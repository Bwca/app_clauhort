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
    assert.deepEqual(result.map((c) => c.name), ['alpha', 'code-review', 'echo-test', 'zeta']);
  });

  test('a builtin skill gets a null description and builtin: true', () => {
    const result = mergeSkills([], ['code-review']);
    assert.deepEqual(result, [{ name: 'code-review', description: null, builtin: true }]);
  });

  test('a project command wins on a name collision — the builtin duplicate is dropped', () => {
    const projectCommands = [{ name: 'code-review', description: 'Custom override', builtin: false }];
    const result = mergeSkills(projectCommands, ['code-review']);
    assert.equal(result.length, 1, `expected the duplicate builtin entry to be dropped, got: ${JSON.stringify(result)}`);
    assert.equal(result[0].description, 'Custom override');
  });

  test('no builtin skills known yet (process never spawned) returns just the project commands', () => {
    const projectCommands = [{ name: 'echo-test', description: null, builtin: false }];
    const result = mergeSkills(projectCommands, []);
    assert.deepEqual(result, projectCommands);
  });
});
