'use strict';
// Rehydrated conversations must not leak RUNDOCK marker payloads.
//
// Live rendering of a platform-delegate turn strips SAVE_AGENT blocks and
// shows the created pill. The rehydrate FIRST PAINT rendered the raw wire
// text, so reopening a Doc conversation showed the agent file's frontmatter
// as visible message text (found in synthetic user testing, 2026-08-12).
// The stored copy was stripped, so navigating away and back hid the leak,
// which is exactly why it survived: the bug only existed on first paint.
const { test, expect } = require('@playwright/test');

test('reopening a conversation with a SAVE_AGENT turn renders no payload on first paint', async ({ page }) => {
  await page.goto('/');
  await page.click('.convo-item:has-text("Doc created an agent")');
  const bubble = page.locator('.msg-bubble', { hasText: 'Created the agent as requested.' });
  await expect(bubble).toBeVisible();
  // The payload must be absent from the ENTIRE messages pane, first paint
  // included: RenSecret only exists inside the marker block.
  await expect(page.locator('#messages')).not.toContainText('RenSecret');
  await expect(page.locator('#messages')).not.toContainText('RUNDOCK:SAVE_AGENT');
});
