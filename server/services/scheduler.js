/**
 * @fileoverview Fires scheduled messages at their chosen time.
 * A scheduled message's whole job is to eventually replay as a normal
 * USER_MESSAGE — @mention targeting (a specific agent, or everyone) is
 * resolved fresh at fire time by handleUserMessage/parseResponders, exactly
 * as it would be for a message typed live, so there's no separate
 * "who responds" logic here.
 */

import {
  getAllScheduledMessages,
  deleteScheduledMessageIfExists,
} from '../store/db.js';
import { handleUserMessage, broadcast } from '../ws/handler.js';

/**
 * setTimeout's delay is a signed 32-bit int under the hood — anything past
 * this fires (or overflows) immediately instead of waiting. armTimer chains
 * itself at this cap for anything scheduled further out.
 */
const MAX_DELAY = 2_147_483_647;

/**
 * Currently-armed timers, keyed by scheduled-message id. A no-op cancel
 * (already fired, or never existed) is simply absent from this map.
 * @type {Map<string, NodeJS.Timeout>}
 */
const timers = new Map();

/**
 * Sends a scheduled message's content through the exact same path a live
 * USER_MESSAGE takes. No-ops if the row is already gone — canceled, or
 * already fired by a race with cancelScheduledMessage (see
 * deleteScheduledMessageIfExists's docs for why that's race-free).
 * @param {string} id
 * @param {import('ws').WebSocketServer} wss
 * @returns {Promise<void>}
 */
async function fireScheduledMessage(id, wss) {
  timers.delete(id);
  const row = await deleteScheduledMessageIfExists(id);
  if (!row) return;

  broadcast(wss, { type: 'SCHEDULED_MESSAGE_FIRED', chatId: row.chatId, id });
  await handleUserMessage(
    { type: 'USER_MESSAGE', chatId: row.chatId, content: row.content, attachments: row.attachments },
    wss
  );
}

/**
 * Arms (or re-arms) an in-memory timer for a pending scheduled message.
 * Clears any timer already armed for this id first — without this, calling
 * armTimer a second time for the same id (e.g. rescheduling to a new time)
 * would leave the OLD timeout still live underneath the new one, since
 * setting a new Map entry doesn't cancel the handle the old one held; the
 * stale timer would then fire fireScheduledMessage at the original time
 * with the message's since-edited content. Delays beyond MAX_DELAY chain
 * through an intermediate wakeup instead of overflowing; an already-overdue
 * sendAt (e.g. the server was down past it) fires almost immediately
 * rather than being treated as an error.
 * @param {import('../store/db.js').ScheduledMessage} row
 * @param {import('ws').WebSocketServer} wss
 * @returns {void}
 */
function armTimer(row, wss) {
  const existing = timers.get(row.id);
  if (existing) clearTimeout(existing);

  const delay = new Date(row.sendAt).getTime() - Date.now();
  if (delay > MAX_DELAY) {
    timers.set(row.id, setTimeout(() => armTimer(row, wss), MAX_DELAY));
    return;
  }
  timers.set(row.id, setTimeout(() => fireScheduledMessage(row.id, wss), Math.max(delay, 0)));
}

/**
 * Persists nothing itself — callers create or update the DB row first —
 * this just (re-)arms the in-memory timer for it. Called right after a
 * scheduled message is created or modified via the REST endpoints.
 * @param {import('../store/db.js').ScheduledMessage} row
 * @param {import('ws').WebSocketServer} wss
 * @returns {void}
 */
export function scheduleTimer(row, wss) {
  armTimer(row, wss);
}

/**
 * Cancels a pending scheduled message: clears its in-memory timer (if still
 * armed) and deletes its DB row. Safe to call even if it already fired —
 * deleteScheduledMessageIfExists simply returns null in that case.
 * @param {string} id
 * @returns {Promise<import('../store/db.js').ScheduledMessage | null>}
 */
export async function cancelScheduledMessage(id) {
  const handle = timers.get(id);
  if (handle) {
    clearTimeout(handle);
    timers.delete(id);
  }
  return deleteScheduledMessageIfExists(id);
}

/**
 * Re-arms a timer for every scheduled message still pending in the DB —
 * called once at server startup so schedules survive a restart, since
 * armed timers themselves are purely in-memory and don't.
 * @param {import('ws').WebSocketServer} wss
 * @returns {void}
 */
export function initScheduler(wss) {
  for (const row of getAllScheduledMessages()) armTimer(row, wss);
}
