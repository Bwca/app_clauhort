/**
 * @fileoverview E2E tests: observer agents. An observer (created via the
 * "Observer" checkbox) exists to silently watch a busy chat and summarize it
 * on demand — it must never respond to a broadcast (un-@mentioned) message,
 * only to an explicit @mention. Real subprocess only (cheap "reply with
 * exactly: X" turns) — proving the observer's much larger history window
 * (server/ws/handler.js's OBSERVER_HISTORY_LIMIT) would need 20+ real paid
 * turns just to fill the normal cap, so that's covered separately, manually,
 * not here.
 */

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, resetData, TEST_PORT } from '../helpers/server.js';
import {
  launchBrowser, closeBrowser, openPage, closePage,
  tid, createChat, createAgent, sendMessage, waitForAgentResponse,
} from '../helpers/browser.js';
import { agentDir, cleanupAgentDirs } from '../helpers/fixtures.js';

describe('Observer agents', () => {
  /** @type {import('puppeteer').Page} */
  let page;

  before(async () => {
    await startServer();
    await launchBrowser();
  });

  after(async () => {
    await closeBrowser();
    await stopServer();
  });

  beforeEach(async () => {
    await resetData();
    if (page) await closePage();
    page = await openPage();
    await createChat(page, 'Observer Test');
  });

  afterEach(() => {
    cleanupAgentDirs();
  });

  test('creating an agent with Observer checked persists isObserver and shows the badge', async () => {
    await createAgent(page, {
      name: 'Overseer',
      workingDir: agentDir('overseer'),
      addToChat: true,
      observerMode: true,
    });

    await page.waitForFunction(
      () => document.querySelector('[data-testid="agent-observer-badge"]') !== null,
      { timeout: 3000 }
    );

    const agentsRes = await (await fetch(`http://localhost:${TEST_PORT}/api/agents`)).json();
    const overseer = agentsRes.find((a) => a.name === 'Overseer');
    assert.ok(overseer, 'agent should have been created');
    assert.equal(overseer.isObserver, true, 'isObserver should be persisted');
  });

  test('an observer never responds to a broadcast message', async () => {
    await createAgent(page, { name: 'Worker', workingDir: agentDir('worker'), addToChat: true });
    await createAgent(page, {
      name: 'Overseer',
      workingDir: agentDir('overseer'),
      addToChat: true,
      observerMode: true,
    });

    await sendMessage(page, 'reply with exactly: PONG');
    const reply = await waitForAgentResponse(page, { timeout: 30_000 });
    assert.equal(reply, 'PONG', "the non-observer worker should still respond to a broadcast");

    // No timing race to guard against: exclusion happens server-side in
    // parseResponders before any stream is ever started for the observer —
    // if it were going to respond, AGENT_STREAM_START would already have
    // fired for it by the time the worker's own reply finished.
    const authors = await page.$$eval(tid('msg-author'), (els) => els.map((el) => el.textContent.trim()));
    assert.ok(!authors.includes('Overseer'), `observer should never have posted a message, got authors: ${authors}`);
  });

  test('an observer responds to an explicit @mention', async () => {
    await createAgent(page, {
      name: 'Overseer',
      workingDir: agentDir('overseer'),
      addToChat: true,
      observerMode: true,
    });

    await sendMessage(page, '@Overseer reply with exactly: OBSERVED');
    const reply = await waitForAgentResponse(page, { timeout: 30_000 });
    assert.equal(reply, 'OBSERVED');
  });
});
