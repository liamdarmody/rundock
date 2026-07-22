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

test('the link button opens an in-UI popover that sets, pre-fills, and removes a link', async ({ page }) => {
  await openNote(page, 'Roadmap-2026.md');
  const NEEDLE = 'Quarterly targets';

  // Select the paragraph text and open the link popover from the toolbar.
  await page.locator('.ProseMirror p', { hasText: NEEDLE }).first().click({ clickCount: 3 });
  await expect(page.locator('#tiptap-toolbar.visible')).toBeVisible();
  const popover = page.locator('#tiptap-toolbar .tb-linkpop');
  const input = page.locator('#tiptap-toolbar .tb-link-input');
  await expect(popover).toBeHidden();
  await page.locator('#tiptap-toolbar .tb-btn[data-cmd="link"]').click();
  await expect(popover).toBeVisible();
  await expect(input).toBeFocused();

  // Type a bare domain and apply with Enter. It is normalised to https:// and
  // the selected text becomes a link; the popover closes.
  await input.fill('rundock.ai');
  await input.press('Enter');
  await expect(popover).toBeHidden();
  const link = page.locator('.ProseMirror a[href="https://rundock.ai"]');
  await expect(link).toHaveCount(1);

  // Reopening on the linked text pre-fills the existing href.
  await link.click({ clickCount: 3 });
  await expect(page.locator('#tiptap-toolbar.visible')).toBeVisible();
  await page.locator('#tiptap-toolbar .tb-btn[data-cmd="link"]').click();
  await expect(input).toHaveValue('https://rundock.ai');

  // The unlink control removes the link.
  await page.locator('#tiptap-toolbar .tb-link-unlink').click();
  await expect(popover).toBeHidden();
  await expect(page.locator('.ProseMirror a[href="https://rundock.ai"]')).toHaveCount(0);
});

test('Escape closes the link popover without changing the document', async ({ page }) => {
  await openNote(page, 'Roadmap-2026.md');
  const NEEDLE = 'Quarterly targets';

  await page.locator('.ProseMirror p', { hasText: NEEDLE }).first().click({ clickCount: 3 });
  await page.locator('#tiptap-toolbar .tb-btn[data-cmd="link"]').click();
  const input = page.locator('#tiptap-toolbar .tb-link-input');
  await expect(input).toBeFocused();
  await input.fill('rundock.ai');
  await input.press('Escape');

  await expect(page.locator('#tiptap-toolbar .tb-linkpop')).toBeHidden();
  await expect(page.locator('.ProseMirror a')).toHaveCount(0);
});
