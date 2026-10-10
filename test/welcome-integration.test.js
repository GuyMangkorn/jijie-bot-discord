import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ChannelType, Events, PermissionFlagsBits } from 'discord.js';
import { openWelcomeSettings } from '../src/welcome/welcome-settings.js';
import { registerMemberJoinHandler } from '../src/welcome/member-join.js';
import { registerInteractionDispatcher } from '../src/commands/interaction-dispatch.js';

const guildId = '234567890123456789';
const channelId = '123456789012345678';
const managerId = '345678901234567890';
const userId = '567890123456789012';

test('manager setup persists and the join event records activity and sends a welcome', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'welcome-integration-'));
  try {
    const settings = await openWelcomeSettings(join(directory, 'welcome.json'), guildId);
    const records = [];
    const sends = [];
    const callbacks = new Map();
    const botMember = { id: '456789012345678901', user: { bot: true } };
    const manager = { id: managerId, user: { bot: false } };
    const channel = {
      id: channelId,
      name: 'welcome',
      guildId,
      type: ChannelType.GuildText,
      permissionsFor() { return { has: () => true }; },
      async send(payload) { sends.push(payload); },
    };
    const guild = {
      id: guildId,
      channels: { async fetch(id, options) { assert.equal(id, channelId); assert.deepEqual(options, { force: true }); return channel; } },
      members: {
        async fetch(options) { assert.deepEqual(options, { user: managerId, force: true }); return manager; },
        async fetchMe(options) { assert.deepEqual(options, { force: true }); return botMember; },
      },
      roles: { async fetch() { return new Map(); } },
    };
    const client = { on(event, callback) { callbacks.set(event, callback); } };
    const activityLog = { async record(event) { records.push(event); } };
    registerMemberJoinHandler(client, { settings, activityLog, guildId });
    registerInteractionDispatcher(client, {
      activityLog, departureLog: {}, guildId, welcomeSettings: settings,
      jijiRuntime: { async handleInteraction() {} },
    });

    const interactionReplies = [];
    const setup = {
      commandName: 'ต้อนรับ',
      guild,
      user: { id: managerId },
      memberPermissions: { has: (permission) => permission === PermissionFlagsBits.ManageGuild },
      options: {
        getSubcommand: () => 'ตั้งค่า',
        getChannel: () => channel,
        getString: () => 'ยินดีต้อนรับ {member} 🎉',
      },
      isChatInputCommand: () => true,
      async deferReply() {},
      async editReply(payload) { interactionReplies.push(payload); },
    };
    await callbacks.get(Events.InteractionCreate)(setup);
    assert.match(interactionReplies[0].content, /ตั้งค่าข้อความต้อนรับใน #welcome แล้ว/);

    const member = { id: userId, guild, user: { id: userId, bot: false } };
    await callbacks.get(Events.GuildMemberAdd)(member);

    assert.equal(records.length, 1);
    assert.equal(records[0].type, 'guild_join');
    assert.equal(sends.length, 1);
    assert.equal(sends[0].content, `ยินดีต้อนรับ <@${userId}> 🎉`);
    assert.deepEqual(sends[0].allowedMentions, { parse: [], users: [userId] });
    assert.deepEqual(await (await openWelcomeSettings(join(directory, 'welcome.json'), guildId)).get(), {
      channelId,
      template: 'ยินดีต้อนรับ {member} 🎉',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
