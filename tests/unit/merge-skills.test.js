/**
 * @fileoverview Unit tests for mergeSkills (server/services/commands.js) —
 * a pure function, no `claude` subprocess or filesystem access involved.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mergeSkills } from '../../server/services/commands.js';

describe('mergeSkills', () => {
  test('combines project commands and builtin skills, sorted alphabetically', () => {
    const projectCommands = [
      { name: 'echo-test', description: 'A test command', builtin: false },
      { name: 'zeta', description: null, builtin: false },
    ];
    const result = mergeSkills(projectCommands, ['code-review', 'alpha']);
    // "compact" always appears too — see the ALLOWED_BUILTIN_COMMANDS test below.
    assert.deepEqual(result.map((c) => c.name), ['alpha', 'code-review', 'compact', 'echo-test', 'zeta']);
  });

  test('a builtin skill gets a null description and builtin: true', () => {
    const result = mergeSkills([], ['code-review']);
    assert.deepEqual(result, [
      { name: 'code-review', description: null, builtin: true },
      { name: 'compact', description: null, builtin: true },
    ]);
  });

  test('a project command wins on a name collision — the builtin duplicate is dropped', () => {
    const projectCommands = [{ name: 'code-review', description: 'Custom override', builtin: false }];
    const result = mergeSkills(projectCommands, ['code-review']);
    assert.equal(result.length, 2, `expected the duplicate builtin entry to be dropped, got: ${JSON.stringify(result)}`);
    assert.equal(result.find((c) => c.name === 'code-review').description, 'Custom override');
  });

  test('ALLOWED_BUILTIN_COMMANDS (e.g. "/compact") is always offered, even with no builtin skills reported yet', () => {
    const projectCommands = [{ name: 'echo-test', description: null, builtin: false }];
    const result = mergeSkills(projectCommands, []);
    assert.deepEqual(result, [
      { name: 'compact', description: null, builtin: true },
      { name: 'echo-test', description: null, builtin: false },
    ]);
  });

  test('a project command named "compact" still wins over the carve-out entry', () => {
    const projectCommands = [{ name: 'compact', description: 'Custom override', builtin: false }];
    const result = mergeSkills(projectCommands, []);
    assert.deepEqual(result, [{ name: 'compact', description: 'Custom override', builtin: false }]);
  });
});
