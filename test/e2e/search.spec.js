'use strict';
// E2E smoke suite (SR1 client test coverage, stage 1).
//
// Ten browser-driven tests protecting the flows the Node suite cannot
// observe. The first two exist because these exact bugs shipped through 338
// green server-side tests: they are named regression tests, and reverting
// their fixes must make them fail (verified when this suite landed).
//
const base = require('@playwright/test');
const { appendRawCoverage, writeLcov, isClientEntry } = require('./coverage.js');

// Auto-fixture: collect V8 coverage for every hand-written client module on
// every page this suite opens, so the client gets measured coverage numbers
// (see coverage.js).
const test = base.test.extend({
  page: async ({ page }, use) => {
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
    await use(page);
    const entries = await page.coverage.stopJSCoverage();
    appendRawCoverage(entries.filter(e => isClientEntry(e.url)));
  },
});
const { expect } = base;

test.afterAll(async () => {
  const summary = await writeLcov();
  if (summary) {
    console.log('');
    for (const f of summary.files) {
      console.log(`[client coverage] public/${f.file}: ${f.pct.toFixed(1)}% lines (${f.covered}/${f.total})`);
    }
    console.log(`[client coverage] combined: ${summary.pct.toFixed(1)}% lines (${summary.covered}/${summary.total}) -> ${summary.out}`);
  }
});

// ── helpers ──────────────────────────────────────────────────────────────────

async function boot(page) {
  await page.goto('/');
  // The app is ready once the conversations sidebar has rendered its rows.
  await expect(page.locator('.convo-item').first()).toBeVisible();
}

async function openPalette(page) {
  await page.locator('#nav-search-btn').click();
  await expect(page.locator('#palette-input')).toBeFocused();
}

async function search(page, query) {
  await openPalette(page);
  await page.locator('#palette-input').fill(query);
  // Opening the palette renders empty-query recents immediately; the typed
  // query's reply arrives after the debounce. Wait for THIS query's results
  // (group labels stop saying "Recent ...") before anyone selects anything,
  // otherwise the click lands on a recent item instead of a match.
  await expect(page.locator('.palette-group-label').first()).not.toContainText('Recent');
  await expect(page.locator('.palette-item').first()).toBeVisible();
}

async function expectSection(page, nav, view) {
  await expect(page.locator(`.nav-item.active[data-nav="${nav}"]`)).toBeVisible();
  await expect(page.locator(`#sidebar-${nav}`)).toBeVisible();
  await expect(page.locator(`#view-${view}`)).toBeVisible();
}

// ── the two escaped bugs, as permanent named regression tests ───────────────

test('anchor: a search-opened conversation scrolls to and flashes the matched message', async ({ page }) => {
  await boot(page);
  await search(page, 'discount structure');
  await page.locator('.palette-item[data-type="conversation"]', { hasText: 'Board prep planning' }).click();
  // The flash lands on the matched message even though it is the first of ~80
  // messages, far above the natural bottom scroll position.
  const flashed = page.locator('.msg.anchor-flash');
  await expect(flashed).toHaveCount(1);
  await expect(flashed).toContainText('discount structure');
  await expect(flashed).toBeInViewport();
});

test('anchor: the flash never replays when navigating away and back (SR1 escape #1)', async ({ page }) => {
  await boot(page);
  await search(page, 'discount structure');
  await page.locator('.palette-item[data-type="conversation"]').first().click();
  await expect(page.locator('.msg.anchor-flash')).toHaveCount(1);
  // The flash class is removed once the animation completes...
  await expect(page.locator('.msg.anchor-flash')).toHaveCount(0);
  // ...so cycling the chat view through display:none (the exact reported
  // repro: away to Files, back to Conversations) cannot restart it.
  await page.locator('.nav-item[data-nav="files"]').click();
  await page.locator('.nav-item[data-nav="conversations"]').click();
  await expect(page.locator('#view-chat')).toBeVisible();
  await page.waitForTimeout(600); // a replayed animation would be visible by now
  await expect(page.locator('.msg.anchor-flash')).toHaveCount(0);
});

test('nav state: every result type from every origin view lands consistently (SR1 escape #2)', async ({ page }) => {
  test.slow(); // 16 palette round-trips
  await boot(page);
  const origins = ['conversations', 'files', 'skills', 'team'];
  const destinations = [
    { query: 'discount structure', type: 'conversation', nav: 'conversations', view: 'chat' },
    { query: 'pricing', type: 'file', nav: 'files', view: 'editor' },
    { query: 'penn', type: 'agent', nav: 'team', view: 'profile' },
    { query: 'workspace management', type: 'skill', nav: 'skills', view: 'skills' },
  ];
  for (const origin of origins) {
    for (const dest of destinations) {
      await page.locator(`.nav-item[data-nav="${origin}"]`).click();
      await search(page, dest.query);
      await page.locator(`.palette-item[data-type="${dest.type}"]`).first().click();
      await expectSection(page, dest.nav, dest.view);
    }
  }
});

// ── search icon active state ────────────────────────────────────────────────

test('nav rail: the search icon activates while the palette is open and the origin view dims', async ({ page }) => {
  await boot(page);
  await page.locator('.nav-item[data-nav="files"]').click();
  await expect(page.locator('.nav-item.active[data-nav="files"]')).toBeVisible();
  // Opening search lights the search icon and clears the origin highlight, so
  // no view icon shows through the overlay.
  await openPalette(page);
  await expect(page.locator('#nav-search-btn')).toHaveClass(/\bactive\b/);
  await expect(page.locator('.nav-item[data-nav="files"]')).not.toHaveClass(/\bactive\b/);
  // Cancelling returns to the view we came from.
  await page.keyboard.press('Escape');
  await expect(page.locator('#palette-overlay')).toBeHidden();
  await expect(page.locator('#nav-search-btn')).not.toHaveClass(/\bactive\b/);
  await expect(page.locator('.nav-item.active[data-nav="files"]')).toBeVisible();
});

test('nav rail: navigating from search hands the active icon to the destination, not the origin', async ({ page }) => {
  await boot(page);
  await page.locator('.nav-item[data-nav="conversations"]').click();
  await search(page, 'pricing');
  await page.locator('.palette-item[data-type="file"]').first().click();
  // Destination (files) wins; search icon and origin are both cleared.
  await expect(page.locator('#nav-search-btn')).not.toHaveClass(/\bactive\b/);
  await expect(page.locator('.nav-item.active[data-nav="files"]')).toBeVisible();
  await expect(page.locator('.nav-item[data-nav="conversations"]')).not.toHaveClass(/\bactive\b/);
});

// ── palette golden paths ─────────────────────────────────────────────────────

test('palette: opens from the nav rail icon and via the keyboard shortcut', async ({ page }) => {
  await boot(page);
  await openPalette(page);
  await page.keyboard.press('Escape');
  await expect(page.locator('#palette-overlay')).toBeHidden();
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.locator('#palette-input')).toBeFocused();
  await page.keyboard.press('ControlOrMeta+k'); // toggles closed
  await expect(page.locator('#palette-overlay')).toBeHidden();
});

test('palette: results are grouped by type with highlighted matches', async ({ page }) => {
  await boot(page);
  await search(page, 'pricing');
  await expect(page.locator('.palette-group-label', { hasText: 'Files' })).toBeVisible();
  await expect(page.locator('.palette-item-meta mark').first()).toContainText(/pricing/i);
});

test('palette: Enter opens the selected result', async ({ page }) => {
  await boot(page);
  await search(page, 'roadmap');
  await expect(page.locator('.palette-item.selected[data-type="file"]')).toBeVisible();
  await page.keyboard.press('Enter');
  await expectSection(page, 'files', 'editor');
  await expect(page.locator('#editor-filename')).toContainText('Roadmap-2026');
});

test('palette: Escape closes and returns focus to the opener', async ({ page }) => {
  await boot(page);
  await openPalette(page);
  await page.keyboard.press('Escape');
  await expect(page.locator('#palette-overlay')).toBeHidden();
  await expect(page.locator('#nav-search-btn')).toBeFocused();
});

test('palette: navigating to a result leaves no stale focus ring on the nav rail', async ({ page }) => {
  // Regression: closePalette() restored focus unconditionally, so selecting
  // a result handed focus back to the last-clicked nav button. In keyboard
  // modality (Cmd/Ctrl+K, Enter) the browser then painted its focus ring on
  // a view the user just left, alongside the new view's active highlight.
  // Cancel closes still restore focus (pinned by the Escape test above);
  // selection closes must not.
  await boot(page);
  await page.locator('.nav-item[data-nav="team"]').click(); // leave focus on a nav button
  // Keyboard invocation, deliberately NOT the search() helper (which clicks
  // the rail button and would toggle this palette closed): the bug only
  // reproduces in keyboard modality.
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.locator('#palette-input')).toBeFocused();
  await page.locator('#palette-input').fill('roadmap');
  await expect(page.locator('.palette-group-label').first()).not.toContainText('Recent');
  await expect(page.locator('.palette-item.selected[data-type="file"]')).toBeVisible();
  await page.keyboard.press('Enter');
  await expectSection(page, 'files', 'editor');
  await expect(page.locator('.nav-item[data-nav="team"]')).not.toBeFocused();
  const railHasFocusRing = await page.evaluate(() =>
    !!document.querySelector('.nav-item:focus-visible, .nav-btn:focus-visible'));
  expect(railHasFocusRing).toBe(false);
});

test('palette: an empty query shows recent items, not nothing', async ({ page }) => {
  await boot(page);
  await openPalette(page);
  await expect(page.locator('.palette-group-label', { hasText: 'Recent files' })).toBeVisible();
  await expect(page.locator('.palette-group-label', { hasText: 'Recent conversations' })).toBeVisible();
});

test('palette: the no-results state explains what is searchable', async ({ page }) => {
  await boot(page);
  await openPalette(page);
  await page.locator('#palette-input').fill('zzzznothingmatches');
  await expect(page.locator('.palette-empty')).toContainText('No matches');
  await expect(page.locator('.palette-empty')).toContainText('file contents');
});

// ── conversations sidebar (pinned-first rework) ─────────────────────────────

test('sidebar: pinned conversations group first and the Unread filter has a caught-up state', async ({ page }) => {
  await boot(page);
  await page.locator('.nav-item[data-nav="conversations"]').click();
  // The pinned conversation ranks above the more recently active unpinned one
  // and carries the pin indicator.
  const first = page.locator('.convo-item').first();
  await expect(first).toContainText('Board prep planning');
  await expect(first.locator('.convo-pin-indicator')).toBeVisible();
  // Unread pill is always visible; with nothing unread it shows the
  // caught-up state instead of hiding.
  await page.locator('#pill-unread').click();
  await expect(page.locator('#convo-list')).toContainText("You're all caught up");
  await page.locator('#pill-all').click();
  await expect(page.locator('.convo-item').first()).toBeVisible();
});
