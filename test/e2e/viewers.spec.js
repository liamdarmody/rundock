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
  await expect(iframe).toHaveAttribute('sandbox', '');

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
