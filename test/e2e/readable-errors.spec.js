'use strict';
// E2E: a save the system refuses reads as a plain sentence, with the raw error
// behind a "Details" control (public/readable-error.js).
//
// Driven through the real editor: a note on disk is made read-only, the person
// types, the autosave reaches the server, the write fails, and the status line
// says what happened and what to try. Before this, the throw stopped in the
// server's message loop and the status kept saying the file was unsaved.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

test('a save the system refuses says why in plain words, with the raw error behind Details', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.convo-item').first()).toBeVisible();
  const workspace = await page.evaluate(() => currentWorkspacePath);
  const rel = 'Locked note.md';
  const full = path.join(workspace, rel);
  fs.writeFileSync(full, '# Locked\n\nSome text.\n');
  fs.chmodSync(full, 0o444);
  try {
    await page.evaluate((f) => window.openWorkspaceFilePath(f), rel);
    await expect(page.locator('.ProseMirror')).toContainText('Some text.');
    await page.locator('.ProseMirror p', { hasText: 'Some text.' }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' More.');

    const status = page.locator('#editor-status');
    await expect(status).toContainText("Rundock couldn't save this file because", { timeout: 10_000 });
    const sentence = await status.evaluate((el) => el.firstChild && el.firstChild.nodeType === 3 ? el.firstChild.textContent : '');
    expect(sentence).toMatch(/try again\.$/);
    expect(sentence).not.toContain(workspace);
    expect(sentence).not.toMatch(/\bE[A-Z]{3,}\b/);

    const details = status.locator('details.error-details');
    await expect(details.locator('summary')).toHaveText('Details');
    await expect(details.locator('code')).toBeHidden();
    await details.locator('summary').click();
    await expect(details.locator('code')).toBeVisible();
    await expect(details.locator('code')).toContainText(/EACCES|EPERM/);
    await expect(details.locator('code')).toContainText(rel);
    expect(fs.readFileSync(full, 'utf8')).toBe('# Locked\n\nSome text.\n');

    // The next save is the same refusal again, never a false "changed outside
    // Rundock": the unchanged disk is not someone else's edit.
    await page.locator('.ProseMirror p', { hasText: 'Some text.' }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Again.');
    await expect(status).toContainText('Unsaved');
    await expect(status).toContainText("Rundock couldn't save this file because", { timeout: 10_000 });
    await expect(page.locator('#external-edit-banner')).toHaveCount(0);
  } finally {
    fs.chmodSync(full, 0o644);
    fs.rmSync(full, { force: true });
  }
});
