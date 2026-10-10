import { ChannelType } from 'discord.js';
import { refreshJijiAccess } from './jiji-access.js';
import { getJijiPrompt } from './jiji-trigger.js';
import { createJijiTools } from './jiji-tools.js';
import { JIJI_TIRED_MESSAGE } from './gemini-client.js';

const GREETING = 'จีจี้อยู่นี่ 😊 มีอะไรให้ช่วยไหม?';
const BUSY = 'จีจี้กำลังคิดอยู่ 😊 รอแป๊บนะ';
const INPUT_ERROR = 'กรุณาส่งคำถามให้สั้นลง ไม่เกิน 2,000 ตัวอักษรนะ 😊';
const MEMORY_ERROR = 'อ่านหรือบันทึกความจำไม่สำเร็จ กรุณาให้ผู้ดูแลตรวจไฟล์ข้อมูลและพื้นที่จัดเก็บของบอต';
const MEMBER_ERROR = 'ดึงข้อมูลสมาชิกไม่สำเร็จ กรุณาตรวจสอบ Server Members Intent แล้วลองอีกครั้ง';
const DEPARTURE_ERROR = 'อ่านหรือบันทึกประวัติการออกไม่สำเร็จ กรุณาตรวจสอบไฟล์ข้อมูลและพื้นที่จัดเก็บของบอต';
const localError = category => Object.assign(new Error(category), { category });

// Discord/storage promises may not support cancellation. Race and discard their late results.
async function cancellable(run, signal) {
  if (signal.aborted) throw localError('cancelled');
  let onAbort;
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        if (signal.aborted) throw localError('cancelled');
        return run();
      }),
      new Promise((_, reject) => {
        onAbort = () => reject(localError('cancelled'));
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export function createJijiChat({ guildId, botId, settings, memory, gemini, departureLog, now = Date.now }) {
  const active = new Map();
  const starts = new Map();
  const pending = new Set();

  function invalidate({ channelId, userId } = {}) {
    for (const turn of pending) {
      if ((channelId === undefined || turn.scope.channelId === channelId)
        && (userId === undefined || turn.scope.userId === userId)) {
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
    const turn = { scope, controller, invalidated: false, finished: false };
    pending.add(turn);
    const isCurrent = () => !turn.invalidated && !turn.finished && !controller.signal.aborted
      && now() < deadlineAt;
    const assertCurrent = () => { if (!isCurrent()) throw localError('cancelled'); };
    const abortProvider = () => provider.abort();
    controller.signal.addEventListener('abort', abortProvider, { once: true });
    // Includes reference resolution and the first permission fetch. Reserve one second
    // for freshly authorized failure delivery; the overall deadline never moves.
    const deadline = setTimeout(() => controller.abort(), 30_000);
    const providerDeadline = setTimeout(abortProvider, 29_000);
    const wasBusy = active.has(scope.userId) || at - (starts.get(scope.userId) ?? -Infinity) < 5_000;
    if (!wasBusy) {
      active.set(scope.userId, turn);
    }
    const run = operation => cancellable(() => { assertCurrent(); return operation(); }, controller.signal);
    const allowed = config => config.enabled === true && config.channelIds.includes(scope.channelId);

    async function freshAccess() {
      assertCurrent();
      try {
        if (!allowed(await run(() => settings.get()))) throw localError('access_denied');
        assertCurrent();
        const access = await run(() => refreshJijiAccess(message.guild, scope.channelId, scope.userId));
        assertCurrent();
        // Settings may change while Discord fetches are in flight.
        if (!allowed(await run(() => settings.get())) || !access.canSend) throw localError('access_denied');
        assertCurrent();
        return access;
      } catch (error) {
        if (!isCurrent()) throw localError('cancelled');
        throw localError(error.category === 'access_denied' ? 'access_denied' : 'access_unavailable');
      }
    }
    async function reply(content) {
      await freshAccess();
      assertCurrent();
      try {
        await run(() => message.reply({ content, allowedMentions: { parse: [], repliedUser: false } }));
        assertCurrent();
      } catch { throw localError('discord_send_failed'); }
    }
    let usedTools = false;
    try {
      let access = await freshAccess();
      if (prompt === null) {
        if ((reference.guildId && reference.guildId !== guildId)
          || (reference.channelId && reference.channelId !== scope.channelId)) return;
        let replyAuthorId = message.mentions?.repliedUser?.id ?? message.referencedMessage?.author?.id;
        if (!replyAuthorId && typeof message.fetchReference === 'function') {
          try { replyAuthorId = (await run(() => message.fetchReference()))?.author?.id; }
          catch { if (!isCurrent()) return; }
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
      try { history = await run(() => memory.get(scope)); }
      catch { assertCurrent(); throw localError('memory_failed'); }
      await freshAccess();
      const permittedTools = createJijiTools({
        guild: message.guild, guildId, channelId: scope.channelId, userId: scope.userId, departureLog,
        checkAccess: async () => { await freshAccess(); return isCurrent(); },
      });
      const tools = {
        execute(call, { signal = provider.signal } = {}) {
          usedTools = true;
          return cancellable(() => { assertCurrent(); return permittedTools.execute(call, { signal }); }, signal);
        },
      };
      const result = await cancellable(() => {
        assertCurrent();
        return gemini.respond({ history, text: prompt, tools, signal: provider.signal });
      }, provider.signal);
      assertCurrent();
      if (typeof result?.text !== 'string' || !result.text.trim() || result.text.length > 2_000) throw localError('invalid_answer');
      await reply(result.text);
      if (!usedTools && result.usedTools !== true) {
        await freshAccess();
        try {
          // The memory store checks this guard inside its serialized mutation queue.
          await run(() => memory.append(scope, { user: prompt, assistant: result.text }, { isCurrent }));
        } catch { assertCurrent(); throw localError('memory_failed'); }
      }
    } catch (error) {
      if (!isCurrent() || ['access_denied', 'access_unavailable', 'discord_send_failed'].includes(error.category)) return;
      const content = error.category === 'member_fetch_failed' ? MEMBER_ERROR
        : error.category === 'departure_read_failed' ? DEPARTURE_ERROR
          : error.category === 'memory_failed' ? MEMORY_ERROR : JIJI_TIRED_MESSAGE;
      // No second failure reply: a failed permission refresh/send stays silent.
      try { await reply(content); } catch { /* Never expose private error details. */ }
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
