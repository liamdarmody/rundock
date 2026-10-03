'use strict';
// look-view end to end: the contributor screenshot tool boots its own server
// against the demo workspace, photographs one view and shuts everything down.
// This runs it once, on the team chart in dark at a narrow width, so a change
// that breaks the tool fails here rather than the next time someone reaches
// for it. The options rules themselves are unit tested in
// test/unit/look-view-options.test.js.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test('look-view writes a PNG of the team chart in dark at 420 wide', async ({ browser }) => {
  const { normalizeOptions } = await import('../../scripts/screenshots/look-view-options.mjs');
  const { captureView, REPO_ROOT } = await import('../../scripts/screenshots/look-view.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'look-view-e2e-'));
  try {
    const out = path.join(dir, 'team.png');
    const options = normalizeOptions({ view: 'team', theme: 'dark', width: 420, height: 800, out }, { root: REPO_ROOT });
    const written = await captureView(browser, options);
    expect(written).toBe(out);
    const bytes = fs.readFileSync(out);
    expect(bytes.length).toBeGreaterThan(1000);
    expect(bytes.subarray(0, 8).equals(PNG_SIGNATURE), 'a PNG').toBe(true);
    // IHDR width and height, big-endian, at bytes 16 and 20: 420 by 800 at scale 1.
    expect(bytes.readUInt32BE(16)).toBe(420);
    expect(bytes.readUInt32BE(20)).toBe(800);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
