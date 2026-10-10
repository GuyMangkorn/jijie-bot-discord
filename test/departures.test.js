import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDepartureLog, buildDeparturesEmbed } from '../src/departure-log.js';
import { handleDepartures } from '../src/departure-command.js';

async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), 'departures-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'data', 'departures.json');
}
const member = (id, bot = false, guildId = 'guild') => ({
  id: String(id), guild: { id: guildId }, user: { bot, username: `user${id}` },
});

test('concurrent events retain latest ten across restart, ignoring bots and other guilds', async (t) => {
  const path = await temporary(t);
  const log = await openDepartureLog(path, 'guild');
  assert.deepEqual(await log.latest(), []);
  await Promise.all(Array.from({ length: 15 }, (_, i) => log.record(member(i), 1000 + i)));
  await log.record(member('bot', true));
  await log.record(member('other', false, 'other'));
  const reopened = await openDepartureLog(path, 'guild');
  const records = await reopened.latest();
  assert.deepEqual(records.map((r) => r.userId), ['14', '13', '12', '11', '10', '9', '8', '7', '6', '5']);
  assert.equal(records[0].leftAt, 1014);
  await assert.rejects(openDepartureLog(path, 'different'));
  await writeFile(path, '{broken');
  await assert.rejects(openDepartureLog(path, 'guild'));
});

test('write failures surface to readers and a later successful write recovers queued records', async (t) => {
  const path = await temporary(t);
  const log = await openDepartureLog(path, 'guild');
  await mkdir(path, { recursive: true });
  await assert.rejects(log.record(member(1), 1000));
  await assert.rejects(log.latest());
  await rm(path, { recursive: true });
  await log.record(member(2), 2000);
  assert.deepEqual((await log.latest()).map((r) => r.userId), ['2', '1']);
});

test('formatting displays plain names safely and handles an empty log', () => {
  const embed = buildDeparturesEmbed([{ name: '@everyone\n<@123> **hi**', userId: '123', leftAt: 1000 }]);
  assert.ok(!embed.description.includes('@everyone'));
  assert.ok(!embed.description.includes('<@123>'));
  assert.ok(embed.description.includes('ID: 123'));
  assert.ok(embed.description.includes('<t:1:f>'));
  assert.match(buildDeparturesEmbed([]).description, /ยังไม่มีประวัติ/);
});

test('command defers before reading and reports storage failure in Thai', async () => {
  const calls = [];
  const interaction = {
    isChatInputCommand: () => true, commandName: 'ออกล่าสุด', guild: { id: 'guild' },
    deferReply: async () => calls.push('defer'),
    editReply: async (reply) => calls.push(reply),
  };
  await handleDepartures(interaction, { latest: async () => { assert.equal(calls[0], 'defer'); return []; } }, 'guild');
  assert.deepEqual(calls[1].allowedMentions, { parse: [] });
  calls.length = 0;
  await handleDepartures(interaction, { latest: async () => { throw new Error('test'); } }, 'guild');
  assert.match(calls[1].content, /ไม่สำเร็จ/);
});
