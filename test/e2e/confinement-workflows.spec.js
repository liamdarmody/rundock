'use strict';
// Extension confinement in the REAL app (browser mode, with the app page's
// own frame policy): the workflows the confinement must leave working,
// and hidden files a writing extension claims by type.
//
// Every destination is a receiver this spec opens on 127.0.0.1. Benign
// extensions only, written into the e2e launcher's disposable workspace and
// removed after each test.

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

let cleanup = [];
test.afterEach(() => { for (const fn of cleanup.splice(0)) { try { fn(); } catch (e) { /* best effort */ } } });

async function boot(page) {
  await page.goto('/');
  await expect(page.locator('.convo-item').first()).toBeVisible();
}
const workspaceOf = (page) => page.evaluate(() => currentWorkspacePath);
function write(ws, rel, text) {
  fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
  fs.writeFileSync(path.join(ws, rel), text);
  cleanup.push(() => fs.rmSync(path.join(ws, rel), { force: true }));
}

// A link that opens OUTSIDE the app: a new page (the system browser, in the
// desktop app, through its window-open handler), with the app page left where
// it was and the receiver reached.
async function opensOutside(page, click, route) {
  const appUrl = page.url();
  const [popup] = await Promise.all([page.context().waitForEvent('page'), click()]);
  await popup.waitForLoadState();
  expect(popup.url()).toBe(`${receiver.url}${route}`);
  expect(page.url(), 'the app page did not navigate').toBe(appUrl);
  expect(receiver.hits).toContain(route);
  await popup.close();
}

test.describe('what the confinement leaves working', () => {
  test('a web link in a conversation opens outside the app', async ({ page }) => {
    await boot(page);
    await page.locator('.convo-item').first().click();
    await expect(page.locator('#view-chat')).toBeVisible();
    await page.evaluate((url) => addAgentMsg(`Read [the outside page](${url}/convo-link).`, 'wren'), receiver.url);
    await opensOutside(page, () => page.locator('#messages a', { hasText: 'the outside page' }).click(), '/convo-link');
  });

  test('a web link in a note opens outside the app', async ({ page }) => {
    await boot(page);
    const ws = await workspaceOf(page);
    write(ws, 'outside-link.md', `# Outside\n\nRead [the outside page](${receiver.url}/note-link).\n`);
    await page.locator('.nav-item[data-nav="files"]').click();
    const row = page.locator('.file-item', { hasText: 'outside-link.md' }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();
    await expect(page.locator('.ProseMirror a', { hasText: 'the outside page' })).toBeVisible();
    await opensOutside(page, () => page.locator('.ProseMirror a', { hasText: 'the outside page' }).click(), '/note-link');
  });
});

test.describe('a writing extension claiming a type never reaches its hidden files', () => {
  const CANARY = 'CANARY-NOT-A-REAL-KEY';
  const ENTRY = [
    "var pre = document.createElement('pre'); pre.id = 'seen'; document.body.appendChild(pre); var seen = [];",
    "window.addEventListener('message', function (e) { seen.push(e.data); pre.textContent = JSON.stringify(seen);",
    "  if (e.data && e.data.type === 'init') parent.postMessage({ type: 'save', content: 'PWNED ' + e.data.path }, '*'); });",
    "parent.postMessage({ type: 'ready' }, '*');",
  ].join('\n');

  function installWriters(ws) {
    const rec = (name, match) => ({
      name, version: '1.0.0', entry: 'index.js', match, writes: true, root: `.rundock/extensions/${name}`,
      source: { url: `https://github.com/example/${name}`, reference: 'v1.0.0' }, installedAt: '2026-09-23T00:00:00.000Z',
    });
    write(ws, '.rundock/extensions.json', JSON.stringify({ schema: 'rundock.extensions/v1', extensions: [rec('md-writer', '*.md'), rec('json-writer', '*.json')] }) + '\n');
    for (const [name, match] of [['md-writer', '*.md'], ['json-writer', '*.json']]) {
      write(ws, `.rundock/extensions/${name}/rundock.json`, JSON.stringify({ name, version: '1.0.0', extension: { entry: 'index.js', match, writes: true } }));
      write(ws, `.rundock/extensions/${name}/index.js`, ENTRY);
      cleanup.push(() => fs.rmSync(path.join(ws, '.rundock', 'extensions', name), { recursive: true, force: true }));
    }
  }

  test('an agent file and .mcp.json are never mounted, never handed over, and a save to either changes no byte', async ({ page }) => {
    await boot(page);
    const ws = await workspaceOf(page);
    const agentFile = path.join(ws, '.claude', 'agents', 'wren.md');
    const mcp = path.join(ws, '.mcp.json');
    const mcpBefore = fs.existsSync(mcp) ? fs.readFileSync(mcp) : null;
    fs.writeFileSync(mcp, JSON.stringify({ mcpServers: { x: { env: { API_KEY: CANARY } } } }));
    cleanup.push(() => { if (mcpBefore === null) fs.rmSync(mcp, { force: true }); else fs.writeFileSync(mcp, mcpBefore); });
    const agentBefore = fs.readFileSync(agentFile);
    const mcpNow = fs.readFileSync(mcp);
    installWriters(ws);
    write(ws, 'plain-note.md', '# Plain\n');
    await page.reload();
    await boot(page);

    // The instrument: an ordinary .md IS mounted and IS handed over, so the
    // writer is really claiming the type.
    await page.evaluate(() => openWorkspaceFilePath('plain-note.md'));
    await expect(page.locator('#editor-content iframe.extension-frame')).toBeVisible();

    for (const rel of ['.claude/agents/wren.md', '.mcp.json']) {
      await page.evaluate((p) => openWorkspaceFilePath(p), rel);
      await expect.poll(() => page.evaluate(() => currentFilePath)).toBe(rel);
      await page.waitForTimeout(800);
      await expect(page.locator('#editor-content iframe.extension-frame'), `${rel} is not mounted`).toHaveCount(0);
      const frames = await page.evaluate(() => [...document.querySelectorAll('iframe')].map((f) => f.getAttribute('srcdoc') || ''));
      for (const text of frames) {
        expect(text).not.toContain(CANARY);
        expect(text).not.toContain('name: wren');
      }
    }
    // The one way an extension's bytes reach a file: a save it caused. Sent
    // to the server exactly as the page sends one, for each hidden file.
    await page.evaluate(() => {
      for (const p of ['.claude/agents/wren.md', '.mcp.json']) ws.send(JSON.stringify({ type: 'save_file', path: p, content: 'PWNED', origin: 'extension' }));
    });
    await page.waitForTimeout(800);
    expect(fs.readFileSync(agentFile).equals(agentBefore), 'the agent file is byte for byte unchanged').toBe(true);
    expect(fs.readFileSync(mcp).equals(mcpNow), '.mcp.json is byte for byte unchanged').toBe(true);
  });
});
