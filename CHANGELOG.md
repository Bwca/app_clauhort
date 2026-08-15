# Changelog

All notable changes to Clauhort are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added
- Version number displayed in the sidebar header, linking to this changelog.

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

[Unreleased]: https://github.com/Bwca/app_clauhort/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Bwca/app_clauhort/releases/tag/v1.0.0
