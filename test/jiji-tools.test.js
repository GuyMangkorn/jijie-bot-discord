import test from 'node:test';
import assert from 'node:assert/strict';
import { createJijiTools, jijiToolDeclarations } from '../src/jiji/jiji-tools.js';

function fixture(overrides = {}) {
  const reads = [];
  const options = {
    guild: { id: '100', members: { fetch: async () => {
      reads.push('members');
      return new Map([['101', { id: '101', displayName: 'member', joinedTimestamp: 1000, user: { bot: false } }]]);
    } } },
    guildId: '100', userId: '101', channelId: '102',
    departureLog: { latest: async () => { reads.push('departures'); return []; } },
    checkAccess: async () => true,
    ...overrides,
  };
  return { tools: createJijiTools(options), reads };
}

test('declarations expose exactly three tools with empty object schemas', () => {
  assert.deepEqual(jijiToolDeclarations.map((tool) => tool.name), ['get_latest_members', 'get_recent_departures', 'activity_help']);
  for (const tool of jijiToolDeclarations) assert.deepEqual(tool.parameters, {
    type: 'object', properties: {}, additionalProperties: false,
  });
});

test('unknown names, prototype-like names and nonempty or nonplain args never read Discord or storage', async () => {
  const { tools, reads } = fixture();
  const calls = [
    { name: 'delete_channel', args: {} }, { name: 'constructor', args: {} },
    { name: '__proto__', args: {} }, { name: 'toString', args: {} },
    ...[{ guildId: '999' }, { userId: '999' }, { channelId: '999' }, [], null, ' {} ',
      Object.create({ injected: true }), { [Symbol('hidden')]: true }].map((args) => ({ name: 'get_latest_members', args })),
  ];
  for (const call of calls) assert.equal((await tools.execute(call)).ok, false);
  assert.deepEqual(reads, []);
});

test('wrong guild and denied or failed access block all three tools', async () => {
  for (const overrides of [{ guildId: '999' }, { userId: undefined }, { channelId: undefined },
    { checkAccess: undefined }, { checkAccess: async () => false },
    { checkAccess: async () => { throw new Error('private'); } }]) {
    const { tools, reads } = fixture(overrides);
    for (const name of ['get_latest_members', 'get_recent_departures', 'activity_help']) {
      assert.equal((await tools.execute({ name, args: {} })).ok, false);
    }
    assert.deepEqual(reads, []);
  }
});

test('access refresh outages retain a safe operational error for chat diagnostics', async () => {
  const { tools } = fixture({ checkAccess: async () => {
    throw Object.assign(new Error('PRIVATE_DISCORD_FAILURE'), {
      category: 'access_unavailable', diagnostic: { stage: 'access', reason: 'access_unavailable' },
    });
  } });
  assert.deepEqual(await tools.execute({ name: 'activity_help', args: {} }), {
    ok: false, error: 'access_unavailable', diagnostic: { stage: 'access', reason: 'access_unavailable' },
  });
});

test('access is checked anew for every call', async () => {
  let allowed = true;
  const { tools, reads } = fixture({ checkAccess: async () => allowed });
  assert.deepEqual(await tools.execute({ name: 'get_latest_members', args: {} }), {
    ok: true, data: { members: [{ userId: '101', name: 'member', joinedAt: 1000 }] },
  });
  allowed = false;
  assert.equal((await tools.execute({ name: 'get_latest_members', args: {} })).ok, false);
  assert.deepEqual(reads, ['members']);
});

test('activity help gives exact static guidance and reads no history', async () => {
  const { tools, reads } = fixture();
  assert.deepEqual(await tools.execute({ name: 'activity_help', args: {} }), {
    ok: true, data: { message: 'ใช้ /กิจกรรม สมาชิก:@สมาชิก [ช่วงวัน:1–30] เพื่อดูผลแบบเห็นเฉพาะคุณนะ 🔎' },
  });
  assert.deepEqual(reads, []);
});

test('departures disclose limited coverage even when empty and strip extra fields and cap at ten', async () => {
  const empty = fixture();
  assert.deepEqual(await empty.tools.execute({ name: 'get_recent_departures', args: {} }), {
    ok: true, data: { departures: [], coverage: 'recorded_while_online', reason: 'unknown' },
  });
  const { tools } = fixture({ departureLog: { latest: async () => Array.from({ length: 11 }, (_, i) =>
    ({ userId: String(i), name: `name-${i}`, leftAt: i + 1, secret: 'omit' })) } });
  const result = await tools.execute({ name: 'get_recent_departures', args: {} });
  assert.equal(result.data.departures.length, 10);
  assert.deepEqual(result.data.departures[0], { userId: '0', name: 'name-0', leftAt: 1 });
  assert.equal(result.data.reason, 'unknown');
});

test('member and departure failures return safe operational errors, not empty histories', async () => {
  const failure = () => { throw new Error('secret data'); };
  const members = fixture({ guild: { id: '100', members: { fetch: failure } } });
  const departures = fixture({ departureLog: { latest: failure } });
  assert.deepEqual(await members.tools.execute({ name: 'get_latest_members', args: {} }), {
    ok: false, error: 'member_fetch_failed',
  });
  assert.deepEqual(await departures.tools.execute({ name: 'get_recent_departures', args: {} }), {
    ok: false, error: 'departure_read_failed',
  });
});

test('aborted calls and late uncancellable reads never return server data', async () => {
  const controller = new AbortController();
  controller.abort();
  const before = fixture();
  assert.equal((await before.tools.execute({ name: 'get_latest_members', args: {} }, { signal: controller.signal })).error, 'cancelled');
  assert.deepEqual(before.reads, []);
  const accessController = new AbortController();
  const access = fixture({ checkAccess: async () => { accessController.abort(); return true; } });
  assert.equal((await access.tools.execute({ name: 'get_latest_members', args: {} }, { signal: accessController.signal })).error, 'cancelled');
  assert.deepEqual(access.reads, []);
  const during = new AbortController();
  const after = fixture({ departureLog: { latest: async () => { during.abort(); return [{ userId: '1', name: 'private', leftAt: 1 }]; } } });
  assert.equal((await after.tools.execute({ name: 'get_recent_departures', args: {} }, { signal: during.signal })).error, 'cancelled');
});

test('Search failure preserves only validated local diagnostic metadata', async () => {
  const { tools } = fixture();
  const failure = Object.assign(new Error('SECRET provider body'), {
    category: 'http', status: 429,
    diagnostic: { stage: 'google_search', reason: 'SECRET', status: 600, key: 'SECRET' },
  });
  const result = await tools.execute({ name: 'search_google', args: { query: 'weather' } }, {
    searchGoogle: async () => { throw failure; },
  });
  assert.deepEqual(result, { ok: false, error: 'search_failed', diagnostic: {
    stage: 'google_search', reason: 'http',
  } });
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
});
