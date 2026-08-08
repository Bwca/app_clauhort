/**
 * @fileoverview Owns one persistent `claude` CLI process per agent, kept
 * alive for as long as the agent is in a chat, instead of spawning a fresh
 * one-shot process per turn (the old model in agentRunner.js). This is what
 * lets MCP servers — and anything else expensive to establish — survive
 * across turns instead of being torn down and re-connected on every single
 * message.
 *
 * Confirmed empirically (real `claude` CLI, not assumed): a single
 * `--print --input-format=stream-json --output-format=stream-json` process
 * genuinely handles multiple sequential turns without closing stdin,
 * remembering context with no `--resume` needed between turns of the same
 * live process. Interrupting a turn (SIGINT) still ends the process
 * afterward regardless — handled here as "evict and let the next turn
 * respawn + --resume", the same recovery path already used for a crash.
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { basename } from 'path';
import { t } from '../i18n/t.js';
import { logger } from '../logger.js';

const log = logger.child({ component: 'agentProcessManager' });

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

/**
 * Kills a process, including any children it spawned (an MCP server
 * subprocess, say) — not just the process itself.
 *
 * Windows has no real equivalent of POSIX signals: Node's child.kill()
 * there ignores what the signal actually means and always calls the OS's
 * TerminateProcess() — an unconditional, immediate kill with zero chance
 * for the target to run its own cleanup (confirmed against Node's own
 * docs and multiple nodejs/node issues, e.g. #12378, #22761). On POSIX,
 * `claude` gets a real SIGTERM/SIGINT and tears down its own spawned MCP
 * subprocesses as part of its normal signal handling (confirmed
 * empirically this session). On Windows, that graceful teardown can never
 * happen — the process is just gone. If it had spawned a local MCP
 * server as a child of its own, that child can be orphaned, left holding
 * a port/lock/session state that the NEXT `claude` process (spawned on
 * the next turn, or after a restart) then can't cleanly take over —
 * surfacing as "MCP not connected" with no obvious cause.
 *
 * `taskkill /T /F` doesn't make Windows shutdown graceful (nothing can),
 * but it does kill the whole process tree together rather than leaving
 * grandchildren behind, which is the actual failure mode above.
 * @param {import('child_process').ChildProcess} child
 * @param {string} signal
 * @param {string} agentId - Logged for context, so a platform-specific
 *   issue like the one this function exists for is traceable per-agent.
 * @returns {void}
 */
function killTree(child, signal, agentId) {
  if (process.platform === 'win32') {
    log.debug({ agentId, pid: child.pid }, 'killing process tree via taskkill (win32)');
    // Best-effort: if the process already exited on its own, taskkill
    // just reports "not found" on stderr — nothing to react to either way,
    // since the caller only cares about the tracked child's own 'exit' event.
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']).on('error', () => {});
  } else {
    log.debug({ agentId, pid: child.pid, signal }, 'killing process via signal (posix)');
    child.kill(signal);
  }
}

/**
 * @typedef {Object} ManagedProcess
 * @property {import('child_process').ChildProcess} child
 * @property {string} agentId
 * @property {string} buffer - Partial last line of stdout not yet parsed
 * @property {{ handleEvent: (event: object) => void, handleExit: (code: number|null, sig: string|null) => void } | null} currentTurn
 * @property {TurnAccumulator | null} background - Accumulates events that
 *   arrive while `currentTurn` is null — see handleUnsolicitedEvent.
 * @property {Promise<void>} queue - Chain of pending/running turns, so two
 *   turns never write to this process's stdin concurrently.
 */

/** @type {Map<string, ManagedProcess>} */
const processes = new Map();

/**
 * Handlers registered via onBackgroundTurn, one per agent. See that
 * function's docs for what fires them.
 * @type {Map<string, (turn: { text: string, toolCalls: ToolCall[], sessionId: string | null, permissionDenials: import('./agentRunner.js').PermissionDenial[] }) => void>}
 */
const backgroundTurnHandlers = new Map();

/**
 * @param {ManagedProcess} proc
 * @returns {boolean}
 */
function isAlive(proc) {
  return proc.child.exitCode === null && proc.child.signalCode === null;
}

/**
 * Builds the same CLI args agentRunner.js's runAgentStream always built —
 * see its (now-delegating) docs for the reasoning behind each flag.
 * @param {import('../store/db.js').Agent} agent
 * @returns {string[]}
 */
function buildArgs(agent) {
  const args = [
    '--print',
    '--input-format=stream-json',
    '--output-format=stream-json',
    '--verbose',
  ];
  if (agent.dangerouslySkipPermissions) {
    args.push('--dangerously-skip-permissions');
  } else {
    args.push('--permission-mode', 'acceptEdits');
  }
  args.push('--add-dir', agent.workingDir);
  for (const p of agent.extraAllowedPaths ?? []) {
    args.push('--add-dir', p);
  }
  if (agent.allowedToolPatterns?.length && !agent.dangerouslySkipPermissions) {
    args.push('--allowedTools', agent.allowedToolPatterns.join(' '));
  }
  if (agent.resumeId) {
    args.push(`--resume=${agent.resumeId}`);
  }
  return args;
}

/**
 * Parses a single newline-delimited JSON line from claude CLI stream-json output.
 * @param {string} line
 * @returns {{ type: string, [key: string]: unknown } | null}
 */
function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * Recognizes the CLI's own "MCP OAuth session expired" wording. Confirmed
 * (by inspecting the installed `claude` binary directly) that this text is
 * literally embedded in the CLI itself — but it surfaces to us as ordinary
 * assistant text (the model just relays what the failed tool call told it),
 * not as a distinct stream-json event type we could otherwise key off of.
 *
 * Why this matters: MCP server auth is read fresh only once, at this
 * process's own spawn time (see spawnProcess docs) — it is NEVER re-read
 * for the life of the process. If a user re-authenticates externally
 * (`claude` → `/login` in a real terminal) while this agent's persistent
 * process is still running, that process has no way to notice — it keeps
 * using the stale token it started with, indefinitely, until killed and
 * respawned. Matching on wording is inherently version-fragile, so this
 * stays a narrow, best-effort net rather than the sole safeguard: it lets
 * the *next* turn spawn a fresh process that re-reads current auth from
 * disk, instead of a process wedged on the credentials it saw at spawn.
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeMcpAuthFailure(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return lower.includes('oauth session expired')
    || (lower.includes('failed to authenticate') && lower.includes('could not be'));
}

/**
 * @typedef {Object} ToolCall
 * @property {string} id - The tool_use content block's own id — links it to
 *   its eventual tool_result.
 * @property {string} name - Raw tool name, e.g. "Bash", "Edit", or an MCP
 *   tool's full name like "mcp__linear__list_issues".
 * @property {string} label - Human "what's happening" summary (see
 *   describeToolUse) — the same text already streamed live as
 *   AGENT_STREAM_STATUS, kept here so it's still visible after the fact.
 * @property {string} result - The tool's own output (stdout, file diff,
 *   MCP response, ...), capped via truncateToolResult — empty string if no
 *   matching tool_result ever arrived (e.g. the call was permission-denied).
 * @property {boolean} isError - True if the tool_result reported is_error.
 */

/** Caps a single tool result's stored/displayed size — this is chat
 * transcript chrome, not a log viewer; a multi-megabyte `cat` dump has no
 * business being shipped to the client and persisted in SQLite in full. */
const MAX_TOOL_RESULT_CHARS = 8000;

/**
 * Flattens a tool_result event's `content` (a bare string, OR an array of
 * Anthropic content blocks — text/image/etc., same shape as any other
 * message content) down to one display string.
 * @param {unknown} content
 * @returns {string}
 */
function extractToolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (block?.type === 'text' ? block.text : `[${block?.type ?? 'unknown'}]`))
      .join('\n');
  }
  return '';
}

/**
 * @param {string} text
 * @returns {string}
 */
function truncateToolResult(text) {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n… (truncated)`;
}

/**
 * Turns a tool_use content block into a short, human "what's happening now"
 * label — mirrors the live activity Claude Code itself shows in a terminal.
 * Falls back to the raw tool name for anything unrecognized (custom skills,
 * MCP tools, future built-ins), since the tool set isn't fixed.
 * @param {{ name: string, input?: Record<string, unknown> }} block
 * @returns {string}
 */
function describeToolUse({ name, input }) {
  const baseName = (p) => (typeof p === 'string' && p ? basename(p) : '');
  switch (name) {
    case 'Bash':
      return `Running: ${input?.description || input?.command || '…'}`;
    case 'Read':
      return `Reading ${baseName(input?.file_path) || 'a file'}`;
    case 'Write':
      return `Writing ${baseName(input?.file_path) || 'a file'}`;
    case 'Edit':
    case 'NotebookEdit':
      return `Editing ${baseName(input?.file_path ?? input?.notebook_path) || 'a file'}`;
    case 'Grep':
      return `Searching for "${input?.pattern ?? ''}"`;
    case 'Glob':
      return `Finding files matching "${input?.pattern ?? ''}"`;
    case 'WebFetch':
      return `Fetching ${input?.url ?? 'a page'}`;
    case 'WebSearch':
      return `Searching the web for "${input?.query ?? ''}"`;
    case 'Task':
      return `Delegating: ${input?.description ?? 'a subtask'}`;
    default:
      return `Using ${name}`;
  }
}

/**
 * @typedef {Object} TurnAccumulator
 * @property {string} fullText
 * @property {string} resultText
 * @property {string | null} sessionId
 * @property {import('./agentRunner.js').PermissionDenial[]} permissionDenials
 * @property {Map<string, ToolCall>} toolCalls
 * @property {boolean} done - Set once a `result` event has been fed in.
 * @property {(event: object) => void} handleEvent
 */

/**
 * The text/tool_use/tool_result/result parsing at the heart of a turn —
 * shared by runOneTurn (an explicitly-initiated turn, streamed live via
 * onChunk/onStatus) and handleUnsolicitedEvent (a turn the CLI resumes and
 * runs entirely on its own — see that function's docs). Previously this
 * logic lived only inline in runOneTurn; factored out so both call sites
 * parse the exact same event shapes instead of two copies drifting apart.
 * @param {{ onChunk?: (text: string) => void, onStatus?: (status: string) => void }} [callbacks]
 * @returns {TurnAccumulator}
 */
function createTurnAccumulator({ onChunk, onStatus } = {}) {
  /** @type {TurnAccumulator} */
  const turn = {
    fullText: '',
    resultText: '',
    sessionId: null,
    permissionDenials: [],
    toolCalls: new Map(),
    done: false,
    handleEvent(event) {
      if (typeof event.session_id === 'string') turn.sessionId = event.session_id;

      if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
        for (const block of event.message.content) {
          if (block.type === 'text') {
            const delta = block.text.slice(turn.fullText.length);
            if (delta) {
              turn.fullText = block.text;
              onChunk?.(delta);
            }
          } else if (block.type === 'tool_use') {
            const label = describeToolUse(block);
            onStatus?.(label);
            turn.toolCalls.set(block.id, { id: block.id, name: block.name, label, result: '', isError: false });
          }
        }
      } else if (event.type === 'user' && Array.isArray(event.message?.content)) {
        // Tool results are fed back to the model as a "user" turn (same
        // wire shape the Anthropic API always uses) — this is where the
        // actual output of a tool_use above shows up, matched by id.
        for (const block of event.message.content) {
          if (block.type !== 'tool_result') continue;
          const call = turn.toolCalls.get(block.tool_use_id);
          if (!call) continue;
          call.result = truncateToolResult(extractToolResultText(block.content));
          call.isError = !!block.is_error;
        }
      } else if (event.type === 'result') {
        turn.resultText = typeof event.result === 'string' ? event.result : turn.fullText;
        if (Array.isArray(event.permission_denials) && event.permission_denials.length) {
          turn.permissionDenials = event.permission_denials;
        }
        turn.done = true;
      }
    },
  };
  return turn;
}

/**
 * Registers the handler to call whenever this agent's persistent process
 * produces a full turn's worth of output WITHOUT Chorus having written a
 * new turn to its stdin — i.e. the CLI's own background-task-completion
 * feature resuming and reporting on its own initiative.
 *
 * Confirmed empirically against the real CLI (v2.1.223), not assumed: give
 * an agent "run `sleep 8 && echo done` in the background, tell me you'll
 * let me know once it's done, then end your turn" against a persistent
 * process (stdin kept open, exactly this module's architecture). The first
 * turn resolves normally on its own `result` event, text "I'll let you
 * know...". ~8 seconds later, with NOTHING written to stdin in between, the
 * SAME process unprompted emits: system/background_tasks_changed,
 * system/task_updated, system/task_notification (status: "completed"),
 * then a fresh system/init, a new assistant text event ("The background
 * command finished..."), and its own new result event. Before this
 * function existed, those later events arrived while `proc.currentTurn`
 * was already null (the original turn had long since resolved and cleared
 * it) and were silently dropped on the floor by `proc.currentTurn?.
 * handleEvent(event)` — the agent's promised follow-up never reached the
 * chat, which is the exact bug this module exists to fix. See
 * handleUnsolicitedEvent for where events actually get routed here.
 *
 * One handler per agent; registering again replaces the previous one
 * (ws/handler.js re-registers on every turn it runs — cheap, and keeps
 * this agnostic of exactly when in an agent's lifecycle its process first
 * comes alive).
 * @param {string} agentId
 * @param {(turn: { text: string, toolCalls: ToolCall[], sessionId: string | null, permissionDenials: import('./agentRunner.js').PermissionDenial[] }) => void} handler
 * @returns {void}
 */
export function onBackgroundTurn(agentId, handler) {
  backgroundTurnHandlers.set(agentId, handler);
}

/**
 * Feeds an event that arrived while no explicit turn was in flight
 * (`proc.currentTurn` is null) into a lazily-created accumulator scoped to
 * this unsolicited stretch of output, and — once its `result` lands —
 * hands the finished text/tool calls off to this agent's registered
 * onBackgroundTurn handler, if any. Most events seen here are pure
 * informational chatter (background_tasks_changed, task_updated,
 * task_notification) with no assistant/result pair ever following; those
 * are harmless no-ops, since the accumulator only actually fires its
 * handler on a genuine `result`, and only if it captured real content.
 * @param {ManagedProcess} proc
 * @param {{ type: string, [key: string]: unknown }} event
 * @returns {void}
 */
function handleUnsolicitedEvent(proc, event) {
  if (event.type !== 'assistant' && event.type !== 'user' && event.type !== 'result') return;

  if (!proc.background) proc.background = createTurnAccumulator();
  proc.background.handleEvent(event);
  if (!proc.background.done) return;

  const turn = proc.background;
  proc.background = null;
  if (!turn.fullText && turn.toolCalls.size === 0) return;

  const handler = backgroundTurnHandlers.get(proc.agentId);
  if (!handler) return;
  handler({
    text: turn.resultText || turn.fullText,
    toolCalls: [...turn.toolCalls.values()],
    sessionId: turn.sessionId,
    permissionDenials: turn.permissionDenials,
  });
}

/**
 * Spawns a fresh persistent process for an agent and registers it. Does
 * NOT write anything to stdin — callers decide when a turn actually starts.
 * @param {import('../store/db.js').Agent} agent
 * @returns {ManagedProcess}
 */
function spawnProcess(agent) {
  const resumed = !!agent.resumeId;
  const child = spawn(CLAUDE_BIN, buildArgs(agent), {
    cwd: agent.workingDir,
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  log.info({ agentId: agent.id, agentName: agent.name, pid: child.pid, resumed }, 'agent process spawned');

  // Avoid an unhandled EPIPE if the process exits before/while we write.
  child.stdin.on('error', () => {});
  child.stderr.setEncoding('utf-8');
  child.stderr.on('data', (data) => {
    log.warn({ agentId: agent.id, agentName: agent.name, pid: child.pid, stderr: data.trim() }, 'agent process stderr');
  });

  /** @type {ManagedProcess} */
  const proc = { child, agentId: agent.id, buffer: '', currentTurn: null, background: null, queue: Promise.resolve() };

  child.stdout.setEncoding('utf-8');
  child.stdout.on('data', (chunk) => {
    proc.buffer += chunk;
    const lines = proc.buffer.split('\n');
    proc.buffer = lines.pop() ?? '';
    for (const line of lines) {
      const event = parseLine(line);
      if (!event) continue;
      // The one piece of information that would have made the Windows MCP
      // investigation trivial instead of requiring hours of empirical
      // spikes: what MCP servers this process actually saw, and whether
      // they connected — now on the record for every single spawn.
      if (event.type === 'system' && event.subtype === 'init' && Array.isArray(event.mcp_servers) && event.mcp_servers.length) {
        log.info({ agentId: agent.id, agentName: agent.name, pid: child.pid, mcpServers: event.mcp_servers }, 'mcp server status at turn start');
      }
      if (proc.currentTurn) {
        proc.currentTurn.handleEvent(event);
      } else {
        handleUnsolicitedEvent(proc, event);
      }
    }
  });

  child.on('exit', (code, sig) => {
    log.info({ agentId: agent.id, agentName: agent.name, pid: child.pid, code, signal: sig }, 'agent process exited');
    // Only clean up if this is still the tracked process for this agent —
    // a grant/PATCH-triggered kill can already have registered a NEWER
    // replacement process by the time this OLD one's exit event fires.
    const current = processes.get(agent.id);
    if (current && current.child === child) processes.delete(agent.id);

    // Flush a trailing unparsed line (no final newline) before signaling exit.
    if (proc.buffer.trim()) {
      const event = parseLine(proc.buffer);
      proc.buffer = '';
      if (event) proc.currentTurn?.handleEvent(event);
    }
    proc.currentTurn?.handleExit(code, sig);
  });

  processes.set(agent.id, proc);
  return proc;
}

/**
 * Eagerly spawns a persistent process for an agent (e.g. right when it
 * joins a chat), so it's already warm before anyone messages it. A no-op
 * if one is already alive. Best-effort: swallows and logs failures (a
 * missing workingDir, say) rather than throwing — the same error already
 * surfaces normally the next time someone actually messages this agent.
 * @param {import('../store/db.js').Agent} agent
 * @returns {void}
 */
export function spawnForAgent(agent) {
  try {
    const existing = processes.get(agent.id);
    if (existing && isAlive(existing)) return;
    if (!existsSync(agent.workingDir)) return;
    spawnProcess(agent);
  } catch (err) {
    log.error({ agentId: agent.id, agentName: agent.name, err }, 'eager spawn failed');
  }
}

/**
 * Runs one turn against an existing (or freshly spawned) persistent
 * process, queued so it never overlaps another in-flight turn on the same
 * process's stdin. Mirrors the return shape the old one-shot
 * runAgentStream always returned.
 * @param {import('../store/db.js').Agent} agent
 * @param {import('./agentRunner.js').ContentBlock[]} content
 * @param {{ onChunk: (text: string) => void, onStatus?: (status: string) => void, signal?: AbortSignal }} options
 * @returns {Promise<{ text: string, permissionDenials: import('./agentRunner.js').PermissionDenial[], sessionId: string | null, stopped: boolean, toolCalls: ToolCall[] }>}
 */
export function runTurn(agent, content, { onChunk, onStatus, signal }) {
  if (!existsSync(agent.workingDir)) {
    return Promise.reject(new Error(t('errors.workingDirMissing', { name: agent.name, path: agent.workingDir })));
  }

  let proc = processes.get(agent.id);
  if (!proc || !isAlive(proc)) {
    proc = spawnProcess(agent);
  }

  const turnPromise = proc.queue.then(() => runOneTurn(proc, content, { onChunk, onStatus, signal }));
  // Keep the queue chain alive regardless of this turn's outcome, so one
  // failed/rejected turn doesn't wedge every turn queued behind it.
  proc.queue = turnPromise.then(() => {}, () => {});
  return turnPromise;
}

/**
 * @param {ManagedProcess} proc
 * @param {import('./agentRunner.js').ContentBlock[]} content
 * @param {{ onChunk: (text: string) => void, onStatus?: (status: string) => void, signal?: AbortSignal }} options
 * @returns {Promise<{ text: string, permissionDenials: import('./agentRunner.js').PermissionDenial[], sessionId: string | null, stopped: boolean, toolCalls: ToolCall[] }>}
 */
function runOneTurn(proc, content, { onChunk, onStatus, signal }) {
  return new Promise((resolve, reject) => {
    const turn = createTurnAccumulator({ onChunk, onStatus });
    let stopped = false;
    let settled = false;

    const killForStop = () => {
      stopped = true;
      killTree(proc.child, 'SIGINT', proc.agentId);
    };
    if (signal) {
      if (signal.aborted) killForStop();
      else signal.addEventListener('abort', killForStop, { once: true });
    }

    const finish = () => {
      if (settled) return;
      settled = true;
      proc.currentTurn = null;
      if (signal) signal.removeEventListener('abort', killForStop);
      resolve({
        text: turn.resultText || turn.fullText,
        permissionDenials: turn.permissionDenials,
        sessionId: turn.sessionId,
        stopped,
        toolCalls: [...turn.toolCalls.values()],
      });
    };

    proc.currentTurn = {
      handleEvent(event) {
        turn.handleEvent(event);
        if (event.type !== 'result') return;
        if (looksLikeMcpAuthFailure(turn.resultText)) {
          // Don't block returning this turn's (already-user-visible) error
          // text — evict in the background so the conversation isn't
          // stuck waiting on a kill+exit round-trip it doesn't need to see.
          log.warn({ agentId: proc.agentId }, 'mcp auth failure detected in turn output; evicting process so the next turn spawns fresh and re-reads current auth');
          killAgent(proc.agentId).catch(() => {});
        }
        finish();
      },
      handleExit(code) {
        if (settled) return;
        // The process died mid-turn with nothing captured yet (a crash,
        // not a graceful interrupt-then-exit, which already resolved via
        // the 'result' event above before this ever fires).
        if (code !== 0 && !turn.resultText && !turn.fullText) {
          settled = true;
          if (signal) signal.removeEventListener('abort', killForStop);
          reject(new Error(t('errors.claudeExitCode', { code })));
          return;
        }
        finish();
      },
    };

    proc.child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
  });
}

/**
 * Kills an agent's live process (if any) and waits for it to actually
 * exit before resolving — used for explicit teardown (agent left/deleted,
 * chat deleted) and whenever a grant or PATCH invalidates a startup CLI
 * flag (--add-dir/--allowedTools/--dangerously-skip-permissions) baked
 * into the currently-running process, which has no way to pick up the
 * change live.
 *
 * Awaiting matters: SIGTERM delivery and process teardown aren't
 * synchronous, so a caller that kills and then immediately starts a new
 * turn (e.g. GRANT_PERMISSION's auto-continue) could otherwise still find
 * the old, dying-but-not-yet-reaped process in the registry and write the
 * new turn's stdin message into it instead of a correctly-flagged fresh
 * spawn.
 * @param {string} agentId
 * @returns {Promise<void>}
 */
export function killAgent(agentId) {
  const proc = processes.get(agentId);
  if (!proc) return Promise.resolve();
  return new Promise((resolve) => {
    proc.child.once('exit', () => resolve());
    killTree(proc.child, 'SIGTERM', agentId);
  });
}

/**
 * Kills every live agent process and waits for them all to actually exit
 * — used for graceful server shutdown, so a plain `kill <pid>` on the
 * Node process (which does NOT forward to children not in their own
 * process group) doesn't orphan them.
 * @returns {Promise<void>}
 */
export async function killAll() {
  await Promise.all([...processes.keys()].map((agentId) => killAgent(agentId)));
}
