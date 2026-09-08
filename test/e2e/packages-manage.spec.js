'use strict';
// E2E for the Packages page as a place to manage what was installed, against
// the real server, reached through the Settings entry and the Packages nav
// item: check for update from a local repository fixture, disable with a
// mounted frame standing down, uninstall through its confirmation, and the
// receipts rendered from seeded files.
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
  write(workspace, '.claude/rundock/extensions.json', JSON.stringify({
    schema: 'rundock.extensions/v1',
    extensions: [{
      name: NAME, version: '1.0.0', entry: 'index.js', match: '*.csv',
      source: { url: `https://github.com/e2e-fixture/${NAME}`, reference: 'v1.0.0' },
      installedAt: '2026-09-01T00:00:00.000Z', root: `.claude/rundock/extensions/${NAME}`,
    }],
  }, null, 2) + '\n');
  write(workspace, `.claude/rundock/extensions/${NAME}/rundock.json`, JSON.stringify({ name: NAME, version: '1.0.0', extension: { entry: 'index.js', match: '*.csv' } }));
  write(workspace, `.claude/rundock/extensions/${NAME}/index.js`, ENTRY);
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
    write(workspace, `.claude/rundock/receipts/2026-08-1${n}-run${n}.json`, JSON.stringify({
      schema: 'rundock.package-import-receipt/v1',
      source: { id: `https://github.com/e2e-fixture/pack-${n}`, reference: 'v1.0.0' },
      appliedAt: `2026-08-1${n}T09:00:00.000Z`,
      items: [{ id: 'file:from-pack', kind: 'file', destination: 'notes/from-pack.md', decision: 'add', outcome: 'written' }],
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
  await expect(page.locator('#packages-extensions')).toBeVisible();
}

test('the managed row is reached through the nav item; check, disable, uninstall and the receipts all run against the real server', async ({ page }) => {
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
  const row = page.locator(`.ext-row[data-extension="${NAME}"]`);
  await expect(row).toBeVisible();
  await expect(row.locator('.ext-chip')).toHaveText('Enabled');
  await expect(row.locator('.meta .src')).toContainText(`e2e-fixture/${NAME}`);
  await expect(row.locator('.meta')).toContainText('pinned v1.0.0');
  await expect(row.locator('[data-action="uninstall"]')).toHaveClass('linkbtn danger');
  await expect(page.locator('.packages-field-hint')).toContainText('Rundock does not review packages');

  // Recently added: five of what is on disk (earlier specs leave receipts in
  // this shared workspace too), then all of them.
  const total = fs.readdirSync(path.join(workspace, '.claude/rundock/receipts')).filter((f) => f.endsWith('.json')).length;
  expect(total).toBeGreaterThanOrEqual(6);
  await expect(page.locator('.receipt-row')).toHaveCount(5);
  await expect(page.locator('.see-all')).toHaveText(`See all (${total})`);
  await page.locator('.see-all').click();
  await expect(page.locator('.receipt-row')).toHaveCount(total);
  const mine = page.locator('.receipt-row[data-receipt="2026-08-16-run6.json"]');
  await expect(mine.locator('.contents')).toHaveText('1 file');
  await expect(mine.locator('.from')).toHaveText('from e2e-fixture/pack-6 at v1.0.0');

  // Check for update answers from the local repository fixture.
  await row.locator('[data-action="check"]').click();
  await expect(row.locator('.ext-chip')).toHaveText('Update available');
  await expect(row.locator('.linkbtn.accent')).toHaveText('Update to v1.1.0');

  // Disable writes the record and stands the mounted frame down.
  await row.locator('[data-action="disable"]').click();
  await expect(row.locator('.ext-chip')).toHaveText('Disabled');
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(workspace, '.claude/rundock/extensions.json'), 'utf8')).extensions[0].enabled).toBe(false);
  await page.locator('.nav-item[data-nav="files"]').click();
  await expect(page.locator('#editor-content .viewer-unsupported')).toBeVisible();
  await expect(page.locator('#editor-content iframe.extension-frame')).toHaveCount(0);
  expect(await page.evaluate(() => currentFilePath)).toBe('sales.csv');

  // Uninstall: nothing leaves before the confirmation; the reply removes the
  // row, the directory and the record, and says what stayed.
  await openPackages(page);
  await expect(page.locator('.settings-btn-danger')).toHaveCount(0);
  await row.locator('[data-action="uninstall"]').click();
  const confirm = row.locator('.ext-confirm .settings-btn-danger');
  await expect(confirm).toHaveText(`Uninstall ${NAME}`);
  expect(fs.existsSync(path.join(workspace, '.claude/rundock/extensions', NAME))).toBe(true);
  await confirm.click();
  await expect(row).toHaveCount(0);
  await expect(page.locator('.ext-notice')).toContainText('ordinary workspace files');
  await expect.poll(() => fs.existsSync(path.join(workspace, '.claude/rundock/extensions', NAME))).toBe(false);
  expect(JSON.parse(fs.readFileSync(path.join(workspace, '.claude/rundock/extensions.json'), 'utf8')).extensions).toEqual([]);

  // A receipt item opens Files on the path it landed at.
  await page.locator('.receipt-row[data-receipt="2026-08-16-run6.json"] .items .linkbtn').click();
  await expect.poll(() => page.evaluate(() => currentFilePath)).toBe('notes/from-pack.md');
});
