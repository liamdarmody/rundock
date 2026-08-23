'use strict';
// The other caller of the starter: boot, for a workspace that was already
// remembered.
//
// That path never goes through the workspace setter. The root is seeded from
// process.env.WORKSPACE when lib/config is first required, so nothing has
// written it and nothing has armed a tick by the time startServer runs. It has
// to arm one itself, and this is the test the CALLERS row for that caller
// names.
//
// WHY THE HARNESS IS BOOTED THIS PARTICULAR WAY, because the obvious way makes
// this test prove nothing. The harness normally points the server at its
// fixture through internal.setWorkspace before it listens, and that goes
// through setWorkspaceRoot, which now arms the tick. startServer would then
// reach its own startScheduler(), meet a live handle, and decline, and the
// test would stay green with the boot call deleted. presetWorkspace puts the
// path in the environment instead, which is how a remembered workspace really
// arrives, and leaves the setter untouched.
//
// It has its own file because the harness boots one server per file.
//
// Nothing here calls startScheduler or stopScheduler. Booting is the surface.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const h = require('../helpers/harness.js');
const { agentFile } = require('../helpers/workspace.js');

before(async () => {
  await h.boot({
    presetWorkspace: true,
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
    'the root was seeded from the environment, the way a remembered workspace arrives');
  assert.strictEqual(h.schedulerBeforeListen, false,
    'and nothing had armed a tick before the server listened: no setter ran, so if this were true '
    + 'the assertion below would pass without the boot path doing anything');
  assert.strictEqual(h.internal.schedulerRunning(), true,
    'so the tick armed while the server started is the boot path arming it, and nothing else');
});
