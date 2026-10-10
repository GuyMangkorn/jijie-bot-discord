import assert from 'node:assert/strict';
import test from 'node:test';
import { ChannelType, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { welcomeCommandData, handleWelcome } from '../src/welcome-command.js';

const guildId = '234567890123456789';
const channelId = '123456789012345678';
const managerId = '345678901234567890';
const botId = '456789012345678901';

function makeFixture({
  commandName = 'ต้อนรับ',
  subcommand = 'ตั้งค่า',
  manager = true,
  channelType = ChannelType.GuildText,
  channelGuildId = guildId,
  channelFetchResult,
  channelFetchError,
  memberFetchError,
  botFetchError,
  requesterCanView = true,
  freshRequesterCanView = requesterCanView,
  botPermissions = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
  template = null,
  config = { channelId: null, template: null },
  setError,
  disableError,
  guild = true,
} = {}) {
  const calls = [];
  const replies = [];
  const requester = { id: managerId, fresh: false, user: { bot: false } };
  const freshRequester = { id: managerId, fresh: true, user: { bot: false } };
  const botMember = { id: botId, fresh: false, user: { bot: true } };
  const freshBotMember = { id: botId, fresh: true, user: { bot: true } };
  const makeChannel = (fresh) => ({
    id: channelId,
    name: 'welcome',
    guildId: channelGuildId,
    type: channelType,
    permissionsFor(member) {
      const permissions = member.user.bot
        ? botPermissions
        : ((fresh && member.fresh ? freshRequesterCanView : requesterCanView) ? [PermissionFlagsBits.ViewChannel] : []);
      return { has: (permission) => permissions.includes(permission) };
    },
  });
  const channel = makeChannel(false);
  const freshChannel = makeChannel(true);
  const server = {
    id: guildId,
    channels: {
      async fetch(id, options) {
        calls.push(['channel.fetch', id, options]);
        if (channelFetchError) throw channelFetchError;
        return channelFetchResult === undefined ? (options?.force ? freshChannel : channel) : channelFetchResult;
      },
    },
    members: {
      async fetch(options) {
        calls.push(['member.fetch', options]);
        if (memberFetchError) throw memberFetchError;
        return options?.force ? freshRequester : requester;
      },
      async fetchMe(options) {
        calls.push(['member.fetchMe', options]);
        if (botFetchError) throw botFetchError;
        return options?.force ? freshBotMember : botMember;
      },
    },
    roles: {
      async fetch() { calls.push(['roles.fetch']); return new Map(); },
    },
  };
  const settings = {
    async get() { calls.push(['settings.get']); return { ...config }; },
    async set(value) {
      calls.push(['settings.set', value]);
      if (setError) throw setError;
      config = { ...value };
    },
    async disable() {
      calls.push(['settings.disable']);
      if (disableError) throw disableError;
      config = { channelId: null, template: null };
    },
  };
  const interaction = {
    commandName,
    guild: guild ? server : null,
    user: { id: managerId },
    memberPermissions: { has: (permission) => manager && permission === PermissionFlagsBits.ManageGuild },
    options: {
      getSubcommand() { return subcommand; },
      getChannel(name) { assert.equal(name, 'ห้อง'); return channel; },
      getString(name) { assert.equal(name, 'ข้อความ'); return template; },
    },
    isChatInputCommand() { return true; },
    async reply(payload) { replies.push(['reply', payload]); return { id: 'reply' }; },
    async deferReply(options) { calls.push(['defer', options]); },
    async editReply(payload) { replies.push(['edit', payload]); return { id: 'reply' }; },
  };
  return { calls, channel, interaction, replies, settings };
}

test('registers the three manager-only subcommands with a text channel and bounded template option', () => {
  assert.equal(welcomeCommandData.name, 'ต้อนรับ');
  assert.equal(welcomeCommandData.default_member_permissions, String(PermissionFlagsBits.ManageGuild));
  assert.deepEqual(welcomeCommandData.options.map(({ name }) => name), ['ตั้งค่า', 'ดู', 'ปิด']);

  const [setup] = welcomeCommandData.options;
  assert.equal(setup.type, 1);
  assert.equal(setup.options[0].type, 7);
  assert.equal(setup.options[0].name, 'ห้อง');
  assert.deepEqual(setup.options[0].channel_types, [ChannelType.GuildText]);
  assert.equal(setup.options[0].required, true);
  assert.equal(setup.options[1].type, 3);
  assert.equal(setup.options[1].required, false);
  assert.equal(setup.options[1].min_length, 1);
  assert.equal(setup.options[1].max_length, 1000);
});

test('sets a selected channel with the default template after acknowledging ephemerally', async () => {
  const fixture = makeFixture();
  await handleWelcome(fixture.interaction, { settings: fixture.settings, guildId });

  assert.equal(fixture.calls[0][0], 'defer');
  assert.equal(fixture.calls[0][1].flags, MessageFlags.Ephemeral);
  assert.deepEqual(fixture.calls.find(([name]) => name === 'settings.set')[1], {
    channelId,
    template: 'ยินดีต้อนรับ {member} เข้าสู่เซิร์ฟเวอร์ 🎉',
  });
  assert.deepEqual(fixture.calls.find(([name]) => name === 'channel.fetch'), ['channel.fetch', channelId, { force: true }]);
  assert.deepEqual(fixture.calls.find(([name]) => name === 'member.fetch'), ['member.fetch', { user: managerId, force: true }]);
  assert.deepEqual(fixture.calls.find(([name]) => name === 'member.fetchMe'), ['member.fetchMe', { force: true }]);
  assert.equal(fixture.calls.some(([name]) => name === 'roles.fetch'), true);
  assert.match(fixture.replies[0][1].content, /#welcome/);
  assert.deepEqual(fixture.replies[0][1].allowedMentions, { parse: [] });
});

test('trims and saves a custom template', async () => {
  const fixture = makeFixture({ template: '  สวัสดี {member}  ' });
  await handleWelcome(fixture.interaction, { settings: fixture.settings, guildId });

  assert.deepEqual(fixture.calls.find(([name]) => name === 'settings.set')[1], {
    channelId,
    template: 'สวัสดี {member}',
  });
});

test('rejects unauthorized, DM and foreign-guild invocations before reading or writing settings', async (t) => {
  const cases = [
    ['member without Manage Server', { manager: false }],
    ['DM invocation', { guild: false }],
    ['another guild', { guild: true, guildIdOverride: '987654321098765432' }],
  ];

  for (const [name, options] of cases) {
    await t.test(name, async () => {
      const fixture = makeFixture(options);
      if (options.guildIdOverride) fixture.interaction.guild.id = options.guildIdOverride;
      await handleWelcome(fixture.interaction, { settings: fixture.settings, guildId });
      assert.equal(fixture.calls.some(([call]) => call === 'settings.get' || call === 'settings.set' || call === 'settings.disable'), false);
      assert.equal(fixture.replies[0][1].flags, MessageFlags.Ephemeral);
    });
  }
});

test('ignores other commands', async () => {
  const fixture = makeFixture({ commandName: 'ล่าสุด' });
  await handleWelcome(fixture.interaction, { settings: fixture.settings, guildId });
  assert.deepEqual(fixture.calls, []);
  assert.deepEqual(fixture.replies, []);
});

test('shows an enabled setting to a manager who can view its channel without allowing mentions', async () => {
  const fixture = makeFixture({ subcommand: 'ดู', config: { channelId, template: 'Hello {member} @everyone' } });
  await handleWelcome(fixture.interaction, { settings: fixture.settings, guildId });

  assert.match(fixture.replies[0][1].content, /#welcome/);
  assert.match(fixture.replies[0][1].content, /Hello \{member\} @everyone/);
  assert.deepEqual(fixture.replies[0][1].allowedMentions, { parse: [] });
});

test('hides a configured channel and template when the manager cannot view the channel', async () => {
  const secretTemplate = 'SECRET TEMPLATE';
  const fixture = makeFixture({ subcommand: 'ดู', requesterCanView: false, config: { channelId, template: secretTemplate } });
  await handleWelcome(fixture.interaction, { settings: fixture.settings, guildId });

  assert.doesNotMatch(fixture.replies[0][1].content, /SECRET|123456789012345678|welcome/);
});

test('refreshes cached permission data before revealing a configured welcome template', async () => {
  const secretTemplate = 'SECRET TEMPLATE';
  const fixture = makeFixture({
    subcommand: 'ดู',
    requesterCanView: true,
    freshRequesterCanView: false,
    config: { channelId, template: secretTemplate },
  });
  await handleWelcome(fixture.interaction, { settings: fixture.settings, guildId });

  assert.doesNotMatch(fixture.replies[0][1].content, /SECRET|123456789012345678|welcome/);
  assert.equal(fixture.calls.some(([name]) => name === 'roles.fetch'), true);
  assert.deepEqual(fixture.calls.find(([name]) => name === 'channel.fetch'), ['channel.fetch', channelId, { force: true }]);
  assert.deepEqual(fixture.calls.find(([name]) => name === 'member.fetch'), ['member.fetch', { user: managerId, force: true }]);
});

test('reports deleted channels separately from channel lookup failures', async (t) => {
  t.mock.method(console, 'error', () => {});
  await t.test('deleted channel', async () => {
    const fixture = makeFixture({ subcommand: 'ดู', channelFetchResult: null, config: { channelId, template: 'Hello' } });
    await handleWelcome(fixture.interaction, { settings: fixture.settings, guildId });
    assert.match(fixture.replies[0][1].content, /ไม่พร้อมใช้งาน/);
    assert.doesNotMatch(fixture.replies[0][1].content, /123456789012345678|Hello/);
  });

  await t.test('unknown channel API error', async () => {
    const fixture = makeFixture({ subcommand: 'ดู', channelFetchError: Object.assign(new Error('unknown'), { code: 10003 }), config: { channelId, template: 'Hello' } });
    await handleWelcome(fixture.interaction, { settings: fixture.settings, guildId });
    assert.match(fixture.replies[0][1].content, /ไม่พร้อมใช้งาน/);
  });

  await t.test('other API failure', async () => {
    const fixture = makeFixture({ subcommand: 'ดู', channelFetchError: Object.assign(new Error('secret API detail'), { code: 500 }), config: { channelId, template: 'Hello' } });
    await handleWelcome(fixture.interaction, { settings: fixture.settings, guildId });
    assert.match(fixture.replies[0][1].content, /ตรวจสอบห้องไม่สำเร็จ/);
    assert.doesNotMatch(fixture.replies[0][1].content, /secret API detail/);
  });
});

test('rejects invalid template and channels before saving', async (t) => {
  const cases = [
    ['empty template', { template: '   ' }],
    ['oversized expanded message', { template: '{member}'.repeat(100) }],
    ['voice channel', { channelType: ChannelType.GuildVoice }],
    ['foreign channel', { channelGuildId: '987654321098765432' }],
    ['deleted channel', { channelFetchResult: null }],
  ];
  for (const [name, options] of cases) {
    await t.test(name, async () => {
      const fixture = makeFixture(options);
      await handleWelcome(fixture.interaction, { settings: fixture.settings, guildId });
      assert.equal(fixture.calls.some(([call]) => call === 'settings.set'), false);
      assert.equal(fixture.replies.some(([, reply]) => /ตั้งค่าสำเร็จ/.test(reply.content ?? '')), false);
    });
  }
});

test('requires manager view and bot view/send permissions in the selected channel', async (t) => {
  const cases = [
    ['manager cannot view channel', { requesterCanView: false }],
    ['bot cannot view channel', { botPermissions: [PermissionFlagsBits.SendMessages] }],
    ['bot cannot send in channel', { botPermissions: [PermissionFlagsBits.ViewChannel] }],
  ];
  for (const [name, options] of cases) {
    await t.test(name, async () => {
      const fixture = makeFixture(options);
      await handleWelcome(fixture.interaction, { settings: fixture.settings, guildId });
      assert.equal(fixture.calls.some(([call]) => call === 'settings.set'), false);
      assert.match(fixture.replies[0][1].content, /สิทธิ์|ดูห้อง/);
    });
  }
});

test('handles member lookup and persistence failures with Thai errors and no success confirmation', async (t) => {
  t.mock.method(console, 'error', () => {});
  const cases = [
    ['requester member lookup', { memberFetchError: new Error('private error') }],
    ['bot member lookup', { botFetchError: new Error('private error') }],
    ['settings write', { setError: new Error('private error') }],
  ];
  for (const [name, options] of cases) {
    await t.test(name, async () => {
      const fixture = makeFixture(options);
      await handleWelcome(fixture.interaction, { settings: fixture.settings, guildId });
      assert.doesNotMatch(fixture.replies[0][1].content, /private error/);
      assert.equal(fixture.replies.some(([, reply]) => /ตั้งค่าสำเร็จ/.test(reply.content ?? '')), false);
    });
  }
});

test('shows disabled state and clears settings on disable', async (t) => {
  await t.test('view disabled', async () => {
    const fixture = makeFixture({ subcommand: 'ดู' });
    await handleWelcome(fixture.interaction, { settings: fixture.settings, guildId });
    assert.match(fixture.replies[0][1].content, /ปิดอยู่/);
  });

  await t.test('disable enabled welcome', async () => {
    const fixture = makeFixture({ subcommand: 'ปิด', config: { channelId, template: 'Hello' } });
    await handleWelcome(fixture.interaction, { settings: fixture.settings, guildId });
    assert.deepEqual(fixture.calls.find(([name]) => name === 'settings.disable'), ['settings.disable']);
    assert.match(fixture.replies[0][1].content, /ปิดข้อความต้อนรับแล้ว/);
  });
});
