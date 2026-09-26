'use strict';
// The judgement half of the desktop profile override run
// (test/electron/user-data-entrypoint.cjs): the environment it launches the
// shipped entrypoint in, how it reads the startup log, and the name of every
// expectation that did not hold. No Electron. The only I/O is resolving real
// paths for the containment gate and the snapshot of the default profile
// location, which lists folders and stats entries and never opens a file.
// Proved by test/unit/user-data-entrypoint.test.js.

const fs = require('node:fs');
const path = require('node:path');
const { launchEnv: parityEnv } = require('./settings-parity.js');

// A value that is set but relative. The app must refuse it rather than read
// it against its working directory.
const RELATIVE_VALUE = 'relative-profile';

// Each expectation the run checks, by the name its report gives a failure.
// The mutation harness reads these names back.
const FAIL = {
  setupClaude: 'setup: the claude CLI is on PATH, so the desktop app starts past its first-run wizard',
  setupDefault: 'setup: the default profile location is inside the throwaway HOME, so checking it never reads the real one',
  setupName: "setup: the running app's name is the package name, so the snapshot is of its default location",
  setupSnapshot: 'setup: the default profile location inside the throwaway HOME can be listed',
  absoluteUserData: "absolute: app.getPath('userData') is exactly RUNDOCK_USER_DATA_DIR",
  absoluteLock: "absolute: the single-instance lock is taken in that folder",
  absoluteStorage: "absolute: the app's own storage is written in that folder",
  absoluteDefault: 'absolute: nothing is written in the default profile location',
  absoluteWindow: 'absolute: the app opens its main window on that profile',
  relativeExit: 'relative: the app exits non-zero',
  relativeReason: 'relative: the app names why it is not starting',
  relativeWindow: 'relative: no window opens',
  relativeServer: 'relative: the embedded server never starts',
  relativeFolder: 'relative: nothing is written in the relative folder under the working directory',
  relativeDefault: 'relative: nothing is written in the default profile location',
};

// The parity run's environment (workspace, HOME, no scheduler, no inherited
// app switches), plus every other home a platform reads its default folders
// from: macOS reads CFFIXED_USER_HOME before the account's home, Linux reads
// XDG_CONFIG_HOME. The run still checks, before launching the app, that the
// default location really landed inside the throwaway HOME (realInside).
function launchEnv({ home, ws, userData }, base = process.env) {
  const env = parityEnv({ ws, home }, userData, base);
  env.CFFIXED_USER_HOME = home;
  env.XDG_CONFIG_HOME = path.join(home, '.config');
  return env;
}

// What Chromium's single-instance lock leaves in the profile folder.
function lockName(platform) {
  return platform === 'win32' ? 'lockfile' : 'SingletonLock';
}

function insideFolder(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

// The real path of a location, which need not exist yet: the real path of
// its nearest existing ancestor with the rest of it appended.
function realPath(p) {
  let head = p;
  const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync(head), ...rest); } catch (e) {
      if (!e || e.code !== 'ENOENT') throw e;
      const up = path.dirname(head);
      if (up === head) throw e;
      rest.unshift(path.basename(head));
      head = up;
    }
  }
}

// The gate before any launch: the location's real path when it is inside the
// real path of the throwaway HOME, and null otherwise. A temporary folder
// reached through a symlink (/tmp and /private/tmp on macOS) is spelt one way
// by Electron and another by the run, so the strings alone cannot say.
function realInside(location, home) {
  if (typeof location !== 'string' || !path.isAbsolute(location)) return null;
  let real;
  let realHome;
  try { real = realPath(location); realHome = fs.realpathSync(home); } catch (e) { return null; }
  return insideFolder(real, realHome) ? real : null;
}

// The lines electron/main.js prints on the way to a window and the server.
// Nothing opens a window before "App ready", and each window it opens is
// announced: the main window's page load, or the first-run wizard.
function startupSeen(output) {
  const text = String(output || '');
  return {
    refusal: /RUNDOCK_USER_DATA_DIR must be an absolute path[^\n]*Not starting/.test(text),
    ready: /\[Electron\] App ready/.test(text),
    window: /\[Electron\] (Loading http|Showing first-run wizard)/.test(text),
    server: /\[Electron\] (Starting server|Server running on port)/.test(text),
  };
}

// A read-only record of a folder: whether it exists, and each entry below it
// by its name relative to the folder, with its type, size and mtime. Only
// lstat and readdir are called, so no file is opened and no link is followed.
// A folder that cannot be listed throws rather than reading as empty.
function snapshotFolder(dir, fsImpl = fs) {
  let top;
  try { top = fsImpl.lstatSync(dir); } catch (e) {
    if (e && e.code === 'ENOENT') return { exists: false, entries: {} };
    throw e;
  }
  const entries = {};
  const walk = (abs, rel) => {
    for (const name of fsImpl.readdirSync(abs).sort()) {
      const childAbs = path.join(abs, name);
      const childRel = rel ? path.join(rel, name) : name;
      const st = fsImpl.lstatSync(childAbs);
      const type = st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
      entries[childRel] = { type, size: st.size, mtimeMs: st.mtimeMs };
      if (type === 'dir') walk(childAbs, childRel);
    }
  };
  if (top.isDirectory()) walk(dir, '');
  return { exists: true, entries };
}

// What differs between two snapshots, each difference named by relative entry
// name: added, then removed, then changed, each sorted.
function snapshotDiff(before, after) {
  if (before.exists !== after.exists) return [after.exists ? 'the folder appeared' : 'the folder disappeared'];
  const a = before.entries;
  const b = after.entries;
  const same = (x, y) => x.type === y.type && x.size === y.size && x.mtimeMs === y.mtimeMs;
  const added = Object.keys(b).filter((k) => !(k in a)).sort().map((k) => `added: ${k}`);
  const removed = Object.keys(a).filter((k) => !(k in b)).sort().map((k) => `removed: ${k}`);
  const changed = Object.keys(a).filter((k) => k in b && !same(a[k], b[k])).sort().map((k) => `changed: ${k}`);
  return [...added, ...removed, ...changed];
}

const named = (fail, changes) => `${fail} (${changes.join('; ')})`;

function judgeAbsolute({ profile, userData, lockInProfile, storageInProfile, defaultChanges, windowError }) {
  const out = [];
  if (userData !== profile) out.push(FAIL.absoluteUserData);
  if (!lockInProfile) out.push(FAIL.absoluteLock);
  if (windowError) out.push(`${FAIL.absoluteWindow} (${windowError})`);
  if (!storageInProfile) out.push(FAIL.absoluteStorage);
  if (defaultChanges.length) out.push(named(FAIL.absoluteDefault, defaultChanges));
  return out;
}

function judgeRelative({ exited, code, output, relativeExists, defaultChanges }) {
  const seen = startupSeen(output);
  const out = [];
  if (!exited || typeof code !== 'number' || code === 0) out.push(FAIL.relativeExit);
  if (!seen.refusal) out.push(FAIL.relativeReason);
  if (seen.ready || seen.window) out.push(FAIL.relativeWindow);
  if (seen.server) out.push(FAIL.relativeServer);
  if (relativeExists) out.push(FAIL.relativeFolder);
  if (defaultChanges.length) out.push(named(FAIL.relativeDefault, defaultChanges));
  return out;
}

module.exports = { RELATIVE_VALUE, FAIL, launchEnv, lockName, insideFolder, realInside, startupSeen, snapshotFolder, snapshotDiff, judgeAbsolute, judgeRelative };
