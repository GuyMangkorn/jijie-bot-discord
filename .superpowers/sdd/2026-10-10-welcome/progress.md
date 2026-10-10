# SDD ledger — plan: /Users/mangkornkatawong/Documents/bot-dis/docs/superpowers/plans/2026-10-10-welcome.md

Ruling: Execute in the current workspace without a worktree, Git range or commits — the supplied project directory has no `.git`, and creating a repository would change project state beyond the requested feature — cost if wrong: changes are not isolated in branch history.

Pre-flight: Task 2 produces `validateWelcomeTemplate` consumed by Task 1; the plan explicitly orders **Task 2 → Task 1 → Task 3**, so execute in dependency order. Task 3 consumes Task 1 and Task 2 interfaces; names and arguments are consistent.

Ruling: Treat the step-by-step feature tests in the user-selected implementation plan as authorized verification — the user asked to implement that exact plan, whose explicit deliverables include tests and test commands — cost if wrong: added test code may exceed the user's intended implementation scope.

Ruling: Write the task ledger manually under `.superpowers/sdd/` and conduct final review from the listed files — the prescribed scripts require Git metadata and cannot run in this workspace — cost if wrong: no VCS range will capture unrelated or pre-existing changes for review.

Task 2: complete (welcome formatting, mention controls, delivery permission checks, tests and README behavior/permission/intent documentation; `node --test test/welcome-message.test.js` → 14/14 pass).

Task 1: complete (version 1 atomic settings store, recovery/validation tests, README storage limits and AGENTS ownership; `node --test test/welcome-settings.test.js` → 15/15 pass).

Task 3: implementation and verification complete pending independent final review and live Discord acceptance. `node --test test/welcome-command.test.js` → 31/31 pass; `node --test test/member-join.test.js test/welcome-integration.test.js` → 5/5 pass; `npm test` → 92/92 pass; all six `node --check` commands → exit 0. README command, permission, scope, intent, setup, data and limitation details compared to source; `.env.example` remains unchanged because no new variable is needed. Command registration/live GuildMemberAdd acceptance is pending a real Discord server.

Ruling: Do not run `npm run register` or alter a live Discord server during implementation — this writes application commands and requires external Discord credentials/server state; the plan's offline checks exercise command metadata and registration-loop inclusion — cost if wrong: the command will not appear on the user's server until they run registration.

Review fix: Important — Discord.js returned cached channels and members to permission checks, which could reveal an old welcome template after access was removed. Force-fetch the configured channel and requester/bot members and refresh guild roles before permission calculation in setup, view and delivery. A regression fixture gives stale cached state permission and fresh state denial; the view now hides the template and `npm test` passes. Cost: an extra roles API request for each relevant permission check.

Review fix: Important — a template with a literal `<@USER_ID>` but no `{member}` could ping despite the documented rule. Only allow the joining user's mention when the template contains `{member}`; the literal text remains in the message but cannot ping. Added a regression test; `npm test` passes.

Deferred review finding: Minor — two persistence/error tests check for `/ตั้งค่าสำเร็จ/`, while the actual success response is `ตั้งค่าข้อความต้อนรับใน ... แล้ว`; they could miss that exact response being emitted on failure. Deferred because the final review classed it Minor and the execution skill excludes Minor items from the fix pass.

Re-review correction: The first forced requester-member fetch used `guild.members.fetch(id, { force: true })`, but the installed discord.js method takes one options argument, so it ignored force and the test doubles concealed the mismatch. Changed setup/view to `guild.members.fetch({ user: id, force: true })`; updated unit and integration fixtures to the actual signature. Test-first reproduction failed on stale cache and integration expectations, then focused command/integration tests passed 33/33. A final focused reviewer confirmed the API signature and found no similar call. Final verification after this correction: `npm test` → 92/92 pass; all six `node --check` commands → exit 0. Live Discord acceptance remains pending.

