import { ChannelType, PermissionFlagsBits } from 'discord.js';

// Permission inputs must all be refreshed before any permission calculation.
export async function refreshJijiAccess(guild, channelId, userId) {
  const [channel, requester, bot] = await Promise.all([
    guild.channels.fetch(channelId, { force: true }),
    guild.members.fetch({ user: userId, force: true }),
    guild.members.fetchMe({ force: true }),
    guild.roles.fetch(),
  ]);
  if (!channel || !requester || !bot) throw new Error('Jiji access data unavailable');
  const valid = channel.id === channelId && channel.guildId === guild.id && channel.type === ChannelType.GuildText;
  const has = (member, permission) => channel.permissionsFor?.(member)?.has(permission) === true;
  const canView = valid && has(requester, PermissionFlagsBits.ViewChannel) && has(bot, PermissionFlagsBits.ViewChannel);
  return {
    channel, requester, bot, canView,
    canSend: canView && has(bot, PermissionFlagsBits.SendMessages),
    isManager: requester.permissions?.has(PermissionFlagsBits.ManageGuild) === true,
  };
}
