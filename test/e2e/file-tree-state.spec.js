'use strict';
// The file tree must not fight the user while an agent works.
//
// renderFileTree rebuilds the DOM from scratch on every file_tree push, and
// the client asks for one after every file-writing tool call and every agent
// turn. Identical data therefore collapsed every folder, losing any folder the
// user had opened and any wikilink reveal. Two guards: skip the render when
// nothing changed, and remember expand state for the renders that remain.
const { test, expect } = require('@playwright/test');

async function openFiles(page) {
  await page.goto('/');
  await expect(page.locator('.convo-item').first()).toBeVisible();
  await page.locator('.nav-item[data-nav="files"]').click();
  await expect(page.locator('.folder-item').first()).toBeVisible();
}

/** Ask the server for the tree again, the way an agent turn does. */
async function refreshTree(page) {
  // Top-level `let` in a classic script lives in the global lexical scope:
  // not a property of window, but a bare reference still resolves here.
  await page.evaluate(() => ws.send(JSON.stringify({ type: 'get_files' })));
  await page.waitForTimeout(250);
}

test('an expanded folder stays expanded when the tree is pushed again', async ({ page }) => {
  await openFiles(page);

  const folder = page.locator('.folder-item', { hasText: 'notes' }).first();
  await folder.click();
  const children = page.locator('.file-children:not(.collapsed)').first();
  await expect(children).toBeVisible();

  await refreshTree(page);

  await expect(page.locator('.file-children:not(.collapsed)').first()).toBeVisible();
});

test('an unchanged tree is not re-rendered at all', async ({ page }) => {
  await openFiles(page);
  await page.locator('.folder-item', { hasText: 'notes' }).first().click();

  // Tag the live DOM node. A re-render replaces it, so the tag surviving is
  // proof no render happened, which is stronger than checking it looks right.
  await page.evaluate(() => {
    document.querySelector('#file-tree .folder-item').dataset.survivedRender = 'yes';
  });

  await refreshTree(page);

  const survived = await page.evaluate(() =>
    document.querySelector('#file-tree .folder-item')?.dataset.survivedRender);
  expect(survived).toBe('yes');
});

test('a genuinely changed tree still re-renders and shows the new file', async ({ page }) => {
  await openFiles(page);
  const before = await page.locator('.file-item').count();

  await page.evaluate(() => ws.send(JSON.stringify({
    type: 'create_path', path: 'tree-state-probe.md', kind: 'note',
  })));
  await page.waitForTimeout(600);

  await expect(page.locator('.file-item', { hasText: 'tree-state-probe' })).toHaveCount(1);
  expect(await page.locator('.file-item').count()).toBeGreaterThan(before);
});
