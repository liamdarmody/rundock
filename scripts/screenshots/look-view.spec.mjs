// The look-view command. Run from the checkout root:
//
//   npx playwright test --config scripts/screenshots/look-view.config.mjs
//
// It reads .rundock/look-view.json (every option has a default, so the file
// is optional), takes the screenshot and prints where it went. See the
// "Look at one view" section of docs/browser-pass.md.

import fs from 'node:fs';
import path from 'node:path';
import { test } from '@playwright/test';

import { OPTIONS_FILE, parseOptionsText } from './look-view-options.mjs';
import { captureView, REPO_ROOT } from './look-view.mjs';

test('look at one view', async ({ browser }) => {
  const file = path.join(REPO_ROOT, OPTIONS_FILE);
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  let options;
  try {
    options = parseOptionsText(text, { root: REPO_ROOT });
  } catch (err) {
    console.log(`look-view: ${err.message}`);
    throw err;
  }
  console.log(`look-view: ${options.view}, ${options.theme}, ${options.width}x${options.height}${text === null ? ` (no ${OPTIONS_FILE}, using defaults)` : ''}`);
  try {
    const out = await captureView(browser, options, { log: (m) => console.log(`look-view: ${m}`) });
    console.log(`look-view: wrote ${out}`);
  } catch (err) {
    // The plain sentence first, before Playwright's own report of the throw.
    if (err.lookView) console.log(`look-view: ${err.message}`);
    throw err;
  }
});
