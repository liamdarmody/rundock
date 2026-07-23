'use strict';
// A wide markdown table in an agent chat message must stay within the message
// bubble and scroll horizontally INSIDE it, rather than pushing the bubble wide
// and forcing the whole conversation to scroll sideways. Browser-driven because
// it depends on real layout: the bubble's max-width, the scroll wrapper's
// overflow, and whether the table overflows the wrap (not the page).
const { test, expect } = require('@playwright/test');

test('a wide markdown table in a chat message is wrapped and scrolls inside the bubble', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.convo-item').first()).toBeVisible();
  await page.locator('.convo-item').first().click();
  await expect(page.locator('.messages')).toBeVisible();

  // Six columns plus a long unbreakable token (a URL) guarantee the table is
  // wider than the bubble regardless of viewport, so the "scroll if required"
  // path is exercised deterministically.
  const wideTable = [
    '| Candidate | Hook | Body copy | Status | Source | Notes |',
    '|---|---|---|---|---|---|',
    '| One | A very long hook line that keeps going on and on | The full body copy available at https://example.com/very/long/unbreakable/path/segment/for/testing/overflow | Confirmed | AuthoredUp direct pull | Additional notes that add still more width |',
    '| Two | Another long hook that also runs very wide | More long-form body copy that stretches the table well beyond a bubble | Confirmed | AuthoredUp direct pull | Further notes making the row wider still |',
  ].join('\n');

  // Render the table through the real markdown path into a real bubble in the
  // messages container, then measure the resulting layout.
  const r = await page.evaluate((md) => {
    const messages = document.querySelector('.messages');
    const msg = document.createElement('div');
    msg.className = 'msg msg-agent';
    msg.innerHTML = '<div class="msg-bubble" id="__tbl_test">' + formatMd(md) + '</div>';
    messages.appendChild(msg);
    const bubble = document.getElementById('__tbl_test');
    const wrap = bubble.querySelector('.md-table-wrap');
    const out = {
      hasWrap: !!wrap,
      overflowX: wrap ? getComputedStyle(wrap).overflowX : null,
      // The table is wider than the wrap, so it scrolls INSIDE the wrap.
      wrapScrolls: wrap ? wrap.scrollWidth > wrap.clientWidth + 1 : null,
      // The bubble did not get pushed past its container by the wide table.
      bubbleWithinContainer:
        bubble.getBoundingClientRect().right <= messages.getBoundingClientRect().right + 1,
      // And the page itself never gained a horizontal scrollbar.
      noPageHScroll: document.documentElement.scrollWidth <= window.innerWidth + 1,
    };
    msg.remove();
    return out;
  }, wideTable);

  expect(r.hasWrap).toBe(true);
  expect(r.overflowX).toBe('auto');
  expect(r.wrapScrolls).toBe(true);
  expect(r.bubbleWithinContainer).toBe(true);
  expect(r.noPageHScroll).toBe(true);
});
