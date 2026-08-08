/**
 * @fileoverview E2E tests: agent creation and chat membership.
 */

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, basename } from 'node:path';
import { startServer, stopServer, resetData, TEST_PORT } from '../helpers/server.js';
import {
  launchBrowser, closeBrowser, openPage, closePage,
  tid, createChat, createAgent, sendMessage, waitForAgentResponse,
} from '../helpers/browser.js';
import { agentDir, cleanupAgentDirs } from '../helpers/fixtures.js';

/**
 * Clears the browse path input and types a new value into it.
 * @param {import('puppeteer').Page} page
 * @param {string} path
 * @returns {Promise<void>}
 */
async function typeBrowsePath(page, path) {
  await page.click(tid('browse-path-input'));
  await page.evaluate(() => { document.querySelector('[data-testid="browse-path-input"]').value = ''; });
  await page.type(tid('browse-path-input'), path);
}

describe('Agent management', () => {
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
    // Most agent tests need an active chat
    await createChat(page, 'Dev Chat');
  });

  afterEach(() => {
    cleanupAgentDirs();
  });

  test('opens the create-agent modal', async () => {
    await page.click(tid('new-agent-btn'));
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="modal-overlay"]')?.hidden,
      { timeout: 3000 }
    );

    const modalVisible = await page.$eval(tid('modal-overlay'), (el) => !el.hidden);
    assert.ok(modalVisible, 'modal should be visible');
  });

  test('generate-name button fills the name field with a "Cla…" name', async () => {
    await page.click(tid('new-agent-btn'));
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="modal-overlay"]')?.hidden,
      { timeout: 3000 }
    );

    const before = await page.$eval(tid('agent-name-input'), (el) => el.value);
    assert.equal(before, '', 'name field should start empty');

    await page.click(tid('agent-name-generate'));
    const generated = await page.$eval(tid('agent-name-input'), (el) => el.value);
    assert.match(generated, /^Cla/, `generated name should start with "Cla", got: "${generated}"`);
  });

  test('modal closes on cancel', async () => {
    await page.click(tid('new-agent-btn'));
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="modal-overlay"]')?.hidden,
      { timeout: 3000 }
    );
    await page.click(tid('modal-cancel'));
    await page.waitForFunction(
      () => document.querySelector('[data-testid="modal-overlay"]')?.hidden,
      { timeout: 3000 }
    );

    const hidden = await page.$eval(tid('modal-overlay'), (el) => el.hidden);
    assert.ok(hidden, 'modal should be hidden after cancel');
  });

  test('creates an agent and it appears in the agent panel', async () => {
    await createAgent(page, {
      name: 'Claudia',
      workingDir: agentDir('claudia'),
      addToChat: true,
    });

    await page.waitForFunction(
      () => document.querySelector('[data-testid="agent-item"]') !== null,
      { timeout: 3000 }
    );
    const names = await page.$$eval(
      tid('agent-name'),
      (els) => els.map((el) => el.textContent.trim())
    );
    assert.ok(names.includes('Claudia'), `agent names in panel: ${names}`);
  });

  test('removes an agent from the chat', async () => {
    await createAgent(page, {
      name: 'Claudia',
      workingDir: agentDir('claudia'),
      addToChat: true,
    });

    await page.waitForFunction(
      () => document.querySelector('[data-testid="agent-item"]') !== null,
      { timeout: 3000 }
    );

    // Hover agent item to reveal remove button
    const agentItem = await page.$(tid('agent-item'));
    await agentItem.hover();
    await page.click(tid('agent-remove-btn'));

    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="agent-item"]').length === 0,
      { timeout: 3000 }
    );

    const count = await page.$$eval(tid('agent-item'), (els) => els.length);
    assert.equal(count, 0);
  });

  test('canceling the delete confirmation keeps the agent', async () => {
    await createAgent(page, { name: 'Claudia', workingDir: agentDir('claudia'), addToChat: true });

    const agentItem = await page.$(tid('agent-item'));
    await agentItem.hover();
    await page.click(tid('agent-del-btn'));
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="confirm-overlay"]')?.hidden,
      { timeout: 3000 }
    );
    await page.click(tid('confirm-cancel'));

    await page.waitForFunction(
      () => document.querySelector('[data-testid="confirm-overlay"]')?.hidden,
      { timeout: 3000 }
    );
    const count = await page.$$eval(tid('agent-item'), (els) => els.length);
    assert.equal(count, 1, 'agent should still be there after canceling the confirmation');
  });

  test('deleting an agent that has sent messages succeeds and keeps the messages', async () => {
    await createAgent(page, { name: 'Claudia', workingDir: agentDir('claudia'), addToChat: true });
    await sendMessage(page, '@Claudia reply with exactly: pong');
    await waitForAgentResponse(page, { timeout: 90_000 });

    const agentItem = await page.$(tid('agent-item'));
    const agentId = await agentItem.evaluate((el) => el.dataset.agentId);
    await agentItem.hover();

    await page.click(tid('agent-del-btn'));
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="confirm-overlay"]')?.hidden,
      { timeout: 3000 }
    );
    const [response] = await Promise.all([
      page.waitForResponse((res) => res.url().endsWith(`/api/agents/${agentId}`) && res.request().method() === 'DELETE'),
      page.click(tid('confirm-ok')),
    ]);
    assert.equal(response.status(), 204, 'deleting an agent that has sent messages should succeed, not fail on a FK constraint');

    const chats = await (await fetch(`http://localhost:${TEST_PORT}/api/chats`)).json();
    const chat = chats.find((c) => c.name === 'Dev Chat');
    const msgs = await (await fetch(`http://localhost:${TEST_PORT}/api/chats/${chat.id}/messages`)).json();
    const agentMsg = msgs.find((m) => m.authorName === 'Claudia');
    assert.ok(agentMsg, "Claudia's message should survive her own deletion");
    assert.equal(agentMsg.agentId, null, 'agentId should be nulled out, not left dangling, after the agent is deleted');
  });

  test('open-folder button hits the open-folder endpoint for the right agent', async () => {
    await createAgent(page, {
      name: 'Claudia',
      workingDir: agentDir('claudia'),
      addToChat: true,
    });

    await page.waitForFunction(
      () => document.querySelector('[data-testid="agent-item"]') !== null,
      { timeout: 3000 }
    );

    const agentItem = await page.$(tid('agent-item'));
    const agentId = await agentItem.evaluate((el) => el.dataset.agentId);
    await agentItem.hover();

    const [response] = await Promise.all([
      page.waitForResponse((res) => res.url().includes('/open-folder') && res.request().method() === 'POST'),
      page.click(tid('agent-open-folder-btn')),
    ]);

    assert.ok(response.url().endsWith(`/api/agents/${agentId}/open-folder`), `unexpected URL: ${response.url()}`);
    assert.equal(response.status(), 200);
  });

  test('agent created without "add to chat" does not appear in panel', async () => {
    await createAgent(page, {
      name: 'Lurker',
      workingDir: agentDir('lurker'),
      addToChat: false,
    });

    // Give the panel a moment to update
    await new Promise((r) => setTimeout(r, 300));
    const count = await page.$$eval(tid('agent-item'), (els) => els.length);
    assert.equal(count, 0, 'agent should not be in panel when addToChat=false');
  });

  test('add-agent button appears after creating agent without adding to chat, and adds them', async () => {
    await createAgent(page, {
      name: 'Standby',
      workingDir: agentDir('standby'),
      addToChat: false,
    });

    // "Add agent" button should now appear (was hidden when no agents available)
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="add-agent-btn"]')?.hidden,
      { timeout: 3000 }
    );
    await page.click(tid('add-agent-btn'));

    await page.waitForSelector(tid('add-agent-menu'), { visible: true });
    const menuItems = await page.$$eval(tid('add-menu-item'), (els) => els.map((el) => el.textContent.trim()));
    assert.ok(menuItems.some((t) => t.includes('Standby')), `menu items: ${menuItems}`);

    // Click the item to add to chat
    const menuItem = await page.$(tid('add-menu-item'));
    await menuItem.click();

    await page.waitForSelector(tid('agent-item'), { visible: true });
    const inPanel = await page.$$eval(tid('agent-name'), (els) => els.map((el) => el.textContent.trim()));
    assert.ok(inPanel.includes('Standby'), `panel agents: ${inPanel}`);
  });

  test('folder browser navigates into a subdirectory and selects it', async () => {
    const dir = agentDir('nested-target');
    const parent = dirname(dir);
    const baseName = basename(dir);

    await page.click(tid('new-agent-btn'));
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="modal-overlay"]')?.hidden,
      { timeout: 3000 }
    );

    await page.click(tid('agent-dir-browse'));
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="browse-overlay"]')?.hidden,
      { timeout: 3000 }
    );

    // Navigate to the fixture dir's parent, then click into the fixture dir itself.
    // Note: we can't wait on browse-path-input's value here, since typeBrowsePath
    // already set it via real typing, well before the /api/browse response for
    // `parent` (fired by clicking "Go") has necessarily resolved and rendered —
    // that wait would pass instantly regardless of fetch state. Wait on the
    // rendered list actually containing the target entry instead.
    await typeBrowsePath(page, parent);
    await page.click(tid('browse-path-go'));
    await page.waitForFunction(
      (expected) => [...document.querySelectorAll('[data-testid="browse-item"]')]
        .some((el) => el.textContent === expected),
      { timeout: 5000 },
      baseName
    );

    const items = await page.$$(tid('browse-item'));
    const labels = await Promise.all(items.map((el) => el.evaluate((n) => n.textContent)));
    const targetIdx = labels.indexOf(baseName);
    assert.ok(targetIdx !== -1, `expected a "${baseName}" entry, got: ${labels}`);
    await items[targetIdx].click();

    await page.waitForFunction(
      (expected) => document.querySelector('[data-testid="browse-path-input"]')?.value === expected,
      { timeout: 3000 },
      dir
    );

    await page.click(tid('browse-select'));
    await page.waitForFunction(
      () => document.querySelector('[data-testid="browse-overlay"]')?.hidden,
      { timeout: 3000 }
    );

    const dirValue = await page.$eval(tid('agent-dir-input'), (el) => el.value);
    assert.equal(dirValue, dir, 'agent-dir input should be filled with the selected folder');
  });

  test('folder browser ignores a stale out-of-order response (race regression)', async () => {
    const dir = agentDir('race-target');

    await page.click(tid('new-agent-btn'));
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="modal-overlay"]')?.hidden,
      { timeout: 3000 }
    );

    // Artificially delay the default (home-dir) /api/browse request so it
    // resolves AFTER a subsequent, faster one — deterministically reproducing
    // the out-of-order race this test guards against.
    await page.evaluate(() => {
      const realFetch = window.fetch;
      window.fetch = (url, opts) => {
        if (url === '/api/browse') {
          return new Promise((resolve) => setTimeout(() => resolve(realFetch(url, opts)), 1200));
        }
        return realFetch(url, opts);
      };
    });

    // Opening the browser fires the (delayed) default request...
    await page.click(tid('agent-dir-browse'));
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="browse-overlay"]')?.hidden,
      { timeout: 3000 }
    );

    // ...but before it resolves, navigate straight to a specific, fast-resolving path.
    await typeBrowsePath(page, dir);
    await page.click(tid('browse-path-go'));
    await page.waitForFunction(
      (expected) => document.querySelector('[data-testid="browse-path-input"]')?.value === expected,
      { timeout: 3000 },
      dir
    );

    // Wait past the artificial delay so the stale default request resolves too.
    await new Promise((r) => setTimeout(r, 1800));

    const finalValue = await page.$eval(tid('browse-path-input'), (el) => el.value);
    assert.equal(finalValue, dir, 'a stale, later-resolving default response must not clobber a newer navigation');
  });

  test('folder browser shows an error for an invalid path', async () => {
    await page.click(tid('new-agent-btn'));
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="modal-overlay"]')?.hidden,
      { timeout: 3000 }
    );
    await page.click(tid('agent-dir-browse'));
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="browse-overlay"]')?.hidden,
      { timeout: 3000 }
    );

    await typeBrowsePath(page, '/definitely-not-a-real-path-xyz');
    await page.click(tid('browse-path-go'));

    await page.waitForFunction(
      () => !document.querySelector('[data-testid="browse-error"]')?.hidden,
      { timeout: 3000 }
    );
    const errText = await page.$eval(tid('browse-error'), (el) => el.textContent);
    assert.ok(errText.length > 0, 'error message should be shown');
  });

  test('creating an agent with a non-existent working directory is rejected, not created', async () => {
    await page.click(tid('new-agent-btn'));
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="modal-overlay"]')?.hidden,
      { timeout: 3000 }
    );
    await page.type(tid('agent-name-input'), 'Ghost');
    await page.type(tid('agent-dir-input'), '/definitely-not-a-real-path-xyz');
    await page.click(tid('modal-submit'));

    await page.waitForFunction(
      () => !document.querySelector('[data-testid="agent-error"]')?.hidden,
      { timeout: 5000 }
    );
    const errText = await page.$eval(tid('agent-error'), (el) => el.textContent);
    assert.match(errText, /doesn.t exist/i, `expected a missing-directory error, got: "${errText}"`);

    // Modal must stay open — the whole point is the agent was never created.
    const modalHidden = await page.$eval(tid('modal-overlay'), (el) => el.hidden);
    assert.equal(modalHidden, false, 'modal should remain open after a rejected creation');

    const agentsRes = await (await fetch(`http://localhost:${TEST_PORT}/api/agents`)).json();
    assert.ok(!agentsRes.some((a) => a.name === 'Ghost'), 'agent should not have been persisted');
  });
});
