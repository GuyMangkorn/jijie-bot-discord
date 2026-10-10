function memberIdentity(member) {
  const userId = member?.id ?? member?.user?.id;
  if (!member?.guild?.id || !userId) return null;
  return {
    guildId: member.guild.id,
    userId,
    isBot: member.user?.bot === true,
  };
}

export function activityFromMessage(message) {
  const guildId = message.guildId ?? message.guild?.id;
  const userId = message.author?.id;
  if (!guildId || !userId || message.author?.bot || message.webhookId) return null;
  return {
    guildId,
    userId,
    isBot: false,
    type: 'message',
    at: message.createdTimestamp,
    channelId: message.channelId ?? message.channel?.id,
    messageId: message.id,
  };
}

export function activityFromVoiceState(member, before, after, at = Date.now()) {
  const identity = memberIdentity(member);
  if (!identity || identity.isBot) return null;
  const fromChannelId = before?.channelId ?? null;
  const channelId = after?.channelId ?? null;
  if (fromChannelId === channelId) return null;
  if (!fromChannelId && channelId) return { ...identity, type: 'voice_join', at, channelId };
  if (fromChannelId && !channelId) return { ...identity, type: 'voice_leave', at, channelId: fromChannelId };
  return { ...identity, type: 'voice_move', at, fromChannelId, channelId };
}

export function activityFromMember(member, action, at = Date.now()) {
  const identity = memberIdentity(member);
  if (!identity || identity.isBot) return null;
  if (action !== 'join' && action !== 'leave') throw new Error('Invalid member activity action');
  return { ...identity, type: action === 'join' ? 'guild_join' : 'guild_leave', at };
}
