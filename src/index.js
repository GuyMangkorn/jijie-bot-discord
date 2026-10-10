import { Client, Events, GatewayIntentBits } from 'discord.js';
import { handleLatestMembers } from './command.js';
import { readConfig } from './config.js';
import { openDepartureLog } from './departure-log.js';
import { handleDepartures } from './departure-command.js';
import { activityFromMember, activityFromMessage, activityFromVoiceState } from './activity-events.js';
import { openActivityLog } from './activity-log.js';
import { handleActivity } from './activity-command.js';
import { openWelcomeSettings } from './welcome-settings.js';
import { registerWelcomeHandlers } from './member-join.js';
import { fileURLToPath } from 'node:url';

async function startBot() {
  const { token, guildId } = readConfig();
  const departureLog = await openDepartureLog(
    fileURLToPath(new URL('../data/departures.json', import.meta.url)), guildId,
  );
  const activityLog = await openActivityLog(
    fileURLToPath(new URL('../data/activity', import.meta.url)), guildId,
  );
  const welcomeSettings = await openWelcomeSettings(
    fileURLToPath(new URL('../data/welcome.json', import.meta.url)), guildId,
  );
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildVoiceStates,
    ],
  });

  function recordActivity(event) {
    if (!event || event.guildId !== guildId) return;
    void activityLog.record(event).catch((error) => {
      console.error('บันทึกประวัติกิจกรรมไม่สำเร็จ', error?.name ?? 'Error', error?.code ?? '');
    });
  }

  client.once(Events.ClientReady, (readyClient) => {
    console.log(`บอตออนไลน์แล้ว: ${readyClient.user.tag}`);
  });

  client.on(Events.InteractionCreate, (interaction) => {
    void Promise.all([
      handleLatestMembers(interaction),
      handleDepartures(interaction, departureLog, guildId),
      handleActivity(interaction, { activityLog, guildId }),
    ]).catch((error) => {
      console.error('จัดการคำสั่งไม่สำเร็จ', error?.name ?? 'Error', error?.code ?? '');
    });
  });

  registerWelcomeHandlers(client, { settings: welcomeSettings, activityLog, guildId });

  client.on(Events.GuildMemberRemove, (member) => {
    void departureLog.record(member).catch((error) => {
      console.error('บันทึกประวัติการออกไม่สำเร็จ', error?.name ?? 'Error', error?.code ?? '');
    });
    recordActivity(activityFromMember(member, 'leave'));
  });

  client.on(Events.MessageCreate, (message) => {
    recordActivity(activityFromMessage(message));
  });

  client.on(Events.VoiceStateUpdate, (before, after) => {
    recordActivity(activityFromVoiceState(after.member ?? before.member, before, after));
  });

  const activityRetentionTimer = setInterval(() => {
    void activityLog.prune().catch((error) => {
      console.error('ลบประวัติกิจกรรมเก่าไม่สำเร็จ', error?.name ?? 'Error', error?.code ?? '');
    });
  }, 60 * 60 * 1000);
  activityRetentionTimer.unref();

  await client.login(token);
}

startBot().catch((error) => {
  console.error('เริ่มบอตไม่สำเร็จ', error?.name ?? 'Error', error?.code ?? '');
  process.exitCode = 1;
});
