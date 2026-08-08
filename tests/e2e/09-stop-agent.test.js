/**
 * @fileoverview E2E tests: interrupting an agent mid-response, mirroring
 * Ctrl+C on a running `claude` CLI session. Real subprocess only — no
 * mocking — so the process-kill side effect is verified on disk, not just
 * trusted from the UI.
 */

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, stopServer, resetData } from '../helpers/server.js';
import {
  launchBrowser, closeBrowser, openPage, closePage,
  tid, createChat, createAgent, sendMessage, waitForAgentResponse,
} from '../helpers/browser.js';
import { agentDir, cleanupAgentDirs } from '../helpers/fixtures.js';

describe('Stopping an in-progress agent', () => {
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

  test('clicking Stop interrupts the agent and actually kills its subprocess', async () => {
    const dir = agentDir('claudia');
    const marker = join(dir, 'done.marker');

    await createChat(page, 'Stop Test');
    await createAgent(page, { name: 'Claudia', workingDir: dir, addToChat: true });

    await sendMessage(
      page,
      '@Claudia use the Bash tool to run exactly: sleep 8 && touch done.marker. Do not reply until it finishes.'
    );

    // Wait for the Stop button to actually render (stream has started).
    await page.waitForFunction(
      () => document.querySelector('[data-testid="stream-stop-btn"]') !== null,
      { timeout: 15_000 }
    );
    await page.click(tid('stream-stop-btn'));

    // The stream must resolve promptly — well before the 8s sleep would've
    // finished on its own — proving the interrupt actually cut it short.
    await waitForAgentResponse(page, { timeout: 10_000 });

    const badge = await page.$(tid('msg-stopped-badge'));
    assert.ok(badge, 'the resulting message should show a "stopped" indicator');

    // Real, independently-observable side effect: wait past when the full
    // 8s sleep + touch would've completed if the process were still alive,
    // and confirm the marker file was never created.
    await new Promise((resolve) => setTimeout(resolve, 9000));
    assert.equal(
      existsSync(marker), false,
      'the Bash command should have been killed before it could create the marker file'
    );
  });
});
