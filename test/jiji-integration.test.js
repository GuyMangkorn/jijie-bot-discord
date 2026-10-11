import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ChannelType, Events, GatewayIntentBits, PermissionFlagsBits as P } from 'discord.js';
import { createJijiRuntime } from '../src/jiji/jiji-runtime.js';
import { createJijiDiagnostics } from '../src/jiji/jiji-diagnostics.js';
import { registerMessageHandlers, botIntents } from '../src/index.js';
import { registerCommands } from '../scripts/register-commands.js';
import { registerInteractionDispatcher } from '../src/commands/interaction-dispatch.js';
import { JIJI_TIRED_MESSAGE } from '../src/jiji/gemini-client.js';

const guildId = '123456789012345678', channelId = '223456789012345678';
const userId = '323456789012345678', botId = '423456789012345678', otherChannel = '523456789012345678';
const response = parts => ({ ok: true, json: async () => ({ candidates: [{ content: { role: 'model', parts } }] }) });
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'jiji-integration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settingsPath = join(directory, 'settings.json'), memoryPath = join(directory, 'memory.json');
  const replies = [], requests = [], callbacks = new Map(); let at = 1_000_000, fetchBehavior = () => response([{ text: 'สวัสดี 😊' }]);
  const member = { id: userId, user: { id: userId, bot: false, username: 'member' }, joinedTimestamp: 900_000, permissions: { has: bit => bit === P.ManageGuild } };
  const channel = { id: channelId, name: 'chat', guildId, type: ChannelType.GuildText,
    permissionsFor: () => ({ has: () => true }), async sendTyping() {} };
  const guild = { id: guildId, channels: { async fetch() { return channel; } }, roles: { async fetch() {} },
    members: { async fetch(options) { return options ? member : new Map([[userId, member]]); }, async fetchMe() { return { id: botId }; } } };
  const client = { user: { id: botId }, on(event, callback) { callbacks.set(event, callback); } };
  const options = { client, guildId, geminiApiKey: 'offline-fixture', departureLog: {}, settingsPath, memoryPath,
    now: () => at, fetchImpl: async (_url, options) => { requests.push(JSON.parse(options.body)); return fetchBehavior(options); } };
  const runtimes = [];
  async function open(overrides = {}) { const runtime = await createJijiRuntime({ ...options, ...overrides }); runtimes.push(runtime); return runtime; }
  t.after(() => runtimes.forEach(runtime => runtime.close()));
  function message(content = 'จีจี้สวัสดี', extra = {}) { return { id: '623456789012345678', content, guild, guildId, channel, channelId,
    createdTimestamp: at, author: { id: userId, bot: false }, async reply(payload) { replies.push(payload); }, ...extra }; }
  function interaction(subcommand, commandName = 'จีจี้') { return { commandName, guild, channelId, user: { id: userId },
    isChatInputCommand: () => true, options: { getSubcommand: () => subcommand, getChannel: () => channel, getString: () => null },
    async deferReply() {}, async editReply(payload) { replies.push(payload); } }; }
  async function enable(runtime) { await runtime.handleInteraction(interaction('เพิ่ม')); await runtime.handleInteraction(interaction('เปิด')); }
  return { open, enable, message, interaction, replies, requests, client, callbacks, settingsPath, memoryPath,
    advance(ms = 5000) { at += ms; }, setFetch(fn) { fetchBehavior = fn; } };
}
const json = async path => JSON.parse(await readFile(path, 'utf8'));

const searchRequest = () => response([{ functionCall: { name: 'search_google', args: { query: 'ข่าวล่าสุด' } } }]);
const searchResponse = () => ({ ok: true, json: async () => ({ candidates: [{
  content: { role: 'model', parts: [{ text: 'ข่าวที่ตรวจแล้ว' }] },
  groundingMetadata: {
    webSearchQueries: ['ข่าวล่าสุด'], groundingChunks: [{ web: { uri: 'https://example.com/news', title: 'News' } }],
    searchEntryPoint: { renderedContent: '<a href="https://www.google.com/search?q=news">news</a>' },
  },
}] }) });

test('runtime searches, replies with provider links and keeps ordinary memory unchanged across restart', async t => {
  const f = await fixture(t); let runtime = await f.open(); await f.enable(runtime);
  await runtime.handleMessage(f.message());
  const before = await json(f.memoryPath);
  let count = 0;
  f.setFetch(() => [searchRequest(), searchResponse(), response([{ text: 'สรุปข่าวล่าสุด' }])][count++]);
  f.advance(); await runtime.handleMessage(f.message('จีจี้ช่วยค้นข่าวล่าสุด'));
  assert.equal(count, 3);
  assert.match(f.replies.at(-1).content, /สรุปข่าวล่าสุด/);
  assert.match(f.replies.at(-1).content, /https:\/\/example.com\/news/);
  assert.match(f.replies.at(-1).content, /ค้นหาต่อบน Google/);
  assert.deepEqual(f.replies.at(-1).allowedMentions, { parse: [], repliedUser: false });
  assert.deepEqual(await json(f.memoryPath), before);
  runtime.close(); runtime = await f.open();
  f.setFetch(() => response([{ text: 'คุยต่อ' }])); f.advance();
  await runtime.handleMessage(f.message('จีจี้คุยต่อ'));
  const contents = f.requests.at(-1).contents;
  assert.equal(JSON.stringify(contents).includes('ข่าว'), false);
  assert.deepEqual(contents.slice(0, 2).map(item => item.parts[0].text), ['สวัสดี', 'สวัสดี 😊']);
});

test('runtime search failure gives the existing Thai failure with no stored search turn', async t => {
  const f = await fixture(t), runtime = await f.open(); await f.enable(runtime);
  let count = 0;
  f.setFetch(() => count++ === 0 ? searchRequest() : { ok: false, status: 429 });
  await runtime.handleMessage(f.message('จีจี้ค้นข่าว'));
  assert.equal(count, 2);
  assert.equal(f.replies.at(-1).content, JIJI_TIRED_MESSAGE);
  await assert.rejects(readFile(f.memoryPath), { code: 'ENOENT' });
});

test('forget, disable and close during Google Search abort it and discard its late result', async t => {
  for (const action of ['ลืม', 'ปิด', 'close']) {
    const f = await fixture(t), runtime = await f.open(); await f.enable(runtime);
    await runtime.handleMessage(f.message()); f.advance();
    let count = 0, enter, release, signal;
    const started = new Promise(resolve => { enter = resolve; });
    f.setFetch(options => {
      if (count++ === 0) return searchRequest();
      signal = options.signal; enter(); return new Promise(resolve => { release = resolve; });
    });
    const pending = runtime.handleMessage(f.message('จีจี้ค้นข่าว')); await started;
    if (action === 'close') runtime.close();
    else await runtime.handleInteraction(f.interaction(action === 'ลืม' ? undefined : action, action === 'ลืม' ? action : 'จีจี้'));
    const before = f.replies.length;
    await pending; assert.equal(signal.aborted, true);
    release(searchResponse()); await new Promise(resolve => setImmediate(resolve));
    assert.equal(count, 2); assert.equal(f.replies.length, before);
    const stored = await json(f.memoryPath);
    assert.equal(JSON.stringify(stored).includes('ข่าว'), false);
    if (action !== 'close') assert.deepEqual(stored.sessions, []);
  }
});

test('permission loss during search prevents delivery and persistence', async t => {
  const f = await fixture(t), runtime = await f.open(); await f.enable(runtime);
  let count = 0;
  const message = f.message('จีจี้ค้นข่าว');
  f.setFetch(() => {
    count += 1;
    if (count === 1) return searchRequest();
    if (count === 2) {
      message.channel.permissionsFor = () => ({ has: () => false });
      return searchResponse();
    }
    return response([{ text: 'คำตอบที่ห้ามส่ง' }]);
  });
  const before = f.replies.length;
  await runtime.handleMessage(message);
  assert.equal(f.replies.length, before);
  await assert.rejects(readFile(f.memoryPath), { code: 'ENOENT' });
});

test('manager add stays disabled; enable, chat, restart, tool exclusion, forget, disable persist', async t => {
  const f = await fixture(t); let runtime = await f.open();
  await runtime.handleInteraction(f.interaction('เพิ่ม'));
  assert.deepEqual(await json(f.settingsPath), { version: 1, guildId, enabled: false, channelIds: [channelId] });
  await runtime.handleMessage(f.message()); assert.equal(f.requests.length, 0);
  await runtime.handleInteraction(f.interaction('เปิด')); await runtime.handleMessage(f.message());
  assert.equal((await json(f.memoryPath)).sessions[0].turns[0].user, 'สวัสดี');
  runtime.close(); runtime = await f.open(); f.advance();
  await runtime.handleMessage(f.message('จีจี้จำได้ไหม'));
  assert.deepEqual(f.requests.at(-1).contents.slice(0, 2).map(part => part.parts[0].text), ['สวัสดี', 'สวัสดี 😊']);
  const beforeTool = await json(f.memoryPath); let toolRequested = false;
  f.setFetch(() => { if (!toolRequested) { toolRequested = true; return response([{ functionCall: { name: 'activity_help', args: {} } }]); } return response([{ text: 'ใช้ /กิจกรรม นะ' }]); });
  f.advance(); await runtime.handleMessage(f.message('จีจี้ดูประวัติยังไง'));
  assert.deepEqual(await json(f.memoryPath), beforeTool);
  assert.ok(f.requests.at(-1).contents.some(content => content.parts.some(part => part.functionResponse)));
  await runtime.handleInteraction(f.interaction(undefined, 'ลืม')); runtime.close(); runtime = await f.open();
  assert.deepEqual((await json(f.memoryPath)).sessions, []);
  await runtime.handleInteraction(f.interaction('ปิด'));
  assert.deepEqual(await json(f.settingsPath), { version: 1, guildId, enabled: false, channelIds: [channelId] });
});

test('startup reconciles interrupted channel removal and global disable', async t => {
  const f = await fixture(t); const session = id => ({ channelId: id, userId, updatedAt: 1_000_000, turns: [{ user: 'hello', assistant: 'answer', at: 1_000_000 }] });
  for (const enabled of [true, false]) {
    await writeFile(f.settingsPath, JSON.stringify({ version: 1, guildId, enabled, channelIds: [channelId] }));
    await writeFile(f.memoryPath, JSON.stringify({ version: 1, guildId, sessions: [session(channelId), session(otherChannel)] }));
    const runtime = await f.open();
    assert.deepEqual((await json(f.memoryPath)).sessions.map(item => item.channelId), enabled ? [channelId] : []);
    runtime.close();
  }
});

test('actual message wiring records independently of ignored messages, blocked fetch and provider failure', async t => {
  const f = await fixture(t), runtime = await f.open(), records = []; await f.enable(runtime);
  registerMessageHandlers(f.client, { guildId, activityLog: { async record(event) { records.push(event); } }, jijiRuntime: runtime });
  const handler = f.callbacks.get(Events.MessageCreate);
  await handler(f.message('ordinary human chat')); assert.equal(f.requests.length, 0); assert.equal(records.length, 1);
  for (const extra of [{ author: { id: botId, bot: true } }, { webhookId: 'webhook' }]) await handler(f.message('จีจี้bot', extra));
  assert.equal(records.length, 1); assert.equal(f.requests.length, 0);
  let finishFetch, entered; const fetching = new Promise(resolve => { entered = resolve; });
  f.setFetch(() => { entered(); return new Promise(resolve => { finishFetch = resolve; }); });
  const pending = handler(f.message()); await fetching;
  assert.equal(records.length, 2, 'activity completed while Gemini was still pending');
  finishFetch({ ok: false, status: 429 }); await pending;
  assert.equal(f.replies.at(-1).content, JIJI_TIRED_MESSAGE);
  assert.deepEqual(Object.keys(records[1]).sort(), ['at', 'channelId', 'guildId', 'isBot', 'messageId', 'type', 'userId']);
  assert.ok(botIntents.includes(GatewayIntentBits.MessageContent));
});

test('missing Gemini key leaves latest command operational and prevents enable', async t => {
  const f = await fixture(t), runtime = await f.open({ geminiApiKey: undefined });
  await runtime.handleInteraction(f.interaction('เพิ่ม')); await runtime.handleInteraction(f.interaction('เปิด'));
  assert.equal((await json(f.settingsPath)).enabled, false); assert.match(f.replies.at(-1).content, /GEMINI_API_KEY/);
  registerInteractionDispatcher(f.client, {
    activityLog: { async record() {} }, departureLog: {}, guildId,
    welcomeSettings: {}, jijiRuntime: runtime,
  });
  const latest = f.interaction(undefined, 'ล่าสุด');
  await f.callbacks.get(Events.InteractionCreate)(latest);
  assert.equal(f.replies.at(-1).embeds.length, 1);
  await f.callbacks.get(Events.InteractionCreate)(f.interaction('ปิด'));
  assert.match(f.replies.at(-1).content, /ปิด/);
});

test('corrupt settings and memory fail startup without overwriting either file', async t => {
  const f = await fixture(t);
  for (const path of [f.settingsPath, f.memoryPath]) {
    await writeFile(path, '{broken'); await assert.rejects(f.open());
    assert.equal(await readFile(path, 'utf8'), '{broken'); await rm(path);
  }
});

test('minute timer prunes expired memory and close clears timer', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = await fixture(t), runtime = await f.open(); await f.enable(runtime); await runtime.handleMessage(f.message());
  f.advance(1_800_000); t.mock.timers.tick(60_000);
  for (let i = 0; i < 100 && (await json(f.memoryPath)).sessions.length; i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual((await json(f.memoryPath)).sessions, []);
  runtime.close();
  const stale = { version: 1, guildId, sessions: [{ channelId, userId, updatedAt: 1_000_000, turns: [{ user: 'hello', assistant: 'answer', at: 1_000_000 }] }] };
  await writeFile(f.memoryPath, JSON.stringify(stale)); t.mock.timers.tick(60_000);
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(await json(f.memoryPath), stale);
});

test('close aborts pending fetch, suppresses late replies and prevents new work', async t => {
  const f = await fixture(t), runtime = await f.open(); await f.enable(runtime);
  let signal, entered; const started = new Promise(resolve => { entered = resolve; });
  f.setFetch(options => { signal = options.signal; entered(); return new Promise(() => {}); });
  const count = f.replies.length, pending = runtime.handleMessage(f.message()); await started;
  runtime.close(); await pending; assert.equal(signal.aborted, true); assert.equal(f.replies.length, count);
  await runtime.handleMessage(f.message()); await runtime.handleInteraction(f.interaction('ปิด')); assert.equal(f.replies.length, count);
  await assert.rejects(readFile(f.memoryPath), { code: 'ENOENT' });
});

test('runtime opens before login and resolves the authenticated bot ID for mention triggers', async t => {
  const f = await fixture(t); f.client.user = null;
  const runtime = await f.open(); await f.enable(runtime);
  await runtime.handleMessage(f.message()); assert.equal(f.requests.length, 0);
  f.client.user = { id: botId };
  await runtime.handleMessage(f.message('hello <@' + botId + '>'));
  assert.equal(f.requests[0].contents.at(-1).parts[0].text, 'hello');
});

test('forget, disable and raw-ID room removal abort pending runtime turns and persist erasure', async t => {
  for (const command of ['ลืม', 'ปิด', 'ลบ']) {
    const f = await fixture(t), runtime = await f.open(); await f.enable(runtime);
    await runtime.handleMessage(f.message()); f.advance();
    let signal, entered; const started = new Promise(resolve => { entered = resolve; });
    f.setFetch(options => { signal = options.signal; entered(); return new Promise(() => {}); });
    const pending = runtime.handleMessage(f.message('จีจี้pending')); await started;
    const before = f.replies.length;
    const interaction = f.interaction(command === 'ลืม' ? undefined : command, command === 'ลืม' ? command : 'จีจี้');
    if (command === 'ลบ') {
      interaction.options.getChannel = () => null;
      interaction.options.getString = () => channelId;
    }
    await runtime.handleInteraction(interaction);
    await pending; assert.equal(signal.aborted, true);
    assert.equal(f.replies.length, before + 1, 'only the ephemeral command reply was delivered');
    assert.deepEqual((await json(f.memoryPath)).sessions, []);
    runtime.close(); await f.open(); assert.deepEqual((await json(f.memoryPath)).sessions, []);
  }
});

test('registration patches/posts owned commands individually and preserves unrelated commands', async () => {
  const calls = [], unrelated = { id: 'unrelated', name: 'keep-me' };
  const rest = { async get() { return [unrelated, { id: 'latest', name: 'ล่าสุด' }, { id: 'jiji', name: 'จีจี้' }]; },
    async patch(route, options) { calls.push(['patch', route, options.body.name]); }, async post(route, options) { calls.push(['post', route, options.body.name]); },
    async put() { assert.fail('bulk replacement forbidden'); }, async delete() { assert.fail('deletion forbidden'); } };
  await registerCommands({ rest, clientId: botId, guildId });
  assert.deepEqual(calls.map(([method, , name]) => [method, name]), [['patch', 'ล่าสุด'], ['post', 'ออกล่าสุด'], ['post', 'กิจกรรม'], ['post', 'ต้อนรับ'], ['patch', 'จีจี้'], ['post', 'ลืม']]);
  assert.ok(calls.every(([, route]) => !route.includes('unrelated'))); assert.equal(unrelated.name, 'keep-me');
});


test('runtime Search 429 produces a safe diagnostic, tired reply and no memory pair', async t => {
  const f = await fixture(t), logs = [];
  const traceId = '00000000-0000-4000-8000-000000000003';
  const runtime = await f.open({
    diagnostics: createJijiDiagnostics({ write: line => logs.push(JSON.parse(line)), now: () => 1_000_000 }),
    traceId: () => traceId,
  });
  await f.enable(runtime);
  let count = 0;
  f.setFetch(() => count++ === 0 ? searchRequest() : {
    ok: false, status: 429, json: () => assert.fail('Search HTTP error body must not be read'),
  });
  await runtime.handleMessage(f.message('จีจี้ค้นข่าว_SECRET_QUERY'));
  assert.equal(f.replies.at(-1).content, JIJI_TIRED_MESSAGE);
  assert.equal(count, 2);
  assert.equal(logs.length, 1);
  assert.deepEqual(logs[0], {
    event: 'jiji_turn_failed', timestamp: '1970-01-01T00:16:40.000Z', traceId,
    stage: 'google_search', category: 'search_failed', httpStatus: 429, reason: 'http',
    durationMs: 0, requestCount: 2, toolCount: 1,
  });
  const logText = JSON.stringify(logs);
  for (const secret of ['offline-fixture', 'ข่าว_SECRET_QUERY', userId, channelId, guildId, 'PRIVATE_PROVIDER_BODY']) {
    assert.equal(logText.includes(secret), false);
  }
  await assert.rejects(readFile(f.memoryPath), { code: 'ENOENT' });
});

test('runtime shutdown logs once and ignores late provider settlement', async t => {
  const f = await fixture(t), logs = [];
  const runtime = await f.open({
    diagnostics: createJijiDiagnostics({ write: line => logs.push(JSON.parse(line)), now: () => 1_000_000 }),
    traceId: () => '00000000-0000-4000-8000-000000000004',
  });
  await f.enable(runtime);
  let signal, release, enter;
  const started = new Promise(resolve => { enter = resolve; });
  f.setFetch(options => { signal = options.signal; enter(); return new Promise(resolve => { release = resolve; }); });
  const before = f.replies.length;
  const pending = runtime.handleMessage(f.message());
  await started;
  runtime.close();
  await pending;
  assert.equal(signal.aborted, true);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, 'jiji_turn_cancelled');
  assert.equal(logs[0].category, 'cancelled');
  assert.equal(logs[0].reason, 'shutdown');
  release(response([{ text: 'late secret answer' }]));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(logs.length, 1);
  assert.equal(f.replies.length, before);
  await assert.rejects(readFile(f.memoryPath), { code: 'ENOENT' });
});
