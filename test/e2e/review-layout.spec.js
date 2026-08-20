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
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const {
  unreviewedSections,
  sectionedBodyLines,
  LONG_REPLY_URL,
  LONG_REPLY_UNBREAKABLE_RUN,
} = require('./fixture.js');

const UNREVIEWED = 'unreviewed-sections.md';

// Selects by path, not by text. `hasText` is a SUBSTRING match, and these two
// fixtures are named such that one contains the other: a search for
// "reviewed-sections" also matches "unreviewed-sections.md". That resolved
// correctly only because the tree sorts alphabetically and "r" precedes "u",
// which is not a property any test should rest on.
//
// The row carries its own path as a data attribute and owns the click handler,
// so addressing it that way is exact by construction and does not depend on
// how the name happens to be rendered.
async function openNote(page, file) {
  await page.goto('/');
  await expect(page.locator('.convo-item').first()).toBeVisible();
  await page.locator('.nav-item[data-nav="files"]').click();
  await page.locator(`#file-tree .file-item[data-path="${file}"]`).click();
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
  await openNote(page, 'reviewed-sections.md');
  const l = await layout(page);

  expect(l.reviewActive).toBe(true);
  expectDefectConditions(l);

  expect(l.overlapping).toEqual([]);
  expect(l.blocks[0].tag).toBe('H1');
  expect(l.blocks[0].top).toBeGreaterThanOrEqual(l.properties.bottom);
});

test('the body stays in document order below the panel', async ({ page }) => {
  await openNote(page, 'reviewed-sections.md');
  const l = await layout(page);

  // Without this the test passes against the broken stylesheet: blocks stay
  // ordered relative to one another even while the panel paints across them,
  // so ordering alone never saw the defect. The overlap test is what catches
  // it, and this assertion is what stops this test claiming credit for that.
  expect(l.reviewActive).toBe(true);
  expectDefectConditions(l);
  expectVisuallyOrdered(l.blocks);
  expect(l.blocks[0].text).toContain('Reviewed Sections');
});

// The panel's row collapsed because `overflow: hidden` made it a scroll
// container. The cheap way to "fix" that is to drop the overflow entirely,
// which would also drop the corner clipping the panel was given on purpose.
// This pins both halves: still clipping, still not a scroll container.
test('the panel still clips to its rounded corners, without scrolling', async ({ page }) => {
  await openNote(page, 'reviewed-sections.md');
  const { panelClip } = await layout(page);

  expect(panelClip.radius).toBeGreaterThan(0);
  // `clip` clips to the padding box exactly as `hidden` did. Unlike `hidden`,
  // `auto` and `scroll`, it establishes no scroll container, which is what
  // lets the auto-sized grid row measure the panel's real height again.
  expect(panelClip.overflowX).toBe('clip');
  expect(panelClip.overflowY).toBe('clip');
});

test('adding the first comment does not change the rendered order', async ({ page }) => {
  // This test WRITES to its fixture, so it has to start from a known state
  // rather than from whatever a previous run left behind. Restoring it here
  // makes the test idempotent: run it twice against one server and the second
  // run judges the fixture, not the first run's comment.
  //
  // The content comes from the fixture module rather than a copy pasted into
  // this file, so there is one definition and nothing to drift.
  await page.goto('/');
  const workspace = await page.evaluate(() => currentWorkspacePath);
  expect(workspace).toBeTruthy();
  fs.writeFileSync(path.join(workspace, UNREVIEWED),
    unreviewedSections(sectionedBodyLines()));

  // The bytes as authored, before the interface touches the file.
  const onDiskBefore = await (await page.request.get(`/api/file?path=${UNREVIEWED}`)).text();

  await openNote(page, 'unreviewed-sections.md');
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

// ---------------------------------------------------------------------------
// A reply carrying a long URL overflowed the side of its card.
//
// Root comment bodies wrap (`.review-card-body`, overflow-wrap: anywhere).
// Reply bodies were a classless <span> in a flex row, so nothing reached
// them: with the flex default `min-width: auto` the item could not shrink
// below the longest unbreakable run, and the box grew wider than the card.
//
// These tests measure PAINTED TEXT, not the element box, and the distinction
// is the point. A change that only lets the box shrink leaves the box inside
// the card while the glyphs keep painting through the card wall, so a test
// that asked the box whether it fit would pass against a fix that fixes
// nothing.
//
// The last test is the one that keeps the diagnosis honest. This defect sits
// in an area where a layout fault once wore a parser's clothes and the
// written diagnosis cost a session, so the cause is not asserted in prose
// anywhere: it is re-measured on every run. The unfixed element is driven
// through the declarations it used to carry and its width is compared
// against its own min-content width. If the real cause were something other
// than the min-content contribution pinning a flex item open, that
// comparison would not hold, and it would fail as a mismatch rather than as
// a passing boolean.
// ---------------------------------------------------------------------------

// Mirrors SIDEBAR_MIN in public/editor/panels/review.js. The narrowest the
// panel goes is the hardest case, so the test takes it rather than the default.
const SIDEBAR_MIN = 220;

async function openReplyNote(page, theme) {
  // Set before any app script runs, so the panel is built at this width and
  // in this theme rather than resized afterwards. The theme is pinned rather
  // than toggled because an unset preference falls back to the runner's OS
  // setting, which is not a property a test should vary on.
  await page.addInitScript(([width, t]) => {
    try {
      localStorage.setItem('rundock.reviewSidebarWidth', String(width));
      localStorage.setItem('rundock-theme', t);
    } catch { /* private mode */ }
  }, [SIDEBAR_MIN, theme]);
  await openNote(page, 'reviewed-replies.md');
}

async function replyLayout(page, unbreakableRun) {
  return page.evaluate((run) => {
    const card = document.querySelector('.review-card');
    const reply = document.querySelector('.review-reply');
    // The fallback matters: on an unfixed build the class does not exist, and
    // this test must FAIL on the measurement rather than error on a selector.
    const body = reply.querySelector('.review-reply-body')
      || [...reply.children].find((c) => !c.classList.contains('review-by'));
    const by = reply.querySelector('.review-by');
    const rootBody = document.querySelector('.review-card-body');

    const cs = getComputedStyle(card);
    const cardRect = card.getBoundingClientRect();
    const cardContentRight = cardRect.right
      - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth);
    const cardContentWidth = cardRect.width
      - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
      - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth);

    // Where the glyphs actually end. One rect per painted line, so this also
    // says whether the text wrapped at all.
    const paintedRects = (el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return [...range.getClientRects()];
    };
    const bodyRects = paintedRects(body);
    const textRight = Math.max(...bodyRects.map((r) => r.right));

    // How wide the unbreakable run WANTS to be, in this card's own font. If
    // this ever stops exceeding the card, the fixture has stopped reproducing
    // the defect and every assertion below would pass for the wrong reason.
    const probe = document.createElement('span');
    probe.textContent = run;
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;left:-9999px';
    probe.style.font = getComputedStyle(body).font;
    document.body.appendChild(probe);
    const runWidth = probe.getBoundingClientRect().width;
    probe.remove();

    return {
      light: document.body.classList.contains('light'),
      // The APPLIED width preference, not the rendered box: the panel paints
      // a few pixels wider than the value it was given, so measuring the box
      // would assert a number that has no meaning in the clamp.
      appliedWidth: parseInt(getComputedStyle(document.getElementById('tiptap-editor-pane'))
        .getPropertyValue('--review-sidebar-width'), 10),
      cardContentWidth: Math.round(cardContentWidth),
      runWidth: Math.round(runWidth),
      lines: bodyRects.length,
      textOverflowPx: Math.round(textRight - cardContentRight),
      rootBodyOverflowPx: Math.round(
        Math.max(...paintedRects(rootBody).map((r) => r.right)) - cardContentRight),
      // A label that wrapped or was clipped would be a regression of its own.
      byWidth: Math.round(by.getBoundingClientRect().width),
      byLines: paintedRects(by).length,
      byClipped: by.scrollWidth > by.clientWidth + 1,
      bodyText: body.textContent,
    };
  }, unbreakableRun);
}

// The fixture still reproduces the defect. Asserted wherever a layout is
// judged, so a shortened URL fails loudly instead of passing vacuously.
// The reply body text is asserted in full, which also proves the endmatter
// `re:` entry actually rendered as a reply rather than being dropped: no
// reply, no element, and every assertion below fails at the selector.
function expectReplyDefectConditions(l) {
  expect(l.appliedWidth).toBe(SIDEBAR_MIN);
  expect(l.bodyText).toBe(LONG_REPLY_URL);
  // Unbreakable by construction, and wider than the space it has to live in.
  expect(LONG_REPLY_UNBREAKABLE_RUN).not.toMatch(/[\s\-/?&=_.]/);
  expect(l.runWidth).toBeGreaterThan(l.cardContentWidth);
}

for (const theme of ['dark', 'light']) {
  test(`a reply's long URL stays inside the card at the narrowest panel width (${theme})`, async ({ page }) => {
    await openReplyNote(page, theme);
    const l = await replyLayout(page, LONG_REPLY_UNBREAKABLE_RUN);

    expect(l.light).toBe(theme === 'light');
    expectReplyDefectConditions(l);

    // The defect, measured: text painting past the card's content edge.
    expect(l.textOverflowPx).toBeLessThanOrEqual(0);
    // And it got there by wrapping, not by being clipped or shrunk away.
    expect(l.lines).toBeGreaterThan(1);
  });
}

test('the reply fix leaves the root body and the author label alone', async ({ page }) => {
  await openReplyNote(page, 'dark');
  const l = await replyLayout(page, LONG_REPLY_UNBREAKABLE_RUN);
  expectReplyDefectConditions(l);

  // Root bodies already wrapped. The fix must not have been paid for by them.
  expect(l.rootBodyOverflowPx).toBeLessThanOrEqual(0);
  // The label is flex-shrink: 0 on purpose. A reply body that shrank the
  // label instead of wrapping itself would satisfy the test above and still
  // be wrong, so this pins the label as its own condition.
  expect(l.byWidth).toBeGreaterThan(0);
  expect(l.byLines).toBe(1);
  expect(l.byClipped).toBe(false);
});

// A regression test must fail against the unfixed stylesheet, not merely
// claim that it would. This drives the reply body through the declarations a
// plausible wrong fix would leave behind and measures each one, so "anywhere
// is the part that matters" is an assertion rather than a belief.
//
// `break-word` is the dangerous one: it reads as a synonym, passes review by
// eye, and leaves the defect exactly where it was, because it does not reduce
// the flex item's min-content contribution and so cannot lower the automatic
// minimum size that made the item too wide in the first place.
test('only the shipped declaration wraps the reply; the near-misses do not', async ({ page }) => {
  await openReplyNote(page, 'dark');
  const l = await replyLayout(page, LONG_REPLY_UNBREAKABLE_RUN);
  expectReplyDefectConditions(l);

  const variants = await page.evaluate(() => {
    const card = document.querySelector('.review-card');
    const body = document.querySelector('.review-reply-body');
    const cs = getComputedStyle(card);
    const cardContentRight = card.getBoundingClientRect().right
      - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth);
    const measure = () => {
      const range = document.createRange();
      range.selectNodeContents(body);
      const rects = [...range.getClientRects()];
      return {
        lines: rects.length,
        bodyWidth: Math.round(body.getBoundingClientRect().width),
        // Both edges, because they can disagree, and the disagreement is the
        // reason this suite measures glyphs rather than boxes.
        boxOverflowPx: Math.round(body.getBoundingClientRect().right - cardContentRight),
        textOverflowPx: Math.round(Math.max(...rects.map((r) => r.right)) - cardContentRight),
      };
    };
    const under = (css) => { body.style.cssText = css; return measure(); };

    // The element's own min-content width, measured under the wrapping rules
    // it had BEFORE the fix. This is the number the diagnosis is about: a
    // flex item's automatic minimum size is its min-content contribution, and
    // `overflow-wrap: anywhere` works by lowering it. Measured on a detached
    // probe so the live element is never left in a half-styled state.
    const probe = document.createElement('span');
    probe.textContent = body.textContent;
    probe.style.cssText = 'position:absolute;visibility:hidden;left:-9999px;'
      + 'width:min-content;overflow-wrap:normal';
    probe.style.font = getComputedStyle(body).font;
    document.body.appendChild(probe);
    const minContentPx = Math.round(probe.getBoundingClientRect().width);
    probe.remove();
    const out = {
      minContentPx,
      cardContentWidth: Math.round(
        card.getBoundingClientRect().width
        - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
        - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth)),
      shipped: under(''),
      // What the element had before this change: no rule reached it at all.
      preFix: under('overflow-wrap: normal'),
      // The synonym that is not one.
      breakWord: under('overflow-wrap: break-word'),
      // Shrinking the box without letting the text wrap: the box fits, the
      // glyphs do not. This is the case the painted-text measurement exists
      // to catch, and a box-based test would call it fixed.
      shrinkOnly: under('overflow-wrap: normal; min-width: 0'),
    };
    body.style.cssText = '';
    return out;
  });

  // The shipped rule contains the text.
  expect(variants.shipped.textOverflowPx).toBeLessThanOrEqual(0);
  expect(variants.shipped.lines).toBeGreaterThan(1);

  // Every near-miss lets it out. If one of these ever stops overflowing, the
  // fix has stopped being load-bearing and this file should be re-reasoned
  // rather than re-baselined.
  expect(variants.preFix.textOverflowPx).toBeGreaterThan(0);
  expect(variants.breakWord.textOverflowPx).toBeGreaterThan(0);
  expect(variants.shrinkOnly.textOverflowPx).toBeGreaterThan(0);

  // The trap, stated as an assertion rather than a warning: shrinking the box
  // without letting the text wrap puts the BOX inside the card while the
  // glyphs stay 600-odd pixels outside it. Any future test here that measures
  // the element rectangle would pass on this and ship the bug.
  expect(variants.shrinkOnly.boxOverflowPx).toBeLessThanOrEqual(0);
  expect(variants.shrinkOnly.textOverflowPx)
    .toBeGreaterThan(variants.shrinkOnly.boxOverflowPx);

  // The diagnosis itself, as a measurement that can come out false.
  //
  // "A flex item pinned open by its own min-content contribution" is a claim
  // with a number attached: unfixed, the item's width should BE its
  // min-content width, and that width should exceed the space it has. Both
  // are compared against quantities measured on this page rather than against
  // constants copied from one machine, so the check is meaningful on any
  // renderer. A cause that was not the min-content contribution would show up
  // here as a mismatch rather than as a quietly passing boolean.
  expect(Math.abs(variants.preFix.bodyWidth - variants.minContentPx))
    .toBeLessThanOrEqual(2);
  expect(variants.preFix.bodyWidth).toBeGreaterThan(variants.cardContentWidth);
  // And the fix works by lowering exactly that: the item now fits the card.
  expect(variants.shipped.bodyWidth).toBeLessThanOrEqual(variants.cardContentWidth + 1);
});
