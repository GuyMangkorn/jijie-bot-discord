import { Events } from 'discord.js';
import { activityFromMember } from '../activity/activity-events.js';
import { sendWelcome } from './welcome-message.js';

function logFailure(context, error) {
  console.error(context, error?.name ?? 'Error', error?.code ?? '');
}

async function safelyRun(context, operation) {
  try {
    await operation();
  } catch (error) {
    logFailure(context, error);
  }
}

export async function handleMemberJoin(member, { activityLog, settings, guildId }) {
  const activity = activityFromMember(member, 'join');
  if (!activity || activity.guildId !== guildId) return;

  await Promise.all([
    safelyRun('บันทึกประวัติการเข้าร่วมไม่สำเร็จ', () => activityLog.record(activity)),
    safelyRun('ส่งข้อความต้อนรับไม่สำเร็จ', () => sendWelcome(member, { settings, guildId })),
  ]);
}

export function registerMemberJoinHandler(client, { settings, activityLog, guildId }) {
  client.on(Events.GuildMemberAdd, (member) => handleMemberJoin(member, { activityLog, settings, guildId })
    .catch((error) => logFailure('จัดการสมาชิกเข้าร่วมไม่สำเร็จ', error)));
}
