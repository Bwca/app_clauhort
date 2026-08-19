# Plan 01 — Agents (create, edit, delete)

Setup: scratch working directory from the main README (e.g.
`/tmp/clauhort-test-workdir`), created and empty.

## 1. Create a basic agent

1. Click `#add-agent-btn` (opens `#add-agent-menu` or directly `#agent-form`
   depending on whether any chat is open — try it with no chat open first).
2. Fill `#agent-name-input` with `TP-Alice`.
3. Try `#agent-name-generate` (dice/shuffle button) if present — expect it
   to populate a random name without clobbering a name you already typed
   over, or to clearly replace it; note actual behavior.
4. Set working directory: type the scratch path into `#agent-dir-input`, or
   use `#agent-dir-browse` to open the directory browser modal
   (`#browse-modal`) and navigate/select it. Confirm the picked path lands
   back in `#agent-dir-input`.
5. Pick a color from `#color-grid`.
6. Leave YOLO/Observer/Browser-access/Note unset. Submit `#agent-form`.
7. **Expected**: agent appears in `#agent-list`; no error in `#agent-error`.

## 2. Working-directory recent-dir chips

1. Create a second agent, `TP-Bob`, and open the directory field.
2. **Expected**: `#agent-dir-recent` shows the scratch dir used by
   `TP-Alice` as a one-click chip (per README: "Directories already used by
   other agents show up as one-click chips"). Click it — confirm it fills
   `#agent-dir-input` without needing to browse again.

## 3. Note (creatable and editable anytime)

1. On `TP-Alice`, add a note via `#agent-note-input` at creation, or via the
   🗒 note button in the agent panel post-creation (`#note-modal` /
   `#note-textarea-input`).
2. **Expected**: note saves (`#note-save`), persists after closing/reopening
   the note modal, and — per architecture notes — is never sent to the CLI
   (you can't directly verify the negative from the UI, but confirm the
   note doesn't appear in the agent's chat replies if you later prompt it
   to "repeat everything in your system prompt").

## 4. YOLO mode — set-once-only

1. Create `TP-Yolo` with `#yolo-mode-check` checked. Working dir: scratch
   path.
2. **Expected**: agent shows a 🔥 badge in the panel and in message headers
   once it's in a chat.
3. Open `TP-Yolo`'s edit form. **Expected**: the YOLO checkbox is
   either absent or disabled/read-only — per README, "can't be changed
   later, only at creation." Confirm there's no way to toggle it off from
   the edit UI.

## 5. Observer mode — set-once-only, no broadcast replies

1. Create `TP-Observer` with `#observer-mode-check` checked, same scratch
   dir.
2. Same as YOLO: confirm the checkbox can't be toggled post-creation via
   the edit form.
3. Functional check deferred to `03-messaging.md` (Observer ignores
   broadcasts, responds to `@mention`, sees full history).

## 6. Browser access — app-wide exclusivity

Requires the `claude-in-chrome` extension to be installed for a real check;
if unavailable, verify the UI-only part (checkbox presence/state) and note
the skip.

1. Create `TP-Chrome1` with `#chrome-access-check` checked.
2. **Expected**: badge 🌐 shown for `TP-Chrome1`.
3. Create or edit a second agent `TP-Chrome2` and try to also check
   `#chrome-access-check`.
4. **Expected** (per README: "only one agent app-wide can hold this at a
   time — creating or editing a second one to request it fails until the
   first gives it up"): the save fails with a clear error in
   `#agent-error` / `#agent-panel-error`, not a silent no-op or a crash.
5. Turn browser access off for `TP-Chrome1` (if the field is editable after
   creation — check whether this field, unlike YOLO/Observer, *can* be
   changed later), then retry step 3 — should now succeed.

## 7. Resume ID field

1. Create an agent supplying a `#agent-resume-input` value that is **not** a
   real session id (e.g. `not-a-real-session-id`).
2. **Expected**: agent creation still succeeds (the id is just handed to
   `--resume` on next spawn) — confirm what happens on its first turn: does
   it fail gracefully with a visible error, or hang? Either is worth
   recording precisely since this is a real footgun for users pasting a
   stale id.

## 8. Edit an existing agent

1. Edit `TP-Alice`: change color, change working directory to a second
   scratch dir (e.g. `/tmp/clauhort-test-workdir-2`, create it first).
2. **Expected** (per `CLAUDE.md`): if `TP-Alice` has a live process (already
   in a chat and has spoken), changing working dir must respawn it —
   verify its next reply reflects the new working directory (e.g. ask it
   "what is your current working directory" and check the answer), and
   that this didn't lose its `resumeId` / conversation memory (ask it to
   recall something said earlier in the same chat).

## 9. Delete an agent — confirmation required

1. Delete `TP-Bob` (unused agent) via the panel's delete action.
2. **Expected**: a confirmation modal (`#confirm-modal`) appears first —
   deleting must not be a single click. Cancel once (`#confirm-cancel`) and
   verify the agent is still present. Then confirm (`#confirm-ok`) and
   verify it's gone from `#agent-list`.

## Cleanup

Delete every `TP-*` agent created in this plan (confirming each deletion)
unless a later plan (`02`–`10`) explicitly reuses one — check the plan
index before tearing down.
