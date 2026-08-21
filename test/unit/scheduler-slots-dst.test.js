'use strict';
// The slot walk across a daylight-saving boundary.
//
// A routine's schedule is a LOCAL wall-clock time: "every day at 23:00" means
// 23:00 on the clock in the room, on the day the clocks change as much as on
// any other. So the walk steps a calendar day rather than twenty-four hours,
// and the difference only shows up twice a year: a 24-hour step across the
// autumn change records 22:00, and across the spring change it records 00:00
// on the following day, which also moves which day the slot belongs to.
//
// ITS OWN FILE, because it needs a timezone that has daylight saving and
// continuous integration runs in UTC, which has none. node --test gives every
// file its own process, so setting the zone here changes nothing anywhere
// else. It is set before the first require for the same reason.
process.env.TZ = 'Europe/London';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { agentFile } = require('../helpers/workspace.js');
const { invalidateAgentCache } = require('../../lib/agents/discovery.js');
const SCHEDULER_KEY = require.resolve('../../lib/scheduler.js');

// A private copy per test, so wiring never leaks into the shared instance.
// Same technique as test/unit/scheduler-lib.test.js.
function freshScheduler() {
  const cached = require.cache[SCHEDULER_KEY];
  delete require.cache[SCHEDULER_KEY];
  const mod = require(SCHEDULER_KEY);
  delete require.cache[SCHEDULER_KEY];
  if (cached) require.cache[SCHEDULER_KEY] = cached;
  return mod;
}

// A workspace holding one agent with one nightly routine, torn down after.
function withNightlyWorkspace(fn) {
  const config = require('../../lib/config.js');
  const original = config.getWorkspace();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-dst-'));
  config.setWorkspace(ws);
  const dir = path.join(ws, '.claude', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'nightly.md'), agentFile({
    name: 'nightly', type: 'specialist', order: 1,
    routines: [{ name: 'late', schedule: 'every day at 23:00', prompt: 'p' }],
  }));
  invalidateAgentCache();
  try {
    return fn(freshScheduler());
  } finally {
    config.setWorkspace(original);
    invalidateAgentCache();
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

// One tick at a fixed instant, with 23:00 still ahead of it so the tick
// observes without spawning anything.
function observeOnce(t, sched, when) {
  sched.wireSchedulerDeps({ now: () => when });
  t.mock.timers.enable({ apis: ['setInterval'] });
  try {
    sched.startScheduler();
    t.mock.timers.tick(60_000);
  } finally {
    sched.stopScheduler();
    t.mock.timers.reset();
  }
}

const KEY = 'nightly:late';
const slotsOf = (sched) => sched.routineSlots.routines[KEY].missed.map(m => new Date(m.slot));

test('the clocks going back does not move the hour a slot was due', (t) => {
  withNightlyWorkspace((sched) => {
    // Friday 23 October 2026, British Summer Time. The clocks go back at
    // 02:00 on Sunday the 25th, making that day 25 hours long.
    observeOnce(t, sched, new Date(2026, 9, 23, 8, 0, 0));
    observeOnce(t, sched, new Date(2026, 9, 27, 8, 0, 0));

    const missed = slotsOf(sched);
    assert.deepStrictEqual(missed.map(d => d.getDate()), [23, 24, 25, 26],
      'one slot for each night the machine was closed, including the long one');
    assert.deepStrictEqual(missed.map(d => d.getHours()), [23, 23, 23, 23],
      'every one of them at 23:00 on the clock in the room, which is what the schedule says');
  });
});

test('the clocks going forward does not move the day a slot belongs to', (t) => {
  withNightlyWorkspace((sched) => {
    // Friday 27 March 2026, Greenwich Mean Time. The clocks go forward at
    // 01:00 on Sunday the 29th, making that day 23 hours long.
    observeOnce(t, sched, new Date(2026, 2, 27, 8, 0, 0));
    observeOnce(t, sched, new Date(2026, 2, 31, 8, 0, 0));

    const missed = slotsOf(sched);
    assert.deepStrictEqual(missed.map(d => d.getDate()), [27, 28, 29, 30],
      'four nights, four slots, and the short day is still one day');
    assert.deepStrictEqual(missed.map(d => d.getHours()), [23, 23, 23, 23],
      'and none of them drifted into the small hours of the following morning');
  });
});
