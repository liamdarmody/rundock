'use strict';
// E2E: the hairline beside the pin control draws only when something follows it.
//
// WHY THIS IS A BROWSER TEST AND NOT A UNIT ONE. The rule is CSS, and it is a
// `:has()` selector over the header's siblings. jsdom resolves neither the
// cascade nor `:has()` well enough to answer "is this element visible", so a
// unit test could only assert that a string exists in a stylesheet, which is
// not the claim. The claim is that a reader does not see a separator with
// nothing after it, and only a real browser can be asked that.
//
// WHAT WAS MEASURED. The pin control is placed left of Preview and Edit behind
// its own hairline, because pinned is a property of the file rather than a
// third view mode. app.js hides both toggles for markdown files, which open in
// the Tiptap pane instead, so on most files in most workspaces the header
// ended in a line with nothing to its right. Reported from the field on the
// 0.14 rail, and missed by the browser pass that had just read that header's
// DOM: it checked that the pin was present and correct, and never asked what
// the element beside it then looked like.
const { test, expect } = require('@playwright/test');

async function open(page, name) {
  await page.goto('/');
  await page.locator('.nav-item[data-nav="files"]').click();
  await page.locator('.file-item', { hasText: name }).first().click();
}

test('a markdown file draws the pin and no trailing hairline', async ({ page }) => {
  await open(page, 'Roadmap-2026.md');
  await expect(page.locator('#editor-pin')).toBeVisible();
  // The toggles this divider separates the pin FROM are not on screen for a
  // markdown file, so the divider has nothing to separate.
  await expect(page.locator('#toggle-preview')).toBeHidden();
  await expect(page.locator('#toggle-edit')).toBeHidden();
  await expect(page.locator('.editor-header-divider')).toBeHidden();
});

test('a file that keeps Preview and Edit still draws the hairline between them and the pin', async ({ page }) => {
  // THE OTHER HALF, and the one that stops this being fixed by deleting the
  // divider. Where the toggles are on screen the separator is doing its job
  // and must still be drawn.
  await open(page, 'proposal.html');
  await expect(page.locator('#editor-pin')).toBeVisible();
  await expect(page.locator('#toggle-preview')).toBeVisible();
  await expect(page.locator('.editor-header-divider')).toBeVisible();
});
