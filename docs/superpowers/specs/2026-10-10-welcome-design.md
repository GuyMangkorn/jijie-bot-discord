# Welcome configuration design

Design basis: the user requested join tracking and welcome messages in a chosen channel, preferred configuration inside Discord over a channel ID in `.env`, and requested an implementation plan. This document records that conversational scope and the concrete defaults for review alongside the plan.

## Outcome and commands

Keep the existing `guild_join` activity tracking and 30-day retention. Add automatic welcome messages for human members joining the guild in `DISCORD_GUILD_ID` while the bot is connected. No historical welcome messages, invite attribution, or new join-history store.

- `/ต้อนรับ ตั้งค่า ห้อง:<text channel> [ข้อความ:<template>]`: require `ManageGuild` (Manage Server) from the requester, both command defaults and runtime checks. Restrict the channel option to `ChannelType.GuildText` in the configured guild. Require current `ViewChannel` and `SendMessages` for the bot and `ViewChannel` for the requester. Fetch channel/member state rather than trust an absent cache entry. Persist configuration before confirming success, with an ephemeral Thai reply. No public test message.
- `/ต้อนรับ ดู`: same guild and requester permission checks; show enabled/disabled, channel and template ephemerally. If the requester cannot currently view the configured channel, show that the channel is inaccessible without exposing its ID or template. A deleted channel is reported as unavailable; API failure is reported as an error, not as deletion.
- `/ต้อนรับ ปิด`: same authorization; persist disabled configuration and clear channel/template. Idempotent; Thai ephemeral confirmation.

Default template when `ข้อความ` is omitted: `ยินดีต้อนรับ {member} เข้าสู่เซิร์ฟเวอร์ 🎉`. Each setup replaces the previous configuration; omission resets the template to this default. Replace every literal `{member}` with `<@USER_ID>`; leave other text unchanged. Accept 1–1,000 UTF-16 code units after trimming; reject whitespace-only templates. Final messages must be at most 2,000 UTF-16 code units, including repeated placeholder expansions. Only the joining user may be mentioned; role mentions and everyone/here pings are suppressed. Configuration replies suppress all mentions. Templates without `{member}` are allowed and do not ping anyone.

## Boundaries and data

`src/welcome-settings.js` owns validation and versioned serialized atomic writes to `data/welcome.json`. `src/welcome-message.js` owns template expansion and sending with current channel permission checks. `src/welcome-command.js` owns command metadata and interactions. `src/index.js` only connects these modules to the existing Gateway and interaction handlers. Keep activity persistence independent of welcome success.

JSON format: `{ "version": 1, "guildId": "...", "channelId": null, "template": null }` when disabled; enabled values are strings. Missing file means disabled. Validate version, guild ID, snowflake channel ID and template including maximum expanded size; reject corrupt or mismatched-guild files at startup instead of overwriting them. Never store tokens or member data here. Write a temporary file with mode `0o600`, rename atomically, and only update in-memory settings after success. Serialize updates, allow a failed update to be followed by a successful one, and return copies from reads. One process per data file. Back up `data/` when moving installations.

## Delivery, installation and limitations

Use existing `GuildMembers` intent and require Server Members Intent enabled in the Developer Portal. No new intents, OAuth scopes, environment variables, dependencies, or bot-wide Manage Server permission. Sending plain text needs only `View Channel` and `Send Messages` in the welcome channel.

Ignore bot accounts and other guilds. On join, read settings, fetch the configured channel and bot member, confirm ordinary guild text channel and current bot permissions, expand and send once. Disabled settings skip all network work. Missing/deleted channels, permission failures and send failures leave settings intact and report a Thai diagnostic with only error name/code; do not log templates, message bodies or secrets. Do not retry failed sends automatically or replay on startup. There is no persistent delivery queue or exactly-once guarantee across reconnects/crashes. A returning human member gets a new welcome on a new received join event.

Register the new slash command using the existing script without removing unrelated commands. Update README command, permission and intent tables, examples, setup, storage and limitations together with implementation; `.env.example` stays unchanged. Document responsibilities and maintenance in AGENTS.md. Test offline with `node --test`; live verification requires a test member joining, restart persistence, permission loss, and command access by a member without Manage Server. The current workspace has no Git repository, so commits are conditional on executing in an actual Git checkout.
