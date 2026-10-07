'use strict';
// Browser and desktop show the same Keep agents inside this workspace row, and
// the same effective state, for the same workspace. Run with:
//
//   npm run test:settings:electron
//
// ONE WORKSPACE, BOTH SURFACES, THE SAME MOMENT:
// - Desktop: the shipped app itself. Electron is launched on the repository,
//   so package.json's "main" (electron/main.js) boots exactly as `npm run
//   electron` does: its own preload and IPC handlers, its own embedded
//   server, its own window. Nothing of the startup is reproduced here, so a
//   change to that wiring changes what this reads. The only inputs are
//   environment variables the app ships with: WORKSPACE, HOME, and
//   RUNDOCK_USER_DATA_DIR (electron/user-data.js), a profile of its own
//   that is set up as an install past first run.
// - Browser: the same server file started in browser mode as a separate
//   process, and the page loaded in Chromium through Playwright, the engine
//   the browser e2e suite uses.
// Before any case, the desktop window must show it is the desktop app: the
// preload's bridge is there and the storage snapshot its main-process
// handler answers came back (BRIDGE in test/helpers/settings-parity.js). Then,
// for each effective state, the files are written once, both pages open
// Permissions the way a person does, and what the row says is compared field
// by field.
//
// Safe by construction: the workspace, HOME and the app's profile are fresh
// folders under the system temporary directory, so the app never takes the
// real app's single-instance lock or reads its state; both servers listen on
// the loopback interface; nothing is clicked beyond opening the pane. The
// desktop window is shown, as the app always shows it.
//
// Exits 0 when every expectation holds and 1 otherwise, printing a JSON report
// either way. The report's `failures` names each expectation that did not
// hold, which is what the mutation harness reads.

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { _electron: electron, chromium } = require('@playwright/test');
const parity = require('../helpers/settings-parity.js');

const ROOT = path.join(__dirname, '..', '..');
const DEADLINE_MS = 180000;
const STEP_MS = 20000;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => process.stderr.write(`[parity] ${m}\n`);

const fixture = parity.makeFixture();
const profile = parity.desktopProfile();
const env = parity.launchEnv(fixture, profile);
const report = { platform: process.platform, workspace: fixture.ws, failures: [], cases: [] };
const handles = [];

// Everything this started is closed, and every folder it made removed,
// before the report is printed and the process exits.
let finished = false;
async function finish() {
  if (finished) return;
  finished = true;
  report.pass = report.failures.length === 0;
  for (const close of handles) await bounded(Promise.resolve().then(close), 'closing', 10000).catch(() => {});
  // The app can still be flushing into these folders for a moment after it
  // closes, so removal retries; a folder that still won't go is reported,
  // never allowed to hide the result.
  for (const dir of [fixture.ws, fixture.home, profile]) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
    catch (err) { (report.cleanup = report.cleanup || []).push(`${dir}: ${err.code || err.message}`); }
  }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exit(report.pass ? 0 : 1);
}

// A step that does not answer (a renderer blocked at load, say) is a failure
// with a name, never a run that waits forever.
function bounded(promise, what, ms = STEP_MS) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: no answer within ${ms / 1000}s`)), ms); })])
    .finally(() => clearTimeout(timer));
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

// The browser-mode server: the same server.js, as `node server.js` runs it.
// Resolves its port and the link it prints, which is how a browser is let
// in (lib/auth): opened once, the browser then has the cookie for the rest
// of the run. The link is held here and never written to the report.
async function startBrowserServer() {
  const port = await freePort();
  const { signInLink } = require('../../scripts/sign-in-link.js');
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: { ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  handles.push(() => { child.kill(); });
  let out = '';
  const link = await bounded(new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { out += String(d); const found = signInLink(out); if (found) resolve(found); });
    child.on('exit', (code) => reject(new Error(`the browser-mode server exited (${code})`)));
  }), 'the browser-mode server printing its link');
  return { port, link };
}

// The app's main window: the one on its own embedded server. A window on
// anything else is the first-run wizard, which means the app did not accept
// the profile as set up.
async function mainWindow(app) {
  const until = Date.now() + STEP_MS * 2;
  while (Date.now() < until) {
    for (const w of app.windows()) {
      if (/^http:\/\/localhost:\d+/.test(w.url())) return w;
      if (/^file:/.test(w.url())) throw new Error(`the app opened its first-run wizard (${path.basename(w.url())}), not its window`);
    }
    await wait(250);
  }
  throw new Error('the app opened no main window');
}

// Poll the page until the row has the server's answer, or give up.
async function snapshot(page) {
  for (let i = 0; i < 60; i += 1) {
    const snap = await bounded(page.evaluate(parity.SNAPSHOT), 'reading the row').catch(() => null);
    if (snap) return snap;
    await wait(250);
  }
  return null;
}

async function readRow(page, load) {
  await bounded(load(), 'loading the page');
  await bounded(page.waitForSelector('.nav-item[data-nav="settings"]'), 'the app rendering');
  await wait(1500);
  await bounded(page.evaluate(parity.OPEN_PERMISSIONS), 'opening Permissions');
  return snapshot(page);
}

async function main() {
  // The app skips its first-run wizard only when it finds the claude CLI,
  // exactly as on a person's machine, so a machine without one is named here
  // rather than read as a wiring failure.
  try { execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['claude'], { env, stdio: 'ignore' }); } catch (e) {
    report.failures.push('setup: the claude CLI is on PATH, so the desktop app starts past its first-run wizard');
    return;
  }

  const app = await electron.launch({ executablePath: require('electron'), args: [ROOT], cwd: ROOT, env, timeout: STEP_MS * 3 });
  handles.push(() => bounded(app.close(), 'closing the app', 8000).catch(() => { app.process().kill(); }));
  report.electron = await bounded(app.evaluate(() => process.versions.electron), 'the app answering');
  let win;
  try { win = await mainWindow(app); } catch (e) { report.failures.push(`desktop: ${e.message}`); return; }

  const bridge = await bounded(win.evaluate(parity.BRIDGE), 'reading the bridge').catch(() => ({ bridge: false, storage: false }));
  report.bridge = bridge;
  if (!bridge.bridge) report.failures.push('desktop: the window carries the app\'s preload bridge');
  if (!bridge.storage) report.failures.push('desktop: the preload\'s storage snapshot comes back from the main process');
  if (report.failures.length) return;

  const { port, link } = await startBrowserServer();
  const browser = await chromium.launch();
  handles.unshift(() => browser.close());
  report.chromium = browser.version();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  // Both windows must be ones the server answers. A window it refuses shows
  // only the line pointing to the link, and every row read through it would
  // be missing for a reason this run is not about, so that is named first.
  const letIn = (p) => bounded(p.evaluate(() => { const so = document.getElementById('signed-out'); return !so || so.hidden; }), 'reading whether the page was let in').catch(() => false);
  let opened = false;
  for (const c of parity.cases()) {
    c.apply(fixture);
    log(`case: ${c.name}`);
    const desktop = await readRow(win, () => win.reload()).catch((e) => { log(`desktop: ${e.message}`); return null; });
    // The first load opens the printed link; after that the browser has the
    // cookie, and the plain address reloads the page as a person's tab would.
    const browserRow = await readRow(page, () => page.goto(opened ? `http://localhost:${port}/` : link)).catch((e) => { log(`browser: ${e.message}`); return null; });
    opened = true;
    if (!(await letIn(win))) report.failures.push('desktop: the server answers the app\'s own window (its main process adds the key)');
    if (!(await letIn(page))) report.failures.push('browser: the server answers a browser opened from the link it printed');
    const differences = parity.compare(desktop, browserRow);
    if (differences.length) report.failures.push(`parity: ${c.name}`);
    report.cases.push({ case: c.name, match: differences.length === 0, differences, desktop, browser: browserRow });
  }
}

setTimeout(() => { report.failures.push(`the run finished within ${DEADLINE_MS / 1000}s`); finish(); }, DEADLINE_MS).unref();
process.on('SIGINT', () => { report.failures.push('the run was interrupted'); finish(); });
main().catch((e) => { report.failures.push(`the run completed (${String(e && e.message || e).split('\n')[0]})`); }).then(finish);
