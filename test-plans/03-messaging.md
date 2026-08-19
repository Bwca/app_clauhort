# Plan 03 — Messaging, mentions, delegation, spotlight

Depends on: chat `TP-Smoke` with agent `TP-Alice` (from `02-chats.md`).
Add a second agent `TP-Bob` (plain, non-observer, non-YOLO, same or
different scratch working dir) to `TP-Smoke` before starting.

## 1. Broadcast message — no mention, both respond

1. In `TP-Smoke`, send: `Everyone reply with just your own name.`
2. **Expected**: both `TP-Alice` and `TP-Bob` respond (in parallel —
   streaming status for both should be visible roughly concurrently, not
   strictly sequential), each showing a live status ("thinking" / tool
   name) before their final text.

## 2. First-turn system preamble (architecture check)

This isn't independently visible in the UI, but you can infer it: on each
agent's *very first* reply in `TP-Smoke`, ask a follow-up "who else is in
this chat with us?" — expect an accurate roster (confirms the preamble with
roster info was sent). This should NOT be re-sent as a full preamble every
turn — a later turn asking the same question should still answer correctly
via ordinary conversation memory, not because it was re-told.

## 3. `@mention` — routes to one agent only

1. Send: `@TP-Alice only you should answer: say "only me".`
2. **Expected**: only `TP-Alice` responds; `TP-Bob` stays idle for this
   message. Check the mention autocomplete while typing — typing `@TP-A`
   should show `TP-Alice` in `#mention-dropdown` with its YOLO/working-dir
   badges if applicable (per README, "the mention autocomplete and every
   message header also show an agent's YOLO badge... and working
   directory").

## 4. Agent-to-agent delegation relay (depth-capped at 1)

1. Send: `@TP-Alice please write a message that says "@TP-Bob can you
   confirm you received this?" and send exactly that.`
2. **Expected**: `TP-Alice` replies with a message containing `@TP-Bob`;
   this should trigger `TP-Bob` to respond once automatically (the relay
   mechanism in `messageRouter.js`'s `extractMentionedAgents`, scanning the
   whole message body per `CLAUDE.md`, not just a trailing line).
3. Now ask `TP-Bob`, in its triggered reply, to further `@mention` a third
   agent — expect this to be depth-capped: verify it does NOT cascade
   endlessly if you set up a mention that could loop (e.g. `TP-Bob`
   mentioning `TP-Alice` back). One extra hop is fine; an infinite relay
   chain is the bug to watch for.

## 5. Mid-message mention position

Per `CLAUDE.md`'s explicit guidance for agent-participants, but also true
for the plain routing UI: send `@TP-Alice hey, quick thing — @TP-Bob can
you also take a look at this?` (mention embedded mid-sentence, not trailing).
**Expected**: both `TP-Alice` and `TP-Bob` respond, since `@Name` anywhere
in the message counts, not just a trailing routing line.

## 6. Spotlight filter (🔎)

1. Click `TP-Alice`'s 🔎 in the agent panel.
2. **Expected**: `#message-list` narrows to `TP-Alice`'s messages plus your
   own messages that are broadcast or `@TP-Alice`-directed — **not**
   messages you sent only to `TP-Bob`. Verify a `@TP-Bob`-only message from
   earlier in this plan is hidden while spotlighted on `TP-Alice`.
3. Click again (or `#message-filter-bar`'s "Show all") — full history
   returns.
4. Switch to a different chat and back (or to `TP-Smoke2` if still around) —
   **expected**: spotlight resets automatically per README ("Resets
   automatically when you switch chats").

## 7. Tool-call and reply UI basics

1. Ask `TP-Alice`, whose working dir is the scratch dir: `List the files in
   your working directory using a tool.`
2. **Expected**: a collapsed tool-call summary appears in the reply
   (collapsed by default per README); expand it and confirm the real
   command/output is shown. (Deeper tool-call + permission behavior is
   covered in `04-tool-calls-and-permissions.md`.)

## 8. Copy reply as text / PNG

1. Hover any agent reply bubble.
2. **Expected**: copy-as-text and copy-as-image controls appear. Try both;
   confirm no console error is thrown (`read_console_messages`) and (for
   text) the clipboard content matches the visible message.

## Cleanup

Leave `TP-Smoke`, `TP-Alice`, `TP-Bob` in place — reused by later plans.
