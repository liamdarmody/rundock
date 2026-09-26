'use strict';
// A PERSON'S FIRST DELIBERATE CLICK IN A VIEW ALWAYS WORKS, in the real app.
// Reported: on a note opened from another view's button, the first click on
// the new view's own button, within a few seconds, was refused as "already
// used", and only the second click worked. A benign extension is written into
// the e2e launcher's disposable workspace and removed after the test.

const base = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
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

// A view with one button that opens the note its frontmatter names, and a
// record of every refusal it is told about.
const ENTRY = [
  "var seen = []; var pre = document.createElement('pre'); pre.id = 'seen';",
  "window.addEventListener('message', function (e) {",
  "  if (!e.data) return; seen.push(e.data.type === 'refused' ? e.data : { type: e.data.type }); pre.textContent = JSON.stringify(seen);",
  "  if (e.data.type !== 'init') return;",
  "  var next = (/next: (.+)/.exec(e.data.content) || [])[1];",
  "  document.body.innerHTML = ''; var b = document.createElement('button'); b.id = 'go'; b.textContent = 'Open ' + next;",
  "  b.onclick = function () { parent.postMessage({ type: 'open', target: next }, '*'); };",
  "  document.body.appendChild(b); document.body.appendChild(pre);",
  "});",
  "parent.postMessage({ type: 'ready' }, '*');",
].join('\n');

const made = [];
test.afterEach(() => { for (const p of made.splice(0)) fs.rmSync(p, { recursive: true, force: true }); });
function write(ws, rel, text) {
  fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
  fs.writeFileSync(path.join(ws, rel), text);
  made.push(path.join(ws, rel));
}

// Opens the chain the report describes and returns a locator for the frame.
async function hopFromFirst(page) {
  await page.goto('/');
  await expect(page.locator('.convo-item').first()).toBeVisible();
  const ws = await page.evaluate(() => currentWorkspacePath);
  const rec = { name: 'hopper', version: '1.0.0', entry: 'index.js', match: '*.md', declares: 'hopper-note', root: '.rundock/extensions/hopper',
    source: { url: 'https://github.com/example/hopper', reference: 'v1.0.0' }, installedAt: '2026-09-23T00:00:00.000Z' };
  write(ws, '.rundock/extensions.json', JSON.stringify({ schema: 'rundock.extensions/v1', extensions: [rec] }) + '\n');
  write(ws, '.rundock/extensions/hopper/rundock.json', JSON.stringify({ name: 'hopper', version: '1.0.0', extension: { entry: 'index.js', match: '*.md', declares: 'hopper-note' } }));
  write(ws, '.rundock/extensions/hopper/index.js', ENTRY);
  write(ws, 'hop-first.md', '---\nhopper-note: true\n---\nnext: hop-second\n');
  write(ws, 'hop-second.md', '---\nhopper-note: true\n---\nnext: Investment Dashboard.md\n');
  write(ws, 'Investment Dashboard.md', '# Investment Dashboard\n');
  await page.reload();
  await expect(page.locator('.convo-item').first()).toBeVisible();
  await page.locator('.nav-item[data-nav="files"]').click();
  await page.locator('.file-item', { hasText: 'hop-first.md' }).first().click();
  const frame = () => page.frameLocator('#editor-content iframe.extension-frame');
  await expect(frame().locator('#go')).toBeVisible();
  // Past the activation window of the tree click that opened it, so this
  // first click is honoured outright.
  await page.waitForTimeout(6000);
  await frame().locator('#go').click();
  await expect.poll(() => page.evaluate(() => currentFilePath)).toBe('hop-second.md');
  await expect(frame().locator('#go')).toHaveText('Open Investment Dashboard.md');
  return frame;
}

// The reported case, as decided (2026-09-23): the new view's first click,
// inside the few seconds the earlier click's activation lasts, cannot be
// told apart from that activation, so Rundock asks, in its own bar above the
// view, and Open does what the view asked.
test('a note opened from another view\'s button: a click on the new view\'s button within seconds is put to the person, and Open works', async ({ page }) => {
  const frame = await hopFromFirst(page);
  await frame().locator('#go').click();
  const bar = page.locator('#editor-content > [data-extension-request="confirm"]');
  await expect(bar).toBeVisible();
  await expect(bar.locator('.rui-alert-message')).toHaveText('Open Investment Dashboard.md?');
  // Directly above the frame, in the page, never inside the frame.
  expect(await bar.evaluate((el) => el.nextElementSibling && el.nextElementSibling.matches('iframe.extension-frame'))).toBe(true);
  await expect(frame().locator('[data-extension-request]')).toHaveCount(0);
  expect(await page.evaluate(() => currentFilePath)).toBe('hop-second.md');
  if (process.env.RUNDOCK_BAR_SHOTS) {
    const dir = process.env.RUNDOCK_BAR_SHOTS;
    fs.mkdirSync(dir, { recursive: true });
    const pane = page.locator('#editor-content');
    // Armed, as the person sees it once it has been on screen a moment.
    await expect(bar.getByRole('button', { name: 'Open', exact: true })).toBeEnabled();
    const light = await page.evaluate(() => document.body.classList.contains('light'));
    await pane.screenshot({ path: path.join(dir, `request-bar-${light ? 'light' : 'dark'}.png`) });
    await page.evaluate(() => toggleTheme());
    await expect(bar).toBeVisible();
    // Past the theme's own colour transition, so the capture is the settled theme.
    await expect.poll(() => bar.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe('rgb(51, 51, 51)');
    await page.waitForTimeout(1500);
    await pane.screenshot({ path: path.join(dir, `request-bar-${light ? 'dark' : 'light'}.png`) });
    await page.evaluate(() => toggleTheme());
  }
  await bar.getByRole('button', { name: 'Open', exact: true }).click();
  await expect.poll(() => page.evaluate(() => currentFilePath), { timeout: 3000 }).toBe('Investment Dashboard.md');
  await expect(page.locator('[data-extension-request]')).toHaveCount(0);
});

test('Dismiss sends the view a refusal, opens nothing, and clears the bar', async ({ page }) => {
  const frame = await hopFromFirst(page);
  await frame().locator('#go').click();
  const bar = page.locator('#editor-content > [data-extension-request="confirm"]');
  await expect(bar).toBeVisible();
  await bar.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(bar).toHaveCount(0);
  await expect(frame().locator('#seen')).toContainText('you dismissed this in Rundock');
  expect(await page.evaluate(() => currentFilePath)).toBe('hop-second.md');
});

// A view that asks to open a note the moment it starts, with nobody touching
// it. Rundock stops it and says so in the same place, above the view.
test('a view that opens a note with no click is stopped, and the person is told what was stopped', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.convo-item').first()).toBeVisible();
  const ws = await page.evaluate(() => currentWorkspacePath);
  const rec = { name: 'grabby', version: '1.0.0', entry: 'index.js', match: '*.md', declares: 'grabby-note', root: '.rundock/extensions/grabby',
    source: { url: 'https://github.com/example/grabby', reference: 'v1.0.0' }, installedAt: '2026-09-23T00:00:00.000Z' };
  write(ws, '.rundock/extensions.json', JSON.stringify({ schema: 'rundock.extensions/v1', extensions: [rec] }) + '\n');
  write(ws, '.rundock/extensions/grabby/rundock.json', JSON.stringify({ name: 'grabby', version: '1.0.0', extension: { entry: 'index.js', match: '*.md', declares: 'grabby-note' } }));
  write(ws, '.rundock/extensions/grabby/index.js', [
    "var pre = document.createElement('pre'); pre.id = 'seen'; document.body.appendChild(pre);",
    "window.addEventListener('message', function (e) {",
    "  if (e.data && e.data.type === 'refused') pre.textContent = e.data.reason;",
    "  if (e.data && e.data.type === 'init') setTimeout(function () { parent.postMessage({ type: 'open', target: 'Investment Dashboard.md' }, '*'); }, 6500);",
    "});",
    "parent.postMessage({ type: 'ready' }, '*');",
  ].join('\n'));
  write(ws, 'grab.md', '---\ngrabby-note: true\n---\n');
  write(ws, 'Investment Dashboard.md', '# Investment Dashboard\n');
  await page.reload();
  await expect(page.locator('.convo-item').first()).toBeVisible();
  await page.locator('.nav-item[data-nav="files"]').click();
  await page.locator('.file-item', { hasText: 'grab.md' }).first().click();
  const line = page.locator('#editor-content > [data-extension-request="refused"]');
  await expect(line).toBeVisible({ timeout: 12000 });
  await expect(line.locator('.rui-alert-message')).toHaveText('The grabby extension tried to open Investment Dashboard.md without you asking, so Rundock stopped it.');
  await expect(page.frameLocator('#editor-content iframe.extension-frame').locator('#seen')).toHaveText('Rundock stopped this because it did not come from your click');
  expect(await page.evaluate(() => currentFilePath)).toBe('grab.md');
  if (process.env.RUNDOCK_BAR_SHOTS) {
    const dir = process.env.RUNDOCK_BAR_SHOTS;
    const pane = page.locator('#editor-content');
    const light = await page.evaluate(() => document.body.classList.contains('light'));
    await pane.screenshot({ path: path.join(dir, `refusal-line-${light ? 'light' : 'dark'}.png`) });
    await page.evaluate(() => toggleTheme());
    await page.waitForTimeout(1500);
    await pane.screenshot({ path: path.join(dir, `refusal-line-${light ? 'dark' : 'light'}.png`) });
    await page.evaluate(() => toggleTheme());
  }
  await line.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(line).toHaveCount(0);
});
