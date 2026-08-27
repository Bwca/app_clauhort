# Test run results — 2026-08-19

## Follow-up — 2026-08-19/20

- **Bug #1 (hyphenated `@mention` routing) — FIXED.** `extractMentionedAgents`
  and `parseSkillInvocation` in `server/services/messageRouter.js` now match
  against the chat's actual member names (longest-first alternation) instead
  of a fixed `\w+` character class. Added regression unit tests
  (`tests/unit/parse-responders.test.js`) and re-verified live against the
  running app: `@TP-Alice` in a two-agent chat now routes to `TP-Alice`
  alone, not a broadcast to both. Full `tests/unit/` (53 tests) and the
  `04-messaging`/`11-slash-commands` E2E suites all still pass. Released in
  `CHANGELOG.md` as 1.2.1.

- **Bug #2 (custom `/command` → "Unknown command") — NOT REPRODUCIBLE,
  no code change.** Re-ran the exact repro (command file created after an
  agent's first turn, agent restarted mid-session, then `@Agent /ping`)
  twice against the currently-installed `claude` CLI (2.1.236) — once via
  raw `--input-format=stream-json` calls, once through the actual running
  app via its REST+WS API — and both times got `"pong"` correctly. The app's
  own routing logic (discovery via `listAgentCommands`, prefix-stripping,
  sending a bare `/command` block) was already correct; the most likely
  explanation is a transient limitation in whatever `claude` CLI build was
  installed when the original test run happened (the CLI auto-updates in
  the background), already resolved since. No app code was changed for
  this one — flagging it here in case it resurfaces on a different CLI
  version, in which case the fix belongs upstream in `claude`, not here.

---


Executed against the running app (`npm run debug`, `http://localhost:3001`) via
`claude-in-chrome` browser automation, following the plans in this directory.
Scratch working directory: `/tmp/clauhort-test-workdir` (removed at cleanup,
along with all `TP-*`/`TPCheck*` test agents and chats — the app was left
with no test data and still running in debug mode).

**Coverage**: plans were executed roughly in dependency order (01 → 02 → 03 →
04 → 08 → 09 → 06 → 05), not strictly 01→10, and not every step of every plan
was reached — this was time-boxed given each agent turn is a real `claude`
CLI spawn. Plan 07 (background/stop) and Plan 10 (resume/persistence beyond
what came up incidentally) were not exercised at all this run. See "Not
covered this run" at the bottom for the full gap list.

## Bugs / issues found (ranked by severity)

### 1. HIGH — `@mention` routing silently breaks for agent names containing a hyphen
**Confirmed via code + reproduction + isolation control.**

Root cause: `server/services/messageRouter.js:19` —
```js
const mentionRegex = /@(\w+)/g;
```
`\w` is `[A-Za-z0-9_]` and does not include `-`. `@TP-Observer` only captures
`TP` (stops at the hyphen), which matches no agent, so `extractMentionedAgents`
returns `[]`. `parseResponders` then falls back to its no-mentions-found
broadcast path (`messageRouter.js:44`), **silently** turning a targeted
message into a broadcast — no error, no warning.

**Repro:**
1. Chat with `TP-Yolo` (non-observer), `TP-Observer` (observer), `TPCheck`
   (non-observer, no hyphen).
2. Sent `@TP-Observer reply with just the word: observed` (via the mention
   autocomplete).
3. Expected: only `TP-Observer` responds.
4. Actual: `TP-Observer` stayed silent (observers don't respond to
   broadcasts); `TP-Yolo` — never mentioned — responded instead: *"This
   message is directed at TP-Observer, not me — no response needed from
   me."* The message was broadcast to every non-observer member, not routed.
5. **Control test**: `@TPCheck only you should reply, say: got-it` (no
   hyphen, same chat) worked perfectly — only `TPCheck` responded. This
   isolates the hyphen as the cause, not message formatting or timing.
6. Reproduced again independently in a second chat: `@TP-Alice run this
   bash command...` also triggered `TP-Bob` (hyphenated, unmentioned).

**Impact**: affects `@mention` routing generally, the skill-invocation
parser (`parseSkillInvocation` uses the identical `/^@(\w+)\s+(\/\S.*)$/s`
pattern at `messageRouter.js:83`), and the agent-to-agent delegation relay
(built on the same `extractMentionedAgents`). Any agent named with a
hyphen, space, period, or other non-word character is affected. The failure
is silent (falls back to broadcast, doesn't error), which is the worse
failure mode — a user targeting a hyphenated-name agent unknowingly
broadcasts to the whole chat instead.

**Suggested fix direction**: match against actual member names (e.g. build
an alternation of escaped agent names, longest-first) instead of a fixed
`\w+` character class, or at minimum widen the class to include `-` and
other characters your UI already allows in agent names.

### 2. MEDIUM-HIGH — Custom `/command` invocation fails with "Unknown command", despite correct discovery/routing
**Confirmed reproducible; root cause ambiguous between this app and the
underlying `claude` CLI's headless-mode slash-command support.**

**Repro:**
1. Created `<workdir>/.claude/commands/ping.md` with valid frontmatter
   (`description: Replies with pong`) and body `Reply with exactly the word
   "pong".`.
2. The agent's own `/` autocomplete correctly lists `/ping — Replies with
   pong` (proves the app's `listAgentCommands()` discovery works).
3. Sent `@TPCheck /ping` (exactly `parseSkillInvocation`'s expected shape)
   → reply: `Unknown command: /ping`, in **11ms** (`SENT 23:50:29.271` →
   `RECEIVED 23:50:29.282` in the transcript log) — far too fast for a real
   model turn, strongly suggesting the CLI's own local (non-LLM) command
   dispatcher is answering, not Claude itself.
4. Used the app's own "Restart agent" (kill+respawn) specifically to rule
   out "process spawned before the command file existed" — retried, got the
   **identical** result. Rules out staleness.
5. Confirmed via `server/ws/handler.js:508-514` (and its own code comment)
   that the app's design is to strip the `@Name ` prefix and send the bare
   `/ping` as literal stream-json content, relying on the real CLI's own
   local slash-command parser to take it from there. Everything on the
   app's side (discovery, format-matching, routing to the right agent)
   worked correctly.

**Conclusion**: the failure is downstream of this app's own logic — whether
the installed `claude` CLI's headless `--print --input-format=stream-json`
mode actually executes custom project slash-commands from injected text the
way interactive TTY mode does is unconfirmed and out of scope for this run.
Regardless of which side owns the fix, the **user-facing result today is
that a real custom command is not invocable end-to-end through the chat
UI** — worth the maintainer's attention.

### 3. NOTE — Agents cannot be edited after creation via the UI at all (by design, not a bug)
Checked every angle: an agent's "more actions" menu only offers *Add a
note, Open folder, Restart agent, Remove from chat, Delete agent* — no
edit/pencil affordance anywhere (confirmed via accessibility-tree search,
not just visual inspection). Cross-checked the backend:
`server/routes/agents.js:109`'s `PATCH /api/agents/:id` genuinely supports
`name`/`color`/`workingDir`/`resumeId`/`dangerouslySkipPermissions`/
`isObserver`/`chromeAccess`/`note`, correctly kill+respawns the process
when a baked-in flag changes — but `server/public/app.js` only ever calls
this endpoint for the `note` field. The route's own code comment confirms
this is intentional: *"Not currently reachable from the UI, but this is
live API surface."*

Net effect: **`test-plans/01-agents.md` step 8 ("Edit an existing agent")
cannot be executed as written** — there is no UI path to change a working
directory or color after creation, only at creation time. If this is
intentional (e.g. a deliberately deferred feature), no action needed; if
not, the backend is ready and waiting for a UI.

### 4. ENVIRONMENT CONFOUND — permission grant/deny UI could not be exercised (not an app bug)
Non-YOLO `TP-Alice` ran Bash commands (`echo`, then a chained
`rm && touch && echo`) with **zero** permission prompts, though
`acceptEdits` mode should still prompt for Bash. Root-caused to this test
*machine's* own `~/.claude/settings.json`: `{"permissions": {"defaultMode":
"auto"}}` — a global Auto Mode setting that applies to every `claude` CLI
child process regardless of the app's own `--permission-mode acceptEdits`
flag (confirmed the app does pass that flag correctly,
`agentProcessManager.js:142`). This blocked meaningful testing of
`test-plans/04-tool-calls-and-permissions.md` steps 3–5 and the YOLO-vs-
non-YOLO contrast in step 6. **To genuinely test Plan 04, rerun with a
`HOME`/`CLAUDE_CONFIG_DIR` pointing at a settings.json without
`permissions.defaultMode: auto`.**

## What worked correctly (confirmed pass)

- **Agent creation flow**: name/workdir/note/resumeId/color fields, live
  "Verifying…" working-directory check before create, recent-directory
  chips reusing a path from another agent.
- **YOLO mode**: 🔥 badge shown correctly in panel and message headers; no
  permission prompts (though not a clean differential test — see confound
  #4 above).
- **Observer mode**: correctly silent on broadcast messages; 👁 badge shown.
- **Browser-access exclusivity**: creating a second agent with browser
  access while one already holds it produces a **live inline validation
  error** before submit even — better UX than a bare failed-save.
- **Chat/agent membership exclusivity**: an agent already in a chat is
  correctly excluded from another chat's "+ Add agent" picker.
- **Chat and agent delete confirmations**: both show a clear "can't be
  undone" modal; cancel works; confirm works.
- **Broadcast messaging**: un-mentioned message correctly reaches all
  non-observer members.
- **Mention autocomplete**: opens on `@`, lists members with YOLO/workdir
  info, correctly filters by typed prefix.
- **Agent-to-agent delegation relay**: an agent mentioning a teammate in
  its reply correctly triggers that teammate once; a further mention back
  does not cascade further (depth cap holds) — verified with non-hyphenated
  agent names to avoid bug #1 above muddying the result.
- **Spotlight filter**: correctly narrows the view to one agent's relevant
  messages, shows a "Show all" bar, and auto-resets on chat switch.
- **Tool-call display**: single calls collapse to one row with an accurate
  human-generated summary (e.g. "Remove and recreate permtest.txt file");
  multiple calls in one turn correctly nest behind a single "N tool calls"
  toggle with accurate count.
- **Copy-as-text / copy-as-image** icons appear on hover over a reply
  (presence confirmed, didn't click through to avoid clipboard side
  effects).
- **Message search**: opens focused, highlights matched substrings in
  results, correct match count.
- **Settings — display name & color**: applies immediately and
  **retroactively** re-renders all historical messages under the new
  name/color, not just future ones.
- **Settings — locale (en-CA ⇄ fr-CA)**: applies live with no reload
  needed; spot-checked sidebar, input placeholder, timestamp format
  (switches to 24h "19 h 34" style), and the entire Settings modal itself —
  no untranslated strings found anywhere checked.
- **Slash-command autocomplete**: once an agent is targeted via `@mention`,
  correctly lists that agent's real custom commands (read live from
  `.claude/commands/*.md`) alongside its globally-installed Claude Code
  skills, with descriptions.
- **Scheduled-message modal**: structurally correct (opens, carries the
  composed message through, has a datetime field) — did not complete a
  full schedule → fire → cancel cycle (see gaps below).

## Not covered this run (time-boxed out, not attempted or inconclusive)

- Plan 07 (Stop button, background-task unsolicited messages) — not
  attempted at all.
- Plan 10 (resume-command copy button, server-restart persistence,
  Observer catch-up on a long-dormant chat) — not attempted beyond
  incidentally seeing resume-id chips populate in the agent panel.
- Plan 08.3 (jump-to-message banner) — inconclusive: clicking a search
  result scrolled/highlighted correctly, but no `#jumped-banner` appeared;
  the test chat was short enough that the jump target may never have left
  the visible area, so this doesn't confirm the banner is broken.
- Plan 08.4–08.7 (spotlight+search interaction, regex-escaping, empty
  state, close/reopen) — not attempted.
- Plan 05.1–05.3 (image/large-text attachments), 05.5–05.6 (scheduled
  message review panel, actually letting one fire) — not attempted.
- Plan 06.3–06.5 (single-agent `/command` shorthand, mid-sentence
  command-looking text, unknown-command control case) — not attempted.
- Plan 09.2 (theme pre-paint flash-on-reload check) — not attempted.
- Plan 01.7 (bogus resume-id handling) — not attempted.

## A note on test-agent naming

Every agent in this run was named with a `TP-` prefix per the plans'
convention (`TP-Alice`, `TP-Bob`, etc.) specifically so test data would be
easy to spot and clean up. That naming convention is exactly what surfaced
bug #1 — a happy accident. Future runs should **keep using hyphenated
names** for at least a couple of test agents, since it's the only thing
that exposed this bug.

---

# Test run — 2026-08-20 (second pass)

Server was killed and restarted fresh (`npm run debug`) before this pass,
picking up the messageRouter.js hyphen-mention fix (commit d492dfb). Driven
mostly via direct REST/WS calls against the live server (faster and more
deterministic than clicking through the UI for setup), with the browser
used for anything genuinely UI-specific (Stop button, agent panel, resume
copy, restart). Environment confound from the prior run
(`~/.claude/settings.json` → `permissions.defaultMode: "auto"`, bypassing
the app's own permission-prompt flow) is still in effect and not re-tested.

## Hyphen-mention fix — CONFIRMED HOLDING ✅

`@TP-Alice only you should reply, say exactly: fixed-confirmed` in a chat
with `TP-Alice`/`TP-Bob` produced exactly 1 responder (`TP-Alice`), both via
a direct WS call and reproduced in the actual UI. No regression.

## New bug found

### MEDIUM — an agent with an invalid `resumeId` fails every turn completely silently
**Confirmed via server logs + UI.**

Created an agent with `resumeId: "not-a-real-session-id"` (Plan 01.7's
exact scenario) and sent it an ordinary message. The `claude` CLI child
process gives a clear, actionable stderr error and exits:
```
server/logs/app.1.log:1979 — stderr: "Error: --resume requires a valid
session ID or session title when used with --print. Usage: claude -p
--resume <session-id|title>. Provided value \"not-a-real-session-id\" is
not a UUID and does not match any session title."
server/logs/app.1.log:1980 — "agent process exited", code:1
server/logs/app.1.log:1981 (retry) — same stderr, code:1
```
But the app logs `"turn ended"` right after (line 1981 SENT/turn-ended
sequence) and emits `AGENT_STREAM_END` with `fullText: ""` — no
`AGENT_STREAM_ERROR`, no partial content. In the UI the agent's reply
bubble renders **completely empty**: no text, no "ERROR" badge, no
"Stopped" badge, nothing — the user has zero indication the turn failed,
let alone why. Every subsequent message to that agent silently fails the
same way. Root cause looks like `agentProcessManager.js`'s turn handling
not treating a process that exits non-zero *before emitting any stream-json
`result` event* as an error condition — it just closes out the turn
accumulator with whatever (empty) text it collected. This is a real
footgun: a user who pastes a stale/wrong resume ID at agent-creation time
gets a silently-broken agent with no diagnostic, and (per the already-
documented "agents can't be edited after creation" finding above) the only
fix is deleting and recreating it.

## Newly-covered plans

- **Plan 07 (background-and-stop) — full pass, both steps ✅.** Stop button:
  clicked mid-turn (during "responding..." before any text streamed),
  produced a "Stopped" badge, preserved partial streamed text (a partial
  800-word essay, cut off mid-third-paragraph), and the agent answered
  normally on the next ordinary message afterward — no corruption.
  Background task completion: naturally reproduced (the agent's blind
  `sleep 25 && echo done` was blocked by the sandbox's own tool-use guard,
  it self-corrected to `run_in_background: true`, and a follow-up message
  landed on its own several seconds later) and confirmed via
  `server/logs/app.1.log:1908` — `"msg":"agent reported back on a
  background task unprompted"` — a real unsolicited-turn event, not a
  normal reply.

- **Plan 10 (resume-and-persistence) — full pass, all four steps ✅.**
  10.1: the agent panel's truncated resume-id text is a real "click to
  copy: `claude --resume <id>`" button; copied id verified live in an
  actual terminal (`claude --resume <id> --print "reply with the single
  word: verified"` → `verified`). 10.2: per-turn transcript log shows only
  the new message content is ever sent, never full history (confirmed
  across 5 turns in the same chat). 10.3: killed and restarted the server
  mid-chat — chat/membership/message history all survived (SQLite), and a
  follow-up turn asking the agent to recall its earlier 800-word essay
  topic correctly answered "Lighthouses." after the process respawned via
  `--resume`. 10.4: added an Observer partway through an active chat,
  confirmed it stayed silent on a broadcast (`TP-Alice`/`TP-Bob` both
  replied "present", Observer didn't), then `@mention`ed it for a summary —
  it correctly and accurately summarized the *entire* chat history
  (everything before it joined, by name, correctly attributed) in one
  reply, confirming full-history + accurate roster on a catch-up turn.

- **Plan 06.3–06.5 (slash-command edge cases) — full pass, all three ✅.**
  06.3: bare `/ping` (no `@mention`) in a single-agent chat correctly
  invoked the real skill ("pong"). 06.4: `@TP-Solo can you run /ping for
  me?` (command-looking text embedded mid-sentence, not the entire
  message) correctly was NOT intercepted as a skill invocation — confirmed
  via the transcript log showing the literal, un-stripped text was sent to
  the CLI — and the model chose on its own to run `/ping` via a real tool
  call, still producing "pong" as a natural, expected consequence, not a
  routing bug. 06.5: `@TP-Solo /does-not-exist` got a clear, helpful reply
  ("That skill isn't available — I only have: ping, ...") rather than a
  hang or crash.

## Still not covered

Plan 08.3–08.7 (jump banner / spotlight+search / escaping / empty state /
close-reopen), Plan 05 (attachments, scheduled-message fire/cancel cycle),
Plan 09.2 (theme pre-paint flash-on-reload) — all skipped this pass to
prioritize the gaps explicitly called out in the task (07, 10, 06.3-06.5,
01.7) and the hyphen-fix regression check.

## Summary

This pass: 1 fix confirmed holding, 1 new bug found (documented above with
full log evidence), 12 test steps executed across 3 plans, all 12 passing
except the resumeId-failure discovery. All test agents/chats/scratch dirs
cleaned up; app left running in debug mode with an empty chats/agents list.

---

# Test run — 2026-08-27 (full sweep, all 10 plans)

First **complete** pass through every plan (01→10, run in dependency order:
01/02 first to seed the shared `TP-Smoke`/`TP-Alice`/`TP-Bob` fixture, then
03–09 against it, 10 last since it's the disruptive one). Driven entirely
through the actual browser UI via `claude-in-chrome`, with server logs
(`server/logs/app.1.log`, `server/logs/chats/<id>.log` — `APP_TRANSCRIPT_LOG`
was on) and the REST API used to verify/root-cause every finding, not just
eyeball the UI. `claude` CLI version at the time: **2.1.247**. Scratch dir:
`/tmp/clauhort-test-workdir` (+ a `.claude/commands/ping.md` skill file for
Plan 06), removed at cleanup.

**Coverage**: ~62 test steps across all 10 plans, all steps reached except
Plan 04.3–04.5 (permission grant/deny UI — blocked by an environment
confound, see below, for the third consecutive run) and Plan 01.7's
send-a-message-and-observe-the-failure half (agent was created and its
graceful-creation-succeeds behavior confirmed, but no message was sent to it
before cleanup — see gaps section). Everything else: full pass or a
confirmed, root-caused finding.

## Bugs / issues found (ranked by severity)

### 1. HIGH — Agent-to-agent delegation relay prompts the relayed agent with the wrong message, so it reliably declines to act
**Confirmed via 3 independent reproductions + exact code reference.**

The relay mechanism (an agent's own reply `@mentioning` a teammate triggers
that teammate once — `server/ws/handler.js`'s `handleUserMessage`,
`relaySet`/lines 525–549) does genuinely fire a real turn for the mentioned
agent. But the content sent as that turn's actionable "current message" is
always `originalMessage` — the **original human message**, not the
delegating agent's own reply that actually contains the `@mention`:

```js
// server/ws/handler.js:519-521
const originalMessage = { content, attachments };
const newMessage = skillInvocation ? { content: skillInvocation.command, attachments } : originalMessage;
...
// line 549, the relay call:
await runAgentsParallel([...relaySet.values()], members, chat, originalMessage, wss, relayPriorMessages, userMessage.id);
```

The delegating agent's actual mention-containing reply only appears
passively inside the `[Since you last responded]` catch-up block — the
relayed agent's *final content block* (`buildPromptBlocks` line 466,
`newMessage.content`) is still the human's original message, which was
never addressed to it.

**Repro (three separate occasions, same outcome each time):**
1. `@TP-Alice please write a message that says "@TP-Bob can you confirm you
   received this?" and send exactly that.` — TP-Bob was actually triggered
   as a **direct broadcast responder**, not via relay, because the human
   message itself contains a literal `@TP-Bob` substring (whole-message-body
   scanning, `extractMentionedAgents`, is correct/intentional per
   `CLAUDE.md`) — confounds this specific wording as a relay test, but
   surfaced the same downstream symptom.
2. Retried with wording that avoids a literal `@Bob` in the human message
   (`@TP-Alice please send a message to your teammate Bob using the proper
   mention syntax...`). This time the relay genuinely fired *after*
   TP-Alice's own reply (`@TP-Bob can you confirm you received this?`) —
   confirmed via `server/logs/chats/<id>.log`: TP-Bob's `SENT` block's final
   line is the **human's** original message, not Alice's. TP-Bob replied
   `*No response — this message is addressed to @TP-Alice, not me.*` — a
   *correct* reading of what it was actually shown, but not what the
   relay/delegation feature is supposed to accomplish.
3. Reproduced a third time, incidentally, during Plan 10.4 (Observer
   summary): TP-Observer's own summary reply happened to quote `@TP-Bob` and
   `TP-Alice` by name several times while recapping earlier history — this
   alone was enough to re-trigger the relay and give TP-Bob another
   `No response...` turn on a message that had nothing to do with it. This
   shows the misfire isn't limited to deliberate delegation attempts — any
   agent reply that incidentally contains `@Name` (very likely in any
   reflective/summarizing turn) spends a real turn and produces the same
   confused non-response.

**Impact**: the delegation-relay feature — a core part of this app's
multi-agent design per `CLAUDE.md` — technically fires but essentially never
succeeds at getting the relayed agent to actually engage, because the prompt
structure tells it the actionable message is addressed to someone else. This
also burns a real `claude` CLI turn (cost + latency) for a response that's
functionally a no-op.

**Suggested fix direction**: for a relay-triggered call, use the delegating
agent's own message (the one containing the `@mention`) as `newMessage`
instead of `originalMessage`, or at minimum make the catch-up section
explicit that catch-up content *is* what the relayed agent should act on
when there's no separate "for you" content following it.

### 2. MEDIUM-HIGH — Stop button, under the currently-installed CLI, gets permanently stuck showing a raw internal diagnostic instead of "Stopped"
**Confirmed via UI + exact server log/code trace. Likely a `claude` CLI
version-dependent regression** — the 2026-08-20 pass (CLI 2.1.236) explicitly
confirmed clean "Stopped" behavior with preserved partial text; this pass
(CLI 2.1.247) reproduces a different, broken outcome for the identical UI
action.

**Repro:**
1. Asked `TP-Alice` (non-YOLO) to write a 500-word story one sentence at a
   time; clicked **Stop** while it was actively streaming.
2. `server/logs/app.1.log`: the app sends `SIGINT` (`agentProcessManager.js`,
   "killing process via signal (posix)"), then almost immediately logs
   `"turn errored"` with:
   ```
   Error: Claude reported an error: [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null
   ```
3. Root cause: `agentProcessManager.js`'s turn `handleEvent` (~line 640–660)
   treats **any** `result` event with `is_error: true` as a hard failure via
   its `fail()` path, regardless of whether a stop was already requested on
   this turn (`stopped`/`killForStop()` is tracked separately and loses the
   race — the `result`-event path "already settles the turn" per its own
   code comment, written for genuine CLI-rejected-flag errors, not for a
   diagnostic that is itself a direct, expected side effect of the SIGINT
   the app just sent).
4. **Effect on the UI**: the message bubble permanently shows the raw
   diagnostic string in red as if it were message content, and the turn's
   status badge is stuck on **"Stopping…" forever** — confirmed it never
   resolves even after 10+ seconds and after a completely separate,
   successful follow-up turn on the same agent completes normally.
5. **Session is not corrupted** — immediately asking `TP-Alice` "are you
   still there?" got a normal `"yes"` reply right away, matching the
   previous run's finding that stopping one turn doesn't break the agent.
   Only the stuck bubble/badge from the interrupted turn itself is affected.

**Impact**: every time a user clicks Stop on this CLI version, they're left
with a permanently broken-looking message bubble (raw internal error text,
badge stuck mid-action) even though nothing is actually wrong — a
confusing, unpolished regression in a very commonly-used control.

### 3. MEDIUM — Clicking a search result for an agent hidden by the active spotlight filter silently does nothing visible
**Confirmed via DOM inspection.**

Search intentionally searches the whole chat regardless of the active
spotlight filter (a reasonable design — see "not a bug" section below for
the flip side of this same behavior). But `jumpToMessage`
(`server/public/app.js` ~line 1524) doesn't check or clear the spotlight
filter before scrolling/flashing the target message into view.

**Repro:**
1. Spotlight `TP-Alice` (`Showing only: you + TP-Alice` active).
2. Search `zephyrtoken` — results correctly include a `TP-Bob` message even
   though TP-Bob is currently hidden by the spotlight.
3. Click that TP-Bob result.
4. Search closes; the spotlight filter is **still active**; nothing visibly
   changes. Confirmed via `getComputedStyle`: the target message element
   *does* get `jumpToMessage`'s `highlight-flash` class added correctly, but
   the element itself has `display: none` (hidden by the spotlight filter's
   own CSS), so the flash/scroll is entirely invisible. No error, no
   auto-clearing of spotlight, no "message hidden by filter" notice — from
   the user's perspective, clicking the search result did nothing at all.

**Suggested fix direction**: `jumpToMessage` should clear the active
spotlight (same as the "Show all" button) whenever the target message isn't
part of the current filtered view.

### 4. LOW-MEDIUM — Settings modal silently no-ops on an empty display name, with zero user feedback
**Confirmed via code + live repro.**

```js
// server/public/app.js:2688-2691
async function handleSettingsFormSubmit(e) {
  e.preventDefault();
  const userDisplayName = settingsDisplayNameInput.value.trim();
  if (!userDisplayName) return;
```

Clearing the display name field and clicking Save does **not** show
`#settings-error` (confirmed hidden, empty text, via direct DOM check),
does **not** close the modal, and does **not** save (confirmed via
`GET /api/settings` — the old name was still there). The "don't save
garbage" half of Plan 09.4's expectation holds; the "`#settings-error` shows
a clear message" half does not — the Save button just appears to do
absolutely nothing.

**Suggested fix**: add a `showSettingsError(...)` call (the same helper
already used elsewhere in this function) before the early return.

### 5. LOW — Slash-command autocomplete dropdown doesn't dismiss itself after the command is sent
Sent a bare `/ping` in a single-agent chat; the `/ping — Replies with pong`
suggestion box stayed visually stuck below the composer after the message
was sent and the input cleared, surviving even a click elsewhere on the
page. Only cleared once new text was typed into the input. Cosmetic, but
looks like a lingering-state bug on first glance.

## Not bugs — clarified / re-scoped this pass

- **Plan 01 step 1's premise doesn't hold**: the agent-creation controls
  (`#new-agent-btn` and the "+ Add agent" equivalent) are entirely
  `display: none` when no chat is selected — confirmed via
  `getComputedStyle`, not just visually. There is currently no way to create
  the very first agent without first creating/selecting a chat. Once a chat
  exists, creating a new agent also **auto-adds it as a member of the
  current chat by default** (an "Add to current chat" checkbox, checked by
  default, has to be unchecked to opt out) — this isn't a separate step the
  way `02-chats.md` assumes. Neither is a bug, just worth updating the plan
  text to match actual flow.
- **Plan 01 step 6 (Browser-access exclusivity) is testing behavior the app
  no longer has, on purpose.** Created two agents with `chromeAccess: true`
  simultaneously — both saved successfully (`GET /api/agents` confirms both
  have `chromeAccess: true`). This is **intentional**, not a regression:
  `server/routes/agents.js`'s own doc-comment says *"Multiple agents may
  hold this concurrently — the extension's local bridge (ws://localhost:8765)
  scopes each connecting CLI process to its own tab group"*, and the current
  README says the same ("any number of agents can hold it at once"). The
  *test-plan file* (`01-agents.md` step 6) still describes an old
  single-holder-only design and should be updated/removed rather than
  treated as a spec to satisfy.
- **No UI to edit an agent post-creation** — reconfirmed, same as the
  2026-08-19 run's already-documented note #3 (⋮ menu only offers
  Add-a-note/Open-folder/Restart/Remove-from-chat/Delete-agent). Not new,
  presumably still an intentional deferral.
- **Plan 04.3–04.5 (permission grant/deny UI) blocked again** by this
  machine's own `~/.claude/settings.json` (`permissions.defaultMode:
  "auto"`), the same environment confound documented in both prior runs.
  Third consecutive run this has blocked genuine testing of the
  grant/deny/multi-denial flow — not touched (it's the user's own global
  Claude Code config, not this app's), but worth flagging again since it
  means this UI path has now gone three full test passes without real
  coverage.
- **Plan 08.3 (jump-to-message banner) root-caused, not exercised.**
  `jumpedBanner.hidden = false` only fires inside `jumpToMessage`'s
  "message not already in the loaded DOM" branch (`app.js` ~line 1527–1537),
  which requires a server round-trip to fetch older context. In this run's
  test chat, every message stayed within the already-loaded window (no
  pagination boundary was ever crossed, even scrolled all the way to the
  top), so this code path never ran — confirmed by testing at the very top
  of a 40+-message chat and finding the banner still correctly absent, by
  design. Not a bug; needs a chat large enough to exceed the initial fetch
  window to actually exercise, which this pass didn't construct.
- **Short (non-chip) pasted-text behavior inconclusive** — this run
  simulated paste via synthetic `ClipboardEvent`s (no real OS clipboard
  available in this environment). The large-paste and image-paste code
  paths both call `preventDefault()` and build the attachment chip
  themselves, so synthetic dispatch exercised them fully and correctly. A
  *short* paste relies on the browser's own native default paste behavior
  (no `preventDefault()` needed) to insert plain text — which a
  script-dispatched `ClipboardEvent` does not trigger in Chrome for security
  reasons. Confirmed the text never landed in the input either way; this is
  a limitation of the paste-simulation method, not evidence of an app bug.
- **Plan 08's spotlight/search precedence question (step 4)**: confirmed
  precisely — search results are **not** scoped to the active spotlight, by
  design (searches the whole chat). Consistent, but see bug #3 above for
  the resulting UX gap when combined with spotlight.

## What worked correctly (confirmed pass, not previously covered as thoroughly)

- **Plan 05 in full — attachments and scheduling**, not reached in either
  prior run: image paste → chip → inline render → lightbox → real model
  vision (`"It's a solid red image."`) all correct; large pasted text (5.6KB)
  → chip → full content transmitted (verified via first/last-word echo);
  oversized image (6MB) → clear `"Image too large (max 5MB)"` error, no
  crash. **The brand-new schedule-edit feature** (its own content field,
  `PATCH` reschedule, from this repo's most recent commits) works
  end-to-end: opening Edit pre-fills the existing content/time correctly,
  picking a past time is rejected with `"Pick a time in the future"`,
  saving a new time+content updates both, and — critically — the message
  fires at the **new, edited** time rather than the original one, live-verified
  by waiting for it: confirms the "clear the old timer before re-arming"
  fix (commit `de177bf`) actually holds under a real reschedule.
- **Plan 09 in full — settings/theme/i18n**, previously only spot-checked:
  display name/color change retroactively re-renders every historical
  message (not just future ones) and survives a hard reload (server-side
  persisted, confirmed via `/api/settings`). Theme pre-paint script verified
  in both directions — screenshotting immediately after `navigate()` in both
  a light→dark→reload and dark→light→reload cycle showed the correct theme
  already applied with no flash observed either way. Locale switch to
  fr-CA/back is instant, no reload, and spot-checked across the sidebar, the
  Settings modal itself, the New Agent modal, and message timestamps
  (24h "09 h 56" style) — no untranslated strings or raw i18n keys found
  anywhere.
- **Plan 10 in full**: resume-id copy button verified against a real,
  separate terminal invocation twice (a plain reply, then a
  context-referencing question that correctly recalled in-chat content);
  transcript log confirmed every turn sends only incremental content, never
  a full-history redump; killed and restarted the actual server process
  mid-chat and confirmed full survival (chat, membership, message history)
  plus a `--resume`'d respawn correctly recalling a word ("LIGHTHOUSE")
  that was only ever told to the agent in the pre-restart process; an
  Observer added partway through a long, eventful chat correctly ignored
  two broadcasts and then, on being `@mentioned`, produced an extremely
  detailed and accurate summary of the *entire* session's history by name
  — strong confirmation of `OBSERVER_HISTORY_LIMIT` full-history catch-up.
- Everything already-covered in prior runs and re-checked this pass still
  holds: hyphenated `@mention` routing (fix from 1.2.1, re-verified live),
  broadcast/mention/mid-sentence-mention routing, mention autocomplete,
  spotlight filtering, tool-call single/multi collapsing, one-chat-at-a-time
  enforcement (now via UI exclusion, confirmed precisely), remove-from-chat
  session reset (fresh `resumeId`, no memory bleed), unread dots, delete
  confirmations (agent + chat, cancel and confirm paths), YOLO/Observer/
  Browser-access badges, background-task unsolicited-message mechanism
  (confirmed again via server log), and slash-command discovery/invocation/
  shorthand/unknown-command handling (bug #2 from the 2026-08-19 run
  remains not reproducible on this CLI version, consistent with the
  2026-08-19/20 follow-up note).

## Gaps for a future run

- Plan 04.3–04.5 (permission grant/deny UI) — needs a `HOME`/
  `CLAUDE_CONFIG_DIR` override without `permissions.defaultMode: "auto"` to
  actually exercise; three runs in a row now without coverage.
- Plan 01.7 — agent-creation-with-bogus-resume-id was created and confirmed
  to save successfully, but no message was sent to it before this pass's
  cleanup, so the actual failure-mode behavior wasn't re-observed this time.
  The 2026-08-20 run already thoroughly documented this (agent silently
  fails every turn with an empty reply bubble, no error indication) with
  full log evidence and no related code has changed since — presumed still
  present, but not re-confirmed this pass.
- Plan 08.3's jump-banner code path (needs a chat exceeding the initial
  message-fetch window to actually trigger — see root-cause note above).
- Real clipboard-based short-text paste behavior (this run's synthetic
  `ClipboardEvent`s can't exercise the native-paste-relies-on-browser-default
  code path — needs a real OS clipboard, e.g. `xclip`/`wl-copy`, unavailable
  in this environment).

## Summary

This pass: full sweep across all 10 plans, ~62 steps executed, the large
majority passing cleanly (including two feature areas — Plan 05 scheduling
including the brand-new edit/reschedule flow, and Plan 09 settings/i18n —
getting their first-ever full pass). 5 new findings this run (1 high, 1
medium-high, 1 medium, 2 low/low-medium), all reproduced live and root-caused
to a specific file/line rather than left as loose observations; 0 of the
previously-fixed bugs regressed (hyphen-mention fix and the resumeId-failure
finding both re-confirmed). All `TP-*` test agents and chats deleted (9
agents, 5 chats including the ephemeral cleanup chat), `/tmp/clauhort-test-workdir`
and its `.claude/commands/` skill file removed, and the user-settings
sandbox values (display name, color, locale, theme) restored to their
pre-run defaults. App left running in debug mode (pid unchanged from before
this pass except for one intentional restart in Plan 10.3) with an empty
chats/agents list and default settings.
