/**
 * @fileoverview Renders agent message content (real markdown from Claude)
 * as safe HTML, via the vendored `marked` parser. Configured to neutralize
 * the two real injection vectors a naive setup would leave open:
 *
 * - Raw HTML in the source (`<script>...`, `<img onerror=...>`) is escaped
 *   to literal text instead of being parsed as markup — confirmed
 *   empirically that marked passes raw HTML through unmodified otherwise.
 * - Link/image URLs are checked against a scheme allowlist — confirmed
 *   empirically that marked does NOT sanitize `javascript:` hrefs on its
 *   own; anything not http(s)/mailto/relative is replaced with `#`.
 *
 * Not app.js's own concern — this module has no dependency on it, so it
 * keeps its own tiny copy of the same 4-entity escaping app.js uses.
 */

import { marked, Renderer } from './vendor/marked.esm.js';

/**
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

/** Anything not matching this is treated as unsafe and replaced with "#". */
const SAFE_URL = /^(https?:|mailto:|#|\/|\.)/i;

/**
 * @param {string} href
 * @returns {string}
 */
function safeHref(href) {
  const trimmed = String(href ?? '').trim();
  return SAFE_URL.test(trimmed) ? trimmed : '#';
}

const renderer = new Renderer();

renderer.html = ({ text }) => escHtml(text);

renderer.link = function link({ href, title, tokens }) {
  const text = this.parser.parseInline(tokens);
  const safe = safeHref(href);
  return `<a href="${safe}"${title ? ` title="${escHtml(title)}"` : ''} target="_blank" rel="noopener noreferrer">${text}</a>`;
};

renderer.image = function image({ href, title, text }) {
  const safe = safeHref(href);
  return `<img src="${safe}" alt="${escHtml(text)}"${title ? ` title="${escHtml(title)}"` : ''}>`;
};

// Wraps the table in a scrollable container instead of constraining the
// <table> itself (e.g. via display:block on the table) — that broke the
// browser's normal auto column-width layout, silently clipping a header
// like "Description" instead of either wrapping it or making it reachable
// via scroll. The wrapper scrolls; the table inside keeps its default
// layout, so every column gets exactly the width its content needs.
const defaultTable = Renderer.prototype.table;
renderer.table = function table(token) {
  return `<div class="md-table-wrap">${defaultTable.call(this, token)}</div>`;
};

marked.use({ renderer, gfm: true, breaks: true });

/**
 * Parses `source` as markdown and returns safe HTML.
 *
 * `.trim()` matters beyond cosmetics: marked.parse() appends a trailing
 * newline to its output (`"done"` → `"<p>done</p>\n"`), which would
 * otherwise leak into the rendered element's `.textContent` as a trailing
 * "\n" — breaking any exact-string comparison against an agent's reply.
 * @param {string} source
 * @returns {string}
 */
export function renderMarkdown(source) {
  return marked.parse(source).trim();
}
