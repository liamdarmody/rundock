'use strict';
// E2E for the Packages install flow: the PL4 states against the real server.
// A plan is only requested on submit, an apply only on confirm, cancel writes
// nothing, a collision disables the confirm with its stated copy, and a
// completed apply lands the agents, the skills and the receipt on disk.
//
// The link field is the only way in, and the server fetches with real git:
// each spec seeds a git repository beside the workspace under a fixture
// organisation that test/e2e/serve.js points git at, so the whole acquire
// path runs unchanged with no network.
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

async function boot(page) {
  await page.goto('/');
  await expect(page.locator('.convo-item').first()).toBeVisible();
}

// ASKING ONCE IS NOT ENOUGH RIGHT AFTER A WORKSPACE SWITCH. The switch
// announces itself to every window, and that announcement redraws the shell.
// A single showView() racing that redraw can be undone by it, leaving the
// field present in the page but not on screen, which is what a plain
// toBeVisible then waits seven seconds to discover. Asking again each time
// the poll runs costs nothing when the view is already right and removes the
// race when it is not.
async function openPackages(page) {
  await expect.poll(
    () => page.evaluate(() => {
      showView('settings');
      showSettingsSection('packages');
      const el = document.getElementById('packages-source-link');
      return !!(el && el.offsetParent !== null);
    }),
    { message: 'the packages field is on screen after asking for it' },
  ).toBe(true);
  await expect(page.locator('#packages-source-link')).toBeVisible();
}

// Seed files from the test process, because the product's own create paths
// rightly refuse dot segments. Reads still go through the server, so what
// the assertions see is server truth.
async function seedFiles(page, dir, files) {
  const workspace = await page.evaluate(() => currentWorkspacePath);
  for (const [rel, content] of files) {
    const absolute = path.join(workspace, dir, rel);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  }
  return path.join(workspace, dir);
}

// A package as a tagged git repository under the fixture organisation, and
// the link the field takes for it.
async function seedRepo(page, name, files) {
  const workspace = await page.evaluate(() => currentWorkspacePath);
  const dir = path.join(workspace, '..', 'repos', name);
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [rel, content] of files) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  const git = (...args) => execFileSync('git', ['-c', 'user.email=e2e@example.com', '-c', 'user.name=e2e', ...args], { cwd: dir, stdio: 'ignore' });
  git('init', '--quiet');
  git('add', '.');
  git('commit', '--quiet', '-m', 'package');
  git('tag', 'v1.0.0');
  return `e2e-fixture/${name}`;
}

// Paste the link, pin it when asked to, and read it.
async function readLink(page, link, reference = '') {
  await page.fill('#packages-source-link', link);
  await page.fill('#packages-source-ref', reference);
  await page.getByRole('button', { name: 'Read it' }).click();
}

async function fileExists(page, rel) {
  const response = await page.request.get('/api/file?path=' + encodeURIComponent(rel));
  return response.ok();
}

const AGENT = '---\nname: scribe\n---\n\nWrite things.\n';

test('plan, confirm and apply land the package with its receipt', async ({ page }) => {
  await boot(page);
  const link = await seedRepo(page, 'pkg-happy', [
    ['.claude/agents/happy-scribe.md', AGENT],
    ['.claude/skills/happy-writer/SKILL.md', 'the skill'],
  ]);
  await openPackages(page);
  await readLink(page, link, 'v1.0.0');
  const card = page.locator('.packages-confirm-card');
  await expect(card.locator('.packages-headline')).toHaveText("This isn't a Rundock package");
  await expect(card.locator('.packages-body')).toContainText('1 agent and 1 skill');
  await expect(card.locator('.packages-body')).toContainText("They're not sandboxed");
  await card.getByRole('button', { name: 'Add to my team' }).click();
  await expect(page.locator('.packages-success-card .packages-headline')).toHaveText('Added to your team');
  await expect(page.locator('.packages-part')).toHaveCount(2);
  await expect(page.locator('.packages-part-dest').nth(0)).toHaveText('.claude/agents/happy-scribe.md');
  await expect(page.locator('.packages-part-dest').nth(1)).toHaveText('.claude/skills/happy-writer');
  expect(await fileExists(page, '.claude/agents/happy-scribe.md')).toBe(true);
  expect(await fileExists(page, '.claude/skills/happy-writer/SKILL.md')).toBe(true);
  const receipt = await page.locator('.packages-success-card').getAttribute('data-receipt');
  expect(receipt).toMatch(/^\.claude\/rundock\/receipts\//);
  expect(await fileExists(page, receipt)).toBe(true);
  const written = JSON.parse(await (await page.request.get('/api/file?path=' + encodeURIComponent(receipt))).text());
  expect(written.source).toEqual({ id: 'https://github.com/e2e-fixture/pkg-happy', reference: 'v1.0.0' },
    'the receipt names the link and the pin it was read at');
});

// The complete .claude subtree as one comparable value, read directly.
function claudeTree(workspace) {
  const result = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name);
      const rel = path.relative(workspace, absolute).split(path.sep).join('/');
      if (entry.isDirectory()) { result.push(`${rel}/`); walk(absolute); }
      else result.push(`${rel}:${fs.readFileSync(absolute).toString('base64')}`);
    }
  };
  walk(path.join(workspace, '.claude'));
  return result;
}

test('cancel leaves the workspace byte-identical', async ({ page }) => {
  await boot(page);
  const workspace = await page.evaluate(() => currentWorkspacePath);
  const link = await seedRepo(page, 'pkg-cancel', [
    ['.claude/agents/cancel-scribe.md', AGENT],
  ]);
  await openPackages(page);
  const before = claudeTree(workspace);
  await readLink(page, link);
  await expect(page.locator('.packages-confirm-card')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('#packages-source-link')).toBeVisible();
  // Every path and every byte under .claude, unchanged: a receipt, a journal,
  // an empty destination directory or a touched file all fail here.
  expect(claudeTree(workspace)).toEqual(before);
});

test('with the socket closed, nothing is sent and the flow stays usable', async ({ page }) => {
  await boot(page);
  const link = await seedRepo(page, 'pkg-offline', [['.claude/agents/offline-scribe.md', AGENT]]);
  await openPackages(page);
  await page.fill('#packages-source-link', link);
  await page.evaluate(() => ws.close());
  await page.getByRole('button', { name: 'Read it' }).click();
  await expect(page.locator('.packages-field-error')).toContainText('Not connected: nothing was sent');
  await expect(page.locator('#packages-source-link')).toBeEnabled();
  expect(await fileExists(page, '.claude/agents/offline-scribe.md')).toBe(false);
});

test('switching workspace returns the flow to idle, discarding the previous plan', async ({ page }) => {
  await boot(page);
  const link = await seedRepo(page, 'pkg-switch', [['.claude/agents/switch-scribe.md', AGENT]]);
  await openPackages(page);
  await readLink(page, link);
  await expect(page.locator('.packages-confirm-card')).toBeVisible();
  // A second workspace, made real on disk, opened through the real path.
  const original = await page.evaluate(() => currentWorkspacePath);
  const other = original + '-b';
  fs.mkdirSync(other, { recursive: true });
  // THE SERVER IS SHARED, SO THE HANDBACK CANNOT BE AN ORDINARY LAST LINE.
  // This moves the one server every spec in this run talks to. If an
  // assertion below fails before the handback, every later spec boots into
  // the empty second workspace, finds no conversations, and fails waiting for
  // a row that will never render: one flake reported as a hundred, with the
  // real one buried at the top. The handback belongs in a finally, so a
  // failure here stays a failure here.
  try {
    await page.evaluate((dir) => ws.send(JSON.stringify({ type: 'set_workspace', path: dir })), other);
    await expect.poll(() => page.evaluate(() => currentWorkspacePath)).toBe(other);
    await openPackages(page);
    await expect(page.locator('#packages-source-link')).toHaveValue('');
    await expect(page.locator('.packages-confirm-card')).toHaveCount(0);
  } finally {
    await page.evaluate((dir) => ws.send(JSON.stringify({ type: 'set_workspace', path: dir })), original);
    await expect.poll(() => page.evaluate(() => currentWorkspacePath)).toBe(original);
  }
});

test('a connection lost mid-wait ends the wait and re-enables the flow', async ({ page }) => {
  await boot(page);
  const link = await seedRepo(page, 'pkg-midwait', [['.claude/agents/midwait-scribe.md', AGENT]]);
  await openPackages(page);
  await page.fill('#packages-source-link', link);
  // Send for real, then cut the socket before handling any reply.
  await page.evaluate(() => { ws.onmessage = null; });
  await page.getByRole('button', { name: 'Read it' }).click();
  await page.evaluate(() => ws.close());
  const failed = page.locator('.packages-failed');
  await expect(failed.locator('.packages-body')).toContainText('connection dropped before an answer arrived');
  await expect(failed.getByRole('button', { name: 'Try again' })).toBeVisible();
});

// An open offer is held on the server under a token the connection owns,
// so a dropped socket ends the offer rather than leaving a confirm that
// nothing could answer.
test('with the socket closed at the offer, the offer ends honestly and nothing is applied', async ({ page }) => {
  await boot(page);
  const link = await seedRepo(page, 'pkg-offline-confirm', [['.claude/agents/offline-confirm-scribe.md', AGENT]]);
  await openPackages(page);
  await readLink(page, link);
  await expect(page.locator('.packages-confirm-card')).toBeVisible();
  await page.evaluate(() => ws.close());
  const failed = page.locator('.packages-failed');
  await expect(failed.locator('.packages-body')).toContainText('The connection dropped. Nothing was installed.');
  await expect(failed.getByRole('button', { name: 'Try again' })).toBeVisible();
  expect(await fileExists(page, '.claude/agents/offline-confirm-scribe.md')).toBe(false);
});

test('a refusal from the real server renders the failure card, not a spinner', async ({ page }) => {
  await boot(page);
  const link = await seedRepo(page, 'pkg-refused', [['.claude/skills/Bad Name/SKILL.md', 'x']]);
  await openPackages(page);
  await readLink(page, link);
  const failed = page.locator('.packages-failed');
  await expect(failed.locator('.packages-headline')).toHaveText("That didn't work");
  await expect(failed.locator('.packages-body')).toContainText('not a canonical skill name');
});

test('a collision disables confirm and says each item needs its own decision', async ({ page }) => {
  await boot(page);
  await seedFiles(page, '.claude/skills/collide-writer', [['SKILL.md', 'existing']]);
  const link = await seedRepo(page, 'pkg-collide', [
    ['.claude/skills/collide-writer/SKILL.md', 'incoming'],
  ]);
  await openPackages(page);
  await readLink(page, link);
  const card = page.locator('.packages-confirm-card');
  await expect(card.locator('.packages-collision-note')).toContainText('collide-writer');
  await expect(card.locator('.packages-collision-note')).toContainText('keep-or-replace decision');
  await expect(card.getByRole('button', { name: 'Add to my team' })).toBeDisabled();
  // And the workspace copy survives untouched.
  await page.getByRole('button', { name: 'Cancel' }).click();
  const kept = await page.request.get('/api/file?path=' + encodeURIComponent('.claude/skills/collide-writer/SKILL.md'));
  expect(await kept.text()).toContain('existing');
});
