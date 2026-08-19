# Manual test plans (for a Claude agent to execute)

These are exploratory / UI-driven test plans meant to be **run by a Claude Code
instance** (typically via the `claude-in-chrome` browser tools) against a
live copy of this app. They complement, but don't replace, the automated
suites in `tests/unit/` and `tests/e2e/` — those are the fast, deterministic
regression net; these plans are for a Claude agent to *use the app like a
person would*, notice things automated assertions wouldn't catch (layout
glitches, confusing copy, awkward focus order, a toast that doesn't clear),
and produce a readable report.

## Prerequisites

- App running: `cd server && npm run debug` (debug mode gives you full
  transcript + debug logs to cross-check what the UI showed against what
  actually happened). Default URL: `http://localhost:3001`.
- The `claude` CLI must be installed, authenticated, and on `PATH` — every
  agent you create in these plans spawns a **real** `claude` CLI process.
  These plans deliberately keep prompts short and cheap, but they are not
  free or instant; budget a few seconds of latency per agent turn.
- A scratch working directory for test agents to point at, so nothing here
  touches this repo or anything you care about, e.g.:
  ```bash
  mkdir -p /tmp/clauhort-test-workdir
  ```
  Reuse that same path across plans — the UI remembers recent directories
  as one-click chips.
- Browser automation via the `claude-in-chrome` skill/tools. Load the core
  tool set once at the start of a session:
  `ToolSearch("select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__read_page,mcp__claude-in-chrome__tabs_create_mcp,mcp__claude-in-chrome__tabs_close_mcp,mcp__claude-in-chrome__find,mcp__claude-in-chrome__get_page_text")`

## How to run a plan

1. Open a fresh tab, navigate to the app URL.
2. Work through the plan's numbered steps in order — each step names the
   element to interact with (by `id` where the UI has one) and the expected
   result.
3. Record actual vs. expected for every step. Use ✅ / ❌ / ⚠️ (partial /
   works-but-off) inline as you go rather than only at the end — if context
   gets compacted mid-run, the partial record survives.
4. On ❌ or ⚠️, capture enough to reproduce: a screenshot
   (`mcp__claude-in-chrome__computer` screenshot action), the relevant
   console output (`read_console_messages`), and — since this app logs
   heavily — the matching lines from `server/logs/` (and the transcript log
   under `server/logs/chats/<chatId>.log` if the issue is agent-response
   shaped, since `npm run debug` has transcript logging on).
5. At the end of a plan, write a short summary: pass count, fail list with
   repro steps, anything surprising that isn't a strict pass/fail (rough
   edge, confusing state, slow response).
6. **Clean up** what you created — delete test chats/agents via the UI (both
   ask for confirmation; that confirmation dialog is itself worth checking
   the first time you hit it, see `01-agents.md`). Don't leave the DB full
   of `E2E-*`-style test junk from a manual run.

## Plan index

| Plan | Covers |
|------|--------|
| [`01-agents.md`](01-agents.md) | Agent CRUD: create/edit/delete, working dir picker, YOLO, Observer, Browser-access exclusivity, notes |
| [`02-chats.md`](02-chats.md) | Chat CRUD, agent membership (one-chat-at-a-time), delete confirmation, sidebar unread dots |
| [`03-messaging.md`](03-messaging.md) | Sending messages, broadcast vs `@mention` routing, parallel responses, agent-to-agent delegation relay, spotlight filter |
| [`04-tool-calls-and-permissions.md`](04-tool-calls-and-permissions.md) | Tool-call display/collapsing, permission grant/deny cards, YOLO bypass |
| [`05-attachments-and-scheduling.md`](05-attachments-and-scheduling.md) | Image/text attachments, scheduled messages (create/review/cancel/fire) |
| [`06-slash-commands.md`](06-slash-commands.md) | `/command` autocomplete and invocation, single-agent shorthand |
| [`07-background-and-stop.md`](07-background-and-stop.md) | Unsolicited background-task messages, Stop button mid-response |
| [`08-search.md`](08-search.md) | Message search: highlighting, jump-to-message, per-agent isolation, query escaping |
| [`09-settings-and-i18n.md`](09-settings-and-i18n.md) | Display name/color, theme (incl. pre-paint flash check), locale switch (en-CA/fr-CA) |
| [`10-resume-and-persistence.md`](10-resume-and-persistence.md) | `--resume` continuity, server restart survival, copyable resume command |

Each file is self-contained — you don't need to run them in order, but
`01-agents.md` and `02-chats.md` create the agent/chat that later plans
assume exists, so running those first saves re-deriving setup steps.

## Ground rules

- **Don't reuse IDs across runs carelessly.** Prefix anything you create
  with a recognizable tag, e.g. agent name `TP-Alice`, chat name
  `TP-Smoke`, so it's obvious what's test scaffolding vs. real data if a run
  gets interrupted before cleanup.
- **Keep test-agent prompts trivial and cheap** — e.g. "reply with exactly
  the word `pong`" — unless the plan step specifically needs the agent to
  use a tool (read a file, run a command) to exercise permission/tool-call
  UI.
- **Never point a test agent's working directory at anything you don't want
  touched.** Use the scratch dir from Prerequisites. A YOLO-mode agent in
  particular has unrestricted tool access inside its working directory.
- If a step's expected result depends on internals described in
  `CLAUDE.md` (e.g. preamble sent only on an agent's first-ever turn *in
  this chat*), that's noted in the plan so you know what you're actually
  verifying, not just what button to click.
