'use strict';
// E2E for the wired extension host, against the real server.
//
// A fixture extension is written into the live workspace's install store
// (one record in .claude/rundock/extensions.json, its files under
// .claude/rundock/extensions/csv-echo/) exactly the way the install flow
// writes them. Its entry says ready, writes the content it receives in init
// into the frame, and offers a button that asks the host to open a sibling.
// The spec opens a .csv through the file tree (which lists it only because
// an enabled record claims it) and reads the frame; then flips the record to
// enabled: false, re-hydrates, sees the tree stop listing the file, opens it
// by exact path, and reads the plain surface. Nothing here is stubbed:
// roster, tree, transport, mount, teardown and the open route all run
// through the real socket.
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

const CSV = 'region,revenue\nnorth,120\nsouth,98\n';

// The fixture extension's entry: the whole of what a renderer can do, in a
// few lines. It runs inside the opaque frame, so it reaches the host only
// through the closed message table.
const ENTRY = [
  "window.addEventListener('message', function (e) {",
  '  var d = e.data;',
  "  if (!d || d.type !== 'init') return;",
  "  document.body.textContent = '';",
  "  var pre = document.createElement('pre'); pre.id = 'echo'; pre.textContent = d.content; document.body.appendChild(pre);",
  "  var meta = document.createElement('p'); meta.id = 'meta'; meta.textContent = d.path + ' ' + d.theme; document.body.appendChild(meta);",
  "  var btn = document.createElement('button'); btn.id = 'open-sibling'; btn.textContent = 'Open sibling';",
  "  btn.addEventListener('click', function () { parent.postMessage({ type: 'open', target: 'sibling-note' }, '*'); });",
  '  document.body.appendChild(btn);',
  "  parent.postMessage({ type: 'resize', height: 240 }, '*');",
  '});',
  "parent.postMessage({ type: 'ready' }, '*');",
].join('\n');

function record(extra = {}) {
  return {
    name: 'csv-echo', version: '1.0.0', entry: 'index.js', match: '*.csv',
    source: { url: 'https://github.com/example/csv-echo', reference: 'v1.0.0' },
    installedAt: '2026-09-07T00:00:00.000Z', root: '.claude/rundock/extensions/csv-echo',
    ...extra,
  };
}

async function boot(page) {
  await page.goto('/');
  await expect(page.locator('.convo-item').first()).toBeVisible();
}

async function workspaceDir(page) {
  return page.evaluate(() => currentWorkspacePath);
}

function write(workspace, rel, content) {
  const absolute = path.join(workspace, rel);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

function writeStore(workspace, rec) {
  write(workspace, '.claude/rundock/extensions.json',
    JSON.stringify({ schema: 'rundock.extensions/v1', extensions: [rec] }, null, 2) + '\n');
  write(workspace, '.claude/rundock/extensions/csv-echo/rundock.json',
    JSON.stringify({ name: 'csv-echo', version: '1.0.0', extension: { entry: 'index.js', match: '*.csv' } }));
  write(workspace, '.claude/rundock/extensions/csv-echo/index.js', ENTRY);
}

// Open a file by clicking its row in the tree. The tree is pushed by the
// server's own poll once the seeded files exist, so the row is waited for.
async function openFromTree(page, name) {
  await page.locator('.nav-item[data-nav="files"]').click();
  const row = page.locator('.file-item', { hasText: name }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click();
}

test('an installed extension renders the opened file inside its frame, and its open message opens a sibling', async ({ page }) => {
  await boot(page);
  const workspace = await workspaceDir(page);
  write(workspace, 'sales.csv', CSV);
  write(workspace, 'sibling-note.md', '# Sibling\n\nOpened from the frame.\n');
  writeStore(workspace, record());
  // Re-hydrate: the roster is requested when the workspace opens, so a
  // store written after boot is read on the next open.
  await page.reload();
  await boot(page);

  await openFromTree(page, 'sales.csv');
  const frame = page.locator('#editor-content iframe.extension-frame');
  await expect(frame).toBeVisible();
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');

  const inner = page.frameLocator('#editor-content iframe.extension-frame');
  await expect(inner.locator('#echo')).toHaveText(CSV.trim());
  const theme = await page.evaluate(() => (document.body.classList.contains('light') ? 'light' : 'dark'));
  await expect(inner.locator('#meta')).toHaveText(`sales.csv ${theme}`);
  // The resize request was honoured within the clamp, through the sheet's floor.
  const height = await frame.evaluate(el => el.getBoundingClientRect().height);
  expect(height).toBeGreaterThanOrEqual(40);

  // The frame asks for a sibling by bare name; the host resolves it the way
  // a wikilink click would and opens it.
  await inner.locator('#open-sibling').click();
  await expect.poll(() => page.evaluate(() => currentFilePath)).toBe('sibling-note.md');
  await expect(page.locator('#editor-content iframe.extension-frame')).toHaveCount(0,
    'opening another file released the mount');
});

test('with the record disabled, the same file renders the plain surface after re-hydration', async ({ page }) => {
  await boot(page);
  const workspace = await workspaceDir(page);
  write(workspace, 'sales.csv', CSV);
  writeStore(workspace, record({ enabled: false }));
  await page.reload();
  await boot(page);

  await expect.poll(() => page.evaluate(() => {
    const r = window.rundockRendererRegistry;
    return r ? r.rendererFor('sales.csv').registered : null;
  })).toBe(false);

  // With the record disabled the tree no longer lists the file at all: the
  // tree lists what an enabled record claims, and nothing else renders csv.
  await page.locator('.nav-item[data-nav="files"]').click();
  await expect(page.locator('.file-item', { hasText: 'Roadmap-2026.md' }).first()).toBeVisible();
  await expect(page.locator('.file-item', { hasText: 'sales.csv' })).toHaveCount(0);
  // Opened by its exact path, the way a wikilink or the palette would, the
  // file renders the plain surface with no frame in the pane.
  await page.evaluate(() => openWorkspaceFilePath('sales.csv'));
  await expect(page.locator('#editor-content .viewer-unsupported')).toBeVisible();
  await expect(page.locator('#editor-content iframe.extension-frame')).toHaveCount(0);
  expect(await page.evaluate(() => currentFilePath)).toBe('sales.csv');
});
