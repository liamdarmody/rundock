'use strict';
// E2E: the properties panel keeps its place when review mode is on.
//
// Review mode turns the editor pane into a two-column grid. A grid item that
// is also a scroll container contributes only its borders to the height of an
// auto-sized row, so a panel styled `overflow: hidden` collapsed its row to
// 18px, kept its real height, and painted across the body text below it. The
// document looked like it had lost its segmentation; the parse was never wrong.
//
// The defect only appears once the pane has more content than it can show, so
// these tests use a long note. A short one lays out correctly either way and
// would pass against the broken stylesheet.
const { test, expect } = require('@playwright/test');

async function openNote(page, name) {
  await page.goto('/');
  await expect(page.locator('.convo-item').first()).toBeVisible();
  await page.locator('.nav-item[data-nav="files"]').click();
  await page.locator('.file-item', { hasText: name }).first().click();
  await expect(page.locator('#tiptap-properties.visible')).toBeVisible();
  await expect(page.locator('.ProseMirror h1')).toBeVisible();
}

// The rectangles that decide whether a reader sees one thing on top of another.
async function layout(page) {
  return page.evaluate(() => {
    const props = document.getElementById('tiptap-properties');
    const pane = document.getElementById('tiptap-editor-pane');
    const pm = document.querySelector('.ProseMirror');
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom) };
    };
    const properties = box(props);
    const blocks = [...pm.children].map((el) => ({
      tag: el.tagName,
      text: (el.textContent || '').slice(0, 30),
      ...box(el),
    }));
    return {
      reviewActive: pane.classList.contains('review-active'),
      properties,
      blocks,
      // A block overlaps the panel when their vertical ranges intersect.
      overlapping: blocks.filter((b) => b.top < properties.bottom && b.bottom > properties.top),
      paneScrolls: pane.scrollHeight > pane.clientHeight,
    };
  });
}

test('the body starts below the properties panel while review mode is on', async ({ page }) => {
  await openNote(page, 'reviewed-sections');
  const l = await layout(page);

  // The conditions the defect needs, asserted so a fixture that quietly stops
  // reproducing them fails loudly instead of passing for the wrong reason.
  expect(l.reviewActive).toBe(true);
  expect(l.paneScrolls).toBe(true);
  expect(l.blocks.filter((b) => b.tag === 'HR').length).toBeGreaterThan(1);

  expect(l.overlapping).toEqual([]);
  expect(l.blocks[0].tag).toBe('H1');
  expect(l.blocks[0].top).toBeGreaterThanOrEqual(l.properties.bottom);
});

test('the body stays in document order below the panel', async ({ page }) => {
  await openNote(page, 'reviewed-sections');
  const { blocks } = await layout(page);

  // Every block sits at or below the one before it: nothing has jumped the queue.
  for (let i = 1; i < blocks.length; i += 1) {
    expect(blocks[i].top).toBeGreaterThanOrEqual(blocks[i - 1].top);
  }
  expect(blocks[0].text).toContain('Reviewed Sections');
});

test('adding the first comment does not change the rendered order', async ({ page }) => {
  await openNote(page, 'unreviewed-sections');
  const before = await layout(page);
  expect(before.reviewActive).toBe(false);
  expect(before.overlapping).toEqual([]);

  await page.locator('.ProseMirror p', { hasText: 'first paragraph' }).first().click({ clickCount: 3 });
  await page.locator('.tb-comment').first().click();
  const composer = page.locator('.review-composer textarea');
  await composer.fill('Does this still read as the opening?');
  await composer.press('Enter');
  await expect(page.locator('#tiptap-editor-pane.review-active')).toBeVisible();

  const after = await layout(page);
  expect(after.reviewActive).toBe(true);
  expect(after.overlapping).toEqual([]);
  expect(after.blocks[0].tag).toBe('H1');
  expect(after.blocks[0].top).toBeGreaterThanOrEqual(after.properties.bottom);
});
