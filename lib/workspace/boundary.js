'use strict';
// Workspace boundary grants, extracted verbatim from server.js as part of
// the server decomposition. The grants file lives INSIDE the current
// workspace, so every function resolves getWorkspace() at use time: a
// workspace switch immediately changes where grants are written and read.
const fs = require('fs');
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
const { canonicalize } = require('../../scripts/permission-hook.js');

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

// PM-5: no grant may suppress a sensitive crossing except the narrow grant
// named for it, and only for a target that actually lies inside the exact
// directory that grant names. A standing grant over the sensitive root
// itself (or any other ancestor of narrowDir) must NOT cover a target here:
// boundaryGrantCovers alone would let it, because a broader stored grant is
// a prefix of the narrow directory and therefore a prefix of the target too.
// So this checks for a stored grant that IS the narrow directory, not merely
// one that contains it.
function narrowGrantCovers(targetPath, narrowDir) {
  if (typeof targetPath !== 'string' || !targetPath) return false;
  if (typeof narrowDir !== 'string' || !narrowDir) return false;
  const target = canonicalize(targetPath);
  const narrow = canonicalize(narrowDir);
  if (target !== narrow && !target.startsWith(narrow + path.sep)) return false;
  return readBoundaryGrants().some(d => canonicalize(d) === narrow);
}

// The one decision the server consults before silencing a card from a
// stored grant, for one reported crossing. A non-sensitive crossing is
// covered by any stored grant that reaches it, exactly as before; a
// sensitive one (the hook's own `sensitive` id, attached by
// sensitiveEnrichment) is covered ONLY by its own narrow grant, never by a
// standing grant over the wider sensitive root it sits inside. Exported so
// the server and the tests that prove PM-5 consult the same function rather
// than two copies of the same rule that could drift apart.
function crossingCovered(crossing) {
  if (!crossing || typeof crossing.path !== 'string') return false;
  return crossing.sensitive
    ? narrowGrantCovers(crossing.path, crossing.narrowGrantDir)
    : boundaryGrantCovers(crossing.path);
}

module.exports = {
  boundaryPermissionsPath, readBoundaryGrants, addBoundaryGrant, boundaryGrantCovers, narrowGrantCovers,
  crossingCovered,
};
