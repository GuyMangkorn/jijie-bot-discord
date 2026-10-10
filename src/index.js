import { Client, Events, GatewayIntentBits } from 'discord.js';
import { readConfig } from './config.js';
import { openDepartureLog } from './departures/departure-log.js';
import { activityFromMember, activityFromMessage, activityFromVoiceState } from './activity/activity-events.js';
import { openActivityLog } from './activity/activity-log.js';
import { openWelcomeSettings } from './welcome/welcome-settings.js';
import { registerMemberJoinHandler } from './welcome/member-join.js';
import { registerInteractionDispatcher } from './commands/interaction-dispatch.js';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createJijiRuntime } from './jiji/jiji-runtime.js';

export const botIntents = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.MessageContent,
];

export function registerMessageHandlers(client, { activityLog, guildId, jijiRuntime }) {
  client.on(Events.MessageCreate, (message) => {
    // Start both paths independently: slow or failed chat must not delay activity.
    const activity = Promise.resolve().then(() => {
      const event = activityFromMessage(message);
      if (event && event.guildId === guildId) return activityLog.record(event);
    }).catch((error) => {
      console.error('บันทึกประวัติกิจกรรมไม่สำเร็จ', error?.name ?? 'Error', error?.code ?? '');
    });
    const chat = Promise.resolve().then(() => jijiRuntime.handleMessage(message)).catch(() => {
      console.error('จัดการข้อความจีจี้ไม่สำเร็จ', 'chat_failed');
    });
    return Promise.all([activity, chat]);
  });
}

export async function startBot() {
  const { token, guildId, geminiApiKey, geminiModel } = readConfig();
  const departureLog = await openDepartureLog(
    fileURLToPath(new URL('../data/departures.json', import.meta.url)), guildId,
  );
  const activityLog = await openActivityLog(
    fileURLToPath(new URL('../data/activity', import.meta.url)), guildId,
  );
  const welcomeSettings = await openWelcomeSettings(
    fileURLToPath(new URL('../data/welcome.json', import.meta.url)), guildId,
  );
  const client = new Client({ intents: botIntents });
  const jijiRuntime = await createJijiRuntime({ client, guildId, geminiApiKey, geminiModel, departureLog });

  function recordActivity(event) {
    if (!event || event.guildId !== guildId) return;
    void activityLog.record(event).catch((error) => {
      console.error('บันทึกประวัติกิจกรรมไม่สำเร็จ', error?.name ?? 'Error', error?.code ?? '');
    });
  }

  client.once(Events.ClientReady, (readyClient) => {
    console.log(`บอตออนไลน์แล้ว: ${readyClient.user.tag}`);
  });

  registerInteractionDispatcher(client, {
    activityLog, departureLog, guildId, welcomeSettings, jijiRuntime,
  });

  registerMemberJoinHandler(client, { settings: welcomeSettings, activityLog, guildId });

  client.on(Events.GuildMemberRemove, (member) => {
    void departureLog.record(member).catch((error) => {
      console.error('บันทึกประวัติการออกไม่สำเร็จ', error?.name ?? 'Error', error?.code ?? '');
    });
    recordActivity(activityFromMember(member, 'leave'));
  });

  registerMessageHandlers(client, { activityLog, guildId, jijiRuntime });

  client.on(Events.VoiceStateUpdate, (before, after) => {
    recordActivity(activityFromVoiceState(after.member ?? before.member, before, after));
  });

  const activityRetentionTimer = setInterval(() => {
    void activityLog.prune().catch((error) => {
      console.error('ลบประวัติกิจกรรมเก่าไม่สำเร็จ', error?.name ?? 'Error', error?.code ?? '');
    });
  }, 60 * 60 * 1000);
  activityRetentionTimer.unref();

  function close() {
    clearInterval(activityRetentionTimer);
    jijiRuntime.close();
    client.destroy();
  }
  try {
    await client.login(token);
  } catch (error) {
    close();
    throw error;
  }
  return { client, close };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startBot().then(({ close }) => {
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, close);
  }).catch((error) => {
    console.error('เริ่มบอตไม่สำเร็จ', error?.name ?? 'Error', error?.code ?? '');
    process.exitCode = 1;
  });
}
