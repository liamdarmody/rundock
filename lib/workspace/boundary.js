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
    // THROUGH THE MERGING WRITER, not a fresh object. This function used to
    // write `{ allowedDirs: grants }` and nothing else, which was harmless
    // while folder grants were the only thing in the file. They are not any
    // more: composed that way, allowing a folder would silently delete every
    // standing tool allow in the same workspace.
    if (!updatePermissions({ allowedDirs: [...grants, normalised] })) return;
    console.log(`[Permission] Standing folder grant added for this workspace: ${normalised}`);
  } catch (e) {
    console.warn(`[Permission] could not persist folder grant: ${e.message}`);
  }
}
// ── Standing tool allows ───────────────────────────────────────────────────
// The other kind of standing answer: a tool the person allowed without a card,
// through "Always allow" on a permission request.
//
// It lived in a Set in the browser tab, so it was lost on a page reload, not
// merely on a restart. A card offering "always" and meaning "until you
// refresh" is a promise the product does not keep, and the cost lands on
// whoever runs the most agents.
//
// Stored beside the folder grants, for the same reasons: encoded into the
// workspace so it travels with it, scoped to that workspace rather than the
// machine, and readable with no browser attached. The sandbox denies writes to
// this file, because an agent that could write it could answer the user's
// permission questions for them.
//
// WHAT THIS DOES NOT CHANGE. Which requests are offered "Always allow" is
// decided elsewhere and is untouched: a high-risk request is carded ahead of
// any standing allow, and a boundary crossing is never answered by one. This
// only makes an answer already given outlive the tab it was given in.
function readToolAllows() {
  try {
    const file = boundaryPermissionsPath();
    if (!file) return [];
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return Array.isArray(data.allowedTools) ? data.allowedTools.filter((k) => typeof k === 'string' && k) : [];
  } catch (e) {
    // UNREADABLE MEANS NO STANDING ANSWER, never a silent yes. A corrupt or
    // missing store shows the card, which is the safe direction: the person is
    // asked again rather than something being allowed on the strength of a
    // file nobody could read.
    return [];
  }
}
// Reports whether it actually wrote. With no workspace open there is nowhere
// to record an answer, and a caller that returned the new list regardless would
// be claiming a grant that does not exist anywhere: the interface would show it
// and the next read would not.
function writePermissionsFile(next) {
  const file = boundaryPermissionsPath();
  if (!file) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
  return true;
}
// THE ONLY WAY THIS FILE IS WRITTEN. Every caller owns one field and states
// only that field; everything else in the file is carried through untouched,
// including keys added by a later version of Rundock that this one has never
// heard of. Two sections already share the file and more will, so a writer
// composing the whole object from what it happens to know is a section-eating
// bug waiting for the next section.
function updatePermissions(changes) {
  return writePermissionsFile({ ...readPermissionsFile(), ...changes });
}
function readPermissionsFile() {
  try {
    const file = boundaryPermissionsPath();
    if (!file) return {};
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
  } catch (e) { return {}; }
}
function addToolAllow(key) {
  try {
    if (typeof key !== 'string' || !key.trim()) return readToolAllows();
    const k = key.trim();
    const current = readToolAllows();
    if (current.includes(k)) return current;
    const next = [...current, k];
    if (!updatePermissions({ allowedTools: next })) return current;
    console.log(`[Permission] Standing tool allow added for this workspace: ${k}`);
    return next;
  } catch (e) {
    console.warn(`[Permission] could not persist tool allow: ${e.message}`);
    return readToolAllows();
  }
}
function removeToolAllow(key) {
  try {
    const current = readToolAllows();
    const kept = current.filter((k) => k !== key);
    if (kept.length === current.length) return current;
    if (!updatePermissions({ allowedTools: kept })) return current;
    console.log(`[Permission] Standing tool allow revoked for this workspace: ${key}`);
    return kept;
  } catch (e) {
    console.warn(`[Permission] could not revoke tool allow: ${e.message}`);
    return readToolAllows();
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
  readToolAllows, addToolAllow, removeToolAllow,
  crossingCovered,
};
