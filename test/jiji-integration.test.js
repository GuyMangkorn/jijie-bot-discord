import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ChannelType, Events, GatewayIntentBits, PermissionFlagsBits as P } from 'discord.js';
import { createJijiRuntime } from '../src/jiji/jiji-runtime.js';
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
