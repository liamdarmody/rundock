'use strict';
// REMOVING A DOWNLOADED PACKAGE FOLDER, ON EVERY PLATFORM.
//
// A package is fetched with git into a temporary folder, and git marks the
// pack files it writes as read-only. On Windows, the desktop app's runtime
// does not clear a file's read-only attribute before deleting it (plain Node
// does), so a recursive remove of that folder failed with EPERM and no
// package could be added on Windows at all. The same remove also fails on
// macOS and Linux for a folder that is itself read-only.
//
// So the tree is made writable first: every file and folder, walked without
// following links, so nothing outside the folder is ever touched. Then it is
// removed, with a short retry for a file something else holds for a moment
// (antivirus scanning a freshly written file is the usual one). Any other
// failure is thrown, unchanged, for the caller to decide about.
const fs = require('fs');
const path = require('path');

// Briefly held, worth another try. Anything else is a real failure.
const HELD = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY', 'EMFILE', 'ENFILE']);

function pause(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) { /* no wait: retry at once */ }
}

// Make every entry under `dir` writable by its owner, links excepted, which
// are removed as links and never followed. Best-effort: an entry that cannot
// be changed is left for the remove to report.
function makeWritable(dir) {
  let st;
  try { st = fs.lstatSync(dir); } catch (e) { return; }
  if (st.isSymbolicLink()) return;
  try { fs.chmodSync(dir, st.isDirectory() ? 0o700 : 0o600); } catch (e) { /* the remove will say */ }
  if (!st.isDirectory()) return;
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch (e) { return; }
  for (const name of entries) makeWritable(path.join(dir, name));
}

/**
 * Remove `dir` and everything in it, whatever the permissions on its files.
 * A folder that is already gone is fine. `rm`, `attempts` and `delayMs` are
 * seams for tests.
 */
function removeDownloadedFolder(dir, { rm = fs.rmSync, attempts = 5, delayMs = 100 } = {}) {
  if (typeof dir !== 'string' || !dir || !fs.existsSync(dir)) return;
  makeWritable(dir);
  for (let attempt = 1; ; attempt++) {
    try {
      rm(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      if (attempt >= attempts || !HELD.has(e && e.code)) throw e;
      pause(delayMs * attempt);
      makeWritable(dir);
    }
  }
}

module.exports = { removeDownloadedFolder };
