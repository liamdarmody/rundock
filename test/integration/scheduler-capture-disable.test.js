'use strict';
// RUNDOCK_DISABLE_SCHEDULER, driven the way its one caller reaches it.
//
// WHY THIS EXISTS. The marketing screenshot pipeline (scripts/screenshots/
// serve.mjs) boots this server against a demo workspace whose routines are
// deliberately seeded as enabled with real run history, so the routines panel
// and the routine editor have something real to show. A demo workspace has no
// genuine tick history behind it, so on real wall-clock time those routines
// read as overdue the moment the process starts, and a capture run long
// enough for one tick to land (any full pipeline run) let the scheduler
// actually fire one against fake data and overwrite the seeded state, which
// is exactly what happened once, mid-session, and is the reason this flag
// exists at all. Both call sites (server.js: the boot path and the
// set_workspace switch path) have to honour it, or the fix only closes half
// the window.
//
// Mirrors scheduler-boot-lifecycle.test.js and scheduler-workspace-lifecycle
// .test.js's own patterns: nothing here calls startScheduler/stopScheduler
// directly, because that proves the starter works and nothing about whether
// either real caller reaches it.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const h = require('../helpers/harness.js');
const { agentFile, makeWorkspace } = require('../helpers/workspace.js');

function punctualAgents() {
  return {
    punctual: agentFile({
      name: 'punctual', type: 'specialist', order: 1,
      routines: [{ name: 'clock-check', schedule: 'every day at 09:00', prompt: 'clock routine body', enabled: true }],
    }),
  };
}

before(async () => {
  // presetWorkspace, the same as scheduler-boot-lifecycle.test.js: the root is
  // seeded from process.env.WORKSPACE before server.js is required, which is
  // the boot path this flag has to reach: the one "nothing had armed a tick
  // before the server listened" already pins for the unflagged case.
  await h.boot({
    presetWorkspace: true,
    env: { RUNDOCK_DISABLE_SCHEDULER: '1' },
    agents: punctualAgents(),
  });
});
after(h.shutdown);

test('the boot path does not arm a tick when the flag is set', () => {
  assert.strictEqual(h.internal.getWorkspace(), h.workspaceDir,
    'sanity: the root was seeded from the environment, the way a remembered workspace arrives');
  assert.strictEqual(h.internal.schedulerRunning(), false,
    'a routine is enabled and due, so a running tick here would be the flag not reaching the boot path');
});

test('the set_workspace switch path does not arm a tick when the flag is set either', async () => {
  const client = await h.connect();
  try {
    const another = makeWorkspace({ claudeMd: '# Second fixture\n', agents: punctualAgents() });
    const since = client.messages.length;
    client.send({ type: 'set_workspace', path: another });
    const { msg } = await client.waitFor(
      m => m.type === 'workspace_set' || m.type === 'workspace_error',
      { since, label: `workspace_set for ${another}` },
    );
    assert.strictEqual(msg.type, 'workspace_set', `choosing ${another} failed: ${msg.message}`);
    assert.strictEqual(h.internal.schedulerRunning(), false,
      'switching to a workspace with a due, enabled routine armed a tick despite the flag');
  } finally {
    client.close();
  }
});
