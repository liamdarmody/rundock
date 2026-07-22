'use strict';
// E2E: the floating toolbar's "Text" block-type dropdown.
//
// Browser-driven because it exercises real selection, the menu open/close, the
// Tiptap block transforms, and the dropdown label tracking the active block.
const { test, expect } = require('@playwright/test');

async function openNote(page, name) {
  await page.goto('/');
  await expect(page.locator('.convo-item').first()).toBeVisible();
  await page.locator('.nav-item[data-nav="files"]').click();
  await page.locator('.file-item', { hasText: name }).first().click();
  await expect(page.locator('.ProseMirror').first()).toBeVisible();
}

// Triple-click the block containing `needle` (revealing the toolbar), open the
// dropdown, and pick a block type.
async function transform(page, needle, cmd) {
  await page.locator('.ProseMirror').getByText(needle, { exact: false }).first().click({ clickCount: 3 });
  await expect(page.locator('#tiptap-toolbar.visible')).toBeVisible();
  await page.locator('#tiptap-toolbar .tb-dd').click();
  await expect(page.locator('#tiptap-toolbar .tb-menu.open')).toBeVisible();
  await page.locator(`#tiptap-toolbar .tb-menu-item[data-cmd="${cmd}"]`).click();
}

test('the "Text" dropdown transforms a paragraph into lists and headings, and reflects the active block', async ({ page }) => {
  await openNote(page, 'Roadmap-2026.md');
  const NEEDLE = 'Quarterly targets';
  const label = page.locator('#tiptap-toolbar .tb-dd-label');

  // A paragraph reads as "Text"; the dropdown offers all seven block types.
  await page.locator('.ProseMirror p', { hasText: NEEDLE }).first().click({ clickCount: 3 });
  await expect(page.locator('#tiptap-toolbar.visible')).toBeVisible();
  await expect(label).toHaveText('Text');
  await page.locator('#tiptap-toolbar .tb-dd').click();
  await expect(page.locator('#tiptap-toolbar .tb-menu-item')).toHaveCount(7);
  await page.locator('#tiptap-toolbar .tb-menu-item[data-cmd="bulletList"]').click();
  await expect(page.locator('.ProseMirror ul li')).toHaveCount(1);
  await expect(label).toHaveText('Bullet list');

  // "Text" unwraps the list back to a paragraph.
  await transform(page, NEEDLE, 'paragraph');
  await expect(page.locator('.ProseMirror ul')).toHaveCount(0);
  await expect(label).toHaveText('Text');

  // The checkbox path (the discoverability motivator): Text -> Checklist.
  await transform(page, NEEDLE, 'taskList');
  await expect(page.locator('.ProseMirror input[type="checkbox"]')).toHaveCount(1);
  await expect(label).toHaveText('Checklist');

  // And a heading, from a clean paragraph.
  await transform(page, NEEDLE, 'paragraph');
  await transform(page, NEEDLE, 'h2');
  await expect(page.locator('.ProseMirror h2')).toHaveCount(1);
  await expect(label).toHaveText('Heading 2');
});

test('a checklist item lays out the checkbox and its text on the same line (not stacked)', async ({ page }) => {
  await openNote(page, 'Roadmap-2026.md');
  const NEEDLE = 'Quarterly targets';

  await transform(page, NEEDLE, 'taskList');
  // The TaskItem nodeView builds the <li> programmatically (no data-type on the
  // li), so anchor on the taskList container instead.
  const checkbox = page.locator('.ProseMirror ul[data-type="taskList"] > li input[type="checkbox"]');
  const content = page.locator('.ProseMirror ul[data-type="taskList"] > li > div');
  await expect(checkbox).toHaveCount(1);
  await expect(content).toHaveCount(1);

  const box = await checkbox.boundingBox();
  const txt = await content.boundingBox();

  // Same line: their vertical spans overlap (the text does not start below the
  // checkbox). If the layout stacks, txt.y would sit at/after the checkbox's
  // bottom edge and this overlap check fails.
  const overlap = Math.min(box.y + box.height, txt.y + txt.height) - Math.max(box.y, txt.y);
  expect(overlap).toBeGreaterThan(0);
  // And the checkbox sits to the LEFT of the text, not above it.
  expect(box.x + box.width).toBeLessThanOrEqual(txt.x + 1);
});
