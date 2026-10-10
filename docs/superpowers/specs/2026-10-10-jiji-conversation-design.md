# จีจี้: Gemini conversation design

Status: proposed implementation specification, distilled from the confirmed interview; no feature is implemented by this document.

## User-facing behavior

- จีจี้ chats in Thai with short, friendly answers, occasional emojis and light contextual jokes. It identifies itself honestly as a bot, asks when a request is ambiguous, and does not invent server facts.
- Respond only in the configured guild's enabled, allowlisted ordinary text channels. No DMs, threads, attachments, web search, unsolicited replies, or reading other people's conversations.
- Triggers: `จีจี้` at the start after leading whitespace (including `จีจี้ช่วย…`), an explicit mention of this bot, or a reply referencing a message authored by this bot. Ignore bots/webhooks. A bare invocation receives `จีจี้อยู่นี่ 😊 มีอะไรให้ช่วยไหม?` without an API request. Explicit replies to another user's bot response use the replying user's own memory; never import the referenced message text.
- Answer publicly with all Discord mentions disabled. Freshly validate requester/bot access before reading memory, tools, or sending results. Disabled/deleted/inaccessible channels receive no conversational response.
- Read-only tools: `get_latest_members({})` and `get_recent_departures({})`, maximum 10 entries with the same selection/storage semantics as existing commands. Fetch full members; failed fetch is a failure, never a complete cache result. Departures mean observed removals, not confirmed voluntary leaves; limited to recorded events while online.
- A static guidance tool `activity_help({})` returns `ใช้ /กิจกรรม สมาชิก:@สมาชิก [ช่วงวัน:1–30] เพื่อดูผลแบบเห็นเฉพาะคุณนะ 🔎`. It reads no activity data. No welcome configuration or member/channel management tools.
- General conversation is permitted. Server data must come from approved tools. Prompt instructions are guidance; code validates tool names and empty argument objects, guild, requester, and current permissions independently of model output.

## Administration

| Command | Options | Response / effect | Access |
| --- | --- | --- | --- |
| `/จีจี้ เพิ่ม` | required `ห้อง`, GuildText | add channel idempotently, remain in current enabled state | current Manage Server |
| `/จีจี้ ลบ` | required `ห้อง`, GuildText | remove idempotently and erase that channel's memory | current Manage Server |
| `/จีจี้ ดู` | none | enabled state and allowed channels currently visible to requester; count hidden channels without names/IDs | current Manage Server |
| `/จีจี้ เปิด` | none | enable if at least one valid accessible channel and Gemini key configured; otherwise explain required setup | current Manage Server |
| `/จีจี้ ปิด` | none | disable, retain channel list, erase all conversational memory | current Manage Server |
| `/ลืม` | none | erase caller's memory in this channel, idempotently, including pending turn invalidation | any member allowed to use this slash command |

All these command replies are ephemeral and acknowledge before slow work. Adding a room does not enable an initially disabled bot. Refresh guild roles, requester/bot members and selected channel before permission calculations. Adding requires requester View Channel and bot View Channel/Send Messages. Removing a stored inaccessible/deleted room must remain possible; do not require current bot send permission to remove it. Default slash permissions and runtime enforcement both apply to `/จีจี้`.

## Memory and data

The latest user approval changes memory from RAM-only to JSON persistence. Preserve the previously chosen 10 completed pairs and 30-minute idle expiry: persistence alone does not extend retention. Load unexpired conversations across restarts; do not reconstruct them from Discord history.

- `data/jiji-settings.json`: version 1, exact top-level `{version:1,guildId,enabled,channelIds}`; absent means disabled/empty.
- `data/jiji-memory.json`: version 1, exact top-level `{version:1,guildId,sessions}`. Session shape `{channelId,userId,updatedAt,turns}`; each turn `{user,assistant,at}`. IDs are snowflake strings; timestamps are finite nonnegative integer Unix milliseconds; texts are nonempty strings at most 2,000 UTF-16 units; max 10 turns, unique channel/user key. Validate exact keys and fail startup on corrupt or mismatched-guild data, never silently replace.
- Retain only completed, successfully sent ordinary text conversations. If ANY tool is used, save neither the user turn nor its assistant answer, nor function call/results. Failure/tired/rate-limit/greeting messages are not memory. Store no API keys, raw provider responses, attachments, audit reasons, or other people's messages.
- Expire a session at idle age >= 1,800,000 ms. Prune at startup, read/write, and every minute; save removals. Limit to 1,000 sessions, evict least-recently-updated with deterministic channel/user tie-breaks.
- Serialized atomic writes using temp+rename and file mode 0600; update live state only after write succeeds, defensive copies, injectable clock/filesystem for tests. One bot process per data set; back up data when moving hosts. Existing departure/activity/welcome version 1 contracts remain unchanged.
- `/ลืม`, channel removal, and global disable invalidate pending work: it must neither send a late answer nor recreate erased memory. A startup reconciliation erases sessions for channels no longer allowed and all sessions if disabled (covers a crash between settings and memory saves).
- `/ลืม` removes local bot memory, not messages on Discord or data already sent to Gemini. Deleting a Discord message does not automatically erase local memory in this version; document and use `/ลืม` to erase it.
- Limit one active question per user across the guild, and >=5,000 ms between starts. No queue/retries/provider fallback. A total 30,000 ms deadline includes permission fetch, tools, and Gemini; release active state on every failure. Abort/cancel pending HTTP when invalidated; ignore late uncancellable Discord work.
- Allow at most three Gemini HTTP requests and four total tool calls per user question. Input max 2,000 UTF-16 units; generated answer max 2,000. Oversized input gets a short Thai request to shorten it. Set max output tokens 512. Memory expiry and keying apply regardless of restart.

## Provider, configuration, errors

Use Node native fetch and Gemini REST `v1beta/models/{model}:generateContent`; no new runtime dependency. Send key only via `x-goog-api-key` header. Defaults chosen for implementation: optional `GEMINI_API_KEY`, `GEMINI_MODEL` default `gemini-2.5-flash` (validate model identifier, never allow arbitrary URL). Model/account availability and free quotas require a live check during setup; do not promise perpetual free service. No fallback model/provider or automatic paid upgrade.

Missing key leaves existing commands working; `/จีจี้ เปิด` explains missing configuration. Every provider failure (quota, invalid key, timeout, HTTP failure, malformed/blocked/empty response, exhausted tool budget) has exactly this public answer: `จีจี้เหนื่อยแล้ว 😴 รอก่อนแล้วค่อยมาคุยกันใหม่นะ`. Log only locally assigned error categories/HTTP status, never provider body/error message, headers, request URL, key, or conversation. Storage and member retrieval failures use separate clear Thai operational errors. Busy/cooldown responds `จีจี้กำลังคิดอยู่ 😊 รอแป๊บนะ`; these responses never call Gemini.

Add Message Content intent in code and Developer Portal. No new OAuth scopes, bot Administrator/Manage Server, or View Audit Log required by this feature. Existing View Channel/Send Messages and GuildMembers suffice for ordinary conversation/tools. Use an included referenced-message author for replies; fallback fetching a single referenced message uses the bot's existing Read Message History permission. Do not fetch full history for memory. If reply reference cannot be resolved safely, do not guess (an independently present name/mention trigger can still work).

## Verification and delivery

Offline node:test coverage for persistence, failure recovery, routing, bounds, permissions, cancellation, provider payloads, and integration without real keys. Run all existing tests. Update README feature/options/examples/config/permission/intent/setup/storage/limitations together with implementation; add module/data maintenance guidance to AGENTS.md. `.env.example` has empty values only; never read or print `.env` during implementation. Re-register commands, enable intent, restart, configure room, then explicitly enable. Live Discord and Gemini checks are manual and must be reported pending until actually performed.

## Sources checked 2026-10-10

- [Gemini function calling](https://ai.google.dev/gemini-api/docs/function-calling)
- [Gemini 2.5 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash)
- [Gemini pricing and free-tier data use](https://ai.google.dev/gemini-api/docs/pricing)
- [Discord messages and access](https://docs.discord.com/developers/resources/message)
- [Discord Gateway intents](https://github.com/discord/discord-api-docs/blob/main/developers/events/gateway.mdx)
