import { ChannelType, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { JijiChannelUnavailableError, refreshJijiAccess } from './jiji-access.js';

const SNOWFLAKE = /^\d{17,20}$/;
const roomOption = { type: 7, name: 'ห้อง', description: 'ห้องข้อความสำหรับคุยกับจีจี้', required: true, channel_types: [ChannelType.GuildText] };
export const jijiCommandData = {
  name: 'จีจี้', description: 'ตั้งค่าห้องสนทนาของจีจี้', type: 1,
  default_member_permissions: PermissionFlagsBits.ManageGuild.toString(),
  options: [
    { type: 1, name: 'เพิ่ม', description: 'เพิ่มห้องสนทนาโดยไม่เปลี่ยนสถานะเปิดปิด', options: [{ ...roomOption }] },
    { type: 1, name: 'ลบ', description: 'ลบห้องสนทนาและล้างความจำของห้อง', options: [
      { ...roomOption, required: false },
      { type: 3, name: 'รหัสห้อง', description: 'Channel ID 17–20 หลักสำหรับห้องที่เลือกไม่ได้', required: false, min_length: 17, max_length: 20 },
    ] },
    { type: 1, name: 'ดู', description: 'ดูสถานะและห้องสนทนาที่คุณเข้าถึงได้' },
    { type: 1, name: 'เปิด', description: 'เปิดการสนทนาของจีจี้' },
    { type: 1, name: 'ปิด', description: 'ปิดการสนทนาและล้างความจำทั้งหมด' },
  ],
};
export const forgetCommandData = { name: 'ลืม', description: 'ล้างความจำของคุณกับจีจี้ในห้องนี้', type: 1 };
const STORAGE_ERROR = 'บันทึกการตั้งค่าหรือความจำไม่สำเร็จ กรุณาให้ผู้ดูแลตรวจพื้นที่จัดเก็บของบอต';
const ACCESS_ERROR = 'ตรวจสอบสิทธิ์สมาชิก ห้อง หรือบอตไม่สำเร็จ กรุณาลองอีกครั้ง';
const reply = (interaction, content) => interaction.editReply({ content, allowedMentions: { parse: [] } });
const state = enabled => enabled ? 'เปิดอยู่' : 'ปิดอยู่';

async function checkManager(guild, userId) {
  const [requester, bot] = await Promise.all([
    guild.members.fetch({ user: userId, force: true }),
    guild.members.fetchMe({ force: true }),
    guild.roles.fetch(),
  ]);
  if (!requester || !bot) throw new Error('Jiji members unavailable');
  return requester.permissions?.has(PermissionFlagsBits.ManageGuild) === true;
}

export async function handleJijiCommand(interaction, { guildId, settings, memory, hasApiKey, invalidate }) {
  if (!interaction.isChatInputCommand() || ![jijiCommandData.name, forgetCommandData.name].includes(interaction.commandName)) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!interaction.guild || interaction.guild.id !== guildId) {
    await reply(interaction, 'คำสั่งนี้ใช้ได้เฉพาะในเซิร์ฟเวอร์ที่ตั้งค่าไว้');
    return;
  }
  const userId = interaction.user.id;
  if (interaction.commandName === forgetCommandData.name) {
    if (!interaction.channelId) {
      await reply(interaction, 'กรุณาใช้คำสั่งนี้ในห้องของเซิร์ฟเวอร์');
      return;
    }
    try {
      const scope = { channelId: interaction.channelId, userId };
      invalidate(scope);
      await memory.clear(scope);
    } catch {
      await reply(interaction, STORAGE_ERROR);
      return;
    }
    await reply(interaction, 'ล้างความจำของคุณกับจีจี้ในห้องนี้แล้ว (ไม่ลบข้อความ Discord หรือข้อมูลที่ส่งให้ Gemini แล้ว)');
    return;
  }
  try {
    if (!await checkManager(interaction.guild, userId)) {
      await reply(interaction, 'คำสั่งนี้ต้องใช้สิทธิ์ Manage Server');
      return;
    }
  } catch {
    await reply(interaction, ACCESS_ERROR);
    return;
  }

  let subcommand;
  try { subcommand = interaction.options.getSubcommand(); } catch {
    await reply(interaction, 'อ่านตัวเลือกคำสั่งไม่สำเร็จ กรุณาลองอีกครั้ง');
    return;
  }
  if (subcommand === 'เพิ่ม' || subcommand === 'ลบ') {
    const selected = interaction.options.getChannel('ห้อง');
    const rawId = subcommand === 'ลบ' ? interaction.options.getString('รหัสห้อง') : null;
    if (subcommand === 'ลบ' && ((selected !== null && selected !== undefined) === (rawId !== null && rawId !== undefined))) {
      await reply(interaction, 'กรุณาระบุห้องหรือรหัสห้องอย่างใดอย่างหนึ่งเท่านั้น');
      return;
    }
    if (rawId !== null && rawId !== undefined) {
      if (typeof rawId !== 'string' || !SNOWFLAKE.test(rawId)) {
        await reply(interaction, 'กรุณาระบุรหัสห้องเป็นตัวเลข 17–20 หลัก');
        return;
      }
    } else if (!selected || selected.guildId !== guildId || selected.type !== ChannelType.GuildText) {
      await reply(interaction, 'กรุณาเลือกห้องข้อความในเซิร์ฟเวอร์นี้');
      return;
    }
    const selectedId = rawId ?? selected.id;
    if (subcommand === 'เพิ่ม') {
      try {
        const access = await refreshJijiAccess(interaction.guild, selected.id, userId);
        if (!access.isManager) { await reply(interaction, 'คำสั่งนี้ต้องใช้สิทธิ์ Manage Server'); return; }
        if (!access.canView || !access.canSend) {
          await reply(interaction, 'คุณต้องดูห้องได้ และบอตต้องดูห้องและส่งข้อความในห้องนั้นได้');
          return;
        }
      } catch { await reply(interaction, ACCESS_ERROR); return; }
    }
    let config;
    try {
      if (subcommand === 'เพิ่ม') await settings.add(selected.id);
      else {
        invalidate({ channelId: selectedId });
        await settings.remove(selectedId);
        await memory.clearChannel(selectedId);
      }
      config = await settings.get();
    } catch { await reply(interaction, STORAGE_ERROR); return; }
    // Removal never exposes the selected room's name or requires channel access.
    await reply(interaction, subcommand === 'เพิ่ม'
      ? `เพิ่มห้องสนทนาแล้ว จีจี้${state(config.enabled)} มีห้องที่ตั้งค่าไว้ ${config.channelIds.length} ห้อง`
      : `ลบห้องสนทนาและล้างความจำของห้องแล้ว จีจี้${state(config.enabled)} มีห้องที่ตั้งค่าไว้ ${config.channelIds.length} ห้อง`);
    return;
  }
  if (subcommand === 'ปิด') {
    try {
      invalidate({});
      await settings.setEnabled(false);
      await memory.clearAll();
    } catch { await reply(interaction, STORAGE_ERROR); return; }
    await reply(interaction, 'ปิดจีจี้และล้างความจำทั้งหมดแล้ว คงรายชื่อห้องที่ตั้งค่าไว้');
    return;
  }
  if (subcommand !== 'ดู' && subcommand !== 'เปิด') {
    await reply(interaction, 'ไม่รู้จักตัวเลือกคำสั่งจีจี้');
    return;
  }
  let config;
  try { config = await settings.get(); } catch { await reply(interaction, STORAGE_ERROR); return; }
  if (subcommand === 'เปิด' && !hasApiKey) {
    await reply(interaction, 'ยังเปิดจีจี้ไม่ได้ กรุณาตั้งค่า GEMINI_API_KEY แล้วรีสตาร์ตบอต');
    return;
  }
  const visible = [];
  let hidden = 0, validRoom = false;
  for (const channelId of config.channelIds) {
    let access;
    try { access = await refreshJijiAccess(interaction.guild, channelId, userId); } catch (error) {
      if (error instanceof JijiChannelUnavailableError) { hidden++; continue; }
      await reply(interaction, ACCESS_ERROR); return;
    }
    if (!access.isManager) { await reply(interaction, 'คำสั่งนี้ต้องใช้สิทธิ์ Manage Server'); return; }
    if (access.canView) visible.push(`#${access.channel.name}`);
    else hidden++;
    if (access.canSend) validRoom = true;
  }
  if (subcommand === 'เปิด') {
    if (!validRoom) {
      await reply(interaction, 'ยังเปิดจีจี้ไม่ได้ ใช้ /จีจี้ เพิ่ม ห้อง:#ห้อง และตรวจว่าคุณดูห้องได้ รวมถึงบอตดูห้องและส่งข้อความได้');
      return;
    }
    try { await settings.setEnabled(true); } catch { await reply(interaction, STORAGE_ERROR); return; }
    await reply(interaction, 'เปิดจีจี้แล้วในห้องที่ตั้งค่าไว้และมีสิทธิ์พร้อม');
    return;
  }
  let content = `จีจี้${state(config.enabled)}\nห้องที่คุณและบอตดูได้: ${visible.length} ห้อง\nห้องที่ซ่อนหรือไม่พร้อมใช้งาน: ${hidden} ห้อง`;
  let shown = 0;
  for (const name of visible) {
    if (content.length + name.length + 1 > 1900) break;
    content += `\n${name}`; shown++;
  }
  if (shown < visible.length) content += `\nยังมีห้องที่ดูได้อีก ${visible.length - shown} ห้อง`;
  await reply(interaction, content);
}
