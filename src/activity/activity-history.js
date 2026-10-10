import { AuditLogEvent, ChannelType, PermissionsBitField, escapeMarkdown } from 'discord.js';

export const MAX_MESSAGES_PER_CHANNEL = 1000;
export const MAX_MESSAGES_PER_QUERY = 10000;
export const MAX_AUDIT_ENTRIES = 1000;
export const MAX_QUERY_DURATION_MS = 60_000;
const PAGE_SIZE = 100;
export const ACTIVITY_QUERY_TIMEOUT = Symbol('timeout');
const REQUIRED_CHANNEL_PERMISSIONS = [
  PermissionsBitField.Flags.ViewChannel,
  PermissionsBitField.Flags.ReadMessageHistory,
];

export async function runWithinDeadline(operation, deadline) {
  if (!Number.isFinite(deadline)) return operation();
  const remaining = deadline - Date.now();
  if (remaining <= 0) return ACTIVITY_QUERY_TIMEOUT;
  let timer;
  try {
    return await Promise.race([
      operation(),
      new Promise((resolve) => { timer = setTimeout(() => resolve(ACTIVITY_QUERY_TIMEOUT), remaining); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function hasPermission(member, permission) {
  return Boolean(member?.permissions?.has?.(permission));
}

export function canReadChannel(channel, requesterMember, botMember) {
  if (!channel || !requesterMember || !botMember) return false;
  return [requesterMember, botMember].every((member) => {
    const permissions = channel.permissionsFor?.(member);
    return permissions?.has?.(REQUIRED_CHANNEL_PERMISSIONS) === true;
  });
}

export function canViewChannel(channel, requesterMember, botMember) {
  if (!channel || !requesterMember || !botMember) return false;
  return [requesterMember, botMember].every((member) =>
    channel.permissionsFor?.(member)?.has?.(PermissionsBitField.Flags.ViewChannel) === true);
}

function isPublicActiveThread(channel) {
  return channel?.type === ChannelType.PublicThread && channel.isPrivate?.() !== true;
}

function isHistoryChannel(channel) {
  return channel?.type === ChannelType.GuildText ||
    channel?.type === ChannelType.GuildAnnouncement;
}

function valuesOf(collection) {
  return collection ? [...collection.values()] : [];
}

function sortMessages(messages) {
  return [...messages].sort((a, b) => b.createdTimestamp - a.createdTimestamp || b.id.localeCompare(a.id));
}

export async function collectMessageHistory({
  guild,
  userId,
  since,
  until = Date.now(),
  requesterMember,
  botMember,
  deadline = Date.now() + MAX_QUERY_DURATION_MS,
  maxPerChannel = MAX_MESSAGES_PER_CHANNEL,
  maxTotal = MAX_MESSAGES_PER_QUERY,
  pageSize = PAGE_SIZE,
}) {
  const result = { records: [], complete: true, status: 'complete', scannedMessages: 0, searchedChannels: 0, skippedChannels: 0 };
  const reason = (value) => {
    result.complete = false;
    if (result.status === 'complete') result.status = 'partial';
    result.reason ??= value;
  };

  const channels = new Map();
  for (const base of valuesOf(guild.channels?.cache)) {
    if (isHistoryChannel(base)) channels.set(base.id, base);
  }

  if (typeof guild.channels?.fetchActiveThreads === 'function') {
    let activeThreads;
    try {
      activeThreads = await runWithinDeadline(() => guild.channels.fetchActiveThreads(false), deadline);
    } catch {
      reason('api_error');
    }
    if (activeThreads === ACTIVITY_QUERY_TIMEOUT) {
      reason('time_limit');
      result.status = 'timeout';
      return result;
    }
    for (const thread of valuesOf(activeThreads?.threads)) {
      if (isPublicActiveThread(thread)) channels.set(thread.id, thread);
    }
  }

  const orderedChannels = [...channels.values()].sort((a, b) => a.id.localeCompare(b.id));
  for (let channelIndex = 0; channelIndex < orderedChannels.length; channelIndex += 1) {
    const channel = orderedChannels[channelIndex];
    if (Date.now() >= deadline) {
      reason('time_limit');
      result.status = 'timeout';
      break;
    }
    if (!canReadChannel(channel, requesterMember, botMember)) {
      result.skippedChannels += 1;
      reason('permission');
      continue;
    }

    let scannedInChannel = 0;
    let before;
    let reachedStart = false;
    let hasMoreInChannel = false;
    let attempted = false;
    const seenCursors = new Set();
    while (!reachedStart) {
      const remainingTotal = maxTotal - result.scannedMessages;
      const remainingChannel = maxPerChannel - scannedInChannel;
      if (remainingTotal <= 0 || remainingChannel <= 0) {
        hasMoreInChannel = true;
        break;
      }
      const limit = Math.min(pageSize, remainingTotal, remainingChannel);
      let page;
      if (!attempted) {
        result.searchedChannels += 1;
        attempted = true;
      }
      try {
        page = await runWithinDeadline(
          () => channel.messages.fetch({ limit, ...(before ? { before } : {}), cache: false }),
          deadline,
        );
      } catch {
        result.skippedChannels += 1;
        reason('api_error');
        break;
      }
      if (page === ACTIVITY_QUERY_TIMEOUT) {
        reason('time_limit');
        result.status = 'timeout';
        break;
      }
      const messages = sortMessages(valuesOf(page));
      if (messages.length === 0) break;
      scannedInChannel += messages.length;
      result.scannedMessages += messages.length;

      for (const message of messages) {
        const at = message.createdTimestamp;
        if (at < since) {
          reachedStart = true;
          continue;
        }
        if (at > until || message.author?.id !== userId) continue;
        result.records.push({
          type: 'message',
          userId,
          at,
          channelId: message.channelId ?? message.channel?.id ?? channel.id,
          messageId: message.id,
          source: 'discord_history',
        });
      }

      const oldest = messages.at(-1);
      if (!oldest || seenCursors.has(oldest.id)) {
        reason('api_error');
        break;
      }
      seenCursors.add(oldest.id);
      before = oldest.id;
      if (reachedStart || messages.length < limit) break;
      if (scannedInChannel >= maxPerChannel || result.scannedMessages >= maxTotal) {
        hasMoreInChannel = oldest.createdTimestamp >= since;
        break;
      }
    }

    if (hasMoreInChannel) reason(result.scannedMessages >= maxTotal ? 'query_limit' : 'channel_limit');
    if (result.status === 'timeout') break;
    if (result.scannedMessages >= maxTotal && channelIndex < orderedChannels.length - 1) {
      reason('query_limit');
      break;
    }
  }

  result.records.sort((a, b) => b.at - a.at || b.messageId.localeCompare(a.messageId));
  return result;
}

const AUDIT_LABELS = new Map([
  [AuditLogEvent.GuildUpdate, 'แก้ไขการตั้งค่าเซิร์ฟเวอร์'],
  [AuditLogEvent.ChannelCreate, 'สร้างช่อง'],
  [AuditLogEvent.ChannelUpdate, 'แก้ไขช่อง'],
  [AuditLogEvent.ChannelDelete, 'ลบช่อง'],
  [AuditLogEvent.ChannelOverwriteCreate, 'เพิ่มสิทธิ์ช่อง'],
  [AuditLogEvent.ChannelOverwriteUpdate, 'แก้ไขสิทธิ์ช่อง'],
  [AuditLogEvent.ChannelOverwriteDelete, 'ลบสิทธิ์ช่อง'],
  [AuditLogEvent.MemberKick, 'เตะสมาชิก'],
  [AuditLogEvent.MemberPrune, 'นำสมาชิกออกจากเซิร์ฟเวอร์'],
  [AuditLogEvent.MemberBanAdd, 'แบนสมาชิก'],
  [AuditLogEvent.MemberBanRemove, 'ปลดแบนสมาชิก'],
  [AuditLogEvent.MemberUpdate, 'แก้ไขสมาชิก'],
  [AuditLogEvent.MemberRoleUpdate, 'เปลี่ยน role สมาชิก'],
  [AuditLogEvent.MemberMove, 'ย้ายสมาชิกในห้องเสียง'],
  [AuditLogEvent.MemberDisconnect, 'ตัดสมาชิกออกจากห้องเสียง'],
  [AuditLogEvent.BotAdd, 'เพิ่มบอต'],
  [AuditLogEvent.RoleCreate, 'สร้าง role'],
  [AuditLogEvent.RoleUpdate, 'แก้ไข role'],
  [AuditLogEvent.RoleDelete, 'ลบ role'],
  [AuditLogEvent.MessageDelete, 'ลบข้อความ'],
  [AuditLogEvent.MessageBulkDelete, 'ลบข้อความหลายรายการ'],
]);

function auditChannelId(entry) {
  if (entry.extra?.channel?.id) return entry.extra.channel.id;
  if (entry.extra?.channelId) return entry.extra.channelId;
  if ([13, 14, 15].includes(entry.action)) return undefined;
  if (entry.targetType === 'Channel' || [10, 11, 12].includes(entry.action)) {
    return entry.targetId ?? undefined;
  }
  return undefined;
}

export async function collectAuditHistory({
  guild,
  userId,
  since,
  until = Date.now(),
  requesterMember,
  botMember,
  deadline = Date.now() + MAX_QUERY_DURATION_MS,
  maxEntries = MAX_AUDIT_ENTRIES,
  pageSize = PAGE_SIZE,
}) {
  const result = { records: [], complete: true, status: 'complete', scannedEntries: 0, hiddenEntries: 0 };
  if (!hasPermission(requesterMember, PermissionsBitField.Flags.ViewAuditLog) ||
      !hasPermission(botMember, PermissionsBitField.Flags.ViewAuditLog)) {
    return { ...result, complete: false, status: 'no_permission' };
  }
  if (typeof guild.fetchAuditLogs !== 'function') {
    return { ...result, complete: false, status: 'error', reason: 'api_error' };
  }

  let before;
  let reachedStart = false;
  const seenCursors = new Set();
  while (!reachedStart && result.scannedEntries < maxEntries) {
    let logs;
    try {
      logs = await runWithinDeadline(
        () => guild.fetchAuditLogs({ limit: Math.min(pageSize, maxEntries - result.scannedEntries), ...(before ? { before } : {}) }),
        deadline,
      );
    } catch {
      return { ...result, complete: false, status: 'error', reason: 'api_error' };
    }
    if (logs === ACTIVITY_QUERY_TIMEOUT) return { ...result, complete: false, status: 'timeout', reason: 'time_limit' };
    const entries = valuesOf(logs.entries);
    if (entries.length === 0) break;
    result.scannedEntries += entries.length;
    const orderedEntries = [...entries].sort((a, b) => b.createdTimestamp - a.createdTimestamp || b.id.localeCompare(a.id));
    for (const entry of orderedEntries) {
      if (entry.createdTimestamp < since) {
        reachedStart = true;
        continue;
      }
      if (entry.createdTimestamp > until) continue;
      const actor = entry.executorId === userId;
      const target = entry.targetId === userId;
      if (!actor && !target) continue;
      const channelId = auditChannelId(entry);
      if (channelId) {
        const channel = guild.channels?.cache?.get(channelId);
        if (!canViewChannel(channel, requesterMember, botMember)) {
          result.hiddenEntries += 1;
          continue;
        }
      }
      result.records.push({
        type: 'audit',
        userId,
        at: entry.createdTimestamp,
        id: entry.id,
        action: entry.action,
        actionLabel: AUDIT_LABELS.get(entry.action) ?? 'การจัดการเซิร์ฟเวอร์',
        actorId: entry.executorId ?? undefined,
        targetId: entry.targetId ?? undefined,
        relation: actor && target ? 'actor_and_target' : actor ? 'actor' : 'target',
        ...(channelId ? { channelId } : {}),
      });
    }
    const oldest = orderedEntries.at(-1);
    if (!oldest || seenCursors.has(oldest.id)) {
      return { ...result, complete: false, status: 'error', reason: 'api_error' };
    }
    seenCursors.add(oldest.id);
    before = oldest.id;
    if (reachedStart || entries.length < Math.min(pageSize, maxEntries - (result.scannedEntries - entries.length))) break;
  }

  if (!reachedStart && result.scannedEntries >= maxEntries) {
    return { ...result, complete: false, status: 'partial', reason: 'audit_limit' };
  }
  result.records.sort((a, b) => b.at - a.at || b.id.localeCompare(a.id));
  return result;
}

export function combineActivityRecords(storedRecords, historicalRecords, userId, since, until, limit = 20) {
  const messages = new Map();
  const others = [];
  for (const record of storedRecords) {
    if (record.userId !== userId || record.at < since || record.at > until) continue;
    if (record.type === 'message') messages.set(record.messageId, { ...record, source: 'เก็บใหม่' });
    else others.push({ ...record, source: 'เก็บใหม่' });
  }
  for (const record of historicalRecords) {
    if (record.userId !== userId || record.at < since || record.at > until) continue;
    if (record.type === 'message') {
      if (!messages.has(record.messageId)) messages.set(record.messageId, { ...record, source: 'ย้อนหลัง' });
    } else {
      others.push({ ...record, source: 'Audit Log' });
    }
  }
  return [...messages.values(), ...others]
    .sort((a, b) => b.at - a.at || String(b.messageId ?? b.id ?? '').localeCompare(String(a.messageId ?? a.id ?? '')))
    .slice(0, limit);
}

function safeLabel(value) {
  return escapeMarkdown(String(value ?? '').replace(/[\r\n\t]/g, ' ').slice(0, 80))
    .replaceAll('@', '@\u200b').replaceAll('<', '‹').replaceAll('>', '›');
}

function recordLine(record, index, guildId) {
  const timestamp = `<t:${Math.floor(record.at / 1000)}:f>`;
  const channel = record.channelId ? ` • <#${record.channelId}>` : '';
  let description;
  switch (record.type) {
    case 'message': {
      const link = `https://discord.com/channels/${guildId}/${record.channelId}/${record.messageId}`;
      description = `ส่งข้อความ${channel} • [เปิดข้อความ](${link})`;
      break;
    }
    case 'voice_join': description = `เข้าห้องเสียง${channel}`; break;
    case 'voice_leave': description = `ออกจากห้องเสียง${channel}`; break;
    case 'voice_move': description = `ย้ายห้องเสียง <#${record.fromChannelId}> → <#${record.channelId}>`; break;
    case 'guild_join': description = 'เข้าร่วมเซิร์ฟเวอร์'; break;
    case 'guild_leave': description = 'ออกจากเซิร์ฟเวอร์ (ออกเอง/ถูกเตะ/ถูกแบนได้)'; break;
    case 'audit': {
      const relation = record.relation === 'actor' ? 'ผู้กระทำ' : record.relation === 'target' ? 'เป้าหมาย' : 'ผู้กระทำและเป้าหมาย';
      description = `Audit Log: ${safeLabel(record.actionLabel)} (${relation})${channel}`;
      if (record.actorId) description += ` • โดย <@${record.actorId}>`;
      if (record.targetId) description += ` • เกี่ยวกับ <@${record.targetId}>`;
      break;
    }
    default: description = 'กิจกรรม';
  }
  return `${index + 1}. ${timestamp} • ${description} • ${record.source}`;
}

function statusText(status, source) {
  if (status.status === 'complete') {
    if (source === 'stored') {
      return `อ่านข้อมูลที่บันทึกไว้ได้${status.hiddenRecords ? ` • ซ่อน ${status.hiddenRecords} รายการตามสิทธิ์ช่อง` : ''}`;
    }
    if (source === 'messages') return `ค้นครบตามสิทธิ์ช่อง • ตรวจ ${status.scannedMessages ?? 0} ข้อความ`;
    const hidden = status.hiddenEntries ? ` • ซ่อน ${status.hiddenEntries} รายการตามสิทธิ์ช่อง` : '';
    return `ตรวจ Audit Log ได้ • ตรวจ ${status.scannedEntries ?? 0} รายการ${hidden}`;
  }
  if (status.status === 'no_permission') return 'ไม่ได้ตรวจ • ต้องมีสิทธิ์ View Audit Log ทั้งผู้เรียกและบอต';
  if (status.status === 'timeout') return 'หยุดเมื่อครบ 60 วินาที • รายการที่แสดงอาจมีเพียงบางส่วน';
  if (status.status === 'error') {
    if (source === 'stored') return 'อ่านไฟล์ประวัติที่เก็บไว้ไม่สำเร็จ';
    if (status.reason === 'member_unavailable') return 'ตรวจสิทธิ์สมาชิกของผู้เรียกไม่สำเร็จ';
    if (source === 'messages') return 'ค้นข้อความไม่สำเร็จหรือได้ข้อมูลเพียงบางส่วน';
    return 'อ่าน Audit Log ไม่สำเร็จหรือได้ข้อมูลเพียงบางส่วน';
  }
  const reason = status.reason === 'permission'
    ? 'มีช่องที่ไม่มีสิทธิ์อ่าน'
    : status.reason === 'api_error'
      ? 'บางช่องค้นไม่สำเร็จ'
      : status.reason === 'audit_limit'
        ? 'ถึงขีดจำกัด Audit Log'
        : status.reason === 'channel_limit'
          ? 'ถึงขีดจำกัดต่อช่อง'
          : 'ถึงขีดจำกัดการค้น';
  const count = source === 'messages' ? ` • ตรวจ ${status.scannedMessages ?? 0} ข้อความ` : '';
  const hidden = status.hiddenRecords ? ` • ซ่อน ${status.hiddenRecords} รายการตามสิทธิ์ช่อง` : '';
  return `ค้นได้บางส่วน • ${reason}${count}${hidden}`;
}

export function buildActivityEmbed({
  guildId,
  userLabel,
  userId,
  since,
  until,
  trackingStartedAt,
  records,
  storedStatus,
  messageStatus,
  auditStatus,
}) {
  const description = records.length
    ? records.slice(0, 20).map((record, index) => recordLine(record, index, guildId)).join('\n')
    : 'ไม่พบข้อมูลที่ตรวจได้ในช่วงนี้ ผลนี้ไม่รับประกันว่าไม่มี activity';
  return {
    title: `กิจกรรมของ ${safeLabel(userLabel)} (ID: ${userId})`,
    description,
    fields: [
      { name: 'ช่วงวันที่', value: `<t:${Math.floor(since / 1000)}:d> ถึง <t:${Math.floor(until / 1000)}:d>`, inline: true },
      { name: 'เริ่มเก็บประวัติใหม่', value: `<t:${Math.floor(trackingStartedAt / 1000)}:d>`, inline: true },
      { name: 'ประวัติที่เก็บ', value: statusText(storedStatus, 'stored'), inline: false },
      { name: 'ข้อความย้อนหลัง', value: statusText(messageStatus, 'messages'), inline: false },
      { name: 'Audit Log', value: statusText(auditStatus, 'audit'), inline: false },
    ],
    footer: { text: 'แสดงสูงสุด 20 รายการ • ประวัติที่บันทึกเก็บ 30 วัน • ไม่เก็บเนื้อหาข้อความ' },
  };
}

export { AUDIT_LABELS };
