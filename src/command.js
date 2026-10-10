import { EmbedBuilder, MessageFlags } from 'discord.js';
import { buildMembersEmbed } from './latest-members.js';
import { fetchLatestMembers } from './member-service.js';

export const commandData = {
  name: 'ล่าสุด',
  description: 'ดูสมาชิกที่เข้าร่วมเซิร์ฟเวอร์ล่าสุด 10 คน',
  type: 1,
};

export async function handleLatestMembers(interaction) {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== commandData.name) return;

  if (!interaction.guild) {
    await interaction.reply({
      content: 'คำสั่งนี้ใช้ได้เฉพาะในเซิร์ฟเวอร์',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();

  let members;
  try {
    members = await fetchLatestMembers(interaction.guild);
  } catch (error) {
    console.error('ดึงข้อมูลสมาชิกไม่สำเร็จ', error?.name ?? 'Error', error?.code ?? '');
    await interaction.editReply({
      content: 'ดึงข้อมูลสมาชิกไม่สำเร็จ กรุณาตรวจสอบ Server Members Intent แล้วลองอีกครั้ง',
      allowedMentions: { parse: [] },
    });
    return;
  }

  const selectedMembers = members.map((member) => ({ id: member.userId, joinedTimestamp: member.joinedAt }));
  const embedContent = buildMembersEmbed(selectedMembers);
  const embed = new EmbedBuilder()
    .setTitle(embedContent.title)
    .setDescription(embedContent.description)
    .setColor(0x5865f2);

  await interaction.editReply({
    embeds: [embed],
    allowedMentions: { parse: [] },
  });
}
