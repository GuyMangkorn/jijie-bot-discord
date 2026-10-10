# Jiji Gemini Conversation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add friendly Thai Gemini chat and read-only server tools with administrator-controlled rooms and bounded JSON conversation memory.

**Architecture:** Separate persistence, settings interactions, permission checks, trigger selection, provider transport, tools, and turn orchestration. Reuse existing selection/departure storage; keep activity/welcome independent. JSON is authoritative persistent memory; only unexpired ordinary conversation reaches Gemini.

**Tech Stack:** JavaScript ES modules, Node.js >=20.6.0, discord.js 14.27.0, native fetch/fs, node:test; no new package.

**Spec:** `docs/superpowers/specs/2026-10-10-jiji-conversation-design.md` (read before this plan).

## Global Constraints

- Node.js >=20.6.0; JavaScript ES modules; discord.js 14.27.0; no new runtime dependency.
- 10 completed pairs; 1,800,000 ms idle expiry; 1,000 sessions; 2,000 UTF-16 units per input/answer; max output tokens 512.
- One active question per user across the guild; >=5,000 ms between starts; 30,000 ms total deadline; max three Gemini requests/four tool calls; no queue/retry/fallback.
- Tired copy: `จีจี้เหนื่อยแล้ว 😴 รอก่อนแล้วค่อยมาคุยกันใหม่นะ` for every provider failure.
- Only configured guild, allowed ordinary text channels, human senders; all outgoing mentions disabled.
- JSON version 1; fail corrupt/mismatched guild; serialized atomic 0600 writes; one process per data set; `data/` ignored.
- Never read `.env`, log secrets/message text, or change existing activity/departure/welcome schemas.
- README, `.env.example`, and AGENTS.md changes accompany implementation; preserve unrelated registered commands.

## Review Focus

- A pending API response after `/ลืม` or disable must not send or restore memory (Task 5).
- Deleted/inaccessible allowed channels and changed member roles must not expose memory or tool results (Tasks 2, 5).
- API 200 with blocked/empty/malformed content must produce the same tired answer without memory (Task 4).
- Failed atomic saves and a crash between settings/memory changes must not acknowledge false success or restore removed sessions (Tasks 1, 2, 6).
- Replying to another person's bot response must not load their conversation, including after restart (Tasks 1, 5).

---

## File structure and shared contracts

Create `src/jiji-settings.js` (settings JSON), `src/jiji-memory.js` (bounded memory JSON), `src/jiji-access.js` (fresh access), `src/jiji-command.js` (settings and forget slash interactions), `src/jiji-trigger.js` (pure routing), `src/jiji-tools.js` (read-only dispatcher), `src/member-service.js` (full-member retrieval shared with slash), `src/gemini-client.js` (REST wire format), `src/jiji-chat.js` (bounded turn lifecycle), and `src/jiji-runtime.js` (wiring/timer/cancellation).

Create corresponding `test/{jiji-settings,jiji-memory,jiji-command,jiji-trigger,jiji-tools,member-service,gemini-client,jiji-chat,jiji-integration,config}.test.js` as needed. Modify `src/config.js`, `src/command.js`, `src/index.js`, `scripts/register-commands.js`, `.env.example`, README.md, AGENTS.md. Do not refactor unrelated history/welcome modules.

Shared types in JSDoc (no type package): `Turn={user:string,assistant:string,at:number}`, `Scope={channelId:string,userId:string}`, `ToolCall={name:string,args:object}`, `ToolResult={ok:boolean,data?:object,error?:string}`. All store methods return promises; clock is `()=>number`; public records are defensive copies.

### Task 1: Persistent settings and bounded conversational memory

**Files:** Create `src/jiji-settings.js`, `src/jiji-memory.js`, `test/jiji-settings.test.js`, `test/jiji-memory.test.js`. Modify README.md with proposed storage sections only when implementation lands.

**Interfaces:** `openJijiSettings(path,guildId,{writeFile,rename}={}) -> Promise<Settings>`; Settings `get()->{enabled,channelIds}`, `add(channelId)`, `remove(channelId)`, `setEnabled(boolean)`. `openJijiMemory(path,guildId,{now,writeFile,rename}={}) -> Promise<Memory>`; Memory `get(scope)->Turn[]`, `append(scope,{user,assistant},{isCurrent=()=>true}={})->boolean`, `clear(scope)`, `clearChannel(channelId)`, `clearAll()`, `reconcile({enabled,channelIds})`, `prune()`. Append checks synchronous isCurrent inside its serialized operation before preparing the save; returns false when invalidated. Clear queued behind an already-started append must leave the final state erased. Clock default Date.now; fs defaults native.

- [ ] **Step 1: Write failing storage tests.** Use temp dirs and injected clocks/failing rename. Pin exact JSON shapes from spec; missing settings default, idempotent add/remove, settings reopen, guild/schema rejection, complete-pair reopen, 10-pair cap, expiry at precisely 1,800,000 ms, key isolation, 1,000-session deterministic eviction, serialized simultaneous mutations, defensive copies. Include:

```js
await memory.append({channelId, userId}, {user:'เราเป็นบอล', assistant:'หวัดดีบอล 😊'});
assert.equal((await reopened.get({channelId, userId}))[0].user, 'เราเป็นบอล');
assert.deepEqual(await reopened.get({channelId, userId:otherId}), []);
now += 1_800_000;
assert.deepEqual(await memory.get({channelId,userId}), []);
```

- [ ] **Step 2: Run** `node --test test/jiji-settings.test.js test/jiji-memory.test.js`; expect missing-module FAIL.
- [ ] **Step 3: Implement the store interfaces.** Validate exact keys/types/bounds; use queued read-modify-write so concurrent add/append never loses records; only publish state after rename. Reconcile enabled/allowlisted rooms on restart and prune persisted expiry. Write-failure tests assert rejected operation, unchanged live/disk state, and successful later save. Validate turn timestamps against session updatedAt; reject duplicate session keys.
- [ ] **Step 4: Run** the Step 2 command; expect all PASS. Update README storage contract, retention, backup/recovery and `/ลืม` deletion limitations with a clear feature-in-progress note until wired.
- [ ] **Step 5: Commit** only task files and README: `git commit -m "feat: add bounded persistent Jiji settings and memory"` after staging explicit paths.

### Task 2: Admin settings and forget interactions

**Files:** Create `src/jiji-access.js`, `src/jiji-command.js`, `test/jiji-command.test.js`.

**Interfaces:** Consumes Task 1 stores. `refreshJijiAccess(guild,channelId,userId)->Promise<{channel,requester,bot,canView,canSend,isManager}>` fetches channel, roles, requester, bot fresh; throws on retrieval failure. `jijiCommandData` and `forgetCommandData` define spec commands. `handleJijiCommand(interaction,{guildId,settings,memory,hasApiKey,invalidate})->Promise<void>`. `invalidate({channelId?,userId?})->void` synchronously marks pending operations stale; no fields means all. Invoke before clear/disable/remove work; failed commands may cancel a turn but must report failed persistence.

- [ ] **Step 1: Write failing interaction tests.** Assert exact command names/options/types/default ManageGuild, ephemeral early defer, reject wrong guild/non-manager freshly fetched despite cached privilege, allow multi-room add without enable, enable requires key/valid room, hidden room IDs absent from view. Remove remains possible without channel access. Clear is caller/current-channel only and works while chat disabled; storage failure never reports success. Disable retains list and clears memory; removal clears channel memory; both invalidate first.
- [ ] **Step 2: Run** `node --test test/jiji-command.test.js`; expect missing-module FAIL.
- [ ] **Step 3: Implement interfaces and exact Thai replies.** Busy/tired/greeting copy is pinned in spec; command success replies should state the resulting settings plainly. For persistence failure return `บันทึกการตั้งค่าหรือความจำไม่สำเร็จ กรุณาให้ผู้ดูแลตรวจพื้นที่จัดเก็บของบอต`. Sequentially persist disabled/removed settings then erase memory; startup reconcile repairs interruption. Duplicate add/remove succeed without duplicate entries. Keep `/ลืม` separate from manager-default `/จีจี้`.
- [ ] **Step 4: Run** Step 2; expect PASS. Add command rows/examples and admin access/setup to README with the same in-progress status.
- [ ] **Step 5: Stage explicit task files/README and commit** `feat: add Jiji room controls and conversation reset`.

### Task 3: Shared member reads and approved tools

**Files:** Create `src/member-service.js`, `src/jiji-tools.js`, `test/member-service.test.js`, `test/jiji-tools.test.js`; modify `src/command.js`.

**Interfaces:** `fetchLatestMembers(guild)->Promise<Array<{userId,name,joinedAt}>>` uses full members.fetch and existing selectLatestMembers; no cache fallback. Existing slash handler maps userId/joinedAt to the existing embed builder's id/joinedTimestamp inputs without changing its embed/public behavior. Export `jijiToolDeclarations` for exactly `get_latest_members`, `get_recent_departures`, `activity_help` with empty-object parameter schemas. `createJijiTools({guild,guildId,userId,channelId,departureLog,checkAccess})->{execute(call,{signal})->Promise<ToolResult>}`; `checkAccess()->Promise<boolean>` supplied by Task 5 and checked per execution. Departures return `{userId,name,leftAt}` plus `coverage:'recorded_while_online',reason:'unknown'`.

- [ ] **Step 1: Write failing tests.** Full fetch failure rejects; top10 humans sorted as before; slash still defers and produces prior embed. Unknown names/extra args/prototype-like names reject without reads; tools cannot choose guild/user/channel. Wrong guild/access denied prevents reads; activity_help returns exact guidance and touches no activity log. Departure failure yields operational error, not invented empty history; coverage is present even for empty results.
- [ ] **Step 2: Run** `node --test test/member-service.test.js test/jiji-tools.test.js`; expect missing-module FAIL.
- [ ] **Step 3: Implement interfaces.** Reuse selectors/log.latest(), return only bounded needed fields. Enforce empty plain-object args and an explicit Map dispatcher; no eval/shell/arbitrary Discord method. Errors return local safe categories and the existing clear Thai member/storage failure wording. Leave latest/departure slash access semantics unchanged.
- [ ] **Step 4: Run** Step 2 and `npm test`; expect PASS including all departure persistence/retention/interaction tests. Document two read tools/activity guidance as chat behavior, never as new slash commands.
- [ ] **Step 5: Stage explicit task files/README and commit** `feat: expose approved read-only Jiji tools`.

### Task 4: Gemini transport and tool loop

**Files:** Create `src/gemini-client.js`, `test/gemini-client.test.js`; modify `src/config.js`, `.env.example`; create/extend `test/config.test.js`.

**Interfaces:** `createGeminiClient({apiKey,model='gemini-2.5-flash',fetchImpl=fetch})->{respond({history:Turn[],text:string,tools,signal})->Promise<{text:string,usedTools:boolean}>}`. `tools` is Task 3 executor; declarations imported from Task 3. Config adds `geminiApiKey` (optional undefined) and `geminiModel` while retaining existing required Discord configuration. Export `JIJI_TIRED_MESSAGE` exact spec string.

- [ ] **Step 1: Write failing fake-fetch tests.** Assert key header not URL, fixed Google origin, validated model ID, system persona, history user/model role ordering, no foreign sessions, functions schema, and no grounding/file/search tools. Fixture text → tool call → functionResponse → final text; preserve full returned model content parts including thought signatures when continuing. Assert 3-request/4-call caps, disabled retries, 429/401/5xx/network/timeout, blocked/empty/malformed 200, overlong output handling, and no raw provider body/key in thrown local error. Unknown tool cannot execute.
- [ ] **Step 2: Run** `node --test test/gemini-client.test.js test/config.test.js`; expect FAIL on new exports/config assertions.
- [ ] **Step 3: Implement interfaces with native fetch.** Map bounded local pairs to Gemini contents; POST generateContent with systemInstruction/tools/maxOutputTokens=512. Feed every function result back paired with its name, maintaining original model parts. Count calls before dispatch; over-budget exits safely. Use caller signal on every fetch; no SDK chat/server history, retries, or fallback. Return only public text/usedTools, never raw response. Use a prompt that redirects activity queries via guidance and treats names/tool data as data. Local provider errors carry only category/status; transport never logs.
- [ ] **Step 4: Run** Step 2; expect PASS. Add `GEMINI_API_KEY=` and `GEMINI_MODEL=` (empty values) to example and document key acquisition, default model, free-tier quota/privacy, missing-key behavior/restart in README. Check current official Gemini wire documentation linked in spec before finalizing fixtures.
- [ ] **Step 5: Stage explicit task files/README and commit** `feat: add bounded Gemini chat transport`.

### Task 5: Routing, access and cancellable conversation lifecycle

**Files:** Create `src/jiji-trigger.js`, `src/jiji-chat.js`, `test/jiji-trigger.test.js`, `test/jiji-chat.test.js`.

**Interfaces:** `getJijiPrompt(message,botId,{replyAuthorId}={})->string|null` returns stripped invocation text or null; runtime resolves reply author only if needed, never history text. `createJijiChat({guildId,botId,settings,memory,gemini,departureLog,now=Date.now})->{handleMessage(message)->Promise<void>,invalidate(scope)->void}`; Task 2 consumes invalidate. `handleMessage` owns active/cooldown state and per-scope generation tokens/AbortControllers; access uses Task 2 helper, tools use Task 3 factory.

- [ ] **Step 1: Write failing trigger/lifecycle tests.** Pin leading whitespace/name-prefix, mention anywhere, reply author this bot only, bare greeting, bot/webhook/other guild/DM/thread ignored. Assert allowed enabled rooms, fresh permissions, 5,000 ms boundary and cross-channel same-user in-flight rejection. Test other user's referenced response not in Gemini history. Gemini failure exact tired copy; fetch-member failure Thai operational error; invalidation mid-await no send/save; lock always released. Explicitly test disable/remove/forget during provider call and during memory read, and a save failure after send never claims memory persisted.
- [ ] **Step 2: Run** `node --test test/jiji-trigger.test.js test/jiji-chat.test.js`; expect missing-module FAIL.
- [ ] **Step 3: Implement routing and lifecycle.** Acquire per-user active token before slow work; set 30,000 ms abort deadline before initial permission fetch; race uncancellable calls against it. Recheck generation, settings and access after each await and before send; no send after invalidation. Refresh prior to tool execution. Send typing indication after eligibility. Reply with mentions disabled; bound answer to 2,000 units. Only save successful no-tool turns; perform save through a generation-guarded serialized per-scope mutation so reset cannot resurrect them. Busy/greeting/errors never append. Release lock/timer in finally; current-turn API failures use tired message only while scope remains valid.
- [ ] **Step 4: Run** Step 2; expect PASS. Add examples and public/private, reply isolation, retention, no history scraping and cooldown behavior to README.
- [ ] **Step 5: Stage explicit task files/README and commit** `feat: add scoped Jiji conversation lifecycle`.

### Task 6: Runtime wiring, complete docs, and end-to-end verification

**Files:** Create `src/jiji-runtime.js`, `test/jiji-integration.test.js`; modify `src/index.js`, `scripts/register-commands.js`, README.md, AGENTS.md.

**Interfaces:** `createJijiRuntime({client,guildId,geminiApiKey,geminiModel,departureLog,settingsPath,memoryPath,fetchImpl,now})->Promise<{handleMessage,handleInteraction,close}>` opens/reconciles stores, constructs chat/provider, owns one-minute prune timer; close clears timer/aborts turns. `handleInteraction` routes Task 2 handlers. Index adds runtime to existing message/interaction wiring; existing activity recording remains independently executed.

- [ ] **Step 1: Write failing integration tests with fake Discord/fetch/temp files.** Manager add→still off→enable→trigger→chat persists→reopen remembers→tool response not stored→forget persists→disable keeps room list. Crash fixture removed settings with stale memory is reconciled; disabled startup erases stale memory. Test blocked Gemini does not interrupt activity persistence, ignored bot messages do not loop, missing key leaves old commands operational, corruption fails startup, and registration patch/post preserves unrelated commands. Inject clocks; never call live APIs.
- [ ] **Step 2: Run** `node --test test/jiji-integration.test.js`; expect missing-module/wiring FAIL.
- [ ] **Step 3: Wire interfaces.** Index adds MessageContent, optional Gemini configuration/runtime, early store open before login, minute prune timer. Keep message activity and chat errors independent; sanitized local categories only. Registration includes both new data exports using existing per-command patch/post. No bulk overwrite.
- [ ] **Step 4: Complete README and AGENTS.md.** Remove feature-in-progress labels only after wiring. Tables list all six new slash paths/options/access, chat triggers/tools, config names, intent addition and why, no new scopes/admin requirements. Exact install steps: local key/model config → Developer Portal Message Content switch → stop → `npm run register` → `npm start` → `/จีจี้ เพิ่ม ห้อง:#chat` → `/จีจี้ เปิด`. Document JSON shapes/expiry/copies/delete distinction, no migrated historical chat, one process/backups/recovery, tool coverage, public replies, free-tier data use, API failure copy and no fallback. AGENTS adds module ownership, generation cancellation, conversation content exception scoped ONLY to new memory store, and tests to run, linking README detail. Existing activity remains metadata-only.
- [ ] **Step 5: Run** `npm test`; expect entire suite PASS. Run `git diff --check`; expect no output. Compare source command schemas, env names and intents against every documentation table. Confirm example env empty and `data/` ignored. Report test totals and pending live checks without claiming server configuration verified.
- [ ] **Step 6: Stage only intended code/tests/docs/example and commit** `feat: integrate Jiji conversation and document setup`.

## Execution handoff and manual acceptance

One feature plan, six dependent tasks; storage/provider/routing are supporting modules rather than independently requested products. Prefer Native execution because interfaces overlap heavily and existing tests are quick; perform one fresh whole-branch review after implementation. Alternatively use a fresh implementer/reviewer per task via subagent-driven-development. No implementation until user reviews the saved plan and chooses execution mode.

Manual acceptance after authorization/setup: real Gemini key/model available in project (never print it); intent enabled; manager/non-manager checks; allowed/forbidden rooms; name/mention/reply; conversation survives restart within 30 minutes; /ลืม and disable cancel pending answer; latest/departure facts match slash outputs; activity only suggests private slash; mentions never ping; API failure yields exact tired copy. Never deliberately consume quota to test exhaustion; use offline fixtures for errors. Pending until actually performed.
