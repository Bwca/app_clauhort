/**
 * @fileoverview Server-side translation lookup. Sourced from the persisted
 * `locale` setting rather than any per-request state — this is a single-user
 * local app, so "the current language" is global mutable state, same as
 * getUserDisplayName()/getUserColor() in server/store/db.js. Re-reads the
 * setting on every call (cheap, no caching) so a locale change takes effect
 * starting with the very next request, no staleness window.
 */
import { DICTS, DEFAULT_LOCALE, translate } from '../public/i18n/index.js';
import { getUserLocale } from '../store/db.js';

/**
 * Translates `key`, interpolating `params` — see translate() in
 * server/public/i18n/index.js for the exact lookup/pluralization rules.
 * @param {string} key
 * @param {Record<string, string | number>} [params]
 * @returns {string}
 */
export function t(key, params) {
  const dict = DICTS[getUserLocale()] ?? DICTS[DEFAULT_LOCALE];
  return translate(dict, key, params);
}
