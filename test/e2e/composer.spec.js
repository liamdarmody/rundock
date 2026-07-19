'use strict';
// E2E for the message composer: you can draft your next message while an agent
// is still responding. The input stays enabled during processing, the button
// stays Stop, and Enter does not send until you stop the agent (at which point
// the button becomes Send, active when the field has text).
const base = require('@playwright/test');
const { appendRawCoverage, writeLcov, isClientEntry } = require('./coverage.js');

const test = base.test.extend({
  page: async ({ page }, use) => {
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
    await use(page);
    const entries = await page.coverage.stopJSCoverage();
    appendRawCoverage(entries.filter(e => isClientEntry(e.url)));
  },
});
const { expect } = base;

test.afterAll(async () => { await writeLcov(); });

async function boot(page) {
  await page.goto('/');
  await expect(page.locator('.convo-item').first()).toBeVisible();
}

// Open a conversation and drive it into the processing state through the real
// startProcessing path, without needing a live agent turn.
async function openProcessing(page) {
  await page.evaluate(() => openConversation('c1'));
  await expect(page.locator('#view-chat')).toBeVisible();
  await page.evaluate(() => startProcessing('c1'));
}

test('the input stays enabled while an agent is responding, so you can draft', async ({ page }) => {
  await boot(page);
  await openProcessing(page);
  const input = page.locator('#msg-input');
  const sendBtn = page.locator('#send-btn');
  // Input is editable; the button is the Stop control.
  await expect(input).toBeEnabled();
  await expect(sendBtn).toHaveClass(/\bcancel\b/);
  // Draft a next message while the agent works.
  await input.fill('my next question');
  await expect(input).toHaveValue('my next question');
  // Enter does not send while the agent runs (the draft is kept, no new user
  // message is appended); it inserts a newline instead.
  await input.focus();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await expect(input).toHaveValue(/my next question\n/);
  // The button is still Stop (drafting does not flip it to Send).
  await expect(sendBtn).toHaveClass(/\bcancel\b/);
});

test('stopping the agent flips the button to Send with the draft preserved and active', async ({ page }) => {
  await boot(page);
  await openProcessing(page);
  const input = page.locator('#msg-input');
  const sendBtn = page.locator('#send-btn');
  await input.fill('drafted while thinking');
  // Simulate the agent turn ending (stop or natural finish reaches this path).
  await page.evaluate(() => finishProcessing('c1'));
  // The draft survives, the button is Send and active because the field has text.
  await expect(input).toHaveValue('drafted while thinking');
  await expect(input).toBeEnabled();
  await expect(sendBtn).not.toHaveClass(/\bcancel\b/);
  await expect(sendBtn).toHaveClass(/\bactive\b/);
});

test('finishing with an empty field leaves the Send button inactive', async ({ page }) => {
  await boot(page);
  await openProcessing(page);
  await page.locator('#msg-input').fill('');
  await page.evaluate(() => finishProcessing('c1'));
  await expect(page.locator('#send-btn')).not.toHaveClass(/\bcancel\b/);
  await expect(page.locator('#send-btn')).not.toHaveClass(/\bactive\b/);
});
