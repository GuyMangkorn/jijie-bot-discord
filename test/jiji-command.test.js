import assert from 'node:assert/strict';
import test from 'node:test';
import { ChannelType, MessageFlags, PermissionFlagsBits as P } from 'discord.js';
import { jijiCommandData, forgetCommandData, handleJijiCommand } from '../src/jiji-command.js';
import { refreshJijiAccess } from '../src/jiji-access.js';
const guildId = '123456789012345678', channelId = '223456789012345678', otherId = '323456789012345678', userId = '423456789012345678';
const storageError = 'บันทึกการตั้งค่าหรือความจำไม่สำเร็จ กรุณาให้ผู้ดูแลตรวจพื้นที่จัดเก็บของบอต';
function fixture({ commandName = 'จีจี้', subcommand = 'เพิ่ม', manager = true, visible = true, send = true, enabled = false, channelIds = [], fail, missing = false, key = true } = {}) {
  const calls = [], replies = []; let config = { enabled, channelIds: [...channelIds] };
  const requester = { id: userId, permissions: { has: bit => manager && bit === P.ManageGuild } }, bot = { id: '523456789012345678' };
  function channel(id) { return { id, guildId, type: ChannelType.GuildText, name: id === channelId ? 'chat' : 'hidden', permissionsFor: member => ({ has: bit => member === requester ? visible && id !== otherId && bit === P.ViewChannel : bit === P.ViewChannel || (send && bit === P.SendMessages) }) }; }
  const guild = { id: guildId,
    channels: { async fetch(id, options) { calls.push(['channel', id, options]); if (missing) throw Object.assign(new Error('missing'), { code: 10003 }); return channel(id); } },
    roles: { async fetch() { calls.push(['roles']); } },
    members: { async fetch(options) { calls.push(['requester', options]); if (fail === 'fetch') throw new Error('fetch'); return requester; }, async fetchMe(options) { calls.push(['bot', options]); return bot; } },
  };
  async function mutate(name, value, change) { calls.push([name, value]); if (fail === name) throw new Error('disk'); change?.(); }
  const settings = { async get() { if (fail === 'get') throw new Error('disk'); return structuredClone(config); },
    add: id => mutate('add', id, () => { if (!config.channelIds.includes(id)) config.channelIds.push(id); }),
    remove: id => mutate('remove', id, () => { config.channelIds = config.channelIds.filter(x => x !== id); }),
    setEnabled: value => mutate('enabled', value, () => { config.enabled = value; }) };
  const memory = { clear: scope => mutate('clear', scope), clearChannel: id => mutate('clearChannel', id), clearAll: () => mutate('clearAll') };
  const interaction = { commandName, guild, channelId, user: { id: userId }, memberPermissions: { has: () => true }, isChatInputCommand: () => true,
    options: { getSubcommand: () => subcommand, getChannel: name => { assert.equal(name, 'ห้อง'); return channel(channelId); } },
    async deferReply(payload) { calls.push(['defer', payload]); }, async editReply(payload) { replies.push(payload); } };
  const options = { guildId, settings, memory, hasApiKey: key, invalidate: scope => calls.push(['invalidate', scope]) };
  return { interaction, options, calls, replies, config: () => config };
}
async function run(options) { const f = fixture(options); await handleJijiCommand(f.interaction, f.options); return f; }
test('exact command names/options/default ManageGuild; forget unrestricted', () => {
  assert.equal(jijiCommandData.name, 'จีจี้'); assert.equal(jijiCommandData.type, 1); assert.equal(jijiCommandData.default_member_permissions, String(P.ManageGuild));
  assert.deepEqual(jijiCommandData.options.map(x => x.name), ['เพิ่ม', 'ลบ', 'ดู', 'เปิด', 'ปิด']);
  for (const option of jijiCommandData.options) assert.equal(option.type, 1);
  for (const option of jijiCommandData.options.slice(0, 2)) assert.deepEqual(option.options.map(x => [x.name, x.type, x.required, x.channel_types]), [['ห้อง', 7, true, [ChannelType.GuildText]]]);
  for (const option of jijiCommandData.options.slice(2)) assert.equal(option.options?.length ?? 0, 0);
  assert.equal(forgetCommandData.name, 'ลืม'); assert.equal(forgetCommandData.type, 1); assert.equal(forgetCommandData.default_member_permissions, undefined); assert.equal(forgetCommandData.options?.length ?? 0, 0);
});
test('access freshly fetches channel, roles, requester and bot; retrieval failure throws', async () => {
  const f = fixture(); const access = await refreshJijiAccess(f.interaction.guild, channelId, userId);
  assert.equal(access.canView, true); assert.equal(access.canSend, true); assert.equal(access.isManager, true);
  assert.deepEqual(f.calls.find(x => x[0] === 'channel'), ['channel', channelId, { force: true }]);
  assert.deepEqual(f.calls.find(x => x[0] === 'requester'), ['requester', { user: userId, force: true }]);
  assert.deepEqual(f.calls.find(x => x[0] === 'bot'), ['bot', { force: true }]); assert.ok(f.calls.some(x => x[0] === 'roles'));
  const bad = fixture({ fail: 'fetch' }); await assert.rejects(refreshJijiAccess(bad.interaction.guild, channelId, userId));
});
test('ephemeral early defer; duplicate and multi-room adds retain disabled state', async () => {
  const f = await run({ channelIds: [otherId] }); assert.deepEqual(f.calls[0], ['defer', { flags: MessageFlags.Ephemeral }]);
  await handleJijiCommand(f.interaction, f.options); assert.deepEqual(f.config(), { enabled: false, channelIds: [otherId, channelId] }); assert.deepEqual(f.replies[0].allowedMentions, { parse: [] });
});
test('wrong guild and freshly revoked manager rejected despite cached privilege', async () => {
  const f = fixture(); f.interaction.guild.id = otherId; await handleJijiCommand(f.interaction, f.options); assert.ok(!f.calls.some(x => x[0] === 'add'));
  const denied = await run({ manager: false }); assert.ok(!denied.calls.some(x => x[0] === 'add')); assert.match(denied.replies[0].content, /Manage Server/);
});
test('adding requires requester view/bot send and GuildText in configured guild', async () => {
  for (const options of [{ visible: false }, { send: false }]) { const f = await run(options); assert.ok(!f.calls.some(x => x[0] === 'add')); }
  for (const change of [{ type: ChannelType.PublicThread }, { guildId: otherId }]) { const f = fixture(); f.interaction.options.getChannel = () => ({ id: channelId, type: ChannelType.GuildText, guildId, ...change }); await handleJijiCommand(f.interaction, f.options); assert.ok(!f.calls.some(x => x[0] === 'add')); }
});
test('enable requires key and valid accessible room', async () => {
  for (const options of [{ key: false, channelIds: [channelId] }, { channelIds: [] }, { channelIds: [channelId], send: false }, { channelIds: [channelId], missing: true }]) { const f = await run({ subcommand: 'เปิด', ...options }); assert.equal(f.config().enabled, false); }
  const f = await run({ subcommand: 'เปิด', channelIds: [channelId] }); assert.equal(f.config().enabled, true);
});
test('view reveals visible rooms and counts hidden without names/IDs', async () => {
  const f = await run({ subcommand: 'ดู', channelIds: [channelId, otherId] }); assert.match(f.replies[0].content, /chat/); assert.match(f.replies[0].content, /1/); assert.ok(!f.replies[0].content.includes(otherId)); assert.ok(!f.replies[0].content.includes('hidden'));
});
test('remove inaccessible/deleted room invalidates then persists settings then clears memory idempotently', async () => {
  const f = await run({ subcommand: 'ลบ', missing: true, channelIds: [channelId], enabled: true }); assert.deepEqual(f.calls.filter(x => ['invalidate', 'remove', 'clearChannel'].includes(x[0])), [['invalidate', { channelId }], ['remove', channelId], ['clearChannel', channelId]]); assert.deepEqual(f.config(), { enabled: true, channelIds: [] }); await handleJijiCommand(f.interaction, f.options); assert.match(f.replies.at(-1).content, /ลบ/);
});
test('disable retains rooms, invalidates all, persists disabled then clears memory', async () => {
  const f = await run({ subcommand: 'ปิด', enabled: true, channelIds: [channelId] }); assert.deepEqual(f.calls.filter(x => ['invalidate', 'enabled', 'clearAll'].includes(x[0])), [['invalidate', {}], ['enabled', false], ['clearAll', undefined]]); assert.deepEqual(f.config(), { enabled: false, channelIds: [channelId] });
});
test('forget non-manager/disabled clears caller/current channel only with invalidation first', async () => {
  const f = await run({ commandName: 'ลืม', manager: false }); assert.deepEqual(f.calls.filter(x => ['invalidate', 'clear'].includes(x[0])), [['invalidate', { channelId, userId }], ['clear', { channelId, userId }]]); assert.match(f.replies[0].content, /ล้าง/);
});
test('persistence failures never claim success or erase memory before settings persist', async () => {
  for (const [subcommand, fail, commandName] of [['เพิ่ม', 'add'], ['ลบ', 'remove'], ['ลบ', 'clearChannel'], ['ปิด', 'enabled'], ['ปิด', 'clearAll'], ['เปิด', 'enabled'], ['ดู', 'get'], [undefined, 'clear', 'ลืม']]) { const f = await run({ subcommand, fail, commandName, channelIds: [channelId] }); assert.equal(f.replies[0].content, storageError); if (fail === 'remove') assert.ok(!f.calls.some(x => x[0] === 'clearChannel')); if (fail === 'enabled' && subcommand === 'ปิด') assert.ok(!f.calls.some(x => x[0] === 'clearAll')); }
});
test('permission retrieval failure reports Thai operational error with no write', async () => { const f = await run({ fail: 'fetch' }); assert.match(f.replies[0].content, /ตรวจสอบสิทธิ์/); assert.ok(!f.calls.some(x => x[0] === 'add')); });
test('ignore unrelated commands and reject DMs without clearing memory', async () => {
  const unrelated = fixture({ commandName: 'ล่าสุด' }); await handleJijiCommand(unrelated.interaction, unrelated.options); assert.deepEqual(unrelated.calls, []);
  const dm = fixture({ commandName: 'ลืม' }); dm.interaction.guild = null; await handleJijiCommand(dm.interaction, dm.options); assert.ok(!dm.calls.some(x => x[0] === 'clear')); assert.match(dm.replies[0].content, /เซิร์ฟเวอร์/);
});
test('refresh completes role fetch before permission calculations and rejects wrong channel results', async () => {
  const f = fixture(); let rolesReady = false;
  f.interaction.guild.roles.fetch = async () => { await Promise.resolve(); rolesReady = true; };
  f.interaction.guild.channels.fetch = async () => ({ id: channelId, guildId, type: ChannelType.GuildText, permissionsFor() { assert.equal(rolesReady, true); return { has: () => true }; } });
  assert.equal((await refreshJijiAccess(f.interaction.guild, channelId, userId)).canSend, true);
  f.interaction.guild.channels.fetch = async () => ({ id: otherId, guildId, type: ChannelType.GuildText, permissionsFor: () => ({ has: () => true }) });
  const wrong = await refreshJijiAccess(f.interaction.guild, channelId, userId); assert.equal(wrong.canView, false); assert.equal(wrong.canSend, false);
});
test('view is bounded within Discord reply limit for many visible rooms', async () => {
  const f = fixture({ subcommand: 'ดู', channelIds: Array.from({ length: 100 }, (_, i) => String(623456789012345678n + BigInt(i))) });
  f.interaction.guild.channels.fetch = async id => ({ id, guildId, type: ChannelType.GuildText, name: 'a'.repeat(100), permissionsFor: () => ({ has: () => true }) });
  await handleJijiCommand(f.interaction, f.options); assert.ok(f.replies[0].content.length <= 2000); assert.match(f.replies[0].content, /อีก/);
});
