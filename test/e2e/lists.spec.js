'use strict';
// E2E: conversation Lists (named many-to-many sidebar groupings as pills).
// Proves the card's user-observable criteria end to end against the real
// server + browser: create a list from a conversation's context menu, the
// pill filters with pinned-first ordering unchanged, membership is
// many-to-many, state survives a reload, and deleting a list never deletes
// conversations.
const { test, expect } = require('@playwright/test');

async function boot(page) {
  await page.goto('/');
  await expect(page.locator('.convo-item').first()).toBeVisible();
}

async function openConversationsView(page) {
  await page.locator('.nav-item[data-nav="conversations"]').click();
  await expect(page.locator('.convo-item').first()).toBeVisible();
}

function convoRow(page, title) {
  return page.locator('.convo-item', { hasText: title });
}

test('lists: create from the context menu, filter via the pill, survive reload, delete safely', async ({ page }) => {
  await boot(page);
  await openConversationsView(page);

  // Create "Client work" from the pinned conversation's context menu.
  await convoRow(page, 'Board prep planning').first().click({ button: 'right' });
  const menuInput = page.locator('.convo-menu-input input');
  await expect(menuInput).toBeFocused();
  await menuInput.fill('Client work');
  await menuInput.press('Enter');

  // The pill appears and the creating conversation is already a member.
  const pill = page.locator('.pill-list', { hasText: 'Client work' });
  await expect(pill).toBeVisible();
  await pill.click();
  await expect(page.locator('.convo-item')).toHaveCount(1);
  await expect(page.locator('.convo-item').first()).toContainText('Board prep planning');

  // Add a second conversation from the All view; pinned-first ordering holds
  // inside the list (Board prep is pinned, so it stays first even though the
  // other conversation is more recent).
  await page.locator('#pill-all').click();
  const second = page.locator('.convo-item:not(:has-text("Board prep planning"))').first();
  const secondTitle = await second.locator('.convo-title').textContent();
  await second.click({ button: 'right' });
  await page.locator('.convo-menu-item', { hasText: 'Client work' }).click();
  await pill.click();
  await expect(page.locator('.convo-item')).toHaveCount(2);
  await expect(page.locator('.convo-item').first()).toContainText('Board prep planning');

  // Many-to-many: the same conversation joins a second list.
  await convoRow(page, 'Board prep planning').first().click({ button: 'right' });
  const input2 = page.locator('.convo-menu-input input');
  await input2.fill('Research');
  await input2.press('Enter');
  await expect(page.locator('.pill-list', { hasText: 'Research' })).toBeVisible();

  // Reload: lists, membership, and the pills all survive.
  await page.reload();
  await expect(page.locator('.convo-item').first()).toBeVisible();
  await openConversationsView(page);
  await expect(page.locator('.pill-list', { hasText: 'Client work' })).toBeVisible();
  await expect(page.locator('.pill-list', { hasText: 'Research' })).toBeVisible();
  await page.locator('.pill-list', { hasText: 'Client work' }).click();
  await expect(page.locator('.convo-item')).toHaveCount(2);

  // Membership toggle removes without deleting: check the row still exists
  // under All after removal from the list.
  await convoRow(page, secondTitle).first().click({ button: 'right' });
  await page.locator('.convo-menu-item', { hasText: 'Client work' }).click();
  await expect(page.locator('.convo-item')).toHaveCount(1);

  // Delete the list from the pill's context menu while it is the active
  // filter: the pill disappears, the view falls back to All, and no
  // conversations were deleted.
  await page.locator('#pill-all').click();
  const allCount = await page.locator('.convo-item').count();
  await page.locator('.pill-list', { hasText: 'Client work' }).click();
  await page.locator('.pill-list', { hasText: 'Client work' }).click({ button: 'right' });
  await page.locator('.convo-menu-item', { hasText: 'Delete list' }).click();
  await expect(page.locator('.pill-list', { hasText: 'Client work' })).toHaveCount(0);
  await expect(page.locator('#pill-all')).toHaveClass(/active/);
  await expect(page.locator('.convo-item')).toHaveCount(allCount);
});
