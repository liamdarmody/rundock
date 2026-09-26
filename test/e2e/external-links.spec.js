'use strict';
// EVERY EXTERNAL LINK OPENS OUTSIDE THE APP, on every surface that renders
// one, in browser mode against the real app: a click opens exactly one new
// page at the address, and the app page stays where it was. (The desktop half,
// the system browser and a main window that never navigates, is checked in
// test/electron/confinement.cjs.)
//
// Links point at a receiver this spec opens on 127.0.0.1, except the app's own
// fixed links to its docs and repository, which are answered locally so the
// run touches no network.

const base = require('@playwright/test');
const http = require('node:http');
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

let receiver;
test.beforeAll(async () => {
  const hits = [];
  const server = http.createServer((req, res) => { hits.push(req.url); res.setHeader('content-type', 'text/html'); res.end('<p>outside</p>'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  receiver = { url: `http://127.0.0.1:${server.address().port}`, hits, close: () => server.close() };
});
test.afterAll(() => receiver.close());

const cleanup = [];
test.afterEach(() => { for (const fn of cleanup.splice(0)) { try { fn(); } catch (e) { /* best effort */ } } });

test.beforeEach(async ({ context }) => {
  // The app's own fixed links, answered here rather than on the network.
  await context.route(/^https:\/\/(docs\.rundock\.ai|github\.com)\//, (route) => route.fulfill({ contentType: 'text/html', body: '<p>stand-in</p>' }));
});

async function boot(page) {
  await page.goto('/');
  await expect(page.locator('.convo-item').first()).toBeVisible();
  return page.evaluate(() => currentWorkspacePath);
}
function write(ws, rel, text) {
  fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
  fs.writeFileSync(path.join(ws, rel), text);
  cleanup.push(() => fs.rmSync(path.join(ws, rel), { force: true }));
}
async function openFile(page, name) {
  await page.locator('.nav-item[data-nav="files"]').click();
  const row = page.locator('.file-item', { hasText: name }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click();
}

// Exactly one new page at the address, and the app page left where it was.
async function opensOnceOutside(page, click, expected) {
  const appUrl = page.url();
  const pages = [];
  const onPage = (p) => pages.push(p);
  page.context().on('page', onPage);
  await click();
  await expect.poll(() => pages.length, { timeout: 5000 }).toBeGreaterThanOrEqual(1);
  await page.waitForTimeout(600);
  page.context().off('page', onPage);
  expect(pages.length, 'one new page, not two').toBe(1);
  await pages[0].waitForLoadState();
  expect(pages[0].url()).toBe(expected);
  expect(page.url(), 'the app page did not navigate').toBe(appUrl);
  await pages[0].close();
}

test('a conversation message', async ({ page }) => {
  await boot(page);
  await page.locator('.convo-item').first().click();
  await page.evaluate((u) => addAgentMsg(`See [the page](${u}/conversation).`, 'wren'), receiver.url);
  await opensOnceOutside(page, () => page.locator('#messages a', { hasText: 'the page' }).click(), `${receiver.url}/conversation`);
});

test('a protocol-relative link in a conversation', async ({ page }) => {
  await boot(page);
  await page.locator('.convo-item').first().click();
  const hostPath = receiver.url.replace(/^http:/, '');
  await page.evaluate((u) => addAgentMsg(`See [the page](${u}/relative).`, 'wren'), hostPath);
  await opensOnceOutside(page, () => page.locator('#messages a', { hasText: 'the page' }).click(), `${receiver.url}/relative`);
});

test('a chat error card', async ({ page }) => {
  await boot(page);
  await page.locator('.convo-item').first().click();
  await page.evaluate(() => renderAuthErrorCard(activeConversation.id));
  const link = page.locator('#messages a[href^="https://docs.rundock.ai/"]').first();
  const href = await link.getAttribute('href');
  await opensOnceOutside(page, () => link.click(), href);
});

test('a note in the rich editor', async ({ page }) => {
  const ws = await boot(page);
  write(ws, 'ext-note.md', `# Note\n\nSee [the page](${receiver.url}/note).\n`);
  await openFile(page, 'ext-note.md');
  const link = page.locator('.ProseMirror a', { hasText: 'the page' });
  await expect(link).toBeVisible();
  await opensOnceOutside(page, () => link.click(), `${receiver.url}/note`);
});

test('a read-only rendering (a text file drawn as markdown)', async ({ page }) => {
  const ws = await boot(page);
  write(ws, 'ext-readme.txt', `See [the page](${receiver.url}/readonly).\n`);
  await openFile(page, 'ext-readme.txt');
  const link = page.locator('#editor-content a', { hasText: 'the page' });
  await expect(link).toBeVisible();
  await opensOnceOutside(page, () => link.click(), `${receiver.url}/readonly`);
});

test('an embedded note', async ({ page }) => {
  const ws = await boot(page);
  write(ws, 'ext-embedded.md', `# Embedded\n\nSee [the page](${receiver.url}/embed).\n`);
  write(ws, 'ext-host.md', '# Host\n\n![[ext-embedded.md]]\n');
  await openFile(page, 'ext-host.md');
  const link = page.locator('.embed-panel a', { hasText: 'the page' });
  await expect(link).toBeVisible({ timeout: 10_000 });
  await opensOnceOutside(page, () => link.click(), `${receiver.url}/embed`);
});

test('a board card, which opens the link and does not start editing the card', async ({ page }) => {
  const ws = await boot(page);
  write(ws, 'ext-board.md', `---\n\nkanban-plugin: board\n\n---\n\n## To do\n\n- [ ] Read [the page](${receiver.url}/board)\n\n\n\n\n%% kanban:settings\n\`\`\`\n{"kanban-plugin":"board"}\n\`\`\`\n%%`);
  await openFile(page, 'ext-board.md');
  const link = page.locator('.board-card-text a', { hasText: 'the page' });
  await expect(link).toBeVisible();
  await opensOnceOutside(page, () => link.click(), `${receiver.url}/board`);
  await expect(page.locator('.board-card.editing')).toHaveCount(0);
});

test('an HTML preview, opened once and not twice', async ({ page }) => {
  const ws = await boot(page);
  write(ws, 'ext-page.html', `<!doctype html><p><a id="out" href="${receiver.url}/preview">the page</a></p>`);
  await openFile(page, 'ext-page.html');
  const frame = page.frameLocator('#editor-content iframe.viewer-frame');
  await expect(frame.locator('#out')).toBeVisible();
  await opensOnceOutside(page, () => frame.locator('#out').click(), `${receiver.url}/preview`);
});

test('the Report an issue link in Settings', async ({ page }) => {
  await boot(page);
  await page.locator('.nav-item[data-nav="settings"]').click();
  await page.evaluate(() => showSettingsSection('about'));
  const link = page.locator('a', { hasText: 'Report an issue' });
  await opensOnceOutside(page, () => link.click(), 'https://github.com/liamdarmody/rundock/issues');
});

test('the Help and docs button', async ({ page }) => {
  await boot(page);
  await opensOnceOutside(page, () => page.locator('#tb-help').click(), 'https://docs.rundock.ai/');
});

test('an in-page anchor and a wikilink stay inside the app', async ({ page }) => {
  const ws = await boot(page);
  write(ws, 'ext-inside.md', '# Inside\n\nGo to [[Roadmap-2026]].\n');
  await openFile(page, 'ext-inside.md');
  const pages = [];
  page.context().on('page', (p) => pages.push(p));
  await page.locator('.ProseMirror a.wikilink, .ProseMirror [data-target]').first().click();
  await expect.poll(() => page.evaluate(() => currentFilePath)).toBe('Roadmap-2026.md');
  expect(pages).toEqual([]);
});

test('a relative link to a workspace file in the rich editor opens that file in Rundock, as read-only rendering does', async ({ page }) => {
  const ws = await boot(page);
  write(ws, 'ext-relative.md', '# Relative\n\nSee [the roadmap](Roadmap-2026.md).\n');
  await openFile(page, 'ext-relative.md');
  const pages = [];
  page.context().on('page', (p) => pages.push(p));
  const appUrl = page.url();
  await page.locator('.ProseMirror a', { hasText: 'the roadmap' }).click();
  await expect.poll(() => page.evaluate(() => currentFilePath)).toBe('Roadmap-2026.md');
  expect(pages).toEqual([]);
  expect(page.url()).toBe(appUrl);
});
