/**
 * @fileoverview E2E tests: chat creation, selection, and deletion.
 */

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, resetData, TEST_PORT } from '../helpers/server.js';
import {
  launchBrowser, closeBrowser, openPage, closePage,
  tid, createChat, createAgent, sendMessage, reloadAndWaitForConnection,
} from '../helpers/browser.js';
import { agentDir, cleanupAgentDirs } from '../helpers/fixtures.js';

/**
 * Hovers and clicks the delete button on the sidebar chat item whose visible
 * name includes `name`, waits for the confirm modal, optionally checks its
 * "also delete agents" checkbox, then confirms or cancels.
 * @param {import('puppeteer').Page} page
 * @param {string} name
 * @param {{ deleteAgents?: boolean, confirm?: boolean }} [opts]
 * @returns {Promise<void>}
 */
async function deleteChatByName(page, name, { deleteAgents = false, confirm = true } = {}) {
  const items = await page.$$(tid('chat-item'));
  let target = null;
  for (const item of items) {
    const text = await item.evaluate((el) => el.textContent);
    if (text.includes(name)) { target = item; break; }
  }
  if (!target) throw new Error(`no chat-item found containing "${name}"`);
  await target.hover();
  const delBtn = await target.$(tid('chat-del-btn'));
  await delBtn.click();
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="confirm-overlay"]')?.hidden,
    { timeout: 3000 }
  );
  if (deleteAgents) await page.click(tid('confirm-checkbox'));
  await page.click(tid(confirm ? 'confirm-ok' : 'confirm-cancel'));
}

/**
 * Clicks the sidebar chat item whose visible name includes `name` — chats
 * are only reachable by name in the UI (no per-chat testid), unlike agents.
 * @param {import('puppeteer').Page} page
 * @param {string} name
 * @returns {Promise<void>}
 */
async function clickChatByName(page, name) {
  const items = await page.$$(tid('chat-item'));
  for (const item of items) {
    const text = await item.evaluate((el) => el.textContent);
    if (text.includes(name)) {
      await item.click();
      return;
    }
  }
  throw new Error(`no chat-item found containing "${name}"`);
}

describe('Chat management', () => {
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
  });

  afterEach(() => {
    cleanupAgentDirs();
  });

  test('creates a chat and shows it in the sidebar', async () => {
    await createChat(page, 'Backend Squad');

    const names = await page.$$eval(
      tid('chat-item-name'),
      (els) => els.map((el) => el.textContent.trim())
    );
    assert.ok(names.some((n) => n.includes('Backend Squad')), `names: ${names}`);
  });

  test('selecting a chat shows the chat view and hides empty state', async () => {
    await createChat(page, 'Frontend Squad');

    const emptyHidden = await page.$eval(tid('empty-state'), (el) => el.hidden);
    assert.ok(emptyHidden, 'empty state should be hidden after selecting chat');

    const topbarText = await page.$eval(tid('chat-topbar-name'), (el) => el.textContent.trim());
    assert.ok(topbarText.includes('Frontend Squad'), `topbar: "${topbarText}"`);
  });

  test('creates multiple chats and all appear in the sidebar', async () => {
    await createChat(page, 'Alpha');
    await createChat(page, 'Beta');
    await createChat(page, 'Gamma');

    const count = await page.$$eval(tid('chat-item'), (els) => els.length);
    assert.equal(count, 3);
  });

  test('deletes a chat and removes it from the sidebar', async () => {
    await createChat(page, 'Temporary Chat');

    // Hover to reveal delete button then click it
    const chatItem = await page.$(tid('chat-item'));
    await chatItem.hover();
    await page.click(tid('chat-del-btn'));
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="confirm-overlay"]')?.hidden,
      { timeout: 3000 }
    );
    await page.click(tid('confirm-ok'));

    // Wait for it to disappear
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="chat-item"]').length === 0,
      { timeout: 3000 }
    );

    const count = await page.$$eval(tid('chat-item'), (els) => els.length);
    assert.equal(count, 0);
  });

  test('canceling the delete confirmation keeps the chat', async () => {
    await createChat(page, 'Keep Me');

    const chatItem = await page.$(tid('chat-item'));
    await chatItem.hover();
    await page.click(tid('chat-del-btn'));
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="confirm-overlay"]')?.hidden,
      { timeout: 3000 }
    );
    await page.click(tid('confirm-cancel'));

    await page.waitForFunction(
      () => document.querySelector('[data-testid="confirm-overlay"]')?.hidden,
      { timeout: 3000 }
    );
    const count = await page.$$eval(tid('chat-item'), (els) => els.length);
    assert.equal(count, 1, 'chat should still be there after canceling the confirmation');
  });

  test('deleting active chat shows empty state again', async () => {
    await createChat(page, 'Soon Gone');

    const chatItem = await page.$(tid('chat-item'));
    await chatItem.hover();
    await page.click(tid('chat-del-btn'));
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="confirm-overlay"]')?.hidden,
      { timeout: 3000 }
    );
    await page.click(tid('confirm-ok'));

    await page.waitForFunction(
      () => !document.querySelector('[data-testid="empty-state"]')?.hidden,
      { timeout: 3000 }
    );

    const emptyVisible = await page.$eval(tid('empty-state'), (el) => !el.hidden);
    assert.ok(emptyVisible, 'empty state should reappear after deleting active chat');
  });

  test('deleting a chat with "also delete agents" checked permanently removes only that chat\'s agents', async () => {
    await createChat(page, 'Chat With Agents');
    await createAgent(page, { name: 'Doomed', workingDir: agentDir('doomed'), addToChat: true });

    await createChat(page, 'Other Chat');
    await createAgent(page, { name: 'Survivor', workingDir: agentDir('survivor'), addToChat: true });

    await deleteChatByName(page, 'Chat With Agents', { deleteAgents: true });

    await page.waitForFunction(
      (n) => ![...document.querySelectorAll('[data-testid="chat-item-name"]')].some((el) => el.textContent.includes(n)),
      { timeout: 3000 },
      'Chat With Agents'
    );

    const agents = await (await fetch(`http://localhost:${TEST_PORT}/api/agents`)).json();
    assert.ok(!agents.some((a) => a.name === 'Doomed'), 'Doomed should have been permanently deleted along with its chat');
    assert.ok(agents.some((a) => a.name === 'Survivor'), "Survivor belongs to a different chat and must be untouched");
  });

  test('deleting a chat without checking "also delete agents" leaves its agents intact', async () => {
    await createChat(page, 'Chat Kept Agents');
    await createAgent(page, { name: 'Spared', workingDir: agentDir('spared'), addToChat: true });

    await deleteChatByName(page, 'Chat Kept Agents', { deleteAgents: false });

    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="chat-item"]').length === 0,
      { timeout: 3000 }
    );

    const agents = await (await fetch(`http://localhost:${TEST_PORT}/api/agents`)).json();
    assert.ok(agents.some((a) => a.name === 'Spared'), 'agent should survive its chat being deleted by default');
  });

  test('an agent reply landing in a background chat shows an unread indicator; opening the chat clears it', async () => {
    await createChat(page, 'Chat A');
    await createAgent(page, { name: 'Claudia', workingDir: agentDir('claudia'), addToChat: true });

    await createChat(page, 'Chat B');
    await createAgent(page, { name: 'Clarence', workingDir: agentDir('clarence'), addToChat: true });
    // Chat B is active here (createChat/createAgent select it).

    await sendMessage(page, '@Clarence reply with exactly: pong');
    // Switch away immediately, before the real response has a chance to
    // land — the point is proving it's flagged unread even though nobody
    // was watching it arrive.
    await clickChatByName(page, 'Chat A');

    await page.waitForFunction(
      (name) => {
        const items = [...document.querySelectorAll('[data-testid="chat-item"]')];
        const b = items.find((el) => el.textContent.includes(name));
        return b?.querySelector('[data-testid="chat-unread-dot"]') != null;
      },
      { timeout: 30_000 },
      'Chat B'
    );

    const aHasDot = await page.evaluate(() => {
      const items = [...document.querySelectorAll('[data-testid="chat-item"]')];
      const a = items.find((el) => el.textContent.includes('Chat A'));
      return a?.querySelector('[data-testid="chat-unread-dot"]') != null;
    });
    assert.equal(aHasDot, false, 'the currently active chat should never show its own unread dot');

    await clickChatByName(page, 'Chat B');
    await page.waitForFunction(
      () => document.querySelector('[data-testid="chat-unread-dot"]') === null,
      { timeout: 3000 }
    );
  });

  test('switching away and back while a reply is still streaming shows it in progress, not silently missing', async () => {
    await createChat(page, 'Chat A');
    await createAgent(page, { name: 'Claudia', workingDir: agentDir('claudia'), addToChat: true });
    await createChat(page, 'Chat B'); // ends up active — Chat A is now in the background

    await clickChatByName(page, 'Chat A');
    await sendMessage(page, "@Claudia use the Bash tool to run `sleep 3`, then reply with exactly: done");

    // Switch away before the agent's reply is anywhere near done.
    await clickChatByName(page, 'Chat B');
    await new Promise((r) => setTimeout(r, 1500));

    // Switch back into Chat A while Claudia is still working — this is the
    // exact scenario that used to leave no trace of the in-progress reply.
    await clickChatByName(page, 'Chat A');

    await page.waitForFunction(
      () => document.querySelector('[data-testid="streaming-bubble"]') !== null,
      { timeout: 5000 }
    );
    await page.waitForFunction(
      () => document.querySelector('[data-testid="streaming-bubble"]') === null,
      { timeout: 30_000 }
    );

    const messages = await page.$$(tid('message') + '[data-role="agent"]');
    const last = messages[messages.length - 1];
    const text = await last.$eval(tid('msg-content'), (el) => el.textContent);
    assert.equal(text, 'done', 'the finished reply should render once the user is back on its chat');
  });

  test('selecting a chat never touches the URL, but persists via sessionStorage — refreshing returns to that same chat', async () => {
    await createChat(page, 'Chat A');
    await createChat(page, 'Chat B'); // ends up active — createChat selects what it creates

    assert.equal(new URL(page.url()).search, '', 'the chat id must never be exposed as a URL query param');
    const storedId = await page.evaluate((key) => sessionStorage.getItem(key), 'app.activeChatId');
    assert.ok(storedId, 'expected the active chat id to be persisted in sessionStorage');

    await reloadAndWaitForConnection(page);

    const topbarText = await page.$eval(tid('chat-topbar-name'), (el) => el.textContent.trim());
    assert.ok(topbarText.includes('Chat B'), `expected to land back on Chat B after reload, topbar: "${topbarText}"`);
    assert.equal(new URL(page.url()).search, '', 'the URL must still have no query params after the reload restores the chat');
  });

  test('deleting the active chat clears its sessionStorage entry', async () => {
    await createChat(page, 'Ephemeral Chat');
    const storedIdBefore = await page.evaluate((key) => sessionStorage.getItem(key), 'app.activeChatId');
    assert.ok(storedIdBefore, 'sanity check: sessionStorage should have a chat id before deleting');

    const chatItem = await page.$(tid('chat-item'));
    await chatItem.hover();
    await page.click(tid('chat-del-btn'));
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="confirm-overlay"]')?.hidden,
      { timeout: 3000 }
    );
    await page.click(tid('confirm-ok'));

    await page.waitForFunction(
      () => !document.querySelector('[data-testid="empty-state"]')?.hidden,
      { timeout: 3000 }
    );
    const storedIdAfter = await page.evaluate((key) => sessionStorage.getItem(key), 'app.activeChatId');
    assert.equal(storedIdAfter, null, 'the stored chat id should be gone once its chat is deleted');
  });

  test('a stale sessionStorage entry (chat since deleted) is dropped, not restored', async () => {
    await page.evaluate((key) => sessionStorage.setItem(key, 'does-not-exist'), 'app.activeChatId');
    await reloadAndWaitForConnection(page);

    const emptyVisible = await page.$eval(tid('empty-state'), (el) => !el.hidden);
    assert.ok(emptyVisible, 'a stale stored chat id should fall back to the empty state, not error out');
    const storedId = await page.evaluate((key) => sessionStorage.getItem(key), 'app.activeChatId');
    assert.equal(storedId, null, 'the stale entry should be cleared, not left sitting in storage');
  });
});
