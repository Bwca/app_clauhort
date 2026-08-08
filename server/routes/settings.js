/**
 * @fileoverview REST routes for user-configurable settings.
 * Mounted at /api/settings.
 */

import { Router } from 'express';
import { getUserDisplayName, setUserDisplayName, getUserColor, setUserColor, getUserLocale, setUserLocale } from '../store/db.js';
import { SUPPORTED_LOCALES } from '../public/i18n/index.js';
import { t } from '../i18n/t.js';

const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

const router = Router();

/**
 * GET /api/settings
 * Returns current settings.
 */
router.get('/', (_req, res) => {
  res.json({ userDisplayName: getUserDisplayName(), userColor: getUserColor(), locale: getUserLocale() });
});

/**
 * PUT /api/settings
 * Updates settings.
 * @param {Object} req.body
 * @param {string} req.body.userDisplayName - New display name for the user
 * @param {string} req.body.userColor - New message color, hex e.g. "#a6adc8"
 * @param {string} req.body.locale - New UI language, e.g. "en-CA" or "fr-CA"
 */
router.put('/', async (req, res) => {
  const userDisplayName = typeof req.body.userDisplayName === 'string' ? req.body.userDisplayName.trim() : '';
  if (!userDisplayName) return res.status(400).json({ error: t('errors.displayNameRequired') });

  const userColor = req.body.userColor;
  if (userColor !== undefined && !HEX_COLOR_RE.test(userColor)) {
    return res.status(400).json({ error: t('errors.invalidColor') });
  }

  const locale = req.body.locale;
  if (locale !== undefined && !SUPPORTED_LOCALES.includes(locale)) {
    return res.status(400).json({ error: t('errors.invalidLocale', { locales: SUPPORTED_LOCALES.join(', ') }) });
  }

  await setUserDisplayName(userDisplayName);
  if (userColor !== undefined) await setUserColor(userColor);
  if (locale !== undefined) await setUserLocale(locale);
  res.json({ userDisplayName, userColor: getUserColor(), locale: getUserLocale() });
});

export default router;
