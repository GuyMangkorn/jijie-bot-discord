import assert from 'node:assert/strict';
import test from 'node:test';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { handleMemberJoin } from '../src/member-join.js';

const guildId = '234567890123456789';
const channelId = '123456789012345678';
const userId = '345678901234567890';

function makeFixture({ recordError, sendError, guild = guildId, bot = false } = {}) {
  const records = [];
  const sent = [];
  let settingsReads = 0;
  const botMember = { id: '456789012345678901', user: { bot: true } };
  const welcomeChannel = {
    id: channelId,
    guildId,
    type: ChannelType.GuildText,
    permissionsFor() { return { has: () => true }; },
    async send(payload) {
      if (sendError) throw sendError;
      sent.push(payload);
    },
  };
  const memberGuild = {
    id: guild,
    channels: { async fetch() { return welcomeChannel; } },
    members: { async fetchMe() { return botMember; } },
    roles: { async fetch() { return new Map(); } },
  };
  const member = { id: userId, guild: memberGuild, user: { id: userId, bot } };
  const activityLog = {
    async record(event) {
      if (recordError) throw recordError;
      records.push(event);
    },
  };
  const settings = {
    async get() {
      settingsReads += 1;
      return { channelId, template: 'Welcome {member}' };
    },
  };
  return { activityLog, member, records, sent, settings, get settingsReads() { return settingsReads; } };
}

test('records the join and sends one welcome for a human member in the configured guild', async () => {
  const fixture = makeFixture();
  await handleMemberJoin(fixture.member, { activityLog: fixture.activityLog, settings: fixture.settings, guildId });

  assert.equal(fixture.records.length, 1);
  assert.equal(fixture.records[0].guildId, guildId);
  assert.equal(fixture.records[0].userId, userId);
  assert.equal(fixture.records[0].type, 'guild_join');
  assert.equal(fixture.sent.length, 1);
  assert.equal(fixture.sent[0].content, `Welcome <@${userId}>`);
});

test('ignores bot members and members from another guild before activity or settings work', async () => {
  for (const options of [{ bot: true }, { guild: '987654321098765432' }]) {
    const fixture = makeFixture(options);
    await handleMemberJoin(fixture.member, { activityLog: fixture.activityLog, settings: fixture.settings, guildId });
    assert.equal(fixture.records.length, 0);
    assert.equal(fixture.sent.length, 0);
    assert.equal(fixture.settingsReads, 0);
  }
});

test('a join history write failure does not prevent the welcome message', async (t) => {
  t.mock.method(console, 'error', () => {});
  const fixture = makeFixture({ recordError: new Error('private storage detail') });
  await handleMemberJoin(fixture.member, { activityLog: fixture.activityLog, settings: fixture.settings, guildId });

  assert.equal(fixture.sent.length, 1);
  assert.equal(fixture.sent[0].content, `Welcome <@${userId}>`);
});

test('a welcome send failure does not prevent recording the join', async (t) => {
  t.mock.method(console, 'error', () => {});
  const fixture = makeFixture({ sendError: new Error('private send detail') });
  await handleMemberJoin(fixture.member, { activityLog: fixture.activityLog, settings: fixture.settings, guildId });

  assert.equal(fixture.records.length, 1);
  assert.equal(fixture.records[0].type, 'guild_join');
});
