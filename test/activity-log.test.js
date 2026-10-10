import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openActivityLog } from '../src/activity/activity-log.js';

async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), 'activity-log-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const event = (overrides = {}) => ({
  guildId: 'guild', userId: 'user', type: 'message', at: Date.UTC(2026, 9, 10, 1),
  channelId: 'channel', messageId: 'message', content: 'secret message text', ...overrides,
});

test('activity log stores only approved metadata, survives restart, and ignores bots and other guilds', async (t) => {
  const dir = await temporary(t);
  const startedAt = Date.UTC(2026, 9, 10);
  const log = await openActivityLog(dir, 'guild', { now: startedAt });
  assert.equal(log.trackingStartedAt, startedAt);

  await Promise.all([
    log.record(event()),
    log.record(event({ messageId: 'message-2', userId: 'other' })),
    log.record(event({ userId: 'bot', isBot: true })),
    log.record(event({ guildId: 'other-guild' })),
  ]);

  const records = await log.recordsFor('user', startedAt - 1);
  assert.equal(records.length, 1);
  assert.equal(records[0].messageId, 'message');
  assert.equal(Object.hasOwn(records[0], 'content'), false);
  const storedFiles = await readdir(dir);
  const dayFile = join(dir, storedFiles.find((name) => name.endsWith('.json') && name !== 'manifest.json'));
  assert.equal((await readFile(dayFile, 'utf8')).includes('secret message text'), false);

  const reopened = await openActivityLog(dir, 'guild', { now: startedAt + 1 });
  assert.equal(reopened.trackingStartedAt, startedAt);
  assert.deepEqual((await reopened.recordsFor('user', startedAt - 1)).map((record) => record.messageId), ['message']);
});

test('retention prunes records older than thirty days while preserving the original tracking date', async (t) => {
  const dir = await temporary(t);
  const now = Date.UTC(2026, 9, 10);
  const log = await openActivityLog(dir, 'guild', { now: now - 60 * 86400000 });
  await log.record(event({ at: now - 31 * 86400000, messageId: 'old' }));
  await log.record(event({ at: now - 29 * 86400000, messageId: 'recent' }));

  await log.prune(now);
  assert.deepEqual((await log.recordsFor('user', 0)).map((record) => record.messageId), ['recent']);
  assert.equal(log.trackingStartedAt, now - 60 * 86400000);
});

test('activity log fails on corrupt, malformed, or mismatched-guild files', async (t) => {
  const dir = await temporary(t);
  await openActivityLog(dir, 'guild', { now: Date.UTC(2026, 9, 10) });
  await assert.rejects(openActivityLog(dir, 'other-guild'));

  const file = join(dir, '2026-10-10.json');
  await writeFile(file, '{broken');
  await assert.rejects(openActivityLog(dir, 'guild'));

  const withoutManifest = await temporary(t);
  await writeFile(join(withoutManifest, '2026-10-10.json'), JSON.stringify({ version: 1, guildId: 'guild', records: [] }));
  await assert.rejects(openActivityLog(withoutManifest, 'guild'), /manifest is missing/);

  const withContent = await temporary(t);
  await openActivityLog(withContent, 'guild', { now: Date.UTC(2026, 9, 10) });
  await writeFile(join(withContent, '2026-10-10.json'), JSON.stringify({ version: 1, guildId: 'guild', records: [{
    type: 'message', userId: 'user', at: Date.UTC(2026, 9, 10), channelId: 'channel', messageId: 'message', content: 'must not load',
  }] }));
  await assert.rejects(openActivityLog(withContent, 'guild'), /Invalid activity log/);
});

test('write failures are reported and queued records persist after a later successful write', async (t) => {
  const dir = await temporary(t);
  const now = Date.UTC(2026, 9, 10);
  const log = await openActivityLog(dir, 'guild', { now });
  const blockedPath = join(dir, '2026-10-10.json');
  await mkdir(blockedPath);
  await assert.rejects(log.record(event({ at: now })));
  await assert.rejects(log.recordsFor('user', 0));
  await rm(blockedPath, { recursive: true });
  await log.record(event({ at: now + 1, messageId: 'retry' }));
  assert.deepEqual((await log.recordsFor('user', 0)).map((record) => record.messageId), ['retry', 'message']);
});
