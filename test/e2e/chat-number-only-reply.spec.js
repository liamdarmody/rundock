'use strict';
// A reply that is only a number must read as that number, inside its bubble.
//
// `4471.` is valid ordered-list syntax, so markdown parsed it into a list whose
// only item was empty. The number then existed ONLY as the list marker, and a
// marker is drawn inside the bubble's list padding, which was too narrow for
// it. The result was a stray `4471.` floating to the left of an otherwise empty
// bubble.
//
// Browser-driven because the bug was never in the markdown, it was in where
// real layout put the marker. The decisive assertion is textContent: a list
// marker is NOT part of it, so if the number is present in the bubble's text
// the reply is genuine content rather than a marker drawn outside the box.
const { test, expect } = require('@playwright/test');

test('a reply that is only a number renders as text inside the bubble', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.convo-item').first()).toBeVisible();
  await page.locator('.convo-item').first().click();
  await expect(page.locator('.messages')).toBeVisible();

  const r = await page.evaluate(() => {
    const messages = document.querySelector('.messages');
    const render = (md, id) => {
      const msg = document.createElement('div');
      msg.className = 'msg msg-agent';
      msg.innerHTML = `<div class="msg-bubble" id="${id}">` + formatMd(md) + '</div>';
      messages.appendChild(msg);
      return document.getElementById(id);
    };

    const bare = render('4471.', '__num_bare');
    const real = render('1. real item\n2. second item', '__num_list');
    const bigStart = render('999. real item', '__num_big');

    const ol = bigStart.querySelector('ol');
    return {
      // The reported bug. Before the fix these were: an <ol>, and empty text.
      bareHasList: !!bare.querySelector('ol'),
      bareText: bare.textContent.trim(),
      bareWithinBubble:
        bare.getBoundingClientRect().left >= messages.getBoundingClientRect().left - 1,

      // A genuine list must be completely unaffected.
      realHasList: !!real.querySelector('ol'),
      realItemCount: real.querySelectorAll('li').length,
      realFirstItem: real.querySelector('li')?.textContent.trim(),

      // The padding guard: a genuine list numbered in the hundreds keeps its
      // marker inside the bubble. 20px was under the ~29.8px "999." needs.
      bigStartHasList: !!ol,
      bigStartPaddingLeft: ol ? parseFloat(getComputedStyle(ol).paddingLeft) : null,
    };
  });

  // The number is real text in the bubble, not a marker drawn beside it.
  expect(r.bareHasList).toBe(false);
  expect(r.bareText).toBe('4471.');
  expect(r.bareWithinBubble).toBe(true);

  // Genuine lists are untouched.
  expect(r.realHasList).toBe(true);
  expect(r.realItemCount).toBe(2);
  expect(r.realFirstItem).toBe('real item');

  // And a high-numbered genuine list still has room for its marker.
  expect(r.bigStartHasList).toBe(true);
  expect(r.bigStartPaddingLeft).toBeGreaterThanOrEqual(30);
});
