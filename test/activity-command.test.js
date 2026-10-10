import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, ChannelType, MessageFlags, PermissionsBitField } from 'discord.js';
import { activityCommandData, collectActivity, createActivityQueryLimiter, handleActivity } from '../src/activity-command.js';

function interaction(overrides = {}) {
  const calls = [];
  const value = {
    isChatInputCommand: () => true,
    commandName: 'กิจกรรม',
    guild: { id: 'guild' },
    user: { id: 'requester' },
    options: {
      getUser: () => ({ id: 'target', username: 'target-user' }),
      getInteger: () => null,
    },
    deferReply: async (options) => calls.push({ type: 'defer', options }),
    editReply: async (reply) => calls.push({ type: 'edit', reply }),
    reply: async (reply) => calls.push({ type: 'reply', reply }),
    ...overrides,
  };
  return { value, calls };
}

test('activity command registers member and optional 1–30 day range', () => {
  assert.equal(activityCommandData.name, 'กิจกรรม');
  assert.deepEqual(activityCommandData.options.map((option) => ({
    name: option.name, type: option.type, required: option.required,
    min_value: option.min_value, max_value: option.max_value,
  })), [
    { name: 'สมาชิก', type: 6, required: true, min_value: undefined, max_value: undefined },
    { name: 'ช่วงวัน', type: 4, required: false, min_value: 1, max_value: 30 },
  ]);
});

test('activity command acknowledges ephemerally before searching and reports source completeness', async () => {
  const { value, calls } = interaction();
  const report = {
    guildId: 'guild', userLabel: 'target-user', userId: 'target', since: 1000, until: 2000,
    trackingStartedAt: 500, records: [],
    storedStatus: { status: 'complete' }, messageStatus: { status: 'partial', scannedMessages: 10 },
    auditStatus: { status: 'no_permission' },
  };
  await handleActivity(value, {
    activityLog: {}, guildId: 'guild',
    runSearch: async (options) => {
      assert.equal(calls[0].type, 'defer');
      assert.equal(calls[0].options.flags, MessageFlags.Ephemeral);
      assert.equal(options.target.id, 'target');
      assert.equal(options.days, 7);
      return report;
    },
  });
  assert.equal(calls[0].type, 'defer');
  assert.equal(calls[1].type, 'edit');
  assert.ok(calls[1].reply.embeds[0].data.fields.some((field) => field.name === 'ข้อความย้อนหลัง'));
  assert.deepEqual(calls[1].reply.allowedMentions, { parse: [] });
});

test('activity command rejects DMs and another guild before doing the search', async () => {
  const { value, calls } = interaction({ guild: { id: 'another-guild' } });
  await handleActivity(value, { activityLog: {}, guildId: 'guild', runSearch: async () => assert.fail('must not search') });
  assert.equal(calls[0].type, 'reply');
  assert.equal(calls[0].reply.flags, MessageFlags.Ephemeral);
});

test('query limiter allows two users, rejects duplicate users and releases slots after completion', async () => {
  const limiter = createActivityQueryLimiter(2);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const first = limiter.run('one', () => held);
  const second = limiter.run('two', async () => 'done');
  assert.deepEqual(await limiter.run('three', async () => 'overflow'), { accepted: false });
  assert.deepEqual(await limiter.run('one', async () => 'duplicate'), { accepted: false });
  assert.deepEqual(await second, { accepted: true, value: 'done' });
  release('released');
  assert.deepEqual(await first, { accepted: true, value: 'released' });
  assert.deepEqual(await limiter.run('three', async () => 'now accepted'), { accepted: true, value: 'now accepted' });
});

test('activity search deduplicates stored messages, filters inaccessible channels, and skips audit logs without permission', async () => {
  const viewAndHistory = new PermissionsBitField([
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.ReadMessageHistory,
  ]);
  const requester = { id: 'requester', permissions: viewAndHistory };
  const bot = { id: 'bot', permissions: viewAndHistory };
  const text = {
    id: 'text', type: ChannelType.GuildText,
    permissionsFor: (member) => member.permissions,
    messages: { fetch: async () => new Collection([['same', {
      id: 'same', channelId: 'text', author: { id: 'target' }, createdTimestamp: 1000, content: 'private text',
    }]]) },
  };
  const guild = {
    id: 'guild',
    channels: { cache: new Collection([['text', text]]), fetchActiveThreads: async () => ({ threads: new Collection() }) },
    members: { cache: new Collection([['requester', requester]]), me: bot },
    fetchAuditLogs: async () => assert.fail('audit permission is absent'),
  };
  const report = await collectActivity({
    interaction: { guild, user: { id: 'requester' } },
    target: { id: 'target', username: 'target' }, days: 1, now: 2000, deadline: Infinity,
    activityLog: {
      trackingStartedAt: 500,
      recordsFor: async () => [
        { type: 'message', userId: 'target', at: 1000, channelId: 'text', messageId: 'same' },
        { type: 'voice_join', userId: 'target', at: 900, channelId: 'text' },
        { type: 'message', userId: 'target', at: 800, channelId: 'missing', messageId: 'hidden' },
      ],
    },
  });
  assert.equal(report.records.filter((record) => record.messageId === 'same').length, 1);
  assert.equal(report.records[0].source, 'เก็บใหม่');
  assert.equal(report.records.some((record) => record.messageId === 'hidden'), false);
  assert.equal(report.records.some((record) => record.type === 'voice_join'), true);
  assert.equal(report.auditStatus.status, 'no_permission');
  assert.equal(report.storedStatus.hiddenRecords, 1);
});

test('activity search rechecks channel permissions before displaying results', async () => {
  const permissions = new PermissionsBitField([
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.ReadMessageHistory,
  ]);
  const requester = { id: 'requester', permissions };
  const bot = { id: 'bot', permissions };
  let canRead = true;
  const text = {
    id: 'text', type: ChannelType.GuildText,
    permissionsFor: (member) => canRead ? member.permissions : new PermissionsBitField([]),
    messages: { fetch: async () => {
      canRead = false;
      return new Collection([['msg', { id: 'msg', channelId: 'text', author: { id: 'target' }, createdTimestamp: 1000 }]]);
    } },
  };
  const guild = {
    id: 'guild',
    channels: { cache: new Collection([['text', text]]), fetchActiveThreads: async () => ({ threads: new Collection() }) },
    members: { cache: new Collection([['requester', requester]]), me: bot },
    fetchAuditLogs: async () => assert.fail('audit permission is absent'),
  };
  const report = await collectActivity({
    interaction: { guild, user: { id: 'requester' } },
    target: { id: 'target', username: 'target' }, days: 1, now: 2000, deadline: Infinity,
    activityLog: { trackingStartedAt: 500, recordsFor: async () => [] },
  });
  assert.deepEqual(report.records, []);
  assert.equal(report.messageStatus.status, 'partial');
  assert.equal(report.messageStatus.hiddenRecords, 1);
});

test('activity search reports a clear source status if requester permissions cannot be loaded', async () => {
  const bot = { id: 'bot', permissions: new PermissionsBitField(PermissionsBitField.Flags.ViewChannel) };
  const guild = {
    id: 'guild',
    channels: { cache: new Collection() },
    members: {
      cache: new Collection(), me: bot,
      fetch: async () => { throw new Error('unavailable'); },
    },
  };
  const report = await collectActivity({
    interaction: { guild, user: { id: 'requester' } },
    target: { id: 'target', username: 'target' }, days: 1, now: 2000, deadline: Infinity,
    activityLog: {
      trackingStartedAt: 500,
      recordsFor: async () => [{ type: 'guild_join', userId: 'target', at: 1000 }],
    },
  });
  assert.equal(report.messageStatus.status, 'error');
  assert.equal(report.messageStatus.reason, 'member_unavailable');
  assert.equal(report.auditStatus.status, 'error');
  assert.equal(report.records.length, 1);
});
