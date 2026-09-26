'use strict';
// Browser and desktop show the same Keep agents inside this workspace row for
// the same workspace. One helper, used by the desktop run
// (test/electron/settings-parity.cjs), which drives both surfaces against one
// workspace at the same moment, and by its unit test, which proves the
// snapshot reads the row and the comparison notices a difference.
//
// SAFE BY CONSTRUCTION: the workspace and the home folder are created under
// the system temporary directory and nothing outside them is written.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

// What a person reads on the row, taken from the rendered page. A string so
// it can be evaluated in any engine: jsdom, Electron's webContents, or a
// Playwright page. Null until the server's status has arrived.
const SNAPSHOT = `(() => {
  const row = document.getElementById('sandbox-row');
  const state = document.getElementById('sandbox-state');
  if (!row || !state || state.textContent === 'Checking\\u2026') return null;
  const first = row.querySelector('.wall-row');
  const sw = first.querySelector('[role="switch"]');
  const notice = document.querySelector('#sandbox-notice-slot .migration-notice span');
  const folders = document.querySelector('#working-folders-block .wf-section-sub');
  return {
    state: state.textContent,
    control: sw ? (sw.checked ? 'switch-on' : 'switch-off') : (first.querySelector('svg.readonly-lock') ? 'lock' : 'none'),
    captions: [...first.querySelectorAll('.sandbox-caption')].map((n) => n.textContent),
    ownership: (first.querySelector('.ownership-note') || { textContent: null }).textContent,
    notice: notice ? notice.textContent : null,
    folders: folders ? folders.textContent : null,
    rows: row.querySelectorAll('.wall-row').length,
  };
})()`;

// Opening the pane the way a person does: Settings in the rail, then
// Permissions in the settings sidebar.
const OPEN_PERMISSIONS = `(() => {
  document.querySelector('.nav-item[data-nav="settings"]').click();
  document.querySelector('.settings-nav-item[data-settings="permissions"]').click();
  return true;
})()`;

function tempDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

// A workspace and a home folder of its own, the workspace already opened by
// an earlier release (mode recorded, no switch stored) so the one-time notice
// is part of what is compared.
function makeFixture() {
  const home = tempDir('parity-home-');
  const ws = tempDir('parity-ws-');
  fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(ws, '.rundock'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'notes.md'), '# Notes\n');
  fs.writeFileSync(path.join(ws, 'CLAUDE.md'), '# Parity\n');
  fs.writeFileSync(path.join(ws, '.rundock', 'state.json'), JSON.stringify({ workspaceMode: 'notes', setupComplete: true }, null, 2));
  return { ws, home };
}

// The three effective states the row distinguishes on macOS, each written to
// disk before both surfaces read it: Rundock's block on, Rundock's block off,
// and Rundock's block off while the project's own settings turn it on.
function cases() {
  const scaffold = require(path.join(ROOT, 'lib', 'workspace', 'scaffold.js'));
  const block = (ws, home, shape) => scaffold.sandboxSettings(ws, 'darwin', home, scaffold.tempRoots(), [], shape);
  const writeLocal = (ws, sandbox) => {
    const file = path.join(ws, '.claude', 'settings.local.json');
    let settings = {};
    try { settings = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (e) { /* none yet */ }
    fs.writeFileSync(file, JSON.stringify({ ...settings, sandbox }, null, 2));
  };
  const project = (ws, value) => {
    const file = path.join(ws, '.claude', 'settings.json');
    if (value === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, JSON.stringify({ sandbox: { enabled: value } }, null, 2));
  };
  return [
    { name: 'Rundock\'s block on', apply: ({ ws, home }) => { writeLocal(ws, block(ws, home, 'on')); project(ws, null); } },
    { name: 'Rundock\'s block off', apply: ({ ws, home }) => { writeLocal(ws, block(ws, home, 'off')); project(ws, null); } },
    { name: 'off, with the project\'s settings turning it on', apply: ({ ws, home }) => { writeLocal(ws, block(ws, home, 'off')); project(ws, true); } },
  ];
}

// Whether the page is the desktop app's: the preload's bridge is there, and
// the storage snapshot it asks the main process for at load came back. Read
// from the desktop window only and never compared, since the browser has
// neither by design; both are wired by electron/main.js (the preload path on
// the window, the handler behind the snapshot), so losing either is the
// desktop wiring broken.
const BRIDGE = `(() => {
  const api = window.electronAPI;
  const snap = api && api.storage ? api.storage.snapshot : undefined;
  return { bridge: !!api, storage: !!snap && typeof snap === 'object' };
})()`;

// A profile of the desktop app's own (RUNDOCK_USER_DATA_DIR, see
// electron/user-data.js), set up the way an install that has already been
// through first run is: the setup marker is there, so the app goes straight
// to its window rather than to the first-run wizard.
function desktopProfile() {
  const dir = tempDir('parity-userdata-');
  fs.writeFileSync(path.join(dir, '.claude-setup-verified'), 'settings parity run\n');
  return dir;
}

// The environment both surfaces start in: the fixture's workspace and home,
// the desktop profile, no scheduler. What the app sets for itself
// (RUNDOCK_ELECTRON, ELECTRON_RUN_AS_NODE) and the packaged-boot check's
// switch are never inherited from whoever runs this.
function launchEnv(fixture, profile, base = process.env) {
  const env = { ...base, HOME: fixture.home, WORKSPACE: fixture.ws, RUNDOCK_USER_DATA_DIR: profile, RUNDOCK_DISABLE_SCHEDULER: '1' };
  delete env.RUNDOCK_ELECTRON;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.RUNDOCK_SMOKE_TEST;
  return env;
}

// Every field that differs, named.
function compare(a, b) {
  if (!a || !b) return [`a snapshot is missing (${a ? 'second' : 'first'})`];
  const out = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) out.push(`${key}: ${JSON.stringify(a[key])} vs ${JSON.stringify(b[key])}`);
  }
  return out;
}

module.exports = { SNAPSHOT, OPEN_PERMISSIONS, BRIDGE, makeFixture, desktopProfile, launchEnv, cases, compare };
