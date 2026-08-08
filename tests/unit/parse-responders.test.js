/**
 * @fileoverview Unit tests for parseResponders/extractMentionedAgents
 * (server/services/messageRouter.js) — pure functions, no `claude`
 * subprocess involved.
 *
 * Context: an "observer" agent (agent.isObserver) exists to silently watch
 * a busy chat and summarize it on demand — it must never be pulled into
 * responding to a plain broadcast message (no @mention), only to an
 * explicit @mention (typed directly, relayed by a teammate's reply, or via
 * a scheduled message, all of which resolve through these same functions).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseResponders, extractMentionedAgents } from '../../server/services/messageRouter.js';

function agent(id, name, isObserver = false) {
  return isObserver ? { id, name, isObserver: true } : { id, name };
}

describe('parseResponders', () => {
  test('a broadcast (no mention) reaches everyone when there are no observers — unchanged behavior', () => {
    const a = agent('a', 'Alice');
    const b = agent('b', 'Bob');
    assert.deepEqual(parseResponders('hello team', [a, b]), [a, b]);
  });

  test('a broadcast excludes an observer but still reaches non-observer members', () => {
    const a = agent('a', 'Alice');
    const observer = agent('c', 'Overseer', true);
    assert.deepEqual(parseResponders('hello team', [a, observer]), [a]);
  });

  test('a broadcast in an all-observer chat resolves to an empty list without throwing', () => {
    const observer = agent('c', 'Overseer', true);
    assert.deepEqual(parseResponders('hello team', [observer]), []);
  });

  test('an explicit @mention of an observer still routes to it', () => {
    const a = agent('a', 'Alice');
    const observer = agent('c', 'Overseer', true);
    assert.deepEqual(parseResponders('@Overseer please summarize', [a, observer]), [observer]);
  });

  test('an explicit @mention of a non-observer is unaffected by an observer merely being present in the chat', () => {
    const a = agent('a', 'Alice');
    const observer = agent('c', 'Overseer', true);
    assert.deepEqual(parseResponders('@Alice go', [a, observer]), [a]);
  });

  test('a multi-mention message including an observer resolves both — mentions always bypass the broadcast filter', () => {
    const a = agent('a', 'Alice');
    const observer = agent('c', 'Overseer', true);
    const result = parseResponders('@Alice @Overseer sync up', [a, observer]);
    assert.deepEqual(new Set(result), new Set([a, observer]));
  });
});

describe('extractMentionedAgents', () => {
  test('still matches an observer by name, regardless of broadcast rules — needed for the relay path', () => {
    const observer = agent('c', 'Overseer', true);
    assert.deepEqual(extractMentionedAgents('cc @Overseer for visibility', [observer]), [observer]);
  });

  test('returns empty (not "everyone") when nothing is mentioned — never falls back to broadcast', () => {
    const observer = agent('c', 'Overseer', true);
    assert.deepEqual(extractMentionedAgents('no mentions here', [observer]), []);
  });
});
