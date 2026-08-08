/**
 * @fileoverview E2E tests: image/large-text attachment capture, chips, and rendering.
 * Paste events are simulated (Puppeteer can't drive the real OS clipboard) via
 * helpers.pasteImage/pasteText, which dispatch synthetic ClipboardEvents.
 */

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, resetData } from '../helpers/server.js';
import {
  launchBrowser, closeBrowser, openPage, closePage,
  tid, createChat, createAgent, pasteImage, pasteText, waitForAgentResponse,
} from '../helpers/browser.js';
import { agentDir, cleanupAgentDirs } from '../helpers/fixtures.js';

// 10x10 solid-green PNG.
const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAIAAAACUFjqAAAAE0lEQVR4nGNkOMGABzDhkxy50gD98gDcrZvX5QAAAABJRU5ErkJggg==';

describe('Attachments', () => {
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
    await createChat(page, 'Attachments Test');
  });

  afterEach(() => {
    cleanupAgentDirs();
  });

  test('pasting an image shows a removable attachment chip', async () => {
    await pasteImage(page, TINY_PNG_B64);

    await page.waitForFunction(
      () => document.querySelector('[data-testid="attachment-chip"]') !== null,
      { timeout: 3000 }
    );
    const chipCount = await page.$$eval(tid('attachment-chip'), (els) => els.length);
    assert.equal(chipCount, 1);

    await page.click(tid('attachment-chip-remove'));
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="attachment-chip"]').length === 0,
      { timeout: 3000 }
    );
  });

  test('pasting a large text block shows a "Pasted text" chip instead of inline text', async () => {
    const bigText = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    await pasteText(page, bigText);

    await page.waitForFunction(
      () => document.querySelector('[data-testid="attachment-chip"]') !== null,
      { timeout: 3000 }
    );
    const label = await page.$eval('.attachment-chip-label', (el) => el.textContent);
    assert.ok(label.includes('Pasted text'), `label: "${label}"`);

    const inputValue = await page.$eval(tid('msg-input'), (el) => el.value);
    assert.equal(inputValue, '', 'large paste should not be inserted inline into the textarea');
  });

  test('sending a message with an image attachment renders it in the message list', async () => {
    await pasteImage(page, TINY_PNG_B64);
    await page.waitForSelector(tid('attachment-chip'), { visible: true });

    await page.click(tid('msg-input'));
    await page.type(tid('msg-input'), 'check this out');
    await page.keyboard.press('Enter');

    await page.waitForFunction(
      () => document.querySelector('[data-testid="msg-attachment-image"]') !== null,
      { timeout: 5000 }
    );
    const src = await page.$eval(tid('msg-attachment-image'), (el) => el.getAttribute('src'));
    assert.ok(src.startsWith('data:image/png;base64,'), `src: "${src}"`);

    // Composer should be cleared of pending chips after send.
    const chipsHidden = await page.$eval(tid('attachment-chips'), (el) => el.hidden);
    assert.ok(chipsHidden, 'attachment chips row should be cleared after sending');
  });

  test('sending a message with a text-paste attachment renders a collapsible block', async () => {
    const bigText = Array.from({ length: 25 }, (_, i) => `log line ${i}`).join('\n');
    await pasteText(page, bigText);
    await page.waitForSelector(tid('attachment-chip'), { visible: true });
    await page.keyboard.press('Enter');

    await page.waitForFunction(
      () => document.querySelector('[data-testid="msg-attachment-text"]') !== null,
      { timeout: 5000 }
    );
    const fullText = await page.$eval(
      tid('msg-attachment-text') + ' pre',
      (el) => el.textContent
    );
    assert.equal(fullText, bigText, 'full pasted text should be preserved, not truncated');
  });

  test('agent can actually see a pasted image (real Claude CLI call)', async () => {
    await createAgent(page, { name: 'Claudia', workingDir: agentDir('claudia'), addToChat: true });

    await pasteImage(page, TINY_PNG_B64);
    await page.waitForSelector(tid('attachment-chip'), { visible: true });
    await page.click(tid('msg-input'));
    await page.type(tid('msg-input'), '@Claudia What solid color is the attached image? One word.');
    await page.keyboard.press('Enter');

    const responseText = await waitForAgentResponse(page, { timeout: 90_000 });
    assert.match(responseText.toLowerCase(), /green/, `expected the agent to identify green, got: "${responseText}"`);
  });
});
