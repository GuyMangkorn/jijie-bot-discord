import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, PermissionFlagsBits as P } from 'discord.js';
import { createJijiChat } from '../src/jiji-chat.js';
const guildId = '123456789012345678', channelId = '223456789012345678', otherChannel = '323456789012345678';
const userId = '423456789012345678', botId = '523456789012345678';
const tired = 'จีจี้เหนื่อยแล้ว 😴 รอก่อนแล้วค่อยมาคุยกันใหม่นะ';
const busy = 'จีจี้กำลังคิดอยู่ 😊 รอแป๊บนะ';
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 200; i++) await Promise.resolve(); };
const waitFor = async predicate => { for (let i = 0; i < 1000; i++) { if (predicate()) return; await Promise.resolve(); } assert.fail('Expected asynchronous boundary was not reached'); };
function fixture() {
  const calls = [], replies = [], saves = [], requests = [];
  let time = 10000, config = { enabled: true, channelIds: [channelId, otherChannel] };
  let visible = true, send = true;
  const requester = { id: userId }, bot = { id: botId };
  const channel = id => ({ id, guildId, type: ChannelType.GuildText,
    permissionsFor(member) { calls.push('permission'); return { has: bit => member === requester ? visible && bit === P.ViewChannel : visible && (bit === P.ViewChannel || (send && bit === P.SendMessages)) }; },
    async sendTyping() { calls.push('typing'); },
  });
  const guild = { id: guildId, channels: { async fetch(id, options) { calls.push(['channel', id, options]); return channel(id); } },
    roles: { async fetch() { calls.push('roles'); } },
    members: { async fetch(options) { calls.push(['members', options]); return requester; }, async fetchMe(options) { calls.push(['bot', options]); return bot; } },
  };
  const settings = { async get() { calls.push('settings'); return structuredClone(config); } };
  const memory = { async get(scope) { calls.push(['memory', scope]); return [{ user: 'เก่า', assistant: 'คำตอบเก่า', at: 1 }]; },
    async append(scope, pair, options) { if (options.isCurrent()) saves.push({ scope, pair }); return true; },
  };
  const gemini = { async respond(options) { requests.push(options); return { text: 'สวัสดี 😊', usedTools: false }; } };
  const departureLog = { latest: async () => [] };
  const chat = createJijiChat({ guildId, botId, settings, memory, gemini, departureLog, now: () => time });
  const message = (changes = {}) => ({ guildId, guild, channelId, channel: channel(channelId), author: { id: userId, bot: false }, content: 'จีจี้ สวัสดี',
    async reply(payload) { replies.push(payload); }, ...changes });
  return { chat, message, guild, settings, memory, gemini, calls, replies, saves, requests,
    setTime: value => { time = value; }, setConfig: value => { config = value; }, deny: () => { visible = false; }, noSend: () => { send = false; } };
}

test('ordinary scoped turn refreshes access, replies publicly without mentions and saves successful text', async () => {
  const f = fixture(); await f.chat.handleMessage(f.message());
  assert.equal(f.requests[0].text, 'สวัสดี');
  assert.deepEqual(f.requests[0].history, [{ user: 'เก่า', assistant: 'คำตอบเก่า', at: 1 }]);
  assert.deepEqual(f.saves, [{ scope: { channelId, userId }, pair: { user: 'สวัสดี', assistant: 'สวัสดี 😊' } }]);
  assert.deepEqual(f.replies[0], { content: 'สวัสดี 😊', allowedMentions: { parse: [], repliedUser: false } });
  assert.ok(f.calls.some(x => x === 'typing'));
  assert.ok(f.calls.filter(x => Array.isArray(x) && x[0] === 'channel').length >= 3);
  for (const x of f.calls.filter(x => Array.isArray(x) && x[0] === 'channel')) assert.deepEqual(x[2], { force: true });
  for (const x of f.calls.filter(x => Array.isArray(x) && x[0] === 'members')) assert.deepEqual(x[1], { user: userId, force: true });
});
test('bots, webhooks, other guild, DMs, threads and uninvoked messages are ignored', async () => {
  for (const changes of [{ author: { id: userId, bot: true } }, { webhookId: '123' }, { guildId: '999' }, { guild: null },
    { channel: { type: ChannelType.PublicThread } }, { content: 'hello' }]) {
    const f = fixture(); await f.chat.handleMessage(f.message(changes)); assert.deepEqual(f.replies, []); assert.deepEqual(f.requests, []);
  }
});
test('disabled/unlisted/deleted/inaccessible rooms and initial permission fetch failures stay silent', async () => {
  for (const change of [f => f.setConfig({ enabled: false, channelIds: [channelId] }), f => f.setConfig({ enabled: true, channelIds: [] }),
    f => f.deny(), f => f.noSend(), f => { f.guild.channels.fetch = async () => null; },
    f => { f.guild.members.fetch = async () => { throw new Error('private'); }; }]) {
    const f = fixture(); change(f); await f.chat.handleMessage(f.message()); assert.deepEqual(f.replies, []); assert.deepEqual(f.requests, []); assert.deepEqual(f.saves, []);
  }
});
test('bare invocation greets without provider or memory and oversized input asks to shorten', async () => {
  for (const [content, expected] of [['จีจี้', 'จีจี้อยู่นี่ 😊 มีอะไรให้ช่วยไหม?'], ['จีจี้' + 'a'.repeat(2001), 'กรุณาส่งคำถามให้สั้นลง ไม่เกิน 2,000 ตัวอักษรนะ 😊']]) {
    const f = fixture(); await f.chat.handleMessage(f.message({ content })); assert.equal(f.replies[0].content, expected); assert.deepEqual(f.requests, []); assert.deepEqual(f.saves, []);
    assert.ok(!f.calls.some(x => Array.isArray(x) && x[0] === 'memory'));
  }
});
test('same user is busy across rooms and can start exactly at 5000 ms', async () => {
  const f = fixture(), pending = deferred(); f.gemini.respond = async () => pending.promise;
  let started = false; f.gemini.respond = async () => { started = true; return pending.promise; };
  const first = f.chat.handleMessage(f.message()); await waitFor(() => started);
  await f.chat.handleMessage(f.message({ channelId: otherChannel, channel: { type: ChannelType.GuildText } }));
  assert.equal(f.replies[0].content, busy); pending.resolve({ text: 'เสร็จ', usedTools: false }); await first;
  f.setTime(14999); await f.chat.handleMessage(f.message()); assert.equal(f.replies.at(-1).content, busy);
  f.setTime(15000); await f.chat.handleMessage(f.message()); assert.equal(f.replies.at(-1).content, 'เสร็จ');
});
test('reply resolves author only and uses replying user memory, never referenced text', async () => {
  const f = fixture(); let fetched = 0;
  const referenced = { author: { id: botId }, get content() { throw new Error('reference content must never be read'); } };
  await f.chat.handleMessage(f.message({ content: 'ขอต่อ', reference: { messageId: '623456789012345678', channelId, guildId }, async fetchReference() { fetched++; return referenced; } }));
  assert.equal(fetched, 1); assert.equal(f.requests[0].text, 'ขอต่อ');
  assert.deepEqual(f.calls.find(x => Array.isArray(x) && x[0] === 'memory')[1], { channelId, userId });
});
test('included bot reply author avoids fetch; unresolved/nonbot references do not guess; explicit trigger survives', async () => {
  for (const [content, author, fail, expected] of [['ต่อ', botId, true, 1], ['ต่อ', userId, false, 0], ['ต่อ', undefined, true, 0], ['จีจี้ต่อ', undefined, true, 1]]) {
    const f = fixture(); let fetched = 0;
    await f.chat.handleMessage(f.message({ content, reference: { messageId: '623456789012345678' }, mentions: { repliedUser: author ? { id: author } : null },
      async fetchReference() { fetched++; if (fail) throw new Error('no history'); return { author: { id: userId } }; } }));
    assert.equal(f.requests.length, expected);
    if (author || content.startsWith('จีจี้')) assert.equal(fetched, 0);
  }
});
test('all provider categories use exact tired copy and release lock without saving', async () => {
  for (const category of ['http', 'network', 'malformed_response', 'blocked_response', 'empty_response', 'request_budget', 'tool_budget', 'missing_key', 'output_too_long']) {
    const f = fixture(); f.gemini.respond = async () => { throw Object.assign(new Error('private provider body'), { category }); };
    await f.chat.handleMessage(f.message()); assert.equal(f.replies[0].content, tired); assert.deepEqual(f.saves, []);
    f.setTime(15000); f.gemini.respond = async () => ({ text: 'กลับมาแล้ว', usedTools: false }); await f.chat.handleMessage(f.message()); assert.equal(f.replies.at(-1).content, 'กลับมาแล้ว');
  }
});
test('approved member tool failure gives Thai operational error, never partial cache or tired copy', async () => {
  const f = fixture(); const original = f.guild.members.fetch;
  f.guild.members.fetch = async options => { if (!options) throw new Error('member fetch'); return original(options); };
  f.gemini.respond = async ({ tools, signal }) => { const result = await tools.execute({ name: 'get_latest_members', args: {} }, { signal }); throw Object.assign(new Error(result.error), { category: result.error }); };
  await f.chat.handleMessage(f.message()); assert.equal(f.replies[0].content, 'ดึงข้อมูลสมาชิกไม่สำเร็จ กรุณาตรวจสอบ Server Members Intent แล้วลองอีกครั้ง'); assert.deepEqual(f.saves, []);
});
test('every tool execution rechecks fresh access and a turn using any tool is never saved', async () => {
  const f = fixture(); f.gemini.respond = async ({ tools, signal }) => {
    assert.equal((await tools.execute({ name: 'activity_help', args: {} }, { signal })).ok, true);
    return { text: 'ใช้ /กิจกรรม', usedTools: false };
  };
  await f.chat.handleMessage(f.message()); assert.equal(f.replies[0].content, 'ใช้ /กิจกรรม'); assert.deepEqual(f.saves, []);
});
test('provider usedTools flag independently suppresses saves and output is bounded', async () => {
  for (const result of [{ text: 'tool answer', usedTools: true }, { text: 'x'.repeat(2001), usedTools: false }]) {
    const f = fixture(); f.gemini.respond = async () => result; await f.chat.handleMessage(f.message());
    assert.ok(f.replies[0].content.length <= 2000); assert.deepEqual(f.saves, []);
    if (result.text.length > 2000) assert.equal(f.replies[0].content, tired);
  }
});
for (const phase of ['provider', 'memory']) for (const action of ['disable', 'remove', 'forget']) {
  test(`${action} during ${phase} cancels pending work, suppresses send/save, releases lock`, async () => {
    const f = fixture(), pending = deferred(); let signal, reached = false;
    if (phase === 'provider') f.gemini.respond = async options => { reached = true; signal = options.signal; return pending.promise; };
    else f.memory.get = async () => { reached = true; return pending.promise; };
    const turn = f.chat.handleMessage(f.message()); await waitFor(() => reached);
    if (action === 'disable') { f.chat.invalidate({}); f.setConfig({ enabled: false, channelIds: [channelId] }); }
    if (action === 'remove') { f.chat.invalidate({ channelId }); f.setConfig({ enabled: true, channelIds: [otherChannel] }); }
    if (action === 'forget') f.chat.invalidate({ channelId, userId });
    await turn; if (signal) assert.equal(signal.aborted, true);
    pending.resolve(phase === 'provider' ? { text: 'late', usedTools: false } : []); await flush();
    assert.deepEqual(f.replies, []); assert.deepEqual(f.saves, []);
    f.setConfig({ enabled: true, channelIds: [channelId] }); f.setTime(15000);
    f.memory.get = async () => []; f.gemini.respond = async () => ({ text: 'new', usedTools: false });
    await f.chat.handleMessage(f.message()); assert.equal(f.replies[0].content, 'new');
  });
}
test('settings or fresh permission revocation after provider result blocks reply/save', async () => {
  for (const change of [f => f.deny(), f => f.setConfig({ enabled: false, channelIds: [channelId] }), f => f.setConfig({ enabled: true, channelIds: [] })]) {
    const f = fixture(); f.gemini.respond = async () => { change(f); return { text: 'private', usedTools: false }; };
    await f.chat.handleMessage(f.message()); assert.deepEqual(f.replies, []); assert.deepEqual(f.saves, []);
  }
});
test('invalidation inside reply blocks later append; queued append guard cannot resurrect forgotten turns', async () => {
  const f = fixture(); let isCurrent;
  f.memory.append = async (_scope, _pair, options) => { isCurrent = options.isCurrent; f.chat.invalidate({ channelId, userId }); return options.isCurrent(); };
  await f.chat.handleMessage(f.message()); assert.equal(isCurrent(), false); assert.deepEqual(f.saves, []);
  const g = fixture(); await g.chat.handleMessage(g.message({ async reply(payload) { g.replies.push(payload); g.chat.invalidate({ channelId, userId }); } }));
  assert.equal(g.replies.length, 1); assert.deepEqual(g.saves, []);
});
test('failed reply never saves, failed save reports operational error without claiming persistence', async () => {
  const f = fixture(); await f.chat.handleMessage(f.message({ async reply() { throw new Error('Discord'); } })); assert.deepEqual(f.saves, []);
  const g = fixture(); g.memory.append = async () => { throw new Error('disk'); }; await g.chat.handleMessage(g.message());
  assert.equal(g.replies[0].content, 'สวัสดี 😊'); assert.match(g.replies[1].content, /บันทึกความจำไม่สำเร็จ/); assert.deepEqual(g.saves, []);
});
test('memory read failure gets a safe operational error and never calls provider', async () => {
  const f = fixture(); f.memory.get = async () => { throw new Error('disk'); }; await f.chat.handleMessage(f.message());
  assert.match(f.replies[0].content, /อ่านหรือบันทึกความจำไม่สำเร็จ/); assert.deepEqual(f.requests, []);
});
test('provider aborts at 29 seconds to reserve safe error delivery within hard 30-second deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture(); let signal;
  f.gemini.respond = async options => { signal = options.signal; return new Promise(() => {}); };
  const turn = f.chat.handleMessage(f.message()); await waitFor(() => signal); t.mock.timers.tick(29000); await turn;
  assert.equal(signal.aborted, true); assert.equal(f.replies[0].content, tired); assert.deepEqual(f.saves, []);
});
test('hard deadline begins before permission fetch and ignores late uncancellable work', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture(), pending = deferred();
  f.guild.members.fetch = async () => pending.promise; const turn = f.chat.handleMessage(f.message()); await flush();
  t.mock.timers.tick(30000); await turn; pending.resolve({ id: userId }); await flush();
  assert.deepEqual(f.replies, []); assert.deepEqual(f.requests, []); assert.deepEqual(f.saves, []);
});
test('failure delivery itself is canceled at total deadline and by forget', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const cancel of ['deadline', 'forget']) {
    const f = fixture(); let provider = false;
    f.gemini.respond = async () => { provider = true; throw new Error('provider'); };
    const original = f.guild.channels.fetch;
    f.guild.channels.fetch = async (...args) => provider ? new Promise(() => {}) : original(...args);
    const turn = f.chat.handleMessage(f.message()); await waitFor(() => provider); await flush();
    if (cancel === 'deadline') t.mock.timers.tick(30000); else f.chat.invalidate({ channelId, userId });
    await turn; assert.deepEqual(f.replies, []); assert.deepEqual(f.saves, []);
  }
});

test('an unrelated reply does not consume conversation cooldown', async () => {
  const f = fixture();
  await f.chat.handleMessage(f.message({ content: 'คุยกับคนอื่น', reference: { messageId: '623456789012345678' }, mentions: { repliedUser: { id: userId } } }));
  await f.chat.handleMessage(f.message()); assert.equal(f.replies[0].content, 'สวัสดี 😊');
});
test('a permission change during memory read prevents provider from receiving the history', async () => {
  const f = fixture(), pending = deferred(); let entered = false;
  f.memory.get = async () => { entered = true; return pending.promise; };
  const turn = f.chat.handleMessage(f.message()); await waitFor(() => entered); f.deny(); pending.resolve([]); await turn;
  assert.deepEqual(f.requests, []); assert.deepEqual(f.replies, []); assert.deepEqual(f.saves, []);
});
test('revocation before a tool call blocks the data source and all public output', async () => {
  const f = fixture(); let read = false;
  const original = f.guild.members.fetch;
  f.guild.members.fetch = async options => { if (!options) { read = true; return new Map(); } return original(options); };
  f.gemini.respond = async ({ tools, signal }) => {
    f.deny(); assert.equal((await tools.execute({ name: 'get_latest_members', args: {} }, { signal })).ok, false);
    return { text: 'private', usedTools: true };
  };
  await f.chat.handleMessage(f.message()); assert.equal(read, false); assert.deepEqual(f.replies, []); assert.deepEqual(f.saves, []);
});
test('different users are independent and forgetting an unrelated scope does not cancel a turn', async () => {
  const f = fixture(), pending = deferred(); let entered = false;
  f.gemini.respond = async ({ text }) => { if (text === 'first') { entered = true; return pending.promise; } return { text: 'second answer', usedTools: false }; };
  const first = f.chat.handleMessage(f.message({ content: 'จีจี้first' })); await waitFor(() => entered);
  f.chat.invalidate({ channelId: otherChannel, userId });
  await f.chat.handleMessage(f.message({ content: 'จีจี้second', author: { id: '723456789012345678', bot: false } }));
  assert.equal(f.replies[0].content, 'second answer'); pending.resolve({ text: 'first answer', usedTools: false }); await first;
  assert.equal(f.replies[1].content, 'first answer');
});

test('elapsed deadline blocks late provider answers/errors before delayed timers and releases lock', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const elapsed of [30000, 30001]) for (const fails of [false, true]) {
    const f = fixture(), pending = deferred(); let signal;
    f.gemini.respond = async options => { signal = options.signal; return pending.promise; };
    const turn = f.chat.handleMessage(f.message()); await waitFor(() => signal);
    f.setTime(10000 + elapsed);
    assert.equal(signal.aborted, false, 'Timer callbacks have deliberately not fired');
    if (fails) pending.reject(new Error('late provider failure'));
    else pending.resolve({ text: 'late answer', usedTools: false });
    await turn; assert.deepEqual(f.replies, []); assert.deepEqual(f.saves, []);
    f.gemini.respond = async () => ({ text: 'new answer', usedTools: false });
    await f.chat.handleMessage(f.message());
    assert.equal(f.replies[0].content, 'new answer'); assert.equal(f.saves.length, 1);
  }
});
test('serialized append guard rejects elapsed deadline even before delayed timers fire', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture(); let guarded;
  f.memory.append = async (_scope, _pair, { isCurrent }) => {
    f.setTime(40001); guarded = isCurrent(); return guarded;
  };
  await f.chat.handleMessage(f.message());
  assert.equal(f.replies.length, 1); assert.equal(guarded, false); assert.deepEqual(f.saves, []);
});
