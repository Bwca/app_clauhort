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
