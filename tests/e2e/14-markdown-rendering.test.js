/**
 * @fileoverview E2E tests: agent replies render as real markdown (bold,
 * code, code blocks) instead of literal `**`/backtick syntax, safely —
 * raw HTML in a reply must never become a real, executable element. User-
 * typed messages must stay plain text. Real Puppeteer + a real `claude`
 * subprocess (asking it to reply with exact markdown), no mocking.
 */

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, resetData } from '../helpers/server.js';
import {
  launchBrowser, closeBrowser, openPage, closePage,
  tid, createChat, createAgent, sendMessage, waitForAgentResponse,
} from '../helpers/browser.js';
import { agentDir, cleanupAgentDirs } from '../helpers/fixtures.js';

describe('Markdown rendering', () => {
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

  test('bold, italic, and inline code render as real elements, not literal syntax', async () => {
    await createChat(page, 'Markdown Inline Test');
    await createAgent(page, { name: 'Claudia', workingDir: agentDir('claudia'), addToChat: true });

    await sendMessage(page, 'Reply with exactly: **bold** and *italic* and `code`');
    await waitForAgentResponse(page, { timeout: 30_000 });

    const contentEl = tid('message') + '[data-role="agent"] ' + tid('msg-content');
    const strongText = await page.$eval(contentEl + ' strong', (el) => el.textContent);
    assert.equal(strongText, 'bold');
    const emText = await page.$eval(contentEl + ' em', (el) => el.textContent);
    assert.equal(emText, 'italic');
    const codeText = await page.$eval(contentEl + ' code', (el) => el.textContent);
    assert.equal(codeText, 'code');

    const fullText = await page.$eval(contentEl, (el) => el.textContent);
    assert.ok(!fullText.includes('**'), `rendered text should not contain literal markdown syntax, got: ${fullText}`);
    assert.ok(!fullText.includes('`'), `rendered text should not contain literal backticks, got: ${fullText}`);
  });

  test('a fenced code block renders as pre>code with the content preserved', async () => {
    await createChat(page, 'Markdown Code Block Test');
    await createAgent(page, { name: 'Claudia', workingDir: agentDir('claudia'), addToChat: true });

    await sendMessage(page, 'Reply with exactly a fenced code block containing: const x = 1;');
    await waitForAgentResponse(page, { timeout: 30_000 });

    const contentEl = tid('message') + '[data-role="agent"] ' + tid('msg-content');
    const codeText = await page.$eval(contentEl + ' pre code', (el) => el.textContent.trim());
    assert.equal(codeText, 'const x = 1;');
  });

  test('raw HTML in a reply is neutralized to literal text, never a real element', async () => {
    await createChat(page, 'Markdown XSS Test');
    await createAgent(page, { name: 'Claudia', workingDir: agentDir('claudia'), addToChat: true });

    await sendMessage(page, 'Reply with exactly this literal text and nothing else: <script>alert(1)</script>');
    await waitForAgentResponse(page, { timeout: 30_000 });

    const contentEl = tid('message') + '[data-role="agent"] ' + tid('msg-content');
    const hasRealScriptTag = await page.$eval(contentEl, (el) => el.querySelector('script') !== null);
    assert.equal(hasRealScriptTag, false, 'a <script> tag in agent output must never become a real, executable element');

    const visibleText = await page.$eval(contentEl, (el) => el.textContent);
    assert.ok(visibleText.includes('<script>alert(1)</script>'), `expected the literal tag text to still be visible, got: ${visibleText}`);
  });

  test('a user-typed message is never markdown-rendered', async () => {
    await createChat(page, 'Markdown User Message Test');

    await sendMessage(page, '**not bold** and `not code`');
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="message"]').length > 0,
      { timeout: 5000 }
    );

    const contentEl = tid('message') + '[data-role="user"] ' + tid('msg-content');
    const hasStrong = await page.$eval(contentEl, (el) => el.querySelector('strong') !== null);
    assert.equal(hasStrong, false, 'a user message must never be markdown-rendered');
    const text = await page.$eval(contentEl, (el) => el.textContent);
    assert.equal(text, '**not bold** and `not code`');
  });
});
