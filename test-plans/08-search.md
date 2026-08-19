# Plan 08 — Message search

This is the most recently added feature (see `CHANGELOG.md` /
`08-permissions`→`16-message-search.test.js` in the E2E suite for the
automated equivalent) — worth extra scrutiny for UI polish, not just
correctness.

Depends on: chat `TP-Smoke` with `TP-Alice` and `TP-Bob`, with enough
message history to search meaningfully. If needed, generate some: send a
handful of distinct broadcast/mention messages with recognizable unique
words (e.g. `zephyrtoken-one`, `zephyrtoken-two`, ...).

## 1. Open search

1. Click `#search-btn` in the chat topbar.
2. **Expected**: `#search-bar` / `#search-input-row` opens with
   `#search-input` focused, ready to type.

## 2. Basic query and highlighting

1. Type `zephyrtoken` (a substring shared by several messages you seeded).
2. **Expected**: `#search-results` lists matching messages; the matched
   substring is visually highlighted within each result snippet.

## 3. Jump to message

1. Click one search result.
2. **Expected**: the main `#message-list` scrolls to that message,
   `#jumped-banner` appears (per its id) indicating you've jumped out of
   normal scroll position, with `#jumped-banner-back-btn` to return.
3. Click `#jumped-banner-back-btn`. **Expected**: returns to wherever you
   were (or to latest), and the banner clears.

## 4. Per-agent isolation

Per the plan-index description ("per-agent isolation") — verify search
results respect the spotlight/agent-scoping if a spotlight filter is
active (see `03-messaging.md` step 6):
1. Spotlight `TP-Alice`.
2. Search for a term that appears in both a `TP-Alice`-related message and
   a `TP-Bob`-only message.
3. **Expected**: confirm whether search results respect the active
   spotlight (only `TP-Alice`-relevant matches) or intentionally search the
   whole chat regardless of spotlight — either is a valid design, but
   confirm it's *consistent and documented-feeling*, not arbitrary. Note
   the actual behavior precisely since this isn't spelled out in
   `CLAUDE.md`.

## 5. Query escaping / special characters

1. Search for a string containing regex-special characters if the search
   isn't a plain substring match under the hood, e.g. `zephyrtoken.*` or
   `zephyrtoken(one)`.
2. **Expected**: no crash, no regex-injection-style false-positive match
   explosion, no console error. If a literal message actually contains
   `zephyrtoken.*` as text, it should match; otherwise it shouldn't
   spuriously match unrelated messages via unintended regex interpretation.

## 6. Empty / no-match query

1. Search for a nonsense string that matches nothing, e.g.
   `qzxjklunmatched12345`.
2. **Expected**: `#search-results` shows a clear empty state, not a blank
   panel or a lingering spinner.

## 7. Close search

1. Click `#search-close`.
2. **Expected**: search UI closes cleanly, normal message view is
   unaffected, and reopening search starts from a fresh empty query
   (previous query doesn't stick around confusingly, unless that's an
   intentional convenience — note whichever it is).

## Cleanup

None beyond standard end-of-run cleanup.
