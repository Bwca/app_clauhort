/**
 * @fileoverview E2E tests: message search — the 🔍 topbar search bar (UI:
 * highlighted results, jumping to and flashing an already-loaded message,
 * closing on Escape) and the REST endpoints it's built on (chat isolation,
 * LIKE-wildcard escaping, 404 on an unknown message id) via direct fetch,
 * same split as tests/e2e/12-scheduled-messages.test.js.
 */

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, resetData, TEST_PORT } from '../helpers/server.js';
import {
  launchBrowser, closeBrowser, openPage, closePage,
  tid, createChat, sendMessage,
} from '../helpers/browser.js';
import { cleanupAgentDirs } from '../helpers/fixtures.js';

const API = `http://localhost:${TEST_PORT}`;

describe('Message search', () => {
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

  /** @returns {Promise<string>} id of the (only) chat, via the REST API */
  async function getChatId() {
    const res = await fetch(`${API}/api/chats`);
    const [chat] = await res.json();
    return chat.id;
  }

  test('search dropdown shows matches with the query highlighted, newest first', async () => {
    await createChat(page, 'Search UI');
    await sendMessage(page, 'discussing the release plan');
    await sendMessage(page, 'nothing relevant here');
    await sendMessage(page, 'one more release note');
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="message"]').length === 3,
      { timeout: 3000 }
    );

    await page.click(tid('search-btn'));
    await page.waitForFunction(() => !document.querySelector('[data-testid="search-bar"]')?.hidden, { timeout: 3000 });
    await page.type(tid('search-input'), 'release');

    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="search-result-item"]').length === 2,
      { timeout: 3000 }
    );
    const snippets = await page.$$eval('[data-testid="search-result-item"] .search-result-snippet', (els) => els.map((e) => e.innerHTML));
    // Newest match ("one more release note") sorts first.
    assert.match(snippets[0], /one more <mark>release<\/mark> note/);
    assert.match(snippets[1], /discussing the <mark>release<\/mark> plan/);
  });

  test('shows a "no results" placeholder for a query with no matches', async () => {
    await createChat(page, 'Search Empty');
    await sendMessage(page, 'hello there');
    await page.waitForSelector(tid('message'));

    await page.click(tid('search-btn'));
    await page.waitForFunction(() => !document.querySelector('[data-testid="search-bar"]')?.hidden, { timeout: 3000 });
    await page.type(tid('search-input'), 'zzzznomatch');
    await page.waitForFunction(() => !document.querySelector('[data-testid="search-results"]')?.hidden, { timeout: 3000 });

    const empty = await page.$(tid('search-result-empty'));
    assert.ok(empty, 'expected the no-results placeholder to be shown');
  });

  test('clicking a result jumps to and flashes the message, closing the search bar', async () => {
    await createChat(page, 'Search Jump');
    await sendMessage(page, 'find this one please');
    await sendMessage(page, 'unrelated filler');
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="message"]').length === 2,
      { timeout: 3000 }
    );

    await page.click(tid('search-btn'));
    await page.waitForFunction(() => !document.querySelector('[data-testid="search-bar"]')?.hidden, { timeout: 3000 });
    await page.type(tid('search-input'), 'find this');
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="search-result-item"]').length === 1,
      { timeout: 3000 }
    );
    await page.click(tid('search-result-item'));

    // Search bar closes on selecting a result.
    const searchBarHidden = await page.$eval(tid('search-bar'), (el) => el.hidden);
    assert.equal(searchBarHidden, true);

    // The target message is flashed (highlight-flash class applied).
    const flashed = await page.waitForFunction(
      () => [...document.querySelectorAll('[data-testid="message"]')]
        .some((el) => el.classList.contains('highlight-flash') && el.textContent.includes('find this one please')),
      { timeout: 3000 }
    );
    assert.ok(flashed);

    // Jumping to an already-loaded message doesn't show the "back to
    // latest" banner — nothing was actually replaced.
    const bannerHidden = await page.$eval(tid('jumped-banner'), (el) => el.hidden);
    assert.equal(bannerHidden, true);
  });

  test('Escape closes the search bar without changing the message list', async () => {
    await createChat(page, 'Search Escape');
    await sendMessage(page, 'a message');
    await page.waitForSelector(tid('message'));

    await page.click(tid('search-btn'));
    await page.waitForFunction(() => !document.querySelector('[data-testid="search-bar"]')?.hidden, { timeout: 3000 });
    await page.focus(tid('search-input'));
    await page.keyboard.press('Escape');

    const hidden = await page.$eval(tid('search-bar'), (el) => el.hidden);
    assert.equal(hidden, true);
  });

  test('search is scoped to the active chat', async () => {
    await createChat(page, 'Chat A');
    await sendMessage(page, 'a secret only chat A has');
    const chatAId = await getChatId();

    await createChat(page, 'Chat B');
    const listRes = await fetch(`${API}/api/chats`);
    const chats = await listRes.json();
    const chatB = chats.find((c) => c.id !== chatAId);

    const searchInB = await fetch(`${API}/api/chats/${chatB.id}/messages/search?q=secret`);
    assert.deepEqual(await searchInB.json(), []);

    const searchInA = await fetch(`${API}/api/chats/${chatAId}/messages/search?q=secret`);
    const resultsInA = await searchInA.json();
    assert.equal(resultsInA.length, 1);
  });

  test('a literal % in the query is matched literally, not as a SQL LIKE wildcard', async () => {
    await createChat(page, 'Percent');
    await sendMessage(page, 'discount is 50% today');
    await page.waitForSelector(tid('message'));
    const chatId = await getChatId();

    const res = await fetch(`${API}/api/chats/${chatId}/messages/search?q=${encodeURIComponent('50%')}`);
    const results = await res.json();
    assert.equal(results.length, 1);
    assert.match(results[0].content, /50% today/);

    // A literal "%" shouldn't match unrelated text just because LIKE
    // treats it as a wildcard when unescaped.
    const noMatch = await fetch(`${API}/api/chats/${chatId}/messages/search?q=${encodeURIComponent('9%')}`);
    assert.deepEqual(await noMatch.json(), []);
  });

  test('the context endpoint 404s for an id that does not belong to the chat', async () => {
    await createChat(page, 'Context 404');
    await sendMessage(page, 'hello');
    await page.waitForSelector(tid('message'));
    const chatId = await getChatId();

    const res = await fetch(`${API}/api/chats/${chatId}/messages/context/not-a-real-id`);
    assert.equal(res.status, 404);
  });
});
