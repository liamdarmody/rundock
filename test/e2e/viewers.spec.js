'use strict';
// E2E: the file-type registry's view surfaces.
//
// Browser-driven proof for every rendering claim: the sandboxed HTML
// artifact preview (script must NOT run), the Preview/Code toggle, the
// image viewer over the binary endpoint (naturalWidth > 0 proves real
// decoded bytes), the PDF frame, and the cannot-preview fallback.
// Screenshots land in test-results/viewers/ as run evidence.
const base = require('@playwright/test');
const { appendRawCoverage, writeLcov, isClientEntry } = require('./coverage.js');

const test = base.test.extend({
  page: async ({ page }, use) => {
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
    await use(page);
    const entries = await page.coverage.stopJSCoverage();
    appendRawCoverage(entries.filter(e => isClientEntry(e.url)));
  },
});
const { expect } = base;

// Both spec files write the lcov summary in afterAll; writeLcov reads the
// full accumulated raw file, so whichever runs last prints the complete
// numbers (the ratchet reads that final block).
test.afterAll(async () => {
  const summary = await writeLcov();
  if (summary) {
    console.log('');
    for (const f of summary.files) {
      console.log(`[client coverage] public/${f.file}: ${f.pct.toFixed(1)}% lines (${f.covered}/${f.total})`);
    }
    console.log(`[client coverage] combined: ${summary.pct.toFixed(1)}% lines (${summary.covered}/${summary.total}) -> ${summary.out}`);
  }
});

const SHOTS = 'test-results/viewers';

async function boot(page) {
  await page.goto('/');
  await expect(page.locator('.convo-item').first()).toBeVisible();
}

async function openFilesView(page) {
  await page.locator('.nav-item[data-nav="files"]').click();
}

async function openFromTree(page, name) {
  await openFilesView(page);
  await page.locator('.file-item', { hasText: name }).first().click();
}

test('HTML artifact renders sandboxed: styles apply, scripts do not run', async ({ page }) => {
  await boot(page);
  await openFromTree(page, 'proposal.html');

  const iframe = page.locator('iframe.viewer-frame');
  await expect(iframe).toBeVisible();
  // allow-same-origin, never allow-scripts: the frame cannot execute code;
  // the host reads it for the review loop.
  await expect(iframe).toHaveAttribute('sandbox', 'allow-same-origin');

  const frame = page.frameLocator('iframe.viewer-frame');
  // Script suppressed: the headline keeps its authored text.
  await expect(frame.locator('#headline')).toHaveText('Quarterly Proposal');
  await expect(frame.locator('.stat')).toHaveText('Three workstreams');
  // The artifact's own CSS applied (not the app's): authored background.
  const bg = await frame.locator('body').evaluate(el => getComputedStyle(el).backgroundColor);
  expect(bg).toBe('rgb(18, 53, 91)');

  await page.screenshot({ path: `${SHOTS}/html-artifact-preview.png` });
});

test('Preview/Code toggle: code view shows raw source, preview remounts the frame', async ({ page }) => {
  await boot(page);
  await openFromTree(page, 'proposal.html');
  await expect(page.locator('iframe.viewer-frame')).toBeVisible();

  await page.locator('#toggle-edit').click();
  const textarea = page.locator('#editor-textarea');
  await expect(textarea).toBeVisible();
  await expect(page.locator('iframe.viewer-frame')).toHaveCount(0);
  expect(await textarea.inputValue()).toContain('<script>');
  await page.screenshot({ path: `${SHOTS}/html-artifact-code-view.png` });

  await page.locator('#toggle-preview').click();
  await expect(page.locator('iframe.viewer-frame')).toBeVisible();
  await expect(textarea).toBeHidden();
});

test('image opens as a real decoded image over the binary endpoint; toggles hidden', async ({ page }) => {
  await boot(page);
  await openFromTree(page, 'chart.png');

  const img = page.locator('.viewer-image-wrap img');
  await expect(img).toBeVisible();
  await expect(img).toHaveAttribute('src', '/workspace-file?path=chart.png');
  const naturalWidth = await img.evaluate(el => el.naturalWidth);
  expect(naturalWidth).toBe(8); // decoded, not utf-8-mangled
  await expect(page.locator('#toggle-preview')).toBeHidden();
  await expect(page.locator('#toggle-edit')).toBeHidden();
  await page.screenshot({ path: `${SHOTS}/image-viewer.png` });
});

test('PDF opens in a frame over the binary endpoint', async ({ page }) => {
  await boot(page);
  await openFromTree(page, 'report.pdf');
  const frame = page.locator('iframe.viewer-frame');
  await expect(frame).toBeVisible();
  // Opens with the pages/thumbnails panel collapsed so it does not steal
  // reading width (navpanes=0).
  await expect(frame).toHaveAttribute('src', '/workspace-file?path=report.pdf#navpanes=0');
  // The endpoint really serves the bytes with the pinned content type.
  const res = await page.request.get('/workspace-file?path=report.pdf');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toBe('application/pdf');
  expect((await res.body()).subarray(0, 5).toString()).toBe('%PDF-');
  await page.screenshot({ path: `${SHOTS}/pdf-viewer.png` });
});

test('unsupported binary types get the cannot-preview state, never raw bytes', async ({ page }) => {
  await boot(page);
  await openFilesView(page);
  // No unsupported type is clickable from the tree today (the tree lists
  // only viewable types); wikilinks in conversations will route here after
  // the sync-point commit. Drive the dispatch directly.
  await page.evaluate(() => loadFileContent('archive.zip', 'PK mangled bytes'));
  await expect(page.locator('.viewer-unsupported')).toBeVisible();
  await expect(page.locator('.viewer-unsupported')).toContainText('Cannot preview this file');
  await expect(page.locator('.viewer-unsupported')).toContainText('.zip');
  const paneText = await page.locator('#editor-content').textContent();
  expect(paneText).not.toContain('PK');
  await page.screenshot({ path: `${SHOTS}/unsupported-fallback.png` });
});

// ── Sidecar comments on the artifact preview ────────────────────

async function selectInFrame(page, selector) {
  // The review loop attaches asynchronously (sidecar fetch + frame load);
  // selecting before its selectionchange listener exists would never show
  // the button. The button's presence in the pane marks attachment.
  await page.waitForSelector('.artifact-comment-btn', { state: 'attached' });
  // Real selection inside the sandboxed frame (allow-same-origin, no
  // scripts), via the frame's own Selection API.
  await page.evaluate((sel) => {
    const iframe = document.querySelector('iframe.viewer-frame');
    const doc = iframe.contentDocument;
    const el = doc.querySelector(sel);
    const range = doc.createRange();
    range.selectNodeContents(el);
    const selection = doc.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }, selector);
}

test('commenting on SVG text keeps the text visible (tspan wrap, not a mark)', async ({ page }) => {
  await boot(page);
  await openFromTree(page, 'diagram.svg');
  await expect(page.locator('iframe.viewer-frame')).toBeVisible();
  await selectInFrame(page, '#label');
  await expect(page.locator('.artifact-comment-btn')).toBeVisible();
  await page.locator('.artifact-comment-btn').dispatchEvent('mousedown');
  const composer = page.locator('.review-composer');
  await expect(composer).toBeVisible();
  await composer.locator('textarea').fill('Rename this label');
  await composer.locator('textarea').press('Enter');
  await expect(page.locator('.review-card.comment')).toHaveCount(1);
  const frame = page.frameLocator('iframe.viewer-frame');
  // The commented run is wrapped in a <tspan> (SVG renders it) with the text
  // still present, never a <mark> (which would make SVG text vanish).
  await expect(frame.locator('tspan[data-rundock-review]')).toHaveText('Architecture diagram label');
  await expect(frame.locator('mark[data-rundock-review]')).toHaveCount(0);
  await expect(frame.locator('text#label')).toBeVisible();
});

test('comment on an artifact: select, comment, sidecar written, reload re-anchors, resolve hands back', async ({ page }) => {
  await boot(page);
  await openFromTree(page, 'proposal.html');
  await expect(page.locator('iframe.viewer-frame')).toBeVisible();

  // Select the stat line in the frame; the floating Comment button appears.
  await selectInFrame(page, '.stat');
  const btn = page.locator('.artifact-comment-btn');
  await expect(btn).toBeVisible();

  // Compose and submit an anchored comment.
  await btn.dispatchEvent('mousedown');
  const composer = page.locator('.review-composer');
  await expect(composer).toBeVisible();
  await expect(composer.locator('.review-quote')).toHaveText('Three workstreams');
  await composer.locator('textarea').fill('Make this four workstreams');
  await composer.locator('textarea').press('Enter');

  // Card renders; the passage is marked in the frame.
  const card = page.locator('.review-card.comment');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('Make this four workstreams');
  await expect(card.locator('.review-quote')).toContainText('Three workstreams');
  const frame = page.frameLocator('iframe.viewer-frame');
  await expect(frame.locator('mark[data-rundock-review]')).toHaveText('Three workstreams');

  // Panel layout parity with the editor pane (regression: .viewer-host's
  // zero padding once left the panel flush to the top, 8px past the right
  // edge, and scrolling the pane horizontally by those same 8px).
  const layout = await page.evaluate(() => {
    const pane = document.getElementById('editor-content');
    const sidebarRect = pane.querySelector('.review-sidebar').getBoundingClientRect();
    const paneRect = pane.getBoundingClientRect();
    return {
      topGap: sidebarRect.top - paneRect.top,
      rightGap: paneRect.right - sidebarRect.right,
      scrollWidth: pane.scrollWidth,
      clientWidth: pane.clientWidth,
    };
  });
  expect(layout.topGap).toBe(24); // same resting box as the markdown editor's panel
  expect(layout.rightGap).toBe(24);
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth); // no horizontal scroll
  await page.screenshot({ path: `${SHOTS}/artifact-comment.png` });

  // The sidecar is on disk, openly stored, discoverable by path.
  const { sidecarPathFor } = await import('../../public/viewers/sidecar-controller.js');
  const sidecarPath = sidecarPathFor('proposal.html');
  const res = await page.request.get('/api/file?path=' + encodeURIComponent(sidecarPath));
  expect(res.status()).toBe(200);
  const sidecar = JSON.parse(await res.text());
  expect(sidecar.path).toBe('proposal.html');
  expect(sidecar.comments.c1.quote).toBe('Three workstreams');
  expect(sidecar.comments.c1.body).toBe('Make this four workstreams');

  // Full reload: the comment re-anchors from the sidecar.
  await page.reload();
  await expect(page.locator('.convo-item').first()).toBeVisible();
  await openFromTree(page, 'proposal.html');
  await expect(page.locator('.review-card.comment')).toContainText('Make this four workstreams');
  await expect(frame.locator('mark[data-rundock-review]')).toHaveText('Three workstreams');

  // Resolve: card leaves, audit trail persists with resolved: true.
  await page.locator('.review-card .review-btn.resolve').click();
  await expect(page.locator('.review-card.comment')).toHaveCount(0);
  await expect.poll(async () => {
    const r = await page.request.get('/api/file?path=' + encodeURIComponent(sidecarPath));
    return JSON.parse(await r.text()).comments.c1.resolved;
  }).toBe(true);
});

test('a comment survives a Preview/Code toggle and re-anchors on remount', async ({ page }) => {
  await boot(page);
  // Dedicated artifact so its sidecar cannot accumulate across tests.
  await page.evaluate(() => new Promise((resolve) => {
    ws.send(JSON.stringify({ type: 'save_file', path: 'toggle-art.html', content: '<html><body><p class="stat">Three workstreams</p></body></html>' }));
    setTimeout(resolve, 300);
  }));
  await openFilesView(page);
  await page.evaluate(() => { ws.send(JSON.stringify({ type: 'read_file', path: 'toggle-art.html' })); });
  await expect(page.locator('iframe.viewer-frame')).toBeVisible();
  await selectInFrame(page, '.stat');
  await page.locator('.artifact-comment-btn').dispatchEvent('mousedown');
  await page.locator('.review-composer textarea').fill('toggle note');
  await page.locator('.review-composer textarea').press('Enter');
  await expect(page.locator('.review-card.comment')).toHaveCount(1);
  await expect(page.frameLocator('iframe.viewer-frame').locator('mark[data-rundock-review]')).toHaveText('Three workstreams');
  // Toggle to Code and back to Preview: the review must re-attach and re-anchor.
  await page.locator('#toggle-edit').click();
  await expect(page.locator('#editor-textarea')).toBeVisible();
  await page.locator('#toggle-preview').click();
  await expect(page.locator('iframe.viewer-frame')).toBeVisible();
  await expect(page.locator('.review-card.comment')).toHaveCount(1);
  await expect(page.frameLocator('iframe.viewer-frame').locator('mark[data-rundock-review]')).toHaveText('Three workstreams');
});

test('two comments on one artifact both render and mark independently', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => new Promise((resolve) => {
    ws.send(JSON.stringify({ type: 'save_file', path: 'multi-art.html', content: '<html><body><p id="a">Alpha passage</p><p id="b">Beta passage</p></body></html>' }));
    setTimeout(resolve, 300);
  }));
  await openFilesView(page);
  await page.evaluate(() => { ws.send(JSON.stringify({ type: 'read_file', path: 'multi-art.html' })); });
  await expect(page.locator('iframe.viewer-frame')).toBeVisible();
  await selectInFrame(page, '#a');
  await page.locator('.artifact-comment-btn').dispatchEvent('mousedown');
  await page.locator('.review-composer textarea').fill('first');
  await page.locator('.review-composer textarea').press('Enter');
  await expect(page.locator('.review-card.comment')).toHaveCount(1);
  await selectInFrame(page, '#b');
  await page.locator('.artifact-comment-btn').dispatchEvent('mousedown');
  await page.locator('.review-composer textarea').fill('second');
  await page.locator('.review-composer textarea').press('Enter');
  await expect(page.locator('.review-card.comment')).toHaveCount(2);
  await expect(page.frameLocator('iframe.viewer-frame').locator('mark[data-rundock-review]')).toHaveCount(2);
});

test('a comment re-anchors when a live external change keeps the quoted passage', async ({ page }) => {
  await boot(page);
  // Dedicated artifact so the live change cannot disturb other tests.
  await page.evaluate(() => new Promise((resolve) => {
    ws.send(JSON.stringify({ type: 'save_file', path: 'live-artifact.html', content: '<html><body><p id="p">Keep this exact passage here.</p><p>filler</p></body></html>' }));
    setTimeout(resolve, 300);
  }));
  await openFilesView(page);
  await page.evaluate(() => { ws.send(JSON.stringify({ type: 'read_file', path: 'live-artifact.html' })); });
  await expect(page.locator('iframe.viewer-frame')).toBeVisible();
  await selectInFrame(page, '#p');
  await page.locator('.artifact-comment-btn').dispatchEvent('mousedown');
  await page.locator('.review-composer textarea').fill('live note');
  await page.locator('.review-composer textarea').press('Enter');
  await expect(page.locator('.review-card.comment')).toHaveCount(1);
  // An external tool changes the file but keeps the quoted passage. The live
  // watcher pushes the change; the comment must re-anchor, not vanish.
  await page.evaluate(() => {
    ws.send(JSON.stringify({ type: 'save_file', path: 'live-artifact.html', content: '<html><body><h1>New heading</h1><p id="p">Keep this exact passage here.</p></body></html>' }));
  });
  await expect(page.frameLocator('iframe.viewer-frame').locator('h1')).toHaveText('New heading'); // refreshed
  await expect(page.locator('.review-card.comment')).toHaveCount(1);
  await expect(page.frameLocator('iframe.viewer-frame').locator('mark[data-rundock-review]')).toHaveText('Keep this exact passage here.');
});

test('an anchor whose passage was edited away lists as orphaned, never dropped', async ({ page }) => {
  await boot(page);
  // A dedicated artifact so this test cannot interfere with the flow above.
  await page.evaluate(() => new Promise((resolve) => {
    ws.send(JSON.stringify({ type: 'save_file', path: 'orphan-demo.html', content: '<html><body><p id="target">Delete this passage soon.</p><p>Stable text.</p></body></html>' }));
    setTimeout(resolve, 300);
  }));
  await openFilesView(page);
  await page.evaluate(() => { ws.send(JSON.stringify({ type: 'read_file', path: 'orphan-demo.html' })); });
  await expect(page.locator('iframe.viewer-frame')).toBeVisible();

  await selectInFrame(page, '#target');
  await page.locator('.artifact-comment-btn').dispatchEvent('mousedown');
  await page.locator('.review-composer textarea').fill('anchored to a doomed passage');
  await page.locator('.review-composer textarea').press('Enter');
  await expect(page.locator('.review-card.comment')).toHaveCount(1);

  // The passage disappears from the file (an agent rewrite, in real life).
  await page.evaluate(() => new Promise((resolve) => {
    ws.send(JSON.stringify({ type: 'save_file', path: 'orphan-demo.html', content: '<html><body><p>Rewritten entirely.</p><p>Stable text.</p></body></html>' }));
    setTimeout(resolve, 300);
  }));
  await page.evaluate(() => { ws.send(JSON.stringify({ type: 'read_file', path: 'orphan-demo.html' })); });

  const card = page.locator('.review-card.comment');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('anchored to a doomed passage');
  await expect(card.locator('.review-badge.orphaned')).toHaveText('Orphaned');
  const frame = page.frameLocator('iframe.viewer-frame');
  await expect(frame.locator('mark[data-rundock-review]')).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/artifact-orphan.png` });
});

test('a multi-paragraph comment is geometry-neutral: paragraph gaps unchanged', async ({ page }) => {
  await boot(page);
  // A dedicated artifact whose paragraphs are separated by real formatting
  // whitespace (newline + indentation), as authored HTML always is.
  await page.evaluate(() => new Promise((resolve) => {
    ws.send(JSON.stringify({ type: 'save_file', path: 'gap-demo.html', content: [
      '<html><body>',
      '  <p id="p1">First paragraph of the proposal, long enough to select across.</p>',
      '  <p id="p2">Second paragraph continues the argument in more detail.</p>',
      '  <p id="p3">Third paragraph is a stable control below the selection.</p>',
      '</body></html>',
    ].join('\n') }));
    setTimeout(resolve, 300);
  }));
  await openFilesView(page);
  await page.evaluate(() => { ws.send(JSON.stringify({ type: 'read_file', path: 'gap-demo.html' })); });
  await expect(page.locator('iframe.viewer-frame')).toBeVisible();
  await page.waitForSelector('.artifact-comment-btn', { state: 'attached' });

  // Bounding boxes are only trustworthy in a visible document (a hidden
  // page can skip layout), so the measurement refuses to run otherwise.
  const measure = () => page.evaluate(() => {
    if (document.visibilityState !== 'visible') return null;
    const doc = document.querySelector('iframe.viewer-frame').contentDocument;
    const r = (id) => doc.getElementById(id).getBoundingClientRect();
    const [a, b, c] = [r('p1'), r('p2'), r('p3')];
    return { gap12: b.top - a.bottom, gap23: c.top - b.bottom };
  });
  const before = await measure();
  expect(before).not.toBeNull();

  // Select from inside p1 to inside p2: the range spans the inter-block
  // whitespace text node between the paragraphs.
  await page.evaluate(() => {
    const doc = document.querySelector('iframe.viewer-frame').contentDocument;
    const range = doc.createRange();
    range.setStart(doc.getElementById('p1').firstChild, 6);
    range.setEnd(doc.getElementById('p2').firstChild, 16);
    const sel = doc.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  });
  await page.locator('.artifact-comment-btn').dispatchEvent('mousedown');
  await page.locator('.review-composer textarea').fill('multi-paragraph note');
  await page.locator('.review-composer textarea').press('Enter');
  await expect(page.locator('.review-card.comment')).toHaveCount(1);
  const frame = page.frameLocator('iframe.viewer-frame');
  // One mark per paragraph; the collapsible whitespace between blocks is
  // never wrapped (a wrap there paints nothing but plants an element).
  await expect(frame.locator('mark[data-rundock-review]')).toHaveCount(2);

  const after = await measure();
  expect(after).not.toBeNull();
  // Geometry-neutral highlight: the vertical gaps between paragraphs are
  // unchanged within 1px (regression: a padded mark wrapped around the
  // inter-block whitespace once inserted a full line box between the
  // commented paragraphs, visibly inflating their spacing).
  expect(Math.abs(after.gap12 - before.gap12)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.gap23 - before.gap23)).toBeLessThanOrEqual(1);
  // Structurally: nothing but the original whitespace text node sits
  // between the commented paragraphs.
  const betweenNodeTypes = await page.evaluate(() => {
    const doc = document.querySelector('iframe.viewer-frame').contentDocument;
    const kinds = [];
    let n = doc.getElementById('p1').nextSibling;
    while (n && n !== doc.getElementById('p2')) { kinds.push(n.nodeType); n = n.nextSibling; }
    return kinds;
  });
  expect(betweenNodeTypes).toEqual([3]); // Node.TEXT_NODE only
  await page.screenshot({ path: `${SHOTS}/artifact-multi-paragraph-gap.png` });
});

// ── Callouts + frontmatter wikilinks ────────────────────────────

test('clicking a callout does not show the inline formatting toolbar', async ({ page }) => {
  await boot(page);
  await openFromTree(page, 'briefing.md');
  const callout = page.locator('.callout.callout-abstract').first();
  await expect(callout).toBeVisible();
  // Clicking a callout selects the atom node; the inline toolbar cannot format
  // it, so it must stay hidden (editing is via the callout's own editor).
  await callout.locator('.callout-line').first().click();
  await page.waitForTimeout(200);
  await expect(page.locator('#tiptap-toolbar')).not.toHaveClass(/\bvisible\b/);
});

test('a callout edits in place and saves byte-honestly', async ({ page }) => {
  await boot(page);
  await openFromTree(page, 'briefing.md');
  const callout = page.locator('.callout.callout-abstract').first();
  await expect(callout).toBeVisible();
  await expect(callout).toContainText('Two meetings, one deadline');
  // Open the in-place editor: the raw callout markdown appears in a textarea.
  await callout.locator('.callout-edit-btn').click();
  const ta = callout.locator('textarea.callout-edit');
  await expect(ta).toBeVisible();
  await expect(ta).toHaveValue(/\[!abstract\]\+ Today at a glance/);
  // Edit the body and commit.
  await ta.fill('> [!abstract]+ Today at a glance\n> Three meetings now.');
  await ta.press('ControlOrMeta+Enter');
  await expect(callout.locator('textarea')).toHaveCount(0);
  await expect(callout).toContainText('Three meetings now');
  await expect(callout).not.toContainText('Two meetings');
  // The edit persists to the file as callout markdown (byte-honest).
  await expect.poll(async () =>
    (await (await page.request.get('/api/file?path=briefing.md')).text())
  ).toContain('> Three meetings now.');
});

test('callouts render as admonition boxes with working fold; frontmatter wikilinks navigate', async ({ page }) => {
  await boot(page);
  await openFromTree(page, 'briefing.md');
  const pane = page.locator('#tiptap-editor-pane');
  await expect(pane).toBeVisible();

  // Fold states: + open, - closed; no literal [!type] or fold chars.
  const folds = pane.locator('details.callout-fold');
  await expect(folds).toHaveCount(3); // abstract+, warning-, and the nested note- (in DOM even while its parent is closed)
  await expect(folds.nth(0)).toHaveAttribute('open', /.*/);
  await expect(folds.nth(0)).toContainText('Today at a glance');
  await expect(folds.nth(1)).not.toHaveAttribute('open', /.*/);
  const paneText = await pane.textContent();
  expect(paneText).not.toContain('[!abstract]');
  expect(paneText).not.toContain('[!warning]');

  // Clicking the closed callout's header expands it, revealing the nested box.
  await folds.nth(1).locator('summary').first().click();
  await expect(folds.nth(1)).toHaveAttribute('open', /.*/);
  await expect(pane.locator('.callout-nested details.callout-fold')).toBeVisible();
  await expect(pane.locator('.callout-nested')).toContainText('Context');
  await page.screenshot({ path: `${SHOTS}/callouts-rendered.png` });

  // Frontmatter wikilinks: the live one navigates, the missing one is dead.
  const live = page.locator('a.prop-wikilink:not(.dead)', { hasText: 'Roadmap-2026' });
  const dead = page.locator('a.prop-wikilink.dead', { hasText: 'Missing Note' });
  await expect(live).toBeVisible();
  await expect(dead).toBeVisible();
  await live.click();
  await expect(page.locator('#editor-filename')).toHaveText('Roadmap-2026.md');
});

test('a wikilink to an image or PDF in a conversation opens the real viewer', async ({ page }) => {
  await boot(page);
  await page.locator('.convo-item', { hasText: 'Export handoff' }).click();
  const link = page.locator('.wikilink', { hasText: 'chart.png' }).first();
  await expect(link).toBeVisible();
  await link.click();
  const img = page.locator('.viewer-image-wrap img');
  await expect(img).toBeVisible();
  expect(await img.evaluate(el => el.naturalWidth)).toBe(8); // the real decoded file, not a chart.png.md dead end

  // Back to the conversation; the PDF link routes to the PDF frame.
  await page.locator('.nav-item[data-nav="conversations"]').click();
  await page.locator('.convo-item', { hasText: 'Export handoff' }).click();
  await page.locator('.wikilink', { hasText: 'report.pdf' }).first().click();
  await expect(page.locator('iframe.viewer-frame')).toHaveAttribute('src', '/workspace-file?path=report.pdf#navpanes=0');
  await page.screenshot({ path: `${SHOTS}/conversation-wikilink-binary.png` });
});

// ── Property editing + external-edit guard ─────────────────────

test('editing frontmatter after switching files edits the current file, not a stale one', async ({ page }) => {
  await boot(page);
  // Open one frontmatter file, then switch to another. The properties panel is
  // a single persistent node; opening the second file must not leave the
  // first file's edit handlers bound to it.
  await openFilesView(page);
  await page.locator('.folder-item', { hasText: 'notes' }).click(); // expand notes/
  await page.locator('.file-item', { hasText: 'pricing-strategy.md' }).click();
  await expect(page.locator('#tiptap-properties.visible')).toBeVisible();
  await openFromTree(page, 'briefing.md');
  const titleRow = page.locator('.prop-row[data-prop-key="title"]');
  await expect(titleRow).toBeVisible();
  await titleRow.locator('.prop-value').click();
  const input = titleRow.locator('input.prop-edit-input');
  await expect(input).toBeVisible();
  // The seed must be THIS file's value, never "undefined" read from the other
  // file's frontmatter through a stale handler.
  await expect(input).toHaveValue('Morning Briefing');
  await input.press('Enter');
  // The panel still reflects the file being edited: its related row survives
  // and the other file's tags row never appears.
  await expect(page.locator('.prop-row[data-prop-key="related"]')).toBeVisible();
  await expect(page.locator('.prop-row[data-prop-key="tags"]')).toHaveCount(0);
});

test('editing a frontmatter property persists byte-honestly to the file', async ({ page }) => {
  await boot(page);
  await openFromTree(page, 'briefing.md');
  const titleRow = page.locator('.prop-row[data-prop-key="title"]');
  await expect(titleRow).toBeVisible();
  await titleRow.locator('.prop-value').click();
  const input = titleRow.locator('input.prop-edit-input');
  await expect(input).toBeVisible();
  await input.fill('Evening Briefing');
  await input.press('Enter');
  await expect(page.locator('.prop-row[data-prop-key="title"]')).toContainText('Evening Briefing');
  // The file on disk: only the title line changed; quotes preserved.
  await expect.poll(async () => {
    const res = await page.request.get('/api/file?path=briefing.md');
    return await res.text();
  }).toContain('title: "Evening Briefing"');
  const after = await (await page.request.get('/api/file?path=briefing.md')).text();
  expect(after).toContain('  - "[[Roadmap-2026]]"'); // untouched neighbour bytes
  expect(after).toContain('> [!abstract]+ Today at a glance'); // body untouched
  await page.screenshot({ path: `${SHOTS}/property-edit.png` });
});

test('an external edit while typing produces reload-theirs/keep-mine, never a silent overwrite', async ({ page }) => {
  await boot(page);
  await openFromTree(page, 'Roadmap-2026.md');
  await expect(page.locator('#tiptap-editor-pane')).toBeVisible();

  // The user starts typing.
  await page.locator('#tiptap-editor .ProseMirror').click();
  await page.keyboard.type('My local addition. ');

  // Meanwhile the file changes outside the editor (an agent or Obsidian).
  await page.evaluate(() => {
    ws.send(JSON.stringify({ type: 'save_file', path: 'Roadmap-2026.md', content: '# Roadmap 2026\n\nEdited elsewhere while Rundock was open.\n' }));
  });

  // The next auto-save must surface the choice instead of overwriting.
  await page.keyboard.type('More typing triggers the save.');
  const banner = page.locator('#external-edit-banner');
  await expect(banner).toBeVisible({ timeout: 10000 });
  await page.screenshot({ path: `${SHOTS}/external-edit-banner.png` });

  // Reload theirs: the external content wins and renders.
  await banner.locator('[data-choice="theirs"]').click();
  await expect(banner).toHaveCount(0);
  await expect(page.locator('#tiptap-editor-pane')).toContainText('Edited elsewhere while Rundock was open.');

  // And the disk was never clobbered by the local edit.
  const disk = await (await page.request.get('/api/file?path=Roadmap-2026.md')).text();
  expect(disk).not.toContain('My local addition');
});

test('normal editing never shows the conflict banner (zero false positives)', async ({ page }) => {
  await boot(page);
  await openFromTree(page, 'CLAUDE.md');
  await page.locator('#tiptap-editor .ProseMirror').click();
  await page.keyboard.type('A quiet edit. ');
  // Wait past the autosave debounce and confirm a clean save.
  await expect(page.locator('#editor-status')).toHaveText('Saved', { timeout: 10000 });
  await expect(page.locator('#external-edit-banner')).toHaveCount(0);
  // A second edit after our own save is also quiet (the baseline moved).
  await page.keyboard.type('Another. ');
  await expect(page.locator('#editor-status')).toHaveText('Saved', { timeout: 10000 });
  await expect(page.locator('#external-edit-banner')).toHaveCount(0);
});

test('in-view find matches inside the sandboxed artifact preview', async ({ page }) => {
  await boot(page);
  await openFromTree(page, 'findable.html');
  // Preview mode by default: the rendered body lives in the sandboxed iframe.
  await expect(page.locator('iframe.viewer-frame')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+f');
  await expect(page.locator('#find-bar')).toBeVisible();
  await page.locator('#find-input').fill('needle');
  // Three occurrences in the rendered body (markup/attributes never counted).
  await expect(page.locator('#find-count')).toHaveText('1 of 3');
  await page.locator('#find-next').click();
  await expect(page.locator('#find-count')).toHaveText('2 of 3');
  // A term that exists only in markup must not match.
  await page.locator('#find-input').fill('doctype');
  await expect(page.locator('#find-count')).toHaveText('No matches');
  await page.screenshot({ path: `${SHOTS}/find-artifact.png` });
});

test('in-view find matches inside the HTML source-edit view', async ({ page }) => {
  await boot(page);
  await openFromTree(page, 'findable.html');
  await page.locator('#toggle-edit').click();
  await expect(page.locator('#editor-textarea')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+f');
  await expect(page.locator('#find-bar')).toBeVisible();
  await page.locator('#find-input').fill('needle');
  // Same three body occurrences; the source view finds them in raw text.
  await expect(page.locator('#find-count')).toHaveText('1 of 3');
  // The matches are visibly highlighted by the overlay behind the textarea
  // (a textarea cannot hold marks and an unfocused selection is not painted).
  await expect(page.locator('.textarea-find-overlay mark.find-hl')).toHaveCount(3);
  await expect(page.locator('.textarea-find-overlay mark.find-hl.current')).toHaveCount(1);
  await page.locator('#find-next').click();
  // Navigation moves the emphasised (current) highlight to the next match.
  await expect(page.locator('#find-count')).toHaveText('2 of 3');
  await expect(page.locator('.textarea-find-overlay mark.find-hl.current')).toHaveText('needle');
  await page.screenshot({ path: `${SHOTS}/find-source-overlay.png` });
  // Closing find removes the overlay entirely.
  await page.keyboard.press('Escape');
  await expect(page.locator('.textarea-find-overlay')).toHaveCount(0);
});

test('in-view find covers the frontmatter properties panel', async ({ page }) => {
  await boot(page);
  await openFromTree(page, 'briefing.md');
  await expect(page.locator('#tiptap-editor-pane')).toBeVisible();
  await expect(page.locator('#tiptap-properties.visible')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+f');
  await expect(page.locator('#find-bar')).toBeVisible();
  // 'Briefing' appears only in the frontmatter title value, not the body
  // (and is stable whether an earlier test left it Morning or Evening). The
  // properties panel lives outside the ProseMirror doc, so this proves the
  // find bar now reaches it.
  await page.locator('#find-input').fill('Briefing');
  await expect(page.locator('#find-count')).toHaveText('1 of 1');
  await expect(page.locator('#tiptap-properties mark.find-match')).toHaveText('Briefing');
});

test('a kanban board file opens as a column board and renders rich cards', async ({ page }) => {
  await boot(page);
  await openFromTree(page, 'board.md');
  // Detected as a board (not the markdown editor) by its frontmatter key.
  await expect(page.locator('.board-lane')).toHaveCount(3);
  await expect(page.locator('#tiptap-editor-pane')).toBeHidden();
  const lanes = page.locator('.board-lane-title');
  await expect(lanes.nth(0)).toHaveText('To do');
  await expect(lanes.nth(1)).toHaveText('Doing');
  await expect(lanes.nth(2)).toHaveText('Done');
  // Cards render styled markdown, not raw syntax.
  await expect(page.locator('.board-card-text strong', { hasText: 'Review' })).toBeVisible();
  await expect(page.locator('.board-card-text a.board-wikilink', { hasText: 'Board' })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/board-view.png` });
});

test('opening a board changes zero bytes; adding a card persists canonical markdown', async ({ page }) => {
  await boot(page);
  const before = await (await page.request.get('/api/file?path=board.md')).text();
  await openFromTree(page, 'board.md');
  await expect(page.locator('.board-lane')).toHaveCount(3);
  // Merely opening a board must not rewrite it.
  const afterOpen = await (await page.request.get('/api/file?path=board.md')).text();
  expect(afterOpen).toBe(before);
  // Add a card to the first lane through the composer.
  await page.locator('.board-lane').first().locator('.board-add-open').click();
  await page.locator('.board-lane').first().locator('.board-add textarea').fill('A brand new card');
  await page.locator('.board-lane').first().locator('.board-add textarea').press('Enter');
  await expect(page.locator('.board-card-text', { hasText: 'A brand new card' })).toBeVisible();
  // The new card persists as a canonical markdown line in the To do lane.
  await expect.poll(async () => (await (await page.request.get('/api/file?path=board.md')).text()))
    .toContain('- [ ] A brand new card');
  const saved = await (await page.request.get('/api/file?path=board.md')).text();
  expect(saved).toContain('## To do\n\n- [ ] Draft the outline\n- [ ] **Review** the brief\n- [ ] A brand new card');
  expect(saved.endsWith('%%')).toBe(true); // no trailing newline: still canonical
});

test('board cards render tag chips and dates, and wikilinks navigate', async ({ page }) => {
  await boot(page);
  await openFromTree(page, 'rich-board.md');
  await expect(page.locator('.board-lane')).toHaveCount(1);
  // Tag chip and date span render (not raw text).
  await expect(page.locator('.board-card-text .board-tag', { hasText: '#launch' })).toBeVisible();
  await expect(page.locator('.board-card-text .board-date', { hasText: '2026-08-01' })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/board-rich-card.png` });
  // Clicking the wikilink navigates to the target file (does not open the card editor).
  await page.locator('.board-card-text a.board-wikilink', { hasText: 'Roadmap-2026' }).click();
  await expect(page.locator('#editor-filename')).toHaveText('Roadmap-2026.md');
  await expect(page.locator('.board-card-editor')).toHaveCount(0);
});

test('cards reorder within a column by dragging onto another card', async ({ page }) => {
  await boot(page);
  await openFromTree(page, 'dnd-board.md');
  await expect(page.locator('.board-card')).toHaveCount(3);
  // Drag Card A onto the bottom half of Card C (insert after) via DnD events.
  await page.evaluate(() => {
    const cards = document.querySelectorAll('.board-card');
    const src = cards[0], tgt = cards[2];
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
    const r = tgt.getBoundingClientRect();
    tgt.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, clientY: r.bottom - 2 }));
    tgt.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
    src.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }));
  });
  // Order in the UI is now B, C, A...
  const texts = await page.locator('.board-card-text').allInnerTexts();
  expect(texts.map(t => t.trim())).toEqual(['Card B', 'Card C', 'Card A']);
  // ...and persisted in that order in the file.
  await expect.poll(async () => {
    const md = await (await page.request.get('/api/file?path=dnd-board.md')).text();
    return md.indexOf('Card B') < md.indexOf('Card C') && md.indexOf('Card C') < md.indexOf('Card A');
  }).toBe(true);
});

test('editing a board in Rundock does not raise a false external-change conflict', async ({ page }) => {
  await boot(page);
  await openFromTree(page, 'watch-board.md');
  await expect(page.locator('.board-lane')).toHaveCount(2);
  // A Rundock edit writes the file; the server watches it and echoes the change
  // back. That echo is our own save and must not be read as an external edit.
  await page.locator('.board-card-check').first().click();
  await page.waitForTimeout(2000); // past the board save + watcher poll interval
  await expect(page.locator('#external-edit-banner')).toHaveCount(0);
});

test('the board card editor shows a selection toolbar with inline formatting only', async ({ page }) => {
  await boot(page);
  await openFromTree(page, 'board.md');
  await expect(page.locator('.board-lane')).toHaveCount(3);
  await page.locator('.board-card-text', { hasText: 'Draft the outline' }).click();
  const editor = page.locator('.board-card-editor .ProseMirror');
  await expect(editor).toBeVisible();
  // The delete control is hidden while editing, even when the card is hovered.
  await page.locator('.board-card.editing').hover();
  await expect(page.locator('.board-card.editing .board-card-controls')).toBeHidden();
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A'); // select the card text
  const toolbar = page.locator('.floating-toolbar.board-card-toolbar.visible');
  await expect(toolbar).toBeVisible();
  // Exactly the inline set: bold, italic, code, link. No headings, no comment.
  await expect(toolbar.locator('.tb-btn')).toHaveCount(4);
  await expect(toolbar.locator('.tb-comment')).toHaveCount(0);
  // Bold via the toolbar formats the selection and persists on save.
  await toolbar.locator('.tb-btn[data-cmd="bold"]').click();
  await expect(editor.locator('strong')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('.board-card-text strong', { hasText: 'Draft the outline' })).toBeVisible();
});

test('a board card edits in place and persists byte-honest markdown', async ({ page }) => {
  await boot(page);
  await openFromTree(page, 'board.md');
  await expect(page.locator('.board-lane')).toHaveCount(3);
  const card = page.locator('.board-card-text', { hasText: 'Draft the outline' });
  await card.click();
  // The card opens in a rich editor (formatting renders as you type).
  const editor = page.locator('.board-card-editor .ProseMirror');
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('Draft the **full** outline'); // input rule bolds "full"
  await expect(editor.locator('strong', { hasText: 'full' })).toBeVisible();
  await page.keyboard.press('Enter'); // Enter saves
  await expect(page.locator('.board-card-text strong', { hasText: 'full' })).toBeVisible();
  // Only that card's line changed; the file stays canonical.
  await expect.poll(async () => (await (await page.request.get('/api/file?path=board.md')).text()))
    .toContain('- [ ] Draft the **full** outline');
  const saved = await (await page.request.get('/api/file?path=board.md')).text();
  expect(saved.endsWith('%%')).toBe(true);
});

test('deleting a board card is undoable in-session', async ({ page }) => {
  await boot(page);
  await openFromTree(page, 'board.md');
  const target = page.locator('.board-card', { hasText: 'Ship it' });
  await target.hover();
  await target.locator('.board-card-ctl').click();
  await expect(page.locator('.board-card', { hasText: 'Ship it' })).toHaveCount(0);
  // Persisted removal...
  await expect.poll(async () => (await (await page.request.get('/api/file?path=board.md')).text()))
    .not.toContain('Ship it');
  // ...but recoverable via the undo toast.
  await page.locator('.board-undo-btn').click();
  await expect(page.locator('.board-card', { hasText: 'Ship it' })).toHaveCount(1);
  await expect.poll(async () => (await (await page.request.get('/api/file?path=board.md')).text()))
    .toContain('- [ ] Ship it');
});

test('a later edit dismisses the undo, so undo never discards interim work', async ({ page }) => {
  await boot(page);
  await openFromTree(page, 'board.md');
  // Delete a card: the undo toast appears.
  const target = page.locator('.board-card', { hasText: 'Ship it' });
  await target.hover();
  await target.locator('.board-card-ctl').click();
  await expect(page.locator('.board-undo-toast')).toBeVisible();
  // Make an unrelated edit (on a card no other test mutates): the stale undo
  // is dismissed, so it can never revert this edit away.
  await page.locator('.board-card-text', { hasText: 'Wire the' }).click();
  const editor = page.locator('.board-card-editor .ProseMirror');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('Wire the whole board');
  await page.keyboard.press('Enter');
  await expect(page.locator('.board-undo-toast')).toHaveCount(0);
  await expect(page.locator('.board-card-text', { hasText: 'Wire the whole board' })).toBeVisible();
});

test('block-style frontmatter on a board survives a save', async ({ page }) => {
  await boot(page);
  await openFromTree(page, 'tagged-board.md');
  await expect(page.locator('.board-lane')).toHaveCount(2);
  // Toggle a checkbox (forces a save) and confirm the block tag list is intact.
  await page.locator('.board-card-check').first().check();
  await expect.poll(async () => (await (await page.request.get('/api/file?path=tagged-board.md')).text()))
    .toContain('tags:\n  - project\n  - kanban');
});

test('a column collapses to a rail and the state persists to the board file', async ({ page }) => {
  await boot(page);
  await openFromTree(page, 'tagged-board.md');
  const firstLane = page.locator('.board-lane').first();
  await expect(firstLane).not.toHaveClass(/collapsed/);
  await firstLane.locator('.board-lane-collapse').click();
  await expect(firstLane).toHaveClass(/collapsed/);
  // Persisted into list-collapse (first lane true).
  await expect.poll(async () => (await (await page.request.get('/api/file?path=tagged-board.md')).text()))
    .toContain('"list-collapse":[true,false]');
  // Clicking the collapsed rail expands it again.
  await firstLane.click();
  await expect(page.locator('.board-lane').first()).not.toHaveClass(/collapsed/);
});

test('the lane menu renames, inserts, and deletes lists with undo', async ({ page }) => {
  await boot(page);
  await openFromTree(page, 'board.md');
  await expect(page.locator('.board-lane')).toHaveCount(3);

  // Rename the first lane via the menu.
  await page.locator('.board-lane').first().locator('.board-lane-menu-btn').click();
  // The menu groups its actions with dividers (identity/insert/sort/destructive).
  await expect(page.locator('.board-lane-popup .board-lane-popup-divider')).toHaveCount(3);
  await page.screenshot({ path: `${SHOTS}/lane-menu-grouped.png` });
  await page.locator('.board-lane-popup-item', { hasText: 'Rename list' }).click();
  const rename = page.locator('input.board-lane-rename');
  await expect(rename).toBeVisible();
  await rename.fill('Icebox');
  await rename.press('Enter');
  await expect(page.locator('.board-lane-title', { hasText: 'Icebox' })).toBeVisible();
  await expect.poll(async () => (await (await page.request.get('/api/file?path=board.md')).text()))
    .toContain('## Icebox');

  // Insert a list after the first, then delete it with undo.
  await page.locator('.board-lane').first().locator('.board-lane-menu-btn').click();
  await page.locator('.board-lane-popup-item', { hasText: 'Insert list after' }).click();
  await expect(page.locator('.board-lane')).toHaveCount(4);
  await page.locator('.board-lane').nth(1).locator('.board-lane-menu-btn').click();
  await page.locator('.board-lane-popup-item', { hasText: 'Delete list' }).click();
  await expect(page.locator('.board-lane')).toHaveCount(3);
  await page.locator('.board-undo-btn').click();
  await expect(page.locator('.board-lane')).toHaveCount(4);
});

test('the lane menu moves a column right, reordering it in the file', async ({ page }) => {
  await boot(page);
  await openFromTree(page, 'reorder-board.md');
  const titles = () => page.locator('.board-lane-title');
  const first = (await titles().nth(0).textContent()) || '';
  const second = (await titles().nth(1).textContent()) || '';
  await page.locator('.board-lane').first().locator('.board-lane-menu-btn').click();
  await page.locator('.board-lane-popup-item', { hasText: 'Move list right' }).click();
  // Order swapped in the UI and in the file heading order.
  await expect(titles().nth(0)).toHaveText(second);
  await expect(titles().nth(1)).toHaveText(first);
  await expect.poll(async () => {
    const md = await (await page.request.get('/api/file?path=reorder-board.md')).text();
    return md.indexOf('## ' + second) < md.indexOf('## ' + first);
  }).toBe(true);
});

test('frontmatter panel: wikilinks are inline links, rows have svg icons', async ({ page }) => {
  await boot(page);
  await openFromTree(page, 'briefing.md');
  await expect(page.locator('#tiptap-properties.visible')).toBeVisible();
  // The related wikilinks render as inline links, not pills.
  await expect(page.locator('#tiptap-properties .prop-link-item')).toHaveCount(2);
  await expect(page.locator('#tiptap-properties .prop-link-item a.prop-wikilink').first()).toBeVisible();
  // Every row carries an svg type icon (not a unicode glyph).
  const iconCount = await page.locator('#tiptap-properties .prop-icon svg').count();
  expect(iconCount).toBeGreaterThanOrEqual(2);
  await page.screenshot({ path: `${SHOTS}/frontmatter-parity.png` });
});

test('the Files + menu creates a note, a board, and a folder', async ({ page }) => {
  await boot(page);
  await openFilesView(page);
  // New note via the header + menu.
  await page.locator('#files-add-btn').click();
  // Each row carries its type icon.
  await expect(page.locator('.files-menu-item svg')).toHaveCount(3);
  await page.locator('.files-menu-item', { hasText: 'New note' }).click();
  await page.locator('.files-menu-field input').fill('Fresh idea');
  await page.locator('.files-menu-field input').press('Enter');
  // It appears in the tree and opens in the editor.
  await expect(page.locator('.file-item', { hasText: 'Fresh idea.md' })).toBeVisible();
  await expect(page.locator('#editor-filename')).toHaveText('Fresh idea.md');

  // New board opens in the board view.
  await page.locator('#files-add-btn').click();
  await page.locator('.files-menu-item', { hasText: 'New board' }).click();
  await page.locator('.files-menu-field input').fill('Sprint');
  await page.locator('.files-menu-field input').press('Enter');
  await expect(page.locator('.file-item', { hasText: 'Sprint.md' })).toBeVisible();
  await expect(page.locator('.board-host')).toBeVisible();

  // New folder appears in the tree.
  await page.locator('#files-add-btn').click();
  await page.locator('.files-menu-item', { hasText: 'New folder' }).click();
  await page.locator('.files-menu-field input').fill('Archive');
  await page.locator('.files-menu-field input').press('Enter');
  await expect(page.locator('.folder-item', { hasText: 'Archive' })).toBeVisible();
});

test('only one floating menu is open at a time and outside clicks close it', async ({ page }) => {
  await boot(page);
  await openFromTree(page, 'board.md'); // files view, board mounted in the pane
  await expect(page.locator('.board-lane')).toHaveCount(3);
  // Open the files "+" menu (lives in the files sidebar header).
  await page.locator('#files-add-btn').click();
  await expect(page.locator('.files-menu')).toBeVisible();
  // Opening a board lane menu dismisses the files menu (single menu open).
  await page.locator('.board-lane-menu-btn').first().click();
  await expect(page.locator('.files-menu')).toHaveCount(0);
  await expect(page.locator('.board-lane-popup')).toBeVisible();
  // Clicking the collapse chevron (which stops propagation) still closes the menu.
  await page.locator('.board-lane-collapse').first().click();
  await expect(page.locator('.board-lane-popup')).toHaveCount(0);
  // Reopen on a still-expanded lane (lane 0 is now collapsed, its button hidden)
  // and confirm a plain outside click (sidebar label) closes it.
  await page.locator('.board-lane-menu-btn').nth(1).click();
  await expect(page.locator('.board-lane-popup')).toBeVisible();
  await page.locator('#sidebar-files .sidebar-label').click();
  await expect(page.locator('.board-lane-popup')).toHaveCount(0);
});

test('board files show the board icon in the tree, notes do not', async ({ page }) => {
  await boot(page);
  await openFilesView(page);
  // The board icon includes a <rect> (kanban); the note icon does not.
  await expect(page.locator('.file-item', { hasText: 'tagged-board.md' }).locator('svg rect')).toHaveCount(1);
  await expect(page.locator('.file-item', { hasText: 'CLAUDE.md' }).locator('svg rect')).toHaveCount(0);
});

test('right-clicking a file row opens a context menu with create and clipboard actions', async ({ page }) => {
  await boot(page);
  await openFromTree(page, 'proposal.html');
  await openFilesView(page);
  await page.locator('.file-item', { hasText: 'proposal.html' }).click({ button: 'right' });
  await expect(page.locator('.files-menu')).toBeVisible();
  await expect(page.locator('.files-menu-item', { hasText: 'New note' })).toBeVisible();
  await expect(page.locator('.files-menu-item', { hasText: 'Copy workspace path' })).toBeVisible();
  await expect(page.locator('.files-menu-item', { hasText: 'Copy wikilink' })).toBeVisible();
  await expect(page.locator('.files-menu-item', { hasText: 'Reveal in Finder' })).toBeVisible();
});

test('an open file persists across a view switch and is revealed in the tree', async ({ page }) => {
  await boot(page);
  await openFilesView(page);
  // Open a nested file, then collapse its folder.
  await page.locator('.folder-item', { hasText: 'notes' }).click();
  await page.locator('.file-item', { hasText: 'pricing-strategy' }).click();
  await expect(page.locator('#tiptap-editor-pane')).toBeVisible();
  await page.locator('.folder-item', { hasText: 'notes' }).click(); // collapse
  // Leave Files for another view, then return.
  await page.locator('.nav-item[data-nav="team"]').click();
  await page.locator('.nav-item[data-nav="files"]').click();
  // The file is still open (not the empty state)...
  await expect(page.locator('#editor-empty')).toBeHidden();
  await expect(page.locator('#tiptap-editor-pane')).toBeVisible();
  // ...and revealed: its folder is expanded again and the row is active.
  await expect(page.locator('.file-item.active', { hasText: 'pricing-strategy' })).toBeVisible();
});

test('the editor back control hides when a file is opened straight from the tree', async ({ page }) => {
  await boot(page);
  await openFromTree(page, 'proposal.html');
  await expect(page.locator('#editor-back')).toBeHidden();
});

test('the editor back control shows when a file was opened from another view', async ({ page }) => {
  await boot(page);
  await openFromTree(page, 'proposal.html');
  await expect(page.locator('#editor-back')).toBeHidden();
  // Opening from Skills sets a return view, so back becomes useful and appears.
  await page.evaluate(() => openSkillFile('CLAUDE.md'));
  await expect(page.locator('#editor-back')).toBeVisible();
});

test('markdown files still open in the rich editor after the registry shim', async ({ page }) => {
  await boot(page);
  await openFromTree(page, 'Roadmap-2026.md');
  await expect(page.locator('#tiptap-editor-pane')).toBeVisible();
  await expect(page.locator('#tiptap-editor-pane')).toContainText('Roadmap 2026');
  await expect(page.locator('iframe.viewer-frame')).toHaveCount(0);
  // Switch md -> image -> md: viewer teardown leaves the editor clean.
  await openFromTree(page, 'chart.png');
  await expect(page.locator('.viewer-image-wrap img')).toBeVisible();
  await openFromTree(page, 'Roadmap-2026.md');
  await expect(page.locator('#tiptap-editor-pane')).toBeVisible();
  await expect(page.locator('.viewer-image-wrap')).toHaveCount(0);
});
