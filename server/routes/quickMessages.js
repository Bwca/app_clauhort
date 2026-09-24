/**
 * @fileoverview REST routes for quick messages — saved snippets the user can
 * insert into the composer instead of re-typing something they send often.
 * Global (not per-chat), same reasoning as user settings. Mounted at
 * /api/quick-messages.
 */

import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getQuickMessages, createQuickMessage, updateQuickMessage, deleteQuickMessage } from '../store/db.js';
import { t } from '../i18n/t.js';

const router = Router();

/**
 * GET /api/quick-messages
 * Returns every saved quick message, oldest first.
 */
router.get('/', (_req, res) => {
  res.json(getQuickMessages());
});

/**
 * POST /api/quick-messages
 * Creates a new quick message.
 * @param {Object} req.body
 * @param {string} req.body.text - The message text to save
 */
router.post('/', async (req, res) => {
  const text = typeof req.body.text === 'string' ? req.body.text.trim() : '';
  if (!text) return res.status(400).json({ error: t('errors.quickMessageTextRequired') });
  const quickMessage = await createQuickMessage({ id: uuidv4(), text });
  res.status(201).json(quickMessage);
});

/**
 * PATCH /api/quick-messages/:id
 * Updates a quick message's text.
 * @param {Object} req.body
 * @param {string} req.body.text - The new message text
 */
router.patch('/:id', async (req, res) => {
  const text = typeof req.body.text === 'string' ? req.body.text.trim() : '';
  if (!text) return res.status(400).json({ error: t('errors.quickMessageTextRequired') });
  const quickMessage = await updateQuickMessage(req.params.id, text);
  if (!quickMessage) return res.status(404).json({ error: t('errors.quickMessageNotFound') });
  res.json(quickMessage);
});

/**
 * DELETE /api/quick-messages/:id
 * Deletes a quick message.
 */
router.delete('/:id', async (req, res) => {
  const deleted = await deleteQuickMessage(req.params.id);
  if (!deleted) return res.status(404).json({ error: t('errors.quickMessageNotFound') });
  res.status(204).end();
});

export default router;
