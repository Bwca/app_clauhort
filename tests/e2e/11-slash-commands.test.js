/**
 * @fileoverview E2E tests: slash-command autocomplete in the composer.
 * A slash command only ever works as the entire message (optionally
 * preceded by exactly one "@Name "), matching parseSkillInvocation's
 * server-side semantics — the dropdown must never offer something that
 * wouldn't actually fire.
 */

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, stopServer, resetData } from '../helpers/server.js';
import {
  launchBrowser, closeBrowser, openPage, closePage,
  tid, createChat, createAgent, sendMessage, waitForAgentResponse,
} from '../helpers/browser.js';
import { agentDir, cleanupAgentDirs } from '../helpers/fixtures.js';

/**
 * Writes a custom Claude Code command file into an agent's project dir.
 * @param {string} dir - Agent workingDir
 * @param {string} name - Command name (file becomes .claude/commands/<name>.md)
 * @param {string} body - Full markdown body, frontmatter included if any
 */
function writeCommand(dir, name, body) {
  mkdirSync(join(dir, '.claude', 'commands'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'commands', `${name}.md`), body);
}

describe('Slash-command autocomplete', () => {
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

  test('typing "/" in a single-agent chat lists that agent\'s custom commands, with descriptions', async () => {
    const dir = agentDir('claudia');
    writeCommand(dir, 'echo-test', '---\ndescription: Fires a fixed reply\n---\nReply with exactly: SLASH_COMMAND_FIRED\n');
    writeCommand(dir, 'no-desc', 'Just a plain command body, no frontmatter.\n');

    await createChat(page, 'Slash Test');
    await createAgent(page, { name: 'Claudia', workingDir: dir, addToChat: true });

    await page.click(tid('msg-input'));
    await page.type(tid('msg-input'), '/');
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="mention-dropdown"]')?.hidden,
      { timeout: 3000 }
    );

    const items = await page.$$eval(tid('slash-command-item'), (els) => els.map((el) => el.textContent.trim()));
    assert.ok(items.some((t) => t.includes('/echo-test') && t.includes('Fires a fixed reply')), `items: ${items}`);
    assert.ok(items.some((t) => t.includes('/no-desc')), `items: ${items}`);
  });

  test('the list narrows as you keep typing', async () => {
    const dir = agentDir('claudia');
    writeCommand(dir, 'echo-test', 'body\n');
    writeCommand(dir, 'other-thing', 'body\n');

    await createChat(page, 'Narrow Test');
    await createAgent(page, { name: 'Claudia', workingDir: dir, addToChat: true });

    await page.click(tid('msg-input'));
    await page.type(tid('msg-input'), '/echo');
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="mention-dropdown"]')?.hidden,
      { timeout: 3000 }
    );
    const items = await page.$$eval(tid('slash-command-item'), (els) => els.map((el) => el.textContent.trim()));
    assert.equal(items.length, 1, `expected only echo-test to match, got: ${items}`);
    assert.ok(items[0].includes('/echo-test'));
  });

  test('clicking a suggestion inserts "/name " into the input', async () => {
    const dir = agentDir('claudia');
    writeCommand(dir, 'echo-test', 'body\n');

    await createChat(page, 'Insert Test');
    await createAgent(page, { name: 'Claudia', workingDir: dir, addToChat: true });

    await page.click(tid('msg-input'));
    await page.type(tid('msg-input'), '/echo');
    await page.waitForFunction(
      () => document.querySelector('[data-testid="slash-command-item"]') !== null,
      { timeout: 3000 }
    );
    await page.click(tid('slash-command-item'));

    const value = await page.$eval(tid('msg-input'), (el) => el.value);
    assert.equal(value, '/echo-test ');
  });

  test('an agent explicitly addressed via "@Name /" gets its own commands offered, prefix preserved on insert', async () => {
    const dirA = agentDir('claudia');
    const dirB = agentDir('clarence');
    writeCommand(dirA, 'claudia-only', 'body\n');
    writeCommand(dirB, 'clarence-only', 'body\n');

    await createChat(page, 'Multi Agent Test');
    await createAgent(page, { name: 'Claudia', workingDir: dirA, addToChat: true });
    await createAgent(page, { name: 'Clarence', workingDir: dirB, addToChat: true });

    // A bare "/" is ambiguous with two agents in the chat — must not offer anything.
    await page.click(tid('msg-input'));
    await page.type(tid('msg-input'), '/');
    await new Promise((resolve) => setTimeout(resolve, 300)); // let any async fetch settle
    let dropdownHidden = await page.$eval(tid('mention-dropdown'), (el) => el.hidden);
    assert.ok(dropdownHidden, 'a bare "/" with 2 agents in the chat must not show a dropdown');

    // Addressing Clarence specifically should offer only Clarence's commands.
    await page.evaluate(() => { document.querySelector('[data-testid="msg-input"]').value = ''; });
    await page.type(tid('msg-input'), '@Clarence /');
    await page.waitForFunction(
      () => document.querySelector('[data-testid="slash-command-item"]') !== null,
      { timeout: 3000 }
    );
    const items = await page.$$eval(tid('slash-command-item'), (els) => els.map((el) => el.textContent.trim()));
    assert.ok(items.some((t) => t.includes('/clarence-only')), `items: ${items}`);
    assert.ok(!items.some((t) => t.includes('/claudia-only')), `items should not include Claudia's command: ${items}`);

    await page.click(tid('slash-command-item'));
    const value = await page.$eval(tid('msg-input'), (el) => el.value);
    assert.equal(value, '@Clarence /clarence-only ');
  });

  test('no custom commands means no dropdown at all', async () => {
    await createChat(page, 'No Commands Test');
    await createAgent(page, { name: 'Claudia', workingDir: agentDir('claudia'), addToChat: true });

    await page.click(tid('msg-input'));
    await page.type(tid('msg-input'), '/anything');
    // Give the async commands fetch a moment, then confirm nothing shows.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const hidden = await page.$eval(tid('mention-dropdown'), (el) => el.hidden);
    assert.ok(hidden, 'no custom commands exist, so no dropdown should appear');
  });

  test('selecting a suggestion and sending it actually fires the real skill', async () => {
    const dir = agentDir('claudia');
    writeCommand(dir, 'echo-test', 'Reply with exactly: SLASH_COMMAND_FIRED\n');

    await createChat(page, 'Fire Test');
    await createAgent(page, { name: 'Claudia', workingDir: dir, addToChat: true });

    await page.click(tid('msg-input'));
    await page.type(tid('msg-input'), '/echo');
    await page.waitForFunction(
      () => document.querySelector('[data-testid="slash-command-item"]') !== null,
      { timeout: 3000 }
    );
    await page.click(tid('slash-command-item'));
    await page.keyboard.press('Enter');

    const responseText = await waitForAgentResponse(page, { timeout: 30_000 });
    assert.equal(responseText, 'SLASH_COMMAND_FIRED');
  });
});
