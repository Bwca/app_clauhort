/**
 * @fileoverview REST routes for chat CRUD, member management, and scheduled
 * messages. Mounted at /api/chats. A factory (not a plain router) because
 * the scheduled-message POST handler needs `wss` to arm a live timer via
 * services/scheduler.js's scheduleTimer.
 */

import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  getChats,
  getChat,
  createChat,
  updateChat,
  deleteChat,
  addChatMember,
  removeChatMember,
  getMessages,
  getMessageCount,
  getMessagesPage,
  searchMessages,
  getMessagesAround,
  getAgent,
  getAgentChatId,
  getScheduledMessages,
  getScheduledMessage,
  createScheduledMessage,
  updateScheduledMessage,
} from '../store/db.js';
import { scheduleTimer, cancelScheduledMessage } from '../services/scheduler.js';
import { spawnForAgent, killAgent } from '../services/agentProcessManager.js';
import { t } from '../i18n/t.js';

/**
 * @param {import('ws').WebSocketServer} wss
 * @returns {import('express').Router}
 */
export default function createChatsRouter(wss) {
  const router = Router();

  /**
   * If `agentId` already belongs to a chat other than `targetChatId`, returns
   * a translated error string naming both the agent and that other chat.
   * Returns null when the add is fine (agent is free, or already in exactly
   * this same chat — the idempotent re-add path). Agents belong to at most
   * one chat at a time (see getAgentChatId's docs), so re-adding to a
   * *different* chat means moving it, which isn't allowed without first
   * removing it from the one it's in.
   * @param {string} agentId
   * @param {string} targetChatId
   * @returns {string | null}
   */
  function crossChatConflictError(agentId, targetChatId) {
    const busyChatId = getAgentChatId(agentId);
    if (!busyChatId || busyChatId === targetChatId) return null;
    const agent = getAgent(agentId);
    const busyChat = getChat(busyChatId);
    return t('errors.agentAlreadyInChat', { name: agent?.name ?? agentId, chatName: busyChat?.name ?? '' });
  }

  /**
   * GET /api/chats
   * Returns all chats.
   */
  router.get('/', (_req, res) => {
    res.json(getChats());
  });

  /**
   * GET /api/chats/:id
   * Returns a single chat by ID.
   */
  router.get('/:id', (req, res) => {
    const chat = getChat(req.params.id);
    if (!chat) return res.status(404).json({ error: t('errors.chatNotFound') });
    res.json(chat);
  });

  /**
   * POST /api/chats
   * Creates a new chat.
   * @param {Object} req.body
   * @param {string} req.body.name - Chat room name
   * @param {string[]} [req.body.memberAgentIds] - Initial agent members
   */
  router.post('/', async (req, res) => {
    const { name, memberAgentIds = [] } = req.body;
    if (!name) return res.status(400).json({ error: t('errors.chatNameRequired') });
    // This new chat doesn't exist yet, so any agent in memberAgentIds that
    // already belongs to ANY chat is necessarily a conflict — no id to
    // compare against yet, so pass a target that can never match a real chat.
    for (const agentId of memberAgentIds) {
      const conflict = crossChatConflictError(agentId, null);
      if (conflict) return res.status(400).json({ error: conflict });
    }
    const chat = await createChat({ id: uuidv4(), name, memberAgentIds });
    // Eager-spawn each member's persistent process now rather than waiting
    // for its first message — best-effort, spawnForAgent swallows its own
    // failures (see its docs).
    for (const agentId of memberAgentIds) {
      const agent = getAgent(agentId);
      if (agent) spawnForAgent(agent);
    }
    res.status(201).json(chat);
  });

  /**
   * PATCH /api/chats/:id
   * Updates a chat's mutable settings.
   * @param {Object} req.body
   * @param {string} [req.body.name]
   * @param {boolean} [req.body.freeRelay] - When true, the agent-to-agent
   *   delegation relay in this chat is no longer depth-capped at one hop
   *   (see updateChat's docs in db.js and the relay loop in ws/handler.js).
   * @param {boolean} [req.body.autoContinue] - When true, a session-limit
   *   error auto-arms a scheduled "please continue" nudge for the affected
   *   agent (see updateChat's docs in db.js and runAgentsParallel's catch
   *   block in ws/handler.js).
   */
  router.patch('/:id', async (req, res) => {
    const { name, freeRelay, autoContinue } = req.body;
    const chat = await updateChat(req.params.id, { name, freeRelay, autoContinue });
    if (!chat) return res.status(404).json({ error: t('errors.chatNotFound') });
    res.json(chat);
  });

  /**
   * DELETE /api/chats/:id
   * Deletes a chat and all its messages.
   */
  router.delete('/:id', async (req, res) => {
    // Captured before deletion — deleteChat's return value is just a
    // boolean, and killAgent needs to know who WAS in this chat.
    const memberAgentIds = getChat(req.params.id)?.memberAgentIds ?? [];
    const deleted = await deleteChat(req.params.id);
    if (!deleted) return res.status(404).json({ error: t('errors.chatNotFound') });
    // Mirrors deleteChat's own resumeId reset (db.js) — the live process is
    // the other place that session now lives.
    await Promise.all(memberAgentIds.map((agentId) => killAgent(agentId)));
    res.status(204).end();
  });

  /**
   * POST /api/chats/:id/members
   * Adds an agent to a chat.
   * @param {Object} req.body
   * @param {string} req.body.agentId - Agent UUID to add
   */
  router.post('/:id/members', async (req, res) => {
    const { agentId } = req.body;
    if (!agentId) return res.status(400).json({ error: t('errors.agentIdRequired') });
    const conflict = crossChatConflictError(agentId, req.params.id);
    if (conflict) return res.status(400).json({ error: conflict });
    const chat = await addChatMember(req.params.id, agentId);
    if (!chat) return res.status(404).json({ error: t('errors.chatNotFound') });
    const agent = getAgent(agentId);
    if (agent) spawnForAgent(agent);
    res.json(chat);
  });

  /**
   * DELETE /api/chats/:id/members/:agentId
   * Removes an agent from a chat.
   */
  router.delete('/:id/members/:agentId', async (req, res) => {
    // removeChatMember returns the chat even on a no-op double-remove (the
    // agent already wasn't a member) — captured here so killAgent only
    // fires on an ACTUAL removal, mirroring removeChatMember's own
    // changes>0-gated resumeId reset (db.js). Skipping this check could
    // otherwise kill a live process out from under some OTHER chat this
    // agent is actually still in.
    const wasMember = getChat(req.params.id)?.memberAgentIds.includes(req.params.agentId) ?? false;
    const chat = await removeChatMember(req.params.id, req.params.agentId);
    if (!chat) return res.status(404).json({ error: t('errors.chatNotFound') });
    if (wasMember) await killAgent(req.params.agentId);
    res.json(chat);
  });

  /**
   * GET /api/chats/:id/messages
   * Without `page`: returns the most-recent-N window (unchanged behavior,
   * still what ws/handler.js's own direct getMessages calls rely on for
   * turn context — this route is a separate consumer of the same function).
   * @param {string} [req.query.limit] - Max number of messages (default 50)
   * @param {string} [req.query.before] - Message ID to paginate before
   *
   * With `page`: forum-thread-style pagination instead — page 1 is the
   * OLDEST messages, ordered oldest-first, sized by `pageSize`. `page` may
   * also be the literal string "last" to fetch whichever page is currently
   * the final one, without the caller needing to already know totalPages.
   * The resolved page/totalPages/totalMessages/pageSize come back as
   * response headers (X-Page, X-Total-Pages, X-Total-Messages,
   * X-Page-Size) rather than reshaping the JSON body, so this stays a
   * plain Message[] either way — existing callers of the no-`page` form
   * (including tests) don't have to change.
   * @param {string} [req.query.page] - 1-indexed page number, or "last"
   * @param {string} [req.query.pageSize] - Messages per page (default 50)
   */
  router.get('/:id/messages', (req, res) => {
    const chat = getChat(req.params.id);
    if (!chat) return res.status(404).json({ error: t('errors.chatNotFound') });

    if (req.query.page !== undefined) {
      const pageSize = parseInt(req.query.pageSize, 10) || 50;
      const totalMessages = getMessageCount(req.params.id);
      const totalPages = Math.max(1, Math.ceil(totalMessages / pageSize));
      const requestedPage = req.query.page === 'last' ? totalPages : parseInt(req.query.page, 10);
      const page = Number.isFinite(requestedPage) ? Math.min(Math.max(requestedPage, 1), totalPages) : totalPages;
      res.set({
        'X-Page': String(page),
        'X-Total-Pages': String(totalPages),
        'X-Total-Messages': String(totalMessages),
        'X-Page-Size': String(pageSize),
      });
      return res.json(getMessagesPage(req.params.id, page, pageSize));
    }

    const limit = parseInt(req.query.limit, 10) || 50;
    const before = req.query.before;
    const messages = getMessages(req.params.id, limit, before);
    res.json(messages);
  });

  /**
   * GET /api/chats/:id/messages/search
   * Substring-searches a chat's full message history (not just the recently
   * loaded window), newest match first.
   * @param {string} req.query.q - Search text; empty/missing yields []
   * @param {string} [req.query.limit] - Max results (default 30)
   */
  router.get('/:id/messages/search', (req, res) => {
    const chat = getChat(req.params.id);
    if (!chat) return res.status(404).json({ error: t('errors.chatNotFound') });
    const q = (req.query.q ?? '').trim();
    if (!q) return res.json([]);
    const limit = parseInt(req.query.limit, 10) || 30;
    res.json(searchMessages(req.params.id, q, limit));
  });

  /**
   * GET /api/chats/:id/messages/context/:messageId
   * Returns the messages immediately surrounding one message (itself
   * included), so a search result outside the currently-loaded window can
   * be jumped to directly.
   */
  router.get('/:id/messages/context/:messageId', (req, res) => {
    const chat = getChat(req.params.id);
    if (!chat) return res.status(404).json({ error: t('errors.chatNotFound') });
    const messages = getMessagesAround(req.params.id, req.params.messageId);
    if (messages.length === 0) return res.status(404).json({ error: t('errors.messageNotFound') });
    res.json(messages);
  });

  /**
   * GET /api/chats/:id/scheduled-messages
   * Returns a chat's pending scheduled messages, soonest first.
   */
  router.get('/:id/scheduled-messages', (req, res) => {
    const chat = getChat(req.params.id);
    if (!chat) return res.status(404).json({ error: t('errors.chatNotFound') });
    res.json(getScheduledMessages(req.params.id));
  });

  /**
   * POST /api/chats/:id/scheduled-messages
   * Schedules a message to be sent to this chat later. Targeting (a
   * specific @mentioned agent, or everyone) is resolved fresh at fire
   * time — same as a live message — not stored here.
   * @param {Object} req.body
   * @param {string} [req.body.content]
   * @param {import('../store/db.js').Attachment[]} [req.body.attachments]
   * @param {string} req.body.sendAt - ISO 8601 timestamp, must be in the future
   */
  router.post('/:id/scheduled-messages', async (req, res) => {
    const chat = getChat(req.params.id);
    if (!chat) return res.status(404).json({ error: t('errors.chatNotFound') });

    const { content = '', attachments = [], sendAt } = req.body;
    if (!content.trim() && attachments.length === 0) {
      return res.status(400).json({ error: t('errors.scheduledContentRequired') });
    }
    const sendAtMs = Date.parse(sendAt);
    if (Number.isNaN(sendAtMs) || sendAtMs <= Date.now()) {
      return res.status(400).json({ error: t('errors.scheduledSendAtPast') });
    }

    const row = await createScheduledMessage({
      id: uuidv4(),
      chatId: req.params.id,
      content,
      attachments,
      sendAt: new Date(sendAtMs).toISOString(),
    });
    scheduleTimer(row, wss);
    res.status(201).json(row);
  });

  /**
   * PATCH /api/chats/:id/scheduled-messages/:scheduledId
   * Modifies a pending scheduled message's content/attachments/send time
   * before it fires, re-arming its timer for the (possibly new) time.
   * 404s if it already fired or was canceled out from under this request.
   * Same validation as creating one — see the POST handler above.
   * @param {Object} req.body
   * @param {string} [req.body.content]
   * @param {import('../store/db.js').Attachment[]} [req.body.attachments]
   * @param {string} req.body.sendAt - ISO 8601 timestamp, must be in the future
   */
  router.patch('/:id/scheduled-messages/:scheduledId', async (req, res) => {
    const existing = getScheduledMessage(req.params.scheduledId);
    if (!existing || existing.chatId !== req.params.id) {
      return res.status(404).json({ error: t('errors.scheduleNotFound') });
    }

    const { content = '', attachments = [], sendAt } = req.body;
    if (!content.trim() && attachments.length === 0) {
      return res.status(400).json({ error: t('errors.scheduledContentRequired') });
    }
    const sendAtMs = Date.parse(sendAt);
    if (Number.isNaN(sendAtMs) || sendAtMs <= Date.now()) {
      return res.status(400).json({ error: t('errors.scheduledSendAtPast') });
    }

    const row = await updateScheduledMessage(req.params.scheduledId, {
      content,
      attachments,
      sendAt: new Date(sendAtMs).toISOString(),
    });
    if (!row) return res.status(404).json({ error: t('errors.scheduleNotFound') });
    scheduleTimer(row, wss);
    res.json(row);
  });

  /**
   * DELETE /api/chats/:id/scheduled-messages/:scheduledId
   * Cancels a pending scheduled message before it fires.
   */
  router.delete('/:id/scheduled-messages/:scheduledId', async (req, res) => {
    const existing = getScheduledMessage(req.params.scheduledId);
    if (!existing || existing.chatId !== req.params.id) {
      return res.status(404).json({ error: t('errors.scheduleNotFound') });
    }
    await cancelScheduledMessage(req.params.scheduledId);
    res.status(204).end();
  });

  return router;
}
