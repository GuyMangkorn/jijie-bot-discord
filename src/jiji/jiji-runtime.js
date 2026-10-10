import { fileURLToPath } from 'node:url';
import { openJijiSettings } from './jiji-settings.js';
import { openJijiMemory } from './jiji-memory.js';
import { createGeminiClient } from './gemini-client.js';
import { createJijiChat } from './jiji-chat.js';
import { handleJijiCommand } from './jiji-command.js';

export async function createJijiRuntime({
  client, guildId, geminiApiKey, geminiModel,
  departureLog,
  settingsPath = fileURLToPath(new URL('../../data/jiji-settings.json', import.meta.url)),
  memoryPath = fileURLToPath(new URL('../../data/jiji-memory.json', import.meta.url)),
  fetchImpl, now = Date.now,
}) {
  const settings = await openJijiSettings(settingsPath, guildId);
  const memory = await openJijiMemory(memoryPath, guildId, { now });
  await memory.reconcile(await settings.get());
  const gemini = createGeminiClient({ apiKey: geminiApiKey, model: geminiModel, fetchImpl });
  let chat, closed = false;
  // The authenticated bot ID becomes available only after client.login().
  function getChat() {
    if (!chat && client.user?.id) {
      chat = createJijiChat({ guildId, botId: client.user.id, settings, memory, gemini, departureLog, now });
    }
    return chat;
  }
  const pruneTimer = setInterval(() => {
    void memory.prune().catch(() => {
      console.error('ลบความจำจีจี้ที่หมดอายุไม่สำเร็จ', 'memory_prune_failed');
    });
  }, 60_000);
  pruneTimer.unref();

  return {
    async handleMessage(message) {
      if (!closed) await getChat()?.handleMessage(message);
    },
    async handleInteraction(interaction) {
      if (closed) return;
      await handleJijiCommand(interaction, {
        guildId, settings, memory, hasApiKey: Boolean(geminiApiKey),
        invalidate: scope => chat?.invalidate(scope),
      });
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(pruneTimer);
      chat?.invalidate();
    },
  };
}
