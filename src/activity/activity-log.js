import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const ACTIVITY_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const MANIFEST_FILE = 'manifest.json';
const EVENT_TYPES = new Set([
  'message', 'voice_join', 'voice_leave', 'voice_move', 'guild_join', 'guild_leave',
]);

const RECORD_FIELDS = {
  message: new Set(['type', 'userId', 'at', 'channelId', 'messageId']),
  voice_join: new Set(['type', 'userId', 'at', 'channelId']),
  voice_leave: new Set(['type', 'userId', 'at', 'channelId']),
  voice_move: new Set(['type', 'userId', 'at', 'channelId', 'fromChannelId']),
  guild_join: new Set(['type', 'userId', 'at']),
  guild_leave: new Set(['type', 'userId', 'at']),
};

function dayFor(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function validateRecord(record) {
  if (!record || typeof record !== 'object' || !EVENT_TYPES.has(record.type) ||
      typeof record.userId !== 'string' || !record.userId ||
      !Number.isSafeInteger(record.at) || record.at <= 0) return false;
  if (Object.keys(record).some((key) => !RECORD_FIELDS[record.type].has(key))) return false;
  if (record.type === 'message') {
    return typeof record.channelId === 'string' && typeof record.messageId === 'string';
  }
  if (record.type === 'voice_join' || record.type === 'voice_leave') {
    return typeof record.channelId === 'string';
  }
  if (record.type === 'voice_move') {
    return typeof record.channelId === 'string' && typeof record.fromChannelId === 'string';
  }
  return record.type === 'guild_join' || record.type === 'guild_leave';
}

function sanitizeEvent(event) {
  const record = {
    type: event.type,
    userId: event.userId,
    at: event.at,
  };
  for (const key of ['channelId', 'fromChannelId', 'messageId']) {
    if (event[key] !== undefined) record[key] = event[key];
  }
  if (!validateRecord(record)) throw new Error('Invalid activity record');
  return record;
}

async function atomicWrite(path, contents) {
  await writeFile(`${path}.tmp`, contents, { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}

function validateFile(data, guildId, filename) {
  const day = filename.slice(0, 10);
  const parsedDay = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(parsedDay.valueOf()) || parsedDay.toISOString().slice(0, 10) !== day ||
      data.version !== 1 || data.guildId !== guildId || !Array.isArray(data.records) ||
      data.records.some((record) => !validateRecord(record) || dayFor(record.at) !== day)) {
    throw new Error('Invalid activity log');
  }
}

export async function openActivityLog(directory, guildId, { now = Date.now() } = {}) {
  await mkdir(directory, { recursive: true });
  const filenames = await readdir(directory);
  const manifestPath = join(directory, MANIFEST_FILE);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (manifest.version !== 1 || manifest.guildId !== guildId ||
        !Number.isSafeInteger(manifest.trackingStartedAt) || manifest.trackingStartedAt <= 0) {
      throw new Error('Invalid activity manifest');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (filenames.some((filename) => /^\d{4}-\d{2}-\d{2}\.json$/.test(filename))) {
      throw new Error('Activity manifest is missing while activity data exists');
    }
    manifest = { version: 1, guildId, trackingStartedAt: now };
    await atomicWrite(manifestPath, JSON.stringify(manifest, null, 2));
  }

  const recordsByDay = new Map();
  for (const filename of filenames) {
    if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(filename)) continue;
    const data = JSON.parse(await readFile(join(directory, filename), 'utf8'));
    validateFile(data, guildId, filename);
    recordsByDay.set(filename.slice(0, 10), data.records);
  }

  let pending = Promise.resolve();
  let writeError;
  const dirtyDays = new Set();

  async function flushDirtyDays() {
    for (const day of [...dirtyDays].sort()) {
      const records = recordsByDay.get(day) ?? [];
      const path = join(directory, `${day}.json`);
      if (records.length === 0) {
        await rm(path, { force: true });
      } else {
        await atomicWrite(path, JSON.stringify({ version: 1, guildId, records }, null, 2));
      }
      dirtyDays.delete(day);
    }
    writeError = undefined;
  }

  async function enqueue(operation) {
    const task = pending.then(operation);
    pending = task.catch((error) => { writeError = error; });
    return task;
  }

  const log = {
    trackingStartedAt: manifest.trackingStartedAt,
    record(event) {
      if (event.guildId !== guildId || event.isBot) return Promise.resolve(false);
      const record = sanitizeEvent(event);
      const day = dayFor(record.at);
      return enqueue(async () => {
        const records = recordsByDay.get(day) ?? [];
        if (record.type === 'message' && records.some((existing) =>
          existing.type === 'message' && existing.messageId === record.messageId)) return false;
        recordsByDay.set(day, [...records, record]);
        dirtyDays.add(day);
        await flushDirtyDays();
        return true;
      });
    },
    async recordsFor(userId, since = 0, until = Number.MAX_SAFE_INTEGER) {
      await pending;
      if (writeError) throw writeError;
      return [...recordsByDay.values()].flat()
        .filter((record) => record.userId === userId && record.at >= since && record.at <= until)
        .sort((a, b) => b.at - a.at || b.userId.localeCompare(a.userId))
        .map((record) => ({ ...record }));
    },
    prune(pruneAt = Date.now()) {
      const cutoff = pruneAt - ACTIVITY_RETENTION_DAYS * DAY_MS;
      return enqueue(async () => {
        for (const [day, records] of recordsByDay) {
          const remaining = records.filter((record) => record.at >= cutoff);
          if (remaining.length !== records.length) {
            recordsByDay.set(day, remaining);
            dirtyDays.add(day);
          }
        }
        await flushDirtyDays();
      });
    },
  };

  await log.prune(now);
  return log;
}
