# Plan 04 — Tool calls and permission grant/deny

Depends on: chat `TP-Smoke` with a **non-YOLO** agent (`TP-Alice`) whose
working directory is the scratch dir, plus a `TP-Yolo` agent (from
`01-agents.md`) added to a chat (create `TP-Yolo-Chat` for it if it isn't
already in one).

## 1. Tool-call collapsing — single call

1. Ask `TP-Alice`: `Read any one file in your working directory (create a
   throwaway file first if the directory is empty) and tell me its
   contents.`
2. **Expected**: reply shows one collapsed tool-call row; expanding shows
   real file content, not a placeholder.

## 2. Tool-call collapsing — multiple calls nest under one toggle

1. Ask `TP-Alice`: `Run three separate simple Bash commands (e.g. echo
   three different words), one after another, showing each result.`
2. **Expected**: per README, "a reply with several tool calls nests them
   behind a single 'N tool calls' toggle instead of stacking one row per
   call." Confirm the count in the toggle matches the actual number of
   calls, and expanding reveals all of them individually.

## 3. Permission denial — Bash command, deny then grant

1. Ask `TP-Alice` (non-YOLO, default `acceptEdits` mode — Bash isn't
   auto-accepted) to run a Bash command, e.g. `echo hello-permission-test`.
2. **Expected**: a permission card appears in the chat with **Grant** and
   **Deny** buttons, rather than the command silently running.
3. Click **Deny**. **Expected**: the card resolves as denied; per
   `CLAUDE.md`, since the turn already ended, nothing auto-sends until
   *every* row in a multi-denial card is resolved — with only one denied
   row here, confirm whether a synthetic follow-up is sent immediately (it
   should be, since that's "every row resolved" for a single-row card) and
   that `TP-Alice`'s next output acknowledges the denial rather than
   hanging.
4. Repeat with a fresh command, this time click **Grant**.
5. **Expected**: the command actually executes (verify via its output in
   the now-expanded tool call), and a synthetic continue message is sent
   automatically — no need to manually re-prompt.

## 4. Multi-denial card — partial resolution doesn't auto-continue

1. Ask `TP-Alice` to run **two** distinct Bash commands in the same turn
   that would each need a separate permission prompt (e.g. two different
   shell one-liners chained with `&&` — per `CLAUDE.md`, chains get split
   into one pattern per sub-command via `deriveToolPatterns`).
2. **Expected**: a card with two distinct rows to resolve.
3. Resolve only the first row (grant or deny). **Expected**: no synthetic
   follow-up is sent yet — the second row is still pending.
4. Resolve the second row. **Expected**: *now* the synthetic follow-up
   fires, reflecting both resolutions together (`buildContinueMessage`).

## 5. File-path tool grant — widens directory access, not per-file

1. Ask `TP-Alice` to write a new file inside a **subdirectory that doesn't
   exist yet** under the scratch dir, e.g.
   `<scratch>/subdir/new-file.txt`.
2. **Expected**: permission card for a `Write`/`Edit` tool. Grant it.
3. **Expected** (per `CLAUDE.md`: "granting the *containing directory*,
   since `--add-dir` on a file path is silently a no-op"): the grant
   succeeds and the file is created. As a bonus check, ask it to write a
   *second*, different file in the same subdirectory — this should NOT
   need a fresh permission prompt, since the directory grant should cover
   siblings.

## 6. YOLO agent — no permission prompts at all

1. In `TP-Yolo-Chat`, ask `TP-Yolo` to run a Bash command and write a file
   in its working directory (scratch dir).
2. **Expected**: no permission card appears at all — actions execute
   immediately. Confirm the 🔥 badge is visible in the message header for
   this reply (README: "shown with a 🌐/🔥 badge... every message header").

## Cleanup

Delete any files/subdirs your test agents created in the scratch directory
(via shell, not via the agent) so the next run starts clean:
```bash
rm -rf /tmp/clauhort-test-workdir/subdir /tmp/clauhort-test-workdir/*.txt
```
