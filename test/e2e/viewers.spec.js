'use strict';
// E2E: the file-type registry's view surfaces (FV2 phase 1).
//
// Browser-driven proof for every rendering claim: the sandboxed HTML
// artifact preview (script must NOT run), the Preview/Code toggle, the
// image viewer over the binary endpoint (naturalWidth > 0 proves real
// decoded bytes), the PDF frame, and the cannot-preview fallback.
// Screenshots land in test-results/viewers/ as run evidence.
const base = require('@playwright/test');
const { appendRawCoverage } = require('./coverage.js');

const test = base.test.extend({
  page: async ({ page }, use) => {
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
    await use(page);
    const entries = await page.coverage.stopJSCoverage();
    appendRawCoverage(entries.filter(e => e.url.endsWith('/app.js')));
  },
});
const { expect } = base;

// Both spec files write the lcov summary in afterAll; writeLcov reads the
// full accumulated raw file, so whichever runs last prints the complete
// number (the ratchet reads that final line).
test.afterAll(async () => {
  const { writeLcov } = require('./coverage.js');
  const summary = await writeLcov();
  if (summary) {
    console.log(`\n[client coverage] public/app.js: ${summary.pct.toFixed(1)}% lines (${summary.covered}/${summary.total}) -> ${summary.out}`);
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
  await expect(frame).toHaveAttribute('src', '/workspace-file?path=report.pdf');
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

// ── FV2 phase 2: sidecar comments on the artifact preview ────────────────────

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
