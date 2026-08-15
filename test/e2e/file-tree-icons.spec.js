'use strict';
// A file tree icon must never be the thing that gives way.
//
// A tree row is a flex container holding an SVG and the filename. The filename
// was a bare text node, and a text node cannot carry text-overflow, so it could
// not truncate. Each nesting level takes 20px of the row's width. When the row
// ran out, the only flexible thing in it was the SVG: at a 200px sidebar,
// depth-0 icons stayed 14px while nested ones rendered around 12.4px, worse the
// deeper it went.
//
// These assertions measure the rendered icon rather than quoting a figure in a
// comment. A measurement in a comment cannot fail when the code changes, and
// this programme has been wrong that way three times.
const { test, expect } = require('@playwright/test');

const ICON_PX = 14;          // .file-item-icon width and height
const SIDEBAR_DEFAULT_W = 280;   // the fallback in .sidebar's var(--sidebar-width, 280px)

// Names long enough to overflow the sidebar at every depth, so the squeeze is
// guaranteed rather than dependent on whatever the fixture workspace holds.
const LONG = 'a-deliberately-long-file-name-that-cannot-fit.md';

/** A tree nested `depth` folders deep, each level holding one long-named file. */
function deepTree(depth) {
  let node = { type: 'file', name: LONG, kind: 'note', path: 'leaf/' + LONG };
  for (let i = depth; i >= 1; i--) {
    node = {
      type: 'folder',
      name: 'a-long-folder-name-at-level-' + i,
      path: 'lvl' + i,
      children: [node, { type: 'file', name: LONG, kind: 'note', path: 'lvl' + i + '/' + LONG }],
    };
  }
  return [node];
}

/**
 * The narrowest sidebar the app actually allows, found by dragging the resize
 * handle as far left as it will go and reading back what the app settled on.
 *
 * Deliberately not a constant copied from app.js. AC-1 is about every width
 * the app allows, so the test has to ask the app rather than restate one of
 * its numbers: a duplicated literal would keep passing against a stale figure
 * if the real clamp ever moved, which is the same way a measurement quoted in
 * a comment fails.
 */
async function narrowestWidth(page) {
  const handle = page.locator('.sidebar-resize-handle');
  await expect(handle).toBeAttached();
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(0, box.y + box.height / 2, { steps: 10 });  // hard against the left edge
  await page.mouse.up();

  const w = await page.evaluate(() =>
    parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width')));
  expect(Number.isFinite(w)).toBe(true);
  // The clamp has to have engaged, otherwise this is measuring a drag that did
  // not happen and the narrow case is not narrow.
  expect(w).toBeLessThan(SIDEBAR_DEFAULT_W);
  return w;
}

async function openFiles(page) {
  await page.goto('/');
  await expect(page.locator('.convo-item').first()).toBeVisible();
  await page.locator('.nav-item[data-nav="files"]').click();
  await expect(page.locator('.folder-item').first()).toBeVisible();
}

/**
 * Render a synthetic deep tree with every folder open, at a given sidebar
 * width. The tree arrives through the real file_tree handler rather than by
 * reaching into the view's internals, so this exercises the path an agent
 * turn takes. Folders are opened by clicking, as the user would.
 */
async function renderDeep(page, { width, depth = 4 }) {
  await page.evaluate(({ tree, width }) => {
    document.documentElement.style.setProperty('--sidebar-width', width + 'px');
    ws.onmessage({ data: JSON.stringify({ type: 'file_tree', tree }) });
  }, { tree: deepTree(depth), width });

  // Every level is built into the DOM already, just collapsed. Opening the
  // outermost first keeps the next one clickable.
  for (let i = 0; i < depth; i++) {
    const folder = page.locator('#file-tree .folder-item').nth(i);
    await expect(folder).toBeVisible();
    await folder.click();
  }
  await expect(page.locator('#file-tree .file-item').first()).toBeVisible();
}

/** Every tree icon's rendered box, tagged with its nesting depth. */
async function iconBoxes(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('#file-tree svg.file-item-icon')).map((svg) => {
      const r = svg.getBoundingClientRect();
      let depth = 0;
      for (let el = svg.parentElement; el; el = el.parentElement) {
        if (el.classList.contains('file-children')) depth++;
      }
      return { w: r.width, h: r.height, depth, row: svg.parentElement.className };
    }));
}

async function expectFullSizeIcons(page, width, label) {
  await renderDeep(page, { width });

  const boxes = await iconBoxes(page);
  // Guard the guard: a tree that never nested would pass the size assertion
  // while proving nothing, which is the exact shape of a test that cannot
  // fail.
  expect(boxes.length, `${label}: rows rendered`).toBeGreaterThan(4);
  expect(Math.max(...boxes.map((b) => b.depth)), `${label}: nesting reached`).toBeGreaterThanOrEqual(4);

  for (const b of boxes) {
    expect.soft(b.w, `${label}: icon width at depth ${b.depth} (${b.row})`).toBeCloseTo(ICON_PX, 1);
    expect.soft(b.h, `${label}: icon height at depth ${b.depth} (${b.row})`).toBeCloseTo(ICON_PX, 1);
  }
}

test('icons render full size at every depth, at the default sidebar width', async ({ page }) => {
  await openFiles(page);
  await expectFullSizeIcons(page, SIDEBAR_DEFAULT_W, `${SIDEBAR_DEFAULT_W}px`);
  expect(test.info().errors).toHaveLength(0);
});

test('icons render full size at every depth, at the narrowest the app allows', async ({ page }) => {
  await openFiles(page);
  const min = await narrowestWidth(page);
  await expectFullSizeIcons(page, min, `narrowest (${min}px)`);
  expect(test.info().errors).toHaveLength(0);
});

test('the filename truncates instead, and stays readable in full', async ({ page }) => {
  await openFiles(page);
  await renderDeep(page, { width: await narrowestWidth(page) });

  const name = page.locator('#file-tree .file-children .file-item .file-item-name').first();
  await expect(name).toBeVisible();

  const m = await name.evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      text: el.textContent,
      overflowing: el.scrollWidth > el.clientWidth,
      textOverflow: cs.textOverflow,
      overflow: cs.overflow,
      whiteSpace: cs.whiteSpace,
    };
  });

  // AC-2: the name is the thing that gives way, and says so visibly.
  expect(m.overflowing).toBe(true);
  expect(m.textOverflow).toBe('ellipsis');
  expect(m.overflow).not.toBe('visible');
  expect(m.whiteSpace).toBe('nowrap');

  // AC-3: truncating is a visual effect only. The text is all still there.
  expect(m.text).toBe(LONG);
});

test('expand, collapse and selection still work with the new row shape', async ({ page }) => {
  await openFiles(page);
  await renderDeep(page, { width: SIDEBAR_DEFAULT_W, depth: 2 });

  const folder = page.locator('#file-tree .folder-item').first();
  const children = page.locator('#file-tree .file-children').first();

  await expect(children).not.toHaveClass(/collapsed/);
  await folder.click();
  await expect(children).toHaveClass(/collapsed/);
  await folder.click();
  await expect(children).not.toHaveClass(/collapsed/);

  // The folder icon swaps open/closed on toggle, and the swap targets the SVG
  // by class, so it has to survive the row's markup changing. Assert the glyph
  // it lands on, not merely that it changed: an earlier version of this app
  // shipped a swap that found the wrong element and wrote a text chevron into
  // the SVG, which "it is different now" would have called a pass.
  const icon = folder.locator('svg.file-item-icon');
  await expect(icon).toHaveCount(1);
  // Read the glyphs back through the DOM so both sides are serialised the same
  // way: the source writes <path/> and innerHTML reports <path></path>.
  const glyphs = await page.evaluate(() => {
    const norm = (src) => {
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      el.innerHTML = src;
      return el.innerHTML;
    };
    return { open: norm(TREE_ICONS.folderOpen), closed: norm(TREE_ICONS.folder) };
  });
  expect(glyphs.open).not.toBe(glyphs.closed);   // the two states are distinguishable

  expect(await icon.innerHTML()).toBe(glyphs.open);
  await folder.click();
  expect(await icon.innerHTML()).toBe(glyphs.closed);
  await folder.click();
  expect(await icon.innerHTML()).toBe(glyphs.open);
});

test('clicking the filename still selects the row', async ({ page }) => {
  // On the real workspace, not the synthetic tree: selection survives only if
  // the file exists, because opening it re-highlights by path afterwards.
  await openFiles(page);
  await page.locator('#file-tree .folder-item').first().click();

  const file = page.locator('#file-tree .file-item').first();
  await expect(file).toBeVisible();
  await file.locator('.file-item-name').click();
  await expect(file).toHaveClass(/active/);
});
