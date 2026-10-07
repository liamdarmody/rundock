'use strict';
// A workspace this install has opened before, at this path, and before it
// kept approvals itself (see lib/agents/approval-locality.js): the routine approvals its agent files
// carry right now are carried over, as they are for a workspace opened before
// approvals were kept per install. Call it once the fixture's agent files are
// written, before the workspace's routines are read.
// THE SUITE NEVER WRITES INTO A REAL STORE. A test that loads server.js with
// no temporary home of its own points the approval and session stores at the
// checkout, where a developer's own Rundock reads them. Before any fixture is
// recorded, both are moved into the temporary folder if they are anywhere
// else.
function inTemp(file) {
  const os = require('node:os');
  const fs = require('node:fs');
  const roots = [os.tmpdir()];
  try { roots.push(fs.realpathSync(os.tmpdir())); } catch (e) { /* the plain path is enough */ }
  return roots.some((r) => file.startsWith(r));
}
function isolateStores() {
  const path = require('node:path');
  const store = require('../../lib/agents/approval-store.js');
  const auth = require('../../lib/auth/index.js');
  const current = store.storePath();
  // In a fixture folder, so the suite's own tidy-up removes it with the rest.
  const { makeTempDir } = require('./workspace.js');
  if (current && !inTemp(current)) {
    store.configureApprovalStore(path.join(makeTempDir('test-stores-'), 'routine-approvals.json'));
  }
  const sessions = auth.sessionStorePath();
  if (sessions && !inTemp(sessions)) {
    auth.configureSessionStore(path.join(makeTempDir('test-sessions-'), 'browser-sessions.json'));
  }
}

function seenHere(dir) {
  isolateStores();
  require('../../lib/agents/approval-store.js').markRecentBeforeStore(dir);
  return require('../../lib/agents/approval-locality.js').noteWorkspaceOpened(dir, dir);
}

module.exports = { seenHere, isolateStores };

// A routine object approved here, for suites that hand the scheduler routine
// objects rather than files: it carries the identity discovery gives a
// routine, and the open workspace's record says it was approved over its
// plan. Opens a throwaway workspace when none is open.
let fixtureOccurrence = 0;
function approvedHere(routine) {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const config = require('../../lib/config.js');
  const store = require('../../lib/agents/approval-store.js');
  const { computePlanHash } = require('../../lib/agents/routines.js');
  isolateStores();
  if (!config.getWorkspace()) config.setWorkspace(fs.mkdtempSync(path.join(os.tmpdir(), 'approved-here-')));
  const hash = computePlanHash(routine);
  const out = { ...routine, planApprovedHash: hash, source: routine.source || { file: '.claude/agents/fixture.md', occurrence: fixtureOccurrence++ } };
  store.recordApproval(config.getWorkspace(), store.identityOf(out), hash, null);
  return out;
}

module.exports.approvedHere = approvedHere;
