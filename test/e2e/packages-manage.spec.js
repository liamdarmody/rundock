'use strict';
// E2E for the Packages page against the real server, reached through the
// Settings entry and the Packages nav item: one card per installed package,
// the check for updates that runs when the page opens (answered by a local
// repository fixture), a package updated as one unit from its card with the
// extension's open view swapped to the new version, and a package
// uninstalled from its card through its confirmation. Switching an extension
// on or off is the Extensions page's, covered in settings-panes.spec.js.
const base = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
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

const CSV = 'region,revenue\nnorth,120\n';
const ENTRY = "window.addEventListener('message', function (e) { if (e.data && e.data.type === 'init') { var p = document.createElement('pre'); p.id = 'echo'; p.textContent = e.data.content; document.body.appendChild(p); } });\nparent.postMessage({ type: 'ready' }, '*');";
const NAME = 'csv-echo';

function write(root, rel, content) {
  const absolute = path.join(root, rel);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

// The store as the install flow writes it, pointing at the fixture organisation git rewrites locally.
function writeStore(workspace) {
  write(workspace, '.rundock/extensions.json', JSON.stringify({
    schema: 'rundock.extensions/v1',
    extensions: [{
      name: NAME, version: '1.0.0', entry: 'index.js', match: '*.csv',
      source: { url: `https://github.com/e2e-fixture/${NAME}`, reference: 'v1.0.0' },
      installedAt: '2026-09-01T00:00:00.000Z', root: `.rundock/extensions/${NAME}`,
    }],
  }, null, 2) + '\n');
  write(workspace, `.rundock/extensions/${NAME}/rundock.json`, JSON.stringify({ name: NAME, version: '1.0.0', extension: { entry: 'index.js', match: '*.csv' } }));
  write(workspace, `.rundock/extensions/${NAME}/index.js`, ENTRY);
}

// The extension's repository, with a tag newer than the pinned one.
function seedRepo(workspace) {
  const dir = path.join(workspace, '..', 'repos', NAME);
  fs.rmSync(dir, { recursive: true, force: true });
  write(dir, 'rundock.json', JSON.stringify({ name: NAME, version: '1.1.0', extension: { entry: 'index.js', match: '*.csv' } }));
  write(dir, 'index.js', ENTRY);
  const git = (...args) => execFileSync('git', ['-c', 'user.email=e2e@example.com', '-c', 'user.name=e2e', ...args], { cwd: dir, stdio: 'ignore' });
  git('init', '--quiet'); git('add', '.'); git('commit', '--quiet', '-m', 'extension'); git('tag', 'v1.0.0'); git('tag', 'v1.1.0');
}

function seedReceipts(workspace) {
  for (const n of [1, 2, 3, 4, 5, 6]) {
    write(workspace, `.rundock/receipts/2026-08-1${n}-run${n}.json`, JSON.stringify({
      schema: 'rundock.package-import-receipt/v1',
      source: { id: `https://github.com/e2e-fixture/pack-${n}`, reference: 'v1.0.0' },
      appliedAt: `2026-08-1${n}T09:00:00.000Z`,
      items: [{ id: 'starter:notes/from-pack.md', kind: 'starter', destination: 'notes/from-pack.md', decision: 'add', outcome: 'written', fingerprint: `sha256:${'0'.repeat(64)}` }],
    }));
  }
  write(workspace, 'notes/from-pack.md', '# From a pack\n');
}

async function boot(page) {
  await page.goto('/');
  await expect(page.locator('.convo-item').first()).toBeVisible();
}

async function openPackages(page) {
  await page.locator('.nav-item[data-nav="settings"]').click();
  await page.locator('.settings-nav-item[data-settings="packages"]').click();
  await expect(page.locator('#packages-installed')).toBeVisible();
}

test('a package is a card; opening Packages checks for updates; a package updates, then uninstalls, from its card', async ({ page }) => {
  await boot(page);
  const workspace = await page.evaluate(() => currentWorkspacePath);
  write(workspace, 'sales.csv', CSV);
  writeStore(workspace);
  seedRepo(workspace);
  seedReceipts(workspace);
  await page.reload();
  await boot(page);

  // A mount to reconcile: the file opens inside the extension's frame.
  await page.locator('.nav-item[data-nav="files"]').click();
  const csvRow = page.locator('.file-item', { hasText: 'sales.csv' }).first();
  await expect(csvRow).toBeVisible({ timeout: 15_000 });
  await csvRow.click();
  await expect(page.frameLocator('#editor-content iframe.extension-frame').locator('#echo')).toHaveText(CSV.trim());

  await openPackages(page);
  await expect(page.locator('.packages-field-hint')).toContainText("Rundock doesn't review packages");
  await expect(page.locator('.settings-section-label').nth(1)).toHaveText('Installed packages');
  const card = page.locator(`.pkg-card-row[data-package="https://github.com/e2e-fixture/${NAME}"]`);
  await expect(card.locator('.pkg-card-name')).toHaveText('Csv Echo');
  await expect(card.locator('.pkg-card-ver')).toHaveText('v1.0.0');
  await expect(card.locator('.pkg-card-repo a')).toHaveText(`github.com/e2e-fixture/${NAME}`);
  await expect(card.locator('.pkg-card-counts')).toHaveText('1 extension');
  const seeded = page.locator('.pkg-card-row[data-package="https://github.com/e2e-fixture/pack-6"]');
  await expect(seeded.locator('.pkg-card-counts')).toHaveText('1 starter file');

  // Opening the page checked for updates: the local fixture has v1.1.0.
  await expect(card.locator('.pkg-card-status')).toHaveText('Update available: v1.1.0');
  await card.locator('[data-action="update"]').click();
  const review = card.locator('#packages-update-review');
  await expect(review.locator('.pkg-review-title')).toHaveText('Update Csv Echo to v1.1.0?');
  await expect(review.locator('.pkg-review-group-label')).toHaveText(['Changed by the author']);
  expect(JSON.parse(fs.readFileSync(path.join(workspace, '.rundock/extensions.json'), 'utf8')).extensions[0].version).toBe('1.0.0');
  await review.getByRole('button', { name: 'Update Csv Echo' }).click();
  await expect(card.locator('#packages-update-done .pkg-review-title')).toHaveText('Csv Echo is updated to v1.1.0.');
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(workspace, '.rundock/extensions.json'), 'utf8')).extensions[0].version).toBe('1.1.0');

  // The open view was swapped to the new version and still shows the file.
  await page.locator('.nav-item[data-nav="files"]').click();
  await expect(page.frameLocator('#editor-content iframe.extension-frame').locator('#echo')).toHaveText(CSV.trim());

  // An item link opens where the item lives.
  await openPackages(page);
  await seeded.locator('.pkg-card-items .linkbtn').first().click();
  await expect.poll(() => page.evaluate(() => currentFilePath)).toBe('notes/from-pack.md');

  // Uninstall asks first, lists what goes, and removes only on its named
  // button; the package then leaves the list and its file shows plain. The
  // item link above left Files on notes/from-pack.md, so the file is opened
  // again by name rather than assumed to be the one on screen.
  await openPackages(page);
  await card.locator('[data-action="uninstall"]').click();
  const confirm = card.locator('#packages-uninstall-confirm');
  await expect(confirm.locator('.pkg-review-title')).toHaveText('Uninstall Csv Echo?');
  await expect(confirm.locator('.pkg-review-item')).toHaveText(['Csv Echo (extension)']);
  expect(fs.existsSync(path.join(workspace, '.rundock/extensions', NAME))).toBe(true);
  await confirm.getByRole('button', { name: 'Uninstall Csv Echo' }).click();
  await expect(page.locator('.ext-notice')).toContainText('Csv Echo is uninstalled.');
  await expect(card).toHaveCount(0);
  await expect.poll(() => fs.existsSync(path.join(workspace, '.rundock/extensions', NAME))).toBe(false);
  expect(JSON.parse(fs.readFileSync(path.join(workspace, '.rundock/extensions.json'), 'utf8')).extensions).toEqual([]);
  await page.locator('.nav-item[data-nav="files"]').click();
  await page.locator('.file-item', { hasText: 'sales.csv' }).first().click();
  await expect.poll(() => page.evaluate(() => currentFilePath)).toBe('sales.csv');
  await expect(page.locator('#editor-content .viewer-unsupported')).toBeVisible();
  await expect(page.locator('#editor-content iframe.extension-frame')).toHaveCount(0);
});
