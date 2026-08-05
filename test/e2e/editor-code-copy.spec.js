'use strict';
// E2E: the copy control on code blocks in the file view editor.
//
// Chat has had one since 0.10.0; the editor did not, so getting a snippet out
// of a note meant hand-selecting inside a contentEditable.
//
// Browser-driven for two reasons. The control is injected as a ProseMirror
// widget decoration, so it only exists once a real editor has mounted and
// rendered. And the assertion that actually matters is about SAVING: this
// editor round-trips markdown byte-exactly, so the one way this feature could
// do real damage is by leaking its own markup into the document. That is
// checked here by comparing what was loaded against what would be written.
const { test, expect } = require('@playwright/test');

async function openCodeNote(page) {
  await page.goto('/');
  await expect(page.locator('.convo-item').first()).toBeVisible();
  await page.locator('.nav-item[data-nav="files"]').click();
  await page.locator('.file-item', { hasText: 'code-blocks.md' }).first().click();
  await expect(page.locator('.ProseMirror pre').first()).toBeVisible();
}

test('code blocks get a copy control, and inline code does not', async ({ page }) => {
  await openCodeNote(page);

  // Two fences in the fixture: one labelled `js`, one unlabelled. The control
  // must not depend on a language being present.
  await expect(page.locator('.ProseMirror pre')).toHaveCount(2);
  await expect(page.locator('.ProseMirror pre .editor-copy-code-btn')).toHaveCount(2);

  // Inline code is a mark, not a block, and must be left alone.
  const inlineButtons = await page.evaluate(() => {
    const inline = [...document.querySelectorAll('.ProseMirror code')]
      .filter((c) => !c.closest('pre'));
    return {
      inlineCount: inline.length,
      withButtons: inline.filter((c) => c.querySelector('.editor-copy-code-btn')).length,
    };
  });
  expect(inlineButtons.inlineCount).toBeGreaterThan(0);
  expect(inlineButtons.withButtons).toBe(0);
});

test('the control copies the fence contents, without the backtick markers', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await openCodeNote(page);

  const firstPre = page.locator('.ProseMirror pre').first();
  await firstPre.hover();
  await firstPre.locator('.editor-copy-code-btn').click();

  // The button confirms visually, which is the part a user relies on.
  await expect(firstPre.locator('.editor-copy-code-btn.copied')).toBeVisible();

  const copied = await page.evaluate(() => navigator.clipboard.readText());
  // The fence's contents, and nothing else: no ``` markers, no language label.
  expect(copied).toBe('const total = 4471;\nconsole.log(total);');
  expect(copied).not.toContain('```');
  expect(copied).not.toContain('js');
});

test('the injected control never becomes document content', async ({ page }) => {
  await openCodeNote(page);

  // rawFileContent is what was read from disk; currentLiveContent() is exactly
  // what a save would write. If the widget had leaked into the document, the
  // serialisation would differ from the source.
  const r = await page.evaluate(() => ({
    loaded: rawFileContent,
    wouldSave: currentLiveContent(),
  }));

  expect(r.wouldSave).toBe(r.loaded);
  expect(r.wouldSave).not.toContain('editor-copy-code-btn');
  expect(r.wouldSave).not.toContain('<button');
  expect(r.wouldSave).not.toContain('<svg');
  // And the fences themselves survived intact.
  expect(r.wouldSave).toContain('```js\nconst total = 4471;');
});

test('the control survives an edit, and still does not leak', async ({ page }) => {
  await openCodeNote(page);

  // Decorations are rebuilt on every document change. An edit is where a
  // naive implementation duplicates or drops them.
  await page.locator('.ProseMirror p').first().click();
  await page.keyboard.type(' edited');

  await expect(page.locator('.ProseMirror pre .editor-copy-code-btn')).toHaveCount(2);

  const wouldSave = await page.evaluate(() => currentLiveContent());
  expect(wouldSave).not.toContain('editor-copy-code-btn');
  expect(wouldSave).toContain(' edited');
  expect(wouldSave).toContain('```js\nconst total = 4471;');
});
