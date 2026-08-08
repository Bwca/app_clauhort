/**
 * @fileoverview WebSocket connection handler.
 * Receives USER_MESSAGE events and orchestrates agent responses.
 */

import { WebSocket, WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { dirname } from 'path';
import { getChat, getAgent, getAgentChatId, getMessages, addMessage, grantAgentPath, grantAgentToolPattern, setAgentResumeIdIfUnset, getUserDisplayName } from '../store/db.js';
import { parseResponders, extractMentionedAgents, parseSkillInvocation } from '../services/messageRouter.js';
import { runAgentStream, FILE_PATH_TOOLS, deriveToolPatterns, dedupePermissionDenials } from '../services/agentRunner.js';
import { killAgent, onBackgroundTurn } from '../services/agentProcessManager.js';
import { t } from '../i18n/t.js';
import { logger } from '../logger.js';
import { logTranscript } from '../transcriptLog.js';

const log = logger.child({ component: 'ws:handler' });

/**
 * Live streams that could still be interrupted, keyed by streamId. Populated
 * for the duration of each runAgentStream() call in runAgentsParallel and
 * consulted by the STOP_AGENT handler below — a stream not in this map has
 * already finished (or never existed), so a late/duplicate stop is a no-op.
 * @type {Map<string, AbortController>}
 */
const activeStreams = new Map();

/**
 * History-fetch cap for an observer agent's own turn (see runAgentsParallel),
 * overriding the normal 20-message window every other agent gets. An
 * observer (agent.isObserver) never responds to a broadcast — only to an
 * explicit @mention — so it may sit out for a long stretch of a busy chat's
 * traffic; when it's finally asked to summarize, it needs to see all of
 * that, not just the last 20 messages. 1000 is generous headroom over a
 * realistic "whole busy day" for this app's usage, not a literal unlimited
 * fetch — getMessages has no "no limit" mode, and an unbounded SELECT would
 * risk a huge prompt/cost spike on a pathologically long-lived chat.
 */
const OBSERVER_HISTORY_LIMIT = 1000;

/**
 * @typedef {Object} UserMessageEvent
 * @property {'USER_MESSAGE'} type
 * @property {string} chatId
 * @property {string} content
 * @property {import('../store/db.js').Attachment[]} [attachments]
 */

/**
 * @typedef {Object} NewUserMessage
 * @property {string} content
 * @property {import('../store/db.js').Attachment[]} attachments
 */

/**
 * @typedef {Object} MessageSavedEvent
 * @property {'MESSAGE_SAVED'} type
 * @property {string} chatId
 * @property {import('../store/db.js').Message} message
 */

/**
 * @typedef {Object} AgentStreamStartEvent
 * @property {'AGENT_STREAM_START'} type
 * @property {string} chatId
 * @property {string} agentId
 * @property {string} streamId
 * @property {string} agentName
 * @property {string} agentColor
 */

/**
 * @typedef {Object} AgentStreamChunkEvent
 * @property {'AGENT_STREAM_CHUNK'} type
 * @property {string} streamId
 * @property {string} chatId
 * @property {string} agentId
 * @property {string} text
 */

/**
 * @typedef {Object} AgentStreamStatusEvent
 * @property {'AGENT_STREAM_STATUS'} type
 * @property {string} streamId
 * @property {string} chatId
 * @property {string} agentId
 * @property {string} status - Short human label, e.g. "Reading app.js"
 */

/**
 * @typedef {Object} AgentStreamEndEvent
 * @property {'AGENT_STREAM_END'} type
 * @property {string} streamId
 * @property {string} chatId
 * @property {string} agentId
 * @property {string} fullText
 * @property {import('../store/db.js').Message} message - The persisted message,
 *   including its toolCalls (see agentProcessManager.js's ToolCall typedef).
 * @property {import('../services/agentRunner.js').PermissionDenial[]} permissionDenials
 * @property {boolean} stopped - True if the user interrupted this turn via
 *   STOP_AGENT rather than it finishing on its own.
 */

/**
 * @typedef {Object} AgentStreamErrorEvent
 * @property {'AGENT_STREAM_ERROR'} type
 * @property {string} streamId
 * @property {string} chatId
 * @property {string} agentId
 * @property {string} error
 */

/**
 * An agent's persistent process resumed and finished a turn entirely on its
 * own initiative — no user message and no AGENT_STREAM_START/CHUNK ever
 * preceded it, so the client can't replace an existing streaming bubble the
 * way AGENT_STREAM_END does; it just appends this as a new message. See
 * agentProcessManager.js's onBackgroundTurn for the mechanism (a backgrounded
 * Bash task finishing is the common case) and makeBackgroundTurnHandler for
 * where this gets built and broadcast.
 * @typedef {Object} AgentBackgroundMessageEvent
 * @property {'AGENT_BACKGROUND_MESSAGE'} type
 * @property {string} chatId
 * @property {string} agentId
 * @property {import('../store/db.js').Message} message
 * @property {import('../services/agentRunner.js').PermissionDenial[]} permissionDenials
 */

/**
 * Synthetic follow-up sent to an agent right after one of its permission
 * denials is granted. The agent's own turn already ended when the denial
 * surfaced — headless mode has no way to retry mid-turn — so without this
 * nudge nothing happens until the user types a brand new message.
 * @type {NewUserMessage}
 */
const CONTINUE_AFTER_GRANT_MESSAGE = {
  content: 'The permission you needed for that last action has just been granted. Please retry it and continue.',
  attachments: [],
};

/**
 * Synthetic follow-up sent to an agent right after one of its permission
 * denials is explicitly denied by the user (as opposed to granted). Same
 * reasoning as CONTINUE_AFTER_GRANT_MESSAGE — the agent's turn already
 * ended, so without this nudge it's just left stuck — but unlike granting,
 * nothing is persisted here: a denial is already the agent's default
 * state, there's no "revoke" to record. Interpolates the specific
 * tool+value denied, since a turn can carry more than one denial row and
 * the user may deny some while granting others.
 * @param {string} toolName
 * @param {string} value
 * @returns {NewUserMessage}
 */
function buildDenyContinueMessage(toolName, value) {
  return {
    content: `Your request to use ${toolName} (${value}) was declined for now. Please continue with whatever else you can do, or ask for guidance — you're welcome to propose it again later if it's still needed.`,
    attachments: [],
  };
}

/**
 * @typedef {Object} PermissionOutcome
 * @property {string} toolName
 * @property {string} value
 * @property {boolean} granted - True if this row was granted, false if denied.
 */

/**
 * Builds the synthetic follow-up sent once every denial row in a permission
 * card has been resolved (granted or denied) — never before. A single turn
 * can surface more than one denial at once (the model tries several blocked
 * actions, or retries one), and the user works through the card's rows one
 * click at a time; nudging the agent to continue after just the FIRST click
 * would race an auto-continued turn against the user still deciding on the
 * rest of the card. The client tracks how many rows remain and only marks
 * the wire event `autoContinue: true` on whichever click resolves the last
 * one — see buildPermissionCard's resolvedCount tracking — so this is only
 * ever called with the complete, final set of outcomes for that card.
 *
 * A single-row card (the common case) keeps the exact prior wording for
 * that one outcome; a multi-row card gets one combined message listing
 * every outcome, so the agent knows what to retry and what to leave alone.
 * @param {PermissionOutcome[]} outcomes
 * @returns {NewUserMessage}
 */
function buildContinueMessage(rawOutcomes) {
  // The client only ever sends this once every row's own slot is filled
  // (see buildPermissionCard's resolvedCount tracking), so this should
  // never actually contain a gap — filtered defensively anyway, since this
  // reads a client-supplied WS message, a trust boundary worth not
  // crashing the server over.
  const outcomes = rawOutcomes.filter((o) => o && typeof o.toolName === 'string' && typeof o.value === 'string');
  if (outcomes.length === 0) {
    return { content: 'Please continue.', attachments: [] };
  }
  if (outcomes.length === 1) {
    const [{ toolName, value, granted }] = outcomes;
    return granted ? CONTINUE_AFTER_GRANT_MESSAGE : buildDenyContinueMessage(toolName, value);
  }
  const lines = outcomes.map((o) => `- ${o.granted ? 'GRANTED' : 'DECLINED'}: ${o.toolName} (${o.value})`);
  return {
    content: [
      `Here's what happened with the ${outcomes.length} actions that needed your approval:`,
      ...lines,
      ``,
      `For anything GRANTED, go ahead and retry it now. For anything DECLINED, don't retry it — continue with whatever else you can do, or ask for guidance if you're blocked; you're welcome to propose a declined action again later if it's still needed.`,
    ].join('\n'),
    attachments: [],
  };
}

/**
 * Broadcasts a JSON payload to all connected WebSocket clients.
 * @param {WebSocketServer} wss
 * @param {object} payload
 */
export function broadcast(wss, payload) {
  const data = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

/**
 * Renders a short placeholder for an attachment, used when summarizing older
 * messages in the history section (their full content isn't resent every turn).
 * @param {import('../store/db.js').Attachment} att
 * @returns {string}
 */
function summarizeAttachment(att) {
  return att.type === 'image'
    ? `[image: ${att.name ?? 'pasted'}]`
    : `[pasted text: ${att.name ?? 'untitled'}, ${att.data.length} chars]`;
}

/**
 * Renders one history line, appending attachment placeholders (not full content).
 * @param {import('../store/db.js').Message} m
 * @returns {string}
 */
function renderHistoryLine(m) {
  const summary = (m.attachments ?? []).map(summarizeAttachment).join(' ');
  return `${m.authorName}: ${[m.content, summary].filter(Boolean).join(' ')}`;
}

/**
 * Narrows a raw message window down to what a given agent actually needs
 * re-sent as context.
 *
 * Each agent is a real, resumed `claude` CLI session (`--resume`) — once it
 * has a resumeId, Claude already natively remembers every turn where THIS
 * agent was the one invoked (its own past prompts and replies), same as any
 * resumed terminal session. Re-sending that history is pure duplication.
 * The only genuinely new information for a resumed agent is messages it
 * was never invoked for at all — a teammate's reply, or a message routed
 * only to someone else — that happened since its own last turn here.
 *
 * An agent with no resumeId yet has zero session memory, so it needs the
 * full window (its very first turn, or it just joined an existing chat).
 *
 * Note this doesn't just trust `resumeId`'s presence blindly for the
 * narrowing itself — it actually searches `messages` for this agent's own
 * last turn (`lastOwnIdx`). That's what makes this safe even for an agent
 * resumed from a resumeId supplied manually at creation, pointing at a
 * session with no relation to this chat at all (see buildPromptBlocks'
 * docs for why that distinction matters): if no own turn is found in this
 * chat's history, `lastOwnIdx` stays -1 and the full window still goes out,
 * exactly as if it had no resumeId.
 *
 * @param {import('../store/db.js').Agent} agent
 * @param {import('../store/db.js').Message[]} messages - Chronological (oldest first)
 * @returns {import('../store/db.js').Message[]}
 */
export function catchUpMessagesFor(agent, messages) {
  if (!agent.resumeId) return messages;

  let lastOwnIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].agentId === agent.id) { lastOwnIdx = i; break; }
  }
  return messages.slice(lastOwnIdx + 1).filter((m) => m.agentId !== agent.id);
}

/**
 * Formats the chat roster (every member except `agent` itself) the same
 * way in both buildSystemPreamble (the full first-turn introduction) and
 * buildPromptBlocks' standalone roster-refresh note (see its docs) — kept
 * as one function so those two call sites can never drift into describing
 * the roster differently.
 * @param {import('../store/db.js').Agent} agent
 * @param {import('../store/db.js').Agent[]} members - All agents in the chat
 * @returns {string}
 */
function formatRoster(agent, members) {
  const teammates = members.filter((m) => m.id !== agent.id);
  return teammates.length
    ? teammates.map((m) => `  - ${m.name} (working in ${m.workingDir})`).join('\n')
    : '  (none — you are the only agent in this chat)';
}

/**
 * Builds the [System] block that tells an agent who they are, who their
 * teammates are, and how the @mention routing model works. Only needed on
 * an agent's very first turn (see buildPromptBlocks) — confirmed
 * empirically (raw spawn spike, not guessed) that a resumed CLI session
 * keeps following instructions given this way in an earlier invocation
 * without them being restated, the same as it remembers plain conversation
 * content. Resending it every turn was pure duplication, same underlying
 * bug as the history replay in catchUpMessagesFor.
 * @param {import('../store/db.js').Agent} agent
 * @param {import('../store/db.js').Chat} chat
 * @param {import('../store/db.js').Agent[]} members - All agents in the chat
 * @returns {string}
 */
function buildSystemPreamble(agent, chat, members) {
  return [
    `[System]`,
    `You are being added to a chat under the name "${agent.name}" — this is your alias for this`,
    `conversation. If you already have unrelated prior context from another session or task, it's`,
    `still yours and you can draw on it if it's genuinely relevant, but don't let it define who you`,
    `are here: for this chat, you are ${agent.name}, an AI assistant operating in the directory:`,
    `${agent.workingDir}`,
    ``,
    `You are participating in a shared chat called "${chat.name}" with these other AI agents:`,
    formatRoster(agent, members),
    ``,
    `How this multi-agent chat works:`,
    `- The user routes messages using @mentions. If a message @mentions your name, only you respond.`,
    `- If no agent is @mentioned, the message went to everyone, and every teammate is already responding to it independently and in parallel — you don't need to @mention a teammate just to make sure they see or answer something they were already sent directly.`,
    `- To delegate a task to a teammate, write @Name in your response (e.g. "@Claudia please copy the file"). The system will automatically route your request to them so they act on it.`,
    `- Only use @Name to hand off something a teammate wouldn't otherwise already be doing — e.g. a follow-up specific to what YOU just found. Don't @mention someone to ask a question they were already asked directly; they're already independently answering it.`,
    `[/System]`,
  ].join('\n');
}

/**
 * Builds the full content-block array for a single agent response, in the
 * shape expected by the Claude CLI's `--input-format=stream-json` stdin
 * message. Prepends the [System] preamble (see buildSystemPreamble) on an
 * agent's first-ever turn IN THIS CHAT — every later turn skips it, since
 * the CLI session already has it.
 *
 * Deliberately gated on whether `agent.id` appears as the author of any
 * message in `priorMessages`, NOT on `agent.resumeId` — those are different
 * questions. `resumeId` only tells you whether the underlying `claude`
 * session has ANY memory at all; it does NOT tell you whether that memory
 * has anything to do with THIS chat. An agent can be created with a
 * manually-supplied resumeId pointing at a completely unrelated prior
 * session (see routes/agents.js's optional resumeId field) — resumeId-gating
 * would then skip the preamble entirely on its first turn here, leaving it
 * cold-dropped into [Since you last responded]-style catch-up context for a
 * conversation it was never part of, under a name/identity it was never
 * told about. Reported live: exactly that — an agent resumed from an
 * unrelated real session either got visibly confused by unexplained
 * catch-up context, or silently went along with a new identity it had no
 * actual grounding for. Gating on real chat history fixes both: a
 * resumed-from-elsewhere agent now gets properly introduced (as an alias,
 * see buildSystemPreamble) the first time it actually speaks in this chat,
 * exactly like a brand-new agent would.
 *
 * Also prepends whatever catch-up messages this agent doesn't already have
 * (see catchUpMessagesFor — attachments from those older messages are
 * summarized, not resent in full), then the new message's own attachments
 * (sent in full) and its typed text.
 *
 * Whenever there's catch-up content at all, a fresh roster line goes out
 * alongside it too (see formatRoster) — cheap (a few lines, not the whole
 * [System] preamble's @mention-routing essay) but necessary: an agent that
 * already spoke once never gets that essay resent, so without this, its own
 * idea of "who's in this chat" is frozen at whatever the roster was on its
 * LAST turn. Reported live, and made much more likely by the Observer
 * feature specifically (an observer can go a whole day between turns by
 * design — plenty of time for membership to change): a long-dormant agent
 * ends up holding a stale "(none — you are the only agent)" roster while
 * simultaneously reading catch-up content that plainly names teammates it
 * was never told about — a real, visible contradiction it correctly (if
 * confusingly, from the user's side) flagged as looking like injected
 * content. Gated on catch-up existing at all, not sent unconditionally on
 * every turn, for the same reason the full preamble isn't: if nothing
 * happened since this agent's last turn, the roster almost certainly
 * hasn't moved either.
 *

 * @param {import('../store/db.js').Agent} agent - The agent being prompted
 * @param {import('../store/db.js').Chat} chat - The current chat
 * @param {import('../store/db.js').Agent[]} members - All agents in the chat
 * @param {NewUserMessage} newMessage - The new user message
 * @param {import('../store/db.js').Message[]} priorMessages - Recent chat
 *   history. May or may not already include the message newMessage was
 *   derived from, depending on when the caller fetched it — excludeMessageId
 *   is the authoritative way to keep it from being resent twice.
 * @param {string} [excludeMessageId] - The DB id of the message newMessage
 *   was derived from, if it's already been persisted. Filtered out of
 *   priorMessages regardless of fetch timing, so it's never sent once as
 *   catch-up context AND again as this turn's own final content block.
 * @returns {import('../services/agentRunner.js').ContentBlock[]}
 */
export function buildPromptBlocks(agent, chat, members, newMessage, priorMessages, excludeMessageId) {
  const hasSpokenInChat = priorMessages.some((m) => m.agentId === agent.id);
  const systemPreamble = hasSpokenInChat ? '' : buildSystemPreamble(agent, chat, members);

  const filteredPriorMessages = excludeMessageId
    ? priorMessages.filter((m) => m.id !== excludeMessageId)
    : priorMessages;
  const catchUp = catchUpMessagesFor(agent, filteredPriorMessages);
  const sectionLabel = hasSpokenInChat ? 'Since you last responded' : 'Conversation context';
  const contextSection = catchUp.length
    ? `[${sectionLabel}]\n${catchUp.map(renderHistoryLine).join('\n')}\n---`
    : '';
  // Only needed when the full [System] preamble (which already includes an
  // up-to-date roster) wasn't sent, AND there's actually catch-up content to
  // pair it with — see this function's docs for why.
  const rosterNote = hasSpokenInChat && catchUp.length
    ? `[Current chat roster]\n${formatRoster(agent, members)}`
    : '';

  /** @type {import('../services/agentRunner.js').ContentBlock[]} */
  const blocks = [];
  const preambleText = [systemPreamble, rosterNote, contextSection].filter(Boolean).join('\n\n');
  // A resumed agent in a 1:1 chat can legitimately have nothing to prepend
  // at all (no preamble needed, nothing to catch up on) — skip pushing an
  // empty text block rather than sending one, since content blocks with
  // empty text risk rejection.
  if (preambleText) blocks.push({ type: 'text', text: preambleText });

  for (const att of newMessage.attachments ?? []) {
    if (att.type === 'image') {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: att.mediaType, data: att.data } });
    } else if (att.type === 'text') {
      blocks.push({ type: 'text', text: `[${att.name ?? 'Pasted text'}]\n${att.data}` });
    }
  }

  blocks.push({ type: 'text', text: newMessage.content || '(see attached)' });
  return blocks;
}

/**
 * Handles an incoming USER_MESSAGE event.
 * Saves the user message, determines responders, then runs agents sequentially.
 * @param {UserMessageEvent} event
 * @param {WebSocketServer} wss
 * @returns {Promise<void>}
 */
export async function handleUserMessage(event, wss) {
  const { chatId, content, attachments = [] } = event;

  const chat = getChat(chatId);
  if (!chat) return;

  // Captured BEFORE this turn's own message is persisted below, so that
  // message never shows up twice — once here, once as the turn's own final
  // content block (see buildPromptBlocks/runAgentsParallel).
  const priorMessages = getMessages(chatId, 20);

  // Save user message
  /** @type {import('../store/db.js').Message} */
  const userMessage = {
    id: uuidv4(),
    chatId,
    role: 'user',
    agentId: null,
    authorName: getUserDisplayName(),
    content,
    attachments,
    createdAt: new Date().toISOString(),
  };
  await addMessage(userMessage);

  /** @type {MessageSavedEvent} */
  broadcast(wss, { type: 'MESSAGE_SAVED', chatId, message: userMessage });

  // Determine which agents should respond
  const members = chat.memberAgentIds
    .map((id) => getAgent(id))
    .filter(Boolean);

  // "@Name /command ..." invokes that agent's Claude Code skill directly —
  // single-target, and the CLI-facing content is the bare command (stripped
  // of the "@Name " prefix), since the local slash-command parser only
  // recognizes a command when it's the start of the message it sees.
  const skillInvocation = parseSkillInvocation(content, members);
  const responders = skillInvocation ? [skillInvocation.agent] : parseResponders(content, members);
  if (responders.length === 0) return;

  /** @type {NewUserMessage} */
  const originalMessage = { content, attachments };
  /** @type {NewUserMessage} */
  const newMessage = skillInvocation ? { content: skillInvocation.command, attachments } : originalMessage;

  const respondedMessages = await runAgentsParallel(responders, members, chat, newMessage, wss, priorMessages, userMessage.id);

  // Relay: parse the just-saved agent responses for @mentions of teammates who
  // haven't responded yet. Trigger those agents once (depth cap = 1 to prevent loops).
  // Always relays with the ORIGINAL message, never a stripped skill command —
  // a relayed teammate isn't the skill's target, and a bare "/command" as
  // their own final content block would risk misfiring an unrelated skill.
  // Scans only the messages produced by THIS call, not a re-fetched window from
  // the DB — an agent's message from an earlier, unrelated turn can still be
  // among the chat's most recent rows (e.g. it responded then, but not this
  // time), and re-querying by "recent N" would wrongly sweep its old @mention
  // back in as if it were a fresh relay trigger.
  const relaySet = new Map();
  for (const msg of respondedMessages.values()) {
    for (const target of extractMentionedAgents(msg.content, members)) {
      if (!respondedMessages.has(target.id)) relaySet.set(target.id, target);
    }
  }

  if (relaySet.size > 0) {
    // Freshly fetched (not the same priorMessages snapshot) — the just-responded
    // agents' own messages are now persisted, and a relay target's catch-up
    // needs to include those, e.g. the teammate reply that @mentioned it.
    // excludeMessageId is still userMessage.id: originalMessage is the same
    // triggering text, now persisted, so it'd otherwise show up twice here too.
    const relayPriorMessages = getMessages(chatId, 20);
    await runAgentsParallel([...relaySet.values()], members, chat, originalMessage, wss, relayPriorMessages, userMessage.id);
  }
}

/**
 * Builds the handler passed to agentProcessManager's onBackgroundTurn for a
 * given agent: persists and broadcasts a turn the CLI resumed and reported
 * on entirely unprompted — see onBackgroundTurn's own docs for the exact
 * mechanism (a backgrounded Bash task finishing is the common trigger) and
 * AgentBackgroundMessageEvent for the wire shape. This can fire long after
 * whichever runAgentsParallel call originally registered it has already
 * returned, against a chat/agent state that may have changed since — so
 * everything here is looked up fresh at delivery time rather than closed
 * over.
 * @param {string} agentId
 * @param {WebSocketServer} wss
 * @returns {(turn: { text: string, toolCalls: import('../services/agentProcessManager.js').ToolCall[], sessionId: string | null, permissionDenials: import('../services/agentRunner.js').PermissionDenial[] }) => Promise<void>}
 */
function makeBackgroundTurnHandler(agentId, wss) {
  return async ({ text, toolCalls, permissionDenials }) => {
    const agent = getAgent(agentId);
    const chatId = getAgentChatId(agentId);
    // Agent was deleted, or removed from every chat, between whenever this
    // background task was kicked off and it actually finishing — nowhere
    // left to report into.
    if (!agent || !chatId) return;

    /** @type {import('../store/db.js').Message} */
    const agentMessage = {
      id: uuidv4(),
      chatId,
      role: 'agent',
      agentId,
      authorName: agent.name,
      content: text,
      attachments: [],
      toolCalls,
      createdAt: new Date().toISOString(),
    };
    await addMessage(agentMessage);
    log.info({ agentId, chatId }, 'agent reported back on a background task unprompted');

    /** @type {AgentBackgroundMessageEvent} */
    broadcast(wss, {
      type: 'AGENT_BACKGROUND_MESSAGE',
      chatId,
      agentId,
      message: agentMessage,
      permissionDenials: dedupePermissionDenials(permissionDenials),
    });
  };
}

/**
 * Runs a set of agents in parallel, streaming each response as it arrives.
 * Saves every completed response before resolving.
 * Returns the messages produced, keyed by agent ID — not just which agents
 * responded, so callers can inspect content from THIS call only, without
 * re-querying the DB and risking a stale message from an earlier turn.
 *
 * @param {import('../store/db.js').Agent[]} agents
 * @param {import('../store/db.js').Agent[]} allMembers
 * @param {import('../store/db.js').Chat} chat
 * @param {NewUserMessage} userMessage - The triggering user message
 * @param {WebSocketServer} wss
 * @param {import('../store/db.js').Message[]} priorMessages - Recent chat
 *   history. Narrowed per-agent in buildPromptBlocks — see catchUpMessagesFor.
 * @param {string} [excludeMessageId] - Forwarded to buildPromptBlocks — see
 *   its docs for why this is needed alongside priorMessages.
 * @returns {Promise<Map<string, import('../store/db.js').Message>>}
 */
async function runAgentsParallel(agents, allMembers, chat, userMessage, wss, priorMessages, excludeMessageId) {
  const responded = new Map();

  await Promise.allSettled(agents.map(async (agent) => {
    const streamId = uuidv4();
    // An observer needs far more than the normal 20-message catch-up window
    // — see OBSERVER_HISTORY_LIMIT's docs. Fetched fresh per-agent here
    // rather than widening the shared `priorMessages` param for everyone,
    // since normal worker agents already have their own session memory via
    // --resume and re-sending more than the recent window would be pure
    // duplication for them (same reasoning catchUpMessagesFor's own docs
    // give). This single override point covers every caller of
    // runAgentsParallel — the main responders call, the relay call, and the
    // GRANT_PERMISSION/DENY_PERMISSION auto-continue calls — without
    // duplicating the fetch-size decision in each of them.
    const agentPriorMessages = agent.isObserver ? getMessages(chat.id, OBSERVER_HISTORY_LIMIT) : priorMessages;
    const content = buildPromptBlocks(agent, chat, allMembers, userMessage, agentPriorMessages, excludeMessageId);
    logTranscript({ chatId: chat.id, agentId: agent.id, agentName: agent.name, streamId, direction: 'SENT', content });
    const controller = new AbortController();
    activeStreams.set(streamId, controller);
    // Registered before this turn even starts (not just after it ends) —
    // the process this turn spawns/reuses is what might later resume and
    // report on a backgrounded task entirely unprompted, so the handler
    // needs to already be in place for that, however long after this
    // specific turn resolves it happens to fire. Re-registering per turn
    // is cheap (a Map.set) and keeps this agnostic of exactly when in the
    // agent's lifecycle its process first comes alive.
    onBackgroundTurn(agent.id, makeBackgroundTurnHandler(agent.id, wss));

    /** @type {AgentStreamStartEvent} */
    broadcast(wss, {
      type: 'AGENT_STREAM_START',
      chatId: chat.id,
      agentId: agent.id,
      streamId,
      agentName: agent.name,
      agentColor: agent.color,
    });
    log.info({ agentId: agent.id, chatId: chat.id, streamId }, 'turn started');

    try {
      const { text: fullText, permissionDenials, sessionId, stopped, toolCalls } = await runAgentStream({
        agent,
        chatId: chat.id,
        content,
        streamId,
        signal: controller.signal,
        onChunk: (text) => {
          /** @type {AgentStreamChunkEvent} */
          broadcast(wss, {
            type: 'AGENT_STREAM_CHUNK',
            streamId,
            chatId: chat.id,
            agentId: agent.id,
            text,
          });
        },
        onStatus: (status) => {
          /** @type {AgentStreamStatusEvent} */
          broadcast(wss, {
            type: 'AGENT_STREAM_STATUS',
            streamId,
            chatId: chat.id,
            agentId: agent.id,
            status,
          });
        },
      });
      logTranscript({ chatId: chat.id, agentId: agent.id, agentName: agent.name, streamId, direction: 'RECEIVED', content: fullText });

      if (sessionId && !agent.resumeId) {
        const updated = await setAgentResumeIdIfUnset(agent.id, sessionId);
        if (updated) broadcast(wss, { type: 'AGENT_UPDATED', agent: updated });
      }

      /** @type {import('../store/db.js').Message} */
      const agentMessage = {
        id: uuidv4(),
        chatId: chat.id,
        role: 'agent',
        agentId: agent.id,
        authorName: agent.name,
        // A stop right at the very start (before any text streamed) would
        // otherwise persist a blank message — fall back to a placeholder so
        // the chat still shows something happened.
        content: fullText || (stopped ? t('chat.stoppedEmptyPlaceholder') : ''),
        attachments: [],
        toolCalls,
        createdAt: new Date().toISOString(),
      };
      await addMessage(agentMessage);
      responded.set(agent.id, agentMessage);

      const dedupedDenials = dedupePermissionDenials(permissionDenials);
      /** @type {AgentStreamEndEvent} */
      broadcast(wss, {
        type: 'AGENT_STREAM_END',
        streamId,
        chatId: chat.id,
        agentId: agent.id,
        fullText,
        message: agentMessage,
        // Deduped here, not just left to the client's own exact-match guard
        // — this catches the Bash-specific case where two DIFFERENT literal
        // denials (a chain vs. one of its parts, piped vs. unpiped) still
        // derive an overlapping --allowedTools pattern, so granting one
        // already covers the other. Only the server knows CLI pattern
        // syntax well enough to reason about that.
        permissionDenials: dedupedDenials,
        stopped,
      });
      log.info(
        { agentId: agent.id, chatId: chat.id, streamId, stopped, permissionDenials: dedupedDenials.map((d) => d.tool_name) },
        'turn ended'
      );
    } catch (err) {
      /** @type {AgentStreamErrorEvent} */
      broadcast(wss, {
        type: 'AGENT_STREAM_ERROR',
        streamId,
        chatId: chat.id,
        agentId: agent.id,
        error: err.message,
      });
      log.error({ agentId: agent.id, chatId: chat.id, streamId, err }, 'turn errored');
    } finally {
      activeStreams.delete(streamId);
    }
  }));

  return responded;
}

/**
 * Registers event listeners for a new WebSocket connection.
 * @param {WebSocket} ws - The incoming client WebSocket
 * @param {import('http').IncomingMessage} _req
 * @param {WebSocketServer} wss
 */
export function handleConnection(ws, _req, wss) {
  ws.on('message', async (raw) => {
    let event;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (event.type) {
      case 'USER_MESSAGE':
        await handleUserMessage(event, wss);
        break;
      case 'GRANT_PERMISSION': {
        // { type: 'GRANT_PERMISSION', agentId: string, chatId?: string, toolName: string,
        //   value: string, autoContinue: boolean, outcomes?: PermissionOutcome[] }
        // File-path-scoped tools (Write/Edit/Read/NotebookEdit) widen --add-dir
        // scope; everything else (Bash, etc.) derives one or more
        // --allowedTools patterns instead — --add-dir can't authorize a
        // command. A chained Bash command derives a pattern per sub-command
        // (see deriveToolPatterns), so grant each in turn.
        //
        // --add-dir requires an actual DIRECTORY — passing the exact file
        // path (what the denial's tool_input.file_path is) is silently a
        // no-op, confirmed empirically: --add-dir <file> still gets denied,
        // --add-dir <dirname(file)> doesn't. So grant the file's containing
        // directory, not the literal denied value.
        //
        // Persisted unconditionally, regardless of autoContinue — a grant
        // should stick the moment it's clicked, even if sibling rows in the
        // same card are still unresolved (e.g. the tab closes before the
        // user finishes the card). Only the AUTO-CONTINUE nudge below is
        // deferred until the whole card is resolved.
        let agent;
        if (FILE_PATH_TOOLS.includes(event.toolName)) {
          agent = await grantAgentPath(event.agentId, dirname(event.value));
        } else {
          for (const pattern of deriveToolPatterns(event.toolName, event.value)) {
            agent = await grantAgentToolPattern(event.agentId, pattern);
          }
        }
        if (!agent) break;

        // --add-dir/--allowedTools are CLI startup flags, baked into the
        // agent's persistent process at spawn time — a running process has
        // no way to pick up a just-widened grant, so evict it now. The
        // next turn (the auto-continue below, or any later message)
        // respawns fresh with the updated flags, resuming via --resume so
        // no conversation memory is lost. Unconditional (not just when
        // autoContinue is true) — a still-mid-card grant needs this too,
        // or a LATER row's own auto-continue would still run against the
        // stale process.
        await killAgent(agent.id);

        broadcast(wss, { type: 'AGENT_UPDATED', agent });

        // Granting only updates the agent's stored permissions — it doesn't
        // make the already-finished turn retry itself. Auto-continue once
        // every row in this card is resolved (see buildContinueMessage) so
        // the user doesn't have to type a follow-up just to unstick an
        // agent that's sitting there newly-authorized but idle — but not
        // before, so a still-pending sibling row isn't raced against an
        // early retry.
        if (event.autoContinue && event.chatId) {
          const chat = getChat(event.chatId);
          if (chat) {
            const members = chat.memberAgentIds
              .map((id) => (id === agent.id ? agent : getAgent(id)))
              .filter(Boolean);
            const priorMessages = getMessages(event.chatId, 20);
            const outcomes = Array.isArray(event.outcomes) && event.outcomes.length
              ? event.outcomes
              : [{ toolName: event.toolName, value: event.value, granted: true }];
            await runAgentsParallel([agent], members, chat, buildContinueMessage(outcomes), wss, priorMessages);
          }
        }
        break;
      }
      case 'DENY_PERMISSION': {
        // { type: 'DENY_PERMISSION', agentId: string, chatId?: string, toolName: string,
        //   value: string, autoContinue: boolean, outcomes?: PermissionOutcome[] }
        // Unlike GRANT_PERMISSION, nothing is persisted — a denial is
        // already the agent's default state, there's no stored permission
        // to revoke. So there's nothing at all to do here until every row
        // in the card is resolved: only then does this auto-continue the
        // agent's turn, informed of every outcome (see buildContinueMessage).
        if (!event.autoContinue || !event.chatId) break;
        const agent = getAgent(event.agentId);
        const chat = getChat(event.chatId);
        if (!agent || !chat) break;
        const members = chat.memberAgentIds.map((id) => getAgent(id)).filter(Boolean);
        const priorMessages = getMessages(event.chatId, 20);
        const outcomes = Array.isArray(event.outcomes) && event.outcomes.length
          ? event.outcomes
          : [{ toolName: event.toolName, value: event.value, granted: false }];
        await runAgentsParallel([agent], members, chat, buildContinueMessage(outcomes), wss, priorMessages);
        break;
      }
      case 'STOP_AGENT': {
        // { type: 'STOP_AGENT', streamId: string }
        // A no-op if the stream already finished (or never existed) —
        // activeStreams only holds entries for turns still in flight.
        activeStreams.get(event.streamId)?.abort();
        break;
      }
      case 'PING':
        ws.send(JSON.stringify({ type: 'PONG' }));
        break;
    }
  });

  ws.on('error', (err) => {
    log.error({ err }, 'WebSocket error');
  });
}
