'use strict';
// A mounted, writable extension view while its file and the page change
// under it, in the real app.
//
// Two extensions are written into the e2e server's own temporary workspace,
// the way the install flow writes them: both claim markdown notes by a
// frontmatter marker and declare writes. Their entry is the same editing
// view, except that `live-note` says `ready` with `handles: ['theme']` and
// `rebuild-note` says a plain `ready`. The view holds what the person types
// until they press Save, so an edit in it is unsaved until then.
//
//   - A theme flip restyles a live `live-note` frame in place: the same frame
//     and document, the unsaved edit still there, the palette now the light
//     one, and Save then writes the edit that survived.
//   - The same flip rebuilds a `rebuild-note` frame, and the unsaved edit is
//     gone: the behaviour the `theme` message exists to replace, kept for a
//     view that has not said it handles it.
//   - A note whose marker is written out, by the view itself or on disk,
//     releases the mount onto the plain surface, naming why.

const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

test.use({ viewport: { width: 1400, height: 900 } });

const ENTRY = (handles) => [
  'window.__born = Math.random();',
  "window.addEventListener('message', function (e) {",
  '  if (e.source !== parent || !e.data) return;',
  '  var d = e.data;',
  "  if (d.type === 'init') {",
  '    var ui = window.Rundock.ui;',
  "    document.body.textContent = '';",
  "    var box = document.createElement('textarea'); box.id = 'buffer'; box.value = d.content;",
  "    box.style.color = 'var(--text-1)'; box.style.background = 'var(--surface)';",
  '    document.body.appendChild(box);',
  "    var save = ui.button({ label: 'Save', variant: 'primary', onClick: function () { parent.postMessage({ type: 'save', content: box.value }, '*'); } });",
  "    save.id = 'save';",
  "    var unmark = ui.button({ label: 'Unmark', onClick: function () { parent.postMessage({ type: 'change', content: box.value.replace(/^[a-z-]+: true\\n/m, '') }, '*'); } });",
  "    unmark.id = 'unmark';",
  '    document.body.appendChild(save); document.body.appendChild(unmark);',
  "    var tabs = ui.tabs({ label: 'View', options: ['Board', 'Table'], value: 'Table' }); tabs.id = 'tabs'; document.body.appendChild(tabs);",
  "    var t = document.createElement('p'); t.id = 'theme'; t.textContent = d.theme; document.body.appendChild(t);",
  "    parent.postMessage({ type: 'resize', height: 300 }, '*');",
  '  }',
  "  if (d.type === 'theme') document.getElementById('theme').textContent = d.theme;",
  '});',
  `parent.postMessage(${handles ? "{ type: 'ready', handles: ['theme'] }" : "{ type: 'ready' }"}, '*');`,
].join('\n');

const EXTENSIONS = [
  { name: 'live-note', handles: true },
  { name: 'rebuild-note', handles: false },
];

function write(workspace, rel, content) {
  const absolute = path.join(workspace, rel);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

const note = (marker) => `---\n${marker}: true\ntitle: Live\n---\nFirst line.\n`;

let workspace = null;
async function setUp(page) {
  await page.goto('/');
  await expect(page.locator('.convo-item').first()).toBeVisible();
  workspace = await page.evaluate(() => currentWorkspacePath);
  write(workspace, '.rundock/extensions.json', JSON.stringify({ schema: 'rundock.extensions/v1', extensions: EXTENSIONS.map(({ name }) => ({
    name, version: '1.0.0', entry: 'index.js', match: '*.md', writes: true, declares: name,
    source: { url: `https://github.com/example/${name}`, reference: 'v1.0.0' },
    installedAt: '2026-09-24T00:00:00.000Z', root: `.rundock/extensions/${name}`,
  })) }, null, 2) + '\n');
  for (const { name, handles } of EXTENSIONS) {
    write(workspace, `.rundock/extensions/${name}/rundock.json`, JSON.stringify({ name, version: '1.0.0', extension: { entry: 'index.js', match: '*.md', declares: name, writes: true } }));
    write(workspace, `.rundock/extensions/${name}/index.js`, ENTRY(handles));
  }
  await page.reload();
  await expect(page.locator('.convo-item').first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const r = window.rundockRendererRegistry;
    return r ? r.rendererFor('live/x.md', '---\nlive-note: true\n---\n').registered : null;
  })).toBe(true);
}

test.afterAll(() => {
  // Leave the shared workspace as other specs expect it: no record claims .md.
  if (!workspace) return;
  fs.rmSync(path.join(workspace, '.rundock', 'extensions.json'), { force: true });
  for (const { name } of EXTENSIONS) fs.rmSync(path.join(workspace, '.rundock', 'extensions', name), { recursive: true, force: true });
  fs.rmSync(path.join(workspace, 'live'), { recursive: true, force: true });
});

async function setTheme(page, theme) {
  const light = await page.evaluate(() => document.body.classList.contains('light'));
  if ((theme === 'light') !== light) await page.evaluate(() => window.toggleTheme());
  await expect.poll(() => page.evaluate(() => document.body.classList.contains('light'))).toBe(theme === 'light');
}

async function openNote(page, rel, content) {
  write(workspace, rel, content);
  await page.evaluate((f) => window.openWorkspaceFilePath(f), rel);
  await expect(page.locator('#editor-content > iframe.extension-frame')).toHaveCount(1);
  const view = page.frameLocator('#editor-content > iframe.extension-frame');
  await expect(view.locator('#buffer')).toHaveValue(content);
  return view;
}

// What the frame's document shows, read inside it.
const INSIDE = (body) => {
  const w = body.ownerDocument.defaultView;
  const box = body.ownerDocument.getElementById('buffer');
  const plain = body.ownerDocument.getElementById('unmark');
  return {
    born: w.__born,
    light: body.classList.contains('light'),
    bodyBg: w.getComputedStyle(body).backgroundColor,
    boxBg: w.getComputedStyle(box).backgroundColor,
    uiBg: w.getComputedStyle(plain).backgroundColor,
  };
};

test.describe('a theme flip under a writable view', () => {
  test.afterEach(async ({ page }) => { await setTheme(page, 'dark'); });

  test('a view that handles theme is restyled in place and keeps its unsaved edit, which Save then writes', async ({ page }) => {
    await setUp(page);
    await setTheme(page, 'dark');
    const view = await openNote(page, 'live/Live note.md', note('live-note'));
    const frameBefore = await page.locator('#editor-content > iframe.extension-frame').elementHandle();
    await view.locator('#buffer').fill(`${note('live-note')}An edit not yet saved.\n`);
    const before = await view.locator('body').evaluate(INSIDE);
    expect(before.light).toBe(false);

    await setTheme(page, 'light');
    await expect(view.locator('#theme')).toHaveText('light');
    // Rundock UI's controls transition their colours; read once they settle.
    await expect.poll(() => view.locator('body').evaluate((b) => b.ownerDocument.getAnimations().length)).toBe(0);
    const after = await view.locator('body').evaluate(INSIDE);

    expect(await page.locator('#editor-content > iframe.extension-frame').count()).toBe(1);
    expect(await frameBefore.evaluate((f) => f.isConnected), 'the same frame element is still mounted').toBe(true);
    expect(after.born, 'the same document: the view was not rebooted').toBe(before.born);
    await expect(view.locator('#buffer'), 'the unsaved edit survived the flip').toHaveValue(`${note('live-note')}An edit not yet saved.\n`);
    expect(after.light, 'the frame shows the light theme').toBe(true);
    expect(after.boxBg, 'the view\'s own var() styles follow').not.toBe(before.boxBg);
    expect(after.bodyBg, 'the floor follows').not.toBe(before.bodyBg);
    expect(after.uiBg, 'Rundock UI follows').not.toBe(before.uiBg);
    await view.locator('#save').click();
    await expect.poll(() => fs.readFileSync(path.join(workspace, 'live/Live note.md'), 'utf8'))
      .toBe(`${note('live-note')}An edit not yet saved.\n`);

    // The oracle for the palette: the same view built fresh in the light
    // theme. What the restyle painted in place is exactly what a new frame
    // paints, for the floor, the view's own styles and Rundock UI.
    const fresh = await openNote(page, 'live/Fresh light note.md', note('live-note'));
    const built = await fresh.locator('body').evaluate(INSIDE);
    expect(built.light).toBe(true);
    expect({ bodyBg: after.bodyBg, boxBg: after.boxBg, uiBg: after.uiBg })
      .toEqual({ bodyBg: built.bodyBg, boxBg: built.boxBg, uiBg: built.uiBg });
  });

  test('a selected tab restyled in place from light to dark matches the same tab built fresh in dark', async ({ page }) => {
    await setUp(page);
    await setTheme(page, 'light');
    const view = await openNote(page, 'live/Tabs note.md', note('live-note'));
    const SELECTED = (list) => {
      const w = list.ownerDocument.defaultView;
      const tab = list.querySelector('.rui-tab.rui-selected');
      const cs = w.getComputedStyle(tab);
      return { text: tab.textContent, bg: cs.backgroundColor, color: cs.color, border: cs.borderTopColor };
    };
    const inLight = await view.locator('#tabs').evaluate(SELECTED);
    expect(inLight.text).toBe('Table');

    await setTheme(page, 'dark');
    await expect(view.locator('#theme')).toHaveText('dark');
    await expect.poll(() => view.locator('body').evaluate((b) => b.ownerDocument.getAnimations().length)).toBe(0);
    const restyled = await view.locator('#tabs').evaluate(SELECTED);
    expect(restyled.bg, 'the selected tab left its light fill').not.toBe(inLight.bg);

    const fresh = await openNote(page, 'live/Tabs fresh dark note.md', note('live-note'));
    await expect.poll(() => fresh.locator('body').evaluate((b) => b.ownerDocument.getAnimations().length)).toBe(0);
    const built = await fresh.locator('#tabs').evaluate(SELECTED);
    expect(restyled, 'what the restyle painted is what a fresh dark frame paints').toEqual(built);
  });

  test('a view that has not said it handles theme is rebuilt, and its unsaved edit is lost', async ({ page }) => {
    await setUp(page);
    await setTheme(page, 'dark');
    const view = await openNote(page, 'live/Rebuild note.md', note('rebuild-note'));
    await view.locator('#buffer').fill(`${note('rebuild-note')}An edit not yet saved.\n`);
    const before = await view.locator('body').evaluate(INSIDE);

    await setTheme(page, 'light');
    await expect(view.locator('#theme')).toHaveText('light');
    const after = await view.locator('body').evaluate(INSIDE);
    expect(after.born, 'a new document: the frame was rebuilt').not.toBe(before.born);
    await expect(view.locator('#buffer'), 'the rebuilt view starts again from the file').toHaveValue(note('rebuild-note'));
  });
});

test.describe('a file that stops claiming its extension releases the mount', () => {
  test('the view writes the marker out: the mount is released onto the plain editor, naming why', async ({ page }) => {
    await setUp(page);
    const view = await openNote(page, 'live/Unmarked by the view.md', note('live-note'));
    await view.locator('#unmark').click();
    await expect.poll(() => fs.readFileSync(path.join(workspace, 'live/Unmarked by the view.md'), 'utf8')).toBe('---\ntitle: Live\n---\nFirst line.\n');
    await expect(page.locator('#editor-content > iframe.extension-frame')).toHaveCount(0);
    await expect(page.locator('#editor-content')).not.toHaveClass(/extension-pane/);
    await expect(page.locator('#tiptap-editor-pane:not(.hidden) .ProseMirror')).toContainText('First line.');
    await expect(page.locator('#editor-status')).toHaveText(/stood down: this file no longer claims the extension "live-note"/);
    expect(await page.evaluate(() => mountedExtension())).toBe(null);
  });

  test('the marker is edited out on disk: the mount is released onto the plain editor', async ({ page }) => {
    await setUp(page);
    await openNote(page, 'live/Unmarked on disk.md', note('live-note'));
    write(workspace, 'live/Unmarked on disk.md', '---\ntitle: plain now\n---\nFirst line.\n');
    await expect(page.locator('#editor-content > iframe.extension-frame')).toHaveCount(0);
    await expect(page.locator('#tiptap-editor-pane:not(.hidden) .ProseMirror')).toContainText('First line.');
    expect(await page.evaluate(() => mountedExtension())).toBe(null);
  });
});
