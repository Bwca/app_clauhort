/**
 * @fileoverview REST routes for agent CRUD operations.
 * Mounted at /api/agents.
 */

import { Router } from 'express';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { getAgents, getAgent, createAgent, updateAgent, deleteAgent } from '../store/db.js';
import { verifyClaudeBinAvailable } from '../services/agentRunner.js';
import { killAgent, getAgentSkills, spawnForAgent } from '../services/agentProcessManager.js';
import { listAgentCommands, mergeSkills } from '../services/commands.js';
import { t } from '../i18n/t.js';
import { logger } from '../logger.js';

const log = logger.child({ component: 'routes:agents' });

const router = Router();

/** The OS command that opens a path in the native file manager. */
const OPEN_FOLDER_CMD = process.platform === 'darwin' ? 'open'
  : process.platform === 'win32' ? 'explorer'
  : 'xdg-open';

/**
 * GET /api/agents
 * Returns all agents.
 */
router.get('/', (_req, res) => {
  res.json(getAgents());
});

/**
 * GET /api/agents/:id
 * Returns a single agent by ID.
 */
router.get('/:id', (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: t('errors.agentNotFound') });
  res.json(agent);
});

/**
 * POST /api/agents
 * Creates a new agent.
 * @param {Object} req.body
 * @param {string} req.body.name - Agent display name
 * @param {string} req.body.color - Hex color e.g. "#6B8EAD"
 * @param {string} req.body.workingDir - Absolute path to project directory
 * @param {string} [req.body.resumeId] - Optional claude --resume conversation ID
 * @param {boolean} [req.body.dangerouslySkipPermissions] - "YOLO mode", opt-in
 * @param {boolean} [req.body.isObserver] - Observer mode, opt-in (creation-time only in the UI)
 * @param {boolean} [req.body.chromeAccess] - Browser access via the Claude in
 *   Chrome extension, opt-in (creation-time only in the UI). Multiple agents
 *   may hold this concurrently — the extension's local bridge (ws://localhost:8765)
 *   scopes each connecting CLI process to its own tab group, so concurrent
 *   `--chrome` sessions don't steal each other's pairing.
 * @param {string} [req.body.note] - Freeform note for the user's own
 *   reference (why this agent exists) — never sent to the CLI.
 */
router.post('/', async (req, res) => {
  const { name, color, workingDir, resumeId, dangerouslySkipPermissions, isObserver, chromeAccess, note } = req.body;
  if (!name || !color || !workingDir) {
    return res.status(400).json({ error: t('errors.agentFieldsRequired') });
  }
  if (!existsSync(workingDir)) {
    return res.status(400).json({ error: t('errors.agentDirNotFound', { path: workingDir }) });
  }
  const verified = await verifyClaudeBinAvailable();
  if (!verified.ok) {
    return res.status(400).json({ error: t('errors.agentVerifyFailed', { message: verified.error }) });
  }
  const data = { id: uuidv4(), name, color, workingDir };
  if (resumeId) data.resumeId = resumeId;
  if (dangerouslySkipPermissions) data.dangerouslySkipPermissions = true;
  if (isObserver) data.isObserver = true;
  if (chromeAccess) data.chromeAccess = true;
  if (note) data.note = note.trim();
  const agent = await createAgent(data);
  res.status(201).json(agent);
});

/**
 * PATCH /api/agents/:id
 * Updates an agent's mutable fields.
 * @param {Object} req.body
 * @param {string} [req.body.name]
 * @param {string} [req.body.color]
 * @param {string} [req.body.workingDir]
 * @param {string} [req.body.resumeId]
 * @param {boolean} [req.body.dangerouslySkipPermissions]
 * @param {boolean} [req.body.isObserver] - Not exposed in the UI for editing,
 *   but supported generically here. Pure server-side routing/context logic —
 *   unlike workingDir/dangerouslySkipPermissions/resumeId, it is NOT baked
 *   into the CLI's spawn args, so changing it does NOT evict the running
 *   process (see flagsChanged below, which deliberately omits it).
 * @param {boolean} [req.body.chromeAccess] - Not exposed in the UI for
 *   editing, but supported generically here. Baked into spawn args
 *   (--chrome), so turning it on evicts the running process like
 *   dangerouslySkipPermissions does.
 * @param {string} [req.body.note] - Freeform note for the user's own
 *   reference. IS exposed in the UI for editing — purely metadata, never
 *   baked into spawn args, so changing it never evicts the running process.
 */
router.patch('/:id', async (req, res) => {
  const { name, color, workingDir, resumeId, dangerouslySkipPermissions, isObserver, chromeAccess, note } = req.body;
  const existing = getAgent(req.params.id);
  if (!existing) return res.status(404).json({ error: t('errors.agentNotFound') });

  // Only re-verify if workingDir is actually changing — resumeId isn't
  // checked at all (see verifyClaudeBinAvailable's docs), and renaming or
  // recoloring an already-working agent shouldn't touch the filesystem.
  if (workingDir !== undefined && workingDir !== existing.workingDir) {
    if (!existsSync(workingDir)) {
      return res.status(400).json({ error: t('errors.agentDirNotFound', { path: workingDir }) });
    }
    const verified = await verifyClaudeBinAvailable();
    if (!verified.ok) {
      return res.status(400).json({ error: t('errors.agentVerifyFailed', { message: verified.error }) });
    }
  }
  const agent = await updateAgent(req.params.id, { name, color, workingDir, resumeId, dangerouslySkipPermissions, isObserver, chromeAccess, note: note !== undefined ? note.trim() : undefined });
  if (!agent) return res.status(404).json({ error: t('errors.agentNotFound') });
  // workingDir/dangerouslySkipPermissions/resumeId/chromeAccess are all
  // baked into the agent's persistent process at spawn time (--add-dir,
  // --dangerously-skip-permissions, --resume, --chrome) — a running process
  // has no way to pick up a change to any of them, so evict it; the next
  // turn respawns fresh. Not currently reachable from the UI, but this is
  // live API surface.
  const flagsChanged = (workingDir !== undefined && workingDir !== existing.workingDir)
    || (dangerouslySkipPermissions !== undefined && dangerouslySkipPermissions !== existing.dangerouslySkipPermissions)
    || (resumeId !== undefined && resumeId !== existing.resumeId)
    || (chromeAccess !== undefined && chromeAccess !== existing.chromeAccess);
  if (flagsChanged) await killAgent(req.params.id);
  res.json(agent);
});

/**
 * POST /api/agents/:id/open-folder
 * Opens the agent's working directory in the OS's native file manager.
 */
router.post('/:id/open-folder', (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: t('errors.agentNotFound') });

  const child = spawn(OPEN_FOLDER_CMD, [agent.workingDir], { stdio: 'ignore', detached: true });
  child.on('error', (err) => log.error({ agentId: agent.id, err }, 'failed to open folder'));
  child.unref();

  res.json({ ok: true });
});

/**
 * POST /api/agents/:id/restart
 * Kills the agent's live process, if any — the next turn spawns a fresh one
 * and `--resume`s, so no chat history is lost. Some process state (notably
 * which MCP connectors/servers are authorized) is read fresh only once, at
 * spawn time, and never re-read for that process's lifetime — see
 * agentProcessManager.js's looksLikeMcpAuthFailure docs. This gives a way to
 * pick up such changes (e.g. a connector authorized mid-session) for one
 * agent without restarting the whole server.
 */
router.post('/:id/restart', async (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: t('errors.agentNotFound') });
  await killAgent(agent.id);
  spawnForAgent(agent);
  res.json({ ok: true });
});

/**
 * GET /api/agents/:id/commands
 * Lists the agent's slash commands for the composer's "/" autocomplete:
 * its project-level custom commands (.claude/commands/*.md in its
 * workingDir) merged with the built-in/marketplace/plugin skills its own
 * live process actually reported having (empty until that process has
 * spawned at least once — see getAgentSkills).
 */
router.get('/:id/commands', (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: t('errors.agentNotFound') });
  res.json(mergeSkills(listAgentCommands(agent.workingDir), getAgentSkills(agent.id)));
});

/**
 * DELETE /api/agents/:id
 * Deletes an agent and all its sessions.
 */
router.delete('/:id', async (req, res) => {
  const deleted = await deleteAgent(req.params.id);
  if (!deleted) return res.status(404).json({ error: t('errors.agentNotFound') });
  await killAgent(req.params.id);
  res.status(204).end();
});

export default router;
