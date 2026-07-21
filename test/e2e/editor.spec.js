'use strict';
// E2E: rich editor (ProseMirror) live-editing safety.
//
// Browser-only regression coverage. The unit harness round-trips markdown
// through a real Tiptap editor in jsdom, but jsdom's splitBlock is clean:
// it cannot reproduce the contenteditable path a real browser takes when the
// Enter key lands next to an inline atom node (a wikilink). This spec drives
// real Chromium so that class of corruption is caught.
const { test, expect } = require('@playwright/test');

async function openNote(page, name) {
  await page.goto('/');
  await expect(page.locator('.convo-item').first()).toBeVisible();
  await page.locator('.nav-item[data-nav="files"]').click();
  await page.locator('.file-item', { hasText: name }).first().click();
  await expect(page.locator('.ProseMirror .wikilink').first()).toBeVisible();
}

// Place a collapsed caret at the very end of the paragraph containing `needle`.
async function caretAtEndOfPara(page, needle) {
  await page.evaluate((needleText) => {
    const pm = document.querySelector('.ProseMirror');
    pm.focus();
    const p = [...pm.querySelectorAll('p')].find((el) => el.textContent.includes(needleText));
    const last = p.lastChild;
    const sel = window.getSelection();
    const range = document.createRange();
    const offset = last.nodeType === 3 ? last.textContent.length : last.childNodes.length;
    range.setStart(last, offset);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }, needle);
}

test('Enter at the end of a wikilink paragraph preserves every link and its text', async ({ page }) => {
  await openNote(page, 'wikilink-line.md');

  // Both wikilinks are present before the edit.
  await expect(page.locator('.ProseMirror .wikilink')).toHaveCount(2);

  await caretAtEndOfPara(page, 'See also');
  await page.keyboard.press('Enter');

  // The original paragraph must keep all its text: nothing before or after the
  // wikilinks may be deleted by the split.
  const paraText = await page.evaluate(() => {
    const p = [...document.querySelectorAll('.ProseMirror p')].find((el) => el.textContent.includes('See also'));
    return p ? p.textContent : '(paragraph gone)';
  });
  expect(paraText).toContain('See also:');
  expect(paraText).toContain('Roadmap-2026');
  expect(paraText).toContain('Missing Note');

  // Both wikilink atoms survive in the document.
  await expect(page.locator('.ProseMirror .wikilink')).toHaveCount(2);
});
