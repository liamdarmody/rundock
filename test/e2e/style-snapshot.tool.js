'use strict';
// Migration instrument, not a test. Excluded from the e2e run by the
// testIgnore rule in playwright.config.js; run it by hand.
//
// Captures the fully-resolved computed style of every element the app renders,
// across every nav section and both themes, so a stylesheet reorganisation can
// be PROVED to change nothing rather than argued to. Byte-identical file moves
// cannot prove that on their own: regrouping rules changes their order, and
// order is what a cascade is made of.
//
//   SNAP_OUT=/tmp/a.json npx playwright test test/e2e/style-snapshot.tool.js
//   ...change the stylesheets...
//   SNAP_OUT=/tmp/b.json npx playwright test test/e2e/style-snapshot.tool.js
//   ...then diff a.json against b.json.
//
// Read the diff against a CONTROL, never against zero. Two runs of the SAME
// build differ by about one element, because a little of what the seeded
// workspace renders varies. A treatment diff that matches the control's own
// noise is a clean result. Ignore keys under HEAD when comparing across a
// change that adds or removes <link> or <style> tags: those elements are in
// the document too, and their count changing is the point, not a regression.
//
// It earned its place immediately: it caught four stylesheets whose ranges had
// been cut through the middle of a multi-line comment, leaving one file with
// an unclosed comment that swallowed its tail and the next with an orphan */
// that ate the rule after it. Nothing else in the repo would have noticed.
const { test, expect } = require('@playwright/test');
const fs = require('fs');

const NAV = ['conversations', 'team', 'files', 'skills', 'settings'];
const OUT = process.env.SNAP_OUT || '/tmp/style-snapshot.json';

test('capture', async ({ page }) => {
  test.setTimeout(180000);
  await page.goto('/');
  await expect(page.locator('.convo-item').first()).toBeVisible();

  const snap = {};
  for (const light of [false, true]) {
    await page.evaluate((w) => { if (document.body.classList.contains('light') !== w) toggleTheme(); }, light);
    // Wait out the 0.2s colour transition; a mid-transition read is not a style.
    await page.waitForTimeout(600);
    for (const nav of NAV) {
      await page.evaluate((n) => switchNav(n), nav);
      await expect(page.locator(`.nav-item.active[data-nav="${nav}"]`)).toBeVisible();
      await page.waitForTimeout(600);
      const got = await page.evaluate(() => {
        // Stable identity: structural path, never text content, so a changing
        // conversation list does not look like a style change.
        const pathOf = (el) => {
          const parts = [];
          for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
            const i = n.parentElement ? [...n.parentElement.children].indexOf(n) : 0;
            parts.unshift(`${n.tagName}:${i}`);
          }
          return parts.join('/');
        };
        const out = {};
        for (const el of document.querySelectorAll('*')) {
          const cs = getComputedStyle(el);
          const buf = [];
          for (let i = 0; i < cs.length; i++) buf.push(cs[i] + '=' + cs.getPropertyValue(cs[i]));
          // Sorted: custom-property enumeration order is not stable between
          // runs, so an unsorted join reports every element as changed.
          out[pathOf(el)] = buf.sort().join(';');
        }
        return out;
      });
      snap[`${light ? 'light' : 'dark'}/${nav}`] = got;
    }
  }
  fs.writeFileSync(OUT, JSON.stringify(snap));
  const n = Object.values(snap).reduce((a, o) => a + Object.keys(o).length, 0);
  console.log(`SNAPSHOT ${OUT}: ${Object.keys(snap).length} scenes, ${n} elements`);
});
