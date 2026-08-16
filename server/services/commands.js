/**
 * @fileoverview Lists an agent's custom Claude Code slash commands, read
 * straight from its project's `.claude/commands/*.md` files — the same
 * mechanism `parseSkillInvocation` (messageRouter.js) relies on to actually
 * invoke one. Used to power the composer's slash-command autocomplete;
 * purely a filesystem read, no `claude` subprocess involved.
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * @typedef {Object} SlashCommand
 * @property {string} name - The command's invocable name, e.g. "echo-test"
 *   for `.claude/commands/echo-test.md` (invoked as "/echo-test").
 * @property {string | null} description - Parsed from the file's YAML
 *   frontmatter `description:` field, if present. Always null for a
 *   `builtin` entry — the CLI's own init event reports names only.
 * @property {boolean} builtin - True for a CLI skill (built-in, or from an
 *   installed marketplace/plugin) reported by the agent's own live process,
 *   as opposed to a project-level `.claude/commands/*.md` file.
 */

/**
 * Extracts the `description:` value from a command file's leading YAML
 * frontmatter block (`---\n...\n---`), if any. Deliberately lenient — this
 * only needs the one field for display purposes, not a full YAML parse, and
 * a command file without frontmatter (or without a description) is common
 * and not an error.
 * @param {string} raw - The full file contents
 * @returns {string | null}
 */
function parseFrontmatterDescription(raw) {
  const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatter) return null;
  const descLine = frontmatter[1].split(/\r?\n/).find((line) => /^description:/.test(line.trim()));
  if (!descLine) return null;
  return descLine.slice(descLine.indexOf(':') + 1).trim().replace(/^["']|["']$/g, '') || null;
}

/**
 * Lists the custom slash commands available to an agent working in
 * `workingDir` — every `.md` file directly inside `.claude/commands/`
 * (project-level only; not recursing into subdirectories, and not
 * including any user-level `~/.claude/commands/` — see file header for why
 * that's an acceptable scope for now). Returns `[]` if the directory
 * doesn't exist, rather than treating that as an error — most agents won't
 * have any custom commands defined.
 * @param {string} workingDir
 * @returns {SlashCommand[]} Sorted alphabetically by name
 */
export function listAgentCommands(workingDir) {
  const dir = join(workingDir, '.claude', 'commands');
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const name = f.slice(0, -3);
      let description = null;
      try {
        description = parseFrontmatterDescription(readFileSync(join(dir, f), 'utf-8'));
      } catch {
        // Unreadable file (permissions, race with a concurrent delete, etc.)
        // — still list the command by name, just without a description.
      }
      return { name, description, builtin: false };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Merges an agent's project-level commands with its live process's
 * reported CLI skill names into one alphabetical list for the composer's
 * "/" autocomplete — project commands win on a name collision (they carry
 * a description; a same-named builtin entry would be redundant).
 * @param {SlashCommand[]} projectCommands - From listAgentCommands.
 * @param {string[]} builtinSkillNames - From agentProcessManager's
 *   getAgentSkills.
 * @returns {SlashCommand[]} Sorted alphabetically by name.
 */
export function mergeSkills(projectCommands, builtinSkillNames) {
  const projectNames = new Set(projectCommands.map((c) => c.name));
  const builtins = builtinSkillNames
    .filter((name) => !projectNames.has(name))
    .map((name) => ({ name, description: null, builtin: true }));
  return [...projectCommands, ...builtins].sort((a, b) => a.name.localeCompare(b.name));
}
