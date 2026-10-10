import { Events } from 'discord.js';
import { commandData as latestMembersCommandData, handleLatestMembers } from '../members/latest-members-command.js';
import { departureCommandData, handleDepartures } from '../departures/departure-command.js';
import { activityCommandData, handleActivity } from '../activity/activity-command.js';
import { welcomeCommandData, handleWelcome } from '../welcome/welcome-command.js';
import { forgetCommandData, jijiCommandData } from '../jiji/jiji-command.js';

function logFailure(context, error) {
  console.error(context, error?.name ?? 'Error', error?.code ?? '');
}

export function registerInteractionDispatcher(client, {
  activityLog, departureLog, guildId, welcomeSettings, jijiRuntime,
}) {
  const routes = new Map([
    [latestMembersCommandData.name, {
      handle: interaction => handleLatestMembers(interaction),
      errorContext: 'จัดการคำสั่งไม่สำเร็จ',
    }],
    [departureCommandData.name, {
      handle: interaction => handleDepartures(interaction, departureLog, guildId),
      errorContext: 'จัดการคำสั่งไม่สำเร็จ',
    }],
    [activityCommandData.name, {
      handle: interaction => handleActivity(interaction, { activityLog, guildId }),
      errorContext: 'จัดการคำสั่งไม่สำเร็จ',
    }],
    [welcomeCommandData.name, {
      handle: interaction => handleWelcome(interaction, { settings: welcomeSettings, guildId }),
      errorContext: 'จัดการคำสั่งต้อนรับไม่สำเร็จ',
    }],
    [jijiCommandData.name, {
      handle: interaction => jijiRuntime.handleInteraction(interaction),
      errorContext: 'จัดการคำสั่งไม่สำเร็จ',
    }],
    [forgetCommandData.name, {
      handle: interaction => jijiRuntime.handleInteraction(interaction),
      errorContext: 'จัดการคำสั่งไม่สำเร็จ',
    }],
  ]);

  client.on(Events.InteractionCreate, interaction => {
    const route = routes.get(interaction?.commandName);
    if (!route) return;

    return Promise.resolve()
      .then(() => route.handle(interaction))
      .catch(error => logFailure(route.errorContext, error));
  });
}
