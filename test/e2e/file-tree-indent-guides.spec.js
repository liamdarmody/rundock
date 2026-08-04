'use strict';
// Indent guides: each expanded folder draws a subtle vertical line down its
// children so the eye can follow deep nesting. Implemented as a ::before on the
// `.file-children` container (one guide per level, cascading), which changes
// nothing about the indent metrics.
const { test, expect } = require('@playwright/test');

test('the file tree draws an indent guide down each expanded folder', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.convo-item').first()).toBeVisible();
  await page.locator('.nav-item[data-nav="files"]').click();

  // Expand a folder (the fixture has a `notes/` folder) so its children
  // container is visible, then inspect the guide.
  await page.locator('.folder-item', { hasText: 'notes' }).first().click();
  const children = page.locator('.file-children:not(.collapsed)').first();
  await expect(children).toBeVisible();

  const guide = await children.evaluate((el) => {
    const cs = getComputedStyle(el);
    const before = getComputedStyle(el, '::before');
    return {
      position: cs.position,
      content: before.content,
      width: before.width,
      bg: before.backgroundColor,
    };
  });

  expect(guide.position).toBe('relative');     // anchors the absolute guide
  expect(guide.content).not.toBe('none');      // the ::before guide exists
  expect(guide.width).toBe('1px');             // a thin line
  expect(guide.bg).not.toBe('rgba(0, 0, 0, 0)'); // and it has a colour
});
