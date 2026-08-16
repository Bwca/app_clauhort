/**
 * @fileoverview E2E tests: an agent belongs to at most one chat at a time.
 * An agent's resumeId is a single global Claude CLI session — being in two
 * chats simultaneously would bleed one chat's conversation into another's.
 * Leaving a chat (removed, or the chat itself deleted) must also reset that
 * session, so a later add to a *different* chat starts genuinely fresh
 * rather than silently carrying the old chat's memory forward.
 */

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, resetData, TEST_PORT } from '../helpers/server.js';
import {
  launchBrowser, closeBrowser, openPage, closePage,
  tid, createChat, createAgent, sendMessage, waitForAgentResponse,
} from '../helpers/browser.js';
import { agentDir, cleanupAgentDirs } from '../helpers/fixtures.js';

/**
 * Removes the sole agent currently shown in the panel from the active chat
 * via the UI (hover to reveal the overflow menu, open it, click Remove,
 * wait for the panel to empty out).
 * @param {import('puppeteer').Page} page
 * @returns {Promise<void>}
 */
async function removeSoleAgentFromChat(page) {
  const agentItem = await page.$(tid('agent-item'));
  await agentItem.hover();
  await page.click(tid('agent-menu-btn'));
  await page.click(tid('agent-remove-btn'));
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="agent-item"]').length === 0,
    { timeout: 3000 }
  );
}

/**
 * Grants the first (only expected) permission-denial row shown, waiting for
 * both the card and the "granted" confirmation — same shape as the grant
 * flow in 08-permissions.test.js, kept minimal here since this file only
 * needs one grant to populate allowedToolPatterns.
 * @param {import('puppeteer').Page} page
 * @returns {Promise<void>}
 */
async function grantFirstPermission(page) {
  await page.waitForFunction(
    () => document.querySelector('[data-testid="perm-card"]') !== null,
    { timeout: 15_000 }
  );
  await page.click(tid('perm-grant-btn'));
  await page.waitForFunction(
    () => document.querySelector('[data-testid="perm-grant-btn"]')?.textContent.includes('✓'),
    { timeout: 3000 }
  );
}

describe('Agent chat exclusivity', () => {
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

  test('a busy agent never appears in another chat\'s add-agent menu', async () => {
    await createChat(page, 'Chat A');
    await createAgent(page, { name: 'Shared', workingDir: agentDir('shared'), addToChat: true });

    await createChat(page, 'Chat B');
    await createAgent(page, { name: 'Free', workingDir: agentDir('free'), addToChat: false });

    await page.waitForFunction(
      () => !document.querySelector('[data-testid="add-agent-btn"]')?.hidden,
      { timeout: 3000 }
    );
    await page.click(tid('add-agent-btn'));
    await page.waitForSelector(tid('add-agent-menu'), { visible: true });

    const menuItems = await page.$$eval(tid('add-menu-item'), (els) => els.map((el) => el.textContent.trim()));
    assert.ok(menuItems.some((t) => t.includes('Free')), `expected Free to be offered, got: ${menuItems}`);
    assert.ok(!menuItems.some((t) => t.includes('Shared')), `Shared is busy in Chat A and must not be offered, got: ${menuItems}`);
  });

  test('the API rejects adding a busy agent to a second chat, on both add-member and create-chat-with-members', async () => {
    await createChat(page, 'Chat A');
    await createAgent(page, { name: 'Shared', workingDir: agentDir('shared'), addToChat: true });

    const chatsBefore = await (await fetch(`http://localhost:${TEST_PORT}/api/chats`)).json();
    const chatA = chatsBefore.find((c) => c.name === 'Chat A');
    const agents = await (await fetch(`http://localhost:${TEST_PORT}/api/agents`)).json();
    const shared = agents.find((a) => a.name === 'Shared');

    // Direct POST /api/chats/:id/members against a second, pre-existing chat.
    await createChat(page, 'Chat B');
    const chatsAfterB = await (await fetch(`http://localhost:${TEST_PORT}/api/chats`)).json();
    const chatB = chatsAfterB.find((c) => c.name === 'Chat B');

    const addRes = await fetch(`http://localhost:${TEST_PORT}/api/chats/${chatB.id}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: shared.id }),
    });
    assert.equal(addRes.status, 400);
    const addBody = await addRes.json();
    assert.match(addBody.error, /Shared/);
    assert.match(addBody.error, /Chat A/);

    const chatBAfter = await (await fetch(`http://localhost:${TEST_PORT}/api/chats/${chatB.id}`)).json();
    assert.ok(!chatBAfter.memberAgentIds.includes(shared.id), 'the rejected add must not have landed');

    // POST /api/chats with memberAgentIds containing a busy agent.
    const createRes = await fetch(`http://localhost:${TEST_PORT}/api/chats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Chat C', memberAgentIds: [shared.id] }),
    });
    assert.equal(createRes.status, 400);

    const allChats = await (await fetch(`http://localhost:${TEST_PORT}/api/chats`)).json();
    assert.ok(!allChats.some((c) => c.name === 'Chat C'), 'no chat should have been created on rejection');
  });

  test('removing an agent from its chat clears resumeId, but permission grants survive', async () => {
    const dir = agentDir('claudia');
    await createChat(page, 'Grant Test');
    await createAgent(page, { name: 'Claudia', workingDir: dir, addToChat: true });

    await sendMessage(page, '@Claudia use the Bash tool to run exactly: git init -q && git add -A');
    await waitForAgentResponse(page, { timeout: 30_000 });
    await grantFirstPermission(page);
    // Granting auto-continues the agent's turn (see the GRANT_PERMISSION
    // handler) — wait for that follow-up turn to actually finish, or it's
    // still running server-side when this test ends and afterEach deletes
    // the agent's workingDir out from under it.
    await waitForAgentResponse(page, { timeout: 30_000 });

    const agentsBefore = await (await fetch(`http://localhost:${TEST_PORT}/api/agents`)).json();
    const before = agentsBefore.find((a) => a.name === 'Claudia');
    assert.ok(before.resumeId, 'resumeId should be captured after the first turn');
    assert.ok(before.allowedToolPatterns?.length, 'allowedToolPatterns should be populated by the grant');

    await removeSoleAgentFromChat(page);

    const agentsAfter = await (await fetch(`http://localhost:${TEST_PORT}/api/agents`)).json();
    const after = agentsAfter.find((a) => a.id === before.id);
    assert.ok(!after.resumeId, 'resumeId should be cleared once the agent leaves its chat');
    assert.deepEqual(after.allowedToolPatterns, before.allowedToolPatterns, 'permission grants must survive removal — they are durable capabilities, not conversational memory');
  });

  test('re-adding an agent to a different chat starts a genuinely fresh session, with no memory of the old one', async () => {
    const dir = agentDir('claudia');
    await createChat(page, 'Chat A');
    await createAgent(page, { name: 'Claudia', workingDir: dir, addToChat: true });

    await sendMessage(page, '@Claudia my favorite fictional pet is named Zorblatt72. Just reply with exactly: ok');
    const reply1 = await waitForAgentResponse(page, { timeout: 30_000 });
    assert.equal(reply1, 'ok');

    const agentsAfterA = await (await fetch(`http://localhost:${TEST_PORT}/api/agents`)).json();
    const afterA = agentsAfterA.find((a) => a.name === 'Claudia');
    assert.ok(afterA.resumeId, 'resumeId should be captured after chat A');

    await removeSoleAgentFromChat(page);

    await createChat(page, 'Chat B');
    await page.click(tid('add-agent-btn'));
    await page.waitForSelector(tid('add-agent-menu'), { visible: true });
    const menuItem = await page.$(tid('add-menu-item'));
    await menuItem.click();
    await page.waitForSelector(tid('agent-item'), { visible: true });

    await sendMessage(
      page,
      '@Claudia what is my favorite fictional pet named? Reply with just the name, or exactly UNKNOWN if you genuinely don\'t know.'
    );
    const reply2 = await waitForAgentResponse(page, { timeout: 30_000 });
    assert.doesNotMatch(reply2.toLowerCase(), /zorblatt72/, `chat B must not remember chat A's content, got: "${reply2}"`);

    const agentsAfterB = await (await fetch(`http://localhost:${TEST_PORT}/api/agents`)).json();
    const afterB = agentsAfterB.find((a) => a.name === 'Claudia');
    assert.ok(afterB.resumeId, 'resumeId should be captured again after chat B');
    assert.notEqual(afterB.resumeId, afterA.resumeId, 'a genuinely new Claude session must have started for chat B');
  });
});
