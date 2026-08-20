/**
 * @fileoverview Unit tests for createTurnAccumulator (server/services/
 * agentProcessManager.js)'s `result` event handling — a pure function, no
 * `claude` subprocess involved.
 *
 * Context: confirmed live against the real CLI that a `result` event isn't
 * always a successful completion — an agent created with a bogus resumeId
 * (an invalid `--resume` flag) produces a well-formed `result` event with
 * `is_error: true`, `subtype: "error_during_execution"`, and the actual
 * message in `errors` (not `result`, which is why the old code's fallback
 * landed on the empty `fullText` instead). Before turn.errorMessage existed,
 * runOneTurn's handleEvent treated every `result` event as success, so this
 * resolved the turn with an empty string instead of surfacing the error —
 * an empty reply bubble with zero diagnostic, silently, on every turn.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createTurnAccumulator } from '../../server/services/agentProcessManager.js';

describe('createTurnAccumulator — result event error detection', () => {
  test('a successful result event leaves errorMessage null', () => {
    const turn = createTurnAccumulator();
    turn.handleEvent({ type: 'result', result: 'all good' });
    assert.equal(turn.errorMessage, null);
    assert.equal(turn.resultText, 'all good');
    assert.equal(turn.done, true);
  });

  test('an is_error result event with an errors array sets errorMessage from it', () => {
    const turn = createTurnAccumulator();
    turn.handleEvent({
      type: 'result',
      is_error: true,
      subtype: 'error_during_execution',
      errors: ['Error: --resume requires a valid session ID or session title when used with --print.'],
    });
    assert.equal(turn.errorMessage, 'Error: --resume requires a valid session ID or session title when used with --print.');
  });

  test('multiple errors are joined', () => {
    const turn = createTurnAccumulator();
    turn.handleEvent({ type: 'result', is_error: true, errors: ['first problem', 'second problem'] });
    assert.equal(turn.errorMessage, 'first problem; second problem');
  });

  test('an is_error result event with no errors array falls back to resultText, then a generic message', () => {
    const turn = createTurnAccumulator();
    turn.handleEvent({ type: 'result', is_error: true, result: 'some result text' });
    assert.equal(turn.errorMessage, 'some result text');

    const turnNoText = createTurnAccumulator();
    turnNoText.handleEvent({ type: 'result', is_error: true });
    assert.equal(turnNoText.errorMessage, 'unknown error');
  });

  test('a non-result event never sets errorMessage, even with is_error-looking fields', () => {
    const turn = createTurnAccumulator();
    turn.handleEvent({ type: 'assistant', is_error: true, message: { content: [] } });
    assert.equal(turn.errorMessage, null);
  });
});
