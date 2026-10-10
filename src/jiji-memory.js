import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const SNOWFLAKE = /^\d{17,20}$/;
const IDLE_MS = 1_800_000;
const MAX_SESSIONS = 1_000;
const MAX_TURNS = 10;
function validId(value) { return typeof value === 'string' && SNOWFLAKE.test(value); }
function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === keys;
}
function validTime(value) { return Number.isFinite(value) && Number.isInteger(value) && value >= 0; }
function validText(value) { return typeof value === 'string' && value.length > 0 && value.length <= 2_000; }
function validateScope(scope) {
  if (!exactKeys(scope, 'channelId,userId') || !validId(scope.channelId) || !validId(scope.userId)) {
    throw new Error('Invalid Jiji memory scope');
  }
  return { channelId: scope.channelId, userId: scope.userId };
}
function key(scope) { return `${scope.channelId}:${scope.userId}`; }
function validateData(data, guildId) {
  if (!exactKeys(data, 'guildId,sessions,version') || data.version !== 1 || !Array.isArray(data.sessions)
    || data.sessions.length > MAX_SESSIONS) throw new Error('Invalid Jiji memory');
  if (data.guildId !== guildId) throw new Error('Jiji memory belongs to a different guild');
  const keys = new Set();
  for (const session of data.sessions) {
    if (!exactKeys(session, 'channelId,turns,updatedAt,userId')
      || !validId(session.channelId) || !validId(session.userId) || !validTime(session.updatedAt)
      || !Array.isArray(session.turns) || session.turns.length < 1 || session.turns.length > MAX_TURNS) {
      throw new Error('Invalid Jiji memory session');
    }
    if (keys.has(key(session))) throw new Error('Duplicate Jiji memory session');
    keys.add(key(session));
    let previous = 0;
    for (const turn of session.turns) {
      if (!exactKeys(turn, 'assistant,at,user') || !validText(turn.user) || !validText(turn.assistant)
        || !validTime(turn.at) || turn.at < previous || turn.at > session.updatedAt) {
        throw new Error('Invalid Jiji memory turn');
      }
      previous = turn.at;
    }
    if (previous !== session.updatedAt) throw new Error('Invalid Jiji memory updatedAt');
  }
  return structuredClone(data.sessions);
}
function compareIds(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
function evictionOrder(a, b) {
  return a.updatedAt - b.updatedAt || compareIds(a.channelId, b.channelId) || compareIds(a.userId, b.userId);
}

export async function openJijiMemory(path, guildId, {
  now = Date.now,
  writeFile: write = writeFile,
  rename: move = rename,
} = {}) {
  if (!validId(guildId)) throw new Error('Invalid Jiji guild ID');
  let current = [];
  try {
    current = validateData(JSON.parse(await readFile(path, 'utf8')), guildId);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let pending = Promise.resolve();
  function enqueue(change) {
    const operation = pending.then(async () => {
      const at = now();
      if (!validTime(at)) throw new Error('Invalid Jiji memory clock');
      const next = structuredClone(current).filter(session => at - session.updatedAt < IDLE_MS);
      const result = change(next, at);
      if (next.length > MAX_SESSIONS) {
        next.sort(evictionOrder);
        next.splice(0, next.length - MAX_SESSIONS);
      }
      if (JSON.stringify(next) !== JSON.stringify(current)) {
        await mkdir(dirname(path), { recursive: true });
        await write(`${path}.tmp`, JSON.stringify({ version: 1, guildId, sessions: next }, null, 2), { mode: 0o600 });
        await move(`${path}.tmp`, path);
        current = next;
      }
      return result;
    });
    pending = operation.catch(() => {});
    return operation;
  }
  const memory = {
    get(scope) {
      let normalized;
      try { normalized = validateScope(scope); } catch (error) { return Promise.reject(error); }
      return enqueue(next => structuredClone(next.find(session => key(session) === key(normalized))?.turns ?? []));
    },
    append(scope, pair, { isCurrent = () => true } = {}) {
      let normalized;
      try {
        normalized = validateScope(scope);
        if (!exactKeys(pair, 'assistant,user') || !validText(pair.user) || !validText(pair.assistant)
          || typeof isCurrent !== 'function') throw new Error('Invalid Jiji memory pair');
      } catch (error) { return Promise.reject(error); }
      const completedPair = { user: pair.user, assistant: pair.assistant };
      return enqueue((next, at) => {
        // Check inside the queue, immediately before preparing the completed turn.
        if (isCurrent() !== true) return false;
        let session = next.find(item => key(item) === key(normalized));
        if (!session) {
          session = { ...normalized, updatedAt: at, turns: [] };
          next.push(session);
        }
        // Keep turn ordering valid even if the system clock moves backwards.
        session.updatedAt = Math.max(at, session.updatedAt);
        session.turns.push({ ...completedPair, at: session.updatedAt });
        session.turns = session.turns.slice(-MAX_TURNS);
        return true;
      });
    },
    clear(scope) {
      let normalized;
      try { normalized = validateScope(scope); } catch (error) { return Promise.reject(error); }
      return enqueue(next => {
        const index = next.findIndex(session => key(session) === key(normalized));
        if (index !== -1) next.splice(index, 1);
      });
    },
    clearChannel(channelId) {
      if (!validId(channelId)) return Promise.reject(new Error('Invalid Jiji channel ID'));
      return enqueue(next => {
        for (let index = next.length - 1; index >= 0; index--) {
          if (next[index].channelId === channelId) next.splice(index, 1);
        }
      });
    },
    clearAll() { return enqueue(next => { next.length = 0; }); },
    reconcile(settings) {
      if (!exactKeys(settings, 'channelIds,enabled') || typeof settings.enabled !== 'boolean'
        || !Array.isArray(settings.channelIds) || !settings.channelIds.every(validId)
        || new Set(settings.channelIds).size !== settings.channelIds.length) {
        return Promise.reject(new Error('Invalid Jiji reconciliation settings'));
      }
      const enabled = settings.enabled;
      const allowed = new Set(settings.channelIds);
      return enqueue(next => {
        for (let index = next.length - 1; index >= 0; index--) {
          if (!enabled || !allowed.has(next[index].channelId)) next.splice(index, 1);
        }
      });
    },
    prune() { return enqueue(() => {}); },
  };
  await memory.prune();
  return memory;
}
