# Plan 07 — Background completion and Stop

Depends on: chat `TP-Smoke` with `TP-Alice` (working dir = scratch dir).

## 1. Stop button interrupts mid-response

1. Ask `TP-Alice` something that takes a while to stream, e.g. `Write a
   500-word short story, one sentence at a time.`
2. While it's actively streaming, click the **Stop** control.
3. **Expected**: streaming halts promptly (`AGENT_STREAM_END` /
   `STOP_AGENT` per the WS event list in `CLAUDE.md`); the partial reply
   stays visible rather than disappearing; the UI returns to a normal
   ready state (input re-enabled) rather than getting stuck showing a
   "thinking" status forever.
4. Send a fresh, ordinary message afterward. **Expected**: the agent
   responds normally — stopping one turn shouldn't corrupt the session or
   require restarting the agent.

## 2. Background task completion (unsolicited message)

This exercises the CLI's own background-task-completion feature — the
agent kicks off a long-running Bash command in the background, tells you
it'll report back, and then does so *without* you sending another message.

1. Ask `TP-Alice`: `Start a background Bash command that sleeps for about
   20 seconds and then echoes "background task done", and tell me you'll
   let me know when it's finished. Don't wait for it synchronously.`
2. **Expected**: `TP-Alice`'s immediate reply acknowledges starting the
   task and does NOT block waiting the full 20s.
3. Wait ~20-30s without sending anything else.
4. **Expected**: a new message from `TP-Alice` appears on its own,
   reporting the background command's result — per `CLAUDE.md`, this is
   `handleUnsolicitedEvent` surfaced to clients as `AGENT_BACKGROUND_MESSAGE`,
   visually distinguishable from a normal reply to your turn (check
   whether the UI marks it differently, e.g. no corresponding user message
   directly above it).
5. If the chat isn't the active/visible one when this fires, confirm it
   still produces the sidebar unread-dot behavior from `02-chats.md` step 5.

## Cleanup

None beyond the standard chat/agent cleanup at the end of a full run.
