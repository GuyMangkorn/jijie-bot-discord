import { ChannelType, PermissionFlagsBits } from 'discord.js';

const unavailableChannelCodes = new Set(['10003', '50001', '50013']);
export class JijiChannelUnavailableError extends Error {
  constructor() { super('Jiji channel unavailable'); this.name = 'JijiChannelUnavailableError'; }
}

// Permission inputs must all be refreshed before any permission calculation.
export async function refreshJijiAccess(guild, channelId, userId) {
  const results = await Promise.allSettled([
    guild.channels.fetch(channelId, { force: true }),
    guild.members.fetch({ user: userId, force: true }),
    guild.members.fetchMe({ force: true }),
    guild.roles.fetch(),
  ]);
  // Member/role failures are access failures, even when this channel is also unavailable.
  for (const result of results.slice(1)) {
    if (result.status === 'rejected') throw result.reason;
  }
  const requester = results[1].value, bot = results[2].value;
  if (!requester || !bot) throw new Error('Jiji access data unavailable');
  const channelResult = results[0];
  if (channelResult.status === 'rejected') {
    const code = String(channelResult.reason?.code ?? channelResult.reason?.rawError?.code);
    if (unavailableChannelCodes.has(code)) throw new JijiChannelUnavailableError();
    throw channelResult.reason;
  }
  const channel = channelResult.value;
  if (!channel) throw new JijiChannelUnavailableError();
  const valid = channel.id === channelId && channel.guildId === guild.id && channel.type === ChannelType.GuildText;
  const has = (member, permission) => channel.permissionsFor?.(member)?.has(permission) === true;
  const canView = valid && has(requester, PermissionFlagsBits.ViewChannel) && has(bot, PermissionFlagsBits.ViewChannel);
  return {
    channel, requester, bot, canView,
    canSend: canView && has(bot, PermissionFlagsBits.SendMessages),
    isManager: requester.permissions?.has(PermissionFlagsBits.ManageGuild) === true,
  };
}
