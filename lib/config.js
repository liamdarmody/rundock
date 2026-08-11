'use strict';
/**
 * Workspace root, owned here so extracted lib/ modules can read it at USE
 * time. The root is LIVE state: it changes when the user switches workspace,
 * and every consumer (113 call sites at extraction start) depends on seeing
 * the change immediately. Modules must therefore call getWorkspace() inside
 * each operation, never capture the value at require time.
 *
 * During the server.js decomposition the root's own `WORKSPACE` variable
 * mirrors this value (server.js still has unconverted read sites); every
 * assignment there goes through a single helper that writes both. Once the
 * last root read site is converted, the mirror goes away and this module is
 * the only owner.
 */

let workspaceRoot = process.env.WORKSPACE || null;

function getWorkspace() {
  return workspaceRoot;
}

function setWorkspace(dir) {
  workspaceRoot = dir;
}

module.exports = { getWorkspace, setWorkspace };
