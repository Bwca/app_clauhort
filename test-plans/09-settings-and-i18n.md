# Plan 09 — Settings, theme, and i18n

No agent/chat dependency — this plan is UI/settings-only.

## 1. Display name and color

1. Open `#settings-btn` → `#settings-modal`.
2. Change `#settings-display-name-input` to `TP-Tester`, pick a color from
   `#settings-color-grid`. Save (`#settings-save`).
3. **Expected**: your own messages in any chat now show the new name/color
   immediately, without a page reload.
4. Reload the page. **Expected**: settings persisted (server-side per
   `CLAUDE.md`'s settings key-value table, not just `localStorage`) —
   confirm by checking after a hard reload.

## 2. Theme — switch and pre-paint flash check

1. In `#settings-theme-select`, switch to dark (if currently light) and
   save.
2. **Expected**: UI switches immediately, no flash/flicker.
3. **The important check** (per `CLAUDE.md`: theme is cached to
   `localStorage` and applied via an inline pre-paint script in
   `index.html`'s `<head>` specifically so a saved preference doesn't flash
   the wrong theme while `/api/settings` is still loading): hard-reload the
   page (not just SPA navigation) with dark theme saved, and watch closely
   for any flash of light theme before dark applies. This is easiest to
   catch by taking a screenshot immediately after `navigate` returns,
   before the page has had time to settle, or by throttling network in
   devtools if available. Repeat switching back to light and reloading —
   same check for a flash of dark.
4. Switch back to whatever theme you started with when done.

## 3. Locale — English/French Canada

1. Switch `#settings-language-select` to French (fr-CA). Save.
2. **Expected**: UI strings update immediately (buttons, labels, modal
   titles) without needing a reload.
3. Spot-check a handful of surfaces you've touched in earlier plans —
   agent form labels, chat topbar, settings modal itself, confirm dialogs —
   for any string that's still showing raw English or a literal missing-key
   placeholder (e.g. a raw i18n key like `settings.language` instead of
   translated text). Per `CLAUDE.md`, every key must exist in **both**
   `en-CA.js` and `fr-CA.js` — a leftover English string here would
   indicate a key that was added to one but not the other.
4. Switch back to English when done.

## 4. Settings error handling

1. If any settings field has client-side validation (e.g. an empty display
   name), try to save an invalid value.
2. **Expected**: `#settings-error` shows a clear message; the modal doesn't
   silently close or save garbage.

## Cleanup

Restore display name/color/theme/locale to whatever they were before this
plan if you changed them from a real user's existing preferences (skip if
this is a fresh/test-only environment).
