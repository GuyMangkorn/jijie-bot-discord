import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, AuditLogEvent, ChannelType, PermissionsBitField } from 'discord.js';
import {
  collectAuditHistory,
  collectMessageHistory,
  combineActivityRecords,
  canReadChannel,
  canViewChannel,
  buildActivityEmbed,
} from '../src/activity-history.js';

const permissions = new PermissionsBitField([
  PermissionsBitField.Flags.ViewChannel,
  PermissionsBitField.Flags.ReadMessageHistory,
  PermissionsBitField.Flags.ViewAuditLog,
]);
const member = { id: 'requester', permissions };
const bot = { id: 'bot', permissions };
const message = (id, authorId, at, content = 'do not retain this') => ({
  id, author: { id: authorId }, createdTimestamp: at, channelId: 'text', content,
});
const channel = (id, type = ChannelType.GuildText, messages = []) => {
  const result = {
    id, name: id, type, isThread: () => type === ChannelType.PublicThread || type === ChannelType.PrivateThread,
    isPrivate: () => type === ChannelType.PrivateThread,
    messages: { fetch: async () => new Collection(messages.map((item) => [item.id, item])) },
  };
  result.permissionsFor = (who) => result.grants === false
    ? new PermissionsBitField([])
    : who?.permissions ?? permissions;
  return result;
};

test('message history pages channels, filters by user and range, and keeps only metadata', async () => {
  const before = [];
  const pages = [
    [message('4', 'user', 4000), message('3', 'other', 3000)],
    [message('2', 'user', 2000), message('1', 'user', 1000)],
  ];
  const text = channel('text');
  text.messages.fetch = async (options) => {
    before.push(options);
    return new Collection(pages[before.length - 1].map((item) => [item.id, item]));
  };
  const guild = {
    channels: {
      cache: new Collection([[text.id, text]]),
      fetchActiveThreads: async () => ({ threads: new Collection() }),
    },
  };

  const result = await collectMessageHistory({
    guild, userId: 'user', since: 1500, until: 4500,
    requesterMember: member, botMember: bot, deadline: Infinity, pageSize: 2,
  });

  assert.deepEqual(result.records.map((record) => record.messageId), ['4', '2']);
  assert.equal(result.records[0].source, 'discord_history');
  assert.equal(Object.hasOwn(result.records[0], 'content'), false);
  assert.deepEqual(before.map((options) => options.limit), [2, 2]);
  assert.equal(before[1].before, '3');
  assert.equal(result.complete, true);
});

test('history excludes archived and private threads and channels the requester or bot cannot read', async () => {
  const visible = channel('visible');
  visible.messages.grants = true;
  visible.messages.fetch = async () => new Collection([['m1', { ...message('m1', 'user', 3000), channelId: visible.id }]]);
  const hidden = channel('hidden');
  hidden.grants = false;
  hidden.messages.fetch = async () => { throw new Error('must not read'); };
  const privateThread = channel('private', ChannelType.PrivateThread);
  privateThread.messages.fetch = async () => { throw new Error('must not read'); };
  const archivedThread = channel('archived', ChannelType.PublicThread);
  archivedThread.archived = true;
  let archivedRead = false;
  archivedThread.messages.fetch = async () => { archivedRead = true; throw new Error('must not read'); };
  const publicThread = channel('public-thread', ChannelType.PublicThread);
  publicThread.messages.fetch = async () => new Collection([['m2', { ...message('m2', 'user', 4000), channelId: publicThread.id }]]);
  const guild = {
    channels: {
      cache: new Collection([[visible.id, visible], [hidden.id, hidden], [archivedThread.id, archivedThread]]),
      fetchActiveThreads: async () => ({ threads: new Collection([
        [privateThread.id, privateThread], [publicThread.id, publicThread],
      ]) }),
    },
  };

  const result = await collectMessageHistory({
    guild, userId: 'user', since: 0, until: 5000,
    requesterMember: member, botMember: bot, deadline: Infinity,
  });

  assert.deepEqual(result.records.map((record) => record.channelId).sort(), ['public-thread', 'visible']);
  assert.equal(result.complete, false);
  assert.equal(result.skippedChannels, 1);
  assert.equal(archivedRead, false);
});

test('history marks a per-channel cap as partial instead of claiming complete results', async () => {
  const text = channel('text');
  let page = 0;
  text.messages.fetch = async () => new Collection([[String(++page), message(String(page), 'user', 4000 - page)]]);
  const guild = {
    channels: { cache: new Collection([[text.id, text]]), fetchActiveThreads: async () => ({ threads: new Collection() }) },
  };
  const result = await collectMessageHistory({
    guild, userId: 'user', since: 0, until: 5000,
    requesterMember: member, botMember: bot, deadline: Infinity,
    maxPerChannel: 1, maxTotal: 10,
  });
  assert.equal(result.scannedMessages, 1);
  assert.equal(result.complete, false);
});

test('audit history matches both actor and target, paginates, and omits reasons', async () => {
  const calls = [];
  const pages = [
    [
      { id: '3', action: AuditLogEvent.MemberKick, targetId: 'user', executorId: 'mod', createdTimestamp: 4000, reason: 'private reason' },
      ...Array.from({ length: 99 }, (_, index) => ({ id: `f${index}`, action: AuditLogEvent.MemberRoleUpdate, targetId: 'other', executorId: 'mod', createdTimestamp: 3900 - index })),
    ],
    [
      { id: '2', action: AuditLogEvent.MemberRoleUpdate, targetId: 'other', executorId: 'user', createdTimestamp: 3000, reason: 'private reason' },
      { id: '1', action: AuditLogEvent.MemberKick, targetId: 'other', executorId: 'mod', createdTimestamp: 1000 },
    ],
  ];
  const guild = {
    channels: { cache: new Collection() },
    fetchAuditLogs: async (options) => {
      calls.push(options);
      return { entries: new Collection(pages[calls.length - 1].map((entry) => [entry.id, entry])) };
    },
  };
  const result = await collectAuditHistory({
    guild, userId: 'user', since: 2000, until: 5000,
    requesterMember: member, botMember: bot, deadline: Infinity,
  });
  assert.deepEqual(result.records.map((record) => record.id), ['3', '2']);
  assert.deepEqual(result.records.map((record) => record.relation), ['target', 'actor']);
  assert.equal(Object.hasOwn(result.records[0], 'reason'), false);
  assert.equal(calls[1].before, 'f98');
  assert.equal(result.complete, true);
});

test('audit history is withheld without both permissions and hides inaccessible channel entries', async () => {
  let fetched = false;
  const hidden = channel('deleted-or-hidden');
  hidden.grants = false;
  const guild = {
    channels: { cache: new Collection([[hidden.id, hidden]]) },
    fetchAuditLogs: async () => {
      fetched = true;
      return { entries: new Collection([
        ['2', { id: '2', action: AuditLogEvent.ChannelDelete, targetId: hidden.id, executorId: 'user', targetType: 'Channel', createdTimestamp: 3000 }],
      ]) };
    },
  };
  const noAuditMember = { id: 'requester', permissions: new PermissionsBitField([PermissionsBitField.Flags.ViewChannel]) };
  const denied = await collectAuditHistory({
    guild, userId: 'user', since: 0, until: 5000,
    requesterMember: noAuditMember, botMember: bot, deadline: Infinity,
  });
  assert.equal(fetched, false);
  assert.equal(denied.status, 'no_permission');

  const allowed = await collectAuditHistory({
    guild, userId: 'user', since: 0, until: 5000,
    requesterMember: member, botMember: bot, deadline: Infinity,
  });
  assert.equal(allowed.records.length, 0);
  assert.equal(allowed.hiddenEntries, 1);
});

test('audit history reports a configured result cap as partial', async () => {
  const entries = [
    { id: '3', action: AuditLogEvent.MemberKick, targetId: 'user', executorId: 'mod', createdTimestamp: 5000 },
    { id: '2', action: AuditLogEvent.MemberKick, targetId: 'user', executorId: 'mod', createdTimestamp: 4000 },
    { id: '1', action: AuditLogEvent.MemberKick, targetId: 'user', executorId: 'mod', createdTimestamp: 3000 },
  ];
  const guild = {
    channels: { cache: new Collection() },
    fetchAuditLogs: async ({ before }) => ({
      entries: new Collection(entries.filter((entry) => !before || entry.id < before).slice(0, 2).map((entry) => [entry.id, entry])),
    }),
  };
  const result = await collectAuditHistory({
    guild, userId: 'user', since: 0, until: 6000,
    requesterMember: member, botMember: bot, deadline: Infinity,
    maxEntries: 2, pageSize: 2,
  });
  assert.equal(result.scannedEntries, 2);
  assert.equal(result.status, 'partial');
  assert.equal(result.reason, 'audit_limit');
});

test('combining records deduplicates messages, sorts, caps at twenty, and formats scope', () => {
  const stored = Array.from({ length: 21 }, (_, index) => ({
    type: 'voice_join', userId: 'user', at: 5000 - index, channelId: 'voice',
  }));
  stored.push({ type: 'message', userId: 'user', at: 9000, channelId: 'text', messageId: 'same' });
  const history = [
    { type: 'message', userId: 'user', at: 9000, channelId: 'text', messageId: 'same', source: 'discord_history' },
    { type: 'message', userId: 'user', at: 10000, channelId: 'text', messageId: 'new', source: 'discord_history' },
  ];
  const records = combineActivityRecords(stored, history, 'user', 0, 11000);
  assert.equal(records.length, 20);
  assert.equal(records.filter((record) => record.messageId === 'same').length, 1);
  assert.equal(records[0].messageId, 'new');
  const embed = buildActivityEmbed({
    guildId: 'guild', userLabel: '@everyone', userId: 'user', since: 0, until: 11000,
    trackingStartedAt: 1000, records: [{ ...history[1], source: 'ย้อนหลัง' }],
    storedStatus: { status: 'complete' }, messageStatus: { status: 'partial', scannedMessages: 10 },
    auditStatus: { status: 'no_permission' },
  });
  assert.equal(embed.title.includes('@everyone'), false);
  const emptyEmbed = buildActivityEmbed({
    guildId: 'guild', userLabel: 'user', userId: 'user', since: 0, until: 11000,
    trackingStartedAt: 1000, records: [], storedStatus: { status: 'complete' },
    messageStatus: { status: 'complete' }, auditStatus: { status: 'no_permission' },
  });
  assert.match(emptyEmbed.description, /ไม่รับประกัน/);
  assert.match(embed.fields.find((field) => field.name === 'ข้อความย้อนหลัง').value, /ค้นได้บางส่วน/);
  assert.equal(embed.description.includes('do not retain this'), false);

  const fullEmbed = buildActivityEmbed({
    guildId: '12345678901234567890', userLabel: 'user', userId: '12345678901234567890',
    since: 0, until: 11000, trackingStartedAt: 1000,
    records: Array.from({ length: 20 }, (_, index) => ({
      type: 'audit', at: 10000 - index, id: String(index), actionLabel: 'แก้ไขการตั้งค่าเซิร์ฟเวอร์',
      relation: 'actor_and_target', actorId: '12345678901234567890', targetId: '12345678901234567890',
      channelId: '12345678901234567890', source: 'Audit Log',
    })),
    storedStatus: { status: 'complete' }, messageStatus: { status: 'complete' }, auditStatus: { status: 'complete' },
  });
  assert.ok(fullEmbed.description.length <= 4096);
});

test('current channel access requires view and read history', () => {
  const accessible = channel('readable');
  assert.equal(canReadChannel(accessible, member, bot), true);
  const hidden = channel('hidden');
  hidden.grants = false;
  assert.equal(canReadChannel(hidden, member, bot), false);
  assert.equal(canReadChannel(null, member, bot), false);
  const voiceOnly = channel('voice-only');
  const viewOnly = { id: 'viewer', permissions: new PermissionsBitField([PermissionsBitField.Flags.ViewChannel]) };
  assert.equal(canViewChannel(voiceOnly, viewOnly, viewOnly), true);
  assert.equal(canReadChannel(voiceOnly, viewOnly, viewOnly), false);
});
