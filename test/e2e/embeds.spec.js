'use strict';
// E2E for embeds, shape A, against the real server.
//
// A note with a line of three `![[file.csv]]` embeds shows three views side
// by side, each the installed fixture extension mounted on its own file and
// handed that file's text and nothing else. The same file opened directly is
// rendered by the same extension. An embedded view that asks to open another
// file is refused, and nothing navigates. A line of targets nothing claims
// degrades visibly: text shows as text, a binary shows as a link, and the
// note embedding itself shows as a link rather than recursing.
const base = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const test = base.test;
const { expect } = base;

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
    installedAt: '2026-09-07T00:00:00.000Z', root: '.rundock/extensions/csv-echo',
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
  write(workspace, '.rundock/extensions.json',
    JSON.stringify({ schema: 'rundock.extensions/v1', extensions: [rec] }, null, 2) + '\n');
  write(workspace, '.rundock/extensions/csv-echo/rundock.json',
    JSON.stringify({ name: 'csv-echo', version: '1.0.0', extension: { entry: 'index.js', match: '*.csv' } }));
  write(workspace, '.rundock/extensions/csv-echo/index.js', ENTRY);
}


const FILES = {
  'embed-a.csv': 'k,v\na,1\n',
  'embed-b.csv': 'k,v\nb,2\n',
  'embed-c.csv': 'k,v\nc,3\n',
  'embed-notes.txt': 'plain text, shown as it is\n',
  'embed-statement.pdf': '%PDF-1.4 not really\n',
};
const DASHBOARD = '# Dashboard\n\n![[embed-a.csv]] ![[embed-b.csv]] ![[embed-c.csv]]\n\n![[embed-notes.txt]] ![[embed-statement.pdf]] ![[embed-dashboard]]\n';

test('three embeds render three views side by side, each with only its own file, read-only, and what nothing claims degrades visibly', async ({ page }) => {
  await boot(page);
  const workspace = await workspaceDir(page);
  for (const [rel, text] of Object.entries(FILES)) write(workspace, rel, text);
  write(workspace, 'embed-dashboard.md', DASHBOARD);
  writeStore(workspace, record());
  await page.reload();
  await boot(page);
  await expect.poll(() => page.evaluate(() => !!(cachedFileTree && JSON.stringify(cachedFileTree).includes('embed-dashboard.md')))).toBe(true);
  await page.evaluate(() => openWorkspaceFilePath('embed-dashboard.md'));
  await expect.poll(() => page.evaluate(() => currentFilePath)).toBe('embed-dashboard.md');

  const rows = page.locator('#tiptap-editor-pane .embed-row');
  await expect(rows).toHaveCount(2);
  const frames = rows.nth(0).locator('iframe.extension-frame');
  await expect(frames).toHaveCount(3);
  // Each view was handed exactly its own file.
  for (const [i, rel] of ['embed-a.csv', 'embed-b.csv', 'embed-c.csv'].entries()) {
    const echo = page.frameLocator(`#tiptap-editor-pane .embed-row:first-child .embed-panel:nth-child(${i + 1}) iframe.extension-frame`).locator('#echo');
    await expect(echo).toHaveText(FILES[rel].trim());
  }
  // An embedded view asking to open another file is refused: nothing moves.
  await page.waitForTimeout(6000);
  await page.frameLocator('#tiptap-editor-pane .embed-row:first-child .embed-panel:nth-child(1) iframe.extension-frame').locator('#open-sibling').click();
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => currentFilePath)).toBe('embed-dashboard.md');

  // The second line: nothing claims these.
  const second = rows.nth(1).locator('.embed-panel');
  await expect(second).toHaveCount(3);
  await expect(second.nth(0).locator('pre')).toHaveText(FILES['embed-notes.txt'].trim());
  await expect(second.nth(1).locator('.embed-link')).toHaveText('Open embed-statement.pdf');
  await expect(second.nth(2).locator('.embed-note')).toContainText('embeds itself');
  await expect(second.nth(2).locator('iframe')).toHaveCount(0);

  // The same file opened directly renders through the same extension.
  await page.evaluate(() => openWorkspaceFilePath('embed-a.csv'));
  await expect(page.locator('#editor-content iframe.extension-frame')).toBeVisible();
  await expect(page.frameLocator('#editor-content iframe.extension-frame').locator('#echo')).toHaveText(FILES['embed-a.csv'].trim());
});
