# Instructions for working on this bot

## Current behavior

Read `README.md` before changing features, Discord permissions, Gateway intents, commands, or configuration. Its command and permission tables are the maintained feature inventory. Confirm behavior against `src/`, `scripts/`, and `package.json`; the tables describe required setup, not a verified snapshot of the live Discord server.

## Completing a feature

Every feature change must include documentation updates in the same change:

1. Update the README command table with the exact command name, options, response, and who can use it. Include examples for new or changed commands.
2. Update the README permissions, OAuth2 scopes, and Gateway intent tables when requirements change. Explain why each added permission is needed and how the user applies it to an existing bot. Grant the minimum permissions the feature needs.
3. Add new configuration variable names to `.env.example` and document their purpose and where to obtain them in README. Keep real values in the local `.env` only.
4. Document the feature's limitations and storage behavior: whether it works for historical members, requires the bot to be online, stores records, or requires migration/setup.
5. Add or revise instructions in this `AGENTS.md` when the feature introduces a new development rule, module responsibility, data format, or maintenance step. Link to detailed documentation instead of duplicating it here.
6. Before reporting completion, compare every changed command, configuration variable, permission, and intent with the documentation. Report verification actually performed and any live Discord check that remains pending.

A feature is complete when its implementation and usage/setup documentation agree. Do not list proposed features as implemented; record proposals separately from the current command inventory.

## Project conventions

- Use JavaScript ES modules and the existing `discord.js` dependency. Runtime and npm scripts are defined in `package.json`.
- Keep selection/formatting logic separate from Discord interaction handling. Register commands through `scripts/register-commands.js`, preserving unrelated existing commands.
- Acknowledge interactions before slow work. Return a clear Thai error when member retrieval fails; avoid presenting a partial member cache as a complete result.
- Keep tokens and other secrets out of source, documentation, command replies, and logs. `.env.example` contains names and empty values only.
- When a feature changes installation requirements, include the exact user action in README (for example, re-register commands or restart the bot).
- Keep Gateway event conversion, activity persistence, history collection, and interaction handling in separate modules; update the activity event tests when adding event types.

## Departure history

- `src/departure-log.js` owns the versioned departure JSON, serialized atomic writes, retention, and formatting. `src/departure-command.js` handles `/ออกล่าสุด`; `src/index.js` records Gateway removals only for the configured guild.
- Preserve the version 1 data contract and fail on corrupt or mismatched-guild data instead of silently replacing it. Run one bot process per data file. Keep `data/` ignored and document migration if the format changes. When changing storage or recovering history, read [README's departure history section](README.md#ประวัติการออกและข้อจำกัด) for the data format and recovery rules.
- Do not describe Gateway removals as confirmed voluntary leaves or claim complete historical coverage. Run `npm test` for persistence, retention, and interaction handling before changing this feature.

## Activity history

- `src/activity-events.js` converts Gateway events to metadata; `src/activity-log.js` owns `data/activity/` JSON files, the tracking-start manifest, atomic writes, and 30-day retention. `src/activity-history.js` enforces current channel permissions, reads bounded message/Audit Log pages, merges results, and formats them; `src/activity-command.js` handles `/กิจกรรม`.
- Preserve activity data version 1 and fail on corrupt or mismatched-guild files. Never persist message content, Audit Log reasons, or unrelated event fields. Run one bot process per activity directory, keep `data/` ignored, and back up `data/` when moving installations.
- Historical message results and stored channel events must be filtered by current permissions. Audit Log results require `View Audit Log` for both the bot and requester. Mark bounded, inaccessible, timed-out, or failed sources as incomplete; never claim a complete history when a source was skipped. Read [README's activity history section](README.md#ประวัติกิจกรรมและข้อจำกัด) before changing this data or permissions, and run `npm test` before changing this feature.

## Welcome messages

- `src/welcome-settings.js` owns `data/welcome.json`, its version 1 contract, serialized atomic writes, and validation. `src/welcome-message.js` owns template validation/expansion and current channel permission checks before sending. Refresh channel, role, and member data from Discord before calculating permissions; do not rely on cached permission data. `src/welcome-command.js` owns `/ต้อนรับ`; `src/member-join.js` independently handles join activity persistence and welcome delivery. `src/index.js` wires the modules and opens the settings before login.
- Preserve the version 1 settings shape and fail on corrupt or mismatched-guild data. Keep `data/` ignored, use one bot process per data file, and back up `data/` when moving installations. Do not log templates or message bodies. A send failure must not prevent join activity from being recorded. Read [README's welcome message section](README.md#ข้อความต้อนรับและข้อจำกัด) before changing settings, permissions, or delivery behavior, and run `npm test` before changing this feature.

## Jiji conversation

- `src/jiji-runtime.js` opens and reconciles Jiji stores before login, wires provider/chat/commands, owns the one-minute prune timer, and aborts pending turns on close. `src/index.js` runs message activity recording independently from chat; preserve bot/webhook exclusion and the old command handlers. Registration uses per-command PATCH/POST for owned commands, never bulk replacement or deletion of unrelated commands.
- `src/jiji-settings.js` owns `data/jiji-settings.json`; `src/jiji-memory.js` owns `data/jiji-memory.json`. Preserve both exact version 1 contracts, atomic serialized writes and fail-startup corruption/guild validation. Reconcile memory with enabled/allowed channels on startup to finish interrupted disable/removal cleanup. Use one process per data set and keep `data/` ignored. Read [README's Jiji storage rules](README.md#ที่เก็บข้อมูลสนทนาจีจี้) before changing persistence, expiry, backups, recovery or deletion semantics.
- `src/jiji-access.js` refreshes Discord permission inputs; `src/jiji-command.js` owns `/จีจี้` and `/ลืม`; `src/jiji-trigger.js` parses invocations; `src/jiji-chat.js` owns permission rechecks, per-user limits, deadline, cancellation and turn persistence. Forget/channel removal/disable/close must invalidate and abort pending turns before cleanup; late uncancellable work must never start an answer or recreate cleared memory. Keep the append guard inside the memory mutation queue.
- Conversation content is permitted ONLY in the new Jiji memory store: at most 10 completed, successfully sent ordinary pairs per channel/user, 30-minute idle expiry, 1,000 sessions. Any tool use excludes the whole pair. Do not store greetings, busy/errors, raw provider responses, tool data, attachments or other people's messages. Activity remains metadata-only with its existing version 1 contract.
- `src/jiji-tools.js` permits only the approved read-only tools and static activity guidance; `src/member-service.js` shares complete member retrieval with `/ล่าสุด`. `src/gemini-client.js` owns native-fetch Gemini REST requests and budgets. Never log keys, headers, URLs, provider bodies/errors or conversations; use locally assigned categories/status only for Jiji errors. Read [README's Gemini setup/privacy rules](README.md#gemini-การตั้งค่าและความเป็นส่วนตัว) and [chat limitations](README.md#การเรียกและวงจรสนทนาจีจี้) before changing access, intents, prompts, tools or provider behavior.
- Run `node --test test/jiji-integration.test.js` and `npm test` for Jiji changes. Use fake Discord/fetch, temporary JSON and injected clocks; do not make live API calls or read `.env` during development. Report live intent/permissions/key/model checks as pending until actually performed.
