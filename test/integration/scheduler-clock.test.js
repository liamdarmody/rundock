'use strict';
// The tick, driven across a scheduled instant by a clock the test owns.
//
// This is the pairing neither existing suite could make: the grammar tests
// freeze Date and never reach the tick, the tick test advances the interval
// and runs the tick against the real wall clock. Here the interval is mocked
// AND the scheduler's clock is wired, so a routine can be watched not firing
// at 08:00 and then firing at 09:30 without a second of real time passing.
//
// Both halves are one test on purpose. "It did not fire" on its own is
// satisfied by a scheduler that was never going to fire anything; the second
// half fires the same routine from the same fixture, which is what makes the
// first half mean something.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const h = require('../helpers/harness.js');
const { agentFile } = require('../helpers/workspace.js');

const scheduler = require('../../lib/scheduler.js');

const KEY = 'punctual:clock-check';
// Wednesday 2026-07-01, local time, so the fixture is timezone-independent.
const BEFORE_NINE = new Date(2026, 6, 1, 8, 0, 0);
const AFTER_NINE = new Date(2026, 6, 1, 9, 30, 0);

before(async () => {
  await h.boot({
    agents: {
      punctual: agentFile({
        name: 'punctual', type: 'specialist', order: 1,
        routines: [{ name: 'clock-check', schedule: 'every day at 09:00', prompt: 'clock routine body', enabled: true }],
      }),
    },
  });
});
after(h.shutdown);

test('the tick fires a routine when the wired clock reaches its time, not before', async (t) => {
  h.writeScenario([
    { match: { agent: 'punctual', promptIncludes: 'clock routine body' }, turn: [{ text: 'routine ran' }] },
  ]);
  delete h.internal.routineState[KEY];

  const clock = { at: BEFORE_NINE };
  const prevDeps = scheduler.wireSchedulerDeps({ now: () => clock.at });
  // The server armed the tick at boot; the interval this test drives has to
  // be the mocked one, so the real one goes first.
  h.internal.stopScheduler();
  t.mock.timers.enable({ apis: ['setInterval'] });
  try {
    h.internal.startScheduler();

    t.mock.timers.tick(60_000);
    assert.strictEqual(h.internal.routineState[KEY], undefined,
      'an hour before its time, the routine has not run');

    clock.at = AFTER_NINE;
    t.mock.timers.tick(60_000);
    const started = h.internal.routineState[KEY];
    assert.ok(started, 'advancing the clock past 09:00 fired the routine, with no real time elapsed');
    assert.strictEqual(started.lastRun, AFTER_NINE.toISOString(),
      'the run was stamped with the wired clock rather than the wall clock');

    // tick() is synchronous and the child's close event cannot have landed
    // during it, so moving the clock here is deterministic. It makes the
    // recorded duration the seam's answer rather than elapsed real time,
    // which is what pins the two clock reads inside the outcome.
    clock.at = new Date(AFTER_NINE.getTime() + 120_000);
    const ran = await h.waitUntil(() => {
      const s = h.internal.routineState[KEY];
      return s && s.status !== 'running';
    });
    assert.ok(ran, 'the fired routine reached an outcome');
    const done = h.internal.routineState[KEY];
    assert.strictEqual(done.status, 'completed',
      'the routine the clock released ran through to completion');
    assert.strictEqual(done.duration, 120,
      'the duration is the two minutes the seam reports, not the milliseconds that really elapsed');
    assert.strictEqual(done.lastRun, clock.at.toISOString(),
      'the outcome is stamped with the seam too');
  } finally {
    h.internal.stopScheduler();
    t.mock.timers.reset();
    scheduler.wireSchedulerDeps(prevDeps);
  }
});
