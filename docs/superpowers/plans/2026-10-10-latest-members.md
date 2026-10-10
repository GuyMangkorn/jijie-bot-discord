# Latest Server Members Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a simple Discord bot that answers /ล่าสุด with the 10 most recently joined current human members.

**Architecture:** Fetch the server's complete member list on invocation and rank join timestamps through a pure helper. A command handler owns Discord replies, a startup module connects the client, and a separate script registers the command in one server. No persistence is required.

**Tech Stack:** Node.js ES modules, discord.js 14.27.0.

**Spec:** ../specs/2026-10-10-latest-members-design.md — proposed behavior and defaults for review alongside this plan.

## Global Constraints

- Runtime: Node.js >=20.6.0, JavaScript ES modules (the current workspace has Node.js 24.5.0).
- Dependency: discord.js 14.27.0; no other runtime dependencies.
- Configuration: DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID in a local .env file loaded with Node's --env-file option.
- Command: /ล่าสุด, registered only in DISCORD_GUILD_ID for this first version.
- Gateway intents: Guilds and GuildMembers; enable Server Members Intent in Developer Portal.
- No database, voice tracking, message-content intent, or hosting setup.
- Never commit .env or log token values; fail clearly on missing configuration.

## Review Focus

- Fewer than 10 humans, or only bots: show available humans or the specified empty message (Task 1).
- Missing or invalid join times: omit them without disturbing valid ordering (Task 1).
- Fetch rejects or times out: finish the deferred reply with the specified error and no partial list (Task 2).
- Direct messages and unrelated interactions: reject DMs privately and ignore other commands (Task 2).
- Mention formatting: list users without triggering any mention notifications (Task 2).

---

## File Structure

- `package.json`, `package-lock.json`: pinned dependency, ES modules, start/register/test scripts.
- `.env.example`, `.gitignore`: configuration names and protection for .env/node_modules.
- `src/latest-members.js`: pure selection and embed-data formatting.
- `src/command.js`: command definition and interaction handler.
- `src/config.js`: read and validate environment variables.
- `src/index.js`: client creation, event wiring, login.
- `scripts/register-commands.js`: create or update this guild command through REST.
- `test/latest-members.test.js`, `test/command.test.js`, `test/config.test.js`: offline tests.
- `README.md`: Thai setup and usage instructions.

### Task 1: Select and format the newest human members

**Files:** Create `package.json`, `.gitignore`, `src/latest-members.js`, `test/latest-members.test.js`.

**Interfaces:**
- Consumes: `Iterable<{ id: string, user: { bot: boolean }, joinedTimestamp: number | null }>`.
- Produces: `selectLatestMembers(members) -> Array<Member>` (at most 10); `buildMembersEmbed(members) -> { title: string, description: string }`, accepting selected members.

- [ ] **Step 1: Add the minimal ES-module package and selection tests.** Use `node:test` and `node:assert/strict`. Set `test` script to `node --test`. Assert these cases with fixed IDs and timestamps:
  - `newest_ten`: 12 humans with timestamps 1000–12000 return IDs 12 through 3.
  - `bots_and_small_lists`: two humans and a newer bot return the two humans only; a bot-only list returns [].
  - `invalid_times`: null, NaN, and Infinity join times are omitted.
  - `ties_and_input_integrity`: equal timestamps sort by ascending string ID; the original array remains unchanged.
  - `embed_copy`: selected ID `123` at 12000ms produces title `สมาชิกที่เข้าร่วมล่าสุด` and description `1. <@123> — <t:12:f>`; [] produces description `ไม่พบสมาชิกที่มีข้อมูลเวลาเข้าร่วม`.
- [ ] **Step 2: Run `node --test test/latest-members.test.js`.** Expected: FAIL because the helper module does not exist.
- [ ] **Step 3: Implement the two exported pure functions in `src/latest-members.js`.** Filter, copy, sort descending by time with ascending ID tie-break, and slice to 10; convert milliseconds to whole seconds for formatting.
- [ ] **Step 4: Run `node --test test/latest-members.test.js`.** Expected: all cases PASS.
- [ ] **Step 5: Save the completed task.** If the user has initialized Git, commit these files with `feat: select and format latest server members`; otherwise leave the files ready for review without creating a repository.

### Task 2: Wire the Discord command and runnable setup

**Files:** Create `src/command.js`, `src/config.js`, `src/index.js`, `scripts/register-commands.js`, `.env.example`, `README.md`, `test/command.test.js`, `test/config.test.js`; modify `package.json`, `.gitignore`; generate `package-lock.json`.

**Interfaces:**
- Consumes: Task 1's `selectLatestMembers(members)` and `buildMembersEmbed(members)`; Discord Interaction and REST APIs.
- Produces: `handleLatestMembers(interaction) -> Promise<void>`; `commandData -> REST slash-command JSON` with name `ล่าสุด` and description `ดูสมาชิกที่เข้าร่วมเซิร์ฟเวอร์ล่าสุด 10 คน`; `readConfig(env) -> { token: string, clientId: string, guildId: string }`.

- [ ] **Step 1: Write command and config tests using fake interactions.** Assert:
  - `full_fetch_and_defer`: `deferReply()` happens before `guild.members.fetch()`; embed includes a newer member provided by fetch but absent from cache; `editReply` has `allowedMentions: { parse: [] }`.
  - `fetch_failure`: rejected fetch edits the reply with `ดึงข้อมูลสมาชิกไม่สำเร็จ กรุณาตรวจสอบ Server Members Intent แล้วลองอีกครั้ง`, without an embed or partial cache results.
  - `dm_rejection`: private reply is `คำสั่งนี้ใช้ได้เฉพาะในเซิร์ฟเวอร์`, and fetch is never called.
  - `unrelated_interactions`: non-chat-input and other-command interactions make no reply or fetch calls.
  - `config_validation`: whitespace-only or missing variables throw an error naming the variable, without echoing values; complete config returns the exact three expected values.
- [ ] **Step 2: Run `node --test test/command.test.js test/config.test.js`.** Expected: FAIL because the modules do not exist.
- [ ] **Step 3: Implement `readConfig(env)` in `src/config.js`.** Validate all three required values before startup or registration network calls.
- [ ] **Step 4: Pin discord.js to `14.27.0`, set engines.node to `>=20.6.0`, and run `npm install`.** Expected: dependency installed and lockfile generated. If registry access is blocked, report it without claiming install succeeded.
- [ ] **Step 5: Implement `commandData` and `handleLatestMembers(interaction)` in `src/command.js`.** Use Task 1 helpers on fetched member values; use MessageFlags.Ephemeral for DM rejection, public deferred replies for server use, and the exact spec messages. Catch command errors and log only safe error names/codes; response failures must not produce unhandled rejections.
- [ ] **Step 6: Implement `src/index.js`.** Create a Client with Guilds/GuildMembers intents, wire InteractionCreate to the handler, log a ready message without credentials, and exit unsuccessfully on startup failure without exposing token values.
- [ ] **Step 7: Implement `scripts/register-commands.js`.** Use REST v10: POST the single command to `Routes.applicationGuildCommands(clientId, guildId)` (create or update by name), rather than PUT replacing every command. Report success or exit unsuccessfully with a safe error.
- [ ] **Step 8: Add configuration and Thai usage documentation.** `.env.example` has empty values for the three variables. Ignore `.env` and `node_modules/`. Add `start: node --env-file=.env src/index.js` and `register: node --env-file=.env scripts/register-commands.js`. README walks through bot creation, Server Members Intent, scopes/permissions, `npm install`, copying .env.example, setting values locally, `npm run register`, `npm start`, and `/ล่าสุด`. Explain the running-process requirement and that former members/bots are excluded.
- [ ] **Step 9: Run `npm test` and `node --check` on each src file and the registration script.** Expected: all tests PASS and all syntax checks exit 0. Confirm no real credentials exist in tracked/deliverable files.
- [ ] **Step 10: Perform the live smoke test when local credentials are available.** Register, connect, invoke `/ล่าสุด`, verify descending join times and no mention notifications. Without credentials, record this test as pending; offline tests are not a live validation.
- [ ] **Step 11: Save the completed task.** If Git is available, commit the task with `feat: add Discord latest members command and setup`; otherwise retain reviewable workspace files.

## Execution Handoff

Review this plan and the accompanying design before implementation. Native execution is recommended: two closely related tasks for a small bot, with offline tests and a final review. Subagent-driven execution is also available if the user prefers separate implementation and review agents. No production code or credentials have been created as part of planning.

## Implementation Notes

- The user requested implementation in this workspace. It is not a Git repository, so changes are being made in place without commits.
- The implementation contains the command, registration script, configuration loader, and Thai setup guide. The test files and test commands from the original plan were omitted because the applicable developer instruction says not to add or run tests unless the user asks for testing or verification.
- The design runtime floor is Node.js 20.6.0 because that version introduced `--env-file`; the original 24.17.0 value came from the current discord.js main docs and did not match the pinned v14 line or the installed Node.js 24.5.0.
- The dependency was upgraded from 14.26.2 to 14.27.0 after npm audit reported moderate and high severity issues in its transitive `undici`; npm audit reports zero vulnerabilities after the upgrade.
- A fresh read-only review found no blocking implementation issues. The live Discord smoke test remains pending until the user configures credentials.
