# Changelog

All notable changes to Clauhort are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

## [1.2.12] - 2026-09-04

### Added
- A per-chat "Auto-continue" toggle (⏳ in the chat topbar, `PATCH /api/chats/:id`) — when on, an agent turn that errors out on Claude's own session-limit message (e.g. "You've hit your session limit · resets 7:20pm (Australia/Darwin)") auto-arms a scheduled `@Agent` "please continue" message for one minute after that reset time, using the same scheduled-message mechanism as the 🕐 panel (visible there, cancelable, survives a restart). Off by default. See `server/services/sessionLimitReset.js` for the timezone-aware reset-time parsing and `maybeScheduleAutoContinue` in `server/ws/handler.js`.

## [1.2.11] - 2026-09-03

### Added
- Each agent message now has an "@" button next to the author's name that inserts `@Name ` into the composer — a quicker way to address a specific agent in a multi-agent chat than typing "@" and picking them off the autocomplete dropdown every time.

## [1.2.10] - 2026-09-03

### Added
- The agent panel now flags an agent with a small blue dot when they've sent a message while the message filter (🔎 spotlight) was focused on someone else — easy to miss a reply otherwise, since a non-spotlighted agent's messages stay hidden in place. Clears the moment that agent gets spotlighted or the filter is cleared.

## [1.2.9] - 2026-09-03

### Added
- The sidebar logo is now clickable — opens the full-size logo in the same lightbox overlay used for message image attachments, instead of only ever showing as a 20px header icon.

## [1.2.8] - 2026-08-31

### Added
- A per-chat "Free agent relay" toggle (🔁 in the chat topbar, `PATCH /api/chats/:id`) — when on, the agent-to-agent delegation relay is no longer capped at one hop: the same agent can be relayed again in a later round for as long as new `@mentions` keep appearing, bounded only by a safety ceiling (`FREE_RELAY_MAX_ROUNDS` in `server/ws/handler.js`, 20 rounds) against a runaway two-agent back-and-forth. Off by default, matching the previous single-hop-only behavior.

## [1.2.7] - 2026-08-31

### Fixed
- The agent-to-agent delegation relay (an agent's reply `@mentioning` a teammate, triggering that teammate once) handed the relayed agent the *original user message* as its turn-trigger content instead of the teammate reply that actually contained the mention — so the relay target would see a final message addressed to someone else, conclude it wasn't for them, and hold instead of engaging with what it was relayed in for. `runAgentsParallel`'s relay call (`server/ws/handler.js`) now groups relay targets by the specific message that mentioned them and uses that message's own content as the trigger.

## [1.2.6] - 2026-08-22

### Added
- The schedule-message modal now has its own content field, pre-filled from whatever's in the composer (or from the message being edited) but editable in place — fixes clicking the 🕐 button before typing anything, which used to open a modal with no way to see or fix the "content required" error it produced on submit.
- Pending scheduled messages can now be edited (✎ button in the scheduled panel) — change the content, attachments, or send time of a message that hasn't fired yet, instead of only being able to cancel and re-create it. Backed by a new `PATCH /api/chats/:id/scheduled-messages/:scheduledId` endpoint.

### Fixed
- Rescheduling a pending message to a new time re-armed its in-memory timer without clearing the previous one first — the old timer would still fire at the original time with the pre-edit content. `armTimer` (`server/services/scheduler.js`) now clears any existing timer for that id before arming the new one.

## [1.2.5] - 2026-08-21

### Added
- A "Grant all" button on a permission-denial card with more than one pending row — grants every still-unresolved row in that card at once instead of clicking "Grant" per row, while individual grant/deny buttons remain available for resolving rows one at a time or mixing grants and denials within the same card.

## [1.2.4] - 2026-08-21

### Fixed
- Switching away from a chat before or while an agent's reply was still streaming, then switching back, showed no sign the reply was in progress — and once it finished, the reply never rendered at all, only resurfacing after another chat switch forced a fresh reload. `streamingEntries` (`server/public/app.js`) only tracked a stream's state while its chat happened to be the active one, and `selectChat` never reconciled with streams still running elsewhere. Streaming state (accumulated text, live status, elapsed timer) is now tracked per-stream regardless of which chat is on screen, and `selectChat` detaches/reattaches the DOM bubble as you switch chats so an in-progress reply picks back up exactly where it left off.

## [1.2.3] - 2026-08-20

### Fixed
- Browser access (`chromeAccess`) was enforced as a single, app-wide singleton — creating or editing a second agent with it enabled returned a 409 conflict. That guard assumed the Claude in Chrome extension only holds one paired connection at a time, but the extension actually bridges through a local WebSocket relay (`ws://localhost:8765`) that scopes each connecting `--chrome` CLI process to its own isolated MCP tab group, so concurrent agents don't steal each other's pairing. Removed the singleton check (`getChromeAccessAgent` in `server/store/db.js`, and both call sites in `server/routes/agents.js`) and the "only one agent app-wide" copy in the UI hint/error strings — any number of agents may now hold browser access at once.

## [1.2.2] - 2026-08-20

### Fixed
- An agent whose turn failed at the CLI level (most commonly an invalid `resumeId` — a stale or hand-typed session ID rejected by `--resume`) rendered a completely empty reply bubble with no error text and no indication anything went wrong, and silently failed the exact same way on every later message. The CLI actually reports this as a well-formed `result` event with `is_error: true` and the real message in `errors`, not a crash — `createTurnAccumulator` (`server/services/agentProcessManager.js`) was treating any `result` event as a successful (if possibly empty) completion. It now recognizes `is_error` and rejects the turn instead, surfacing the CLI's actual error message to the user via the existing `AGENT_STREAM_ERROR` path.
- Two more spots carried the same hyphen-breaking `\w+` mention pattern fixed in 1.2.1, found while fixing it: the client-side spotlight/message-filter mention scan (`extractMentionedAgentIds` in `server/public/app.js`) could show a message under the wrong spotlight filter for a hyphenated-name agent, and the composer's `@`/`/` autocomplete (`updateComposerDropdown`) silently closed the dropdown the moment you typed a hyphen into a mention or an addressed agent's name. Both now match against real agent names / any non-whitespace run instead of `\w`.

## [1.2.1] - 2026-08-19

### Fixed
- `@mention` routing silently broke for any agent name containing a hyphen (or any other non-word character): `@TP-Observer` matched only `@TP`, resolved to no agent, and the message quietly fell back to broadcasting to the whole chat instead of erroring or routing correctly. Found via the new manual test plans in `test-plans/`. `extractMentionedAgents` and `parseSkillInvocation` (`server/services/messageRouter.js`) now match mentions against the chat's actual member names instead of a fixed `\w+` character class, so any character the agent-creation form already allows in a name is mentionable.

## [1.2.0] - 2026-08-18

### Added
- Message search within a chat: a 🔍 button in the chat topbar opens a search bar that queries the chat's full message history (not just the recently loaded window), showing highlighted-match results you can click to jump straight to that message — loading the surrounding context and scrolling/flashing it into view if it isn't already loaded, with a "Back to latest" banner to return to the normal view.

## [1.1.7] - 2026-08-17

### Fixed
- Clicking a sent image attachment opened a new browser tab that stayed permanently blank — Chrome silently blocks top-level navigation of a new tab straight to the `data:` URI attachment images are stored as. Now opens in an in-page lightbox instead.

## [1.1.6] - 2026-08-17

### Added
- A "Restart agent" action in each agent's `⋮` menu, plus its backing `POST /api/agents/:id/restart` route — kills and respawns the agent's persistent CLI process (no chat history lost) so it can pick up state that's only ever read once at spawn time and never refreshed, like a newly-authorized MCP connector, without restarting the whole server.

## [1.1.5] - 2026-08-16

### Fixed
- A built-in Claude Code skill (e.g. `/code-review`) sent right after an agent's process respawned (server restart, or any permission grant/workingDir/YOLO/resumeId change) was no longer recognized as a real skill invocation and silently fell back to plain-chat routing. Found during manual QA of the 1.1.4 feature.

## [1.1.4] - 2026-08-16

### Added
- The composer's `/` autocomplete now also offers an agent's built-in Claude Code skills (e.g. `/code-review`), not just its project-level `.claude/commands/*.md` files — read straight from the agent's own live process, which reports its actual invokable skill set on spawn.

## [1.1.3] - 2026-08-16

### Changed
- The `@mention` autocomplete dropdown now shows an agent's note (if it has one) below its working directory, making it easier to pick the right agent by what it's currently doing.

## [1.1.2] - 2026-08-16

### Changed
- Per-agent panel actions (note, open folder, remove, delete) now live behind a single `⋮` overflow menu instead of five always-reserved icon slots crammed next to the agent's name/directory/note. The filter button stays inline as the one frequently-used action.

## [1.1.1] - 2026-08-15

### Changed
- Editing an agent's note now opens a proper modal instead of an inline textarea cramped into the 240px-wide agent panel.

### Fixed
- The create-agent modal no longer overflows the viewport on smaller screens — its field list now scrolls internally while the header and Cancel/Create buttons stay pinned in view.

## [1.1.0] - 2026-08-15

### Added
- Per-agent note: an optional, freeform reminder of why an agent was created / what it's for, set at creation or added/edited any time from the agent panel (🗒). Purely for the user's own reference — never sent to the CLI or the agent.

## [1.0.2] - 2026-08-15

### Added
- App logo and favicon (browser tab icon, in the sizes/formats browsers expect), generated from a new logo image. The logo also appears next to the app name in the sidebar header.

## [1.0.1] - 2026-08-15

### Added
- Version number displayed in the sidebar header, linking to this changelog.

### Fixed
- Browser-access badge (🌐) now shows in the `@mention` autocomplete dropdown, matching the badge already shown in message headers and the agent panel.

## [1.0.0] - 2026-08-15

Initial release.

### Added
- Multi-agent group chat: each agent is a real, persistent `claude` CLI process running against its own working directory, kept alive across turns so MCP servers and other session state survive between messages.
- `@mention` routing between the user and agents, and agent-to-agent relay (an agent's reply can `@mention` a teammate to bring them into the conversation, depth-capped to prevent loops).
- Observer agents that only respond when explicitly `@mentioned`, catching up on the full chat history rather than the normal recent-message window.
- Scheduled messages, sent automatically at a future time.
- Slash-command invocation of an agent's real Claude Code skills (`@Name /command`).
- Permission flow for tool calls: file-path grants (`Write`/`Edit`/`Read`/`NotebookEdit`) widen the agent's allowed directories, other tool grants (e.g. `Bash`) derive scoped `--allowedTools` patterns; an optional per-agent YOLO mode skips permission checks entirely.
- Optional per-agent browser access via the Claude in Chrome extension (one agent app-wide at a time).
- Chat and agent management: create/rename/delete chats, create/edit/delete agents, add/remove agents from chats.
- Markdown rendering of agent replies, file attachments, and directory browsing for picking an agent's working directory.
- User settings: display name, message color, light/dark theme, and language (English/French, Canada), persisted server-side.
- Structured logging (pino) with daily file rotation, and an opt-in full transcript log for debugging.
- SQLite persistence with a one-time import from a legacy `data.json`, if present.

[Unreleased]: https://github.com/Bwca/app_clauhort/compare/v1.1.1...HEAD
[1.1.1]: https://github.com/Bwca/app_clauhort/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/Bwca/app_clauhort/compare/v1.0.2...v1.1.0
[1.0.2]: https://github.com/Bwca/app_clauhort/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/Bwca/app_clauhort/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Bwca/app_clauhort/releases/tag/v1.0.0
