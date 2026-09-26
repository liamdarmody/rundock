'use strict';
// Named sources and asking an agent in the REAL app, against the real server.
// Benign extensions are written into the e2e launcher's disposable workspace
// the way the install flow writes them (never a hostile fixture); what the
// view received is read from its own record, what was written from the disk,
// and what was sent from the socket's own frames.

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

// The e2e workspace is shared by every spec file, so what these tests install
// and create is removed after each one: a later spec opening a .csv or a .md
// must see the workspace it expects, not an extension claiming it.
let installedIn = null;
test.afterEach(() => {
  if (!installedIn) return;
  for (const rel of ['.rundock/extensions.json', '.rundock/extensions/dash-view', '.rundock/extensions/csv-asker',
    'dash.md', 'ask.csv', 'notes/a.csv', 'notes/b.csv', 'notes/unnamed.csv', 'stub-prompts.jsonl']) {
    fs.rmSync(path.join(installedIn, rel), { recursive: true, force: true });
  }
  installedIn = null;
});

// A view that writes every message it is ever sent into #seen, and offers
// buttons that write a source, ask Wren, and nothing else.
const ENTRY = [
  'var seen = [];',
  "var pre = document.createElement('pre'); pre.id = 'seen';",
  "window.addEventListener('message', function (e) { seen.push(e.data); pre.textContent = JSON.stringify(seen); });",
  "document.body.innerHTML = '<button id=\"save\">save</button><button id=\"ask\">ask</button>';",
  'document.body.appendChild(pre);',
  "var RLO = String.fromCharCode(0x202e); var ZWSP = String.fromCharCode(0x200b);",
  "document.getElementById('save').onclick = function () { parent.postMessage({ type: 'saveSource', source: 'notes/a.csv', content: 'VIEW-EDIT\\n' }, '*'); };",
  "document.getElementById('ask').onclick = function () { parent.postMessage({ type: 'ask', agent: 'wren', message: 'Summarise' + RLO + ' the ' + ZWSP + 'risk' }, '*'); };",
  "parent.postMessage({ type: 'ready' }, '*');",
].join('\n');

function write(workspace, rel, content) {
  const absolute = path.join(workspace, rel);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

function installView(workspace, { name, match, declares, sources, writes, asks }) {
  installedIn = workspace;
  const extension = { entry: 'index.js', match, ...(declares ? { declares } : {}), ...(sources ? { sources: true } : {}), ...(writes ? { writes: true } : {}), ...(asks ? { asks } : {}) };
  const record = {
    name, version: '1.0.0', entry: 'index.js', match, root: `.rundock/extensions/${name}`,
    source: { url: `https://github.com/example/${name}`, reference: 'v1.0.0' }, installedAt: '2026-09-23T00:00:00.000Z',
    ...(declares ? { declares } : {}), ...(sources ? { sources: true } : {}), ...(writes ? { writes: true } : {}), ...(asks ? { asks } : {}),
  };
  write(workspace, '.rundock/extensions.json', JSON.stringify({ schema: 'rundock.extensions/v1', extensions: [record] }, null, 2) + '\n');
  write(workspace, `.rundock/extensions/${name}/rundock.json`, JSON.stringify({ name, version: '1.0.0', extension }));
  write(workspace, `.rundock/extensions/${name}/index.js`, ENTRY);
}

const NOTE = '---\nportfolio-dashboard: true\nsources:\n  - notes/a.csv\n  - notes/b.csv\n---\n# Dashboard\n';

async function boot(page) {
  await page.goto('/');
  await expect(page.locator('.convo-item').first()).toBeVisible();
}
async function openFromTree(page, name) {
  await page.locator('.nav-item[data-nav="files"]').click();
  const row = page.locator('.file-item', { hasText: name }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click();
}
const frame = (page) => page.frameLocator('#editor-content iframe.extension-frame');
async function seen(page) { return JSON.parse((await frame(page).locator('#seen').textContent()) || '[]'); }

async function sourcesWorkspace(page, { sources = true } = {}) {
  await boot(page);
  const workspace = await page.evaluate(() => currentWorkspacePath);
  write(workspace, 'notes/a.csv', 'a,1\n');
  write(workspace, 'notes/b.csv', 'b,1\n');
  write(workspace, 'dash.md', NOTE);
  installView(workspace, { name: 'dash-view', match: '*.md', declares: 'portfolio-dashboard', sources, writes: true });
  await page.reload();
  await boot(page);
  return workspace;
}

test.describe('named sources in the app', () => {
  test('the view is handed the listed files; a changed one, a removed name and a new unnamed file each behave', async ({ page }) => {
    const workspace = await sourcesWorkspace(page);
    await openFromTree(page, 'dash.md');
    await expect.poll(async () => ((await seen(page)).find((m) => m.type === 'init') || {}).sources).toEqual([
      { path: 'notes/a.csv', content: 'a,1\n' }, { path: 'notes/b.csv', content: 'b,1\n' },
    ]);
    fs.writeFileSync(path.join(workspace, 'notes', 'a.csv'), 'a,2\n');
    write(workspace, 'notes/unnamed.csv', 'CANARY-UNNAMED');
    await expect.poll(async () => {
      const updates = (await seen(page)).filter((m) => m.type === 'sources');
      return updates.length ? updates[updates.length - 1].sources[0].content : null;
    }, { timeout: 5000 }).toBe('a,2\n');
    fs.writeFileSync(path.join(workspace, 'dash.md'), NOTE.replace('  - notes/b.csv\n', ''));
    await expect.poll(async () => {
      const msgs = await seen(page);
      return msgs.some((m) => m.type === 'init' && m.sources.length === 1 && m.sources[0].path === 'notes/a.csv');
    }, { timeout: 5000 }).toBe(true);
    expect(JSON.stringify(await seen(page))).not.toContain('CANARY-UNNAMED');
  });

  test('the open file still refreshes from disk while its sources are watched', async ({ page }) => {
    const workspace = await sourcesWorkspace(page);
    await openFromTree(page, 'dash.md');
    await expect.poll(async () => (await seen(page)).some((m) => m.type === 'init')).toBe(true);
    fs.writeFileSync(path.join(workspace, 'dash.md'), NOTE.replace('# Dashboard', '# Dashboard, edited on disk'));
    await expect.poll(async () => (await seen(page)).some((m) => m.type === 'init' && /edited on disk/.test(m.content)), { timeout: 5000 }).toBe(true);
  });

  test('a source edited on disk after mount raises the reload-theirs or keep-mine choice instead of being overwritten', async ({ page }) => {
    const workspace = await sourcesWorkspace(page);
    await openFromTree(page, 'dash.md');
    await expect.poll(async () => (await seen(page)).some((m) => m.type === 'init')).toBe(true);
    // The watch hands the view a changed file within one interval, after
    // which a save is no longer against stale bytes; so the edit and the save
    // race it, and a lost race is simply tried again.
    let raised = false;
    for (let attempt = 0; attempt < 6 && !raised; attempt += 1) {
      fs.writeFileSync(path.join(workspace, 'notes', 'a.csv'), `disk edit ${attempt}\n`);
      await frame(page).locator('#save').click();
      raised = await page.locator('#external-edit-banner').isVisible({ timeout: 1500 }).catch(() => false);
      if (!raised) await page.waitForTimeout(900);
    }
    expect(raised, 'the choice was raised').toBe(true);
    await expect(page.locator('#external-edit-banner')).toContainText('notes/a.csv');
    expect(fs.readFileSync(path.join(workspace, 'notes', 'a.csv'), 'utf8')).toMatch(/^disk edit/);
    await page.locator('#external-edit-banner .banner-btn[data-choice="mine"]').click();
    await expect.poll(() => fs.readFileSync(path.join(workspace, 'notes', 'a.csv'), 'utf8')).toBe('VIEW-EDIT\n');
  });

  test('an extension that did not declare sources, on a marked note that lists files, is handed an empty list', async ({ page }) => {
    await sourcesWorkspace(page, { sources: false });
    await openFromTree(page, 'dash.md');
    await expect.poll(async () => ((await seen(page)).find((m) => m.type === 'init') || {}).sources).toEqual([]);
  });
});

test.describe('asking an agent in the app', () => {
  async function askWorkspace(page, sentFrames) {
    page.on('websocket', (ws) => ws.on('framesent', (f) => { try { sentFrames.push(JSON.parse(f.payload)); } catch (e) {} }));
    await boot(page);
    const workspace = await page.evaluate(() => currentWorkspacePath);
    write(workspace, 'ask.csv', 'x,1\n');
    installView(workspace, { name: 'csv-asker', match: '*.csv', asks: ['wren'] });
    await page.reload();
    await boot(page);
    await openFromTree(page, 'ask.csv');
    await expect(page.locator('#editor-content iframe.extension-frame')).toBeVisible();
    // Past the activation window of the tree click that opened it.
    await page.waitForTimeout(6000);
    return workspace;
  }

  // THE ASK ON RUNDOCK'S BAR. Pressed within seconds of the
  // tree click that opened the file, the view's ask cannot be told apart from
  // that click, so Rundock asks. A press on Open before the bar arms does
  // nothing; one after it drafts exactly that ask into a new conversation,
  // unsent; Dismiss tells the view only that it was refused.
  async function askOnBarInApp(page, sentFrames) {
    page.on('websocket', (ws) => ws.on('framesent', (f) => { try { sentFrames.push(JSON.parse(f.payload)); } catch (e) {} }));
    await boot(page);
    const workspace = await page.evaluate(() => currentWorkspacePath);
    write(workspace, 'ask.csv', 'x,1\n');
    installView(workspace, { name: 'csv-asker', match: '*.csv', asks: ['wren'] });
    await page.reload();
    await boot(page);
    const before = await page.evaluate(() => conversations.length);
    await openFromTree(page, 'ask.csv');
    await expect(page.locator('#editor-content iframe.extension-frame')).toBeVisible();
    await frame(page).locator('#ask').click();
    const bar = page.locator('#editor-content > [data-extension-request="confirm"]');
    await expect(bar).toBeVisible();
    return { workspace, before, bar };
  }

  test('an ask on the bar drafts nothing on an early press, and on an armed press drafts exactly that ask into a new conversation, unsent', async ({ page }) => {
    const sentFrames = [];
    const { before, bar } = await askOnBarInApp(page, sentFrames);
    await expect(bar.locator('.rui-alert-message')).toHaveText(/^Start a conversation with .+ with a drafted message\?$/);
    const open = bar.getByRole('button', { name: 'Open', exact: true });
    const box = await open.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    expect(await open.isDisabled(), 'the early press landed on the unarmed button').toBe(true);
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => conversations.length), 'the early press drafted nothing').toBe(before);
    await expect(bar, 'and the ask is still waiting').toBeVisible();
    await expect(open).toBeEnabled({ timeout: 2000 });
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect.poll(() => page.evaluate(() => activeConversation && activeConversation.agentId)).toBe('wren');
    expect(await page.evaluate(() => conversations.length), 'one new conversation').toBe(before + 1);
    expect(await page.evaluate(() => activeConversation.messages.length), 'a new one, empty').toBe(0);
    await expect(page.locator('#msg-input')).toHaveValue('Summarise the risk');
    await page.waitForTimeout(1500);
    expect(sentFrames.filter((m) => m.type === 'chat'), 'unsent: the socket carried no chat message').toEqual([]);
  });

  test('Dismiss on the ask bar drafts nothing and tells the view only that it was refused', async ({ page }) => {
    const sentFrames = [];
    const { before, bar } = await askOnBarInApp(page, sentFrames);
    await expect(bar.getByRole('button', { name: 'Dismiss', exact: true })).toBeEnabled({ timeout: 2000 });
    const beforeSeen = (await seen(page)).length;
    await bar.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await expect(bar).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => conversations.length)).toBe(before);
    expect((await seen(page)).slice(beforeSeen)).toEqual([{ type: 'refused', of: 'ask', reason: 'you dismissed this in Rundock' }]);
    expect(sentFrames.filter((m) => m.type === 'chat')).toEqual([]);
  });

  test('a click drafts to a NEW conversation with Wren, unsent, cleaned, named; nothing goes back', async ({ page }) => {
    const sentFrames = [];
    const workspace = await askWorkspace(page, sentFrames);
    const before = await page.evaluate(() => conversations.length);
    await frame(page).locator('#ask').click();
    await expect.poll(() => page.evaluate(() => activeConversation && activeConversation.agentId)).toBe('wren');
    expect(await page.evaluate(() => conversations.length), 'one new conversation').toBe(before + 1);
    expect(await page.evaluate(() => activeConversation.messages.length), 'a new one, not an existing one').toBe(0);
    await expect(page.locator('#msg-input')).toHaveValue('Summarise the risk');
    await expect(page.locator('#messages .ask-provenance')).toHaveText('Drafted by the csv-asker extension from ask.csv. Nothing has been sent.');
    await expect(page.locator('#view-chat')).toBeVisible();
    await expect(page.locator('#editor-content .ask-provenance, #editor-content #msg-input')).toHaveCount(0);
    await page.waitForTimeout(2000);
    expect(sentFrames.filter((m) => m.type === 'chat'), 'the socket carried no chat message').toEqual([]);
    // The person sends the draft as it stands: the agent receives exactly the
    // composer text, and never the line that says who drafted it.
    await page.locator('#send-btn').click();
    const promptsFile = path.join(workspace, 'stub-prompts.jsonl');
    await expect.poll(() => (fs.existsSync(promptsFile) ? fs.readFileSync(promptsFile, 'utf8') : ''), { timeout: 15_000 }).toContain('Summarise the risk');
    const prompts = fs.readFileSync(promptsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((p) => p.agent === 'wren');
    const last = prompts[prompts.length - 1].prompt;
    expect(last.endsWith('Summarise the risk'), 'the composer text reaches the agent').toBe(true);
    expect(last).not.toContain('Drafted by');
  });

  test('an ask never discards what the person typed in another conversation and has not sent', async ({ page }) => {
    const sentFrames = [];
    await askWorkspace(page, sentFrames);
    // Type in an existing conversation, unsent.
    await page.locator('.nav-item[data-nav="conversations"]').click();
    await page.locator('.convo-item').first().click();
    const typedIn = await page.evaluate(() => activeConversation.id);
    await page.locator('#msg-input').fill('half a thought, not sent');
    // Back to the view, past the click that opened it, and ask.
    await openFromTree(page, 'ask.csv');
    await expect(page.locator('#editor-content iframe.extension-frame')).toBeVisible();
    await page.waitForTimeout(6000);
    await frame(page).locator('#ask').click();
    await expect.poll(() => page.evaluate(() => activeConversation && activeConversation.agentId)).toBe('wren');
    await expect(page.locator('#msg-input')).toHaveValue('Summarise the risk');
    // Return to the first conversation: its text is intact.
    await page.locator(`.convo-item[data-convo-id="${typedIn}"]`).click();
    await expect(page.locator('#msg-input')).toHaveValue('half a thought, not sent');
    expect(sentFrames.filter((m) => m.type === 'chat')).toEqual([]);
  });

  test('a draft the person never sends leaves no saved conversation behind', async ({ page }) => {
    const sentFrames = [];
    await askWorkspace(page, sentFrames);
    const savedBefore = await page.evaluate(() => conversations.filter((c) => c.agentId === 'wren').map((c) => c.id));
    await frame(page).locator('#ask').click();
    await expect.poll(() => page.evaluate(() => activeConversation && activeConversation.agentId)).toBe('wren');
    const draftId = await page.evaluate(() => activeConversation.id);
    await page.locator('.nav-item[data-nav="files"]').click();
    await page.reload();
    await boot(page);
    const after = await page.evaluate(() => conversations.map((c) => c.id));
    expect(after).not.toContain(draftId);
    expect(await page.evaluate(() => conversations.filter((c) => c.agentId === 'wren').length)).toBe(savedBefore.length);
    expect(sentFrames.filter((m) => m.type === 'save_conversation' && m.conversation && m.conversation.id === draftId)).toEqual([]);
  });
});
