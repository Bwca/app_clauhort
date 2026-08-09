/**
 * @fileoverview Optional, opt-in plain-text transcript log — captures the
 * exact content sent to and received from each agent, per chat, for
 * debugging without needing to `claude --resume` a session in a real
 * terminal to see what it actually saw. Off by default: set
 * APP_TRANSCRIPT_LOG (any truthy value) to enable.
 *
 * Deliberately separate from the structured operational logger
 * (logger.js), for two reasons: this can contain full conversation
 * content — more sensitive than anything logger.js captures (agent/process
 * lifecycle, MCP status, request metadata) — so it needs its own explicit
 * opt-in rather than inheriting logger.js's always-on-by-default behavior;
 * and it's plain text, not JSON, since the whole point is a human reading
 * a multi-line system preamble or reply directly, not grepping/parsing it
 * the way the structured log is meant to be consumed.
 */

import { appendFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Renders a ContentBlock[] array (see services/agentRunner.js) down to
 * plain text for the transcript — image blocks are noted, not dumped as
 * base64 (that would make the file both huge and unreadable).
 * @param {import('./services/agentRunner.js').ContentBlock[]} content
 * @returns {string}
 */
function renderContent(content) {
  return content
    .map((block) => {
      if (block.type === 'text') return block.text;
      if (block.type === 'image') return '[image attached]';
      return `[${block.type}]`;
    })
    .join('\n\n');
}

/**
 * Appends one entry to `<APP_LOG_DIR>/chats/<chatId>.log` — one file per
 * chat, since the bugs this exists to help debug (agents confused about
 * their identity or roster, a relay misfiring, ...) are chat-level
 * phenomena: you need every agent's sent/received content in that chat,
 * in order, not one agent's history split across the multiple chats it's
 * ever been in.
 *
 * A complete no-op — not even a directory check — when
 * APP_TRANSCRIPT_LOG isn't set. Checked fresh on every call rather than
 * cached at module load, so tests (or a running server) can toggle it
 * without a process restart.
 * @param {{ chatId: string, agentId: string, agentName: string, streamId: string, direction: 'SENT' | 'RECEIVED', content: import('./services/agentRunner.js').ContentBlock[] | string }} entry
 * @returns {void}
 */
export function logTranscript({ chatId, agentId, agentName, streamId, direction, content }) {
  if (!process.env.APP_TRANSCRIPT_LOG) return;

  const logDir = join(process.env.APP_LOG_DIR || join(__dirname, 'logs'), 'chats');
  mkdirSync(logDir, { recursive: true });

  const text = typeof content === 'string' ? content : renderContent(content);
  const header = `${new Date().toISOString()} | ${agentName} (${agentId}) | stream ${streamId} | ${direction}`;
  const divider = '='.repeat(header.length);
  appendFileSync(join(logDir, `${chatId}.log`), `${divider}\n${header}\n${divider}\n${text}\n\n`);
}
