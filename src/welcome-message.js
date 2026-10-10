import { ChannelType, PermissionFlagsBits } from 'discord.js';

export const DEFAULT_WELCOME_TEMPLATE = 'ยินดีต้อนรับ {member} เข้าสู่เซิร์ฟเวอร์ 🎉';

const MAX_TEMPLATE_LENGTH = 1000;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_USER_ID = '9'.repeat(20);
const CHANNEL_PERMISSIONS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];

function expandTemplate(template, userId) {
  return template.replaceAll('{member}', `<@${userId}>`);
}

export function validateWelcomeTemplate(template) {
  if (typeof template !== 'string') throw new Error('Welcome template must be a string');
  const normalized = template.trim();
  if (!normalized) throw new Error('Welcome template cannot be empty');
  if (normalized.length > MAX_TEMPLATE_LENGTH) {
    throw new Error(`Welcome template must be at most ${MAX_TEMPLATE_LENGTH} characters`);
  }
  if (expandTemplate(normalized, MAX_USER_ID).length > MAX_MESSAGE_LENGTH) {
    throw new Error(`Expanded welcome message must be at most ${MAX_MESSAGE_LENGTH} characters`);
  }
  return normalized;
}

export function buildWelcomeMessage(template, userId) {
  if (typeof userId !== 'string' || !/^\d{17,20}$/.test(userId)) {
    throw new Error('Invalid member ID');
  }
  const normalizedTemplate = validateWelcomeTemplate(template);
  const content = expandTemplate(normalizedTemplate, userId);
  if (content.length > MAX_MESSAGE_LENGTH) {
    throw new Error(`Expanded welcome message must be at most ${MAX_MESSAGE_LENGTH} characters`);
  }
  return {
    content,
    allowedMentions: { parse: [], users: normalizedTemplate.includes('{member}') ? [userId] : [] },
  };
}

function hasChannelPermissions(channel, member, permissions) {
  const channelPermissions = channel.permissionsFor?.(member);
  return permissions.every((permission) => channelPermissions?.has(permission) === true);
}

export async function sendWelcome(member, { settings, guildId }) {
  if (!member?.guild?.id || member.guild.id !== guildId || member.user?.bot === true) return 'skipped';

  const config = await settings.get();
  if (!config?.channelId || !config.template) return 'skipped';

  const channel = await member.guild.channels.fetch(config.channelId, { force: true });
  if (!channel || channel.id !== config.channelId || channel.guildId !== guildId || channel.type !== ChannelType.GuildText) {
    throw new Error('Welcome channel is unavailable');
  }

  const [botMember] = await Promise.all([
    member.guild.members.fetchMe({ force: true }),
    member.guild.roles.fetch(),
  ]);
  if (!botMember) throw new Error('Bot member is unavailable');
  if (!hasChannelPermissions(channel, botMember, CHANNEL_PERMISSIONS)) {
    throw new Error('Bot cannot view and send messages in the welcome channel');
  }

  await channel.send(buildWelcomeMessage(config.template, member.id));
  return 'sent';
}
