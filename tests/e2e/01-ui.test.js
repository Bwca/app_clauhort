/**
 * @fileoverview E2E tests: initial UI state and layout.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, resetData } from '../helpers/server.js';
import { launchBrowser, closeBrowser, openPage, closePage, tid } from '../helpers/browser.js';
import { APP_NAME } from '../../server/public/appName.js';

describe('Initial UI', () => {
  /** @type {import('puppeteer').Page} */
  let page;

  before(async () => {
    await startServer();
    await launchBrowser();
    await resetData();
    page = await openPage();
  });

  after(async () => {
    await closePage();
    await closeBrowser();
    await stopServer();
  });

  test('page title is APP_NAME', async () => {
    assert.equal(await page.title(), APP_NAME);
  });

  test('connection dot is green (WebSocket connected)', async () => {
    const connected = await page.$eval(
      tid('conn-dot'),
      (el) => el.classList.contains('connected')
    );
    assert.ok(connected, 'conn-dot should have .connected class');
  });

  test('empty state is visible when no chat is selected', async () => {
    const visible = await page.$eval(
      tid('empty-state'),
      (el) => !el.hidden && el.offsetParent !== null
    );
    assert.ok(visible, 'empty state should be visible');
  });

  test('agent panel shows "No chat selected" notice', async () => {
    const text = await page.$eval(tid('no-chat-notice'), (el) => el.textContent.trim());
    assert.ok(text.includes('No chat'), `got: "${text}"`);
  });

  test('chat list is empty', async () => {
    const count = await page.$$eval(tid('chat-item'), (els) => els.length);
    assert.equal(count, 0);
  });
});
