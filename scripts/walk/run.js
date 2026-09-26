#!/usr/bin/env node
'use strict';
// The release walk: one command that uses the product before the tag.
//
// Boots server.js from source on a fresh scratch workspace with a scratch
// HOME and the stub runtime first on PATH, drives the real page through
// Playwright over the real socket and HTTP surfaces, installs the two
// example packages from their GitHub tags, and records every step as PASS
// or FAIL with a screenshot. Exit code is non-zero on any FAIL. The report
// lands in .walk/ (ignored), and is what the release runbook says to attach
// to the release pull request.
//
//   npm run walk
//
// It needs network access to GitHub and runs on the release engineer's
// machine, not in CI. Eleven of eighteen defects in the release before this
// stage existed were seams nobody had walked; this is the walk.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { runWalk, buildReport, writeReport } = require('./runner.js');
const { buildSteps } = require('./steps.js');
const { buildWorkspace, SEED } = require('./workspace.js');
const { LEAN_TEAM, CSV_EXTENSION } = require('./repos.js');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, '.walk');
const PORT = Number(process.env.WALK_PORT || 3671);

function git(args) { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim(); }

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const startedAt = new Date().toISOString();
  const serverCommit = git(['rev-parse', 'HEAD']);
  const dirty = git(['status', '--porcelain']).length > 0;

  const { root, workspace, home } = buildWorkspace();
  const stubs = [path.join(ROOT, 'test', 'helpers', 'stub-claude'), path.join(ROOT, 'test', 'helpers', 'stub-codex')].join(path.delimiter);
  const env = {
    ...process.env, WORKSPACE: workspace, PORT: String(PORT), HOME: home, USERPROFILE: home,
    RUNDOCK_ELECTRON: '1', PATH: `${stubs}${path.delimiter}${process.env.PATH}`,
  };
  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });

  const { chromium } = require('@playwright/test');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.setDefaultTimeout(15000);
  const ctx = { page, workspace, home, port: PORT, scratch: path.join(root, 'repos'), seed: SEED };

  console.log(`walk: server ${serverCommit}${dirty ? ' (dirty)' : ''}, workspace ${workspace}`);
  const outcome = await runWalk(buildSteps(), ctx, {
    log: console.log,
    screenshot: async (name) => {
      const file = path.join(OUT, `${name}.png`);
      await page.screenshot({ path: file, timeout: 10000 });
      return path.relative(ROOT, file);
    },
  });

  await browser.close().catch(() => {});
  server.kill();
  const report = buildReport({
    serverCommit, dirty, startedAt, finishedAt: new Date().toISOString(), results: outcome.results,
    tags: { [LEAN_TEAM.repo]: LEAN_TEAM.tag, [CSV_EXTENSION.repo]: CSV_EXTENSION.tag },
  });
  const file = writeReport(fs, OUT, report);
  fs.writeFileSync(path.join(OUT, 'server.log'), serverLog);
  console.log(`\n${outcome.results.length - outcome.failed.length}/${outcome.results.length} steps passed; report at ${path.relative(ROOT, file)}`);
  // A failed walk keeps its workspace, so the disk can be read after the fact.
  if (outcome.failed.length) console.log(`Workspace kept at ${workspace}\nServer log tail:\n` + serverLog.slice(-1500));
  else fs.rmSync(root, { recursive: true, force: true });
  process.exit(outcome.exitCode);
}

main().catch((e) => { console.error(`walk: ${e && e.stack || e}`); process.exit(2); });
