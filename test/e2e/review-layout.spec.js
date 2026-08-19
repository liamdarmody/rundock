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

const UNREVIEWED = 'unreviewed-sections.md';

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
    const cs = getComputedStyle(props);
    return {
      reviewActive: pane.classList.contains('review-active'),
      properties,
      blocks,
      // The order a reader sees, as a comparable value rather than geometry.
      // Comparing the whole sequence is what catches a block that moved into
      // the middle of the document; checking only the first block does not.
      sequence: blocks.map((b) => `${b.tag}|${b.text}`),
      // A block overlaps the panel when their vertical ranges intersect.
      overlapping: blocks.filter((b) => b.top < properties.bottom && b.bottom > properties.top),
      paneScrolls: pane.scrollHeight > pane.clientHeight,
      // Clipping to the rounded corners was deliberate. The fix trades
      // `hidden` for `clip`, and both of those clip; `visible` would not.
      panelClip: {
        overflowX: cs.overflowX,
        overflowY: cs.overflowY,
        radius: parseFloat(cs.borderTopLeftRadius),
      },
    };
  });
}

// The preconditions the defect needs. Asserted wherever a layout is judged, so
// a fixture that quietly stops reproducing them fails loudly instead of passing
// for the wrong reason. A shortened note is the likeliest way to lose them.
function expectDefectConditions(l) {
  expect(l.paneScrolls).toBe(true);
  expect(l.blocks.filter((b) => b.tag === 'HR').length).toBeGreaterThan(1);
}

// Every block sits at or below the one before it: nothing jumped the queue.
function expectVisuallyOrdered(blocks) {
  for (let i = 1; i < blocks.length; i += 1) {
    expect(blocks[i].top).toBeGreaterThanOrEqual(blocks[i - 1].top);
  }
}

test('the body starts below the properties panel while review mode is on', async ({ page }) => {
  await openNote(page, 'reviewed-sections');
  const l = await layout(page);

  expect(l.reviewActive).toBe(true);
  expectDefectConditions(l);

  expect(l.overlapping).toEqual([]);
  expect(l.blocks[0].tag).toBe('H1');
  expect(l.blocks[0].top).toBeGreaterThanOrEqual(l.properties.bottom);
});

test('the body stays in document order below the panel', async ({ page }) => {
  await openNote(page, 'reviewed-sections');
  const l = await layout(page);

  expectDefectConditions(l);
  expectVisuallyOrdered(l.blocks);
  expect(l.blocks[0].text).toContain('Reviewed Sections');
});

// The panel's row collapsed because `overflow: hidden` made it a scroll
// container. The cheap way to "fix" that is to drop the overflow entirely,
// which would also drop the corner clipping the panel was given on purpose.
// This pins both halves: still clipping, still not a scroll container.
test('the panel still clips to its rounded corners, without scrolling', async ({ page }) => {
  await openNote(page, 'reviewed-sections');
  const { panelClip } = await layout(page);

  expect(panelClip.radius).toBeGreaterThan(0);
  // `clip` clips to the padding box exactly as `hidden` did. Unlike `hidden`,
  // `auto` and `scroll`, it establishes no scroll container, which is what
  // lets the auto-sized grid row measure the panel's real height again.
  expect(panelClip.overflowX).toBe('clip');
  expect(panelClip.overflowY).toBe('clip');
});

test('adding the first comment does not change the rendered order', async ({ page }) => {
  // The bytes as authored, before the interface touches the file.
  const onDiskBefore = await (await page.request.get(`/api/file?path=${UNREVIEWED}`)).text();

  await openNote(page, 'unreviewed-sections');
  const before = await layout(page);
  expect(before.reviewActive).toBe(false);
  expect(before.overlapping).toEqual([]);
  // The same preconditions the reviewed-note tests assert. Without these a
  // shortened fixture would let this test pass without exercising the defect.
  expectDefectConditions(before);

  await page.locator('.ProseMirror p', { hasText: 'first paragraph' }).first().click({ clickCount: 3 });
  await page.locator('.tb-comment').first().click();
  const composer = page.locator('.review-composer textarea');
  await composer.fill('Does this still read as the opening?');
  await composer.press('Enter');
  await expect(page.locator('#tiptap-editor-pane.review-active')).toBeVisible();

  const after = await layout(page);
  expect(after.reviewActive).toBe(true);
  expect(after.overlapping).toEqual([]);
  expectDefectConditions(after);
  expect(after.blocks[0].tag).toBe('H1');
  expect(after.blocks[0].top).toBeGreaterThanOrEqual(after.properties.bottom);

  // The whole sequence, not just the first block: a block that swapped places
  // with another in the middle of the document would survive a first-block
  // check untouched.
  expect(after.sequence).toEqual(before.sequence);
  expectVisuallyOrdered(after.blocks);

  // The byte-preservation guarantee, checked where the interface actually
  // exercises it, rather than on a static in-memory round-trip. Without this,
  // a comment-add that rewrote or re-escaped the body would pass every other
  // assertion here.
  await expect(page.locator('#editor-status')).toHaveText('Saved', { timeout: 10000 });
  await expect
    .poll(async () => (await (await page.request.get(`/api/file?path=${UNREVIEWED}`)).text()))
    .toContain('\n---\ncomments:');

  const onDiskAfter = await (await page.request.get(`/api/file?path=${UNREVIEWED}`)).text();
  const endmatterAt = onDiskAfter.indexOf('\n---\ncomments:');
  expect(endmatterAt).toBeGreaterThan(0);

  // Everything before the endmatter block: frontmatter and body. Adding a
  // comment inserts CriticMarkup at the comment site and must change nothing
  // else, so stripping that one annotation has to give back the exact bytes.
  //
  // The slice stops AT the newline the match starts on, because that newline
  // is the endmatter's own opening delimiter rather than the body's last byte.
  // The body already ends in a newline of its own; taking both would count the
  // blank line that separates the two blocks as if the body had grown one.
  const outside = onDiskAfter.slice(0, endmatterAt);
  const stripped = outside.replace(/\{==([\s\S]*?)==\}\{>>[\s\S]*?<<\}\{#[^}]*\}/g, '$1');
  expect(stripped).toBe(onDiskBefore);
});
