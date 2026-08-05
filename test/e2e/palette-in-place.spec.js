'use strict';
// The search palette opens where the search field is, so the field appears to
// expand in place rather than summon a separate surface somewhere else.
//
// Browser-driven because the whole thing is real layout: the panel and the
// field are positioned by two different mechanisms (a grid column and a
// centred fixed overlay) and the claim is that they land in exactly the same
// place. That can only be checked by measuring both.
//
// The focus test is the important one. The field is hidden while the panel
// stands in its place, and a visibility:hidden element CANNOT take focus. So
// the field has to be revealed before focus is restored, not after. Both
// orders were tried during the spike: the wrong one silently drops focus to
// <body> and breaks keyboard flow after Escape, without throwing anything.
const { test, expect } = require('@playwright/test');

async function boot(page) {
  await page.goto('/');
  await expect(page.locator('.convo-item').first()).toBeVisible();
}

// The panel opens with a scaleY animation, so its measured height is a
// fraction of the real one until that finishes. Measuring during it produced a
// 32px input row for a 36px control, which looks exactly like a CSS bug and is
// not one. Wait for the geometry to settle before believing it.
async function openPaletteSettled(page) {
  await page.locator('#tb-search').click();
  await expect(page.locator('#palette-input')).toBeFocused();
  await page.waitForFunction(() => {
    const el = document.querySelector('.palette');
    return el && el.getAnimations().every((a) => a.playState === 'finished');
  });
}

test('the palette opens exactly where the search field is', async ({ page }) => {
  await boot(page);

  const fieldBox = await page.locator('#tb-search').boundingBox();
  await openPaletteSettled(page);
  const palBox = await page.locator('.palette').boundingBox();

  // Same left edge, same top edge, same width: one control in two states.
  expect(Math.round(palBox.x)).toBe(Math.round(fieldBox.x));
  expect(Math.round(palBox.y)).toBe(Math.round(fieldBox.y));
  expect(Math.round(palBox.width)).toBe(Math.round(fieldBox.width));

  // The panel's input row is the field's height, so the text does not jump as
  // one replaces the other.
  const rowBox = await page.locator('.palette-input-row').boundingBox();
  expect(Math.round(rowBox.height)).toBe(Math.round(fieldBox.height));

  // The field is hidden rather than removed, so the bar's layout is unchanged.
  await expect(page.locator('#tb-search')).toBeHidden();
});

test('Escape reveals the field before restoring focus to it', async ({ page }) => {
  // The regression this pins: closing in the wrong order leaves the field
  // still hidden at the moment focus is restored, so the browser silently
  // drops focus to <body> instead. Nothing throws; keyboard flow just breaks.
  await boot(page);

  await openPaletteSettled(page);

  await page.keyboard.press('Escape');
  await expect(page.locator('#palette-overlay')).toBeHidden();
  await expect(page.locator('#tb-search')).toBeVisible();
  await expect(page.locator('#tb-search')).toBeFocused();
});

test('the panel keeps clear of the window controls, as the field does', async ({ page }) => {
  await boot(page);

  // Simulate a platform with window controls in the right gutter. The panel
  // and the field share one gutter variable, so constraining one constrains
  // both; this asserts they really do move together.
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--chrome-inset-right', '138px');
  });
  await openPaletteSettled(page);

  const palBox = await page.locator('.palette').boundingBox();
  const viewport = page.viewportSize();
  const captionStart = viewport.width - 138;

  expect(palBox.x + palBox.width).toBeLessThan(captionStart);
  // And still centred on the window, not on the space left over.
  const centreOffset = Math.abs((palBox.x + palBox.width / 2) - viewport.width / 2);
  expect(centreOffset).toBeLessThanOrEqual(1);
});
