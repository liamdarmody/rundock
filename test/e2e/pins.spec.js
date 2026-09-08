'use strict';
// Pins, walked end to end in the real server and real Chromium.
//
// Pin from the header, pin from the tree row, open from the rail, unpin, at
// each step asserting BOTH the DOM and the `pins` reply the server sent,
// read off the page's own socket. Then the empty state under both themes:
// its text and its ground resolve to colours that differ between dark and
// light, which is the claim that the new rules reference tokens and nothing
// hard-coded.
//
// The spec leaves the fixture with no pins, because the server and its
// fake HOME are shared by every spec in the run.
const { test, expect } = require('@playwright/test');

// Every `pins` reply the page receives, oldest first. Registered before the
// page loads so the socket's first frames are not missed.
function collectPinsReplies(page) {
  const replies = [];
  page.on('websocket', (ws) => {
    ws.on('framereceived', (frame) => {
      try {
        const msg = JSON.parse(frame.payload);
        if (msg && msg.type === 'pins') replies.push(msg.pins);
      } catch (e) { /* binary or non-JSON frame */ }
    });
  });
  return replies;
}

async function boot(page) {
  await page.goto('/');
  await expect(page.locator('.convo-item').first()).toBeVisible();
}

async function openFromTree(page, name) {
  await page.locator('.nav-item[data-nav="files"]').click();
  await page.locator('#file-tree .file-item', { hasText: name }).first().click();
  await expect(page.locator('#editor-filename')).toHaveText(name);
}

const lit = (page) => page.evaluate(() => [...document.querySelectorAll('.nav-item[data-nav].active')].map(e => e.dataset.nav));
const visiblePanels = (page) => page.evaluate(() =>
  [...document.querySelectorAll('aside.sidebar > [id^="sidebar-"]')].filter(e => !e.classList.contains('hidden')).map(e => e.id.replace('sidebar-', '')));
const pinRows = (page) => page.evaluate(() => [...document.querySelectorAll('#pin-list .pin-item')].map(e => e.dataset.path));

async function setTheme(page, light) {
  await page.evaluate((wantLight) => {
    if (document.body.classList.contains('light') !== wantLight) toggleTheme();
  }, light);
  await expect.poll(() => page.evaluate(() => document.body.classList.contains('light'))).toBe(light);
}

// The pane's colours as the browser resolves them, read only once they have
// settled on the tokens the rules name. base.css transitions every colour
// over --duration-slow, so a read straight after the toggle sees the value
// being left, not the one arriving: the poll below is what the theme spec
// does for the body and is the stronger claim here, because it says the
// pane's text is --text-2 and its ground is --surface, whichever theme is on.
async function settledColours(page) {
  const read = () => page.evaluate(() => {
    const body = getComputedStyle(document.body);
    const pane = getComputedStyle(document.querySelector('#view-pins .pins-empty'));
    const lead = getComputedStyle(document.querySelector('#view-pins .pins-empty-lead'));
    const rgb = (name) => {
      const m = /^#([0-9a-f]{6})$/i.exec(body.getPropertyValue(name).trim());
      if (!m) return null;
      const n = parseInt(m[1], 16);
      return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
    };
    return {
      text: pane.color, lead: lead.color, ground: pane.backgroundColor,
      settled: pane.color === rgb('--text-2') && pane.backgroundColor === rgb('--surface') && lead.color === rgb('--text-1'),
    };
  });
  await expect.poll(async () => (await read()).settled, { message: 'the pane must settle on --text-2 over --surface, lead in --text-1' }).toBe(true);
  return read();
}

test('pin from the header, pin from the tree, open from the rail, unpin: the DOM and the pins reply agree at every step', async ({ page }) => {
  const replies = collectPinsReplies(page);
  await boot(page);
  await expect.poll(() => replies.length, 'the workspace open asks for the list').toBeGreaterThan(0);
  expect(replies.at(-1)).toEqual([]);

  // The rail carries Pins directly below Files, present with zero pins.
  const order = await page.evaluate(() => [...document.querySelectorAll('.nav-main .nav-item[data-nav]')].map(e => e.dataset.nav));
  expect(order.indexOf('pins')).toBe(order.indexOf('files') + 1);

  // 1. Pin from the header.
  await openFromTree(page, 'Roadmap-2026.md');
  const control = page.locator('#editor-pin');
  await expect(control).toHaveAttribute('aria-pressed', 'false');
  await control.click();
  await expect(control).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => replies.at(-1)).toEqual(['Roadmap-2026.md']);
  expect(await pinRows(page)).toEqual(['Roadmap-2026.md']);
  expect(await lit(page)).toEqual(['files']);

  // 2. Pin from the tree row's context menu.
  const row = page.locator('#file-tree .file-item', { hasText: 'briefing.md' }).first();
  await row.click({ button: 'right' });
  await expect(page.locator('.files-menu')).toBeVisible();
  await page.locator('.files-menu .files-menu-item', { hasText: /^Pin$/ }).click();
  await expect.poll(() => replies.at(-1)).toEqual(['Roadmap-2026.md', 'briefing.md']);
  expect(await pinRows(page)).toEqual(['Roadmap-2026.md', 'briefing.md']);
  // The same row now offers Unpin.
  await row.click({ button: 'right' });
  await expect(page.locator('.files-menu')).toContainText('Unpin');
  await page.keyboard.press('Escape');
  await page.evaluate(() => closeFilesMenu());

  // 3. Open from the rail. The open file is pinned, so it stays open, and
  //    Pins is lit with the Pins panel up.
  await page.locator('.nav-item[data-nav="pins"]').click();
  expect(await lit(page)).toEqual(['pins']);
  expect(await visiblePanels(page)).toEqual(['pins']);
  await expect(page.locator('#editor-filename')).toHaveText('Roadmap-2026.md');
  await expect(page.locator('#pin-list .pin-item.active')).toHaveAttribute('data-path', 'Roadmap-2026.md');

  // A pinned row opens its file in the same editor, Pins still lit.
  await page.locator('#pin-list .pin-item[data-path="briefing.md"]').click();
  await expect(page.locator('#editor-filename')).toHaveText('briefing.md');
  expect(await lit(page)).toEqual(['pins']);
  await expect(control).toHaveAttribute('aria-pressed', 'true');

  // The same file from the tree lights Files.
  await openFromTree(page, 'briefing.md');
  expect(await lit(page)).toEqual(['files']);

  // 4. Unpin: from the header, then from the row's own control.
  await control.click();
  await expect(control).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => replies.at(-1)).toEqual(['Roadmap-2026.md']);
  expect(await pinRows(page)).toEqual(['Roadmap-2026.md']);

  await page.locator('.nav-item[data-nav="pins"]').click();
  const remaining = page.locator('#pin-list .pin-item[data-path="Roadmap-2026.md"]');
  await remaining.hover();
  await remaining.locator('.pin-unpin').click();
  await expect.poll(() => replies.at(-1)).toEqual([]);
  expect(await pinRows(page)).toEqual([]);
  await expect(page.locator('#pin-list .sidebar-quiet')).toContainText('Nothing pinned yet.');
});

test('with zero pins the rail entry opens onto the empty state, whose colours come from the theme', async ({ page }) => {
  await boot(page);
  await page.locator('.nav-item[data-nav="pins"]').click();
  expect(await lit(page)).toEqual(['pins']);
  const pane = page.locator('#view-pins .pins-empty');
  await expect(pane).toBeVisible();
  await expect(pane).toContainText('Nothing pinned yet.');
  await expect(pane).toContainText('header');
  await expect(pane).toContainText('right-click');

  await setTheme(page, false);
  const dark = await settledColours(page);
  await setTheme(page, true);
  const light = await settledColours(page);
  await setTheme(page, false);

  for (const key of ['text', 'lead', 'ground']) {
    expect(dark[key], `${key} must resolve in dark`).not.toBe('');
    expect(dark[key], `${key} must not be transparent`).not.toBe('rgba(0, 0, 0, 0)');
    expect(light[key], `${key} is the same in both themes, so it is not coming from the theme`).not.toBe(dark[key]);
  }
});
