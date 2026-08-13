'use strict';
// E2E configuration for client test coverage.
// One worker, no parallelism: the tests share one stateful server + seeded
// workspace, and several assert cross-view navigation state on that shared
// app instance.
const { defineConfig } = require('@playwright/test');

const PORT = Number(process.env.E2E_PORT || 34517);

module.exports = defineConfig({
  testDir: 'test/e2e',
  // *.tool.js are hand-run instruments, not tests. They live beside the specs
  // because they need the same fixtures and server, but they assert nothing on
  // their own: they capture state for a human to compare across two builds.
  // See test/e2e/style-snapshot.tool.js.
  testIgnore: '**/*.tool.js',
  workers: 1,
  fullyParallel: false,
  // 60s is a ceiling, not a wait: green tests are unaffected (typical spec
  // time is a few seconds) and only a genuinely stuck test takes longer to
  // fail. 30s was exceeded by a healthy spec on a busy runner (2026-08-08,
  // on a PR that changed only PNG assets), which is a false red. No retries:
  // a retry would hide real timing regressions instead of surfacing them.
  timeout: 60_000,
  expect: { timeout: 7_000 },
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    browserName: 'chromium',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node test/e2e/serve.js',
    port: PORT,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
