'use strict';
// The map, end to end against the real server and the fixture workspace:
// the rail lights Map, the canvas fills the pane, a keyword finds a file,
// and clicking its node lands in the editor on that file with the rail on
// Files. The node is clicked at the position the view reports through its
// test seam, so the test asks the map where the file is rather than guessing
// at pixels.
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

test('Map from the rail: canvas at the pane, a keyword finds Roadmap-2026, its node opens the file', async ({ page }) => {
  await boot(page);
  await page.locator('.nav-item[data-nav="map"]').click();
  await expect(page.locator('.nav-item.active[data-nav="map"]')).toBeVisible();
  await expect(page.locator('#view-map')).toBeVisible();
  await expect(page.locator('.sidebar')).toBeHidden();

  // The index may still be warming when the map is first opened; the map
  // says so and rebuilds itself when the server reports ready, so the canvas
  // is waited for rather than assumed.
  const canvas = page.locator('#view-map canvas');
  await expect(canvas).toBeVisible({ timeout: 20_000 });
  const stage = await page.locator('#graph-stage').boundingBox();
  const box = await canvas.boundingBox();
  expect(Math.abs(box.width - stage.width)).toBeLessThan(2);
  expect(Math.abs(box.height - stage.height)).toBeLessThan(2);
  await expect(page.locator('#graph-readout')).toContainText('files');

  await page.fill('#graph-filter-input', 'Roadmap-2026');
  await expect(page.locator('#graph-readout')).toContainText('matching “roadmap-2026”');
  await expect(page.locator('#graph-readout b')).toHaveText('1');

  const at = await page.evaluate(() => mapNodeScreenPosition('Roadmap-2026.md'));
  expect(at, 'the view reports where the node is').toBeTruthy();
  expect(at.visible, 'a match is on screen whatever the zoom').toBe(true);
  await page.mouse.move(at.x, at.y);
  await expect(page.locator('#graph-readout b')).toHaveText('Roadmap-2026.md');
  await page.mouse.click(at.x, at.y);

  await expect(page.locator('.nav-item.active[data-nav="files"]')).toBeVisible();
  await expect(page.locator('#view-editor')).toBeVisible();
  await expect(page.locator('#editor-filename')).toHaveText('Roadmap-2026.md');
  await expect(page.locator('#view-map canvas')).toHaveCount(0);
});

test('the content corner beside the rail is rounded on the map as it is everywhere else', async ({ page }) => {
  // WHAT WAS REPORTED. Every view gets its rounded top-left from the sidebar,
  // which is --surface against the --chrome behind it, so the curve shows
  // because the two colours differ. The map has no sidebar, so .main is the
  // element at the frame's edge and it was square.
  //
  // .graph-stage already asked for the radius and could not show it: same
  // --elevated, same x and y as .main, so it rounded against an identical
  // colour and what a reader saw was the square corner underneath. A rule that
  // is present and inert is worse than a missing one, because reading the
  // stylesheet says the corner is handled.
  //
  // Asserted against the Files view rather than against 12px, so the claim is
  // "the same as everywhere else" rather than a number that can drift apart
  // from the token in one place.
  await boot(page);

  await page.locator('.nav-item[data-nav="files"]').click();
  const withSidebar = await page.locator('.sidebar').evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { radius: getComputedStyle(el).borderTopLeftRadius, x: Math.round(r.x), y: Math.round(r.y) };
  });
  expect(withSidebar.radius).not.toBe('0px');

  await page.locator('.nav-item[data-nav="map"]').click();
  await expect(page.locator('#view-map')).toBeVisible();
  await expect(page.locator('.sidebar')).toBeHidden();
  const onMap = await page.locator('.main').evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { radius: getComputedStyle(el).borderTopLeftRadius, x: Math.round(r.x), y: Math.round(r.y) };
  });

  expect(onMap.radius, 'the map corner should match the sidebar corner').toBe(withSidebar.radius);
  expect(onMap.x, 'and sit at the same place beside the rail').toBe(withSidebar.x);
  expect(onMap.y).toBe(withSidebar.y);
});
