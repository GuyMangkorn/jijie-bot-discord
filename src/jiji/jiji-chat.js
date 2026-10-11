import { randomUUID } from 'node:crypto';
import { ChannelType } from 'discord.js';
import { refreshJijiAccess } from './jiji-access.js';
import { getJijiPrompt } from './jiji-trigger.js';
import { createJijiTools } from './jiji-tools.js';
import { JIJI_TIRED_MESSAGE } from './gemini-client.js';
import { createJijiDiagnostics, readJijiDiagnostic } from './jiji-diagnostics.js';

const GREETING = 'จีจี้อยู่นี่ 😊 มีอะไรให้ช่วยไหม?';
const BUSY = 'จีจี้กำลังคิดอยู่ 😊 รอแป๊บนะ';
const INPUT_ERROR = 'กรุณาส่งคำถามให้สั้นลง ไม่เกิน 2,000 ตัวอักษรนะ 😊';
const MEMORY_ERROR = 'อ่านหรือบันทึกความจำไม่สำเร็จ กรุณาให้ผู้ดูแลตรวจไฟล์ข้อมูลและพื้นที่จัดเก็บของบอต';
const MEMBER_ERROR = 'ดึงข้อมูลสมาชิกไม่สำเร็จ กรุณาตรวจสอบ Server Members Intent แล้วลองอีกครั้ง';
const DEPARTURE_ERROR = 'อ่านหรือบันทึกประวัติการออกไม่สำเร็จ กรุณาตรวจสอบไฟล์ข้อมูลและพื้นที่จัดเก็บของบอต';
const STAGES = new Set(['access', 'reference', 'memory_read', 'gemini', 'google_search', 'tool', 'discord_send', 'memory_write']);
const ownValue = (object, key) => {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch { return undefined; }
};
const localError = (category, stage, reason = category, status) => Object.assign(new Error(category), {
  category,
  ...(status === undefined ? {} : { status }),
  diagnostic: { stage, reason, ...(status === undefined ? {} : { status }) },
});
const categoryOf = error => readJijiDiagnostic(error).category;

// Discord/storage promises may not support cancellation. Race and discard their late results.
async function cancellable(run, signal, stage, reason) {
  if (signal.aborted) throw localError('cancelled', stage, reason());
  let onAbort;
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        if (signal.aborted) throw localError('cancelled', stage, reason());
        return run();
      }),
      new Promise((_, reject) => {
        onAbort = () => reject(localError('cancelled', stage, reason()));
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export function createJijiChat({
  guildId, botId, settings, memory, gemini, departureLog, now = Date.now,
  diagnostics = createJijiDiagnostics({ now }), traceId = randomUUID,
}) {
  const active = new Map();
  const starts = new Map();
  const pending = new Set();

  function invalidate({ channelId, userId } = {}, { reason = 'invalidated' } = {}) {
    for (const turn of pending) {
      if ((channelId === undefined || turn.scope.channelId === channelId)
        && (userId === undefined || turn.scope.userId === userId)) {
        turn.cancelReason ??= reason;
        turn.invalidated = true;
        turn.controller.abort();
      }
    }
  }

  async function handleMessage(message) {
    if (!message.guild || message.guild.id !== guildId || message.guildId !== guildId
      || message.channel?.type !== ChannelType.GuildText || !message.channelId
      || !message.author?.id || message.author.bot || message.webhookId) return;
    let prompt = getJijiPrompt(message, botId);
    const reference = message.reference;
    if (prompt === null && !reference?.messageId) return;

    const scope = { channelId: message.channelId, userId: message.author.id };
    const at = now();
    const deadlineAt = at + 30_000;
    const controller = new AbortController();
    const provider = new AbortController();
    let assignedTraceId;
    try { assignedTraceId = typeof traceId === 'function' ? traceId() : undefined; } catch { /* Use a local fallback. */ }
    const turn = {
      scope, traceId: typeof assignedTraceId === 'string' ? assignedTraceId : randomUUID(),
      startedAt: at, controller, invalidated: false, finished: false, cancelReason: undefined,
      stage: 'access', providerStarted: false, progress: { requestCount: 0, toolCount: 0 },
      terminalRecorded: false, secondaryRecorded: false,
    };
    pending.add(turn);
    const isCurrent = () => {
      if (turn.finished || turn.invalidated || controller.signal.aborted) return false;
      if (now() >= deadlineAt) {
        turn.cancelReason ??= 'turn_timeout';
        controller.abort();
        return false;
      }
      return !turn.cancelReason || turn.cancelReason === 'provider_timeout';
    };
    const assertCurrent = () => { if (!isCurrent()) throw localError('cancelled', turn.stage, turn.cancelReason ?? 'cancelled'); };
    const abortProvider = () => provider.abort();
    controller.signal.addEventListener('abort', abortProvider, { once: true });
    // Includes reference resolution and the first permission fetch. Reserve one second
    // for freshly authorized failure delivery; the overall deadline never moves.
    const deadline = setTimeout(() => {
      turn.cancelReason ??= 'turn_timeout';
      controller.abort();
    }, 30_000);
    const providerDeadline = setTimeout(() => {
      if (turn.providerStarted && !turn.cancelReason && !turn.finished) {
        turn.cancelReason = 'provider_timeout';
        provider.abort();
      }
    }, 29_000);
    const wasBusy = active.has(scope.userId) || at - (starts.get(scope.userId) ?? -Infinity) < 5_000;
    if (!wasBusy) active.set(scope.userId, turn);
    const run = operation => cancellable(() => { assertCurrent(); return operation(); }, controller.signal,
      turn.stage, () => turn.cancelReason ?? 'cancelled');
    const allowed = config => config.enabled === true && config.channelIds.includes(scope.channelId);

    function log(fields, terminal = false) {
      if (terminal && turn.terminalRecorded) return false;
      if (terminal) turn.terminalRecorded = true;
      const elapsed = (() => { try { return Math.max(0, Math.floor(now() - turn.startedAt)); } catch { return 0; } })();
      try {
        diagnostics.record({
          ...fields, traceId: turn.traceId, durationMs: elapsed,
          requestCount: turn.progress.requestCount, toolCount: turn.progress.toolCount,
        });
      } catch { /* A broken sink must never change a user's turn. */ }
      return true;
    }
    function failureDetails(error) {
      const safe = readJijiDiagnostic(error);
      return {
        category: safe.category,
        stage: safe.stage && safe.stage !== 'unknown' ? safe.stage : turn.stage,
        reason: safe.reason && safe.reason !== 'unknown' ? safe.reason : safe.category,
        status: safe.status,
      };
    }
    function recordFailure(error) {
      const detail = failureDetails(error);
      log({ event: 'jiji_turn_failed', ...detail }, true);
      return detail;
    }
    function recordCancellation(reason, event = 'jiji_turn_cancelled') {
      log({ event, category: 'cancelled', stage: turn.stage, reason }, true);
    }
    function recordSecondary(error, fallbackStage) {
      if (turn.secondaryRecorded) return;
      turn.secondaryRecorded = true;
      const detail = failureDetails(error);
      log({
        event: 'jiji_turn_failed', ...detail,
        stage: detail.stage === 'unknown' ? fallbackStage : detail.stage,
      });
    }
    function updateProgress(snapshot) {
      const safe = readJijiDiagnostic({ category: 'unknown', diagnostic: snapshot });
      const requestCount = ownValue(snapshot, 'requestCount');
      const toolCount = ownValue(snapshot, 'toolCount');
      if (safe.stage !== 'unknown' && STAGES.has(safe.stage)) turn.stage = safe.stage;
      if (Number.isInteger(requestCount) && requestCount >= 0 && requestCount <= 3) turn.progress.requestCount = requestCount;
      if (Number.isInteger(toolCount) && toolCount >= 0 && toolCount <= 4) turn.progress.toolCount = toolCount;
    }

    async function freshAccess() {
      turn.stage = 'access';
      assertCurrent();
      try {
        if (!allowed(await run(() => settings.get()))) throw localError('access_denied', 'access');
        assertCurrent();
        const access = await run(() => refreshJijiAccess(message.guild, scope.channelId, scope.userId));
        assertCurrent();
        // Settings may change while Discord fetches are in flight.
        if (!allowed(await run(() => settings.get())) || !access.canSend) throw localError('access_denied', 'access');
        assertCurrent();
        return access;
      } catch (error) {
        if (!isCurrent()) throw localError('cancelled', 'access', turn.cancelReason ?? 'cancelled');
        if (categoryOf(error) === 'access_denied') throw error;
        throw localError('access_unavailable', 'access', 'access_unavailable');
      }
    }
    async function reply(content) {
      await freshAccess();
      assertCurrent();
      turn.stage = 'discord_send';
      try {
        await run(() => message.reply({ content, allowedMentions: { parse: [], repliedUser: false } }));
        assertCurrent();
      } catch (error) {
        if (categoryOf(error) === 'cancelled' || !isCurrent()) throw error;
        throw localError('discord_send_failed', 'discord_send', 'discord_send_failed');
      }
    }
    let usedTools = false;
    try {
      let access = await freshAccess();
      if (prompt === null) {
        if ((reference.guildId && reference.guildId !== guildId)
          || (reference.channelId && reference.channelId !== scope.channelId)) return;
        let replyAuthorId = message.mentions?.repliedUser?.id ?? message.referencedMessage?.author?.id;
        if (!replyAuthorId && typeof message.fetchReference === 'function') {
          try {
            turn.stage = 'reference';
            replyAuthorId = (await run(() => message.fetchReference()))?.author?.id;
          } catch { if (!isCurrent()) return; }
        }
        assertCurrent();
        prompt = getJijiPrompt(message, botId, { replyAuthorId });
        if (prompt === null) return;
        access = await freshAccess();
      }
      if (wasBusy) { await reply(BUSY); return; }
      starts.set(scope.userId, at);
      if (prompt.length === 0) { await reply(GREETING); return; }
      if (prompt.length > 2_000) { await reply(INPUT_ERROR); return; }
      try { await run(() => access.channel.sendTyping()); }
      catch { assertCurrent(); }
      await freshAccess();
      let history;
      try {
        turn.stage = 'memory_read';
        history = await run(() => memory.get(scope));
      } catch (error) {
        assertCurrent();
        throw localError('memory_failed', 'memory_read');
      }
      await freshAccess();
      const permittedTools = createJijiTools({
        guild: message.guild, guildId, channelId: scope.channelId, userId: scope.userId, departureLog,
        checkAccess: async () => { await freshAccess(); return isCurrent(); },
      });
      const tools = {
        execute(call, { signal = provider.signal, searchGoogle } = {}) {
          usedTools = true;
          turn.stage = call?.name === 'search_google' ? 'google_search' : 'tool';
          return cancellable(() => { assertCurrent(); return permittedTools.execute(call, { signal, searchGoogle }); }, signal,
            turn.stage, () => turn.cancelReason ?? 'cancelled');
        },
      };
      turn.stage = 'gemini';
      const result = await cancellable(() => {
        assertCurrent();
        turn.providerStarted = true;
        return gemini.respond({ history, text: prompt, tools, signal: provider.signal, onProgress: updateProgress });
      }, provider.signal, turn.stage, () => turn.cancelReason ?? 'cancelled');
      turn.providerStarted = false;
      assertCurrent();
      if (typeof result?.text !== 'string' || !result.text.trim() || result.text.length > 2_000) {
        throw localError('invalid_answer', turn.stage);
      }
      await reply(result.text);
      if (!usedTools && result.usedTools !== true) {
        await freshAccess();
        try {
          turn.stage = 'memory_write';
          // The memory store checks this guard inside its serialized mutation queue.
          await run(() => memory.append(scope, { user: prompt, assistant: result.text }, { isCurrent }));
        } catch {
          assertCurrent();
          throw localError('memory_failed', 'memory_write');
        }
      }
    } catch (error) {
      const cause = turn.cancelReason;
      if (cause && cause !== 'provider_timeout') {
        if (cause === 'turn_timeout') recordCancellation(cause, 'jiji_turn_failed');
        else recordCancellation(cause);
        return;
      }
      if (categoryOf(error) === 'access_denied') return;
      const detail = recordFailure(cause === 'provider_timeout'
        ? localError('cancelled', turn.stage, cause)
        : error);
      if (detail.category === 'access_unavailable' || detail.category === 'discord_send_failed') return;
      const content = detail.category === 'member_fetch_failed' ? MEMBER_ERROR
        : detail.category === 'departure_read_failed' ? DEPARTURE_ERROR
          : detail.category === 'memory_failed' ? MEMORY_ERROR : JIJI_TIRED_MESSAGE;
      try { await reply(content); }
      catch (replyError) {
        const replyCategory = categoryOf(replyError);
        recordSecondary(replyError, replyCategory === 'access_denied' || replyCategory === 'access_unavailable' ? 'access' : 'discord_send');
      }
    } finally {
      turn.finished = true;
      clearTimeout(deadline);
      clearTimeout(providerDeadline);
      controller.signal.removeEventListener('abort', abortProvider);
      provider.abort();
      pending.delete(turn);
      if (active.get(scope.userId) === turn) active.delete(scope.userId);
    }
  }
  return { handleMessage, invalidate };
}
