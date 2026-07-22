'use strict';
// E2E: the Kanban board's "Add a list" affordance.
//
// Browser-driven because the affordance is a DOM interaction on the real board
// view: a trailing "+ Add list" column that is always present, so a board with
// zero columns can still be built (before this, the only way to add a list was
// through an existing lane's menu, so an empty board was a dead end).
const { test, expect } = require('@playwright/test');

async function openBoard(page, name) {
  await page.goto('/');
  await expect(page.locator('.convo-item').first()).toBeVisible();
  await page.locator('.nav-item[data-nav="files"]').click();
  await page.locator('.file-item', { hasText: name }).first().click();
  await expect(page.locator('.board-add-lane-open')).toBeVisible();
}

test('a populated board shows a trailing "+ Add list", and it adds a column', async ({ page }) => {
  await openBoard(page, 'board.md');

  await expect(page.locator('.board-lane')).toHaveCount(3);
  await expect(page.locator('.board-add-lane-open')).toHaveText('+ Add list');

  await page.locator('.board-add-lane-open').click();
  await page.locator('.board-add-lane-input').fill('Review');
  await page.locator('.board-add-lane-input').press('Enter');

  await expect(page.locator('.board-lane')).toHaveCount(4);
  await expect(page.locator('.board-lane-title', { hasText: 'Review' })).toBeVisible();
});

test('an empty board is not a dead end: it offers "Add your first list"', async ({ page }) => {
  await openBoard(page, 'empty-board.md');

  // Zero columns, but the affordance is present and labelled for the empty state.
  await expect(page.locator('.board-lane')).toHaveCount(0);
  await expect(page.locator('.board-add-lane-open')).toHaveText('+ Add your first list');

  await page.locator('.board-add-lane-open').click();
  await page.locator('.board-add-lane-input').fill('To Do');
  await page.locator('.board-add-lane-input').press('Enter');

  await expect(page.locator('.board-lane')).toHaveCount(1);
  await expect(page.locator('.board-lane-title', { hasText: 'To Do' })).toBeVisible();
});
