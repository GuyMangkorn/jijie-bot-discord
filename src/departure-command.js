import { EmbedBuilder, MessageFlags } from 'discord.js';
import { buildDeparturesEmbed } from './departure-log.js';

export const departureCommandData = {
  name: 'ออกล่าสุด',
  description: 'ดูประวัติสมาชิกที่ออกล่าสุดที่บอตบันทึกได้ สูงสุด 10 รายการ',
  type: 1,
};

export async function handleDepartures(interaction, log, guildId) {
  if (!interaction.isChatInputCommand() || interaction.commandName !== departureCommandData.name) return;
  if (!interaction.guild || interaction.guild.id !== guildId) {
    await interaction.reply({ content: 'คำสั่งนี้ใช้ได้เฉพาะในเซิร์ฟเวอร์ที่ตั้งค่าไว้', flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply();
  try {
    const records = await log.latest();
    await interaction.editReply({
      embeds: [new EmbedBuilder(buildDeparturesEmbed(records)).setColor(0x5865f2)],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    console.error('อ่านประวัติการออกไม่สำเร็จ', error?.name ?? 'Error', error?.code ?? '');
    await interaction.editReply({
      content: 'อ่านหรือบันทึกประวัติการออกไม่สำเร็จ กรุณาตรวจสอบไฟล์ข้อมูลและพื้นที่จัดเก็บของบอต',
      allowedMentions: { parse: [] },
    });
  }
}
