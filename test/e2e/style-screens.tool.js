'use strict';
// Screenshots of every view in both themes, for reviewing a deliberate visual
// change. A tool, not a test: it asserts nothing, it produces images for a
// person to look at.
//
//   RUN_TOOLS=1 SHOT_DIR=/tmp/shots-before npx playwright test test/e2e/style-screens.tool.js
//   ...change the styling...
//   RUN_TOOLS=1 SHOT_DIR=/tmp/shots-after  npx playwright test test/e2e/style-screens.tool.js
//
// It drives a few hover states as well as the default ones, because most of
// what a styling change touches is not visible until something is hovered, and
// a review that only sees resting states is not a review.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const NAV = ['conversations', 'team', 'files', 'skills', 'settings'];
const DIR = process.env.SHOT_DIR || '/tmp/shots';

test('capture', async ({ page }) => {
  // Belt and braces. The *.tool.js name already keeps this out of the default
  // Playwright testMatch, but a naming convention is invisible to anyone
  // reading only this file, and a tool that asserts nothing must not be able
  // to report itself as a passing verification of anything.
  test.skip(!process.env.RUN_TOOLS, 'instrument, not a test: run with RUN_TOOLS=1');
  test.setTimeout(240000);
  fs.mkdirSync(DIR, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await expect(page.locator('.convo-item').first()).toBeVisible();

  const shot = async (name) => {
    await page.waitForTimeout(450);          // let the 0.2s colour transition settle
    await page.screenshot({ path: path.join(DIR, `${name}.png`) });
  };

  for (const light of [false, true]) {
    const theme = light ? 'light' : 'dark';
    await page.evaluate((w) => { if (document.body.classList.contains('light') !== w) toggleTheme(); }, light);
    await page.waitForTimeout(500);

    for (const nav of NAV) {
      await page.evaluate((n) => switchNav(n), nav);
      await expect(page.locator(`.nav-item.active[data-nav="${nav}"]`)).toBeVisible();
      await shot(`${theme}-${nav}`);
    }

    // Hover states. The delete control on a conversation row is one of the
    // surfaces whose red changed, and it does not exist until the row is
    // hovered.
    await page.evaluate(() => switchNav('conversations'));
    await page.locator('.convo-item').first().hover();
    await shot(`${theme}-convo-hover`);

    // The sidebar add menu carries the other destructive surface.
    const add = page.locator('.files-add-btn').first();
    if (await add.count()) {
      await page.evaluate(() => switchNav('files'));
      await add.click({ force: true }).catch(() => {});
      await shot(`${theme}-files-menu`);
      await page.keyboard.press('Escape').catch(() => {});
    }
  }
  console.log(`SHOTS ${DIR}: ${fs.readdirSync(DIR).length} images`);
});
