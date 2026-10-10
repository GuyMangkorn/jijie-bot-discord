import { REST, Routes } from 'discord.js';
import { commandData } from '../src/command.js';
import { departureCommandData } from '../src/departure-command.js';
import { activityCommandData } from '../src/activity-command.js';
import { welcomeCommandData } from '../src/welcome-command.js';
import { readConfig } from '../src/config.js';

async function registerCommand() {
  const { token, clientId, guildId } = readConfig();
  const rest = new REST({ version: '10' }).setToken(token);
  const collectionRoute = Routes.applicationGuildCommands(clientId, guildId);
  const currentCommands = await rest.get(collectionRoute);
  for (const data of [commandData, departureCommandData, activityCommandData, welcomeCommandData]) {
    const existingCommand = currentCommands.find((command) => command.name === data.name);

    if (existingCommand) {
      await rest.patch(
        Routes.applicationGuildCommand(clientId, guildId, existingCommand.id),
        { body: data },
      );
      console.log(`อัปเดตคำสั่ง /${data.name} แล้ว`);
    } else {
      await rest.post(collectionRoute, { body: data });
      console.log(`ลงทะเบียนคำสั่ง /${data.name} แล้ว`);
    }
  }
}

registerCommand().catch((error) => {
  console.error('ลงทะเบียนคำสั่งไม่สำเร็จ', error?.name ?? 'Error', error?.code ?? '');
  process.exitCode = 1;
});
