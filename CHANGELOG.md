# Changelog

All notable changes to Clauhort are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

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
