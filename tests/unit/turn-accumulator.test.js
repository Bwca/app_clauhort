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

describe('createTurnAccumulator — text across a tool call', () => {
  // Confirmed live against the real CLI (`claude --print --output-format=
  // stream-json --verbose`): a turn with "text, tool call, more text" isn't
  // one assistant message whose content array keeps growing across the tool
  // call — it's a sequence of SEPARATE assistant messages, a new message.id
  // each time a tool call interrupts the model's output, each with its own
  // content array that starts fresh (same shape reproduced inline below).
  // Before this was tracked per (message id, block index), the second
  // message's short, just-started text got sliced against the first
  // message's already-longer length, dropping or mangling everything after
  // the turn's first tool call.

  test('text before and after a tool call is both captured, in order, with nothing dropped', () => {
    const chunks = [];
    const turn = createTurnAccumulator({ onChunk: (text) => chunks.push(text) });

    // First assistant message: commentary, then a tool call. The CLI sends
    // growing snapshots of the SAME message as it's produced.
    turn.handleEvent({ type: 'assistant', message: { id: 'msg_1', content: [] } });
    turn.handleEvent({
      type: 'assistant',
      message: { id: 'msg_1', content: [{ type: 'text', text: 'Let me check something first.' }] },
    });
    turn.handleEvent({
      type: 'assistant',
      message: {
        id: 'msg_1',
        content: [
          { type: 'text', text: 'Let me check something first.' },
          { type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    });
    turn.handleEvent({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'file1\nfile2' }] },
    });

    // Second assistant message: a brand new message.id, own content array
    // starting fresh — NOT a continuation of msg_1's text.
    turn.handleEvent({
      type: 'assistant',
      message: { id: 'msg_2', content: [{ type: 'text', text: 'Found it, done.' }] },
    });
    turn.handleEvent({ type: 'result', result: 'Found it, done.' });

    assert.equal(turn.fullText, 'Let me check something first.Found it, done.');
    assert.deepEqual(chunks, ['Let me check something first.', 'Found it, done.']);
  });

  test('a second text block at the same index in a new message does not get its head sliced off', () => {
    // The exact failure mode: msg_1's text block (30 chars) sets the old
    // turn-wide length to 30; msg_2's text block starts short and only
    // grows past 30 once fully formed, at which point slicing it against
    // the stale turn-wide length used to emit a tail fragment starting
    // mid-string instead of the block's actual start.
    const chunks = [];
    const turn = createTurnAccumulator({ onChunk: (text) => chunks.push(text) });

    turn.handleEvent({
      type: 'assistant',
      message: { id: 'msg_1', content: [{ type: 'text', text: 'A'.repeat(30) }] },
    });
    turn.handleEvent({
      type: 'assistant',
      message: {
        id: 'msg_1',
        content: [{ type: 'text', text: 'A'.repeat(30) }, { type: 'tool_use', id: 'call_1', name: 'Bash', input: {} }],
      },
    });
    turn.handleEvent({
      type: 'assistant',
      message: { id: 'msg_2', content: [{ type: 'text', text: 'short reply' }] },
    });

    assert.equal(turn.fullText, `${'A'.repeat(30)}short reply`);
    assert.equal(chunks.at(-1), 'short reply');
  });
});
