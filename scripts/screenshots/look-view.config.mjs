// Playwright configuration for look-view only. Kept apart from the repo's
// playwright.config.js, which boots the e2e fixture server: look-view boots its
// own server against the demo workspace, inside the spec, and stops it again.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'look-view.spec.mjs',
  workers: 1,
  timeout: 90_000,
  reporter: [['list']],
  // Traces and result folders are for test suites; this writes one picture.
  outputDir: '../../.rundock/scratch/look-view-results',
  use: { browserName: 'chromium', trace: 'off' },
});
