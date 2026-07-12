'use strict';
// E2E configuration (SR1 client test coverage, stage 1).
// One worker, no parallelism: the tests share one stateful server + seeded
// workspace, and several assert cross-view navigation state on that shared
// app instance.
const { defineConfig } = require('@playwright/test');

const PORT = Number(process.env.E2E_PORT || 34517);

module.exports = defineConfig({
  testDir: 'test/e2e',
  workers: 1,
  fullyParallel: false,
  timeout: 30_000,
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
