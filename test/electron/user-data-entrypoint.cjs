'use strict';
// RUNDOCK_USER_DATA_DIR, proven on the shipped desktop entrypoint. Run with:
//
//   npm run test:user-data:electron
//
// The app is launched on the repository, so package.json's "main"
// (electron/main.js) boots exactly as `npm run electron` does. Nothing of its
// startup is reproduced here: what is read is what the running app reports
// and what it leaves on disk.
//
// ABSOLUTE: a fresh temporary folder, set up as an install past first run.
// Launched through Playwright's Electron driver, as the parity run launches
// it. The running app's app.getPath('userData') must be that folder exactly;
// while it runs, its single-instance lock must be in that folder; a value
// written through the window's own storage bridge must land in that folder;
// and nothing may change in the default profile location.
//
// RELATIVE: the same entrypoint with a relative value, from a throwaway
// working directory. It must exit non-zero and say why; it must never reach
// "App ready" (nothing opens a window before it), announce a window, or start
// its embedded server, which listens on an OS-assigned port, so its start is
// read from the lines the entrypoint prints on the way to it; and nothing may
// appear in the relative folder under the working directory, and nothing may
// change in the default profile location. This case spawns the Electron binary directly,
// the same command without Playwright's debugging switches, because
// Playwright's launch rejects an app that exits during startup and discards
// its exit status, which is the thing being proved.
//
// SAFE BY CONSTRUCTION: the run never launches Rundock unless its default
// profile location provably lives inside the throwaway HOME, so no case, and
// no mutation of the app under test, can touch the person's real profile.
// Every folder is new under the system temporary directory, including HOME
// and the platform's other home variables. Before each case, a probe (a
// two-line Electron app in its own temporary folder, under its own name, no
// Rundock code) asks Electron for appData in that environment. Its answer and
// the throwaway HOME are compared by real path (the real path of the answer's
// nearest existing ancestor), because the system temporary directory is
// reached through a symlink and Electron and the run spell it differently.
// Unless the answer is inside the throwaway HOME, the case stops with a named
// setup failure and Rundock is never launched. The default location, appData
// joined with the package name, is then inside that HOME, and it is checked
// by a read-only snapshot taken before the case and again after it (whether
// it exists, and each entry's relative name, type, size and mtime,
// recursively, listing folders and stating entries but never opening a
// file), which must be identical. Nothing outside the run's own temporary
// folders is ever listed.
//
// Every step is bounded. Exits 0 when every expectation holds and 1
// otherwise, printing a JSON report either way. The report's `failures` names
// each expectation that did not hold (FAIL in
// test/helpers/user-data-entrypoint.js), which is what the mutation harness
// reads.

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('@playwright/test');
const parity = require('../helpers/settings-parity.js');
const entry = require('../helpers/user-data-entrypoint.js');

const ROOT = path.join(__dirname, '..', '..');
const ELECTRON = require('electron');
const DEADLINE_MS = 150000;
const STEP_MS = 20000;
const STORAGE_FILE = 'renderer-storage.json';
// With every home moved to a throwaway folder, macOS has no login keychain to
// find, and Chromium asking for one would put a system dialog in front of an
// unattended run. The mock keychain is Chromium's own switch for this; it
// changes nothing about where the profile is.
const SWITCHES = ['--use-mock-keychain'];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => process.stderr.write(`[user-data] ${m}\n`);

const report = { platform: process.platform, failures: [], absolute: null, relative: null };
const dirs = [];
const handles = [];

let finished = false;
async function finish() {
  if (finished) return;
  finished = true;
  report.pass = report.failures.length === 0;
  for (const close of handles) await bounded(Promise.resolve().then(close), 'closing', 10000).catch(() => {});
  for (const dir of dirs) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
    catch (err) { (report.cleanup = report.cleanup || []).push(`${path.basename(dir)}: ${err.code || err.message}`); }
  }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exit(report.pass ? 0 : 1);
}

function bounded(promise, what, ms = STEP_MS) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: no answer within ${ms / 1000}s`)), ms); })])
    .finally(() => clearTimeout(timer));
}

function tempDir(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

function exists(p) {
  try { fs.lstatSync(p); return true; } catch (e) { return false; }
}

function entries(dir) {
  try { return fs.readdirSync(dir).sort(); } catch (e) { return []; }
}

// A path as the report shows it: relative to the case's throwaway HOME, by
// real path, so no machine path is ever printed.
function shown(p, home) {
  if (typeof p !== 'string') return p;
  const real = entry.realInside(p, home);
  return real ? path.join('HOME', path.relative(fs.realpathSync(home), real)) : '(outside the throwaway HOME)';
}

// Run the Electron binary to its exit, or kill it at the bound. Output is
// every line it printed on either stream.
function runToExit(args, { env, cwd }, ms) {
  return new Promise((resolve) => {
    let output = '';
    let stdout = '';
    let timedOut = false;
    let result = null;
    const child = spawn(ELECTRON, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    handles.push(() => { if (!result) child.kill('SIGKILL'); });
    child.stdout.on('data', (d) => { output += d; stdout += d; });
    child.stderr.on('data', (d) => { output += d; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, ms);
    const done = () => resolve({ exited: !timedOut && result.code !== null, code: result.code, signal: result.signal, output, stdout });
    child.on('error', (e) => { clearTimeout(timer); output += `\n(the binary did not start: ${e.message})`; result = { code: null, signal: null }; done(); });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      result = { code, signal };
      // Helper processes can hold the pipes open for a moment after the main
      // process exits; the output is read once they close, or after a second.
      const flush = setTimeout(done, 1000);
      child.on('close', () => { clearTimeout(flush); done(); });
    });
  });
}

// Where Electron puts the default profile location (appData) in this
// environment, asked of a two-line app that is not Rundock, as its real path.
// Null, with the setup failure named, unless that real path is inside the
// throwaway HOME: the gate every case passes before Rundock is launched.
async function defaultLocation(env, home) {
  const dir = tempDir('userdata-probe-');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'userdata-probe', main: 'main.js' }));
  fs.writeFileSync(path.join(dir, 'main.js'),
    "const { app } = require('electron');\nprocess.stdout.write('\\n' + JSON.stringify({ appData: app.getPath('appData') }) + '\\n');\nprocess.exit(0);\n");
  const run = await runToExit([dir], { env, cwd: dir }, STEP_MS);
  let appData = null;
  for (const line of run.stdout.split('\n')) {
    try { const got = JSON.parse(line); if (got && typeof got.appData === 'string') appData = got.appData; } catch (e) { /* not the answer */ }
  }
  const real = entry.realInside(appData, home);
  if (!real) {
    report.failures.push(`${entry.FAIL.setupDefault} (${appData ? 'it is outside' : 'the probe gave no answer'})`);
    return null;
  }
  return real;
}

// The read-only snapshot of the default location inside the throwaway HOME,
// or null with the setup failure named (by error code only) when it cannot
// be listed.
function snapshotDefault(defaultDir) {
  try { return entry.snapshotFolder(defaultDir); } catch (e) {
    report.failures.push(`${entry.FAIL.setupSnapshot} (${e && e.code || 'error'})`);
    return null;
  }
}

// The app's main window: the one on its own embedded server. A window on
// anything else is the first-run wizard, which means the app did not read the
// setup marker from the profile it was given.
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

function packageAppName() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  return pkg.productName || pkg.name;
}

async function absoluteCase() {
  const fixture = parity.makeFixture();
  dirs.push(fixture.ws, fixture.home);
  const profile = parity.desktopProfile();
  dirs.push(profile);
  const env = entry.launchEnv({ home: fixture.home, ws: fixture.ws, userData: profile });
  const appData = await defaultLocation(env, fixture.home);
  if (!appData) return null;
  const name = packageAppName();
  const defaultDir = path.join(appData, name);
  const before = snapshotDefault(defaultDir);
  if (!before) return null;
  try { execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['claude'], { env, stdio: 'ignore' }); } catch (e) {
    report.failures.push(entry.FAIL.setupClaude);
    return null;
  }

  log('absolute: launching');
  const app = await electron.launch({ executablePath: ELECTRON, args: [...SWITCHES, ROOT], cwd: ROOT, env, timeout: STEP_MS * 3 });
  handles.push(() => bounded(app.close(), 'closing the app', 8000).catch(() => { app.process().kill('SIGKILL'); }));
  const seen = await bounded(app.evaluate(({ app: a }) => ({ userData: a.getPath('userData'), appData: a.getPath('appData'), name: a.getName(), electron: process.versions.electron })), 'the app answering');
  report.electron = seen.electron;
  if (seen.name !== name) report.failures.push(`${entry.FAIL.setupName} (${seen.name})`);
  // Read while the app holds it: the lock is released when the app exits.
  const lockInProfile = exists(path.join(profile, entry.lockName(process.platform)));

  let windowError = null;
  let storageInProfile = false;
  const key = 'userDataEntrypointCheck';
  const value = `written-${process.pid}`;
  try {
    const win = await mainWindow(app);
    await bounded(win.evaluate(([k, v]) => window.electronAPI.storage.set(k, v), [key, value]), "writing through the app's storage");
    const stored = JSON.parse(fs.readFileSync(path.join(profile, STORAGE_FILE), 'utf8'));
    storageInProfile = stored[key] === value;
  } catch (e) {
    windowError = String(e && e.message || e).split('\n')[0];
  }
  const after = snapshotDefault(defaultDir);
  if (!after) return seen.name;
  const defaultChanges = entry.snapshotDiff(before, after);

  report.absolute = {
    userData: seen.userData === profile ? '(exactly the RUNDOCK_USER_DATA_DIR folder)' : shown(seen.userData, fixture.home),
    appName: seen.name,
    lock: lockInProfile ? `${entry.lockName(process.platform)} in the folder` : 'not in the folder',
    storage: storageInProfile ? `${STORAGE_FILE} in the folder carries the value written` : 'not in the folder',
    defaultLocation: shown(defaultDir, fixture.home),
    defaultExisted: before.exists,
    defaultEntries: Object.keys(before.entries).length,
    defaultChanges,
    windowError,
    profileEntries: entries(profile),
  };
  report.failures.push(...entry.judgeAbsolute({ profile, userData: seen.userData, lockInProfile, storageInProfile, defaultChanges, windowError }));
  return seen.name;
}

async function relativeCase(appName) {
  const fixture = parity.makeFixture();
  dirs.push(fixture.ws, fixture.home);
  const cwd = tempDir('userdata-cwd-');
  const env = entry.launchEnv({ home: fixture.home, ws: fixture.ws, userData: entry.RELATIVE_VALUE });
  const appData = await defaultLocation(env, fixture.home);
  if (!appData) return;
  const defaultDir = path.join(appData, appName);
  const before = snapshotDefault(defaultDir);
  if (!before) return;

  log('relative: launching');
  const run = await runToExit([...SWITCHES, ROOT], { env, cwd }, STEP_MS);
  const relativeDir = path.join(cwd, entry.RELATIVE_VALUE);
  const relativeExists = exists(relativeDir);
  const after = snapshotDefault(defaultDir);
  if (!after) return;
  const defaultChanges = entry.snapshotDiff(before, after);

  report.relative = {
    value: entry.RELATIVE_VALUE,
    exited: run.exited,
    exitCode: run.code,
    signal: run.signal,
    seen: entry.startupSeen(run.output),
    lines: run.output.split('\n').filter((l) => /\[Electron\]/.test(l)).map((l) => l.trim()),
    workingDirectory: entries(cwd),
    relativeExists,
    defaultLocation: shown(defaultDir, fixture.home),
    defaultExisted: before.exists,
    defaultEntries: Object.keys(before.entries).length,
    defaultChanges,
  };
  report.failures.push(...entry.judgeRelative({ exited: run.exited, code: run.code, output: run.output, relativeExists, defaultChanges }));
}

async function main() {
  let appName = null;
  try { appName = await absoluteCase(); } catch (e) { report.failures.push(`absolute: the case completed (${String(e && e.message || e).split('\n')[0]})`); }
  try { await relativeCase(appName || packageAppName()); } catch (e) { report.failures.push(`relative: the case completed (${String(e && e.message || e).split('\n')[0]})`); }
}

setTimeout(() => { report.failures.push(`the run finished within ${DEADLINE_MS / 1000}s`); finish(); }, DEADLINE_MS).unref();
process.on('SIGINT', () => { report.failures.push('the run was interrupted'); finish(); });
main().catch((e) => { report.failures.push(`the run completed (${String(e && e.message || e).split('\n')[0]})`); }).then(finish);
