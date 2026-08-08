/**
 * @fileoverview Filesystem directory-browsing route, backing the New Agent
 * modal's folder picker. Browsers deliberately don't expose real absolute
 * paths from native file/folder pickers (even the File System Access API
 * only returns sandboxed handles), so the picker instead browses the
 * filesystem through this server-side listing and returns real path strings.
 * Mounted at /api/browse.
 */

import { Router } from 'express';
import { readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { dirname, resolve } from 'path';
import { t } from '../i18n/t.js';

const router = Router();

/**
 * @typedef {Object} BrowseEntry
 * @property {string} name
 * @property {string} path
 */

// Contains null bytes, which no real filesystem path can — filesystems
// reject them outright — so this can never collide with an actual path a
// user navigates to. Used as a sentinel `path` value meaning "list
// available drives", kept distinct from an empty/missing path (which
// already means "use the home directory", see below). The client never
// needs to know this value means anything special: it treats `parent` as
// an opaque token and just sends back whatever the server gave it, so no
// client-side change is needed to round-trip this correctly.
const WINDOWS_DRIVES_SENTINEL = '\u0000windows-drives\u0000';

/**
 * Lists available drive letters (C:\, D:\, ...). Windows has no single
 * filesystem root to browse "up" to the way POSIX has "/" — this is what a
 * drive root's "parent" points to instead, so there's still somewhere to
 * go from e.g. C:\ if the folder you want is on D:\.
 * @returns {BrowseEntry[]}
 */
function listWindowsDrives() {
  const drives = [];
  for (let code = 65; code <= 90; code++) {
    const letter = String.fromCharCode(code);
    const path = `${letter}:\\`;
    if (existsSync(path)) drives.push({ name: `${letter}:`, path });
  }
  return drives;
}

/**
 * GET /api/browse?path=<absolute path>
 * Lists the subdirectories of the given path (defaults to the user's home
 * directory). Hidden (dotfile) directories are excluded.
 * @param {string} [req.query.path]
 * @returns {{ path: string, parent: string | null, entries: BrowseEntry[] }}
 */
router.get('/', async (req, res) => {
  if (req.query.path === WINDOWS_DRIVES_SENTINEL) {
    return res.json({ path: '', parent: null, entries: listWindowsDrives() });
  }

  const requested = typeof req.query.path === 'string' && req.query.path ? req.query.path : homedir();
  const target = resolve(requested);

  let dirents;
  try {
    dirents = await readdir(target, { withFileTypes: true });
  } catch (err) {
    return res.status(400).json({ error: t('errors.cantReadDirectory', { message: err.message }) });
  }

  const entries = dirents
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => ({ name: d.name, path: resolve(target, d.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const rawParent = dirname(target);
  const atRoot = rawParent === target;
  const parent = atRoot
    ? (process.platform === 'win32' ? WINDOWS_DRIVES_SENTINEL : null)
    : rawParent;
  res.json({ path: target, parent, entries });
});

export default router;
