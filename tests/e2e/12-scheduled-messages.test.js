/**
 * @fileoverview E2E tests: scheduling a message to send later, canceling a
 * pending one, and multiple messages scheduled at once. Targeting
 * (@mention a specific agent, or everyone) is resolved fresh once a
 * scheduled message actually fires — same code path as a live message —
 * so these tests also double as proof that no separate/stale targeting
 * decision gets baked in at schedule time.
 */

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, resetData, TEST_PORT } from '../helpers/server.js';
import {
  launchBrowser, closeBrowser, openPage, closePage,
  tid, createChat, createAgent, waitForAgentResponse,
} from '../helpers/browser.js';
import { agentDir, cleanupAgentDirs } from '../helpers/fixtures.js';
import enCA from '../../server/public/i18n/en-CA.js';

describe('Scheduled messages', () => {
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

  /**
   * Types `content` into the composer (if given), opens the schedule
   * modal, sets the datetime-local input to `secondsFromNow` out (the
   * input has step="1" so second-precision is honored, not rounded to the
   * current minute), and submits.
   * @param {import('puppeteer').Page} p
   * @param {string} content
   * @param {number} secondsFromNow
   * @returns {Promise<void>}
   */
  async function scheduleMessageViaUi(p, content, secondsFromNow) {
    if (content) {
      await p.click(tid('msg-input'));
      await p.type(tid('msg-input'), content);
    }
    await p.click(tid('schedule-btn'));
    await p.waitForFunction(
      () => !document.querySelector('[data-testid="schedule-overlay"]')?.hidden,
      { timeout: 3000 }
    );
    await p.evaluate((secs) => {
      const d = new Date(Date.now() + secs * 1000);
      const pad = (n) => String(n).padStart(2, '0');
      const value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      const input = document.querySelector('[data-testid="schedule-time-input"]');
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, secondsFromNow);
    await p.click(tid('schedule-submit'));
    await p.waitForFunction(
      () => document.querySelector('[data-testid="schedule-overlay"]')?.hidden,
      { timeout: 3000 }
    );
  }

  /**
   * Waits for the topbar badge to show an exact pending count, or to be
   * hidden entirely when count is 0 (renderScheduledPanel hides it rather
   * than showing "🕐 0" — see app.js).
   * @param {import('puppeteer').Page} p
   * @param {number} count
   * @returns {Promise<void>}
   */
  async function waitForScheduledCount(p, count) {
    await p.waitForFunction(
      (n) => {
        const btn = document.querySelector('[data-testid="scheduled-btn"]');
        if (n === 0) return !!btn && btn.hidden;
        return !!btn && !btn.hidden && btn.textContent.includes(String(n));
      },
      { timeout: 5000 },
      count
    );
  }

  /**
   * Waits for a chat message with exactly this content to appear.
   * @param {import('puppeteer').Page} p
   * @param {string} content
   * @param {number} timeout
   * @returns {Promise<void>}
   */
  async function waitForChatMessage(p, content, timeout) {
    await p.waitForFunction(
      (text) => [...document.querySelectorAll('[data-testid="msg-content"]')].some((el) => el.textContent === text),
      { timeout },
      content
    );
  }

  test('a scheduled message with no @mention fires and the agent responds', async () => {
    await createChat(page, 'Schedule Fire Test');
    await createAgent(page, { name: 'Claudia', workingDir: agentDir('claudia'), addToChat: true });

    await scheduleMessageViaUi(page, 'reply with exactly: done', 3);
    await waitForScheduledCount(page, 1);

    await page.click(tid('scheduled-btn'));
    const preview = await page.$eval(tid('scheduled-item-preview'), (el) => el.textContent);
    assert.equal(preview, 'reply with exactly: done');

    const responseText = await waitForAgentResponse(page, { timeout: 30_000 });
    assert.equal(responseText, 'done');
    await waitForScheduledCount(page, 0);
  });

  test('a scheduled message with @mention targets only that agent, resolved fresh at fire time', async () => {
    await createChat(page, 'Schedule Mention Test');
    await createAgent(page, { name: 'Claudia', workingDir: agentDir('claudia'), addToChat: true });
    await createAgent(page, { name: 'Clauditor', workingDir: agentDir('clauditor'), addToChat: true });

    await scheduleMessageViaUi(page, '@Claudia say: acknowledged', 3);
    await waitForAgentResponse(page, { timeout: 30_000 });

    const authors = await page.$$eval(
      tid('message') + '[data-role="agent"] ' + tid('msg-author'),
      (els) => els.map((el) => el.textContent.trim())
    );
    assert.deepEqual(authors, ['Claudia'], `only the @mentioned agent should have responded, got: ${authors}`);
  });

  test('multiple pending schedules: canceling one leaves the other to fire normally', async () => {
    await createChat(page, 'Multi Schedule Test');
    // No agent needed — the user message itself still persists and "fires"
    // through the normal send path even with zero responders, so this
    // exercises fire/cancel timing without a real (slow) Claude turn.

    await scheduleMessageViaUi(page, 'will be canceled', 3);
    await scheduleMessageViaUi(page, 'will still fire', 6);
    await waitForScheduledCount(page, 2);

    await page.click(tid('scheduled-btn'));
    const items = await page.$$(tid('scheduled-item'));
    let canceledIdx = -1;
    for (let i = 0; i < items.length; i++) {
      const text = await items[i].$eval(tid('scheduled-item-preview'), (el) => el.textContent);
      if (text === 'will be canceled') canceledIdx = i;
    }
    assert.notEqual(canceledIdx, -1, 'expected to find the "will be canceled" row');
    await items[canceledIdx].$eval(tid('scheduled-cancel-btn'), (btn) => btn.click());
    await waitForScheduledCount(page, 1);

    // Wait past the canceled message's original fire time (3s) plus buffer —
    // it must never appear in the chat.
    await new Promise((r) => setTimeout(r, 4000));
    const contents = await page.$$eval(tid('msg-content'), (els) => els.map((el) => el.textContent));
    assert.ok(!contents.includes('will be canceled'), 'a canceled scheduled message must never be sent');

    // The other one (originally +6s, ~3s remaining now) should still fire.
    await waitForChatMessage(page, 'will still fire', 10_000);
    await waitForScheduledCount(page, 0);
  });

  test('validation: empty composer and a past time are both rejected', async () => {
    await createChat(page, 'Schedule Validation Test');

    // Empty composer, but a valid future time — isolates the content check
    // from the time-input's own `required` attribute, which would otherwise
    // block native form submission before our JS handler ever runs.
    await page.click(tid('schedule-btn'));
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="schedule-overlay"]')?.hidden,
      { timeout: 3000 }
    );
    await page.evaluate(() => {
      const d = new Date(Date.now() + 120_000);
      const pad = (n) => String(n).padStart(2, '0');
      const value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      const input = document.querySelector('[data-testid="schedule-time-input"]');
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.click(tid('schedule-submit'));
    const contentErrorVisible = await page.$eval(tid('schedule-error'), (el) => !el.hidden);
    assert.ok(contentErrorVisible, 'expected a content-required error');
    await page.click(tid('schedule-close'));

    // Content present, but a past time. The input's own `min` (set to "now"
    // when the modal opened) would otherwise block native form submission
    // before our JS ever runs — removed here to isolate testing our own
    // JS-level check, which is the authoritative one (min is best-effort:
    // a snapshot taken at open time, not live, so it can't catch every
    // case — e.g. the modal sitting open past its own snapshot time).
    await page.type(tid('msg-input'), 'too late');
    await page.click(tid('schedule-btn'));
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="schedule-overlay"]')?.hidden,
      { timeout: 3000 }
    );
    await page.$eval(tid('schedule-time-input'), (el) => {
      el.removeAttribute('min');
      el.value = '2020-01-01T00:00:00';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.click(tid('schedule-submit'));
    const pastTimeErrorVisible = await page.$eval(tid('schedule-error'), (el) => !el.hidden);
    assert.ok(pastTimeErrorVisible, 'expected a past-time error');

    // Neither attempt should have actually created anything server-side.
    const chatsRes = await fetch(`http://localhost:${TEST_PORT}/api/chats`);
    const [chat] = await chatsRes.json();
    const listRes = await fetch(`http://localhost:${TEST_PORT}/api/chats/${chat.id}/scheduled-messages`);
    assert.equal((await listRes.json()).length, 0);

    // Direct server-side check (bypassing the client-side guard entirely).
    const res = await fetch(`http://localhost:${TEST_PORT}/api/chats/${chat.id}/scheduled-messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'nope', sendAt: '2020-01-01T00:00:00.000Z' }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, enCA['errors.scheduledSendAtPast']);
  });

  test('i18n: modal, panel, and the empty-state text (reachable by canceling the last pending item) match the real dictionary', async () => {
    await createChat(page, 'Schedule i18n Test');

    await page.click(tid('schedule-btn'));
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="schedule-overlay"]')?.hidden,
      { timeout: 3000 }
    );
    const modalTitle = await page.$eval('#schedule-header span', (el) => el.textContent);
    assert.equal(modalTitle, enCA['schedule.modalTitle']);
    const timeLabel = await page.$eval('#schedule-form .field-label span', (el) => el.textContent);
    assert.equal(timeLabel, enCA['schedule.timeLabel']);
    const submitLabel = await page.$eval(tid('schedule-submit'), (el) => el.textContent);
    assert.equal(submitLabel, enCA['schedule.submitBtn']);
    await page.click(tid('schedule-close'));

    await scheduleMessageViaUi(page, 'later', 120);
    await waitForScheduledCount(page, 1);

    await page.click(tid('scheduled-btn'));
    const cancelTitle = await page.$eval(tid('scheduled-cancel-btn'), (el) => el.title);
    assert.equal(cancelTitle, enCA['schedule.cancelTitle']);

    // Canceling the LAST pending item while the panel is open re-renders it
    // in place to the empty state rather than closing it (see
    // renderScheduledPanel) — the one path where panelEmpty is reachable.
    // cancelScheduled awaits a DELETE before re-rendering, so the panel's
    // own `hidden` (already false from opening it above) isn't a real
    // signal here — wait for the empty-state element to actually appear.
    await page.click(tid('scheduled-cancel-btn'));
    await page.waitForFunction(
      () => document.querySelector('.scheduled-item-empty') !== null,
      { timeout: 3000 }
    );
    const emptyText = await page.$eval('.scheduled-item-empty', (el) => el.textContent);
    assert.equal(emptyText, enCA['schedule.panelEmpty']);
    await waitForScheduledCount(page, 0);
  });
});
