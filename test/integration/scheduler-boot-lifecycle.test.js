'use strict';
// The other caller of the starter: boot, for a workspace that was already
// remembered or preset in the environment.
//
// That path never goes through the workspace setter, because the root is
// seeded from process.env.WORKSPACE at require time rather than assigned. So
// it arms the tick itself, it is one of the rows in
// test/unit/scheduler-lifecycle-doors.test.js, and this is the test that row
// names.
//
// It has its own file because the harness boots one server per file and this
// one has to boot WITH a workspace, which is the opposite of what
// test/integration/scheduler-workspace-lifecycle.test.js needs.
//
// Nothing here calls startScheduler or stopScheduler. Booting is the surface,
// and the question is asked of the interval handle the tick depends on.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const h = require('../helpers/harness.js');
const { agentFile } = require('../helpers/workspace.js');

before(async () => {
  await h.boot({
    agents: {
      punctual: agentFile({
        name: 'punctual', type: 'specialist', order: 1,
        routines: [{ name: 'clock-check', schedule: 'every day at 09:00', prompt: 'clock routine body' }],
      }),
    },
  });
});
after(h.shutdown);

test('booting with a workspace already set arms the tick, with nobody calling the starter', () => {
  assert.strictEqual(h.internal.getWorkspace(), h.workspaceDir,
    'the server came up pointed at the fixture, the way a remembered workspace arrives');
  assert.strictEqual(h.internal.schedulerRunning(), true,
    'and a tick is armed for it: this is the one path that already worked, and it still does');
});
