import assert from 'node:assert/strict';
import test from 'node:test';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import {
  DEFAULT_WELCOME_TEMPLATE,
  buildWelcomeMessage,
  sendWelcome,
  validateWelcomeTemplate,
} from '../src/welcome-message.js';

const guildId = '234567890123456789';
const channelId = '123456789012345678';
const userId = '345678901234567890';

function makeFixture({ enabled = true, channelOverrides = {}, send = async () => ({ id: 'message' }) } = {}) {
  const calls = { channelFetch: 0, send: 0, memberFetch: 0, rolesFetch: 0 };
  const botMember = { id: '456789012345678901', user: { bot: true } };
  const requester = { id: userId, user: { bot: false } };
  const channel = {
    id: channelId,
    guildId,
    type: ChannelType.GuildText,
    permissionsFor(member) {
      const permissions = member === botMember
        ? (channelOverrides.bot ?? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])
        : (channelOverrides.requester ?? [PermissionFlagsBits.ViewChannel]);
      return { has: (permission) => permissions.includes(permission) };
    },
    async send(payload) {
      calls.send += 1;
      return send(payload);
    },
  };
  const guild = {
    id: guildId,
    channels: {
      async fetch(id, options) {
        calls.channelFetch += 1;
        assert.equal(id, channelId);
        guild.channels.fetchOptions = options;
        return channelOverrides.channel === undefined ? channel : channelOverrides.channel;
      },
    },
    members: {
      async fetchMe(options) {
        calls.memberFetch += 1;
        guild.members.fetchMeOptions = options;
        if (channelOverrides.memberFetchError) throw channelOverrides.memberFetchError;
        return botMember;
      },
    },
    roles: {
      async fetch() { calls.rolesFetch += 1; return new Map(); },
    },
  };
  const member = { id: userId, guild, user: { id: userId, bot: false } };
  const settings = {
    async get() {
      return enabled
        ? { channelId, template: 'ยินดีต้อนรับ {member} 🎉' }
        : { channelId: null, template: null };
    },
  };
  return { calls, channel, guild, member, requester, settings };
}

test('uses the documented default and replaces every member placeholder', () => {
  assert.equal(DEFAULT_WELCOME_TEMPLATE, 'ยินดีต้อนรับ {member} เข้าสู่เซิร์ฟเวอร์ 🎉');
  const payload = buildWelcomeMessage('{member} {member} @everyone <@&123>', userId);

  assert.equal(payload.content, `<@${userId}> <@${userId}> @everyone <@&123>`);
  assert.deepEqual(payload.allowedMentions, { parse: [], users: [userId] });
});

test('keeps templates without placeholders unchanged and does not enable user mentions', () => {
  assert.equal(validateWelcomeTemplate('  Welcome aboard!  '), 'Welcome aboard!');
  const payload = buildWelcomeMessage(`Welcome aboard! <@${userId}>`, userId);
  assert.equal(payload.content, `Welcome aboard! <@${userId}>`);
  assert.deepEqual(payload.allowedMentions, { parse: [], users: [] });
});

test('rejects empty templates, more than 1000 code units and oversized expansions', () => {
  assert.throws(() => validateWelcomeTemplate('   '), /empty/i);
  assert.throws(() => validateWelcomeTemplate('x'.repeat(1001)), /1000/);
  assert.throws(() => validateWelcomeTemplate('{member}'.repeat(100)), /2000/);
  assert.throws(() => validateWelcomeTemplate('😀'.repeat(501)), /1000/);
});

test('rejects an actual expansion that exceeds Discord message length', () => {
  assert.throws(() => buildWelcomeMessage('{member}'.repeat(120), userId), /2000/);
});

test('skips disabled settings, bot accounts and members from another guild without API calls', async () => {
  const disabled = makeFixture({ enabled: false });
  assert.equal(await sendWelcome(disabled.member, { settings: disabled.settings, guildId }), 'skipped');
  const bot = makeFixture();
  assert.equal(await sendWelcome({ ...bot.member, user: { bot: true } }, { settings: bot.settings, guildId }), 'skipped');
  const otherGuild = makeFixture();
  assert.equal(await sendWelcome({ ...otherGuild.member, guild: { ...otherGuild.guild, id: '987654321098765432' } }, { settings: otherGuild.settings, guildId }), 'skipped');
  assert.deepEqual(disabled.calls, { channelFetch: 0, send: 0, memberFetch: 0, rolesFetch: 0 });
  assert.deepEqual(bot.calls, { channelFetch: 0, send: 0, memberFetch: 0, rolesFetch: 0 });
  assert.deepEqual(otherGuild.calls, { channelFetch: 0, send: 0, memberFetch: 0, rolesFetch: 0 });
});

test('refreshes the channel, roles and bot member before checking permissions and sending', async () => {
  const fixture = makeFixture();
  let sentPayload;
  fixture.channel.send = async (payload) => {
    fixture.calls.send += 1;
    sentPayload = payload;
  };

  assert.equal(await sendWelcome(fixture.member, { settings: fixture.settings, guildId }), 'sent');
  assert.deepEqual(fixture.calls, { channelFetch: 1, send: 1, memberFetch: 1, rolesFetch: 1 });
  assert.deepEqual(fixture.guild.channels.fetchOptions, { force: true });
  assert.deepEqual(fixture.guild.members.fetchMeOptions, { force: true });
  assert.equal(sentPayload.content, `ยินดีต้อนรับ <@${userId}> 🎉`);
  assert.deepEqual(sentPayload.allowedMentions, { parse: [], users: [userId] });
});

test('rejects missing, foreign, non-text channels and missing bot permissions', async (t) => {
  const cases = [
    ['missing channel', { channel: null }],
    ['foreign guild channel', { channel: { id: channelId, guildId: '987654321098765432', type: ChannelType.GuildText } }],
    ['non-text channel', { channel: { id: channelId, guildId, type: ChannelType.GuildVoice } }],
    ['bot cannot view channel', { bot: [PermissionFlagsBits.SendMessages] }],
    ['bot cannot send messages', { bot: [PermissionFlagsBits.ViewChannel] }],
  ];

  for (const [name, channelOverrides] of cases) {
    await t.test(name, async () => {
      const fixture = makeFixture({ channelOverrides });
      await assert.rejects(sendWelcome(fixture.member, { settings: fixture.settings, guildId }));
      assert.equal(fixture.calls.send, 0);
    });
  }
});

test('propagates bot member lookup failures without sending', async () => {
  const fixture = makeFixture({ channelOverrides: { memberFetchError: new Error('lookup failed') } });
  await assert.rejects(sendWelcome(fixture.member, { settings: fixture.settings, guildId }), /lookup failed/);
  assert.equal(fixture.calls.send, 0);
});

test('does not mutate settings when sending fails', async () => {
  const fixture = makeFixture({ send: async () => { throw new Error('Discord send failed'); } });
  let writes = 0;
  fixture.settings.set = async () => { writes += 1; };
  fixture.settings.disable = async () => { writes += 1; };

  await assert.rejects(sendWelcome(fixture.member, { settings: fixture.settings, guildId }), /Discord send failed/);
  assert.equal(writes, 0);
});
