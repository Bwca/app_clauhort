/**
 * @fileoverview Shared i18n engine — imported by BOTH the browser (as a
 * static ES module served from server/public/) and the Node server (via a
 * relative import). Keep this file, and the dictionaries it loads,
 * framework-free: no Node APIs (fs/path/process) and no DOM APIs
 * (document/window). That's what lets a single file serve both consumers
 * with zero build step and zero duplication of translated strings.
 */
import enCA from './en-CA.js';
import frCA from './fr-CA.js';

export const DEFAULT_LOCALE = 'en-CA';

export const SUPPORTED_LOCALES = ['en-CA', 'fr-CA'];

export const DICTS = {
  'en-CA': enCA,
  'fr-CA': frCA,
};

/**
 * Looks up `key` in `dict`, interpolating `{token}` placeholders from
 * `params`. If `params.count` is given, the key is first suffixed with
 * `_one` (count === 1) or `_other` (anything else) — a minimal pluralization
 * scheme, sufficient for en-CA/fr-CA which both only distinguish "1" from
 * "everything else". Falls back to the English dictionary, then to the raw
 * key itself, so a missing translation degrades visibly rather than
 * crashing or rendering "undefined".
 * @param {Record<string, string>} dict
 * @param {string} key
 * @param {Record<string, string | number>} [params]
 * @returns {string}
 */
export function translate(dict, key, params = {}) {
  const resolvedKey = params.count !== undefined
    ? key + (params.count === 1 ? '_one' : '_other')
    : key;
  const template = dict[resolvedKey] ?? DICTS[DEFAULT_LOCALE][resolvedKey] ?? resolvedKey;
  return template.replace(/\{(\w+)\}/g, (_, token) => params[token] ?? '');
}
