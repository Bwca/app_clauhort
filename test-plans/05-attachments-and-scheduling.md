# Plan 05 — Attachments and scheduled messages

Depends on: chat `TP-Smoke` with `TP-Alice`.

## 1. Image attachment

1. In `TP-Smoke`'s `#input-area`, attach an image (paste one, or use
   whatever attach control the UI exposes near `#input-row`).
2. **Expected**: an `#attachment-chips` entry appears showing the image
   (thumbnail or filename). No error in `#attachment-error`.
3. Send the message with a short caption, e.g. `what's in this image?`.
4. **Expected**: the sent message shows the image inline in
   `#message-list`; clicking it opens `#image-lightbox-overlay` /
   `#image-lightbox-img` at full size. `TP-Alice`'s reply should reference
   the actual image content (confirms it was really transmitted to the
   CLI, not dropped).

## 2. Large pasted text block becomes an attachment

1. Paste a very large block of text (a few thousand characters — e.g. a
   long lorem-ipsum blob or a big JSON blurb) into the message input.
2. **Expected**: per README ("Attach images or large pasted text blocks to
   a message"), this should convert into an attachment chip rather than
   filling the input box unreadably. Confirm the threshold behavior: a
   short paste (a sentence) stays inline text; a long one becomes a chip.
   Note the rough size where it switches, if easily observed.
3. Send it; confirm `TP-Alice` receives the full content (ask it to quote
   the first and last few words).

## 3. Attachment error path

1. Try attaching something invalid if the UI allows selecting arbitrary
   files (e.g. a very large image, or an unsupported file type, if there's
   a client-side check).
2. **Expected**: `#attachment-error` shows a clear message, not a silent
   failure or a raw stack trace.

## 4. Schedule a message

1. Click `#schedule-btn` next to Send.
2. **Expected**: `#schedule-modal` opens with `#schedule-form`,
   `#schedule-time-input`, and a message body field.
3. Type a message (`This is a scheduled test message.`) and pick a time a
   couple minutes in the future. Submit (`#schedule-submit`).
4. **Expected**: `#scheduled-btn` / `#scheduled-wrapper` now shows a badge
   count of 1. No error in `#schedule-error`.

## 5. Review and cancel a scheduled message

1. Click `#scheduled-btn` to open `#scheduled-panel`.
2. **Expected**: the pending message is listed with its scheduled time and
   content, plus a cancel control.
3. Cancel it. **Expected**: badge count drops to 0, and it no longer fires
   later (skip to step 6 only if you *don't* cancel a duplicate scheduled
   message you set up for that purpose).

## 6. Let a scheduled message actually fire

1. Schedule a second message ~1 minute out (don't cancel this one).
2. Wait for the scheduled time (use `ScheduleWakeup`/poll rather than a
   long blocking sleep if you're doing this inside an autonomous loop).
3. **Expected**: message appears in `#message-list` at (approximately) the
   scheduled time as if freshly sent, `TP-Alice` responds to it normally,
   and the `#scheduled-btn` badge count drops back down. This corresponds
   to the `SCHEDULED_MESSAGE_FIRED` WS event in `CLAUDE.md`'s event list —
   worth a glance at `read_console_messages` or the debug log for that
   event name to confirm it actually fired server-side and wasn't just a
   client-side timer coincidence.

## Cleanup

Cancel/let-expire any scheduled messages you don't want lingering; no
special file cleanup needed for this plan.
