'use strict';
// The suite never writes into the checkout's own stores.
//
// From source, Rundock keeps its routine approvals and the fingerprints of the
// browsers let in beside the checkout. A test that loads server.js without a
// temporary home of its own would point both there, and every fixture it made
// would land in the record a developer's own Rundock reads. The fixture
// helpers move both stores into the temporary folder before writing anything.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const CHECKOUT_STORES = ['.routine-approvals.json', '.browser-sessions.json'].map((f) => path.join(ROOT, f));
const snapshot = () => CHECKOUT_STORES.map((f) => { try { const s = fs.statSync(f); return `${s.size}:${s.mtimeMs}`; } catch (e) { return 'absent'; } });

test('loading the server and making fixtures leaves the checkout\'s stores untouched', () => {
  const before = snapshot();
  // As a unit test that requires the server would, with no home of its own.
  delete process.env.RUNDOCK_ELECTRON;
  require('../../server.js');
  const { makeWorkspace, agentFile } = require('../helpers/workspace.js');
  const { approvedHere } = require('../helpers/approvals.js');
  for (let i = 0; i < 3; i++) {
    makeWorkspace({ agents: { piper: agentFile({ name: 'piper', type: 'specialist', order: 1, routines: [{ name: 'r', schedule: 'every day at 07:00', prompt: 'go', enabled: true }] }) } });
  }
  approvedHere({ name: 'digest', prompt: 'go', runOn: 'local', enabled: true });
  const auth = require('../../lib/auth/index.js');
  auth.setLinkPrinter(() => {});
  require('../helpers/approvals.js').isolateStores();
  auth.exchangeCode(auth.codeOf(auth.signInLink(4500)), 4500);
  const after = snapshot();
  // Requiring the server may create a store that did not exist (its first
  // record); it must never grow one with fixtures.
  CHECKOUT_STORES.forEach((file, i) => {
    if (before[i] === 'absent') return;
    assert.strictEqual(after[i], before[i], `${path.basename(file)} was written by the suite`);
  });
  const store = require('../../lib/agents/approval-store.js');
  assert.ok(store.storePath() === null || store.storePath().startsWith(fs.realpathSync(os.tmpdir())) || store.storePath().startsWith(os.tmpdir()),
    'the approval store is in the temporary folder');
});
