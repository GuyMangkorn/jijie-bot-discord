import { fetchLatestMembers } from '../members/member-service.js';

export const jijiToolDeclarations = [
  { name: 'get_latest_members', description: 'สมาชิกปัจจุบันที่เป็นคนและเข้าร่วมล่าสุด สูงสุด 10 คน' },
  { name: 'get_recent_departures', description: 'เหตุการณ์สมาชิกออกที่บอตบันทึกขณะออนไลน์ สูงสุด 10 รายการ ไม่ทราบเหตุผล' },
  { name: 'activity_help', description: 'คำแนะนำใช้คำสั่งกิจกรรมแบบเห็นเฉพาะผู้เรียก ไม่อ่านประวัติกิจกรรม' },
].map((tool) => ({ ...tool, parameters: { type: 'object', properties: {}, additionalProperties: false } }));

const failed = (error) => ({ ok: false, error });
const emptyArguments = (args) => args !== null && typeof args === 'object' &&
  Object.getPrototypeOf(args) === Object.prototype && Reflect.ownKeys(args).length === 0;

// Context is supplied by the runtime, never by model-selected arguments.
// ToolResult: {ok:true,data:object} | {ok:false,error:stableLocalCategory}.
export function createJijiTools({ guild, guildId, userId, channelId, departureLog, checkAccess }) {
  const handlers = new Map([
    ['get_latest_members', { error: 'member_fetch_failed', run: async () => ({ members: await fetchLatestMembers(guild) }) }],
    ['get_recent_departures', { error: 'departure_read_failed', run: async () => ({
      departures: (await departureLog.latest()).slice(0, 10).map(({ userId: id, name, leftAt }) => ({ userId: id, name, leftAt })),
      coverage: 'recorded_while_online', reason: 'unknown',
    }) }],
    ['activity_help', { error: 'tool_failed', run: async () => ({
      message: 'ใช้ /กิจกรรม สมาชิก:@สมาชิก [ช่วงวัน:1–30] เพื่อดูผลแบบเห็นเฉพาะคุณนะ 🔎',
    }) }],
  ]);

  return {
    async execute(call, { signal } = {}) {
      if (signal?.aborted) return failed('cancelled');
      if (!call || typeof call.name !== 'string' || !handlers.has(call.name) || !emptyArguments(call.args)) {
        return failed('invalid_tool_call');
      }
      const handler = handlers.get(call.name);
      if (!guild || guild.id !== guildId || !userId || !channelId || typeof checkAccess !== 'function') {
        return failed('access_denied');
      }
      try {
        if (await checkAccess() !== true) return failed('access_denied');
      } catch {
        return failed(signal?.aborted ? 'cancelled' : 'access_denied');
      }
      if (signal?.aborted) return failed('cancelled');
      try {
        const data = await handler.run();
        return signal?.aborted ? failed('cancelled') : { ok: true, data };
      } catch {
        return failed(signal?.aborted ? 'cancelled' : handler.error);
      }
    },
  };
}
