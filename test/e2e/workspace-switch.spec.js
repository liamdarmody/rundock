'use strict';
// E2E: switching workspaces must close the open file.
//
// The intended behaviour is a fine line the fix must respect: an open file
// persists across VIEW switches WITHIN a workspace (the "keep your place"
// feature), but is CLOSED when you switch WORKSPACES, so the previous
// workspace's note/board/artifact never leaks into the new one.
const { test, expect } = require('@playwright/test');
const { buildFixture } = require('./fixture.js');

test('a view switch within a workspace keeps the open file; a workspace switch closes it', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.convo-item').first()).toBeVisible();

  // Open a board in workspace A.
  await page.locator('.nav-item[data-nav="files"]').click();
  await page.locator('.file-item', { hasText: 'board.md' }).first().click();
  await expect(page.locator('.board-lane').first()).toBeVisible();
  expect(await page.evaluate(() => currentFilePath)).toBe('board.md');

  // A VIEW switch within the same workspace keeps the file open (keep-your-place).
  await page.locator('.nav-item[data-nav="conversations"]').click();
  await page.locator('.nav-item[data-nav="files"]').click();
  expect(await page.evaluate(() => currentFilePath)).toBe('board.md');

  // A WORKSPACE switch closes it: the file is torn down and nothing leaks.
  const workspaceB = buildFixture().workspace;
  await page.evaluate((dir) => selectWorkspace(dir), workspaceB);

  await expect.poll(() => page.evaluate(() => currentFilePath)).toBeNull();
  await expect(page.locator('.board-lane')).toHaveCount(0);
  await expect(page.locator('.file-item.active')).toHaveCount(0);
});
