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
    routines: [{ name: 'late', schedule: 'every day at 23:00', prompt: 'p', enabled: true }],
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

// ===== MONTHLY =====
// A monthly slot is a day of the month at a wall-clock time, so a step is one
// calendar month at the same time on the clock, and the last day is each
// month's own last day. Asked of the slot arithmetic directly, then of the walk
// that records what passed.

const parse = (sched, schedule) => sched.parseSchedule(schedule);
const local = (d) => [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()];

test('a monthly slot keeps its hour across the days the clocks change', () => {
  const sched = freshScheduler();
  // Sunday 25 October 2026: the clocks go back at 02:00.
  const day25 = parse(sched, 'on day 25 of every month at 09:00');
  const september = sched.slotFor(day25, new Date(2026, 8, 10, 12, 0));
  assert.deepStrictEqual(local(september), [2026, 9, 25, 9, 0], 'the slot of the month the instant falls in');
  const october = sched.stepSlots(day25, september, 1);
  assert.deepStrictEqual(local(october), [2026, 10, 25, 9, 0], 'one month on, still 09:00 on the clock');
  assert.deepStrictEqual(local(sched.stepSlots(day25, october, 1)), [2026, 11, 25, 9, 0], 'and past the change');
  assert.deepStrictEqual(local(sched.stepSlots(day25, october, -1)), [2026, 9, 25, 9, 0], 'and back across it');

  // Sunday 28 March 2027: the clocks go forward at 01:00.
  const day28 = parse(sched, 'on day 28 of every month at 07:00');
  const february = sched.slotFor(day28, new Date(2027, 1, 3, 12, 0));
  assert.deepStrictEqual(local(february), [2027, 2, 28, 7, 0]);
  assert.deepStrictEqual(local(sched.stepSlots(day28, february, 1)), [2027, 3, 28, 7, 0],
    'one month on, on the short day, still 07:00 on the clock');
  assert.deepStrictEqual(local(sched.stepSlots(day28, february, 2)), [2027, 4, 28, 7, 0]);
});

test('the last day of the month is each month\'s own last day', () => {
  const sched = freshScheduler();
  const last = parse(sched, 'on the last day of every month at 18:00');
  const january = sched.slotFor(last, new Date(2027, 0, 5, 12, 0));
  assert.deepStrictEqual(local(january), [2027, 1, 31, 18, 0]);
  const february = sched.stepSlots(last, january, 1);
  assert.deepStrictEqual(local(february), [2027, 2, 28, 18, 0], 'February 2027 has 28 days');
  assert.deepStrictEqual(local(sched.stepSlots(last, february, 1)), [2027, 3, 31, 18, 0],
    'and March is back to 31, rather than staying on the 28th');
  assert.deepStrictEqual(local(sched.stepSlots(last, january, 13)), [2028, 2, 29, 18, 0], 'February 2028 has 29');
  assert.deepStrictEqual(local(sched.slotFor(last, new Date(2028, 1, 3, 12, 0))), [2028, 2, 29, 18, 0]);
  assert.deepStrictEqual(local(sched.slotFor(last, new Date(2026, 3, 9, 12, 0))), [2026, 4, 30, 18, 0], 'April has 30');
});

test('a monthly schedule\'s shape names the day, or the last day, and the time', () => {
  const sched = freshScheduler();
  assert.strictEqual(sched.scheduleShape(parse(sched, 'on day 25 of every month at 09:00')), 'monthly:25:9:0');
  assert.strictEqual(sched.scheduleShape(parse(sched, 'on day 05 of every month at 09:30')), 'monthly:5:9:30',
    'a leading zero is not a different schedule');
  assert.strictEqual(sched.scheduleShape(parse(sched, 'on the last day of every month at 18:00')), 'monthly:last:18:0');
  assert.notStrictEqual(sched.scheduleShape(parse(sched, 'on day 1 of every month at 09:00')),
    sched.scheduleShape(parse(sched, 'every day at 09:00')), 'and day 1 is not every day');
});

// The walk, over a routine closed from December to April: four month ends
// passed, one of them in February and one after the clocks went forward.
test('the walk records each month\'s own last day at the hour it was due', (t) => {
  const sched = freshScheduler();
  const config = require('../../lib/config.js');
  const original = config.getWorkspace();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-dst-monthly-'));
  config.setWorkspace(ws);
  const dir = path.join(ws, '.claude', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'closer.md'), agentFile({
    name: 'closer', type: 'specialist', order: 1,
    routines: [{ name: 'books', schedule: 'on the last day of every month at 18:00', prompt: 'p', enabled: true }],
  }));
  invalidateAgentCache();
  try {
    observeOnce(t, sched, new Date(2026, 11, 1, 8, 0, 0));
    observeOnce(t, sched, new Date(2027, 3, 2, 8, 0, 0));
    const missed = sched.routineSlots.routines['closer:books'].missed.map(m => local(new Date(m.slot)));
    assert.deepStrictEqual(missed, [
      [2026, 12, 31, 18, 0], [2027, 1, 31, 18, 0], [2027, 2, 28, 18, 0], [2027, 3, 31, 18, 0],
    ], 'one record for each month end, each on that month\'s last day at 18:00');
  } finally {
    config.setWorkspace(original);
    invalidateAgentCache();
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
