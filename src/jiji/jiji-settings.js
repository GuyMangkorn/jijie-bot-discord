import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const SNOWFLAKE = /^\d{17,20}$/;
function validId(value) { return typeof value === 'string' && SNOWFLAKE.test(value); }
function validateSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'channelIds,enabled'
    || typeof value.enabled !== 'boolean' || !Array.isArray(value.channelIds)
    || !value.channelIds.every(validId) || new Set(value.channelIds).size !== value.channelIds.length) {
    throw new Error('Invalid Jiji settings');
  }
  return { enabled: value.enabled, channelIds: [...value.channelIds] };
}

export async function openJijiSettings(path, guildId, {
  writeFile: write = writeFile,
  rename: move = rename,
} = {}) {
  if (!validId(guildId)) throw new Error('Invalid Jiji guild ID');
  let current = { enabled: false, channelIds: [] };
  try {
    const data = JSON.parse(await readFile(path, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)
      || Object.keys(data).sort().join(',') !== 'channelIds,enabled,guildId,version'
      || data.version !== 1) throw new Error('Invalid Jiji settings');
    if (data.guildId !== guildId) throw new Error('Jiji settings belong to a different guild');
    current = validateSettings({ enabled: data.enabled, channelIds: data.channelIds });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  let pending = Promise.resolve();
  function mutate(change) {
    const operation = pending.then(async () => {
      const next = validateSettings(change({ enabled: current.enabled, channelIds: [...current.channelIds] }));
      if (JSON.stringify(next) === JSON.stringify(current)) return;
      await mkdir(dirname(path), { recursive: true });
      await write(`${path}.tmp`, JSON.stringify({ version: 1, guildId, ...next }, null, 2), { mode: 0o600 });
      await move(`${path}.tmp`, path);
      current = next;
    });
    pending = operation.catch(() => {});
    return operation;
  }
  return {
    async get() {
      await pending;
      return { enabled: current.enabled, channelIds: [...current.channelIds] };
    },
    add(channelId) {
      if (!validId(channelId)) return Promise.reject(new Error('Invalid Jiji channel ID'));
      return mutate(next => {
        if (!next.channelIds.includes(channelId)) next.channelIds.push(channelId);
        return next;
      });
    },
    remove(channelId) {
      if (!validId(channelId)) return Promise.reject(new Error('Invalid Jiji channel ID'));
      return mutate(next => ({ ...next, channelIds: next.channelIds.filter(id => id !== channelId) }));
    },
    setEnabled(enabled) {
      if (typeof enabled !== 'boolean') return Promise.reject(new Error('Invalid Jiji enabled state'));
      return mutate(next => ({ ...next, enabled }));
    },
  };
}
