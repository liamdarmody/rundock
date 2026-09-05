'use strict';
// Workspace boundary grants, extracted verbatim from server.js as part of
// the server decomposition. The grants file lives INSIDE the current
// workspace, so every function resolves getWorkspace() at use time: a
// workspace switch immediately changes where grants are written and read.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getWorkspace } = require('../config.js');

// Grants and the paths they are asked about are canonicalised the same way
// the permission hook canonicalises its comparison: nearest existing
// ancestor through realpath, unborn tail reattached. Without this a grant
// stored under one spelling of a symlinked folder never covers the same
// folder asked about under its other name, and the card the grant exists to
// retire comes back. Reusing scripts/permission-hook.js's own export, rather
// than keeping a second copy of the algorithm, is what keeps the two sides
// of the comparison from drifting apart. This is an in-process require of
// its exports (not a spawn of the file as a script), so it is unaffected by
// scripts/ being asar-unpacked in the packaged app: that unpacking exists
// only so Claude Code can exec permission-hook.js as its own OS process,
// which a same-process require never needs.
const { canonicalize, isSecretPath } = require('../../scripts/permission-hook.js');

// ── Workspace boundary grants ──────────────────────────────────────────────
// Standing folder-level permissions for file access OUTSIDE the workspace.
// Spec: anything outside the workspace requires a permission card unless a
// standing per-workspace grant covers it; grants are folder-level, never
// machine-wide. Encoded INTO the workspace (.rundock/permissions.json) so
// they are long-term, travel with the workspace, and apply with no browser
// attached. A grant covers its subtree. The card's "Always allow this
// folder" button is the only writer.
function boundaryPermissionsPath() {
  const ws = getWorkspace();
  return ws ? path.join(ws, '.rundock', 'permissions.json') : null;
}
function readBoundaryGrants() {
  try {
    const file = boundaryPermissionsPath();
    if (!file) return [];
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return Array.isArray(data.allowedDirs) ? data.allowedDirs : [];
  } catch (e) { return []; }
}
function addBoundaryGrant(dir) {
  try {
    const file = boundaryPermissionsPath();
    if (!file || typeof dir !== 'string' || !dir) return;
    const normalised = canonicalize(dir);
    const grants = readBoundaryGrants();
    if (grants.includes(normalised)) return;
    grants.push(normalised);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ allowedDirs: grants }, null, 2));
    console.log(`[Permission] Standing folder grant added for this workspace: ${normalised}`);
  } catch (e) {
    console.warn(`[Permission] could not persist folder grant: ${e.message}`);
  }
}
function boundaryGrantCovers(targetPath) {
  if (typeof targetPath !== 'string' || !targetPath) return false;
  const t = canonicalize(targetPath);
  // Stored grants are canonicalised on write, and canonicalised AGAIN on
  // read for the ones written before that was true, so an old grant under a
  // now-symlinked spelling keeps covering what its author meant.
  return readBoundaryGrants().some(d => {
    const g = canonicalize(d);
    return t === g || t.startsWith(g + path.sep);
  });
}

// The one decision the server consults before silencing a card from a
// stored grant. A crossing the secrets registry names is covered by NO
// stored grant, however broad, checked here at the point of decision rather
// than trusted from whatever tag the hook attached on its way over the wire.
// Everything else is covered by any stored grant that reaches it. `home` is
// a defaulted seam (production never passes it) so a test can pass a
// fixture home instead of monkey-patching a Node builtin.
function crossingCovered(crossing, home = os.homedir()) {
  if (!crossing || typeof crossing.path !== 'string') return false;
  if (isSecretPath(crossing.path, home)) return false;
  return boundaryGrantCovers(crossing.path);
}

module.exports = {
  boundaryPermissionsPath, readBoundaryGrants, addBoundaryGrant, boundaryGrantCovers,
  crossingCovered,
};
