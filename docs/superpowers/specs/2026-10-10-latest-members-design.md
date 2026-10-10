# Latest server members — design for review

## Purpose

สร้างบอต Node.js แบบง่าย ใช้คำสั่ง `/ล่าสุด` ในแชท Discord เพื่อดูคนที่เข้าร่วมเซิร์ฟเวอร์ล่าสุด 10 คน พร้อมเวลาเข้าร่วม

## Proposed behavior

- Query current members of the command's server, exclude bots, and display at most 10 humans, newest joined first. People who already left are outside this query.
- Fetch the complete member list through `guild.members.fetch()` on each invocation; never rank only a partial cache or assume the API returns join-date order.
- Ignore members whose `joinedTimestamp` is null or not a finite number. Break equal timestamps by ascending string member ID for deterministic output.
- Reply publicly with one embed: title `สมาชิกที่เข้าร่วมล่าสุด`, numbered mentions and Discord `<t:SECONDS:f>` timestamps. Disable all mention notifications. Discord renders timestamps in each viewer's local time.
- When no qualifying members exist, display `ไม่พบสมาชิกที่มีข้อมูลเวลาเข้าร่วม`.
- Defer the response before fetching. On fetch failure, display `ดึงข้อมูลสมาชิกไม่สำเร็จ กรุณาตรวจสอบ Server Members Intent แล้วลองอีกครั้ง` and do not display partial results.
- Reject direct-message invocation with `คำสั่งนี้ใช้ได้เฉพาะในเซิร์ฟเวอร์` privately. Ignore unrelated interactions.

## Global constraints

- Runtime: Node.js >=20.6.0, JavaScript ES modules (for the built-in `--env-file` option; the current workspace has Node.js 24.5.0).
- Dependency: discord.js 14.27.0; no other runtime dependencies.
- Configuration: DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID in a local .env file loaded with Node's --env-file option.
- Command: /ล่าสุด, registered only in DISCORD_GUILD_ID for this first version.
- Gateway intents: Guilds and GuildMembers; enable Server Members Intent in Developer Portal.
- No database, voice tracking, message-content intent, or hosting setup.
- Never commit .env or log token values; fail clearly on missing configuration.

## Structure and operations

Separate pure selection/formatting from Discord interaction handling. A small startup file connects the client; a separate registration script creates or updates this command without replacing other existing commands. README in Thai explains Developer Portal setup, invitation with bot and applications.commands scopes, required channel permissions (View Channel, Send Messages, Embed Links), registration, and startup. The Node process must stay running for commands to work.

## Validation

Use node:test for selection and interaction behavior with fake Discord objects. Run a manual smoke test in the user's server only after credentials are configured: register command, start bot, run /ล่าสุด, compare ordering with known join times, and check that mentions do not notify users. Local tests cannot verify Discord permissions or live authentication.

## Sources

- [Discord member objects and member listing](https://discord.com/developers/docs/resources/guild#guild-member-object)
- [Privileged intents](https://support-dev.discord.com/hc/en-us/articles/6207308062871-What-are-Privileged-Intents)
- [discord.js documentation](https://discord.js.org/docs/packages/discord.js/14.27.0)

Status: implemented in this workspace. The final dependency was raised to discord.js 14.27.0 after npm audit found vulnerabilities in 14.26.2. This folder has no Git repository, so there is no design commit.
