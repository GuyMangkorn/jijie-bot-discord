import { ChannelType, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { DEFAULT_WELCOME_TEMPLATE, validateWelcomeTemplate } from './welcome-message.js';

const MANAGE_GUILD = PermissionFlagsBits.ManageGuild;
const VIEW_CHANNEL = PermissionFlagsBits.ViewChannel;
const SEND_MESSAGES = PermissionFlagsBits.SendMessages;
const NO_MENTIONS = { parse: [] };

export const welcomeCommandData = {
  name: 'ต้อนรับ',
  description: 'ตั้งค่าข้อความต้อนรับสมาชิกใหม่',
  type: 1,
  default_member_permissions: MANAGE_GUILD.toString(),
  options: [
    {
      type: 1,
      name: 'ตั้งค่า',
      description: 'เลือกห้องและข้อความต้อนรับ',
      options: [
        {
          type: 7,
          name: 'ห้อง',
          description: 'ห้องข้อความสำหรับส่งข้อความต้อนรับ',
          required: true,
          channel_types: [ChannelType.GuildText],
        },
        {
          type: 3,
          name: 'ข้อความ',
          description: 'ใช้ {member} เพื่อกล่าวถึงสมาชิกใหม่',
          required: false,
          min_length: 1,
          max_length: 1000,
        },
      ],
    },
    { type: 1, name: 'ดู', description: 'ดูการตั้งค่าข้อความต้อนรับ' },
    { type: 1, name: 'ปิด', description: 'ปิดข้อความต้อนรับ' },
  ],
};

function safeLog(context, error) {
  console.error(context, error?.name ?? 'Error', error?.code ?? '');
}

function replyPayload(content) {
  return { content, allowedMentions: NO_MENTIONS };
}

async function editReply(interaction, content) {
  await interaction.editReply(replyPayload(content));
}

function hasPermission(channel, member, permission) {
  return channel.permissionsFor?.(member)?.has(permission) === true;
}

function isGuildTextChannel(channel, guildId) {
  return channel?.type === ChannelType.GuildText && channel.guildId === guildId;
}

function isUnknownChannel(error) {
  return String(error?.code ?? error?.rawError?.code) === '10003';
}

async function handleSetup(interaction, { settings, guildId }) {
  const selectedChannel = interaction.options.getChannel('ห้อง');
  if (!isGuildTextChannel(selectedChannel, guildId)) {
    await editReply(interaction, 'กรุณาเลือกห้องข้อความในเซิร์ฟเวอร์นี้');
    return;
  }

  let template;
  try {
    template = validateWelcomeTemplate(interaction.options.getString('ข้อความ') ?? DEFAULT_WELCOME_TEMPLATE);
  } catch {
    await editReply(interaction, 'ข้อความต้องมี 1–1,000 ตัวอักษร และหลังแทน {member} ต้องไม่เกิน 2,000 ตัวอักษร');
    return;
  }

  const channel = await interaction.guild.channels.fetch(selectedChannel.id, { force: true });
  if (!isGuildTextChannel(channel, guildId) || channel.id !== selectedChannel.id) {
    await editReply(interaction, 'ไม่พบห้องข้อความที่เลือก กรุณาเลือกห้องใหม่');
    return;
  }

  let requesterMember;
  let botMember;
  try {
    [requesterMember, botMember] = await Promise.all([
      interaction.guild.members.fetch({ user: interaction.user.id, force: true }),
      interaction.guild.members.fetchMe({ force: true }),
      interaction.guild.roles.fetch(),
    ]);
  } catch (error) {
    safeLog('ตรวจสิทธิ์ห้องต้อนรับไม่สำเร็จ', error);
    await editReply(interaction, 'ตรวจสอบสิทธิ์สมาชิกหรือบอตไม่สำเร็จ กรุณาลองอีกครั้ง');
    return;
  }

  const requesterCanView = hasPermission(channel, requesterMember, VIEW_CHANNEL);
  const botCanView = hasPermission(channel, botMember, VIEW_CHANNEL);
  const botCanSend = hasPermission(channel, botMember, SEND_MESSAGES);
  if (!requesterCanView || !botCanView || !botCanSend) {
    await editReply(interaction, 'คุณต้องดูห้องได้ และบอตต้องดูห้องและส่งข้อความในห้องนั้นได้');
    return;
  }

  try {
    await settings.set({ channelId: channel.id, template });
  } catch (error) {
    safeLog('บันทึกการตั้งค่าต้อนรับไม่สำเร็จ', error);
    await editReply(interaction, 'บันทึกการตั้งค่าไม่สำเร็จ กรุณาตรวจสอบไฟล์ data/welcome.json');
    return;
  }

  await interaction.editReply(replyPayload(`ตั้งค่าข้อความต้อนรับใน #${channel.name} แล้ว\nข้อความ: ${template}`));
}

async function handleView(interaction, { settings, guildId }) {
  let config;
  try {
    config = await settings.get();
  } catch (error) {
    safeLog('อ่านการตั้งค่าต้อนรับไม่สำเร็จ', error);
    await editReply(interaction, 'อ่านการตั้งค่าไม่สำเร็จ กรุณาตรวจสอบไฟล์ data/welcome.json');
    return;
  }

  if (!config.channelId || !config.template) {
    await editReply(interaction, 'ข้อความต้อนรับปิดอยู่');
    return;
  }

  let channel;
  try {
    channel = await interaction.guild.channels.fetch(config.channelId, { force: true });
  } catch (error) {
    if (isUnknownChannel(error)) {
      await editReply(interaction, 'ห้องที่ตั้งค่าไว้ไม่พร้อมใช้งาน กรุณาเลือกห้องใหม่หรือปิดการต้อนรับ');
      return;
    }
    safeLog('ตรวจสอบห้องต้อนรับไม่สำเร็จ', error);
    await editReply(interaction, 'ตรวจสอบห้องไม่สำเร็จ กรุณาลองอีกครั้ง');
    return;
  }

  if (!isGuildTextChannel(channel, guildId) || channel.id !== config.channelId) {
    await editReply(interaction, 'ห้องที่ตั้งค่าไว้ไม่พร้อมใช้งาน กรุณาเลือกห้องใหม่หรือปิดการต้อนรับ');
    return;
  }

  let requesterMember;
  try {
    [requesterMember] = await Promise.all([
      interaction.guild.members.fetch({ user: interaction.user.id, force: true }),
      interaction.guild.roles.fetch(),
    ]);
  } catch (error) {
    safeLog('ตรวจสิทธิ์ผู้ดูการตั้งค่าต้อนรับไม่สำเร็จ', error);
    await editReply(interaction, 'ตรวจสอบสิทธิ์สมาชิกไม่สำเร็จ กรุณาลองอีกครั้ง');
    return;
  }

  if (!hasPermission(channel, requesterMember, VIEW_CHANNEL)) {
    await editReply(interaction, 'คุณไม่มีสิทธิ์ดูห้องที่ตั้งค่าไว้');
    return;
  }

  await interaction.editReply(replyPayload(`ข้อความต้อนรับเปิดอยู่\nห้อง: #${channel.name}\nข้อความ: ${config.template}`));
}

export async function handleWelcome(interaction, { settings, guildId }) {
  if (!interaction.isChatInputCommand() || interaction.commandName !== welcomeCommandData.name) return;

  if (!interaction.guild || interaction.guild.id !== guildId) {
    await interaction.reply({
      ...replyPayload('คำสั่งนี้ใช้ได้เฉพาะในเซิร์ฟเวอร์ที่ตั้งค่าไว้'),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (!interaction.memberPermissions?.has(MANAGE_GUILD)) {
    await interaction.reply({
      ...replyPayload('คำสั่งนี้ต้องใช้สิทธิ์ Manage Server'),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  let subcommand;
  try {
    subcommand = interaction.options.getSubcommand();
  } catch (error) {
    safeLog('อ่านคำสั่งต้อนรับไม่สำเร็จ', error);
    await editReply(interaction, 'อ่านตัวเลือกคำสั่งไม่สำเร็จ กรุณาลองอีกครั้ง');
    return;
  }

  try {
    if (subcommand === 'ตั้งค่า') {
      await handleSetup(interaction, { settings, guildId });
    } else if (subcommand === 'ดู') {
      await handleView(interaction, { settings, guildId });
    } else if (subcommand === 'ปิด') {
      await settings.disable();
      await interaction.editReply(replyPayload('ปิดข้อความต้อนรับแล้ว'));
    } else {
      await editReply(interaction, 'ไม่รู้จักตัวเลือกคำสั่งต้อนรับ');
    }
  } catch (error) {
    safeLog('จัดการคำสั่งต้อนรับไม่สำเร็จ', error);
    await editReply(interaction, 'จัดการข้อความต้อนรับไม่สำเร็จ กรุณาตรวจสิทธิ์บอตและลองอีกครั้ง');
  }
}
