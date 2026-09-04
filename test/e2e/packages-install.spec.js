'use strict';
// E2E for the Packages install flow against the real server. A plan is only
// requested on submit, an apply only on confirm, cancel writes nothing, and
// a completed apply lands the agents, the skills and the receipt on disk.
// A collision opens the review with skip preselected in both themes,
// overwrite is a deliberate switch, a blocked row offers only skipping, and
// a workspace that moves mid-review voids every decision.
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
      const el = document.getElementById('packages-source-path');
      return !!(el && el.offsetParent !== null);
    }),
    { message: 'the packages field is on screen after asking for it' },
  ).toBe(true);
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
  await expect(page.locator('.packages-part-dest').nth(0)).toHaveText('.claude/agents/happy-scribe.md');
  await expect(page.locator('.packages-part-dest').nth(1)).toHaveText('.claude/skills/happy-writer');
  expect(await fileExists(page, '.claude/agents/happy-scribe.md')).toBe(true);
  expect(await fileExists(page, '.claude/skills/happy-writer/SKILL.md')).toBe(true);
  const receipt = await page.locator('.packages-success-card').getAttribute('data-receipt');
  expect(receipt).toMatch(/^\.claude\/rundock\/receipts\//);
  expect(await fileExists(page, receipt)).toBe(true);
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
  const source = await seedPackage(page, 'pkg-cancel', [
    ['.claude/agents/cancel-scribe.md', AGENT],
  ]);
  await openPackages(page);
  const before = claudeTree(workspace);
  await page.fill('#packages-source-path', source);
  await page.getByRole('button', { name: 'Read it' }).click();
  await expect(page.locator('.packages-confirm-card')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('#packages-source-path')).toBeVisible();
  // Every path and every byte under .claude, unchanged: a receipt, a journal,
  // an empty destination directory or a touched file all fail here.
  expect(claudeTree(workspace)).toEqual(before);
});

test('with the socket closed, nothing is sent and the flow stays usable', async ({ page }) => {
  await boot(page);
  const source = await seedPackage(page, 'pkg-offline', [['.claude/agents/offline-scribe.md', AGENT]]);
  await openPackages(page);
  await page.fill('#packages-source-path', source);
  await page.evaluate(() => ws.close());
  await page.getByRole('button', { name: 'Read it' }).click();
  await expect(page.locator('.packages-field-error')).toContainText('Not connected: nothing was sent');
  await expect(page.locator('#packages-source-path')).toBeEnabled();
  expect(await fileExists(page, '.claude/agents/offline-scribe.md')).toBe(false);
});

test('switching workspace returns the flow to idle, discarding the previous plan', async ({ page }) => {
  await boot(page);
  const source = await seedPackage(page, 'pkg-switch', [['.claude/agents/switch-scribe.md', AGENT]]);
  await openPackages(page);
  await page.fill('#packages-source-path', source);
  await page.getByRole('button', { name: 'Read it' }).click();
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
    await expect(page.locator('#packages-source-path')).toHaveValue('');
    await expect(page.locator('.packages-confirm-card')).toHaveCount(0);
  } finally {
    await page.evaluate((dir) => ws.send(JSON.stringify({ type: 'set_workspace', path: dir })), original);
    await expect.poll(() => page.evaluate(() => currentWorkspacePath)).toBe(original);
  }
});

test('a connection lost mid-wait ends the wait and re-enables the flow', async ({ page }) => {
  await boot(page);
  const source = await seedPackage(page, 'pkg-midwait', [['.claude/agents/midwait-scribe.md', AGENT]]);
  await openPackages(page);
  await page.fill('#packages-source-path', source);
  // Send for real, then cut the socket before handling any reply.
  await page.evaluate(() => { ws.onmessage = null; });
  await page.getByRole('button', { name: 'Read it' }).click();
  await page.evaluate(() => ws.close());
  const failed = page.locator('.packages-failed');
  await expect(failed.locator('.packages-body')).toContainText('connection dropped before an answer arrived');
  await expect(failed.getByRole('button', { name: 'Review the package again' })).toBeVisible();
});

test('with the socket closed at confirm, nothing is applied and the flow stays usable', async ({ page }) => {
  await boot(page);
  const source = await seedPackage(page, 'pkg-offline-confirm', [['.claude/agents/offline-confirm-scribe.md', AGENT]]);
  await openPackages(page);
  await page.fill('#packages-source-path', source);
  await page.getByRole('button', { name: 'Read it' }).click();
  await expect(page.locator('.packages-confirm-card')).toBeVisible();
  await page.evaluate(() => ws.close());
  await page.locator('.packages-confirm-card').getByRole('button', { name: 'Add to my team' }).click();
  await expect(page.locator('.packages-field-error')).toContainText('Not connected: nothing was sent');
  await expect(page.locator('#packages-source-path')).toBeEnabled();
  expect(await fileExists(page, '.claude/agents/offline-confirm-scribe.md')).toBe(false);
});

test('a refusal from the real server renders the failure card, not a spinner', async ({ page }) => {
  await boot(page);
  const source = await seedPackage(page, 'pkg-refused', [['.claude/skills/Bad Name/SKILL.md', 'x']]);
  await openPackages(page);
  await page.fill('#packages-source-path', source);
  await page.getByRole('button', { name: 'Read it' }).click();
  const failed = page.locator('.packages-failed');
  await expect(failed.locator('.packages-headline')).toHaveText("That didn't work");
  await expect(failed.locator('.packages-body')).toContainText('not a canonical skill name');
});

// The review surface: collisions are visible and individually decided, skip
// preselected, and the confirm label says exactly what pressing it does.
test('a collision opens the review with skip preselected, in both themes, and skip keeps yours', async ({ page }) => {
  await boot(page);
  await seedPackage(page, '.claude/skills/collide-writer', [['SKILL.md', 'existing']]);
  const source = await seedPackage(page, 'pkg-collide', [
    ['.claude/skills/collide-writer/SKILL.md', 'incoming'],
  ]);
  await openPackages(page);
  await page.fill('#packages-source-path', source);
  await page.getByRole('button', { name: 'Read it' }).click();
  const card = page.locator('.packages-review-card');
  await expect(card.locator('.packages-headline')).toHaveText('Review this package');
  const row = card.locator('[data-item="skill:collide-writer"]');
  await expect(row).toHaveAttribute('data-row', 'collision');
  await expect(row.locator('.packages-dt-selected')).toHaveText(/Skip: keep yours/);
  await expect(card.locator('.packages-confirm')).toHaveText('Skip 1, nothing added');
  // The same card in the other theme: the review renders whole either way.
  // Toggling text alone would pass with every colour the new CSS rules
  // reach for undefined in one theme, since an undefined custom property
  // inherits rather than erroring; read the tokens themselves too, on both
  // sides of the toggle, so a token missing from one theme fails here.
  const tokensDefined = () => page.evaluate(() => ['--danger', '--attention', '--success', '--accent-glow']
    .map((t) => getComputedStyle(document.body).getPropertyValue(t).trim()));
  await expect.poll(tokensDefined).not.toContain('');
  await page.evaluate(() => toggleTheme());
  await expect(card.locator('.packages-headline')).toHaveText('Review this package');
  await expect(row.locator('.packages-dt-selected')).toHaveText(/Skip: keep yours/);
  await expect.poll(tokensDefined).not.toContain('');
  await page.evaluate(() => toggleTheme());
  // Confirming an untouched review keeps what the person already has.
  await card.locator('.packages-confirm').click();
  await expect(page.locator('.packages-success-card .packages-headline')).toHaveText('Nothing was added');
  const kept = await page.request.get('/api/file?path=' + encodeURIComponent('.claude/skills/collide-writer/SKILL.md'));
  expect(await kept.text()).toContain('existing');
});

test('overwrite is a deliberate switch, and the confirm label follows it', async ({ page }) => {
  await boot(page);
  await seedPackage(page, '.claude/skills/switch-writer', [['SKILL.md', 'existing']]);
  const source = await seedPackage(page, 'pkg-switch-decide', [
    ['.claude/skills/switch-writer/SKILL.md', 'incoming'],
  ]);
  await openPackages(page);
  await page.fill('#packages-source-path', source);
  await page.getByRole('button', { name: 'Read it' }).click();
  const row = page.locator('[data-item="skill:switch-writer"]');
  await row.getByRole('button', { name: /Overwrite: replace what you have/ }).click();
  await expect(row.locator('.packages-dt-selected')).toHaveText(/Overwrite/);
  const confirm = page.locator('.packages-review-card .packages-confirm');
  await expect(confirm).toHaveText('Overwrite 1');
  await confirm.click();
  await expect(page.locator('.packages-success-card .packages-headline')).toHaveText('Added to your team');
  const replaced = await page.request.get('/api/file?path=' + encodeURIComponent('.claude/skills/switch-writer/SKILL.md'));
  expect(await replaced.text()).toContain('incoming');
});

test('a blocked row offers skipping and nothing else, and skipping clears it', async ({ page }) => {
  await boot(page);
  // The workspace's default agent is no part of the import; overwriting the
  // colliding agent would make a second default.
  await seedPackage(page, '.claude/agents', [['blocked-coach.md', '---\nname: blocked-coach\norder: 0\n---\n\nC.\n']]);
  await seedPackage(page, '.claude/agents', [['blocked-helper.md', '---\nname: blocked-helper\n---\n\nOld.\n']]);
  const source = await seedPackage(page, 'pkg-blocked', [
    ['.claude/agents/blocked-helper.md', '---\nname: blocked-helper\norder: 0\n---\n\nNew default.\n'],
  ]);
  await openPackages(page);
  await page.fill('#packages-source-path', source);
  await page.getByRole('button', { name: 'Read it' }).click();
  const row = page.locator('[data-item="agent:blocked-helper"]');
  await expect(row).toHaveAttribute('data-row', 'collision');
  await row.getByRole('button', { name: /Overwrite: replace what you have/ }).click();
  await expect(row).toHaveAttribute('data-row', 'blocked');
  await expect(row.locator('.packages-blocked-note')).toContainText('second default agent');
  await expect(row.locator('.packages-dt-blocked')).toBeDisabled();
  await expect(page.locator('.packages-review-card .packages-confirm')).toContainText('blocked');
  // The one way out is skipping, and it clears the conflict in place.
  await row.getByRole('button', { name: 'Skip this item' }).click();
  await expect(row).toHaveAttribute('data-row', 'collision');
  await expect(page.locator('.packages-review-card .packages-confirm')).toHaveText('Skip 1, nothing added');
});

test('a workspace that moves mid-review voids every decision, with danger weight and a re-plan', async ({ page }) => {
  await boot(page);
  const workspace = await page.evaluate(() => currentWorkspacePath);
  await seedPackage(page, '.claude/skills/stale-writer', [['SKILL.md', 'existing']]);
  const source = await seedPackage(page, 'pkg-stale', [
    ['.claude/skills/stale-writer/SKILL.md', 'incoming'],
  ]);
  await openPackages(page);
  await page.fill('#packages-source-path', source);
  await page.getByRole('button', { name: 'Read it' }).click();
  await expect(page.locator('.packages-review-card')).toBeVisible();
  // The workspace changes under the review; the next projection says stale.
  fs.writeFileSync(path.join(workspace, '.claude/skills/stale-writer/SKILL.md'), 'moved under you');
  const row = page.locator('[data-item="skill:stale-writer"]');
  await row.getByRole('button', { name: /Overwrite: replace what you have/ }).click();
  const stale = page.locator('.packages-stale-card');
  await expect(stale).toHaveAttribute('data-tone', 'danger');
  await expect(stale.locator('.packages-stale-headline')).toHaveText('Your workspace changed');
  await expect(stale.locator('.packages-stale-body')).toContainText('discarded and nothing was written');
  await stale.getByRole('button', { name: 'Re-plan' }).click();
  // The re-plan reads the moved workspace and the review reopens against it.
  await expect(page.locator('.packages-review-card')).toBeVisible();
});

test('a mixed package renders the will-add and skipped-new rows against the real server', async ({ page }) => {
  await boot(page);
  await seedPackage(page, '.claude/skills/mixed-writer', [['SKILL.md', 'existing']]);
  const source = await seedPackage(page, 'pkg-mixed', [
    ['.claude/skills/mixed-writer/SKILL.md', 'incoming'],
    ['.claude/skills/mixed-fresh/SKILL.md', 'brand new'],
  ]);
  await openPackages(page);
  await page.fill('#packages-source-path', source);
  await page.getByRole('button', { name: 'Read it' }).click();
  const freshRow = page.locator('[data-item="skill:mixed-fresh"]');
  await expect(freshRow).toHaveAttribute('data-row', 'willAdd');
  await expect(freshRow.locator('.packages-ready-mark')).toHaveText('Will add');
  // No control on this card can reach the skipped-new row yet (setDecision
  // accepts 'skip' on a non-colliding item, but no button here sends it),
  // per the recorded scope note beside setDecision in the model. Driving the
  // model function directly still exercises the real evaluate round trip
  // and the real renderer, which is what this row needs proving against.
  await page.evaluate(() => packagesSetDecision('skill:mixed-fresh', 'skip'));
  await expect(freshRow).toHaveAttribute('data-row', 'skippedNew');
  await expect(freshRow.locator('.packages-skip-mark')).toHaveText('Will skip');
  await freshRow.getByRole('button', { name: 'Add it back' }).click();
  await expect(freshRow).toHaveAttribute('data-row', 'willAdd');
});
