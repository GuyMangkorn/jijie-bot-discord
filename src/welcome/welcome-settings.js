import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { validateWelcomeTemplate } from './welcome-message.js';

const VERSION = 1;
const DISABLED = Object.freeze({ channelId: null, template: null });
const SNOWFLAKE = /^\d{17,20}$/;

function validateStoredData(data, guildId) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid welcome settings');
  const keys = Object.keys(data).sort();
  if (data.guildId !== guildId) throw new Error('Welcome settings belong to a different guild');
  if (keys.join(',') !== 'channelId,guildId,template,version' || data.version !== VERSION) {
    throw new Error('Invalid welcome settings');
  }

  if (data.channelId === null && data.template === null) return { ...DISABLED };
  if (typeof data.channelId !== 'string' || !SNOWFLAKE.test(data.channelId) || typeof data.template !== 'string') {
    throw new Error('Invalid welcome settings');
  }

  const template = validateWelcomeTemplate(data.template);
  if (template !== data.template) throw new Error('Invalid welcome settings');
  return { channelId: data.channelId, template };
}

export async function openWelcomeSettings(path, guildId, {
  writeFile: write = writeFile,
  rename: move = rename,
} = {}) {
  let current = { ...DISABLED };
  try {
    const data = JSON.parse(await readFile(path, 'utf8'));
    current = validateStoredData(data, guildId);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  let pending = Promise.resolve();

  function save(next) {
    const operation = pending.then(async () => {
      const data = JSON.stringify({ version: VERSION, guildId, ...next }, null, 2);
      await mkdir(dirname(path), { recursive: true });
      await write(`${path}.tmp`, data, { mode: 0o600 });
      await move(`${path}.tmp`, path);
      current = { ...next };
    });
    pending = operation.catch(() => {});
    return operation;
  }

  return {
    async get() {
      await pending;
      return { ...current };
    },
    set({ channelId, template }) {
      if (typeof channelId !== 'string' || !SNOWFLAKE.test(channelId)) {
        return Promise.reject(new Error('Invalid welcome channel ID'));
      }
      let normalized;
      try {
        normalized = validateWelcomeTemplate(template);
      } catch (error) {
        return Promise.reject(error);
      }
      return save({ channelId, template: normalized });
    },
    disable() {
      return save({ ...DISABLED });
    },
  };
}
