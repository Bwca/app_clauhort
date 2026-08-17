/**
 * @fileoverview Clauhort — plain JS frontend.
 * No build step. Talks to the server via REST + WebSocket.
 */

import { DICTS, DEFAULT_LOCALE, translate } from './i18n/index.js';
import { renderMarkdown } from './markdown.js';
import { APP_NAME } from './appName.js';
import { APP_VERSION } from './appVersion.js';

// ─── Types (JSDoc only) ─────────────────────────────────────────────────────

/**
 * @typedef {Object} Agent
 * @property {string} id
 * @property {string} name
 * @property {string} color
 * @property {string} workingDir
 * @property {string} [resumeId] - Optional claude --resume conversation ID
 * @property {boolean} [dangerouslySkipPermissions] - "YOLO mode"
 * @property {boolean} [isObserver] - Never responds to broadcast messages,
 *   only @mentions — sees the full chat history instead of the recent window
 * @property {string} [note] - Freeform reminder for the user, why this agent exists
 * @property {string} createdAt
 */

/**
 * @typedef {Object} Chat
 * @property {string} id
 * @property {string} name
 * @property {string[]} memberAgentIds
 * @property {string} createdAt
 */

/**
 * @typedef {'user'|'agent'} MessageRole
 */

/**
 * @typedef {Object} Attachment
 * @property {string} id
 * @property {'image'|'text'} type
 * @property {string} [mediaType] - MIME type, images only (e.g. "image/png")
 * @property {string} [name] - Filename or a label like "Pasted text #1 (+40 lines)"
 * @property {string} data - Base64 (image) or raw text (text paste)
 * @property {number} [size]
 */

/**
 * @typedef {Object} Message
 * @property {string} id
 * @property {string} chatId
 * @property {MessageRole} role
 * @property {string|null} agentId
 * @property {string} authorName
 * @property {string} content
 * @property {Attachment[]} [attachments]
 * @property {import('../services/agentProcessManager.js').ToolCall[]} [toolCalls]
 * @property {string} createdAt
 */

/**
 * @typedef {Object} ScheduledMessage
 * @property {string} id
 * @property {string} chatId
 * @property {string} content
 * @property {Attachment[]} attachments
 * @property {string} sendAt
 * @property {string} createdAt
 */

/**
 * @typedef {Object} StreamingEntry
 * @property {string} streamId
 * @property {string} agentId
 * @property {string} agentName
 * @property {string} agentColor
 * @property {HTMLElement} el   - The .msg DOM element
 * @property {HTMLElement} body - The .msg-content text node container
 */

// ─── State ──────────────────────────────────────────────────────────────────

/** @type {Agent[]} */
let agents = [];

/** @type {Chat[]} */
let chats = [];

/** @type {string|null} */
let activeChatId = null;

/**
 * Chat IDs with an agent reply the user hasn't seen yet — purely a
 * live-session signal, not persisted server-side or across a reload. An
 * agent message arriving for a chat that isn't the active one adds it here
 * (see onStreamEnd); selecting a chat clears it. Only agent messages count
 * — the user's own messages are inherently already "seen" as they type them.
 * @type {Set<string>}
 */
const unreadChatIds = new Set();

/**
 * Agent IDs currently "spotlighted" via the agent panel's filter toggle —
 * when non-empty, only messages from these agents stay visible, plus the
 * user's own messages that are actually relevant to them: a broadcast (no
 * @mention) or one that @mentions a spotlighted agent. A user message
 * @mentioning someone else entirely (e.g. a private aside to a different
 * teammate) is hidden like anything else unrelated — see
 * isVisibleUnderMessageFilter. Everything hidden (other agents' messages,
 * their streaming bubbles, their permission cards) is hidden in-place rather
 * than re-fetched. Empty = show everything (the default). Resets whenever
 * the active chat changes (see selectChat) — a filter scoped to one chat's
 * roster carrying over to an unrelated chat would be confusing, not
 * convenient.
 * @type {Set<string>}
 */
const messageFilterAgentIds = new Set();

/** @type {string} currently selected color in the create-agent modal */
let selectedColor = '#89b4fa';

/** @type {string} currently selected color in the settings modal's message-color picker */
let selectedUserColor = '#a6adc8';

/** @type {string | null} id of the agent whose note the note modal is currently editing */
let noteEditAgentId = null;

/**
 * @typedef {Object} Settings
 * @property {string} userDisplayName
 * @property {string} userColor - Hex color string, e.g. "#a6adc8"
 * @property {string} locale - UI language, e.g. "en-CA" or "fr-CA"
 * @property {string} theme - UI theme, "dark" or "light"
 */

/** @type {Settings} */
let userSettings = { userDisplayName: 'You', userColor: '#a6adc8', locale: DEFAULT_LOCALE, theme: 'dark' };

/** @type {string} the UI's currently active language */
let currentLocale = DEFAULT_LOCALE;

/**
 * Translates `key` in the current locale, interpolating `params` — see
 * translate() in ./i18n/index.js for the exact lookup/pluralization rules.
 * @param {string} key
 * @param {Record<string, string | number>} [params]
 * @returns {string}
 */
function t(key, params) {
  return translate(DICTS[currentLocale] ?? DICTS[DEFAULT_LOCALE], key, params);
}

/**
 * Applies the current locale to every statically-marked element in the DOM
 * (data-i18n/-placeholder/-title/-html) and syncs <html lang>. Elements whose
 * text is set imperatively elsewhere (e.g. #conn-dot's title, toggled on
 * ws.onopen/onclose) aren't covered here — those call sites call t() directly
 * so a locale switch mid-connection doesn't need a reconnect to take effect.
 */
function applyTranslations() {
  document.documentElement.lang = currentLocale;
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
}

/**
 * Applies `theme` to the document root (style.css keys its light palette off
 * `:root[data-theme="light"]`, dark is the attribute-less default) and
 * caches it in localStorage so a page reload's inline snippet in
 * index.html's `<head>` can apply a saved light preference before first
 * paint, instead of flashing dark (the default) until the async
 * /api/settings fetch in init() resolves and corrects it.
 * @param {string} theme - "dark" or "light"
 * @returns {void}
 */
function applyTheme(theme) {
  if (theme === 'light') document.documentElement.dataset.theme = 'light';
  else delete document.documentElement.dataset.theme;
  localStorage.setItem('theme', theme);
}

// ─── Responsive drawers (narrow viewports) ─────────────────────────────────
// Below the breakpoints in style.css, #sidebar/#agent-panel come out of the
// normal flex layout and become off-canvas panels — CSS handles the actual
// slide animation via the .drawer-open class, this just owns which one (if
// any) is currently open. Only one at a time: opening the other closes
// whichever was open, so the shared backdrop's "click to close" has a single
// unambiguous target instead of needing to track a set.

/** @type {HTMLElement | null} #sidebar or #agent-panel, whichever is currently open as a drawer. */
let openDrawerEl = null;

/**
 * Closes whichever drawer is open, if any. Safe to call unconditionally
 * (e.g. on Escape, or a chat being selected) even when nothing is open.
 * @returns {void}
 */
function closeDrawer() {
  if (!openDrawerEl) return;
  openDrawerEl.classList.remove('drawer-open');
  openDrawerEl = null;
  drawerBackdrop.hidden = true;
}

/**
 * Opens `el` as a drawer, closing any other drawer first (see openDrawerEl's
 * docs) — a no-op re-click on the SAME panel's toggle button closes it
 * instead, handled by toggleDrawer below rather than here.
 * @param {HTMLElement} el
 * @returns {void}
 */
function openDrawer(el) {
  if (openDrawerEl && openDrawerEl !== el) closeDrawer();
  openDrawerEl = el;
  el.classList.add('drawer-open');
  drawerBackdrop.hidden = false;
}

/**
 * Wired to both toggle buttons — clicking the button for the already-open
 * drawer closes it, clicking the other one's switches directly.
 * @param {HTMLElement} el
 * @returns {void}
 */
function toggleDrawer(el) {
  if (openDrawerEl === el) closeDrawer();
  else openDrawer(el);
}

// ─── Contrast-safe agent/user colors ───────────────────────────────────────
// PRESET_COLORS (below) is a fixed set of pastel hexes tuned to read well as
// text/avatar-fill against the DARK theme's near-black --bg0. The light
// theme's --bg0 is near-white, so those same pastels (and any custom hex
// stored before this existed) can land well under WCAG contrast there — the
// exact "agent color barely readable in light mode" bug this section fixes.
// Rather than a second theme-specific palette (which wouldn't help colors
// already saved on existing agents), every render site nudges the stored
// color's LIGHTNESS toward black/white, preserving hue, until it contrasts
// enough against the CURRENT theme's --bg0 — a color already safe (e.g. any
// dark-theme pastel against dark --bg0) round-trips unchanged.

/** Minimum WCAG contrast ratio targeted for agent/user color text and avatar fills. */
const MIN_COLOR_CONTRAST = 4.5;

/**
 * @param {string} hex - "#rrggbb"
 * @returns {{r: number, g: number, b: number}}
 */
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** @param {{r: number, g: number, b: number}} rgb */
function rgbToHex({ r, g, b }) {
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  return '#' + [r, g, b].map((v) => clamp(v).toString(16).padStart(2, '0')).join('');
}

/**
 * WCAG relative luminance (0 = black, 1 = white).
 * @param {{r: number, g: number, b: number}} rgb
 * @returns {number}
 */
function relativeLuminance({ r, g, b }) {
  const [R, G, B] = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

/**
 * WCAG contrast ratio between two hex colors, from 1 (identical) to 21
 * (black vs white).
 * @param {string} hexA
 * @param {string} hexB
 * @returns {number}
 */
function contrastRatio(hexA, hexB) {
  const lA = relativeLuminance(hexToRgb(hexA));
  const lB = relativeLuminance(hexToRgb(hexB));
  const [lighter, darker] = lA >= lB ? [lA, lB] : [lB, lA];
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * @param {{r: number, g: number, b: number}} rgb
 * @returns {{h: number, s: number, l: number}} each in [0, 1]
 */
function rgbToHsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  switch (max) {
    case r: h = (g - b) / d + (g < b ? 6 : 0); break;
    case g: h = (b - r) / d + 2; break;
    default: h = (r - g) / d + 4;
  }
  return { h: h / 6, s, l };
}

/** @param {{h: number, s: number, l: number}} hsl */
function hslToRgb({ h, s, l }) {
  if (s === 0) return { r: l * 255, g: l * 255, b: l * 255 };
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return { r: hue2rgb(p, q, h + 1 / 3) * 255, g: hue2rgb(p, q, h) * 255, b: hue2rgb(p, q, h - 1 / 3) * 255 };
}

/**
 * Returns `hex` unchanged if it already contrasts enough against `bgHex`,
 * otherwise nudges its HSL lightness toward black (if `bgHex` is light) or
 * white (if `bgHex` is dark) — hue and saturation untouched — by the least
 * amount that clears `minRatio`. Binary search over lightness rather than a
 * fixed step: the two theme backgrounds are extreme enough (near-black /
 * near-white) that the darkest/lightest end of the search always clears
 * ordinary text-contrast thresholds, so this always converges.
 * @param {string} hex
 * @param {string} bgHex
 * @param {number} [minRatio]
 * @returns {string}
 */
function ensureContrast(hex, bgHex, minRatio = MIN_COLOR_CONTRAST) {
  if (contrastRatio(hex, bgHex) >= minRatio) return hex;

  const hsl = rgbToHsl(hexToRgb(hex));
  const bgIsLight = relativeLuminance(hexToRgb(bgHex)) > 0.5;
  const passes = (l) => contrastRatio(rgbToHex(hslToRgb({ ...hsl, l })), bgHex) >= minRatio;

  // Light bg: darken toward 0, contrast rises monotonically as l falls, so
  // the passing region is [0, l*] — binary-search for that upper boundary,
  // the least-dark passing lightness. Dark bg: mirror image, lighten toward
  // 1, passing region is [l*, 1], search for its lower boundary.
  let lo, hi;
  if (bgIsLight) {
    lo = 0; // passes (black vs light bg)
    hi = hsl.l; // fails (already established above)
  } else {
    lo = hsl.l; // fails
    hi = 1; // passes (white vs dark bg)
  }
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (passes(mid) === bgIsLight) {
      // bgIsLight: mid passes → it's a valid (and less-dark) new boundary.
      // !bgIsLight: mid fails → still need to go lighter.
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return rgbToHex(hslToRgb({ ...hsl, l: bgIsLight ? lo : hi }));
}

/**
 * Resolves a stored agent/user hex color to what should actually be
 * rendered right now — contrast-corrected (see ensureContrast) against the
 * CURRENT theme's --bg0, which is also the literal background every avatar
 * (.msg-avatar/.agent-avatar/.mention-avatar/.add-menu-avatar) sits on and
 * fills with var(--bg0) text, and a close proxy for the message bubble's own
 * background (--bg0 lightly tinted by the color itself). One reference
 * background covers both roles since each just needs "this color" and
 * "--bg0" to contrast, regardless of which one is foreground vs background.
 * Passed through unchanged if it isn't a plain "#rrggbb" (e.g. the
 * `var(--muted)` fallback for a since-deleted agent — already theme-safe by
 * construction).
 * @param {string} hex
 * @returns {string}
 */
function agentDisplayColor(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  const bg0 = getComputedStyle(document.documentElement).getPropertyValue('--bg0').trim();
  return ensureContrast(hex, bg0);
}

/** @type {Record<string, StreamingEntry>} keyed by streamId */
const streamingEntries = {};

/** @type {Attachment[]} pending attachments for the message currently being composed */
let pendingAttachments = [];

/** @type {ScheduledMessage[]} pending scheduled messages for the active chat */
let pendingScheduledMessages = [];

let pasteTextCounter = 0;

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENTS = 5;
const PASTE_TEXT_CHAR_THRESHOLD = 800;
const PASTE_TEXT_LINE_THRESHOLD = 20;

/** @type {WebSocket|null} */
let ws = null;

let wsBackoff = 1000;
const MAX_BACKOFF = 30_000;

const PRESET_COLORS = [
  '#89b4fa', '#a6e3a1', '#fab387', '#f38ba8',
  '#cba6f7', '#f9e2af', '#89dceb', '#b4befe',
];

const CLA_NAMES = [
  'Claire', 'Clara', 'Clarabelle', 'Clarence', 'Clarissa', 'Clark', 'Clarke',
  'Claude', 'Claudia', 'Claudette', 'Claudio', 'Claudius', 'Clay', 'Clayton',
  'Clancy', 'Clarion', 'Clarity', 'Claybourne',
  'Claudine', 'Claudina', 'Claus', 'Claudie', 'Claudiu', 'Claudell',
  'Claudelle', 'Claudian', 'Clavius', 'Claudel', 'Claudiano', 'Claudino',
];

// ─── DOM refs ───────────────────────────────────────────────────────────────

const $ = /** @param {string} sel */ (sel) => document.querySelector(sel);

const appTitleEl       = $('#app-title');
const appVersionEl     = $('#app-version');
const connDot          = $('#conn-dot');
const chatList         = $('#chat-list');
const newChatBtn       = $('#new-chat-btn');
const newChatForm      = $('#new-chat-form');
const newChatInput     = $('#new-chat-input');
const emptyState       = $('#empty-state');
const chatView         = $('#chat-view');
const chatTopbarName   = $('#chat-topbar-name');
const reconnNotice     = $('#reconnecting-notice');
const sidebarEl        = $('#sidebar');
const sidebarToggleBtn = $('#sidebar-toggle-btn');
const agentPanelEl     = $('#agent-panel');
const agentPanelToggleBtn = $('#agent-panel-toggle-btn');
const drawerBackdrop   = $('#drawer-backdrop');
const messageFilterBar = $('#message-filter-bar');
const messageList      = $('#message-list');
const msgInput         = $('#msg-input');
const scheduleBtn      = $('#schedule-btn');
const sendBtn          = $('#send-btn');
const mentionDropdown  = $('#mention-dropdown');
const scheduledBtn     = $('#scheduled-btn');
const scheduledPanel   = $('#scheduled-panel');
const scheduleOverlay  = $('#schedule-overlay');
const scheduleClose    = $('#schedule-close');
const scheduleForm     = $('#schedule-form');
const scheduleTimeInput = $('#schedule-time-input');
const scheduleError    = $('#schedule-error');
const scheduleCancel   = $('#schedule-cancel');
const scheduleSubmit   = $('#schedule-submit');
const attachmentChips  = $('#attachment-chips');
const attachmentError  = $('#attachment-error');
const inputArea        = $('#input-area');
const agentList        = $('#agent-list');
const agentActions     = $('#agent-actions');
const noChatNotice     = $('#no-chat-notice');
const addAgentBtn      = $('#add-agent-btn');
const addAgentMenu     = $('#add-agent-menu');
const agentPanelError  = $('#agent-panel-error');
const newAgentBtn      = $('#new-agent-btn');
const modalOverlay     = $('#modal-overlay');
const modalClose       = $('#modal-close');
const modalCancel      = $('#modal-cancel');
const agentForm        = $('#agent-form');
const agentNameInput   = $('#agent-name');
const agentNameGenerateBtn = $('#agent-name-generate');
const agentDirInput    = $('#agent-dir');
const agentDirBrowseBtn = $('#agent-dir-browse');
const agentDirRecent   = $('#agent-dir-recent');
const agentDirRecentWrap = $('#agent-dir-recent-wrap');
const agentResumeInput = $('#agent-resume');
const agentNoteInput   = $('#agent-note');
const colorGrid        = $('#color-grid');
const yoloModeCheck    = $('#yolo-mode-check');
const observerModeCheck = $('#observer-mode-check');
const chromeAccessCheck = $('#chrome-access-check');
const addToChatLabel   = $('#add-to-chat-label');
const addToChatCheck   = $('#add-to-chat-check');
const agentError       = $('#agent-error');
const modalSubmit      = $('#modal-submit');
const browseOverlay    = $('#browse-overlay');
const browseClose      = $('#browse-close');
const browsePathInput  = $('#browse-path-input');
const browsePathGo     = $('#browse-path-go');
const browseError      = $('#browse-error');
const browseList       = $('#browse-list');
const browseCancel     = $('#browse-cancel');
const browseSelect     = $('#browse-select');
const noteOverlay      = $('#note-overlay');
const noteHeaderTitle  = $('#note-header-title');
const noteClose        = $('#note-close');
const noteForm         = $('#note-form');
const noteTextarea     = $('#note-textarea');
const noteCancel       = $('#note-cancel');
const confirmOverlay   = $('#confirm-overlay');
const confirmMessage   = $('#confirm-message');
const confirmCancel    = $('#confirm-cancel');
const confirmOk        = $('#confirm-ok');
const settingsBtn      = $('#settings-btn');
const settingsOverlay  = $('#settings-overlay');
const settingsClose    = $('#settings-close');
const settingsCancel   = $('#settings-cancel');
const settingsForm     = $('#settings-form');
const settingsDisplayNameInput = $('#settings-display-name');
const settingsColorGrid = $('#settings-color-grid');
const settingsLanguageSelect = $('#settings-language');
const settingsThemeSelect = $('#settings-theme');
const settingsError    = $('#settings-error');
const settingsSave     = $('#settings-save');

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Returns the short display path (last two segments).
 * @param {string} dir
 * @returns {string}
 */
function shortDir(dir) {
  const parts = dir.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length > 1 ? `…/${parts.slice(-2).join('/')}` : dir;
}

/**
 * Formats an ISO timestamp for display in the message list. Time-only for
 * today (e.g. "2:15 PM") — otherwise the date is included too (e.g. "Aug 2,
 * 2:15 PM", or "Aug 2, 2024, 2:15 PM" once it's from a previous year), so a
 * conversation spanning multiple days doesn't read as "confusing" — every
 * message's own timestamp says which day it's from, not just the time.
 * "Today" is evaluated at call time in the browser's local timezone, so a
 * message rendered before midnight won't retroactively grow a date once
 * it's no longer "today" — same as this app's other live timestamps, not
 * worth a midnight-tick timer to correct.
 * @param {string} iso
 * @returns {string}
 */
function fmtTime(iso) {
  const date = new Date(iso);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString(currentLocale, { hour: '2-digit', minute: '2-digit' });
  }
  const includeYear = date.getFullYear() !== now.getFullYear();
  return date.toLocaleString(currentLocale, {
    month: 'short',
    day: 'numeric',
    ...(includeYear ? { year: 'numeric' } : {}),
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Formats an ISO timestamp for a scheduled message's send time. Unlike
 * fmtTime, always shows the full date — a future send time doesn't have
 * the same "today, so time alone is unambiguous" shortcut a past message's
 * timestamp does.
 * @param {string} iso
 * @returns {string}
 */
function fmtScheduledTime(iso) {
  const date = new Date(iso);
  const includeYear = date.getFullYear() !== new Date().getFullYear();
  return date.toLocaleString(currentLocale, {
    month: 'short',
    day: 'numeric',
    ...(includeYear ? { year: 'numeric' } : {}),
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Finds an agent by ID from the local state.
 * @param {string} id
 * @returns {Agent|undefined}
 */
function agentById(id) {
  return agents.find((a) => a.id === id);
}

/**
 * Returns the active chat object.
 * @returns {Chat|undefined}
 */
function activeChat() {
  return chats.find((c) => c.id === activeChatId);
}

/** @type {((confirmed: boolean) => void) | null} resolver for the in-flight confirmDialog() call, if any */
let pendingConfirmResolve = null;

/**
 * Shows the generic confirmation modal with the given message and resolves
 * once the user picks Cancel (false) or Delete (true). Used to gate
 * irreversible actions (deleting a chat or an agent) behind an explicit step.
 * @param {string} message
 * @returns {Promise<boolean>}
 */
function confirmDialog(message) {
  confirmMessage.textContent = message;
  confirmOverlay.hidden = false;
  return new Promise((resolve) => { pendingConfirmResolve = resolve; });
}

/**
 * Resolves the in-flight confirmDialog() promise and hides the modal.
 * @param {boolean} result
 */
function resolveConfirm(result) {
  confirmOverlay.hidden = true;
  pendingConfirmResolve?.(result);
  pendingConfirmResolve = null;
}

confirmCancel.addEventListener('click', () => resolveConfirm(false));
confirmOk.addEventListener('click', () => resolveConfirm(true));

// ─── WebSocket ──────────────────────────────────────────────────────────────

function connectWs() {
  const url = `ws://${location.host}/ws`;
  ws = new WebSocket(url);

  ws.onopen = () => {
    connDot.classList.add('connected');
    connDot.title = t('conn.connected');
    reconnNotice.hidden = true;
    msgInput.disabled = false;
    sendBtn.disabled = false;
    wsBackoff = 1000;
  };

  ws.onmessage = (ev) => {
    try {
      handleServerEvent(JSON.parse(ev.data));
    } catch { /* ignore malformed */ }
  };

  ws.onclose = () => {
    connDot.classList.remove('connected');
    connDot.title = t('conn.disconnected');
    reconnNotice.hidden = false;
    msgInput.disabled = true;
    sendBtn.disabled = true;
    ws = null;
    setTimeout(() => {
      wsBackoff = Math.min(wsBackoff * 2, MAX_BACKOFF);
      connectWs();
    }, wsBackoff);
  };

  ws.onerror = () => ws.close();
}

/**
 * Sends a USER_MESSAGE over the WebSocket.
 * @param {string} chatId
 * @param {string} content
 * @param {Attachment[]} [attachments]
 */
function sendMessage(chatId, content, attachments = []) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'USER_MESSAGE', chatId, content, attachments }));
  }
}

// ─── Server event handler ────────────────────────────────────────────────────

/**
 * Dispatches a parsed server WebSocket event to the appropriate handler.
 * @param {{ type: string, [key: string]: unknown }} event
 */
function handleServerEvent(event) {
  switch (event.type) {
    case 'MESSAGE_SAVED':
      onMessageSaved(/** @type {Message} */ (event.message));
      break;
    case 'AGENT_STREAM_START':
      onStreamStart(event);
      break;
    case 'AGENT_STREAM_CHUNK':
      onStreamChunk(event);
      break;
    case 'AGENT_STREAM_STATUS':
      onStreamStatus(event);
      break;
    case 'AGENT_STREAM_END':
      onStreamEnd(event);
      break;
    case 'AGENT_STREAM_ERROR':
      onStreamError(event);
      break;
    case 'AGENT_BACKGROUND_MESSAGE':
      onAgentBackgroundMessage(event);
      break;
    case 'AGENT_UPDATED':
      onAgentUpdated(/** @type {Agent} */ (event.agent));
      break;
    case 'SCHEDULED_MESSAGE_FIRED':
      onScheduledMessageFired(/** @type {{ chatId: string, id: string }} */ (event));
      break;
  }
}

/**
 * A scheduled message just fired — the message itself arrives separately
 * via the normal MESSAGE_SAVED/AGENT_STREAM_* events, so this only needs to
 * drop it from the locally-tracked pending list and re-render the panel.
 * @param {{ chatId: string, id: string }} event
 */
function onScheduledMessageFired({ chatId, id }) {
  if (chatId !== activeChatId) return;
  pendingScheduledMessages = pendingScheduledMessages.filter((m) => m.id !== id);
  renderScheduledPanel();
}

/**
 * @param {Message} message
 */
function onMessageSaved(message) {
  if (message.chatId !== activeChatId) return;
  appendMessage(message);
}

/**
 * @param {{ streamId: string, chatId: string, agentId: string, agentName: string, agentColor: string }} event
 */
function onStreamStart({ streamId, chatId, agentId, agentName, agentColor }) {
  if (chatId !== activeChatId) return;
  const el = createStreamingBubble(agentId, agentName, agentColor);
  messageList.appendChild(el);
  scrollToBottom();

  const startedAt = Date.now();
  const elapsedEl = el.querySelector('.msg-elapsed');
  const timerId = setInterval(() => {
    elapsedEl.textContent = t('chat.elapsedSeconds', { seconds: Math.floor((Date.now() - startedAt) / 1000) });
  }, 1000);

  const stopBtn = el.querySelector('.msg-stop-btn');
  stopBtn.addEventListener('click', () => {
    stopAgentStream(streamId);
    stopBtn.disabled = true;
    stopBtn.textContent = t('chat.stoppingLabel');
  });

  streamingEntries[streamId] = {
    streamId,
    agentId,
    agentName,
    agentColor,
    el,
    body: el.querySelector('.msg-content'),
    rawText: '',
    typingEl: el.querySelector('.msg-typing'),
    statusTextEl: el.querySelector('.msg-status-text'),
    elapsedEl,
    timerId,
  };
}

/**
 * Stops an entry's elapsed-time ticker and hides its "responding…"/status
 * row — called once real content starts arriving or the stream ends, so the
 * live status doesn't linger once it's no longer telling the user anything new.
 * @param {{ timerId: number, typingEl: HTMLElement }} entry
 */
function stopStreamStatus(entry) {
  clearInterval(entry.timerId);
  entry.typingEl.hidden = true;
}

/**
 * @param {{ streamId: string, text: string }} event
 */
function onStreamChunk({ streamId, text }) {
  const entry = streamingEntries[streamId];
  if (!entry) return;
  if (text && !entry.typingEl.hidden) stopStreamStatus(entry);
  // Re-rendered from the full accumulated text each time, not patched
  // incrementally — a still-open token (half-typed "**bold", an unclosed
  // code fence) just renders as literal text until its closing token
  // arrives and it snaps into formatting. Cosmetic only, self-correcting.
  entry.rawText += text;
  entry.body.innerHTML = renderMarkdown(entry.rawText);
  scrollToBottom();
}

/**
 * Live "what's happening now" update, parsed server-side from the agent's
 * tool_use calls (e.g. "Reading file.js", "Running: ls") — replaces the
 * static "responding…" placeholder so a long multi-step turn doesn't look stalled.
 * @param {{ streamId: string, status: string }} event
 */
function onStreamStatus({ streamId, status }) {
  const entry = streamingEntries[streamId];
  if (!entry || entry.typingEl.hidden) return;
  entry.statusTextEl.textContent = status;
}

/**
 * @param {{ streamId: string, message: Message, agentId: string,
 *           permissionDenials: import('../services/agentRunner.js').PermissionDenial[],
 *           stopped: boolean }} event
 */
function onStreamEnd({ streamId, chatId, message, agentId, permissionDenials, stopped }) {
  // An agent reply landing in a chat the user isn't currently looking at —
  // flag it unread. Checked unconditionally (not just inside the `if
  // (entry)` block below), since a background chat's stream never got an
  // entry in the first place (onStreamStart bails out early for it too).
  if (chatId !== activeChatId) {
    unreadChatIds.add(chatId);
    renderChatList();
  }

  const entry = streamingEntries[streamId];
  if (entry) {
    clearInterval(entry.timerId);
    const finalEl = buildMessageEl(message);
    entry.el.replaceWith(finalEl);
    delete streamingEntries[streamId];

    // Purely a live-session annotation — not persisted, so it won't reappear
    // after a reload. That's fine: it's just telling the user "this is why
    // the reply cuts off here", not part of the durable record.
    if (stopped) {
      finalEl.querySelector('.msg-meta').insertAdjacentHTML(
        'beforeend',
        `<span class="msg-stopped-badge" data-testid="msg-stopped-badge" title="${t('chat.stoppedTitle')}">⏹ ${t('chat.stoppedLabel')}</span>`
      );
    }

    if (permissionDenials?.length) {
      const card = buildPermissionCard(agentId, chatId, permissionDenials);
      finalEl.after(card);
    }
  }
  scrollToBottom();
}

/**
 * An agent's persistent process resumed and reported on its own — most
 * commonly a backgrounded Bash task finishing — without any new user
 * message to trigger it (see agentProcessManager.js's onBackgroundTurn on
 * the server for the mechanism). Unlike onStreamEnd, there's never an
 * existing streaming bubble to replace here: nothing client-side was
 * watching for this to start, so it always appends fresh.
 * @param {{ chatId: string, agentId: string, message: Message,
 *           permissionDenials: import('../services/agentRunner.js').PermissionDenial[] }} event
 */
function onAgentBackgroundMessage({ chatId, agentId, message, permissionDenials }) {
  if (chatId !== activeChatId) {
    unreadChatIds.add(chatId);
    renderChatList();
    return;
  }
  appendMessage(message);
  if (permissionDenials?.length) {
    const card = buildPermissionCard(agentId, chatId, permissionDenials);
    $(`[data-msg-id="${message.id}"]`)?.after(card);
  }
  scrollToBottom();
}

/**
 * Sends a STOP_AGENT event asking the server to kill the in-flight `claude`
 * process for this stream (SIGTERM) and resolve with whatever partial
 * response it had produced so far, instead of waiting for it to finish
 * on its own — mirrors interrupting a running command in a real terminal.
 * @param {string} streamId
 */
function stopAgentStream(streamId) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'STOP_AGENT', streamId }));
  }
}

/**
 * Handles a server-sent AGENT_UPDATED event — keeps local agent state in sync
 * after a GRANT_PERMISSION is processed.
 * @param {Agent} updatedAgent
 */
function onAgentUpdated(updatedAgent) {
  const idx = agents.findIndex((a) => a.id === updatedAgent.id);
  if (idx !== -1) agents[idx] = updatedAgent;
  renderAgentPanel();
}

/**
 * Opens an agent's working directory in the OS's native file manager.
 * @param {Agent} agent
 * @returns {Promise<void>}
 */
async function openAgentFolder(agent) {
  await fetch(`/api/agents/${agent.id}/open-folder`, { method: 'POST' });
}

/**
 * Kills and respawns an agent's persistent CLI process (no data lost — the
 * next turn `--resume`s). Useful for picking up state a running process
 * only ever reads once at spawn time and never refreshes on its own, like a
 * newly-authorized MCP connector.
 * @param {Agent} agent
 * @returns {Promise<void>}
 */
async function restartAgent(agent) {
  await fetch(`/api/agents/${agent.id}/restart`, { method: 'POST' });
}

/**
 * Copies a ready-to-paste `claude --resume <id>` command to the clipboard so
 * the user can continue an agent's native Claude session in their terminal.
 * @param {Agent} agent
 * @returns {Promise<void>}
 */
async function copySessionCommand(agent) {
  if (!agent.resumeId) return;
  await navigator.clipboard.writeText(`claude --resume ${agent.resumeId}`);
  const btn = document.querySelector(`[data-agent-id="${agent.id}"] .agent-session-btn`);
  if (!btn) return;
  const original = btn.textContent;
  btn.textContent = t('agent.copiedFeedback');
  setTimeout(() => { btn.textContent = original; }, 1200);
}

/**
 * Builds a permission-denial card that lets the user grant access.
 * @param {string} agentId
 * @param {string} chatId
 * @param {import('../services/agentRunner.js').PermissionDenial[]} denials
 * @returns {HTMLElement}
 */
function buildPermissionCard(agentId, chatId, denials) {
  const card = document.createElement('div');
  card.className = 'perm-card';
  card.dataset.testid = 'perm-card';
  card.dataset.agentId = agentId ?? '';
  card.hidden = !isVisibleUnderMessageFilter(agentId);

  const label = document.createElement('p');
  label.className = 'perm-label';
  label.textContent = t('perm.requiredLabel');
  card.appendChild(label);

  // A single turn can carry more than one denial for the exact same
  // tool+command — the model sometimes retries a blocked call itself before
  // giving up and reporting back. Without deduping, that renders two
  // identical rows and the user has to click "Grant" twice for one actual
  // authorization. Keep only the first occurrence of each tool+value pair.
  // Deduped up front (not inline in the render loop below) so the total row
  // count is known before any row is built — needed for the
  // resolve-one-at-a-time tracking right after.
  const seen = new Set();
  const uniqueDenials = [];
  for (const denial of denials) {
    // Display value: a real path for file-scoped tools, the literal command
    // for Bash, a raw JSON dump as a last resort for anything else — this is
    // just what's SHOWN. The value actually sent to grant is the same string;
    // the server (not the client) decides how to turn it into an
    // authorization, since only it knows the CLI's permission-pattern syntax.
    const value = denial.tool_input?.file_path ?? denial.tool_input?.command ?? JSON.stringify(denial.tool_input);
    const key = `${denial.tool_name}::${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueDenials.push({ denial, value });
  }

  // If a turn produced more than one distinct denial, resolving just one of
  // them shouldn't immediately nudge the agent to retry while its siblings
  // in the same card are still pending — that races an auto-continued turn
  // against the user still working through the rest of the card. Only the
  // click that resolves the LAST still-pending row in THIS card tells the
  // server to auto-continue; earlier ones in the same card just persist
  // (grant) or no-op (deny) without triggering anything yet. `outcomes` is
  // indexed to match display order (not click order) and sent in full only
  // on that final click, since the server has no other memory of a denial
  // (nothing is persisted for a deny) — it's the only record of what
  // happened to every row in the card, used to build one combined
  // continuation message covering all of them.
  const totalRows = uniqueDenials.length;
  let resolvedCount = 0;
  /** @type {({ toolName: string, value: string, granted: boolean } | null)[]} */
  const outcomes = new Array(totalRows).fill(null);

  uniqueDenials.forEach(({ denial, value }, idx) => {
    const row = document.createElement('div');
    row.className = 'perm-row';
    row.innerHTML = `
      <span class="perm-tool">${escHtml(denial.tool_name)}</span>
      <span class="perm-path" title="${escHtml(String(value))}">${escHtml(String(value))}</span>
      <button class="perm-deny-btn" data-testid="perm-deny-btn">${t('perm.denyBtn')}</button>
      <button class="perm-grant-btn" data-testid="perm-grant-btn">${t('perm.grantBtn')}</button>`;
    const grantBtn = row.querySelector('.perm-grant-btn');
    const denyBtn = row.querySelector('.perm-deny-btn');
    // A row can only be resolved one way — once either button is clicked,
    // disable both so there's no way to grant-then-deny (or vice versa)
    // the same denial.
    grantBtn.addEventListener('click', () => {
      resolvedCount += 1;
      outcomes[idx] = { toolName: denial.tool_name, value, granted: true };
      const autoContinue = resolvedCount === totalRows;
      grantPermission(agentId, chatId, denial.tool_name, value, autoContinue, autoContinue ? outcomes : undefined);
      grantBtn.textContent = t('perm.grantedBtn');
      grantBtn.disabled = true;
      denyBtn.disabled = true;
    });
    denyBtn.addEventListener('click', () => {
      resolvedCount += 1;
      outcomes[idx] = { toolName: denial.tool_name, value, granted: false };
      const autoContinue = resolvedCount === totalRows;
      denyPermission(agentId, chatId, denial.tool_name, value, autoContinue, autoContinue ? outcomes : undefined);
      denyBtn.textContent = t('perm.deniedBtn');
      denyBtn.disabled = true;
      grantBtn.disabled = true;
    });
    card.appendChild(row);
  });

  return card;
}

/**
 * Sends a GRANT_PERMISSION event to the server for the given agent, tool,
 * and denial value (a file path for file-scoped tools, a raw command
 * string for Bash, etc.) — the server derives the actual authorization
 * mechanism (--add-dir vs. a --allowedTools pattern) from toolName. Only
 * auto-continues the agent's turn when `autoContinue` is true — pass false
 * while sibling denials in the same card are still unresolved, so the
 * agent isn't nudged to retry mid-way through the user working through the
 * rest of the card (see buildPermissionCard's resolvedCount tracking).
 * @param {string} agentId
 * @param {string} chatId
 * @param {string} toolName
 * @param {string} value
 * @param {boolean} autoContinue
 * @param {{ toolName: string, value: string, granted: boolean }[]} [outcomes] -
 *   Every row's resolution in this card, in display order. Only meaningful
 *   (and only ever passed) when autoContinue is true — the server uses it
 *   to build one continuation message covering every outcome, since it has
 *   no other record of a denied row (nothing is persisted for a deny).
 */
function grantPermission(agentId, chatId, toolName, value, autoContinue, outcomes) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'GRANT_PERMISSION', agentId, chatId, toolName, value, autoContinue, outcomes }));
  }
}

/**
 * Sends a DENY_PERMISSION event to the server for the given agent, tool,
 * and denial value — unlike grantPermission, nothing gets persisted (a
 * denial is already the default). Same `autoContinue`/`outcomes` gating as
 * grantPermission: only re-prompts the agent once this was the last
 * pending denial in its card.
 * @param {string} agentId
 * @param {string} chatId
 * @param {string} toolName
 * @param {string} value
 * @param {boolean} autoContinue
 * @param {{ toolName: string, value: string, granted: boolean }[]} [outcomes]
 */
function denyPermission(agentId, chatId, toolName, value, autoContinue, outcomes) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'DENY_PERMISSION', agentId, chatId, toolName, value, autoContinue, outcomes }));
  }
}

/**
 * @param {{ streamId: string, error: string }} event
 */
function onStreamError({ streamId, error }) {
  const entry = streamingEntries[streamId];
  if (entry) {
    stopStreamStatus(entry);
    entry.body.textContent = t('errors.streamErrorPrefix', { error });
    entry.body.style.color = 'var(--red)';
    entry.el.classList.remove('streaming');
    delete streamingEntries[streamId];
  }
}

// ─── DOM rendering ───────────────────────────────────────────────────────────

function scrollToBottom() {
  messageList.scrollTop = messageList.scrollHeight;
}

/**
 * Client-side mirror of server/services/messageRouter.js's
 * extractMentionedAgents — same unanchored `@(\w+)` scan, so a mention
 * counts wherever it sits in the text, matching how the server actually
 * routes it. Kept as a separate small copy rather than sharing a module: the
 * server's version returns Agent objects from its own DB-backed lookup,
 * this one just needs the subset of matching ids for filter comparisons.
 * @param {string} content
 * @param {Agent[]} members
 * @returns {string[]}
 */
function extractMentionedAgentIds(content, members) {
  const mentionRegex = /@(\w+)/g;
  const mentioned = new Set([...content.matchAll(mentionRegex)].map((m) => m[1].toLowerCase()));
  return members.filter((a) => mentioned.has(a.name.toLowerCase())).map((a) => a.id);
}

/**
 * Whether something authored by `agentId` (null for the user's own
 * messages) should be visible under the current message filter. See
 * messageFilterAgentIds's own docs for what "the filter" means.
 *
 * `mentionedIds` only matters for the user's own messages (agentId null) —
 * it's how a message you sent to a DIFFERENT agent gets correctly hidden
 * instead of always tagging along just because you authored it. An agent's
 * own messages ignore it entirely; their visibility is purely "is this
 * agent spotlighted," same as always.
 * @param {string | null} agentId
 * @param {string[]} [mentionedIds] - Agent ids this message @mentions,
 *   pre-resolved at render time (see buildMessageEl). Empty = broadcast.
 * @returns {boolean}
 */
function isVisibleUnderMessageFilter(agentId, mentionedIds = []) {
  if (messageFilterAgentIds.size === 0) return true;
  if (agentId) return messageFilterAgentIds.has(agentId);
  return mentionedIds.length === 0 || mentionedIds.some((id) => messageFilterAgentIds.has(id));
}

/**
 * Re-evaluates every already-rendered message, streaming bubble, and
 * permission card against the current filter — called right after the
 * filter itself changes, since everything up to that point was rendered
 * under the OLD filter state and buildMessageEl/createStreamingBubble/
 * buildPermissionCard only decide visibility once, at creation time. Each
 * of those tags its root element with data-agent-id (empty string for the
 * user's own messages) specifically so this can re-derive the right answer
 * later without keeping a parallel registry in sync. data-mentioned-ids
 * (user messages only — see buildMessageEl) rides along the same way.
 * @returns {void}
 */
function applyMessageFilterToDom() {
  for (const el of messageList.querySelectorAll('[data-agent-id]')) {
    const mentionedIds = el.dataset.mentionedIds ? el.dataset.mentionedIds.split(',') : [];
    el.hidden = !isVisibleUnderMessageFilter(el.dataset.agentId || null, mentionedIds);
  }
}

/**
 * Re-applies agentDisplayColor to every already-rendered message and
 * streaming bubble's --author-color and avatar fill — same data-agent-id
 * scan as applyMessageFilterToDom, for the same reason: buildMessageEl and
 * createStreamingBubble only resolve the contrast-corrected color once, at
 * creation time, so a later theme switch (which moves the contrast target —
 * see agentDisplayColor) or a user color change needs this to bring
 * already-rendered elements back in line without a full re-render.
 * @returns {void}
 */
function refreshAgentDisplayColors() {
  for (const el of messageList.querySelectorAll('[data-agent-id]')) {
    const agentId = el.dataset.agentId || null;
    const rawColor = agentId ? (agentById(agentId)?.color ?? 'var(--muted)') : userSettings.userColor;
    const color = agentDisplayColor(rawColor);
    el.style.setProperty('--author-color', color);
    const avatar = el.querySelector('.msg-avatar');
    if (avatar) avatar.style.background = color;
  }
}

/**
 * Toggles whether `agentId` is spotlighted by the message filter — added if
 * it wasn't in the set, removed if it was. Multiple agents can be
 * spotlighted at once (union, not single-select), so filtering to "Claudio
 * and Dana" is just clicking both of their panel buttons.
 * @param {string} agentId
 * @returns {void}
 */
function toggleMessageFilter(agentId) {
  if (messageFilterAgentIds.has(agentId)) messageFilterAgentIds.delete(agentId);
  else messageFilterAgentIds.add(agentId);
  applyMessageFilterToDom();
  renderAgentPanel();
  renderMessageFilterBar();
}

/**
 * Clears the message filter entirely, back to showing everything.
 * @returns {void}
 */
function clearMessageFilter() {
  if (messageFilterAgentIds.size === 0) return;
  messageFilterAgentIds.clear();
  applyMessageFilterToDom();
  renderAgentPanel();
  renderMessageFilterBar();
}

/**
 * Shows (or hides, when the filter is empty) the banner above the message
 * list naming who's currently spotlighted, with a one-click way to clear it
 * — the filter toggle buttons live in the agent panel, easy to lose track
 * of once you've scrolled away from it, so this is the visible reminder
 * that the message list isn't currently showing everything.
 * @returns {void}
 */
function renderMessageFilterBar() {
  if (messageFilterAgentIds.size === 0) {
    messageFilterBar.hidden = true;
    messageFilterBar.innerHTML = '';
    return;
  }
  const names = [...messageFilterAgentIds].map((id) => agentById(id)?.name).filter(Boolean).join(', ');
  messageFilterBar.hidden = false;
  messageFilterBar.innerHTML = `
    <span data-testid="message-filter-bar-label">${escHtml(t('chat.filterBarLabel', { names }))}</span>
    <button id="message-filter-clear-btn" data-testid="message-filter-clear-btn">${escHtml(t('chat.filterBarClearBtn'))}</button>`;
  messageFilterBar.querySelector('#message-filter-clear-btn').addEventListener('click', clearMessageFilter);
}

/**
 * Creates and returns a DOM element for a completed message.
 * @param {Message} msg
 * @returns {HTMLElement}
 */
function buildMessageEl(msg) {
  const agent = msg.agentId ? agentById(msg.agentId) : null;
  const color = agentDisplayColor(msg.role === 'user' ? userSettings.userColor : (agent?.color ?? 'var(--muted)'));
  const initial = msg.authorName[0].toUpperCase();
  // Only agent replies are real markdown worth rendering — a user typing
  // "*not markdown*" shouldn't have it silently reinterpreted.
  const contentHtml = msg.role === 'agent' ? renderMarkdown(msg.content) : escHtml(msg.content);

  // Only matters for a user message (agentId null) — see
  // isVisibleUnderMessageFilter's docs for why an agent's own messages
  // don't need this at all. Resolved against ALL known agents, not just
  // current chat members: a message can @mention an agent who has since
  // been removed from the chat, and that history shouldn't collapse into
  // looking like a broadcast just because the mention no longer matches
  // anyone currently present.
  const mentionedIds = msg.agentId ? [] : extractMentionedAgentIds(msg.content, agents);

  const el = document.createElement('div');
  el.className = 'msg';
  el.dataset.msgId = msg.id;
  el.dataset.testid = 'message';
  el.dataset.role = msg.role;
  el.dataset.agentId = msg.agentId ?? '';
  el.dataset.mentionedIds = mentionedIds.join(',');
  el.hidden = !isVisibleUnderMessageFilter(msg.agentId, mentionedIds);
  el.style.setProperty('--author-color', color);
  el.innerHTML = `
    <div class="msg-avatar" style="background:${color}">${initial}</div>
    <div class="msg-body">
      <div class="msg-meta">
        <span class="msg-author" data-testid="msg-author">${escHtml(msg.authorName)}</span>
        ${agent?.dangerouslySkipPermissions ? `<span class="msg-author-yolo-badge" data-testid="msg-author-yolo-badge" title="${t('agent.yoloBadgeTitle')}">🔥</span>` : ''}
        ${agent?.chromeAccess ? `<span class="msg-author-chrome-badge" data-testid="msg-author-chrome-badge" title="${t('agent.chromeBadgeTitle')}">🌐</span>` : ''}
        ${agent ? `<span class="msg-author-dir" data-testid="msg-author-dir" title="${escHtml(agent.workingDir)}">${escHtml(shortDir(agent.workingDir))}</span>` : ''}
        <span class="msg-time" data-iso="${msg.createdAt}">${fmtTime(msg.createdAt)}</span>
        ${msg.role === 'agent' ? `
        <span class="msg-actions">
          <button class="msg-copy-text-btn" data-testid="msg-copy-text-btn" title="${t('msg.copyTextTitle')}">📋</button>
          <button class="msg-copy-image-btn" data-testid="msg-copy-image-btn" title="${t('msg.copyImageTitle')}">📸</button>
        </span>` : ''}
      </div>
      <div class="msg-content${msg.role === 'user' ? ' msg-content-plain' : ''}" data-testid="msg-content">${contentHtml}</div>
    </div>`;
  if (msg.attachments?.length) {
    el.querySelector('.msg-body').appendChild(buildAttachmentsEl(msg.attachments));
  }
  if (msg.toolCalls?.length) {
    el.querySelector('.msg-body').appendChild(buildToolCallsEl(msg.toolCalls));
  }
  if (msg.role === 'agent') {
    el.querySelector('.msg-copy-text-btn').addEventListener('click', (e) => copyMessageText(e.currentTarget, msg.content));
    el.querySelector('.msg-copy-image-btn').addEventListener('click', (e) => copyMessageAsImage(e.currentTarget, el));
  }
  return el;
}

/**
 * Briefly swaps a button's label to a status glyph (success/failure), then
 * restores it, mirroring the "Copied!" feedback used for session-ID copying.
 * @param {HTMLButtonElement} btn
 * @param {string} glyph
 */
function flashButtonStatus(btn, glyph) {
  const original = btn.textContent;
  btn.textContent = glyph;
  btn.disabled = true;
  setTimeout(() => {
    btn.textContent = original;
    btn.disabled = false;
  }, 1200);
}

/**
 * Copies a message's raw text content to the clipboard.
 * @param {HTMLButtonElement} btn
 * @param {string} content
 */
async function copyMessageText(btn, content) {
  try {
    await navigator.clipboard.writeText(content);
    flashButtonStatus(btn, '✓');
  } catch (err) {
    console.error('Failed to copy message text:', err);
    flashButtonStatus(btn, '✗');
  }
}

/**
 * Traces a rounded-rect path on a canvas context (no native roundRect
 * fallback needed, but this keeps rendering independent of that API).
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @param {number} r
 */
function traceRoundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Block-level tags that should end their own line when flattening rendered
 * markdown down to plain text (see blockText) — covers nested lists (an
 * <li>'s own text and any nested <ul>/<ol> inside it are separate <li>
 * elements themselves) and tables (each <tr> is one line) without needing
 * to special-case container tags like <ul>/<table>/<tbody> at all. */
const BLOCK_TAGS = 'p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, tr, hr';

/**
 * Flattens an element's text for the copy-as-image export. Plain
 * `.textContent` concatenates every descendant text node with NO separator
 * at all regardless of CSS display/block boundaries (DOM behavior, not a
 * bug) — fine for a single paragraph, but a rendered markdown list would
 * otherwise flatten to "item oneitem two". Works on a clone (never touches
 * the live, on-screen DOM): inserts a newline marker right after every
 * block-level element, then reads the whole thing back as one string —
 * naturally handles nesting since each block tag's marker lands in
 * document order relative to the others, without hand-walking the tree.
 * Falls back cleanly to plain single-line content (e.g. a user's own
 * message) since it's a no-op when there's nothing to mark.
 * @param {Element} el
 * @returns {string}
 */
function blockText(el) {
  const clone = el.cloneNode(true);
  clone.querySelectorAll(BLOCK_TAGS).forEach((node) => {
    node.after(document.createTextNode('\n'));
  });
  return clone.textContent.replace(/\n{2,}/g, '\n').trim();
}

/**
 * Greedily wraps text to fit within maxWidth: splits first on explicit
 * newlines (message content uses white-space: pre-wrap, so they're real line
 * breaks), then on spaces. A single word wider than maxWidth is kept whole
 * rather than hard-broken — good enough for a copy-as-image utility; it
 * doesn't need to byte-for-byte match the browser's own line breaks.
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} maxWidth
 * @returns {string[]}
 */
function wrapCanvasText(ctx, text, maxWidth) {
  const lines = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph === '') { lines.push(''); continue; }
    let current = '';
    for (const word of paragraph.split(' ')) {
      const candidate = current ? `${current} ${word}` : word;
      if (!current || ctx.measureText(candidate).width <= maxWidth) {
        current = candidate;
      } else {
        lines.push(current);
        current = word;
      }
    }
    lines.push(current);
  }
  return lines;
}

/**
 * Renders a message bubble to a PNG and copies it to the clipboard as an
 * image, by drawing each part (background, avatar, author, timestamp,
 * content, attachment thumbnails) directly with the Canvas 2D API at the
 * exact positions the browser already laid them out at (via
 * getBoundingClientRect). Deliberately avoids the more obvious "serialize to
 * SVG <foreignObject>, draw that onto canvas" approach — Chromium taints any
 * canvas an SVG-with-foreignObject was drawn onto, permanently blocking
 * toBlob/toDataURL, so that route can never produce an exportable image.
 * Drawing only canvas primitives (fillRect/fillText/drawImage) sidesteps
 * tainting entirely and needs no third-party screenshot library.
 * @param {HTMLButtonElement} btn
 * @param {HTMLElement} msgEl - The .msg element to capture
 */
async function copyMessageAsImage(btn, msgEl) {
  try {
    const rect = msgEl.getBoundingClientRect();
    const msgStyle = getComputedStyle(msgEl);
    const scale = window.devicePixelRatio || 1;

    const canvas = document.createElement('canvas');
    canvas.width = rect.width * scale;
    canvas.height = rect.height * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);

    traceRoundedRect(ctx, 0, 0, rect.width, rect.height, parseFloat(msgStyle.borderRadius) || 0);
    ctx.fillStyle = msgStyle.backgroundColor;
    ctx.fill();
    const borderWidth = parseFloat(msgStyle.borderLeftWidth) || 0;
    if (borderWidth > 0) {
      ctx.fillStyle = msgStyle.borderLeftColor;
      ctx.fillRect(0, 0, borderWidth, rect.height);
    }

    /**
     * Draws a text element's own content at its real rendered position.
     * @param {Element | null} el
     * @param {{ align?: CanvasTextAlign, baseline?: CanvasTextBaseline }} [opts]
     */
    const drawTextEl = (el, { align = 'left', baseline = 'alphabetic' } = {}) => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      ctx.font = cs.font;
      ctx.fillStyle = cs.color;
      ctx.textAlign = align;
      ctx.textBaseline = baseline;
      const x = align === 'center' ? r.left - rect.left + r.width / 2 : r.left - rect.left;
      const y = baseline === 'middle' ? r.top - rect.top + r.height / 2 : r.bottom - rect.top - 1;
      ctx.fillText(el.textContent, x, y);
    };

    const avatarEl = msgEl.querySelector('.msg-avatar');
    if (avatarEl) {
      const r = avatarEl.getBoundingClientRect();
      const cx = r.left - rect.left + r.width / 2;
      const cy = r.top - rect.top + r.height / 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r.width / 2, 0, Math.PI * 2);
      ctx.fillStyle = getComputedStyle(avatarEl).backgroundColor;
      ctx.fill();
      drawTextEl(avatarEl, { align: 'center', baseline: 'middle' });
    }

    drawTextEl(msgEl.querySelector('.msg-author'));
    drawTextEl(msgEl.querySelector('.msg-time'));

    const contentEl = msgEl.querySelector('.msg-content');
    if (contentEl) {
      const r = contentEl.getBoundingClientRect();
      const cs = getComputedStyle(contentEl);
      ctx.font = cs.font;
      ctx.fillStyle = cs.color;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
      const x = r.left - rect.left;
      let y = r.top - rect.top + lineHeight * 0.8;
      for (const line of wrapCanvasText(ctx, blockText(contentEl), r.width)) {
        ctx.fillText(line, x, y);
        y += lineHeight;
      }
    }

    for (const img of msgEl.querySelectorAll('.msg-attachment-img')) {
      const r = img.getBoundingClientRect();
      ctx.drawImage(img, r.left - rect.left, r.top - rect.top, r.width, r.height);
    }

    for (const details of msgEl.querySelectorAll('.msg-attachment-text')) {
      const r = details.getBoundingClientRect();
      const cs = getComputedStyle(details);
      traceRoundedRect(ctx, r.left - rect.left, r.top - rect.top, r.width, r.height, parseFloat(cs.borderRadius) || 0);
      ctx.fillStyle = cs.backgroundColor;
      ctx.fill();
      drawTextEl(details.querySelector('summary'));
    }

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    flashButtonStatus(btn, '✓');
  } catch (err) {
    console.error('Failed to copy message as image:', err);
    flashButtonStatus(btn, '✗');
  }
}

/**
 * Builds the attachments block appended below a message's text content.
 * @param {Attachment[]} attachments
 * @returns {HTMLElement}
 */
function buildAttachmentsEl(attachments) {
  const wrap = document.createElement('div');
  wrap.className = 'msg-attachments';
  wrap.dataset.testid = 'msg-attachments';
  for (const att of attachments) {
    if (att.type === 'image') {
      const img = document.createElement('img');
      img.className = 'msg-attachment-img';
      img.dataset.testid = 'msg-attachment-image';
      img.src = `data:${att.mediaType};base64,${att.data}`;
      img.alt = att.name ?? t('attachments.pastedImageAlt');
      img.addEventListener('click', () => window.open(img.src, '_blank'));
      wrap.appendChild(img);
    } else {
      const details = document.createElement('details');
      details.className = 'msg-attachment-text';
      details.dataset.testid = 'msg-attachment-text';
      details.innerHTML = `<summary>${escHtml(att.name ?? t('attachments.defaultPastedTextLabel'))}</summary><pre>${escHtml(att.data)}</pre>`;
      wrap.appendChild(details);
    }
  }
  return wrap;
}

/**
 * Builds a single tool call's own expandable entry (label + result), shared
 * by both the flat and accordion-wrapped layouts in buildToolCallsEl.
 * @param {import('../services/agentProcessManager.js').ToolCall} call
 * @returns {HTMLElement}
 */
function buildToolCallEl(call) {
  const details = document.createElement('details');
  details.className = `msg-tool-call${call.isError ? ' msg-tool-call-error' : ''}`;
  details.dataset.testid = 'msg-tool-call';
  const resultText = call.result || `(${t('msg.toolCallNoOutput')})`;
  details.innerHTML = `
    <summary>${call.isError ? `<span class="msg-tool-call-error-badge">${escHtml(t('msg.toolCallErrorLabel'))}</span> ` : ''}${escHtml(call.label)}</summary>
    <pre>${escHtml(resultText)}</pre>`;
  return details;
}

/**
 * Renders a message's tool calls as collapsed, click-to-expand entries —
 * same idea as the VS Code Claude Code extension's expandable tool-call
 * blocks, scaled down to fit a multi-agent group chat: collapsed by
 * default so several agents narrating their work at once doesn't drown out
 * the actual conversation, but the real output (command results, diffs, MCP
 * responses) is one click away instead of being discarded entirely.
 *
 * A single call is shown directly — one accordion is already minimal. Two
 * or more get nested inside an outer accordion too: an agent that made a
 * dozen tool calls was otherwise a dozen collapsed-but-still-one-line
 * entries stacked in the message, which on its own was already enough
 * height to crowd out the actual conversation this is a CHAT for. The outer
 * summary surfaces an error badge up front (matching each inner entry's own
 * badge) so a failure is visible without expanding anything.
 * @param {import('../services/agentProcessManager.js').ToolCall[]} toolCalls
 * @returns {HTMLElement}
 */
function buildToolCallsEl(toolCalls) {
  const wrap = document.createElement('div');
  wrap.className = 'msg-tool-calls';
  wrap.dataset.testid = 'msg-tool-calls';

  if (toolCalls.length <= 1) {
    for (const call of toolCalls) wrap.appendChild(buildToolCallEl(call));
    return wrap;
  }

  const hasError = toolCalls.some((call) => call.isError);
  const outer = document.createElement('details');
  outer.className = `msg-tool-calls-outer${hasError ? ' msg-tool-call-error' : ''}`;
  outer.dataset.testid = 'msg-tool-calls-outer';
  const summary = document.createElement('summary');
  summary.innerHTML = `${hasError ? `<span class="msg-tool-call-error-badge">${escHtml(t('msg.toolCallErrorLabel'))}</span> ` : ''}${escHtml(t('msg.toolCallsSummary', { count: toolCalls.length }))}`;
  outer.appendChild(summary);
  const inner = document.createElement('div');
  inner.className = 'msg-tool-calls-inner';
  for (const call of toolCalls) inner.appendChild(buildToolCallEl(call));
  outer.appendChild(inner);
  wrap.appendChild(outer);
  return wrap;
}

/**
 * Appends a completed message to the message list.
 * @param {Message} msg
 */
function appendMessage(msg) {
  if ($(`[data-msg-id="${msg.id}"]`)) return; // dedup
  messageList.appendChild(buildMessageEl(msg));
  scrollToBottom();
}

/**
 * Creates a streaming bubble placeholder for an in-progress agent response.
 * @param {string} agentId
 * @param {string} agentName
 * @param {string} agentColor
 * @returns {HTMLElement}
 */
function createStreamingBubble(agentId, agentName, agentColor) {
  const agent = agentById(agentId);
  const color = agentDisplayColor(agentColor);
  const el = document.createElement('div');
  el.className = 'msg streaming';
  el.dataset.testid = 'streaming-bubble';
  el.dataset.agentId = agentId ?? '';
  el.hidden = !isVisibleUnderMessageFilter(agentId);
  el.style.setProperty('--author-color', color);
  el.innerHTML = `
    <div class="msg-avatar" style="background:${color}">${agentName[0].toUpperCase()}</div>
    <div class="msg-body">
      <div class="msg-meta">
        <span class="msg-author">${escHtml(agentName)}</span>
        ${agent?.dangerouslySkipPermissions ? `<span class="msg-author-yolo-badge" data-testid="msg-author-yolo-badge" title="${t('agent.yoloBadgeTitle')}">🔥</span>` : ''}
        ${agent?.chromeAccess ? `<span class="msg-author-chrome-badge" data-testid="msg-author-chrome-badge" title="${t('agent.chromeBadgeTitle')}">🌐</span>` : ''}
        ${agent ? `<span class="msg-author-dir" data-testid="msg-author-dir" title="${escHtml(agent.workingDir)}">${escHtml(shortDir(agent.workingDir))}</span>` : ''}
        <span class="msg-typing" data-testid="msg-typing">
          <span class="msg-status-text" data-testid="msg-status-text">${t('chat.respondingLabel')}</span>
          <span class="msg-elapsed" data-testid="msg-elapsed"></span>
        </span>
        <button class="msg-stop-btn" data-testid="stream-stop-btn" title="${t('chat.stopTitle')}">⏹ ${t('chat.stopBtn')}</button>
      </div>
      <div class="msg-content" data-testid="msg-content"></div>
    </div>`;
  return el;
}

/**
 * Escapes a string for safe innerHTML insertion.
 * @param {string} str
 * @returns {string}
 */
function escHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Chat list rendering ─────────────────────────────────────────────────────

function renderChatList() {
  chatList.innerHTML = '';
  for (const chat of chats) {
    const li = document.createElement('li');
    const unread = unreadChatIds.has(chat.id);
    li.className = 'chat-item' + (chat.id === activeChatId ? ' active' : '') + (unread ? ' has-unread' : '');
    li.dataset.chatId = chat.id;
    li.dataset.testid = 'chat-item';
    li.innerHTML = `
      ${unread ? `<span class="chat-unread-dot" data-testid="chat-unread-dot" title="${t('chat.unreadTitle')}"></span>` : ''}
      <span class="chat-item-name" data-testid="chat-item-name">${t('chat.channelName', { name: escHtml(chat.name) })}</span>
      <button class="chat-del-btn" data-testid="chat-del-btn" data-del-chat="${chat.id}" title="${t('chat.deleteTitle')}">×</button>`;
    li.addEventListener('click', (e) => {
      if (e.target.closest('[data-del-chat]')) return;
      selectChat(chat.id);
    });
    li.querySelector('[data-del-chat]').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (await confirmDialog(t('confirm.deleteChat', { name: chat.name }))) {
        deleteChat(chat.id);
      }
    });
    chatList.appendChild(li);
  }
}

// ─── Agent panel rendering ───────────────────────────────────────────────────

/** Hides every open per-agent overflow menu (at most one is open at a time). */
function closeAllAgentMenus() {
  for (const menu of agentList.querySelectorAll('.agent-menu:not([hidden])')) {
    menu.hidden = true;
  }
}

function renderAgentPanel() {
  const chat = activeChat();
  if (!chat) {
    noChatNotice.hidden = false;
    agentList.hidden = true;
    agentActions.hidden = true;
    return;
  }
  noChatNotice.hidden = true;
  agentList.hidden = false;
  agentActions.hidden = false;
  agentPanelError.hidden = true;

  // Member list
  const members = chat.memberAgentIds.map(agentById).filter(Boolean);
  agentList.innerHTML = '';
  for (const agent of members) {
    const li = document.createElement('li');
    li.className = 'agent-item';
    li.dataset.testid = 'agent-item';
    li.dataset.agentId = agent.id;
    li.innerHTML = `
      <div class="agent-avatar" style="background:${agentDisplayColor(agent.color)}">${agent.name[0].toUpperCase()}</div>
      <div class="agent-info">
        <span class="agent-name" data-testid="agent-name">${escHtml(agent.name)}${agent.dangerouslySkipPermissions ? ` <span class="agent-yolo-badge" data-testid="agent-yolo-badge" title="${t('agent.yoloBadgeTitle')}">🔥</span>` : ''}${agent.isObserver ? ` <span class="agent-observer-badge" data-testid="agent-observer-badge" title="${t('agent.observerBadgeTitle')}">👁</span>` : ''}${agent.chromeAccess ? ` <span class="agent-chrome-badge" data-testid="agent-chrome-badge" title="${t('agent.chromeBadgeTitle')}">🌐</span>` : ''}</span>
        <span class="agent-dir" title="${escHtml(agent.workingDir)}">${escHtml(shortDir(agent.workingDir))}</span>
        ${agent.note ? `<span class="agent-note" data-testid="agent-note" title="${escHtml(agent.note)}">📝 ${escHtml(agent.note)}</span>` : ''}
        ${agent.resumeId ? `<button class="agent-session-btn" data-testid="agent-session-btn" title="${t('agent.copySessionTitle', { resumeId: escHtml(agent.resumeId) })}">⧉ ${agent.resumeId.slice(0, 8)}…</button>` : ''}
      </div>
      <button class="agent-filter-btn${messageFilterAgentIds.has(agent.id) ? ' active' : ''}" data-testid="agent-filter-btn" title="${messageFilterAgentIds.has(agent.id) ? t('agent.filterOffTitle', { name: agent.name }) : t('agent.filterOnTitle', { name: agent.name })}">🔎</button>
      <div class="agent-menu-wrap">
        <button class="agent-menu-btn" data-testid="agent-menu-btn" title="${t('agent.moreActionsTitle')}">⋮</button>
        <ul class="agent-menu" data-testid="agent-menu" hidden>
          <li><button class="agent-note-btn" data-testid="agent-note-btn">🗒 ${agent.note ? t('agent.editNoteTitle') : t('agent.addNoteTitle')}</button></li>
          <li><button class="agent-open-folder-btn" data-testid="agent-open-folder-btn">📂 ${t('agent.openFolderTitle')}</button></li>
          <li><button class="agent-restart-btn" data-testid="agent-restart-btn" title="${t('agent.restartHint')}">🔄 ${t('agent.restartTitle')}</button></li>
          <li><button class="agent-remove-btn" data-testid="agent-remove-btn">× ${t('agent.removeFromChatTitle')}</button></li>
          <li><button class="agent-del-btn" data-testid="agent-del-btn">🗑 ${t('agent.deleteTitle')}</button></li>
        </ul>
      </div>`;
    const agentMenu = li.querySelector('.agent-menu');
    const closeAgentMenu = () => { agentMenu.hidden = true; };
    li.querySelector('.agent-filter-btn').addEventListener('click', () => toggleMessageFilter(agent.id));
    li.querySelector('.agent-menu-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const wasHidden = agentMenu.hidden;
      closeAllAgentMenus();
      agentMenu.hidden = !wasHidden;
    });
    li.querySelector('.agent-note-btn').addEventListener('click', () => { closeAgentMenu(); openNoteModal(agent); });
    li.querySelector('.agent-open-folder-btn').addEventListener('click', () => { closeAgentMenu(); openAgentFolder(agent); });
    li.querySelector('.agent-restart-btn').addEventListener('click', () => { closeAgentMenu(); restartAgent(agent); });
    li.querySelector('.agent-remove-btn').addEventListener('click', () => { closeAgentMenu(); removeMember(agent.id); });
    li.querySelector('.agent-del-btn').addEventListener('click', async () => {
      closeAgentMenu();
      if (await confirmDialog(t('confirm.deleteAgent', { name: agent.name }))) {
        deleteGlobalAgent(agent.id);
      }
    });
    li.querySelector('.agent-session-btn')?.addEventListener('click', () => copySessionCommand(agent));
    agentList.appendChild(li);
  }

  // Add-agent dropdown contents — an agent belongs to at most one chat at a
  // time, so exclude anyone busy in ANY chat, not just this one (a strict
  // superset of "already in this chat", since this chat's own members are
  // necessarily part of that union too).
  const busyAgentIds = new Set(chats.flatMap((c) => c.memberAgentIds));
  const available = agents.filter((a) => !busyAgentIds.has(a.id));
  addAgentBtn.hidden = available.length === 0;
  addAgentMenu.innerHTML = '';
  for (const agent of available) {
    const li = document.createElement('li');
    li.className = 'add-menu-item';
    li.dataset.testid = 'add-menu-item';
    li.dataset.agentId = agent.id;
    li.innerHTML = `
      <span class="add-menu-avatar" style="background:${agentDisplayColor(agent.color)}">${agent.name[0]}</span>
      <span class="add-menu-name">${escHtml(agent.name)}</span>
      <button class="agent-del-btn" data-testid="agent-del-btn" title="${t('agent.deleteTitle')}">🗑</button>`;
    li.querySelector('.add-menu-name').addEventListener('click', () => addMember(agent.id));
    li.querySelector('.add-menu-avatar').addEventListener('click', () => addMember(agent.id));
    li.querySelector('.agent-del-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (await confirmDialog(t('confirm.deleteAgent', { name: agent.name }))) {
        deleteGlobalAgent(agent.id);
      }
    });
    addAgentMenu.appendChild(li);
  }
}

/**
 * Opens the note modal for a given agent, pre-filled with its current note
 * (if any). Purely a user-facing reminder (never sent to the CLI), and
 * unlike workingDir/YOLO/Observer/chromeAccess it's editable any time — see
 * the note field's docs in server/store/db.js for why that's safe (no
 * spawn-arg implications).
 * @param {Agent} agent
 * @returns {void}
 */
function openNoteModal(agent) {
  noteEditAgentId = agent.id;
  noteHeaderTitle.textContent = agent.note ? t('agent.editNoteTitle') : t('agent.addNoteTitle');
  noteTextarea.value = agent.note ?? '';
  noteOverlay.hidden = false;
  noteTextarea.focus();
}

function closeNoteModal() {
  noteOverlay.hidden = true;
  noteEditAgentId = null;
}

/**
 * Persists the note modal's textarea via PATCH (never evicts the running
 * process — see the PATCH route's docs), updates local state, and re-renders.
 * @param {SubmitEvent} e
 * @returns {Promise<void>}
 */
async function handleNoteFormSubmit(e) {
  e.preventDefault();
  const agentId = noteEditAgentId;
  const note = noteTextarea.value.trim();
  closeNoteModal();

  const res = await fetch(`/api/agents/${agentId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note }),
  });
  if (res.ok) {
    const updated = /** @type {Agent} */ (await res.json());
    const idx = agents.findIndex((a) => a.id === agentId);
    if (idx !== -1) agents[idx] = updated;
  }
  renderAgentPanel();
}

// ─── Chat actions ────────────────────────────────────────────────────────────

/** sessionStorage key for the last-active chat — per-tab, cleared when the
 * tab closes, and never visible in the URL/address bar. */
const ACTIVE_CHAT_STORAGE_KEY = 'app.activeChatId';

/**
 * Clears the chat view back to "no chat selected" — used when deleting the
 * active chat, and when the id restored from sessionStorage no longer
 * corresponds to a real chat (e.g. it was deleted in another tab).
 */
function showEmptyChatState() {
  activeChatId = null;
  sessionStorage.removeItem(ACTIVE_CHAT_STORAGE_KEY);
  emptyState.hidden = false;
  chatView.hidden = true;
  pendingScheduledMessages = [];
  renderChatList();
  renderAgentPanel();
}

/**
 * Switches the active chat, loads its message history, and re-renders.
 * Also remembers the choice in sessionStorage so a refresh returns to the
 * same chat instead of always landing back on "no chat selected" —
 * deliberately not the URL, so the chat id is never exposed there.
 * @param {string} id
 */
async function selectChat(id) {
  activeChatId = id;
  sessionStorage.setItem(ACTIVE_CHAT_STORAGE_KEY, id);
  unreadChatIds.delete(id);
  messageFilterAgentIds.clear();
  renderMessageFilterBar();
  renderChatList();
  renderAgentPanel();
  // On a narrow viewport the chat list a user just picked from is an
  // off-canvas drawer (see the responsive drawers section) — closing it
  // automatically here matches how any mobile chat app behaves, and is a
  // harmless no-op on a wide viewport where it was never open.
  closeDrawer();

  const chat = activeChat();
  chatTopbarName.textContent = t('chat.channelName', { name: chat?.name ?? '' });
  emptyState.hidden = true;
  chatView.hidden = false;
  messageList.innerHTML = '';

  const res = await fetch(`/api/chats/${id}/messages`);
  const msgs = /** @type {Message[]} */ (await res.json());
  for (const msg of msgs) appendMessage(msg);

  scheduledPanel.hidden = true;
  const scheduledRes = await fetch(`/api/chats/${id}/scheduled-messages`);
  pendingScheduledMessages = /** @type {ScheduledMessage[]} */ (await scheduledRes.json());
  renderScheduledPanel();
}

/**
 * Creates a new chat via the REST API and selects it.
 * @param {string} name
 */
async function createChat(name) {
  const res = await fetch('/api/chats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const chat = /** @type {Chat} */ (await res.json());
  chats.push(chat);
  renderChatList();
  await selectChat(chat.id);
}

/**
 * Deletes a chat via the REST API.
 * @param {string} id
 */
async function deleteChat(id) {
  await fetch(`/api/chats/${id}`, { method: 'DELETE' });
  chats = chats.filter((c) => c.id !== id);
  unreadChatIds.delete(id);
  if (activeChatId === id) {
    showEmptyChatState();
  }
  renderChatList();
}

// ─── Member actions ───────────────────────────────────────────────────────────

/**
 * Shows a short-lived error message under the agent panel's add-agent
 * control (e.g. a rejected cross-chat add). Mirrors showAttachmentError.
 * @param {string} text
 */
function showAgentPanelError(text) {
  agentPanelError.textContent = text;
  agentPanelError.hidden = false;
  setTimeout(() => { agentPanelError.hidden = true; }, 4000);
}

/**
 * Adds an agent to the active chat.
 * @param {string} agentId
 */
async function addMember(agentId) {
  const res = await fetch(`/api/chats/${activeChatId}/members`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId }),
  });
  addAgentMenu.hidden = true;
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    // The add-menu's candidate list is only as fresh as our local `chats`
    // state — a rejection can mean another tab just claimed this agent, so
    // resync before re-rendering rather than leaving a stale, still-offered
    // entry in the menu. renderAgentPanel() resets the error banner, so
    // show the error AFTER re-rendering, not before.
    chats = await (await fetch('/api/chats')).json();
    renderAgentPanel();
    showAgentPanelError(body.error ?? t('errors.addMemberFailed'));
    return;
  }
  const chat = /** @type {Chat} */ (await res.json());
  const idx = chats.findIndex((c) => c.id === chat.id);
  if (idx !== -1) chats[idx] = chat;
  renderAgentPanel();
}

/**
 * Removes an agent from the active chat.
 * @param {string} agentId
 */
async function removeMember(agentId) {
  const res = await fetch(`/api/chats/${activeChatId}/members/${agentId}`, { method: 'DELETE' });
  const chat = /** @type {Chat} */ (await res.json());
  const idx = chats.findIndex((c) => c.id === chat.id);
  if (idx !== -1) chats[idx] = chat;
  renderAgentPanel();
}

/**
 * Permanently deletes an agent from the system (not just from the current chat).
 * @param {string} agentId
 */
async function deleteGlobalAgent(agentId) {
  await fetch(`/api/agents/${agentId}`, { method: 'DELETE' });
  agents = agents.filter((a) => a.id !== agentId);
  // Remove from all chats in local state
  for (const chat of chats) {
    chat.memberAgentIds = chat.memberAgentIds.filter((id) => id !== agentId);
  }
  renderAgentPanel();
}

// ─── Scheduled messages ───────────────────────────────────────────────────────

/**
 * Re-renders the topbar badge (with a count) and its dropdown panel from
 * pendingScheduledMessages. The badge itself is hidden entirely when
 * there's nothing pending, same convention as addAgentBtn's own
 * available-candidates check.
 */
function renderScheduledPanel() {
  scheduledBtn.hidden = !activeChatId || pendingScheduledMessages.length === 0;
  scheduledBtn.textContent = `🕐 ${pendingScheduledMessages.length}`;
  scheduledBtn.title = t('schedule.panelTitle');

  scheduledPanel.innerHTML = '';
  if (pendingScheduledMessages.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'scheduled-item-empty';
    empty.textContent = t('schedule.panelEmpty');
    scheduledPanel.appendChild(empty);
    return;
  }
  for (const scheduled of pendingScheduledMessages) {
    const li = document.createElement('li');
    li.className = 'scheduled-item';
    li.dataset.testid = 'scheduled-item';
    li.dataset.scheduledId = scheduled.id;
    li.innerHTML = `
      <div class="scheduled-item-content">
        <span class="scheduled-item-preview" data-testid="scheduled-item-preview">${escHtml(scheduled.content || t('attachments.defaultPastedTextLabel'))}</span>
        <span class="scheduled-item-time" data-testid="scheduled-item-time">${fmtScheduledTime(scheduled.sendAt)}</span>
      </div>
      <button class="scheduled-cancel-btn" data-testid="scheduled-cancel-btn" title="${t('schedule.cancelTitle')}">✕</button>`;
    li.querySelector('.scheduled-cancel-btn').addEventListener('click', () => cancelScheduled(scheduled.id));
    scheduledPanel.appendChild(li);
  }
}

/**
 * Cancels a pending scheduled message via the REST API and updates local state.
 * @param {string} id
 */
async function cancelScheduled(id) {
  await fetch(`/api/chats/${activeChatId}/scheduled-messages/${id}`, { method: 'DELETE' });
  pendingScheduledMessages = pendingScheduledMessages.filter((m) => m.id !== id);
  renderScheduledPanel();
}

/**
 * Opens the schedule modal, defaulting the datetime-local input's minimum
 * to "now" (best-effort — browser support for `min` on this input type
 * varies, so the submit handler re-validates regardless).
 */
function openScheduleModal() {
  scheduleError.hidden = true;
  scheduleError.textContent = '';
  scheduleSubmit.disabled = false;
  scheduleTimeInput.value = '';
  const now = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000);
  scheduleTimeInput.min = now.toISOString().slice(0, 16);
  scheduleOverlay.hidden = false;
  scheduleTimeInput.focus();
}

function closeScheduleModal() {
  scheduleOverlay.hidden = true;
}

/**
 * Submits the schedule form: schedules whatever's currently in the
 * composer (content + attachments), then clears it exactly like a normal
 * send. @mention targeting is resolved fresh once the message actually
 * fires, same as a live message — nothing about targeting is decided here.
 * @param {SubmitEvent} e
 */
async function handleScheduleFormSubmit(e) {
  e.preventDefault();
  const content = msgInput.value.trim();
  if (!content && pendingAttachments.length === 0) {
    scheduleError.textContent = t('errors.scheduledContentRequired');
    scheduleError.hidden = false;
    return;
  }
  const sendAtMs = new Date(scheduleTimeInput.value).getTime();
  if (!scheduleTimeInput.value || Number.isNaN(sendAtMs) || sendAtMs <= Date.now()) {
    scheduleError.textContent = t('schedule.pastTimeError');
    scheduleError.hidden = false;
    return;
  }

  scheduleSubmit.disabled = true;
  scheduleError.hidden = true;
  try {
    const res = await fetch(`/api/chats/${activeChatId}/scheduled-messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, attachments: pendingAttachments, sendAt: new Date(sendAtMs).toISOString() }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      scheduleError.textContent = body.error ?? t('errors.scheduledContentRequired');
      scheduleError.hidden = false;
      return;
    }
    const scheduled = /** @type {ScheduledMessage} */ (await res.json());
    pendingScheduledMessages.push(scheduled);
    renderScheduledPanel();
    clearComposer();
    closeScheduleModal();
  } finally {
    scheduleSubmit.disabled = false;
  }
}

// ─── Create agent modal ───────────────────────────────────────────────────────

function openModal() {
  agentNameInput.value = '';
  agentDirInput.value = '';
  agentResumeInput.value = '';
  agentNoteInput.value = '';
  yoloModeCheck.checked = false;
  observerModeCheck.checked = false;
  chromeAccessCheck.checked = false;
  agentError.hidden = true;
  agentError.textContent = '';
  modalSubmit.disabled = false;
  addToChatLabel.hidden = !activeChatId;
  addToChatCheck.checked = !!activeChatId;
  selectedColor = PRESET_COLORS[0];
  renderColorGrid(colorGrid, selectedColor, (c) => { selectedColor = c; });
  renderRecentDirs();
  modalOverlay.hidden = false;
  agentNameInput.focus();
}

/** Most working directories to offer as one-click picks in the New Agent modal. */
const MAX_RECENT_DIRS = 6;

/**
 * Renders one-click chips for working directories already used by existing
 * agents, so adding a second/third agent to the same project doesn't require
 * clicking all the way through the folder browser again. Deduped by
 * directory, most-recently-created agent's use of a dir wins its position —
 * a reasonable proxy for "recently used" without tracking actual last-use
 * separately. Hidden entirely once there's nothing to offer (fresh install).
 */
function renderRecentDirs() {
  const seen = new Set();
  const dirs = [];
  for (const agent of [...agents].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    if (seen.has(agent.workingDir)) continue;
    seen.add(agent.workingDir);
    dirs.push(agent.workingDir);
    if (dirs.length >= MAX_RECENT_DIRS) break;
  }

  agentDirRecent.innerHTML = '';
  agentDirRecentWrap.hidden = dirs.length === 0;
  for (const dir of dirs) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.title = dir;
    chip.textContent = shortDir(dir);
    chip.addEventListener('click', () => { agentDirInput.value = dir; });
    agentDirRecent.appendChild(chip);
  }
}

function closeModal() {
  modalOverlay.hidden = true;
}

/**
 * Renders a row of PRESET_COLORS swatches into a container, highlighting the
 * currently selected one and calling onSelect when a different one is
 * clicked. Shared by the New Agent modal's color picker and the settings
 * modal's message-color picker.
 * @param {HTMLElement} container
 * @param {string} selected
 * @param {(color: string) => void} onSelect
 */
function renderColorGrid(container, selected, onSelect) {
  container.innerHTML = '';
  for (const c of PRESET_COLORS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'color-swatch' + (c === selected ? ' selected' : '');
    btn.style.background = c;
    btn.title = c;
    btn.addEventListener('click', () => {
      onSelect(c);
      container.querySelectorAll('.color-swatch').forEach((s) => s.classList.remove('selected'));
      btn.classList.add('selected');
    });
    container.appendChild(btn);
  }
}

/**
 * Picks a random "Cla…"-prefixed name for a new agent, avoiding collisions
 * with existing agent names. Falls back to a numbered suffix if every name
 * in the pool is already taken.
 * @returns {string}
 */
function generateAgentName() {
  const taken = new Set(agents.map((a) => a.name.toLowerCase()));
  const pool = CLA_NAMES.filter((n) => !taken.has(n.toLowerCase()));
  if (pool.length) return pool[Math.floor(Math.random() * pool.length)];

  // Every pool name is taken — suffix a random one with a number until unique.
  const base = CLA_NAMES[Math.floor(Math.random() * CLA_NAMES.length)];
  let n = 2;
  while (taken.has(`${base} ${n}`.toLowerCase())) n++;
  return `${base} ${n}`;
}

// ─── Settings modal ─────────────────────────────────────────────────────────

/**
 * Opens the settings modal, pre-filled with the current display name.
 * @returns {Promise<void>}
 */
async function openSettingsModal() {
  settingsError.hidden = true;
  settingsError.textContent = '';
  settingsSave.disabled = false;
  settingsOverlay.hidden = false;
  try {
    const res = await fetch('/api/settings');
    const settings = /** @type {Settings} */ (await res.json());
    settingsDisplayNameInput.value = settings.userDisplayName;
    selectedUserColor = settings.userColor;
    settingsLanguageSelect.value = settings.locale;
    settingsThemeSelect.value = settings.theme;
  } catch {
    settingsDisplayNameInput.value = '';
    selectedUserColor = userSettings.userColor;
    settingsLanguageSelect.value = currentLocale;
    settingsThemeSelect.value = userSettings.theme ?? 'dark';
  }
  renderColorGrid(settingsColorGrid, selectedUserColor, (c) => { selectedUserColor = c; });
  settingsDisplayNameInput.focus();
}

function closeSettingsModal() {
  settingsOverlay.hidden = true;
}

/**
 * Submits the settings form to the REST API.
 * @param {SubmitEvent} e
 */
async function handleSettingsFormSubmit(e) {
  e.preventDefault();
  const userDisplayName = settingsDisplayNameInput.value.trim();
  if (!userDisplayName) return;
  const userColor = selectedUserColor;
  const locale = settingsLanguageSelect.value;
  const theme = settingsThemeSelect.value;

  settingsSave.disabled = true;
  settingsError.hidden = true;
  try {
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userDisplayName, userColor, locale, theme }),
    });
    if (!res.ok) {
      const body = await res.json();
      settingsError.textContent = body.error ?? t('errors.saveSettingsFailed');
      settingsError.hidden = false;
      return;
    }
    userSettings = { userDisplayName, userColor, locale, theme };
    applyTheme(theme);
    // All four fields apply to the user's whole history/whole UI, not just
    // going forward (the server resolves authorName for user rows live, not
    // from a per-message snapshot; color was never stored per-message; and
    // locale purely controls how the CURRENTLY-RENDERING client displays
    // strings) — reflect that immediately rather than waiting for the next
    // chat switch/reload to re-fetch/re-render.
    document.querySelectorAll('[data-testid="message"][data-role="user"]').forEach((el) => {
      el.querySelector('[data-testid="msg-author"]').textContent = userDisplayName;
    });
    // A theme switch moves what counts as "enough contrast" (see
    // agentDisplayColor), so this has to re-color EVERY already-rendered
    // message/streaming bubble, not just the user's own — an agent's avatar
    // picked when dark theme was active would otherwise stay stuck showing
    // its dark-theme-safe color even after switching to light, until the
    // next reload rebuilds the message list from scratch.
    refreshAgentDisplayColors();
    if (locale !== currentLocale) {
      currentLocale = locale;
      applyTranslations();
      renderChatList();
      document.querySelectorAll('.msg-time[data-iso]').forEach((el) => { el.textContent = fmtTime(el.dataset.iso); });
    }
    renderAgentPanel();
    closeSettingsModal();
  } catch (err) {
    settingsError.textContent = err.message;
    settingsError.hidden = false;
  } finally {
    settingsSave.disabled = false;
  }
}

// ─── Folder browser ─────────────────────────────────────────────────────────

/** @type {string | null} the directory currently listed in the browser */
let browseCurrentPath = null;

/**
 * Monotonically increasing token identifying the most recently issued
 * loadBrowseDir() call. Since a user can trigger a new navigation (typing a
 * path, clicking an entry) before an in-flight fetch resolves, requests can
 * settle out of order — this discards any response that isn't the latest.
 */
let browseRequestId = 0;

/**
 * @typedef {Object} BrowseEntry
 * @property {string} name
 * @property {string} path
 */

/**
 * @typedef {Object} BrowseResult
 * @property {string} path
 * @property {string|null} parent
 * @property {BrowseEntry[]} entries
 */

/**
 * Opens the folder browser, starting from the current Working Directory
 * field's value if set, otherwise the server's default (the user's home dir).
 * @returns {Promise<void>}
 */
async function openFolderBrowser() {
  browseOverlay.hidden = false;
  await loadBrowseDir(agentDirInput.value.trim() || null);
}

/**
 * Closes the folder browser without changing the Working Directory field.
 */
function closeFolderBrowser() {
  browseOverlay.hidden = true;
}

/**
 * Fetches and renders the listing for a directory.
 * @param {string | null} path - Absolute path, or null for the server default
 * @returns {Promise<void>}
 */
async function loadBrowseDir(path) {
  const requestId = ++browseRequestId;
  const url = path ? `/api/browse?path=${encodeURIComponent(path)}` : '/api/browse';
  try {
    const res = await fetch(url);
    const body = /** @type {BrowseResult | { error: string }} */ (await res.json());
    if (requestId !== browseRequestId) return; // superseded by a newer navigation

    if (!res.ok) {
      browseError.textContent = /** @type {{ error: string }} */ (body).error ?? t('errors.readDirectoryFailed');
      browseError.hidden = false;
      return;
    }
    browseError.hidden = true;
    const result = /** @type {BrowseResult} */ (body);
    browseCurrentPath = result.path;
    browsePathInput.value = result.path;
    renderBrowseList(result);
  } catch (err) {
    if (requestId !== browseRequestId) return;
    browseError.textContent = err.message;
    browseError.hidden = false;
  }
}

/**
 * Renders the subdirectory list for the current browse result.
 * @param {BrowseResult} result
 */
function renderBrowseList(result) {
  browseList.innerHTML = '';
  if (result.parent) {
    const up = document.createElement('li');
    up.className = 'browse-item browse-item-up';
    up.textContent = t('browseModal.parentDirLabel');
    up.addEventListener('click', () => loadBrowseDir(result.parent));
    browseList.appendChild(up);
  }
  for (const entry of result.entries) {
    const li = document.createElement('li');
    li.className = 'browse-item';
    li.dataset.testid = 'browse-item';
    li.textContent = entry.name;
    li.addEventListener('click', () => loadBrowseDir(entry.path));
    browseList.appendChild(li);
  }
}

/**
 * Submits the create-agent form to the REST API.
 * @param {SubmitEvent} e
 */
async function handleAgentFormSubmit(e) {
  e.preventDefault();
  const name = agentNameInput.value.trim();
  const workingDir = agentDirInput.value.trim();
  if (!name || !workingDir) return;

  const resumeId = agentResumeInput.value.trim() || undefined;
  const note = agentNoteInput.value.trim() || undefined;
  const dangerouslySkipPermissions = yoloModeCheck.checked;
  const isObserver = observerModeCheck.checked;
  const chromeAccess = chromeAccessCheck.checked;
  modalSubmit.disabled = true;
  modalSubmit.textContent = t('agentModal.verifyingBtn');
  agentError.hidden = true;

  try {
    const res = await fetch('/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color: selectedColor, workingDir, resumeId, dangerouslySkipPermissions, isObserver, chromeAccess, note }),
    });
    if (!res.ok) {
      const body = await res.json();
      agentError.textContent = body.error ?? t('errors.createAgentFailed');
      agentError.hidden = false;
      return;
    }
    const agent = /** @type {Agent} */ (await res.json());
    agents.push(agent);

    if (addToChatCheck.checked && activeChatId) {
      await addMember(agent.id);
    } else {
      renderAgentPanel();
    }
    closeModal();
  } catch (err) {
    agentError.textContent = err.message;
    agentError.hidden = false;
  } finally {
    modalSubmit.disabled = false;
    modalSubmit.textContent = t('agentModal.createBtn');
  }
}

// ─── @mention / slash-command autocomplete ───────────────────────────────────

/** @type {number} index of focused dropdown item (-1 = none) */
let mentionFocusIdx = -1;

/** @type {Map<string, Promise<import('../services/commands.js').SlashCommand[]>>} */
const agentCommandsCache = new Map();

/**
 * Returns agents in the active chat that match a mention query.
 * @param {string} query
 * @returns {Agent[]}
 */
function getMentionMatches(query) {
  const chat = activeChat();
  if (!chat) return [];
  return agents.filter(
    (a) => chat.memberAgentIds.includes(a.id) && a.name.toLowerCase().startsWith(query.toLowerCase())
  );
}

/**
 * Fetches (and caches for the session) an agent's custom slash commands.
 * @param {string} agentId
 * @returns {Promise<import('../services/commands.js').SlashCommand[]>}
 */
function getAgentCommands(agentId) {
  if (!agentCommandsCache.has(agentId)) {
    agentCommandsCache.set(
      agentId,
      fetch(`/api/agents/${agentId}/commands`).then((r) => (r.ok ? r.json() : [])).catch(() => [])
    );
  }
  return agentCommandsCache.get(agentId);
}

/**
 * Resolves which single agent a slash command typed right now would
 * actually be sent to — matches parseSkillInvocation/parseResponders
 * semantics server-side (server/services/messageRouter.js), so the
 * dropdown never offers a command that wouldn't actually fire: an
 * explicitly @mentioned name, or, unambiguously, the chat's only member.
 * Returns null when it's ambiguous (multiple agents, none addressed) or
 * the addressed name doesn't match a real member.
 * @param {string} [addressedName]
 * @returns {Agent | null}
 */
function resolveSlashCommandAgent(addressedName) {
  const chat = activeChat();
  if (!chat) return null;
  const members = chat.memberAgentIds.map(agentById).filter(Boolean);
  if (addressedName) {
    return members.find((a) => a.name.toLowerCase() === addressedName.toLowerCase()) ?? null;
  }
  return members.length === 1 ? members[0] : null;
}

/**
 * Renders a set of composer-dropdown items (shared by @mention and
 * /command autocomplete — they're mutually exclusive triggers, so only one
 * kind is ever shown at a time) and shows the dropdown, or hides it if
 * there's nothing to offer. Keyboard navigation (ArrowUp/Down/Enter/Escape,
 * wired in the msgInput keydown listener) works generically against any
 * .mention-item element, regardless of which kind it is.
 * @param {{ testId: string, html: string, onSelect: () => void }[]} items
 */
function renderComposerDropdown(items) {
  if (items.length === 0) {
    hideMentionDropdown();
    return;
  }
  mentionFocusIdx = -1;
  mentionDropdown.innerHTML = '';
  for (const item of items) {
    const li = document.createElement('li');
    li.className = 'mention-item';
    li.dataset.testid = item.testId;
    li.innerHTML = item.html;
    li.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      item.onSelect();
    });
    mentionDropdown.appendChild(li);
  }
  mentionDropdown.hidden = false;
}

/**
 * Updates the composer's autocomplete dropdown from the current textarea
 * value and cursor — either "/" slash-command or "@" mention, whichever
 * the text up to the cursor matches. A slash command only ever works as
 * the ENTIRE message (optionally preceded by exactly one "@Name "), so
 * unlike @mentions (which can appear anywhere), its trigger is anchored to
 * the very start of the input.
 * @returns {Promise<void>}
 */
async function updateComposerDropdown() {
  const cursor = msgInput.selectionStart ?? msgInput.value.length;
  const before = msgInput.value.slice(0, cursor);

  const slashMatch = before.match(/^(?:@(\w+)\s+)?\/(\w*)$/);
  if (slashMatch) {
    const [, addressedName, query] = slashMatch;
    const agent = resolveSlashCommandAgent(addressedName);
    if (!agent) {
      hideMentionDropdown();
      return;
    }
    const commands = await getAgentCommands(agent.id);
    const matches = commands.filter((c) => c.name.toLowerCase().startsWith(query.toLowerCase()));
    renderComposerDropdown(matches.map((c) => ({
      testId: 'slash-command-item',
      html: `<span class="mention-avatar slash-icon">/</span>` +
        `<span class="mention-item-main"><span class="mention-item-name">/${escHtml(c.name)}</span>` +
        (c.description ? `<span class="mention-item-desc">${escHtml(c.description)}</span>`
          : c.builtin ? `<span class="mention-item-desc">${t('agent.builtinSkillDesc')}</span>` : '') +
        `</span>`,
      onSelect: () => insertSlashCommand(addressedName ? agent.name : null, c.name),
    })));
    return;
  }

  const mentionMatch = before.match(/@(\w*)$/);
  if (mentionMatch) {
    const matches = getMentionMatches(mentionMatch[1]);
    renderComposerDropdown(matches.map((agent) => ({
      testId: 'mention-item',
      html: `<span class="mention-avatar" style="background:${agentDisplayColor(agent.color)}">${agent.name[0]}</span>` +
        `<span class="mention-item-main">` +
        `<span class="mention-item-name">${escHtml(agent.name)}${agent.dangerouslySkipPermissions ? ` <span class="msg-author-yolo-badge" title="${t('agent.yoloBadgeTitle')}">🔥</span>` : ''}${agent.chromeAccess ? ` <span class="msg-author-chrome-badge" title="${t('agent.chromeBadgeTitle')}">🌐</span>` : ''}</span>` +
        `<span class="mention-item-desc">${escHtml(shortDir(agent.workingDir))}</span>` +
        (agent.note ? `<span class="mention-item-note">📝 ${escHtml(agent.note)}</span>` : '') +
        `</span>`,
      onSelect: () => insertMention(agent.name),
    })));
    return;
  }

  hideMentionDropdown();
}

function hideMentionDropdown() {
  mentionDropdown.hidden = true;
  mentionFocusIdx = -1;
}

/**
 * Inserts @AgentName at the current cursor position, replacing the @query.
 * @param {string} name
 */
function insertMention(name) {
  const cursor = msgInput.selectionStart ?? msgInput.value.length;
  const before = msgInput.value.slice(0, cursor);
  const atIdx = before.lastIndexOf('@');
  msgInput.value = msgInput.value.slice(0, atIdx) + `@${name} ` + msgInput.value.slice(cursor);
  hideMentionDropdown();
  msgInput.focus();
}

/**
 * Inserts a slash-command selection, replacing everything from the start
 * of the input up to the cursor (a slash command is only ever valid as the
 * entire message) — optionally re-prefixed with "@Name " using the agent's
 * canonical-cased name, if the command was addressed to a specific agent
 * rather than implied by being the chat's only member.
 * @param {string | null} agentName
 * @param {string} commandName
 */
function insertSlashCommand(agentName, commandName) {
  const cursor = msgInput.selectionStart ?? msgInput.value.length;
  const prefix = agentName ? `@${agentName} ` : '';
  msgInput.value = `${prefix}/${commandName} ${msgInput.value.slice(cursor)}`;
  hideMentionDropdown();
  msgInput.focus();
}

// ─── Attachments ────────────────────────────────────────────────────────────

/**
 * Shows a short-lived error message under the composer (e.g. cap exceeded).
 * @param {string} text
 */
function showAttachmentError(text) {
  attachmentError.textContent = text;
  attachmentError.hidden = false;
  setTimeout(() => { attachmentError.hidden = true; }, 4000);
}

/**
 * Reads a File/Blob as a base64 data URL.
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
function readAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(/** @type {string} */ (reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * Adds an image file as a pending attachment, enforcing size/count caps.
 * @param {File} file
 * @returns {Promise<void>}
 */
async function addImageAttachment(file) {
  if (pendingAttachments.length >= MAX_ATTACHMENTS) {
    showAttachmentError(t('attachments.maxAttachments', { max: MAX_ATTACHMENTS }));
    return;
  }
  if (file.size > MAX_IMAGE_BYTES) {
    showAttachmentError(t('attachments.imageTooLarge', { mb: MAX_IMAGE_BYTES / (1024 * 1024) }));
    return;
  }
  const dataUrl = await readAsDataUrl(file);
  const match = /^data:(.+?);base64,(.*)$/s.exec(dataUrl);
  if (!match) return;
  const [, mediaType, data] = match;
  pendingAttachments.push({
    id: crypto.randomUUID(),
    type: 'image',
    mediaType,
    name: file.name || 'pasted-image',
    data,
    size: file.size,
  });
  renderAttachmentChips();
}

/**
 * Adds a large pasted text block as a pending attachment, enforcing the count cap.
 * @param {string} text
 */
function addTextAttachment(text) {
  if (pendingAttachments.length >= MAX_ATTACHMENTS) {
    showAttachmentError(t('attachments.maxAttachments', { max: MAX_ATTACHMENTS }));
    return;
  }
  pasteTextCounter += 1;
  const lines = text.split('\n').length;
  pendingAttachments.push({
    id: crypto.randomUUID(),
    type: 'text',
    name: t('attachments.pastedText', { count: lines, n: pasteTextCounter, lines }),
    data: text,
    size: text.length,
  });
  renderAttachmentChips();
}

/**
 * Whether a pasted plain-text string is large enough to become an attachment
 * chip instead of being dumped inline into the textarea.
 * @param {string} text
 * @returns {boolean}
 */
function isLargePaste(text) {
  return text.length > PASTE_TEXT_CHAR_THRESHOLD || text.split('\n').length > PASTE_TEXT_LINE_THRESHOLD;
}

/**
 * Re-renders the pending-attachment chip row from `pendingAttachments`.
 */
function renderAttachmentChips() {
  attachmentChips.innerHTML = '';
  attachmentChips.hidden = pendingAttachments.length === 0;
  for (const att of pendingAttachments) {
    const chip = document.createElement('div');
    chip.className = 'attachment-chip';
    chip.dataset.testid = 'attachment-chip';
    chip.innerHTML = att.type === 'image'
      ? `<img class="attachment-chip-thumb" src="data:${att.mediaType};base64,${att.data}" alt="">
         <span class="attachment-chip-label">${escHtml(att.name)}</span>
         <button type="button" class="attachment-chip-remove" data-testid="attachment-chip-remove">×</button>`
      : `<span class="attachment-chip-icon">📄</span>
         <span class="attachment-chip-label">${escHtml(att.name)}</span>
         <button type="button" class="attachment-chip-remove" data-testid="attachment-chip-remove">×</button>`;
    chip.querySelector('.attachment-chip-remove').addEventListener('click', () => {
      pendingAttachments = pendingAttachments.filter((a) => a.id !== att.id);
      renderAttachmentChips();
    });
    attachmentChips.appendChild(chip);
  }
}

msgInput.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items ?? [];
  let capturedImage = false;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const file = item.getAsFile();
      if (file) addImageAttachment(file);
      capturedImage = true;
    }
  }
  if (capturedImage) return;

  const text = e.clipboardData?.getData('text/plain') ?? '';
  if (isLargePaste(text)) {
    e.preventDefault();
    addTextAttachment(text);
  }
});

inputArea.addEventListener('dragover', (e) => e.preventDefault());
inputArea.addEventListener('drop', (e) => {
  e.preventDefault();
  for (const file of e.dataTransfer?.files ?? []) {
    if (file.type.startsWith('image/')) addImageAttachment(file);
  }
});

// ─── Input handling ───────────────────────────────────────────────────────────

/**
 * Resets the composer back to empty — shared by a normal send and a
 * successful schedule submission, since both consume whatever was typed.
 */
function clearComposer() {
  msgInput.value = '';
  pendingAttachments = [];
  renderAttachmentChips();
  hideMentionDropdown();
  msgInput.style.height = 'auto';
}

function submitMessage() {
  const content = msgInput.value.trim();
  if ((!content && pendingAttachments.length === 0) || !activeChatId) return;
  sendMessage(activeChatId, content, pendingAttachments);
  clearComposer();
}

msgInput.addEventListener('input', () => {
  // Auto-resize textarea
  msgInput.style.height = 'auto';
  msgInput.style.height = Math.min(msgInput.scrollHeight, 140) + 'px';
  updateComposerDropdown();
});

msgInput.addEventListener('keydown', (e) => {
  if (!mentionDropdown.hidden) {
    const items = mentionDropdown.querySelectorAll('.mention-item');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      mentionFocusIdx = Math.min(mentionFocusIdx + 1, items.length - 1);
      items.forEach((el, i) => el.classList.toggle('focused', i === mentionFocusIdx));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      mentionFocusIdx = Math.max(mentionFocusIdx - 1, 0);
      items.forEach((el, i) => el.classList.toggle('focused', i === mentionFocusIdx));
      return;
    }
    if (e.key === 'Enter' && mentionFocusIdx >= 0) {
      e.preventDefault();
      const focused = items[mentionFocusIdx];
      if (focused) focused.dispatchEvent(new MouseEvent('mousedown'));
      return;
    }
    if (e.key === 'Escape') {
      hideMentionDropdown();
      return;
    }
  }

  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submitMessage();
  }
});

sendBtn.addEventListener('click', submitMessage);

// ─── Sidebar events ───────────────────────────────────────────────────────────

newChatBtn.addEventListener('click', () => {
  newChatForm.hidden = !newChatForm.hidden;
  if (!newChatForm.hidden) newChatInput.focus();
});

newChatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = newChatInput.value.trim();
  if (!name) return;
  newChatInput.value = '';
  newChatForm.hidden = true;
  await createChat(name);
});

newChatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') newChatForm.hidden = true;
});

// ─── Agent panel events ───────────────────────────────────────────────────────

addAgentBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  addAgentMenu.hidden = !addAgentMenu.hidden;
});

document.addEventListener('click', (e) => {
  if (!addAgentMenu.contains(e.target) && e.target !== addAgentBtn) {
    addAgentMenu.hidden = true;
  }
  if (!scheduledPanel.contains(e.target) && e.target !== scheduledBtn) {
    scheduledPanel.hidden = true;
  }
  if (!e.target.closest('.agent-menu-wrap')) {
    closeAllAgentMenus();
  }
});

scheduledBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  scheduledPanel.hidden = !scheduledPanel.hidden;
});

scheduleBtn.addEventListener('click', openScheduleModal);
scheduleClose.addEventListener('click', closeScheduleModal);
scheduleCancel.addEventListener('click', closeScheduleModal);
scheduleOverlay.addEventListener('click', (e) => { if (e.target === scheduleOverlay) closeScheduleModal(); });
scheduleForm.addEventListener('submit', handleScheduleFormSubmit);

settingsBtn.addEventListener('click', openSettingsModal);
settingsClose.addEventListener('click', closeSettingsModal);
settingsCancel.addEventListener('click', closeSettingsModal);
settingsOverlay.addEventListener('click', (e) => { if (e.target === settingsOverlay) closeSettingsModal(); });
settingsForm.addEventListener('submit', handleSettingsFormSubmit);

sidebarToggleBtn.addEventListener('click', () => toggleDrawer(sidebarEl));
agentPanelToggleBtn.addEventListener('click', () => toggleDrawer(agentPanelEl));
drawerBackdrop.addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

newAgentBtn.addEventListener('click', openModal);
modalClose.addEventListener('click', closeModal);
modalCancel.addEventListener('click', closeModal);
modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });
agentForm.addEventListener('submit', handleAgentFormSubmit);
agentNameGenerateBtn.addEventListener('click', () => {
  agentNameInput.value = generateAgentName();
});

agentDirBrowseBtn.addEventListener('click', openFolderBrowser);
browseClose.addEventListener('click', closeFolderBrowser);
browseCancel.addEventListener('click', closeFolderBrowser);
browseOverlay.addEventListener('click', (e) => { if (e.target === browseOverlay) closeFolderBrowser(); });
browsePathGo.addEventListener('click', () => loadBrowseDir(browsePathInput.value.trim()));
browsePathInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    loadBrowseDir(browsePathInput.value.trim());
  }
});
browseSelect.addEventListener('click', () => {
  if (browseCurrentPath) agentDirInput.value = browseCurrentPath;
  closeFolderBrowser();
});

noteClose.addEventListener('click', closeNoteModal);
noteCancel.addEventListener('click', closeNoteModal);
noteOverlay.addEventListener('click', (e) => { if (e.target === noteOverlay) closeNoteModal(); });
noteForm.addEventListener('submit', handleNoteFormSubmit);

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function init() {
  document.title = APP_NAME;
  appTitleEl.textContent = APP_NAME;
  appVersionEl.textContent = `v${APP_VERSION}`;

  renderColorGrid(colorGrid, selectedColor, (c) => { selectedColor = c; });

  const [agentsRes, chatsRes, settingsRes] = await Promise.all([
    fetch('/api/agents'),
    fetch('/api/chats'),
    fetch('/api/settings'),
  ]);
  agents = await agentsRes.json();
  userSettings = await settingsRes.json();
  chats = await chatsRes.json();

  currentLocale = userSettings.locale ?? DEFAULT_LOCALE;
  applyTranslations();
  applyTheme(userSettings.theme ?? 'dark');

  renderChatList();
  renderAgentPanel();
  connectWs();

  // Restore whichever chat was last active in this tab (e.g. after a
  // refresh), rather than always landing back on "no chat selected".
  const storedChatId = sessionStorage.getItem(ACTIVE_CHAT_STORAGE_KEY);
  if (storedChatId && chats.some((c) => c.id === storedChatId)) {
    await selectChat(storedChatId);
  } else if (storedChatId) {
    // Stale entry (chat since deleted) — drop it rather than trying to
    // restore something that no longer exists.
    sessionStorage.removeItem(ACTIVE_CHAT_STORAGE_KEY);
  }
}

init();
