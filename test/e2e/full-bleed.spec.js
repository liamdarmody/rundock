'use strict';
// Full-bleed extension views in the real app.
//
// A claimed extension view and a plain note are written into the e2e
// server's own temporary workspace, with an extension record written the way
// the install flow writes one, so nothing here depends on any private path.
// In both themes the spec measures, in Chromium:
//   - the frame's left and top edges and width equal the pane's, the pane has
//     no padding, and the frame fills the pane top to bottom;
//   - the frame paints the same pixel as a plain note's pane at the same point;
//   - the view's first line starts at the same x as the note's first line;
//   - an embedded view paints its panel's surface, with no inner box, border,
//     radius or padding of its own.
//   - a view that opts out (rundock-full-bleed on its body) starts at the
//     frame's own corner, and one that sets its own body padding starts
//     exactly where it asked, with the frame filling the pane either way.

const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

test.use({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });

const NAME = 'bleed-view';
// The extension's whole entry: on init it writes one line of text, with no
// outer padding or background of its own, and asks for a short frame so the
// pane, not the view, decides the height.
// The file's own text chooses the layout, so one extension exercises all
// three: the default, the documented opt-out (rundock-full-bleed on body),
// and a view that sets its own body padding.
const ENTRY = [
  "window.addEventListener('message', function (e) {",
  "  if (!e.data || e.data.type !== 'init') return;",
  "  var mode = String(e.data.content).trim();",
  "  if (mode === 'full-bleed') document.body.classList.add('rundock-full-bleed');",
  "  if (mode === 'own-padding') document.body.style.padding = '8px 12px';",
  "  document.body.textContent = '';",
  "  var p = document.createElement('p'); p.id = 'first'; p.style.margin = '0'; p.textContent = 'The first line of the view.';",
  "  document.body.appendChild(p);",
  "  parent.postMessage({ type: 'resize', height: 200 }, '*');",
  '});',
  "parent.postMessage({ type: 'ready' }, '*');",
].join('\n');

function write(workspace, rel, content) {
  const absolute = path.join(workspace, rel);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

let workspace = null;
async function setUp(page) {
  await page.goto('/');
  await expect(page.locator('.convo-item').first()).toBeVisible();
  workspace = await page.evaluate(() => currentWorkspacePath);
  write(workspace, 'bleed/figures.csv', 'a,b\n1,2\n');
  write(workspace, 'bleed/edge.csv', 'full-bleed\n');
  write(workspace, 'bleed/own.csv', 'own-padding\n');
  write(workspace, 'bleed/Plain bleed note.md', 'The first line of a plain note.\n\nA second paragraph.\n');
  write(workspace, 'bleed/Embed bleed note.md', 'A note with a view in it.\n\n![[bleed/figures.csv]]\n');
  write(workspace, '.rundock/extensions.json', JSON.stringify({ schema: 'rundock.extensions/v1', extensions: [{
    name: NAME, version: '1.0.0', entry: 'index.js', match: '*.csv',
    source: { url: 'https://github.com/example/bleed-view', reference: 'v1.0.0' },
    installedAt: '2026-09-23T00:00:00.000Z', root: `.rundock/extensions/${NAME}`,
  }] }, null, 2) + '\n');
  write(workspace, `.rundock/extensions/${NAME}/rundock.json`, JSON.stringify({ name: NAME, version: '1.0.0', extension: { entry: 'index.js', match: '*.csv' } }));
  write(workspace, `.rundock/extensions/${NAME}/index.js`, ENTRY);
  await page.reload();
  await expect(page.locator('.convo-item').first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const r = window.rundockRendererRegistry;
    return r ? r.rendererFor('bleed/figures.csv').registered : null;
  })).toBe(true);
}

test.afterAll(() => {
  // Leave the shared workspace as other specs expect it: no record claims .csv.
  if (!workspace) return;
  fs.rmSync(path.join(workspace, '.rundock', 'extensions.json'), { force: true });
  fs.rmSync(path.join(workspace, '.rundock', 'extensions', NAME), { recursive: true, force: true });
});

async function setTheme(page, theme) {
  const light = await page.evaluate(() => document.body.classList.contains('light'));
  if ((theme === 'light') !== light) await page.evaluate(() => window.toggleTheme());
  await expect.poll(() => page.evaluate(() => document.body.classList.contains('light'))).toBe(theme === 'light');
}

async function open(page, file) {
  await page.evaluate((f) => window.openWorkspaceFilePath(f), file);
}

// The painted colour at a page point, read off a real screenshot.
async function pixel(page, x, y) {
  const png = await page.screenshot({ clip: { x: Math.round(x), y: Math.round(y), width: 1, height: 1 } });
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = 1; c.height = 1;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)];
  }, png.toString('base64'));
}

// Where the first line of visible text starts inside a root, in its own
// document's coordinates.
const FIRST_TEXT = (root) => {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.textContent.trim() && n.parentElement && n.parentElement.offsetParent !== null ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
  });
  const node = walker.nextNode();
  const range = root.ownerDocument.createRange();
  range.selectNodeContents(node);
  const r = range.getClientRects()[0];
  return { x: r.left, y: r.top };
};

for (const theme of ['dark', 'light']) {
  test(`an extension view is the pane, not a box inside it (${theme})`, async ({ page }) => {
    await setUp(page);
    await setTheme(page, theme);

    await open(page, 'bleed/Plain bleed note.md');
    const note = page.locator('#tiptap-editor-pane:not(.hidden) .ProseMirror');
    await expect(note).toContainText('first line of a plain note');
    const noteFirst = await note.evaluate(FIRST_TEXT);
    const notePane = await page.locator('#tiptap-editor-pane').boundingBox();
    // Inside the right-hand padding, partway down: the pane and nothing else.
    const px = notePane.x + notePane.width - 20;
    const py = notePane.y + 400;
    const paneColour = await pixel(page, px, py);

    await open(page, 'bleed/figures.csv');
    const frameLoc = page.locator('#editor-content.extension-pane > iframe.extension-frame');
    await expect(frameLoc).toHaveCount(1);
    const inner = page.frameLocator('#editor-content > iframe.extension-frame');
    await expect(inner.locator('#first')).toHaveText('The first line of the view.');
    await page.waitForTimeout(300);
    const pane = await page.locator('#editor-content').boundingBox();
    const frame = await frameLoc.boundingBox();
    const padding = await page.locator('#editor-content').evaluate((el) => getComputedStyle(el).padding);
    const first = await inner.locator('body').evaluate(FIRST_TEXT);

    expect(padding, 'the pane an extension holds has no padding').toBe('0px');
    expect(Math.abs(frame.x - pane.x), 'frame and pane share their left edge').toBeLessThanOrEqual(0.5);
    expect(Math.abs(frame.y - pane.y), 'and their top edge').toBeLessThanOrEqual(0.5);
    expect(Math.abs(frame.width - pane.width), 'the frame spans the pane').toBeLessThanOrEqual(0.5);
    expect(frame.height, 'and fills it top to bottom though the view asked for 200px').toBeGreaterThanOrEqual(pane.height - 0.5);
    expect(await pixel(page, px, py), 'frame and pane paint identical pixels').toEqual(paneColour);
    expect(Math.abs((frame.x + first.x) - noteFirst.x), 'the view\'s first line starts where a note\'s does').toBeLessThanOrEqual(0.5);
  });

  test(`an embedded view paints its panel's surface with no inner box (${theme})`, async ({ page }) => {
    await setUp(page);
    await setTheme(page, theme);
    await open(page, 'bleed/Embed bleed note.md');
    const frameLoc = page.locator('.embed-body > iframe.extension-frame');
    await expect(frameLoc).toHaveCount(1);
    const inner = page.frameLocator('.embed-body > iframe.extension-frame');
    await expect(inner.locator('#first')).toHaveText('The first line of the view.');
    await page.waitForTimeout(300);

    const panel = await page.locator('.embed-panel').evaluate((el) => getComputedStyle(el).backgroundColor);
    const doc = await inner.locator('body').evaluate((b) => ({
      embedded: b.classList.contains('rundock-embedded'),
      padding: getComputedStyle(b).padding,
      body: getComputedStyle(b).backgroundColor,
      html: getComputedStyle(document.documentElement).backgroundColor,
    }));
    const frameStyle = await frameLoc.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { background: cs.backgroundColor, border: cs.borderTopWidth, radius: cs.borderTopLeftRadius, padding: cs.padding };
    });
    expect(doc.embedded, 'the host told the view it is embedded').toBe(true);
    expect(doc.padding, 'the embedded document adds no padding of its own').toBe('0px');
    expect(doc.body, 'the embedded document paints the panel surface').toBe(panel);
    expect(doc.html, 'all the way to its edges').toBe(panel);
    expect(frameStyle).toEqual({ background: panel, border: '0px', radius: '0px', padding: '0px' });

    // Pixels: a blank point inside the frame, and one in the panel's own
    // padding beside it, are the same colour. Any inner box would differ.
    const body = await page.locator('.embed-body').boundingBox();
    const frame = await frameLoc.boundingBox();
    expect(Math.abs(frame.x - (body.x + 10)), 'the frame starts at the panel body\'s content edge').toBeLessThanOrEqual(0.5);
    const inside = await pixel(page, frame.x + frame.width - 12, frame.y + frame.height - 12);
    const beside = await pixel(page, body.x + 4, frame.y + frame.height - 12);
    expect(inside, 'the frame and the panel around it paint identical pixels').toEqual(beside);
  });
}

// The opt-out, and a view's own padding, in the real app. The frame
// still fills the pane edge to edge; only where the view's content starts
// moves, to exactly where the view asked.
for (const theme of ['dark', 'light']) {
  test(`a view can opt out to an edge-to-edge canvas, or set its own padding (${theme})`, async ({ page }) => {
    await setUp(page);
    await setTheme(page, theme);
    const placement = async (file) => {
      await open(page, file);
      const frameLoc = page.locator('#editor-content.extension-pane > iframe.extension-frame');
      await expect(frameLoc).toHaveCount(1);
      const inner = page.frameLocator('#editor-content > iframe.extension-frame');
      await expect(inner.locator('#first')).toHaveText('The first line of the view.');
      await page.waitForTimeout(300);
      const pane = await page.locator('#editor-content').boundingBox();
      const frame = await frameLoc.boundingBox();
      const first = await inner.locator('#first').evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top, padding: getComputedStyle(document.body).padding, bleed: document.body.classList.contains('rundock-full-bleed') };
      });
      return { pane, frame, first };
    };

    const edge = await placement('bleed/edge.csv');
    expect(edge.first.bleed, 'the view set the documented opt-out').toBe(true);
    expect(edge.first.padding, 'the opt-out takes the body padding to zero').toBe('0px');
    expect(Math.abs(edge.frame.x - edge.pane.x) + Math.abs(edge.frame.y - edge.pane.y), 'the frame still fills the pane').toBeLessThanOrEqual(0.5);
    expect(Math.abs(edge.first.x) + Math.abs(edge.first.y), 'content starts at the frame\'s own corner').toBeLessThanOrEqual(0.5);

    const own = await placement('bleed/own.csv');
    expect(own.first.bleed).toBe(false);
    expect(own.first.padding, 'a view\'s own body padding wins over the floor').toBe('8px 12px');
    expect(Math.abs(own.frame.x - own.pane.x) + Math.abs(own.frame.y - own.pane.y), 'the frame still fills the pane').toBeLessThanOrEqual(0.5);
    expect(Math.abs(own.first.x - 12), 'content starts where the view put it, 12px in').toBeLessThanOrEqual(0.5);
    expect(Math.abs(own.first.y - 8), 'and 8px down').toBeLessThanOrEqual(0.5);
  });
}
