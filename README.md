# Clauhort

A multi-agent Claude chat app. Each participant in a conversation is a Claude Code CLI instance running in its own working directory — think MS Teams, but the participants are AI agents.

## How it works

- Create named agents, each with its own working directory and color
- Group multiple agents into a chat — but each agent belongs to only one chat at a time; remove it from a chat to free it up for another (this also resets its Claude session, so it starts fresh with no memory of the old chat)
- Send messages; agents respond in parallel with streaming output, showing a live status of what they're doing (reading a file, running a command, etc.) and how long they've been at it
- Each tool call's real output (command results, diffs, MCP responses) is one click away — collapsed by default so it doesn't clutter the conversation; a reply with several tool calls nests them behind a single "N tool calls" toggle instead of stacking one row per call
- If an agent starts something in the background (e.g. a long-running Bash command) and says it'll let you know once it's done, it actually does — the follow-up lands in the chat on its own when the task finishes, no need to prompt it again
- Getting lost in a busy multi-agent chat? Click an agent's 🔎 in the panel to spotlight it — the message list then shows that agent's messages plus your own that are actually relevant to it (a broadcast, or one that `@mentions` it), not every message you've sent to everyone else too; click again, or the filter bar's **Show all**, to go back to everyone. Resets automatically when you switch chats
- Use `@AgentName` to route a message to a specific agent; no mention = everyone responds — the mention autocomplete and every message header also show an agent's YOLO badge (if any) and working directory, so it's clear who (and where) you're talking to
- Agents can delegate to teammates by writing `@Name` in their reply
- Use `@AgentName /command` (or just `/command` in a chat with only one agent) to invoke one of that agent's real Claude Code skills — typing `/` shows an autocomplete of that agent's available commands, with descriptions
- Interrupt an agent mid-response with the **Stop** button
- Attach images or large pasted text blocks to a message
- Schedule a message for later via the 🕐 button next to Send — pending ones show as a badge count you can open, review, and cancel before they fire
- Agents keep one continuous native Claude session for as long as they're in a chat (auto-chained via `--resume` after their first reply) — copy the `claude --resume <id>` command from the agent panel to continue that session in a terminal
- When an agent's tool call is denied — a path outside its working directory, a Bash command, etc. — a card appears with **Grant** and **Deny** buttons; either one lets the agent continue right away, no need to send a follow-up message
- Enable **YOLO mode** per agent at creation time to skip all permission checks entirely, shown with a 🔥 badge — use with care
- Chats with new activity you haven't seen yet (an agent finished a task while you were elsewhere) show an unread dot in the sidebar
- Hover a reply to copy it as text or as a PNG image
- Deleting a chat or agent asks for confirmation first (irreversible)
- Customize your own display name, message color, and UI language (English/French, Canada) from **Settings** (⚙ icon)

## Stack

- **Backend**: Node.js + Express + `ws` (WebSocket)
- **Frontend**: Plain HTML/CSS/JS (ES modules, no build step)
- **Persistence**: SQLite via Node's built-in `node:sqlite`, at `server/store/data.sqlite3` (auto-created, gitignored) — no native compile step, so no build toolchain (Visual Studio, Xcode CLT, build-essential) required on any platform
- **Agent execution**: Claude Code CLI (`claude --print --input-format=stream-json --output-format=stream-json`)
- **i18n**: `server/public/i18n/` — a small dictionary + lookup engine shared unmodified between the browser and the server

## Requirements

- Node.js 22.13+ (needed for `node:sqlite` without a flag; project uses v24 via nvm — see `.nvmrc`)
- [Claude Code CLI](https://claude.ai/code) installed and authenticated, available on `PATH` as `claude`
- Linux, macOS, or Windows — developed and tested on Linux; Windows-specific path/spawn handling has been audited but not run on an actual Windows machine, so treat it as "should work," not battle-tested

## Setup

```bash
cd server
npm install
node index.js
```

Then open `http://localhost:3001` in your browser.

To use a different port:

```bash
PORT=4000 node index.js
```

A few convenience scripts wrap the common combinations:

```bash
npm start        # node index.js
npm run dev      # node --watch index.js — auto-restarts on file changes
npm run debug    # node index.js, with APP_TRANSCRIPT_LOG and APP_LOG_LEVEL=debug both on
npm run dev:debug # both of the above together
```

Other environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3001` | HTTP/WebSocket port |
| `CLAUDE_BIN` | `claude` (resolved via `PATH`) | Override if `claude` isn't on `PATH` under that name |
| `APP_DB_FILE` | `server/store/data.sqlite3` | Override the SQLite file path (tests use `:memory:`) |
| `APP_LOG_DIR` | `server/logs` | Where structured log files (and, if enabled, per-chat transcripts — see below) are written |
| `APP_LOG_LEVEL` | `info` | Minimum level written to the log file: `debug`, `info`, `warn`, `error`, or `silent` to disable file logging entirely. The console always stays at `info`+ regardless of this setting |
| `APP_TRANSCRIPT_LOG` | unset (off) | Set to any truthy value to enable a separate, plain-text, per-chat transcript log at `<APP_LOG_DIR>/chats/<chatId>.log` — the exact content sent to and received from each agent on every turn, for debugging without needing to `claude --resume` a session in a real terminal. Off by default: unlike the structured log above, this can contain full conversation content |

## Agent options

| Field | Required | Description |
|-------|----------|-------------|
| Name | yes | Display name used for `@mentions` |
| Working Directory | yes | Absolute path — the agent's cwd and default tool-access scope. Directories already used by other agents show up as one-click chips, so adding a second agent to the same project doesn't mean re-browsing to it |
| Resume ID | no | Pass a `--resume` conversation ID to pick up a named Claude session |
| Color | yes | Avatar color |
| YOLO mode | no | Skip all permission checks for this agent (`--dangerously-skip-permissions`) — off by default; can't be changed later, only at creation |
| Observer | no | Never responds to a broadcast message (no `@mention`) — only to an explicit `@mention` — and when it does respond, sees the full chat history instead of the usual recent-message window. For an agent whose job is to quietly watch a busy chat and summarize it later. Off by default; can't be changed later, only at creation |
| Add to current chat | no | Joins the agent to the chat you created it from — an agent belongs to at most one chat at a time |

## E2E tests

Tests use Puppeteer and run against a separate server instance on port 3099.

```bash
cd tests
npm install
npm test
```

Run a single suite directly with `node --test e2e/<file>.test.js` — each file starts/stops its own server, so passing multiple files to `node --test` at once causes them to run concurrently and collide on the shared test port.

## License

MIT
