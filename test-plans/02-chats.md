# Plan 02 — Chats and agent membership

Depends on: at least one agent from `01-agents.md` (e.g. `TP-Alice`,
plain, non-YOLO, non-Observer). Create it first if running this plan in
isolation.

## 1. Create a chat

1. Use the sidebar's chat-creation control to make a chat named `TP-Smoke`.
2. **Expected**: it appears in `#chat-list` / `#chats-section`, and
   selecting it shows an empty `#message-list` with `#no-chat-notice` /
   `#empty-state` replaced by the active chat view.

## 2. Add an agent to a chat

1. From `TP-Smoke`, add `TP-Alice` as a member (via the chat topbar or
   agent panel "add to chat" control — `#add-to-chat-check` /
   `#add-to-chat-label` is the equivalent field at agent-creation time; here
   you're doing it post-creation from an existing agent).
2. **Expected**: `TP-Alice` shows in the chat's member list /
   `#chat-topbar`, and its panel entry reflects it's now in `TP-Smoke`.

## 3. One-chat-at-a-time enforcement

1. Create a second chat `TP-Smoke2`.
2. Try to add `TP-Alice` (already in `TP-Smoke`) to `TP-Smoke2` directly.
3. **Expected**: this either isn't offered as an option (already-in-a-chat
   agents excluded from the add picker) or is rejected with a clear
   message — per `CLAUDE.md`, this is enforced at the DB level by a unique
   index (`idx_chat_members_agent`), so it must never silently succeed and
   leave the agent in two chats at once.

## 4. Removing an agent resets its session

1. Remove `TP-Alice` from `TP-Smoke`.
2. Add it to `TP-Smoke2`.
3. Send it a message in `TP-Smoke2` asking "what did we just talk about?"
   (assuming step 2 of this plan or a prior message exchange happened in
   `TP-Smoke` first).
4. **Expected**: per `CLAUDE.md` ("this also resets its Claude session, so
   it starts fresh with no memory of the old chat"), `TP-Alice` should NOT
   recall anything from `TP-Smoke` — it's a genuinely fresh session, not
   just a UI-level history reset.

## 5. Unread indicator

1. With `TP-Smoke2` open and `TP-Alice` a member, send it a message that
   takes a moment to answer (e.g. "count slowly to 5 in words, one per
   line").
2. While it's still responding, switch to a *different* chat (or if only
   one chat exists, create a throwaway second one to switch to).
3. **Expected**: once `TP-Alice`'s reply lands while you're elsewhere, an
   unread dot appears next to `TP-Smoke2` in the sidebar. Switch back —
   dot clears.

## 6. Delete a chat — confirmation required, irreversible

1. Delete `TP-Smoke2` via its delete control.
2. **Expected**: `#confirm-modal` appears (same pattern as agent deletion).
   Cancel once, verify chat still exists and its messages are intact.
   Confirm, verify chat and its message history are gone from the UI.
3. Check any agent that was *only* in `TP-Smoke2` — per the membership
   rules, it should now be free (not shown as belonging to any chat), and
   available to add to another chat without the one-chat-at-a-time
   rejection from step 3.

## Cleanup

Leave `TP-Smoke` and `TP-Alice` (in it) — reused by `03-messaging.md`
onward. Delete anything else created only for this plan (`TP-Smoke2` should
already be gone from step 6).
