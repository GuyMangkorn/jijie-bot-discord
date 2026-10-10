import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openJijiSettings } from '../src/jiji-settings.js';
const guildId = '234567890123456789', channelId = '123456789012345678', otherId = '345678901234567890';
async function temporary(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'jiji-settings-'));
  try { await fn(join(directory, 'settings.json')); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
test('settings default disabled; idempotent add/remove; reopen exact version 1 shape', async () => temporary(async (path) => {
  const store = await openJijiSettings(path, guildId);
  assert.deepEqual(await store.get(), { enabled: false, channelIds: [] });
  await store.add(channelId); await store.add(channelId); await store.remove(otherId);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { version: 1, guildId, enabled: false, channelIds: [channelId] });
  await store.setEnabled(true);
  assert.deepEqual(await (await openJijiSettings(path, guildId)).get(), { enabled: true, channelIds: [channelId] });
  await store.remove(channelId);
  assert.deepEqual(await store.get(), { enabled: true, channelIds: [] });
}));
test('settings reject corruption, guild/schema mismatches and invalid mutations', async () => temporary(async (path) => {
  const valid = { version: 1, guildId, enabled: false, channelIds: [] };
  for (const value of ['{broken', null, { ...valid, guildId: otherId }, { ...valid, version: 2 }, { ...valid, extra: true }, { ...valid, enabled: 1 }, { ...valid, channelIds: ['bad'] }, { ...valid, channelIds: [channelId, channelId] }]) {
    const original = typeof value === 'string' ? value : JSON.stringify(value);
    await writeFile(path, original); await assert.rejects(openJijiSettings(path, guildId));
    assert.equal(await readFile(path, 'utf8'), original);
  }
  await rm(path);
  const store = await openJijiSettings(path, guildId);
  await assert.rejects(store.add('bad')); await assert.rejects(store.remove(123)); await assert.rejects(store.setEnabled('true'));
}));
test('settings serialize mutations and return defensive copies', async () => temporary(async (path) => {
  const store = await openJijiSettings(path, guildId);
  await Promise.all([store.add(channelId), store.add(otherId), store.setEnabled(true), store.remove(channelId)]);
  const state = await store.get();
  assert.deepEqual(state, { enabled: true, channelIds: [otherId] });
  state.channelIds.push(channelId); state.enabled = false;
  assert.deepEqual(await store.get(), { enabled: true, channelIds: [otherId] });
}));
test('settings write/rename failure preserves live/disk state and recovers', async () => {
  for (const point of ['write', 'rename']) await temporary(async (path) => {
    let fail = false;
    const store = await openJijiSettings(path, guildId, {
      writeFile: async (...args) => { assert.equal(args[2].mode, 0o600); if (fail && point === 'write') throw new Error('injected'); return writeFile(...args); },
      rename: async (...args) => { if (fail && point === 'rename') throw new Error('injected'); return rename(...args); },
    });
    await store.add(channelId); const disk = await readFile(path, 'utf8'); fail = true;
    await assert.rejects(store.add(otherId), /injected/);
    assert.deepEqual(await store.get(), { enabled: false, channelIds: [channelId] }); assert.equal(await readFile(path, 'utf8'), disk);
    fail = false; await store.add(otherId);
    assert.deepEqual(await (await openJijiSettings(path, guildId)).get(), { enabled: false, channelIds: [channelId, otherId] });
  });
});
