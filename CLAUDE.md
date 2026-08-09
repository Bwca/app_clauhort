# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Clauhort: a multi-agent Claude chat app. Each chat participant ("agent") is a real Claude Code CLI instance running `--print --input-format=stream-json --output-format=stream-json` in its own working directory. The user chats with one or more agents at once (like a group chat), agents can respond in parallel, delegate to each other via `@mentions`, and run real Claude Code tools/skills/MCP servers against their own project directory.

- **Backend**: Node.js (ESM, `"type": "module"`) + Express + `ws`
- **Frontend**: Plain HTML/CSS/JS in `server/public/` — ES modules, no build step, no framework
- **Persistence**: SQLite via Node's built-in `node:sqlite` (no native compile step), at `server/store/data.sqlite3` (gitignored, auto-created)
- **i18n**: `server/public/i18n/` — a small dictionary + lookup engine imported unmodified by both the browser (`server/public/`) and the server (`server/i18n/t.js`)

Requires Node 22.13+ (see `.nvmrc` — v22.13.0) and the `claude` CLI installed, authenticated, and on `PATH`.

## Commit workflow

Commit early and often — don't let work pile up into one large, hard-to-review commit. As soon as a self-contained, working piece of a task is done (one function, one file, one route, one test suite), commit it before moving to the next piece, rather than batching the whole task into a single commit at the end.

- Each commit should be small and do exactly one thing — a change someone could review and understand on its own, independent of what comes before or after it.
- Prefer several narrow commits over one broad one, even within a single task (e.g. a new route, its wiring into the router, and its test can each be their own commit).
- Write commit messages that say *why*, not just what, when the reason isn't obvious from the diff itself.
- This repo's own history (`git log`) was built this way — one concern per commit, in dependency order — and later work should keep following that pattern rather than reverting to large batched commits.
- Only commit when the user asks (see the global git safety rules) — this section governs *how* to shape commits once asked, not a standing permission to commit unprompted.

## Commands

```bash
cd server && npm install && node index.js   # run the app — http://localhost:3001
npm run dev                                  # node --watch, auto-restart
npm run debug                                # + CHORUS_TRANSCRIPT_LOG and CHORUS_LOG_LEVEL=debug
npm run dev:debug                            # both together
PORT=4000 node index.js                      # different port
```

Unit tests (plain `node:test`, pure functions, no server/CLI needed):
```bash
node --test tests/unit/                       # all unit tests
node --test tests/unit/parse-responders.test.js  # a single file
```

E2E tests (Puppeteer, drive a real running server on port 3099):
```bash
cd tests && npm install && npm test           # all suites, sequential
node --test e2e/04-messaging.test.js          # a single suite
npm test -- --grep "agent"                    # filter by name substring
```
Each E2E file starts/stops its own server instance and shares port 3099 — never pass multiple E2E files to `node --test` at once, they'll collide on the port. `tests/run.js` already runs them with `concurrency: 1` for this reason.

There is no lint/typecheck script configured (JSDoc types only, no TypeScript build).

Key env vars (see README for the full table): `PORT`, `CLAUDE_BIN` (override the `claude` binary name/path), `CHORUS_DB_FILE` (`:memory:` in tests), `CHORUS_LOG_DIR`, `CHORUS_LOG_LEVEL`, `CHORUS_TRANSCRIPT_LOG` (full per-chat prompt/response logging, off by default).

## Architecture

### Request flow

`server/index.js` wires up Express (`/api/*` REST routes + static `server/public/`) and one `WebSocketServer` at `/ws`. All actual chat traffic — sending a message, streaming a response, granting a permission, stopping an agent — goes over the WebSocket, handled entirely in `server/ws/handler.js`. REST routes (`server/routes/`) only cover CRUD for agents/chats/settings and directory browsing.

### The agent process model (the core mechanism)

Each agent that's currently a member of a chat gets **one persistent `claude` child process**, kept alive across turns (`server/services/agentProcessManager.js`), rather than a fresh spawn per message. This is what lets MCP servers and other expensive-to-establish state survive between turns. Key implications when touching this code:

- CLI flags baked in at spawn time (`--add-dir`, `--dangerously-skip-permissions`/`--permission-mode`, `--allowedTools`, `--resume`) can't change on a live process — anything that changes one of these (a permission grant, a `workingDir`/YOLO/`resumeId` PATCH) must `killAgent()` the process so the *next* turn respawns fresh with updated flags and resumes via `--resume` (no memory lost).
- A process can emit output **unprompted** — the CLI's own background-task-completion feature resuming a finished turn on its own initiative (e.g. a backgrounded Bash command finishing). This is handled via `onBackgroundTurn`/`handleUnsolicitedEvent` and surfaced to clients as `AGENT_BACKGROUND_MESSAGE`, distinct from the normal `AGENT_STREAM_START/CHUNK/END` triggered by an explicit turn.
- An agent belongs to **at most one chat at a time** (enforced by a unique index in SQLite — `idx_chat_members_agent`). Leaving a chat (removed, or the chat deleted) clears its `resumeId` so a later add to a *different* chat starts a genuinely fresh session instead of bleeding context across chats.
- `agentRunner.js` is a thin, stable-contract wrapper (`runAgentStream`) around `agentProcessManager.js`'s `runTurn` — kept so call sites don't need to know about process lifecycle. It also owns permission-pattern derivation (`deriveToolPatterns`, `dedupePermissionDenials`) shared with the WS handler's `GRANT_PERMISSION`/`DENY_PERMISSION` cases.

### Prompting a resumed CLI session correctly

Because each agent is a real resumed Claude session, re-sending full conversation history every turn would be pure duplication — the CLI already remembers its own past turns. `server/ws/handler.js` builds each turn's prompt narrowly:

- `buildSystemPreamble` (identity + roster + @mention routing rules) is sent **once**, only on an agent's first-ever turn *in this chat* — gated on whether the agent has actually spoken in this chat's history, **not** on `resumeId` being set (an agent can be created with a manually-supplied `resumeId` pointing at an unrelated session, so resumeId-gating would skip the introduction it still needs).
- `catchUpMessagesFor` sends only messages the agent doesn't already have via its own session memory — i.e. messages since its own last turn that it wasn't the author of.
- A standalone roster-refresh note goes out whenever there's catch-up content but no full preamble, so a long-dormant agent (e.g. an Observer) doesn't hold a stale membership list while reading catch-up content that references teammates it was never introduced to.
- An **Observer** agent (`agent.isObserver`) never responds to a broadcast (un-@mentioned) message, only an explicit `@mention` — but gets the *full* chat history (`OBSERVER_HISTORY_LIMIT`, not the normal ~20-message window) on the turns it does run, since it may be catching up on a whole day of chat at once.

`@mentions` are parsed by `server/services/messageRouter.js`: `parseResponders` decides who responds to a user message (broadcast to non-observers if nothing's mentioned), `extractMentionedAgents` is used both for that and for the **relay** mechanism (an agent's own reply `@mentioning` a teammate triggers that teammate once, depth-capped at 1 to prevent loops), and `parseSkillInvocation` detects a message that is *entirely* `@Name /command ...` to invoke one of that agent's real Claude Code skills (listed via `server/services/commands.js`, which reads `.claude/commands/*.md` straight off the agent's `workingDir`).

### Permission flow

Agents normally run with `--permission-mode acceptEdits` (or fully unrestricted under YOLO mode, `--dangerously-skip-permissions`, opt-in per agent at creation only). A denied tool call surfaces as a permission card in the UI; granting/denying sends `GRANT_PERMISSION`/`DENY_PERMISSION` over the WS. Two distinct grant mechanisms, kept separate because they authorize different things:
- File-path tools (`Write`/`Edit`/`Read`/`NotebookEdit`) widen `extraAllowedPaths` → `--add-dir` (granting the *containing directory*, since `--add-dir` on a file path is silently a no-op).
- Everything else (`Bash`, etc.) derives `allowedToolPatterns` → `--allowedTools`, with Bash chains (`a && b`, pipes, `;`) split into one pattern per sub-command (`deriveToolPatterns`) so a multi-command denial doesn't accidentally under- or over-grant.

Since a turn already ended by the time a denial is resolved (headless mode can't retry mid-turn), granting/denying auto-sends a synthetic follow-up message once every row in a multi-denial card is resolved (`buildContinueMessage`), not before.

### Persistence (`server/store/db.js`)

Single file owns the whole SQLite schema and every migration. `CREATE TABLE IF NOT EXISTS` only helps brand-new databases — any schema change needs an explicit, idempotent `migrate*()` function run unconditionally at `loadDb()` startup (see the existing `migrate*` functions for the pattern: check via `PRAGMA table_info`/`PRAGMA index_list`, no-op if already applied). A one-time legacy `data.json` → SQLite import runs automatically if a fresh DB is created and an old `data.json` is found alongside it.

### Frontend (`server/public/`)

Single `app.js` (~2500 lines, no bundler) drives the whole UI via plain DOM APIs and the WebSocket protocol defined by `server/ws/handler.js`'s JSDoc event typedefs (`USER_MESSAGE`, `AGENT_STREAM_START/CHUNK/STATUS/END/ERROR`, `AGENT_BACKGROUND_MESSAGE`, `GRANT_PERMISSION`/`DENY_PERMISSION`, `STOP_AGENT`, `MESSAGE_SAVED`, `AGENT_UPDATED`, `SCHEDULED_MESSAGE_FIRED`, `PING`/`PONG`). `markdown.js` wraps the vendored `marked.esm.js` (`server/public/vendor/`) for rendering agent replies. i18n dictionaries (`en-CA.js`, `fr-CA.js`) are plain JS objects looked up through the shared `index.js` engine — add new keys to *both* locale files.

### Logging

`server/logger.js` (pino) — every module gets its own `logger.child({ component: '<name>' })` rather than repeating fields by hand. File logging is structured JSON with daily rotation; console output stays at `info`+ regardless of `CHORUS_LOG_LEVEL`. `server/transcriptLog.js` is separate and off by default (`CHORUS_TRANSCRIPT_LOG`) — the only place full prompt/response content is ever written to disk, since it's a debugging-only, opt-in log distinct from the always-on structured log.
