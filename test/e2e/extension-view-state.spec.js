'use strict';
// Extension view state in the real app: a real
// sandboxed frame, the real host, the real page seam and the real server,
// with the state read off disk.
//
// Three extensions are written into the e2e server's temporary workspace the
// way the install flow writes them, each claiming markdown notes by its own
// frontmatter marker. `state-a` and `state-b` share one entry: it records
// what `Rundock.viewState.get('k')` answered on its first line, shows the
// `init` it was handed, draws a Rundock UI table with `stateKey`, and shows
// any refusal. `state-quiet` never touches view state.

const { test, expect } = require('@playwright/test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

test.use({ viewport: { width: 1400, height: 900 } });

const ENTRY = [
  'window.__first = Rundock.viewState.get("k");',
  "window.addEventListener('message', function (e) {",
  '  if (e.source !== parent || !e.data) return;',
  '  var d = e.data;',
  "  if (d.type === 'init') {",
  "    document.body.textContent = '';",
  "    var seen = document.createElement('pre'); seen.id = 'seen';",
  '    seen.textContent = JSON.stringify({ first: window.__first === undefined ? null : window.__first, init: d.state });',
  '    document.body.appendChild(seen);',
  "    var table = Rundock.ui.table({ resizable: true, stateKey: 'positions', caption: 'Positions',",
  "      columns: [{ key: 'holding', label: 'Holding' }, { key: 'account', label: 'Account' }, { key: 'units', label: 'Units', numeric: true }],",
  "      rows: [{ holding: 'CRWD', account: 'Taxable', units: 120 }] });",
  "    table.id = 'table'; document.body.appendChild(table);",
  "    var refused = document.createElement('p'); refused.id = 'refused'; document.body.appendChild(refused);",
  "    parent.postMessage({ type: 'resize', height: 400 }, '*');",
  '  }',
  "  if (d.type === 'refused') document.getElementById('refused').textContent = d.of + ': ' + d.reason;",
  '});',
  "parent.postMessage({ type: 'ready' }, '*');",
].join('\n');

const QUIET = [
  "window.addEventListener('message', function (e) {",
  "  if (e.source === parent && e.data && e.data.type === 'init') { document.body.textContent = ''; var p = document.createElement('p'); p.id = 'seen'; p.textContent = 'quiet'; document.body.appendChild(p); }",
  '});',
  "parent.postMessage({ type: 'ready' }, '*');",
].join('\n');

const EXTENSIONS = [{ name: 'state-a', entry: ENTRY }, { name: 'state-b', entry: ENTRY }, { name: 'state-quiet', entry: QUIET }];

function write(workspace, rel, content) {
  const absolute = path.join(workspace, rel);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}
const note = (marker, title) => `---\n${marker}: true\n---\n# ${title}\n`;
const stateFolder = (extension) => path.join(workspace, '.rundock', 'extension-state', extension);
const stateFile = (extension, rel) => path.join(stateFolder(extension), `${crypto.createHash('sha256').update(rel).digest('hex')}.json`);
const stored = (extension, rel) => {
  try { return JSON.parse(fs.readFileSync(stateFile(extension, rel), 'utf8')).state; } catch (e) { return null; }
};
const listing = () => {
  const root = path.join(workspace, '.rundock', 'extension-state');
  return fs.existsSync(root) ? fs.readdirSync(root, { recursive: true }).map(String).sort() : [];
};

let workspace = null;
async function setUp(page) {
  await page.goto('/');
  await expect(page.locator('.convo-item').first()).toBeVisible();
  workspace = await page.evaluate(() => currentWorkspacePath);
  fs.rmSync(path.join(workspace, '.rundock', 'extension-state'), { recursive: true, force: true });
  fs.rmSync(path.join(workspace, 'state'), { recursive: true, force: true });
  write(workspace, '.rundock/extensions.json', JSON.stringify({ schema: 'rundock.extensions/v1', extensions: EXTENSIONS.map(({ name }) => ({
    name, version: '1.0.0', entry: 'index.js', match: '*.md', declares: name,
    source: { url: `https://github.com/example/${name}`, reference: 'v1.0.0' },
    installedAt: '2026-09-25T00:00:00.000Z', root: `.rundock/extensions/${name}`,
  })) }, null, 2) + '\n');
  for (const { name, entry } of EXTENSIONS) {
    write(workspace, `.rundock/extensions/${name}/rundock.json`, JSON.stringify({ name, version: '1.0.0', extension: { entry: 'index.js', match: '*.md', declares: name } }));
    write(workspace, `.rundock/extensions/${name}/index.js`, entry);
  }
  write(workspace, 'state/Plain.md', '# Plain\n');
  await page.reload();
  await expect(page.locator('.convo-item').first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const r = window.rundockRendererRegistry;
    return r ? r.rendererFor('state/x.md', '---\nstate-a: true\n---\n').registered : null;
  })).toBe(true);
}

test.afterAll(() => {
  if (!workspace) return;
  fs.rmSync(path.join(workspace, '.rundock', 'extensions.json'), { force: true });
  for (const { name } of EXTENSIONS) fs.rmSync(path.join(workspace, '.rundock', 'extensions', name), { recursive: true, force: true });
  fs.rmSync(path.join(workspace, '.rundock', 'extension-state'), { recursive: true, force: true });
  fs.rmSync(path.join(workspace, 'state'), { recursive: true, force: true });
});

const FRAME = '#editor-content > iframe.extension-frame';
async function open(page, rel, content) {
  if (content !== undefined) write(workspace, rel, content);
  await page.evaluate((f) => window.openWorkspaceFilePath(f), rel);
  await expect.poll(() => page.evaluate(() => currentFilePath)).toBe(rel);
}
async function openView(page, rel, content) {
  await open(page, rel, content);
  await expect(page.locator(FRAME)).toHaveCount(1);
  const view = page.frameLocator(FRAME);
  await expect(view.locator('#seen')).toHaveCount(1);
  return view;
}
const seen = async (view) => JSON.parse(await view.locator('#seen').textContent());
const inFrame = (view, fn, arg) => view.locator('body').evaluate(fn, arg);

test.describe('view state through a real mount', () => {
  test('get answers on the entry\'s first line, and a write lands in the mounted pair\'s file, never in the note', async ({ page }) => {
    await setUp(page);
    const noteText = note('state-a', 'A');
    const view = await openView(page, 'state/A.md', noteText);
    expect(await seen(view)).toEqual({ first: null, init: null });
    await inFrame(view, (body) => body.ownerDocument.defaultView.Rundock.viewState.set('k', 'a-value'));
    // A frame that names another extension, note and file on the message:
    // none of it is read.
    await inFrame(view, (body) => body.ownerDocument.defaultView.parent.postMessage({
      type: 'setState', state: { k: 'forged' }, extension: 'state-b', path: 'state/B.md', file: '../../escape.json',
    }, '*'));
    await expect.poll(() => stored('state-a', 'state/A.md')).toEqual({ k: 'forged' });
    expect(listing()).toEqual(['state-a', path.join('state-a', path.basename(stateFile('state-a', 'state/A.md')))]);
    expect(fs.readFileSync(path.join(workspace, 'state/A.md'), 'utf8')).toBe(noteText);
    expect(fs.existsSync(path.join(workspace, 'escape.json'))).toBe(false);

    await open(page, 'state/Plain.md');
    const again = await openView(page, 'state/A.md');
    expect(await seen(again)).toEqual({ first: 'forged', init: { k: 'forged' } });
  });

  test('two extensions on two notes each read back only their own', async ({ page }) => {
    await setUp(page);
    const a = await openView(page, 'state/A.md', note('state-a', 'A'));
    await inFrame(a, (body) => body.ownerDocument.defaultView.Rundock.viewState.set('k', 'from-a'));
    await open(page, 'state/Plain.md');
    const b = await openView(page, 'state/B.md', note('state-b', 'B'));
    expect(await seen(b)).toEqual({ first: null, init: null });
    await inFrame(b, (body) => body.ownerDocument.defaultView.Rundock.viewState.set('k', 'from-b'));
    await open(page, 'state/Plain.md');
    await expect.poll(() => [stored('state-a', 'state/A.md'), stored('state-b', 'state/B.md')]).toEqual([{ k: 'from-a' }, { k: 'from-b' }]);
    expect(stored('state-b', 'state/A.md')).toBe(null);
    expect(stored('state-a', 'state/B.md')).toBe(null);
    expect((await seen(await openView(page, 'state/A.md'))).init).toEqual({ k: 'from-a' });
    await open(page, 'state/Plain.md');
    expect((await seen(await openView(page, 'state/B.md'))).init).toEqual({ k: 'from-b' });
  });

  test('a burst of sets writes once, and opening another file inside the pause still writes the last', async ({ page }) => {
    await setUp(page);
    const view = await openView(page, 'state/A.md', note('state-a', 'A'));
    await page.evaluate(() => {
      window.__stateWrites = [];
      const send = ws.send.bind(ws);
      ws.send = (m) => { try { const d = JSON.parse(m); if (d.type === 'set_view_state') window.__stateWrites.push(d.state); } catch (e) { /* not ours */ } return send(m); };
    });
    await inFrame(view, (body) => { const vs = body.ownerDocument.defaultView.Rundock.viewState; for (let i = 0; i < 50; i += 1) vs.set('n', i); });
    await expect.poll(() => stored('state-a', 'state/A.md')).toEqual({ n: 49 });
    await page.waitForTimeout(800);
    expect(await page.evaluate(() => window.__stateWrites)).toEqual([{ n: 49 }]);
    await inFrame(view, (body) => body.ownerDocument.defaultView.Rundock.viewState.set('n', 'last'));
    await open(page, 'state/Plain.md');
    await expect.poll(() => stored('state-a', 'state/A.md')).toEqual({ n: 'last' });
  });

  test('a Date is refused by name before it leaves the page, and the view keeps its own copy', async ({ page }) => {
    await setUp(page);
    const view = await openView(page, 'state/A.md', note('state-a', 'A'));
    const kept = await inFrame(view, (body) => {
      const vs = body.ownerDocument.defaultView.Rundock.viewState;
      vs.set('settings', { since: new Date(0) });
      return vs.get('settings').since instanceof body.ownerDocument.defaultView.Date;
    });
    expect(kept).toBe(true);
    await expect(view.locator('#refused')).toHaveText('setState: the view state is not plain JSON: a Date at settings.since');
    await open(page, 'state/Plain.md');
    expect(listing()).toEqual([]);
  });

  test('an embedded view reads its state and every write from it is refused, with nothing written', async ({ page }) => {
    await setUp(page);
    const view = await openView(page, 'state/A.md', note('state-a', 'A'));
    await inFrame(view, (body) => body.ownerDocument.defaultView.Rundock.viewState.set('k', 'kept'));
    await open(page, 'state/Plain.md');
    await expect.poll(() => stored('state-a', 'state/A.md')).toEqual({ k: 'kept' });
    const before = fs.readFileSync(stateFile('state-a', 'state/A.md'), 'utf8');
    // An embed resolves its name against the tree the page holds when it is
    // drawn, so wait for the tree that has the note this test wrote.
    await expect.poll(() => page.evaluate(() => !!cachedFileTree
      && findFileInTree(cachedFileTree, window.RundockEmbedModel.searchName('A.md'), 'state/Host.md') === 'state/A.md')).toBe(true);
    await open(page, 'state/Host.md', '# Host\n\n![[A.md]]\n');
    const embedded = page.frameLocator('.embed-panel iframe.extension-frame');
    await expect(embedded.locator('#seen')).toHaveCount(1, { timeout: 10_000 });
    expect(await seen(embedded)).toEqual({ first: 'kept', init: { k: 'kept' } });
    await inFrame(embedded, (body) => body.ownerDocument.defaultView.Rundock.viewState.set('k', 'from-embed'));
    await expect(embedded.locator('#refused')).toHaveText('setState: an embedded view cannot keep view state; open this file to change it');
    await page.waitForTimeout(800);
    expect(fs.readFileSync(stateFile('state-a', 'state/A.md'), 'utf8')).toBe(before);
  });

  test('a resized column opens at its width after a remount, and a reset puts it back to the rule', async ({ page }) => {
    await setUp(page);
    let view = await openView(page, 'state/A.md', note('state-a', 'A'));
    const handle = () => view.locator('#table .rui-col-resize').nth(1);
    // The width by the rule, once the table has measured it.
    await expect.poll(async () => Number(await handle().getAttribute('aria-valuenow'))).toBeGreaterThan(0);
    const rule = Number(await handle().getAttribute('aria-valuenow'));
    await handle().focus();
    for (let i = 0; i < 4; i += 1) await handle().press('Shift+ArrowRight');
    const widened = Number(await handle().getAttribute('aria-valuenow'));
    expect(widened).toBeGreaterThan(rule);
    await open(page, 'state/Plain.md');
    await expect.poll(() => stored('state-a', 'state/A.md')).toEqual({ 'rui.table.positions': { account: widened } });
    view = await openView(page, 'state/A.md');
    await expect.poll(async () => Number(await handle().getAttribute('aria-valuenow'))).toBe(widened);
    await handle().focus();
    await handle().press('Enter');
    await open(page, 'state/Plain.md');
    await expect.poll(() => fs.existsSync(stateFile('state-a', 'state/A.md'))).toBe(false);
    view = await openView(page, 'state/A.md');
    await expect.poll(async () => Number(await handle().getAttribute('aria-valuenow'))).toBe(rule);
  });

  test('a kept width below the column\'s header opens at the header', async ({ page }) => {
    await setUp(page);
    write(workspace, 'state/A.md', note('state-a', 'A'));
    fs.mkdirSync(stateFolder('state-a'), { recursive: true });
    fs.writeFileSync(stateFile('state-a', 'state/A.md'), JSON.stringify({ path: 'state/A.md', state: { 'rui.table.positions': { account: 2 } }, updatedAt: '2026-09-25T00:00:00.000Z' }));
    const view = await openView(page, 'state/A.md');
    const handle = view.locator('#table .rui-col-resize').nth(1);
    // The floor is measured from the header once the table is laid out, so
    // the width and the floor are read together, never the floor ahead of it.
    const pair = async () => [Number(await handle.getAttribute('aria-valuenow')), Number(await handle.getAttribute('aria-valuemin'))];
    await expect.poll(async () => { const [now, min] = await pair(); return min > 2 && now === min; }).toBe(true);
    const [now, min] = await pair();
    expect(now).toBe(min);
    expect(min).toBeGreaterThan(2);
  });

  test('two mounts of one note in turn, and a fresh mount reads the second write', async ({ page }) => {
    await setUp(page);
    let view = await openView(page, 'state/A.md', note('state-a', 'A'));
    await inFrame(view, (body) => body.ownerDocument.defaultView.Rundock.viewState.set('k', 'first'));
    await open(page, 'state/Plain.md');
    view = await openView(page, 'state/A.md');
    await inFrame(view, (body) => body.ownerDocument.defaultView.Rundock.viewState.set('k', 'second'));
    await open(page, 'state/Plain.md');
    view = await openView(page, 'state/A.md');
    expect((await seen(view)).init).toEqual({ k: 'second' });
  });

  test('a view that never uses view state leaves no state behind', async ({ page }) => {
    await setUp(page);
    await openView(page, 'state/Quiet.md', note('state-quiet', 'Quiet'));
    await open(page, 'state/Plain.md');
    await page.waitForTimeout(800);
    expect(listing()).toEqual([]);
  });

  test('a renamed note starts afresh, and its old state stays until uninstall', async ({ page }) => {
    await setUp(page);
    const view = await openView(page, 'state/A.md', note('state-a', 'A'));
    await inFrame(view, (body) => body.ownerDocument.defaultView.Rundock.viewState.set('k', 'old name'));
    await open(page, 'state/Plain.md');
    await expect.poll(() => stored('state-a', 'state/A.md')).toEqual({ k: 'old name' });
    fs.renameSync(path.join(workspace, 'state/A.md'), path.join(workspace, 'state/Renamed.md'));
    const renamed = await openView(page, 'state/Renamed.md');
    expect(await seen(renamed)).toEqual({ first: null, init: null });
    expect(stored('state-a', 'state/A.md')).toEqual({ k: 'old name' });
  });
});
