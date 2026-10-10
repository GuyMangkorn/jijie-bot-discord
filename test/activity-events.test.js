import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activityFromMember,
  activityFromMessage,
  activityFromVoiceState,
} from '../src/activity/activity-events.js';

const member = (userId = 'user', bot = false, guildId = 'guild') => ({
  id: userId, guild: { id: guildId }, user: { id: userId, bot },
});

test('message event contains IDs and time without copying text', () => {
  const event = activityFromMessage({
    guildId: 'guild', channelId: 'channel', id: 'message', createdTimestamp: 1000,
    author: { id: 'user', bot: false }, content: 'private text', webhookId: null,
  });
  assert.deepEqual(event, {
    guildId: 'guild', userId: 'user', isBot: false, type: 'message', at: 1000,
    channelId: 'channel', messageId: 'message',
  });
  assert.equal(Object.hasOwn(event, 'content'), false);
  assert.equal(activityFromMessage({ guildId: null }), null);
  assert.equal(activityFromMessage({ guildId: 'guild', author: { id: 'bot', bot: true } }), null);
});

test('voice state changes distinguish join, leave, and move while ignoring other changes', () => {
  assert.equal(activityFromVoiceState(member(), { channelId: null }, { channelId: 'one' }, 1000).type, 'voice_join');
  assert.deepEqual(activityFromVoiceState(member(), { channelId: 'one' }, { channelId: null }, 2000), {
    guildId: 'guild', userId: 'user', isBot: false, type: 'voice_leave', at: 2000, channelId: 'one',
  });
  assert.deepEqual(activityFromVoiceState(member(), { channelId: 'one' }, { channelId: 'two' }, 3000), {
    guildId: 'guild', userId: 'user', isBot: false, type: 'voice_move', at: 3000,
    fromChannelId: 'one', channelId: 'two',
  });
  assert.equal(activityFromVoiceState(member(), { channelId: 'one' }, { channelId: 'one' }, 4000), null);
  assert.equal(activityFromVoiceState(member('bot', true), { channelId: null }, { channelId: 'one' }, 5000), null);
});

test('member gateway events preserve the distinction between join and leave', () => {
  assert.equal(activityFromMember(member(), 'join', 1000).type, 'guild_join');
  assert.equal(activityFromMember(member(), 'leave', 2000).type, 'guild_leave');
  assert.equal(activityFromMember(member('bot', true), 'join', 3000), null);
});
