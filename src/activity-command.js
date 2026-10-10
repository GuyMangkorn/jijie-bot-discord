import { EmbedBuilder, MessageFlags } from 'discord.js';
import { ACTIVITY_QUERY_TIMEOUT, MAX_QUERY_DURATION_MS, buildActivityEmbed, canReadChannel, canViewChannel, collectAuditHistory, collectMessageHistory, combineActivityRecords, runWithinDeadline } from './activity-history.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export const activityCommandData = {
  name: 'กิจกรรม',
  description: 'ดูประวัติกิจกรรมของสมาชิกในช่วงวันที่เลือก',
  type: 1,
  options: [
    { type: 6, name: 'สมาชิก', description: 'สมาชิกที่ต้องการตรวจประวัติ', required: true },
    { type: 4, name: 'ช่วงวัน', description: 'จำนวนวันที่ต้องการตรวจย้อนหลัง (1–30)', required: false, min_value: 1, max_value: 30 },
  ],
};

export function createActivityQueryLimiter(maxConcurrent = 2) {
  const activeUsers = new Set();
  let activeQueries = 0;
  return {
    async run(userId, operation) {
      if (activeUsers.has(userId) || activeQueries >= maxConcurrent) return { accepted: false };
      activeUsers.add(userId);
      activeQueries += 1;
      try {
        return { accepted: true, value: await operation() };
      } finally {
        activeUsers.delete(userId);
        activeQueries -= 1;
      }
    },
  };
}

const queryLimiter = createActivityQueryLimiter(2);

function readableRecords(records, guild, requesterMember, botMember) {
  const visible = [];
  const hidden = { stored: 0, messages: 0, audit: 0 };
  for (const record of records) {
    if (!record.channelId) {
      visible.push(record);
      continue;
    }
    const channel = guild.channels.cache.get(record.channelId);
    const readable = record.type === 'message'
      ? canReadChannel(channel, requesterMember, botMember)
      : canViewChannel(channel, requesterMember, botMember);
    if (readable) visible.push(record);
    else if (record.type === 'audit') hidden.audit += 1;
    else if (record.source === 'เก็บใหม่') hidden.stored += 1;
    else hidden.messages += 1;
  }
  return { records: visible, hidden };
}

async function getQueryMembers(guild, requesterId, deadline) {
  let requesterMember = guild.members.cache.get(requesterId);
  if (!requesterMember) {
    requesterMember = await runWithinDeadline(() => guild.members.fetch(requesterId), deadline);
    if (requesterMember === ACTIVITY_QUERY_TIMEOUT) throw new Error('Query timed out');
  }
  let botMember = guild.members.me;
  if (!botMember && typeof guild.members.fetchMe === 'function') {
    botMember = await runWithinDeadline(() => guild.members.fetchMe(), deadline);
    if (botMember === ACTIVITY_QUERY_TIMEOUT) throw new Error('Query timed out');
  }
  return { requesterMember, botMember };
}

export async function collectActivity({
  interaction,
  target,
  days,
  activityLog,
  now = Date.now(),
  deadline = Date.now() + MAX_QUERY_DURATION_MS,
}) {
  const guild = interaction.guild;
  const since = now - days * DAY_MS;
  let storedStatus = { status: 'complete' };
  let storedRecords = [];
  try {
    const result = await runWithinDeadline(() => activityLog.recordsFor(target.id, since, now), deadline);
    if (result === ACTIVITY_QUERY_TIMEOUT) storedStatus = { status: 'timeout' };
    else storedRecords = result;
  } catch (error) {
    console.error('อ่านประวัติกิจกรรมที่เก็บไว้ไม่สำเร็จ', error?.name ?? 'Error', error?.code ?? '');
    storedStatus = { status: 'error' };
  }

  let requesterMember;
  let botMember;
  let memberStatus = 'complete';
  let memberStatusReason;
  try {
    ({ requesterMember, botMember } = await getQueryMembers(guild, interaction.user.id, deadline));
    if (!requesterMember || !botMember) throw new Error('Guild members unavailable');
  } catch (error) {
    console.error('ตรวจสิทธิ์สมาชิกสำหรับประวัติกิจกรรมไม่สำเร็จ', error?.name ?? 'Error', error?.code ?? '');
    memberStatus = error?.message === 'Query timed out' ? 'timeout' : 'error';
    memberStatusReason = memberStatus === 'timeout' ? 'time_limit' : 'member_unavailable';
  }

  let messageResult = { records: [], status: memberStatus === 'timeout' ? 'timeout' : 'error', complete: false, reason: 'member_unavailable', scannedMessages: 0 };
  let auditResult = { records: [], status: memberStatus === 'timeout' ? 'timeout' : 'error', complete: false, reason: 'member_unavailable', scannedEntries: 0 };
  if (memberStatus === 'complete') {
    try {
      messageResult = await collectMessageHistory({
        guild, userId: target.id, since, until: now, requesterMember, botMember, deadline,
      });
    } catch (error) {
      console.error('ค้นประวัติข้อความย้อนหลังไม่สำเร็จ', error?.name ?? 'Error', error?.code ?? '');
      messageResult = { records: [], status: 'error', complete: false, reason: 'api_error', scannedMessages: 0 };
    }
    if (messageResult.status === 'timeout' || Date.now() >= deadline) {
      auditResult = { records: [], status: 'timeout', complete: false, reason: 'time_limit', scannedEntries: 0 };
    } else {
      try {
        auditResult = await collectAuditHistory({
          guild, userId: target.id, since, until: now, requesterMember, botMember, deadline,
        });
      } catch (error) {
        console.error('ค้น Audit Log ไม่สำเร็จ', error?.name ?? 'Error', error?.code ?? '');
        auditResult = { records: [], status: 'error', complete: false, reason: 'api_error', scannedEntries: 0 };
      }
    }
  }

  const historicalRecords = [...messageResult.records, ...auditResult.records];
  const combinedRecords = combineActivityRecords(storedRecords, historicalRecords, target.id, since, now, 20);
  const accessible = readableRecords(combinedRecords, guild, requesterMember, botMember);
  if (accessible.hidden.stored > 0) storedStatus = { ...storedStatus, hiddenRecords: accessible.hidden.stored };
  if (accessible.hidden.messages > 0) {
    messageResult = {
      ...messageResult,
      status: messageResult.status === 'complete' ? 'partial' : messageResult.status,
      complete: false,
      reason: messageResult.reason ?? 'permission',
      hiddenRecords: accessible.hidden.messages,
    };
  }
  if (accessible.hidden.audit > 0) {
    auditResult = { ...auditResult, hiddenEntries: (auditResult.hiddenEntries ?? 0) + accessible.hidden.audit };
  }
  return {
    guildId: guild.id,
    userLabel: target.globalName ?? target.username ?? target.id,
    userId: target.id,
    since,
    until: now,
    trackingStartedAt: activityLog.trackingStartedAt ?? now,
    records: accessible.records,
    storedStatus,
    messageStatus: memberStatus === 'complete' ? messageResult : { status: memberStatus, reason: memberStatusReason },
    auditStatus: memberStatus === 'complete' ? auditResult : { status: memberStatus, reason: memberStatusReason },
  };
}

export async function handleActivity(interaction, {
  activityLog,
  guildId,
  runSearch = collectActivity,
} = {}) {
  if (!interaction.isChatInputCommand() || interaction.commandName !== activityCommandData.name) return;
  if (!interaction.guild || interaction.guild.id !== guildId) {
    await interaction.reply({
      content: 'คำสั่งนี้ใช้ได้เฉพาะในเซิร์ฟเวอร์ที่ตั้งค่าไว้',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const target = interaction.options.getUser('สมาชิก');
  const days = interaction.options.getInteger('ช่วงวัน') ?? 7;
  if (!target || !Number.isInteger(days) || days < 1 || days > 30) {
    await interaction.editReply({ content: 'กรุณาเลือกสมาชิกและช่วงวันระหว่าง 1 ถึง 30 วัน', allowedMentions: { parse: [] } });
    return;
  }

  let query;
  try {
    query = await queryLimiter.run(interaction.user.id, () => runSearch({
      interaction, target, days, activityLog,
    }));
  } catch (error) {
    console.error('ตรวจประวัติกิจกรรมไม่สำเร็จ', error?.name ?? 'Error', error?.code ?? '');
    await interaction.editReply({
      content: 'ตรวจประวัติกิจกรรมไม่สำเร็จ กรุณาตรวจสิทธิ์บอตและไฟล์ข้อมูลก่อนลองอีกครั้ง',
      allowedMentions: { parse: [] },
    });
    return;
  }
  if (!query.accepted) {
    await interaction.editReply({
      content: 'มีคำสั่งตรวจประวัติกำลังทำงานอยู่ หรือบอตกำลังตรวจให้สมาชิกอื่น กรุณาลองอีกครั้งภายหลัง',
      allowedMentions: { parse: [] },
    });
    return;
  }

  try {
    const embed = new EmbedBuilder(buildActivityEmbed(query.value)).setColor(0x5865f2);
    await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch (error) {
    console.error('จัดรูปแบบประวัติกิจกรรมไม่สำเร็จ', error?.name ?? 'Error', error?.code ?? '');
    await interaction.editReply({
      content: 'แสดงประวัติกิจกรรมไม่สำเร็จ กรุณาลองใหม่อีกครั้ง',
      allowedMentions: { parse: [] },
    });
  }
}
