'use strict';
// Workspace boundary grants, extracted verbatim from server.js as part of
// the server decomposition. The grants file lives INSIDE the current
// workspace, so every function resolves getWorkspace() at use time: a
// workspace switch immediately changes where grants are written and read.
const fs = require('fs');
const path = require('path');
const { getWorkspace } = require('../config.js');

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
    const normalised = path.resolve(dir);
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
  const t = path.resolve(targetPath);
  return readBoundaryGrants().some(d => t === d || t.startsWith(d + path.sep));
}

module.exports = {
  boundaryPermissionsPath, readBoundaryGrants, addBoundaryGrant, boundaryGrantCovers,
};
