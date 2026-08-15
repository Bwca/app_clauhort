/**
 * @fileoverview SQLite-based persistence layer (node:sqlite, Node's built-in
 * driver — no native compile step, so no node-gyp/Visual Studio/build-essential
 * required on any platform).
 * Opens/creates the database on startup; if a legacy data.json exists and no
 * database file exists yet, imports it once. All writes are synchronous
 * SQLite statements wrapped in `async` functions to preserve the existing
 * awaited call sites.
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../logger.js';

const log = logger.child({ component: 'db' });

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = process.env.APP_DB_FILE ?? join(__dirname, 'data.sqlite3');
const JSON_DATA_FILE = join(__dirname, 'data.json');

/** @type {import('node:sqlite').DatabaseSync} */
let db;

/**
 * Runs `fn` inside a transaction, committing on success and rolling back if
 * it throws. node:sqlite's DatabaseSync has no built-in `.transaction()`
 * helper (unlike better-sqlite3), so this shim covers the small handful of
 * call sites in this file that need one.
 * @template T
 * @param {() => T} fn
 * @returns {() => T}
 */
function transaction(fn) {
  return () => {
    db.exec('BEGIN');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };
}

/**
 * @typedef {Object} Attachment
 * @property {string} id - Client-generated UUID
 * @property {'image' | 'text'} type - Attachment kind
 * @property {string} [mediaType] - MIME type, images only (e.g. "image/png")
 * @property {string} [name] - Filename or a label like "Pasted text #1 (+40 lines)"
 * @property {string} data - Base64 (image) or raw text (text paste)
 * @property {number} [size] - Byte/char length, for display
 */

/**
 * @typedef {Object} Agent
 * @property {string} id - UUID v4
 * @property {string} name - Display name
 * @property {string} color - Hex color string e.g. "#6B8EAD"
 * @property {string} workingDir - Absolute path to the agent's project directory
 * @property {string} [resumeId] - Optional claude --resume conversation ID
 * @property {string[]} [extraAllowedPaths] - Additional directories granted via
 *   GRANT_PERMISSION for file-path-scoped tools (Write/Edit/Read/NotebookEdit),
 *   passed to `claude` as `--add-dir`.
 * @property {string[]} [allowedToolPatterns] - Tool-permission patterns granted via
 *   GRANT_PERMISSION for non-file tools like Bash (e.g. "Bash(git add:*)"), passed
 *   to `claude` as `--allowedTools`. Kept distinct from extraAllowedPaths since
 *   `--add-dir` only ever widens filesystem access — it can't authorize a command.
 * @property {boolean} [dangerouslySkipPermissions] - "YOLO mode": spawns this agent
 *   with `--dangerously-skip-permissions` instead of the normal acceptEdits + grant
 *   flow, bypassing every permission check entirely (no denials, no cards, ever).
 *   Opt-in per agent at creation/edit time; never a default.
 * @property {boolean} [isObserver] - Never responds to a broadcast (un-@mentioned)
 *   message — only responds when explicitly @mentioned (typed, relayed, or via a
 *   scheduled message). In exchange, gets the FULL chat history as context instead
 *   of the normal recent-window cap, so a dormant observer can catch up on a whole
 *   day's work when finally asked to summarize it. Opt-in at creation only (no UI
 *   edit later, though PATCH supports it generically). Purely server-side routing/
 *   context logic — does not affect CLI spawn args at all.
 * @property {boolean} [chromeAccess] - Spawns this agent with `--chrome`, enabling
 *   the Claude in Chrome browser-automation MCP tools. The extension only supports
 *   one paired connection at a time, so at most one agent app-wide may have this
 *   set — enforced at creation/update via getChromeAccessAgent. Opt-in at creation
 *   only (no UI edit later, though PATCH supports it generically).
 * @property {string} createdAt - ISO 8601 timestamp
 */

/**
 * @typedef {Object} Chat
 * @property {string} id - UUID v4
 * @property {string} name - Chat room name
 * @property {string[]} memberAgentIds - Array of agent UUIDs in this chat
 * @property {string | null} rosterChangedAt - ISO 8601 timestamp of the last
 *   membership change (add or remove), or null if it's never changed since
 *   creation. Used to decide whether an already-spoken agent needs a fresh
 *   roster note even when nothing else happened since its last turn — see
 *   buildPromptBlocks in ws/handler.js.
 * @property {string} createdAt - ISO 8601 timestamp
 */

/**
 * @typedef {'user' | 'agent'} MessageRole
 */

/**
 * @typedef {Object} Message
 * @property {string} id - UUID v4
 * @property {string} chatId - Parent chat UUID
 * @property {MessageRole} role - Who authored this message
 * @property {string | null} agentId - Agent UUID if role === 'agent', else null
 * @property {string} authorName - Display name of the author
 * @property {string} content - Full message text
 * @property {Attachment[]} attachments - Images/large text pastes attached to this message
 * @property {import('../services/agentProcessManager.js').ToolCall[]} toolCalls - Tool
 *   calls made while producing this message (agent messages only — always
 *   `[]` for user messages), each paired with its own result.
 * @property {boolean} [isLocalCommandOnly] - True when this agent reply came
 *   entirely from the `claude` CLI's OWN local-command dispatcher (e.g. a
 *   bare "/chrome", "/help" — its built-in commands, not this project's
 *   `.claude/commands/*.md` skills) intercepting the turn before the model
 *   ever saw it — see agentProcessManager.js's local_command handling.
 *   Still shown in the chat like any other reply, but excluded from
 *   hasSpokenInChat/catch-up reasoning in ws/handler.js: nothing sent
 *   alongside it (the [System] preamble, any catch-up context) actually
 *   reached the model, so treating it as a real turn would permanently
 *   skip the agent's one-time introduction.
 * @property {string} createdAt - ISO 8601 timestamp
 */

/**
 * @typedef {Object} ScheduledMessage
 * @property {string} id - UUID v4
 * @property {string} chatId - Target chat UUID
 * @property {string} content - Message text to send once it fires
 * @property {Attachment[]} attachments - Attachments to send along with it
 * @property {string} sendAt - ISO 8601 timestamp of when this should fire
 * @property {string} createdAt - ISO 8601 timestamp of when this was scheduled
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  working_dir TEXT NOT NULL,
  resume_id TEXT,
  extra_allowed_paths TEXT NOT NULL DEFAULT '[]',
  allowed_tool_patterns TEXT NOT NULL DEFAULT '[]',
  dangerously_skip_permissions INTEGER NOT NULL DEFAULT 0,
  is_observer INTEGER NOT NULL DEFAULT 0,
  chrome_access INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  roster_changed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_members (
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  PRIMARY KEY (chat_id, agent_id)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','agent')),
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  author_name TEXT NOT NULL,
  content TEXT NOT NULL,
  attachments TEXT NOT NULL DEFAULT '[]',
  tool_calls TEXT NOT NULL DEFAULT '[]',
  is_local_command_only INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_chat_created ON messages(chat_id, created_at);

CREATE TABLE IF NOT EXISTS scheduled_messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  attachments TEXT NOT NULL DEFAULT '[]',
  send_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_send_at ON scheduled_messages(send_at);
`;

/**
 * Rebuilds the `messages` table if it still has the original agent_id
 * foreign key (no ON DELETE action), which blocked deleting an agent who'd
 * ever sent a message — `CREATE TABLE IF NOT EXISTS` in SCHEMA only applies
 * to brand-new databases, so existing ones need this one-time migration.
 * Preserves all rows; a no-op (one cheap pragma query) once already migrated.
 * @returns {void}
 */
function migrateMessagesAgentFk() {
  const agentFk = db.prepare("PRAGMA foreign_key_list(messages)").all()
    .find((fk) => fk.table === 'agents' && fk.from === 'agent_id');
  if (!agentFk || agentFk.on_delete === 'SET NULL') return;

  db.exec('PRAGMA foreign_keys = OFF');
  transaction(() => {
    db.exec(`
      CREATE TABLE messages_new (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user','agent')),
        agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
        author_name TEXT NOT NULL,
        content TEXT NOT NULL,
        attachments TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      )
    `);
    db.exec(`
      INSERT INTO messages_new (id, chat_id, role, agent_id, author_name, content, attachments, created_at)
      SELECT id, chat_id, role, agent_id, author_name, content, attachments, created_at FROM messages
    `);
    db.exec('DROP TABLE messages');
    db.exec('ALTER TABLE messages_new RENAME TO messages');
    db.exec('CREATE INDEX IF NOT EXISTS idx_messages_chat_created ON messages(chat_id, created_at)');
  })();
  db.exec('PRAGMA foreign_keys = ON');
}

/**
 * Adds the `allowed_tool_patterns` column to `agents` if it's missing — needed
 * for any database created before this column existed, since `CREATE TABLE IF
 * NOT EXISTS` in SCHEMA only applies to brand-new databases. A no-op (one
 * cheap pragma query) once already migrated.
 * @returns {void}
 */
function migrateAgentsAllowedToolPatterns() {
  const hasColumn = db.prepare("PRAGMA table_info(agents)").all()
    .some((col) => col.name === 'allowed_tool_patterns');
  if (hasColumn) return;
  db.exec("ALTER TABLE agents ADD COLUMN allowed_tool_patterns TEXT NOT NULL DEFAULT '[]'");
}

/**
 * Adds the `dangerously_skip_permissions` column to `agents` if it's missing,
 * same reasoning as migrateAgentsAllowedToolPatterns above.
 * @returns {void}
 */
function migrateAgentsDangerMode() {
  const hasColumn = db.prepare("PRAGMA table_info(agents)").all()
    .some((col) => col.name === 'dangerously_skip_permissions');
  if (hasColumn) return;
  db.exec('ALTER TABLE agents ADD COLUMN dangerously_skip_permissions INTEGER NOT NULL DEFAULT 0');
}

/**
 * Adds the `is_observer` column to `agents` if it's missing, same reasoning
 * as migrateAgentsAllowedToolPatterns above.
 * @returns {void}
 */
function migrateAgentsObserverMode() {
  const hasColumn = db.prepare("PRAGMA table_info(agents)").all()
    .some((col) => col.name === 'is_observer');
  if (hasColumn) return;
  db.exec('ALTER TABLE agents ADD COLUMN is_observer INTEGER NOT NULL DEFAULT 0');
}

/**
 * Adds the `chrome_access` column to `agents` if it's missing, same
 * reasoning as migrateAgentsAllowedToolPatterns above.
 * @returns {void}
 */
function migrateAgentsChromeAccess() {
  const hasColumn = db.prepare("PRAGMA table_info(agents)").all()
    .some((col) => col.name === 'chrome_access');
  if (hasColumn) return;
  db.exec('ALTER TABLE agents ADD COLUMN chrome_access INTEGER NOT NULL DEFAULT 0');
}

/**
 * Adds the `tool_calls` column to `messages` if it's missing — needed for
 * any database created before this column existed, since `CREATE TABLE IF
 * NOT EXISTS` in SCHEMA only applies to brand-new databases. A no-op (one
 * cheap pragma query) once already migrated.
 * @returns {void}
 */
function migrateMessagesToolCalls() {
  const hasColumn = db.prepare("PRAGMA table_info(messages)").all()
    .some((col) => col.name === 'tool_calls');
  if (hasColumn) return;
  db.exec("ALTER TABLE messages ADD COLUMN tool_calls TEXT NOT NULL DEFAULT '[]'");
}

/**
 * Adds the `is_local_command_only` column to `messages` if it's missing,
 * same reasoning as migrateMessagesToolCalls above.
 * @returns {void}
 */
function migrateMessagesLocalCommandOnly() {
  const hasColumn = db.prepare("PRAGMA table_info(messages)").all()
    .some((col) => col.name === 'is_local_command_only');
  if (hasColumn) return;
  db.exec('ALTER TABLE messages ADD COLUMN is_local_command_only INTEGER NOT NULL DEFAULT 0');
}

/**
 * Enforces "each agent belongs to at most one chat at a time" via a UNIQUE
 * index on chat_members.agent_id — an agent's resumeId is a single global
 * Claude session, so being in 2+ chats simultaneously would bleed one
 * chat's conversation into another's. Unlike migrateMessagesAgentFk, no
 * table rebuild is needed here — SQLite can add an index to an existing
 * table directly. Deliberately NOT declared in SCHEMA itself: db.exec(SCHEMA)
 * runs unconditionally on every startup (not just for brand-new databases),
 * so if an existing DB ever had a real duplicate membership, building the
 * index there would throw before this migration's dedup step ever ran.
 *
 * If any agent already has memberships in 2+ chats (verified zero cases on
 * this app's live DB — this is defensive, not an urgent fix), keeps the
 * earliest membership (lowest rowid) and drops the rest, logging each drop.
 * Confirmed via a throwaway script (fresh DB, simulated legacy DB with a
 * real duplicate, and a reopen-after-migration check) that this is a clean,
 * idempotent no-op once the index exists.
 * @returns {void}
 */
function migrateChatMembersUniqueAgent() {
  const hasIndex = db.prepare('PRAGMA index_list(chat_members)').all()
    .some((idx) => idx.name === 'idx_chat_members_agent' && idx.unique);
  if (hasIndex) return;

  const dupes = db.prepare(`
    SELECT chat_id, agent_id, rowid FROM chat_members
    WHERE rowid NOT IN (SELECT MIN(rowid) FROM chat_members GROUP BY agent_id)
  `).all();
  for (const row of dupes) {
    log.warn({ agentId: row.agent_id, chatId: row.chat_id }, 'migration: dropping extra chat membership (keeping earliest only)');
    db.prepare('DELETE FROM chat_members WHERE rowid = ?').run(row.rowid);
  }
  db.exec('CREATE UNIQUE INDEX idx_chat_members_agent ON chat_members(agent_id)');
}

/**
 * Adds the `roster_changed_at` column to `chats` if it's missing, same
 * reasoning as migrateAgentsAllowedToolPatterns above.
 * @returns {void}
 */
function migrateChatsRosterChangedAt() {
  const hasColumn = db.prepare("PRAGMA table_info(chats)").all()
    .some((col) => col.name === 'roster_changed_at');
  if (hasColumn) return;
  db.exec('ALTER TABLE chats ADD COLUMN roster_changed_at TEXT');
}

/**
 * Maps a raw `agents` row to the public Agent shape.
 * @param {Record<string, unknown>} row
 * @returns {Agent}
 */
function rowToAgent(row) {
  const extraAllowedPaths = JSON.parse(row.extra_allowed_paths);
  const allowedToolPatterns = JSON.parse(row.allowed_tool_patterns);
  const agent = {
    id: row.id,
    name: row.name,
    color: row.color,
    workingDir: row.working_dir,
    createdAt: row.created_at,
  };
  if (row.resume_id) agent.resumeId = row.resume_id;
  if (extraAllowedPaths.length) agent.extraAllowedPaths = extraAllowedPaths;
  if (allowedToolPatterns.length) agent.allowedToolPatterns = allowedToolPatterns;
  if (row.dangerously_skip_permissions) agent.dangerouslySkipPermissions = true;
  if (row.is_observer) agent.isObserver = true;
  if (row.chrome_access) agent.chromeAccess = true;
  return agent;
}

/**
 * Maps a raw `chats` row (plus its member IDs) to the public Chat shape.
 * @param {Record<string, unknown>} row
 * @returns {Chat}
 */
function rowToChat(row) {
  const memberAgentIds = db
    .prepare('SELECT agent_id FROM chat_members WHERE chat_id = ? ORDER BY rowid')
    .all(row.id)
    .map((r) => r.agent_id);
  return { id: row.id, name: row.name, memberAgentIds, rosterChangedAt: row.roster_changed_at ?? null, createdAt: row.created_at };
}

/**
 * Maps a raw `messages` row to the public Message shape.
 *
 * For user-authored rows, authorName resolves to the CURRENT display name
 * setting rather than whatever was stored at send time — the user's name is
 * a live identity, not a per-message snapshot, so renaming applies to their
 * whole message history, not just future messages. (Agent-authored rows keep
 * their stored author_name, since an agent's identity doesn't change.)
 * @param {Record<string, unknown>} row
 * @returns {Message}
 */
function rowToMessage(row) {
  const message = {
    id: row.id,
    chatId: row.chat_id,
    role: row.role,
    agentId: row.agent_id,
    authorName: row.role === 'user' ? getUserDisplayName() : row.author_name,
    content: row.content,
    attachments: JSON.parse(row.attachments),
    toolCalls: JSON.parse(row.tool_calls ?? '[]'),
    createdAt: row.created_at,
  };
  if (row.is_local_command_only) message.isLocalCommandOnly = true;
  return message;
}

/**
 * Maps a raw `scheduled_messages` row to the public ScheduledMessage shape.
 * @param {Record<string, unknown>} row
 * @returns {ScheduledMessage}
 */
function rowToScheduledMessage(row) {
  return {
    id: row.id,
    chatId: row.chat_id,
    content: row.content,
    attachments: JSON.parse(row.attachments),
    sendAt: row.send_at,
    createdAt: row.created_at,
  };
}

/**
 * Imports a legacy data.json into the freshly-created SQLite schema, once.
 * @returns {void}
 */
function importLegacyJson() {
  const raw = JSON.parse(readFileSync(JSON_DATA_FILE, 'utf-8'));
  const insertAgent = db.prepare(`
    INSERT INTO agents (id, name, color, working_dir, resume_id, extra_allowed_paths, allowed_tool_patterns, dangerously_skip_permissions, is_observer, chrome_access, created_at)
    VALUES (@id, @name, @color, @workingDir, @resumeId, @extraAllowedPaths, @allowedToolPatterns, @dangerouslySkipPermissions, @isObserver, @chromeAccess, @createdAt)
  `);
  const insertChat = db.prepare('INSERT INTO chats (id, name, created_at) VALUES (?, ?, ?)');
  const insertMember = db.prepare('INSERT OR IGNORE INTO chat_members (chat_id, agent_id) VALUES (?, ?)');
  const insertMessage = db.prepare(`
    INSERT INTO messages (id, chat_id, role, agent_id, author_name, content, attachments, created_at)
    VALUES (@id, @chatId, @role, @agentId, @authorName, @content, @attachments, @createdAt)
  `);

  const importTxn = transaction(() => {
    for (const a of raw.agents ?? []) {
      insertAgent.run({
        id: a.id,
        name: a.name,
        color: a.color,
        workingDir: a.workingDir,
        resumeId: a.resumeId ?? null,
        extraAllowedPaths: JSON.stringify(a.extraAllowedPaths ?? []),
        allowedToolPatterns: JSON.stringify(a.allowedToolPatterns ?? []),
        dangerouslySkipPermissions: a.dangerouslySkipPermissions ? 1 : 0,
        isObserver: a.isObserver ? 1 : 0,
        chromeAccess: a.chromeAccess ? 1 : 0,
        createdAt: a.createdAt,
      });
    }
    for (const c of raw.chats ?? []) {
      insertChat.run(c.id, c.name, c.createdAt);
      for (const agentId of c.memberAgentIds ?? []) insertMember.run(c.id, agentId);
    }
    for (const m of raw.messages ?? []) {
      insertMessage.run({
        id: m.id,
        chatId: m.chatId,
        role: m.role,
        agentId: m.agentId ?? null,
        authorName: m.authorName,
        content: m.content,
        attachments: JSON.stringify(m.attachments ?? []),
        createdAt: m.createdAt,
      });
    }
  });
  importTxn();
}

/**
 * Opens (or creates) the database, applies the schema, and imports a legacy
 * data.json exactly once if the database file didn't already exist.
 * @returns {Promise<void>}
 */
export async function loadDb() {
  const isMemory = DATA_FILE === ':memory:';
  const isNewDatabase = isMemory || !existsSync(DATA_FILE);

  db = new DatabaseSync(DATA_FILE);
  if (!isMemory) db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  migrateMessagesAgentFk();
  migrateMessagesToolCalls();
  migrateMessagesLocalCommandOnly();
  migrateAgentsAllowedToolPatterns();
  migrateAgentsDangerMode();
  migrateAgentsObserverMode();
  migrateAgentsChromeAccess();
  migrateChatMembersUniqueAgent();
  migrateChatsRosterChangedAt();

  if (!isMemory && isNewDatabase && existsSync(JSON_DATA_FILE)) {
    importLegacyJson();
  }
}

// ─── Agents ────────────────────────────────────────────────────────────────

/**
 * Returns all agents.
 * @returns {Agent[]}
 */
export function getAgents() {
  return db.prepare('SELECT * FROM agents').all().map(rowToAgent);
}

/**
 * Returns a single agent by ID, or undefined if not found.
 * @param {string} id
 * @returns {Agent | undefined}
 */
export function getAgent(id) {
  const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
  return row ? rowToAgent(row) : undefined;
}

/**
 * Returns the one agent (if any) with browser access enabled, other than
 * `excludeId`. The Claude in Chrome extension only holds a single paired
 * connection at a time — a second `--chrome`-enabled agent process would
 * silently steal that pairing out from under the first — so this is used
 * to enforce a single browser-access agent app-wide, not per-chat.
 * @param {string} [excludeId] - Agent id to exclude (e.g. the one being updated)
 * @returns {Agent | undefined}
 */
export function getChromeAccessAgent(excludeId) {
  const row = db.prepare('SELECT * FROM agents WHERE chrome_access = 1 AND id != ?').get(excludeId ?? '');
  return row ? rowToAgent(row) : undefined;
}

/**
 * Creates and persists a new agent.
 * @param {Omit<Agent, 'createdAt'>} data
 * @returns {Promise<Agent>}
 */
export async function createAgent(data) {
  const createdAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO agents (id, name, color, working_dir, resume_id, extra_allowed_paths, allowed_tool_patterns, dangerously_skip_permissions, is_observer, chrome_access, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.id, data.name, data.color, data.workingDir,
    data.resumeId ?? null, JSON.stringify(data.extraAllowedPaths ?? []),
    JSON.stringify(data.allowedToolPatterns ?? []), data.dangerouslySkipPermissions ? 1 : 0,
    data.isObserver ? 1 : 0, data.chromeAccess ? 1 : 0, createdAt
  );
  return getAgent(data.id);
}

/**
 * Updates an existing agent's mutable fields and persists.
 * Only the fields present (and not undefined) in `updates` are written —
 * a partial PATCH never clobbers untouched columns.
 * @param {string} id
 * @param {Partial<Pick<Agent, 'name' | 'color' | 'workingDir' | 'resumeId' | 'extraAllowedPaths' | 'allowedToolPatterns' | 'dangerouslySkipPermissions' | 'isObserver' | 'chromeAccess'>>} updates
 * @returns {Promise<Agent | null>}
 */
export async function updateAgent(id, updates) {
  if (!getAgent(id)) return null;

  const columns = {
    name: updates.name,
    color: updates.color,
    working_dir: updates.workingDir,
    resume_id: updates.resumeId,
    extra_allowed_paths: updates.extraAllowedPaths ? JSON.stringify(updates.extraAllowedPaths) : undefined,
    allowed_tool_patterns: updates.allowedToolPatterns ? JSON.stringify(updates.allowedToolPatterns) : undefined,
    // Boolean, so explicitly checked against undefined — unlike the arrays
    // above, `false` is a meaningful, common value here (turning YOLO mode
    // back off), not "absent".
    dangerously_skip_permissions: updates.dangerouslySkipPermissions !== undefined
      ? (updates.dangerouslySkipPermissions ? 1 : 0)
      : undefined,
    // Same explicit-undefined-check reasoning as dangerously_skip_permissions above.
    is_observer: updates.isObserver !== undefined ? (updates.isObserver ? 1 : 0) : undefined,
    // Same explicit-undefined-check reasoning as dangerously_skip_permissions above.
    chrome_access: updates.chromeAccess !== undefined ? (updates.chromeAccess ? 1 : 0) : undefined,
  };
  const entries = Object.entries(columns).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return getAgent(id);

  const setClause = entries.map(([col]) => `${col} = ?`).join(', ');
  const values = entries.map(([, v]) => v);
  db.prepare(`UPDATE agents SET ${setClause} WHERE id = ?`).run(...values, id);
  return getAgent(id);
}

/**
 * Sets an agent's resumeId, but only if it isn't already set — used to persist
 * an auto-captured Claude session id exactly once, safely under concurrent turns.
 * @param {string} id
 * @param {string} resumeId
 * @returns {Promise<Agent | null>} the updated agent, or null if it was already set (no-op) or not found
 */
export async function setAgentResumeIdIfUnset(id, resumeId) {
  const result = db.prepare('UPDATE agents SET resume_id = ? WHERE id = ? AND resume_id IS NULL').run(resumeId, id);
  return result.changes > 0 ? getAgent(id) : null;
}

/**
 * Deletes an agent.
 * @param {string} id
 * @returns {Promise<boolean>} true if deleted, false if not found
 */
export async function deleteAgent(id) {
  const result = db.prepare('DELETE FROM agents WHERE id = ?').run(id);
  return result.changes > 0;
}

/**
 * Adds a path to an agent's extraAllowedPaths (idempotent).
 * @param {string} agentId
 * @param {string} path
 * @returns {Promise<Agent | null>}
 */
export async function grantAgentPath(agentId, path) {
  const agent = getAgent(agentId);
  if (!agent) return null;
  const extraAllowedPaths = agent.extraAllowedPaths ?? [];
  if (!extraAllowedPaths.includes(path)) {
    extraAllowedPaths.push(path);
    db.prepare('UPDATE agents SET extra_allowed_paths = ? WHERE id = ?')
      .run(JSON.stringify(extraAllowedPaths), agentId);
  }
  return getAgent(agentId);
}

/**
 * Adds a tool-permission pattern to an agent's allowedToolPatterns (idempotent) —
 * the Bash-and-friends equivalent of grantAgentPath, passed to `claude` as
 * `--allowedTools` rather than `--add-dir` (see the Agent typedef's doc comment
 * for why these two grant mechanisms are kept separate).
 * @param {string} agentId
 * @param {string} pattern - e.g. "Bash(git add:*)"
 * @returns {Promise<Agent | null>}
 */
export async function grantAgentToolPattern(agentId, pattern) {
  const agent = getAgent(agentId);
  if (!agent) return null;
  const allowedToolPatterns = agent.allowedToolPatterns ?? [];
  if (!allowedToolPatterns.includes(pattern)) {
    allowedToolPatterns.push(pattern);
    db.prepare('UPDATE agents SET allowed_tool_patterns = ? WHERE id = ?')
      .run(JSON.stringify(allowedToolPatterns), agentId);
  }
  return getAgent(agentId);
}

// ─── Chats ─────────────────────────────────────────────────────────────────

/**
 * Returns all chats.
 * @returns {Chat[]}
 */
export function getChats() {
  return db.prepare('SELECT * FROM chats').all().map(rowToChat);
}

/**
 * Returns a single chat by ID, or undefined if not found.
 * @param {string} id
 * @returns {Chat | undefined}
 */
export function getChat(id) {
  const row = db.prepare('SELECT * FROM chats WHERE id = ?').get(id);
  return row ? rowToChat(row) : undefined;
}

/**
 * Creates and persists a new chat.
 * @param {Omit<Chat, 'createdAt'>} data
 * @returns {Promise<Chat>}
 */
export async function createChat(data) {
  const createdAt = new Date().toISOString();
  const insertMember = db.prepare('INSERT OR IGNORE INTO chat_members (chat_id, agent_id) VALUES (?, ?)');
  const txn = transaction(() => {
    db.prepare('INSERT INTO chats (id, name, created_at) VALUES (?, ?, ?)').run(data.id, data.name, createdAt);
    for (const agentId of data.memberAgentIds ?? []) insertMember.run(data.id, agentId);
  });
  txn();
  return getChat(data.id);
}

/**
 * Clears an agent's resumeId — called whenever an agent leaves its chat
 * (removed, or the chat itself is deleted), so a later add to a *different*
 * chat starts a fresh Claude session instead of silently carrying the old
 * chat's conversational memory forward via --resume. Deliberately distinct
 * from setAgentResumeIdIfUnset, whose "only if unset" semantics are the
 * opposite of what's needed here (this always clears, unconditionally).
 * @param {string} agentId
 * @returns {void}
 */
function clearAgentResumeId(agentId) {
  db.prepare('UPDATE agents SET resume_id = NULL WHERE id = ?').run(agentId);
}

/**
 * Returns the ID of the chat an agent currently belongs to, or undefined if
 * it's in none. Agents belong to at most one chat at a time (enforced by
 * idx_chat_members_agent — see migrateChatMembersUniqueAgent), so this is a
 * single lookup rather than a list.
 * @param {string} agentId
 * @returns {string | undefined}
 */
export function getAgentChatId(agentId) {
  const row = db.prepare('SELECT chat_id FROM chat_members WHERE agent_id = ?').get(agentId);
  return row?.chat_id;
}

/**
 * Deletes a chat and all its messages. Also clears resumeId for every agent
 * that was a member — chat_members rows cascade-delete via FK as part of
 * the same statement, which would otherwise silently free those agents to
 * join a new chat while still carrying this deleted chat's full
 * conversational memory forward via --resume.
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export async function deleteChat(id) {
  const txn = transaction(() => {
    const memberIds = db.prepare('SELECT agent_id FROM chat_members WHERE chat_id = ?').all(id).map((r) => r.agent_id);
    const result = db.prepare('DELETE FROM chats WHERE id = ?').run(id);
    if (result.changes > 0) for (const agentId of memberIds) clearAgentResumeId(agentId);
    return result.changes > 0;
  });
  return txn();
}

/**
 * Stamps a chat's rosterChangedAt to now — called whenever chat_members
 * actually gains or loses a row, so an already-spoken agent whose live
 * session missed the change (no accompanying chat message, e.g. a plain
 * member removal) can still be caught up next turn. See buildPromptBlocks
 * in ws/handler.js for the read side.
 * @param {string} chatId
 * @returns {void}
 */
function touchRosterChanged(chatId) {
  db.prepare('UPDATE chats SET roster_changed_at = ? WHERE id = ?').run(new Date().toISOString(), chatId);
}

/**
 * Adds an agent to a chat's member list (idempotent). Callers are
 * responsible for rejecting an agent that's already a member of a
 * *different* chat before calling this (see getAgentChatId) — this
 * function itself just relies on idx_chat_members_agent to reject the
 * insert at the DB level if that check is skipped.
 * @param {string} chatId
 * @param {string} agentId
 * @returns {Promise<Chat | null>}
 */
export async function addChatMember(chatId, agentId) {
  if (!getChat(chatId)) return null;
  const txn = transaction(() => {
    const result = db.prepare('INSERT OR IGNORE INTO chat_members (chat_id, agent_id) VALUES (?, ?)').run(chatId, agentId);
    if (result.changes > 0) touchRosterChanged(chatId);
  });
  txn();
  return getChat(chatId);
}

/**
 * Removes an agent from a chat's member list, and clears its resumeId —
 * see deleteChat's doc comment for why leaving a chat must reset memory.
 * Only clears if a row was actually removed, so a no-op double-remove
 * doesn't wipe an agent's session for no reason. Same changes>0 guard for
 * the rosterChangedAt stamp (see touchRosterChanged).
 * @param {string} chatId
 * @param {string} agentId
 * @returns {Promise<Chat | null>}
 */
export async function removeChatMember(chatId, agentId) {
  if (!getChat(chatId)) return null;
  const txn = transaction(() => {
    const result = db.prepare('DELETE FROM chat_members WHERE chat_id = ? AND agent_id = ?').run(chatId, agentId);
    if (result.changes > 0) {
      clearAgentResumeId(agentId);
      touchRosterChanged(chatId);
    }
  });
  txn();
  return getChat(chatId);
}

// ─── Messages ───────────────────────────────────────────────────────────────

/**
 * Returns messages for a chat, ordered by createdAt ascending.
 * @param {string} chatId
 * @param {number} [limit=50]
 * @param {string} [beforeId] - Return messages created before this message ID
 * @returns {Message[]}
 */
export function getMessages(chatId, limit = 50, beforeId) {
  let rows;
  if (beforeId) {
    const pivot = db.prepare('SELECT created_at, rowid FROM messages WHERE id = ?').get(beforeId);
    rows = pivot
      ? db.prepare(`
          SELECT * FROM messages WHERE chat_id = ?
            AND (created_at < ? OR (created_at = ? AND rowid < ?))
          ORDER BY created_at DESC, rowid DESC LIMIT ?
        `).all(chatId, pivot.created_at, pivot.created_at, pivot.rowid, limit)
      : [];
  } else {
    rows = db.prepare(`
      SELECT * FROM messages WHERE chat_id = ?
      ORDER BY created_at DESC, rowid DESC LIMIT ?
    `).all(chatId, limit);
  }
  return rows.reverse().map(rowToMessage);
}

/**
 * Appends a new message and persists.
 * @param {Message} message
 * @returns {Promise<Message>}
 */
export async function addMessage(message) {
  db.prepare(`
    INSERT INTO messages (id, chat_id, role, agent_id, author_name, content, attachments, tool_calls, is_local_command_only, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    message.id, message.chatId, message.role, message.agentId, message.authorName,
    message.content, JSON.stringify(message.attachments ?? []), JSON.stringify(message.toolCalls ?? []),
    message.isLocalCommandOnly ? 1 : 0, message.createdAt
  );
  return message;
}

// ─── Settings ──────────────────────────────────────────────────────────────

const DEFAULT_USER_DISPLAY_NAME = 'You';
const DEFAULT_USER_COLOR = '#a6adc8';
const DEFAULT_USER_LOCALE = 'en-CA';
const DEFAULT_USER_THEME = 'dark';

/**
 * Returns a raw settings value, or defaultValue if the key isn't set.
 * @param {string} key
 * @param {string} defaultValue
 * @returns {string}
 */
function getSetting(key, defaultValue) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row?.value || defaultValue;
}

/**
 * Inserts or updates a raw settings value.
 * @param {string} key
 * @param {string} value
 * @returns {void}
 */
function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

/**
 * Returns the user's configured display name, defaulting to "You". Used both
 * for new messages and, via rowToMessage, to resolve authorName for past
 * user-authored messages too — renaming applies retroactively.
 * @returns {string}
 */
export function getUserDisplayName() {
  return getSetting('userDisplayName', DEFAULT_USER_DISPLAY_NAME);
}

/**
 * Sets the user's display name.
 * @param {string} name
 * @returns {Promise<void>}
 */
export async function setUserDisplayName(name) {
  setSetting('userDisplayName', name);
}

/**
 * Returns the user's configured message color (hex string).
 * @returns {string}
 */
export function getUserColor() {
  return getSetting('userColor', DEFAULT_USER_COLOR);
}

/**
 * Sets the user's message color.
 * @param {string} color - Hex color string, e.g. "#a6adc8"
 * @returns {Promise<void>}
 */
export async function setUserColor(color) {
  setSetting('userColor', color);
}

/**
 * Returns the user's configured UI language, defaulting to "en-CA".
 * @returns {string}
 */
export function getUserLocale() {
  return getSetting('locale', DEFAULT_USER_LOCALE);
}

/**
 * Sets the user's UI language.
 * @param {string} locale - e.g. "en-CA" or "fr-CA"
 * @returns {Promise<void>}
 */
export async function setUserLocale(locale) {
  setSetting('locale', locale);
}

/**
 * Returns the user's configured UI theme, defaulting to "dark".
 * @returns {string}
 */
export function getUserTheme() {
  return getSetting('theme', DEFAULT_USER_THEME);
}

/**
 * Sets the user's UI theme.
 * @param {string} theme - "dark" or "light"
 * @returns {Promise<void>}
 */
export async function setUserTheme(theme) {
  setSetting('theme', theme);
}

// ─── Scheduled Messages ─────────────────────────────────────────────────────

/**
 * Returns a chat's pending scheduled messages, ordered by sendAt ascending.
 * @param {string} chatId
 * @returns {ScheduledMessage[]}
 */
export function getScheduledMessages(chatId) {
  return db.prepare('SELECT * FROM scheduled_messages WHERE chat_id = ? ORDER BY send_at ASC')
    .all(chatId).map(rowToScheduledMessage);
}

/**
 * Returns a single scheduled message by ID, or undefined if not found.
 * @param {string} id
 * @returns {ScheduledMessage | undefined}
 */
export function getScheduledMessage(id) {
  const row = db.prepare('SELECT * FROM scheduled_messages WHERE id = ?').get(id);
  return row ? rowToScheduledMessage(row) : undefined;
}

/**
 * Returns every pending scheduled message across all chats — used once at
 * server startup to re-arm in-memory timers after a restart (see
 * services/scheduler.js's initScheduler).
 * @returns {ScheduledMessage[]}
 */
export function getAllScheduledMessages() {
  return db.prepare('SELECT * FROM scheduled_messages').all().map(rowToScheduledMessage);
}

/**
 * Creates and persists a new scheduled message.
 * @param {Omit<ScheduledMessage, 'createdAt'>} data
 * @returns {Promise<ScheduledMessage>}
 */
export async function createScheduledMessage(data) {
  const createdAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO scheduled_messages (id, chat_id, content, attachments, send_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(data.id, data.chatId, data.content, JSON.stringify(data.attachments ?? []), data.sendAt, createdAt);
  return rowToScheduledMessage(
    db.prepare('SELECT * FROM scheduled_messages WHERE id = ?').get(data.id)
  );
}

/**
 * Deletes a scheduled message if it still exists, returning what was
 * deleted (or null if it was already gone — already fired, already
 * canceled, or never existed). Used for BOTH cancellation and firing, so
 * whichever happens first "wins" and the other becomes a safe no-op.
 *
 * Safe without a SQL `RETURNING` clause: node:sqlite's DatabaseSync is
 * fully synchronous, so this SELECT-then-DELETE has no `await` between the
 * two statements and nothing else can run in between on Node's single
 * thread — the same reasoning already relied on elsewhere in this file
 * (e.g. removeChatMember's changes>0 check).
 * @param {string} id
 * @returns {Promise<ScheduledMessage | null>}
 */
export async function deleteScheduledMessageIfExists(id) {
  const row = db.prepare('SELECT * FROM scheduled_messages WHERE id = ?').get(id);
  if (!row) return null;
  db.prepare('DELETE FROM scheduled_messages WHERE id = ?').run(id);
  return rowToScheduledMessage(row);
}

// ─── Maintenance ───────────────────────────────────────────────────────────

/**
 * Deletes all data from every table. Used by the /__reset test endpoint.
 * @returns {Promise<void>}
 */
export async function resetAll() {
  const txn = transaction(() => {
    db.prepare('DELETE FROM scheduled_messages').run();
    db.prepare('DELETE FROM messages').run();
    db.prepare('DELETE FROM chat_members').run();
    db.prepare('DELETE FROM chats').run();
    db.prepare('DELETE FROM agents').run();
    db.prepare('DELETE FROM settings').run();
  });
  txn();
}
