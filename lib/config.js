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

// "Names no model": an empty field and the word `inherit` are the same
// statement, matched case-insensitively and ignoring surrounding whitespace the
// way `runtime` already is, so a frontmatter typo cannot strand an agent.
//
// Owned here because TWO layers ask the question: resolution
// (lib/agents/discovery.js, which must turn it into each runtime's own spelling
// of "no model") and spawn (lib/runtime/claude.js, which must pass no --model).
// A rule about what a user's frontmatter means cannot have two implementations:
// they would drift on exactly the edge cases the rule exists for.
function namesNoModel(value) {
  const named = String(value == null ? '' : value).trim();
  return !named || named.toLowerCase() === 'inherit';
}

// There is deliberately no default model here.
//
// Rundock spawns a CLI and passes through the model the user named, or names
// none and lets the CLI resolve its own. A default owned here could not be
// served at all on a machine whose models arrive through a gateway, and on
// every other machine it silently overrode a user who had chosen a model with
// `/model`. The runtime's own default is the only one guaranteed to work.
module.exports = { getWorkspace, setWorkspace, namesNoModel };
