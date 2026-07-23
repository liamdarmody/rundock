'use strict';
// The "Instructions ▾" panel on an agent (and skill) profile should expand to
// reveal the WHOLE set of instructions when opened, not scroll within a fixed
// 400px porthole. Expanding a disclosure signals intent to read it; a nested
// scroll region (two scrollbars, one inside the already-scrolling profile
// pane) fights that intent. This pins that the panel has no inner-scroll cap.
const { test, expect } = require('@playwright/test');

test('the agent instructions panel expands fully, with no inner scroll cap', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.convo-item').first()).toBeVisible();

  // Open a specialist's profile (Penn has instructions) and expand the panel.
  await page.evaluate(() => showProfile('penn'));
  await page.evaluate(() => document.getElementById('agent-instructions').classList.remove('hidden'));

  const inner = page.locator('#agent-instructions > div');
  await expect(inner).toBeVisible();

  const style = await inner.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { maxHeight: cs.maxHeight, overflowY: cs.overflowY };
  });
  expect(style.maxHeight).toBe('none');       // no fixed cap
  expect(['visible', 'clip']).toContain(style.overflowY); // no inner scrollbar
});

// Regression lock for the 2026-04-30 "instructions cut off at a square bracket"
// report. The render is now esc() (textContent -> innerHTML), which handles
// brackets, HTML, wikilinks, and code fences without truncating, so this pins
// that behaviour rather than fixing anything.
test('agent instructions render in full past brackets, HTML, wikilinks, and code fences', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.convo-item').first()).toBeVisible();
  await page.evaluate(() => showProfile('penn'));
  await page.evaluate(() => document.getElementById('agent-instructions').classList.remove('hidden'));

  const text = await page.locator('#agent-instructions > div').textContent();
  expect(text).toContain('SENTINEL_AFTER_BRACKET');   // content right after a '['
  expect(text).toContain('FINAL_SENTINEL_END');       // content after <tag>, wikilink, and a fence
  expect(text).toContain('[Key]');                    // literal bracket preserved
  expect(text).toContain('<tag>');                    // escaped, not swallowed as HTML
  expect(text).toContain('[[Roadmap-2026]]');         // wikilink text preserved verbatim
});
