import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openJijiMemory } from '../src/jiji/jiji-memory.js';
const guildId = '234567890123456789', channelId = '123456789012345678', userId = '345678901234567890', otherId = '456789012345678901';
const scope = { channelId, userId }, pair = { user: 'เราเป็นบอล', assistant: 'หวัดดีบอล 😊' };
async function temporary(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'jiji-memory-'));
  try { await fn(join(directory, 'memory.json')); } finally { await rm(directory, { recursive: true, force: true }); }
}
const session = (overrides = {}) => ({ ...scope, updatedAt: 100, turns: [{ ...pair, at: 100 }], ...overrides });
const data = (sessions) => ({ version: 1, guildId, sessions });
test('memory complete pairs reopen with exact schema, isolated keys and defensive copies', async () => temporary(async (path) => {
  const memory = await openJijiMemory(path, guildId, { now: () => 100 });
  assert.deepEqual(await memory.get(scope), []); assert.equal(await memory.append(scope, pair), true);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), data([session()]));
  const reopened = await openJijiMemory(path, guildId, { now: () => 100 });
  assert.equal((await reopened.get(scope))[0].user, 'เราเป็นบอล');
  assert.deepEqual(await reopened.get({ channelId, userId: otherId }), []);
  assert.deepEqual(await reopened.get({ channelId: otherId, userId }), []);
  const returned = await reopened.get(scope); returned[0].user = 'changed'; returned.push({ ...pair, at: 100 });
  assert.deepEqual(await reopened.get(scope), [{ ...pair, at: 100 }]);
}));
test('ten-pair cap and simultaneous serialized appends lose no turns', async () => temporary(async (path) => {
  let now = 100;
  const memory = await openJijiMemory(path, guildId, { now: () => now++ });
  await Promise.all(Array.from({ length: 12 }, (_, index) => memory.append(scope, { user: `u${index}`, assistant: `a${index}` })));
  const turns = await memory.get(scope);
  assert.equal(turns.length, 10); assert.deepEqual(turns.map(turn => turn.user), Array.from({ length: 10 }, (_, index) => `u${index + 2}`));
  assert.deepEqual(await (await openJijiMemory(path, guildId, { now: () => now })).get(scope), turns);
}));
test('expiry at exactly 1,800,000 ms persists on read, startup, write and prune', async () => {
  for (const method of ['get', 'startup', 'append', 'prune']) await temporary(async (path) => {
    let now = 100; const memory = await openJijiMemory(path, guildId, { now: () => now });
    await memory.append(scope, pair); now += 1_799_999; assert.equal((await memory.get(scope)).length, 1); now++;
    if (method === 'startup') await openJijiMemory(path, guildId, { now: () => now });
    else if (method === 'append') await memory.append({ channelId, userId: otherId }, pair);
    else await memory[method](scope);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).sessions.some(item => item.userId === userId), false);
    if (method !== 'startup') assert.deepEqual(await memory.get(scope), []);
  });
});
test('1,000-session eviction orders by timestamp then channel/user IDs', async () => temporary(async (path) => {
  const ids = Array.from({ length: 1000 }, (_, index) => String(100000000000000000n + BigInt(index)));
  const sessions = ids.map(id => session({ userId: id })); sessions[999].updatedAt = 99; sessions[999].turns[0].at = 99;
  await writeFile(path, JSON.stringify(data(sessions)));
  const memory = await openJijiMemory(path, guildId, { now: () => 100 });
  await memory.append(scope, pair); assert.deepEqual(await memory.get({ channelId, userId: ids[999] }), []);
  await memory.append({ channelId: otherId, userId }, pair); assert.deepEqual(await memory.get({ channelId, userId: ids[0] }), []);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).sessions.length, 1000);
}));
test('clear, channel clear, global clear and restart reconciliation persist erasure', async () => temporary(async (path) => {
  const memory = await openJijiMemory(path, guildId, { now: () => 100 });
  const otherUser = { channelId, userId: otherId }, otherChannel = { channelId: otherId, userId };
  await Promise.all([memory.append(scope, pair), memory.append(otherUser, pair), memory.append(otherChannel, pair)]);
  await memory.clear(scope); await memory.clear(scope); assert.deepEqual(await memory.get(scope), []); assert.equal((await memory.get(otherUser)).length, 1);
  await memory.clearChannel(channelId); assert.deepEqual(await memory.get(otherUser), []);
  await memory.reconcile({ enabled: true, channelIds: [channelId] }); assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), data([]));
  await memory.append(scope, pair); await memory.reconcile({ enabled: false, channelIds: [channelId] }); assert.deepEqual(await memory.get(scope), []);
  await memory.append(scope, pair); await memory.clearAll(); assert.deepEqual(await (await openJijiMemory(path, guildId, { now: () => 100 })).get(scope), []);
}));
test('queued append checks synchronous invalidation; clear behind started append erases final state', async () => temporary(async (path) => {
  let release, started, block = true;
  const entered = new Promise(resolve => { started = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const memory = await openJijiMemory(path, guildId, { now: () => 100, writeFile: async (...args) => { if (block) { started(); await gate; block = false; } return writeFile(...args); } });
  const first = memory.append(scope, pair); await entered;
  let current = true;
  const queued = memory.append(scope, pair, { isCurrent: () => current }), clear = memory.clear(scope);
  current = false; release(); assert.equal(await first, true); assert.equal(await queued, false); await clear;
  assert.deepEqual(await memory.get(scope), []); assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), data([]));
}));
test('memory write/rename failure preserves live/disk state and later saves recover', async () => {
  for (const point of ['write', 'rename']) await temporary(async (path) => {
    let fail = false;
    const memory = await openJijiMemory(path, guildId, { now: () => 100,
      writeFile: async (...args) => { assert.equal(args[2].mode, 0o600); if (fail && point === 'write') throw new Error('injected'); return writeFile(...args); },
      rename: async (...args) => { if (fail && point === 'rename') throw new Error('injected'); return rename(...args); },
    });
    await memory.append(scope, pair); const disk = await readFile(path, 'utf8'); fail = true;
    await assert.rejects(memory.append(scope, pair), /injected/); await assert.rejects(memory.clearAll(), /injected/);
    assert.deepEqual(await memory.get(scope), [{ ...pair, at: 100 }]); assert.equal(await readFile(path, 'utf8'), disk);
    fail = false; await memory.append(scope, pair); assert.equal((await memory.get(scope)).length, 2);
  });
});
test('memory rejects corrupt/mismatched schema, duplicate keys, timestamp/text bounds and invalid input', async () => temporary(async (path) => {
  const badSessions = [
    [session({ extra: true })], [session(), session()], [session({ userId: 'bad' })], [session({ updatedAt: 99 })], [session({ updatedAt: 100.5 })],
    [session({ turns: [] })], [session({ turns: Array.from({ length: 11 }, () => ({ ...pair, at: 100 })) })],
    [session({ turns: [{ ...pair, at: -1 }] })], [session({ turns: [{ ...pair, at: 101 }] })], [session({ turns: [{ ...pair, at: 99 }] })],
    [session({ turns: [{ ...pair, user: '', at: 100 }] })], [session({ turns: [{ ...pair, assistant: 'x'.repeat(2001), at: 100 }] })],
    [session({ turns: [{ ...pair, at: 100, extra: true }] })], [session({ turns: [{ ...pair, at: 100 }, { ...pair, at: 99 }] })],
  ];
  const invalid = ['{broken', null, { ...data([]), version: 2 }, { ...data([]), guildId: otherId }, { ...data([]), extra: true }, ...badSessions.map(data)];
  for (const value of invalid) {
    const original = typeof value === 'string' ? value : JSON.stringify(value); await writeFile(path, original);
    await assert.rejects(openJijiMemory(path, guildId, { now: () => 100 })); assert.equal(await readFile(path, 'utf8'), original);
  }
  await rm(path); const memory = await openJijiMemory(path, guildId, { now: () => 100 });
  await assert.rejects(memory.append({ channelId: 'bad', userId }, pair)); await assert.rejects(memory.append(scope, { user: '', assistant: 'a' }));
  await assert.rejects(memory.append(scope, { user: 'x'.repeat(2001), assistant: 'a' }));
}));

test('channel ID precedes user ID for equal-time eviction ties', async () => temporary(async (path) => {
  const sessions = Array.from({ length: 999 }, (_, index) => session({
    channelId: otherId,
    userId: String(100000000000000000n + BigInt(index)),
  }));
  sessions.push(session());
  await writeFile(path, JSON.stringify(data(sessions)));
  const memory = await openJijiMemory(path, guildId, { now: () => 100 });
  await memory.append({ channelId: otherId, userId: otherId }, pair);
  assert.deepEqual(await memory.get(scope), []);
  assert.equal((await memory.get({ channelId: otherId, userId: sessions[0].userId })).length, 1);
}));

test('memory snapshots caller input, accepts exact text bounds and keeps clock rollback ordered', async () => temporary(async (path) => {
  let now = 100;
  const memory = await openJijiMemory(path, guildId, { now: () => now });
  const inputScope = { ...scope };
  const inputPair = { user: 'x'.repeat(2000), assistant: 'y'.repeat(2000) };
  const pending = memory.append(inputScope, inputPair);
  inputScope.userId = otherId;
  inputPair.user = 'mutated';
  await pending;
  now = 99;
  await memory.append(scope, pair);
  const turns = await memory.get(scope);
  assert.equal(turns[0].user.length, 2000);
  assert.equal(turns[1].at, 100);
  assert.deepEqual(await memory.get({ channelId, userId: otherId }), []);
  assert.deepEqual(await (await openJijiMemory(path, guildId, { now: () => now })).get(scope), turns);
}));

test('memory rejects invalid clearing/reconciliation scopes and invalid clocks', async () => temporary(async (path) => {
  let now = 0;
  const memory = await openJijiMemory(path, guildId, { now: () => now });
  await memory.append(scope, pair);
  await assert.rejects(memory.get({ ...scope, extra: true }));
  await assert.rejects(memory.clear({ channelId, userId: 'bad' }));
  await assert.rejects(memory.clearChannel('bad'));
  await assert.rejects(memory.reconcile({ enabled: true, channelIds: [channelId, channelId] }));
  await assert.rejects(memory.reconcile({ enabled: 'true', channelIds: [] }));
  for (const value of [-1, 0.5, NaN, Infinity]) {
    now = value;
    await assert.rejects(memory.prune(), /clock/);
  }
  now = 0;
  assert.deepEqual(await memory.get(scope), [{ ...pair, at: 0 }]);
}));


test('failed first append removes partial temporary text before no-op clear', async () => {
  for (const point of ['write', 'rename']) await temporary(async (path) => {
    const memory = await openJijiMemory(path, guildId, { now: () => 100,
      writeFile: async (...args) => { await writeFile(...args); if (point === 'write') throw new Error('partial write'); },
      rename: async () => { throw new Error('rename failed'); },
    });
    await assert.rejects(memory.append(scope, pair), /partial write|rename failed/);
    await assert.rejects(readFile(`${path}.tmp`), { code: 'ENOENT' });
    await memory.clear(scope);
    await assert.rejects(readFile(path), { code: 'ENOENT' });
    await assert.rejects(readFile(`${path}.tmp`), { code: 'ENOENT' });
    assert.deepEqual(await memory.get(scope), []);
  });
});

test('startup discards stale temporary conversations without promoting them or replacing corrupt canonical data', async () => {
  for (const canonical of [null, JSON.stringify(data([session()])), '{broken']) await temporary(async (path) => {
    const stalePair = { user: 'uncommitted secret', assistant: 'uncommitted answer' };
    await writeFile(`${path}.tmp`, JSON.stringify(data([session({ turns: [{ ...stalePair, at: 100 }] })])));
    if (canonical !== null) await writeFile(path, canonical);
    if (canonical === '{broken') await assert.rejects(openJijiMemory(path, guildId, { now: () => 100 }));
    else {
      const memory = await openJijiMemory(path, guildId, { now: () => 100 });
      assert.deepEqual(await memory.get(scope), canonical === null ? [] : [{ ...pair, at: 100 }]);
    }
    await assert.rejects(readFile(`${path}.tmp`), { code: 'ENOENT' });
    if (canonical === null) await assert.rejects(readFile(path), { code: 'ENOENT' });
    else assert.equal(await readFile(path, 'utf8'), canonical);
  });
});

test('no-op clear, channel clear, global clear, expiry prune and reconcile discard stale temporary text', async () => {
  for (const method of ['clear', 'clearChannel', 'clearAll', 'prune', 'disabled', 'removed']) await temporary(async (path) => {
    let now = 100;
    const memory = await openJijiMemory(path, guildId, { now: () => now, rename: async () => { throw new Error('failed append'); } });
    await assert.rejects(memory.append(scope, pair), /failed append/);
    // Also emulate a leftover from an interrupted write while canonical state is empty.
    await writeFile(`${path}.tmp`, JSON.stringify(data([session()])));
    now += 1_800_000;
    if (method === 'disabled') await memory.reconcile({ enabled: false, channelIds: [channelId] });
    else if (method === 'removed') await memory.reconcile({ enabled: true, channelIds: [] });
    else await memory[method](method === 'clearChannel' ? channelId : scope);
    await assert.rejects(readFile(`${path}.tmp`), { code: 'ENOENT' });
    await assert.rejects(readFile(path), { code: 'ENOENT' });
    assert.deepEqual(await memory.get(scope), []);
  });
});

test('memory canonical writes have private 0600 file mode', async () => temporary(async (path) => {
  const memory = await openJijiMemory(path, guildId, { now: () => 100 });
  await memory.append(scope, pair);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
}));
