'use strict';
// E2E for the Packages install flow: the PL4 states against the real server.
// A plan is only requested on submit, an apply only on confirm, cancel writes
// nothing, a collision disables the confirm with its stated copy, and a
// completed apply lands the agents, the skills and the receipt on disk.
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

async function boot(page) {
  await page.goto('/');
  await expect(page.locator('.convo-item').first()).toBeVisible();
}

async function openPackages(page) {
  await page.evaluate(() => { showView('settings'); showSettingsSection('packages'); });
  await expect(page.locator('#packages-source-path')).toBeVisible();
}

// Seed a package source under the live workspace from the test process,
// because the product's own create paths rightly refuse dot segments. Reads
// still go through the server, so what the assertions see is server truth.
async function seedPackage(page, dir, files) {
  const workspace = await page.evaluate(() => currentWorkspacePath);
  for (const [rel, content] of files) {
    const absolute = path.join(workspace, dir, rel);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  }
  return path.join(workspace, dir);
}

async function fileExists(page, rel) {
  const response = await page.request.get('/api/file?path=' + encodeURIComponent(rel));
  return response.ok();
}

const AGENT = '---\nname: scribe\n---\n\nWrite things.\n';

test('plan, confirm and apply land the package with its receipt', async ({ page }) => {
  await boot(page);
  const source = await seedPackage(page, 'pkg-happy', [
    ['.claude/agents/happy-scribe.md', AGENT],
    ['.claude/skills/happy-writer/SKILL.md', 'the skill'],
  ]);
  await openPackages(page);
  await page.fill('#packages-source-path', source);
  await page.getByRole('button', { name: 'Read it' }).click();
  const card = page.locator('.packages-confirm-card');
  await expect(card.locator('.packages-headline')).toHaveText("This isn't a Rundock package");
  await expect(card.locator('.packages-body')).toContainText('1 agent and 1 skill');
  await expect(card.locator('.packages-body')).toContainText("They're not sandboxed");
  await card.getByRole('button', { name: 'Add to my team' }).click();
  await expect(page.locator('.packages-success-card .packages-headline')).toHaveText('Added to your team');
  await expect(page.locator('.packages-part')).toHaveCount(2);
  expect(await fileExists(page, '.claude/agents/happy-scribe.md')).toBe(true);
  expect(await fileExists(page, '.claude/skills/happy-writer/SKILL.md')).toBe(true);
  const receipt = await page.locator('.packages-success-card').getAttribute('data-receipt');
  expect(receipt).toMatch(/^\.claude\/rundock\/receipts\//);
  expect(await fileExists(page, receipt)).toBe(true);
});

test('cancel from the offer writes nothing at all', async ({ page }) => {
  await boot(page);
  const source = await seedPackage(page, 'pkg-cancel', [
    ['.claude/agents/cancel-scribe.md', AGENT],
  ]);
  await openPackages(page);
  await page.fill('#packages-source-path', source);
  await page.getByRole('button', { name: 'Read it' }).click();
  await expect(page.locator('.packages-confirm-card')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('#packages-source-path')).toBeVisible();
  expect(await fileExists(page, '.claude/agents/cancel-scribe.md')).toBe(false);
});

test('a collision disables confirm and says each item needs its own decision', async ({ page }) => {
  await boot(page);
  await seedPackage(page, '.claude/skills/collide-writer', [['SKILL.md', 'existing']]);
  const source = await seedPackage(page, 'pkg-collide', [
    ['.claude/skills/collide-writer/SKILL.md', 'incoming'],
  ]);
  await openPackages(page);
  await page.fill('#packages-source-path', source);
  await page.getByRole('button', { name: 'Read it' }).click();
  const card = page.locator('.packages-confirm-card');
  await expect(card.locator('.packages-collision-note')).toContainText('collide-writer');
  await expect(card.locator('.packages-collision-note')).toContainText('keep-or-replace decision');
  await expect(card.getByRole('button', { name: 'Add to my team' })).toBeDisabled();
  // And the workspace copy survives untouched.
  await page.getByRole('button', { name: 'Cancel' }).click();
  const kept = await page.request.get('/api/file?path=' + encodeURIComponent('.claude/skills/collide-writer/SKILL.md'));
  expect(await kept.text()).toContain('existing');
});
