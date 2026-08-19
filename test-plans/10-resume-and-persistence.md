# Plan 10 — Session resume and persistence

Depends on: chat `TP-Smoke` with `TP-Alice`, with at least one real
exchanged message (so it has a live `resumeId`).

This plan is the most disruptive one (involves restarting the server) —
run it last, and expect to need terminal access alongside the browser.

## 1. Copy the resume command

1. Open `TP-Alice`'s agent panel.
2. **Expected**: a `claude --resume <id>` command is shown, copyable (per
   README: "copy the `claude --resume <id>` command from the agent panel
   to continue that session in a terminal").
3. Copy it and actually run it in a terminal (outside the app) — Bash tool,
   not through the app itself:
   ```bash
   claude --resume <id> --print "reply with the single word: verified"
   ```
4. **Expected**: it responds and demonstrably has the context of the
   in-app conversation (ask it something referencing an earlier in-chat
   exchange) — confirms the id shown in the UI is a real, live session id,
   not a stale or cosmetic value.

## 2. Continuity across turns without re-sending full history

Ask `TP-Alice` something that depends on something said several messages
ago in `TP-Smoke` (not the last message) — per `CLAUDE.md`'s
`catchUpMessagesFor` design, the app should only be sending *new* content
each turn, relying on the CLI's own session memory for the rest.
**Expected**: it answers correctly. (You can't directly observe the prompt
size from the UI, but `APP_TRANSCRIPT_LOG`-enabled debug mode logs exactly
what was sent each turn at `server/logs/chats/<chatId>.log` — inspect it
after this turn and confirm the sent prompt is short/incremental, not the
full conversation re-transmitted.)

## 3. Server restart survives

1. Send `TP-Alice` a message and get a reply.
2. Stop the server (`pkill -f "node index.js"`), then restart it
   (`cd server && npm run debug`).
3. Reload the app in the browser.
4. **Expected**: `TP-Smoke`, its full message history, and `TP-Alice`'s
   membership all persisted (SQLite-backed, not in-memory) — confirm the
   history matches what was there before restart.
5. Send `TP-Alice` a follow-up referencing pre-restart conversation.
   **Expected**: since the process was killed, the *next* turn should
   `--resume` a fresh child process using the persisted `resumeId` — verify
   it still has full context (this is the real point of `--resume`
   persistence: surviving not just page reloads but actual process death).

## 4. Catch-up note for a long-dormant agent (Observer angle)

Requires an Observer agent (`TP-Observer` from `01-agents.md`) added to
`TP-Smoke` partway through, after several messages already exist.

1. Add `TP-Observer` to `TP-Smoke` (assuming it's currently in no chat —
   remove it from elsewhere first if needed).
2. Have `TP-Alice` and the user exchange a few more ordinary broadcast
   messages — `TP-Observer` should NOT respond to any of them (Observer
   ignores broadcasts).
3. Send `@TP-Observer summarize what's happened in this chat so far.`
4. **Expected**: per `CLAUDE.md`, Observer gets the **full** chat history
   (`OBSERVER_HISTORY_LIMIT`, not the ~20-message normal window) on this
   turn, and also — since it's catching up with catch-up content but no
   full preamble on a later turn — should correctly know the other
   participants' names without ever having gotten a "roster refresh" gap.
   Confirm its summary is accurate and it doesn't refer to teammates it
   was never introduced to as unknown/mystery participants.

## Cleanup

Final teardown for the whole plan suite: delete all `TP-*` chats and
agents created across plans 01–10, and remove the scratch working
directory:
```bash
rm -rf /tmp/clauhort-test-workdir /tmp/clauhort-test-workdir-2
```
