'use strict';
// Every reader of a schedule shares one idea of its period.
//
// Two of them decide something irreversible from it. The tick fires a slot
// while getNextRun still names it, and the slot walk records a slot as missed
// once its catch-up window has closed. If they disagree, one of three things
// happens: a slot is recorded as missed while the tick still fires it (a gap
// that was not one), a slot the tick has given up on is never recorded (a
// silent hole), or a slot is fired twice in one period. The sweep below asks
// both readers about every slot across two years, at instants either side of
// its window, and fails on the first instant they disagree.
//
// THE WINDOW IS COMPUTED HERE, independently: the slot's calendar day, for a
// daily and a weekly routine alike. Taking it from the scheduler would let the
// two readers agree on a wrong window and pass.
//
// ITS OWN FILE, because it needs a timezone with daylight saving and
// continuous integration runs in UTC. Set before the first require, and
// node --test gives every file its own process.
process.env.TZ = 'Europe/London';

const { test } = require('node:test');
const assert = require('node:assert');

const SCHEDULER_KEY = require.resolve('../../lib/scheduler.js');

// A private copy, so wiring never leaks into the shared instance.
function freshScheduler() {
  const cached = require.cache[SCHEDULER_KEY];
  delete require.cache[SCHEDULER_KEY];
  const mod = require(SCHEDULER_KEY);
  delete require.cache[SCHEDULER_KEY];
  if (cached) require.cache[SCHEDULER_KEY] = cached;
  return mod;
}

const sched = freshScheduler();
const clock = { at: new Date(2026, 0, 1) };
sched.wireSchedulerDeps({ now: () => clock.at });

const MINUTE = 60 * 1000;
const FIRST = new Date(2026, 0, 1);
// Past the end of February 2028, so the leap day is in the sweep.
const LAST = new Date(2028, 2, 1);

function* days() {
  for (let d = new Date(FIRST); d < LAST; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) yield d;
}

const nextDay = (s) => new Date(s.getFullYear(), s.getMonth(), s.getDate() + 1);

// Each schedule with its slots and its window, written out longhand. The time
// is chosen to land on the clock changes: 00:30 on both changing Sundays.
const SCHEDULES = [
  {
    schedule: 'every day at 00:30',
    slots: () => [...days()].map(d => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 30)),
    closes: nextDay,
  },
  {
    schedule: 'every sunday at 00:30',
    slots: () => [...days()].filter(d => d.getDay() === 0)
      .map(d => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 30)),
    closes: nextDay,
  },
];

function nextRunAt(at, schedule, lastRun) {
  clock.at = at;
  return sched.getNextRun(schedule, lastRun ? lastRun.toISOString() : null);
}

// Whether the walk, told nobody watched `slot` pass, records it as missed at
// `at`. The real walk, from an anchor on the slot itself.
function walkRecords(schedule, slot, at) {
  const parsed = sched.parseSchedule(schedule);
  const key = 'sweep:routine';
  sched.routineSlots.routines[key] = { due: slot.toISOString(), schedule: sched.scheduleShape(parsed), missed: [] };
  sched.recordPassedSlots(key, parsed, new Date(slot.getTime() - MINUTE), at, true);
  const recorded = sched.routineSlots.routines[key].missed.some(m => m.slot === slot.toISOString());
  delete sched.routineSlots.routines[key];
  return recorded;
}

// Just before the window, at it, inside it, at its last minute, as it closes,
// and just past.
function instants(slot, closes) {
  const middle = new Date(slot.getTime() + Math.floor((closes - slot) / 2 / MINUTE) * MINUTE);
  return [
    new Date(slot.getTime() - MINUTE), slot, middle,
    new Date(closes.getTime() - MINUTE), closes, new Date(closes.getTime() + MINUTE),
  ];
}

const same = (a, b) => !!a && !!b && a.getTime() === b.getTime();
const show = (d) => (d ? d.toString() : String(d));

for (const { schedule, slots, closes } of SCHEDULES) {
  test(`the tick and the walk agree on every slot's window: ${schedule}`, () => {
    const all = slots();
    assert.ok(all.length >= 26, 'the sweep reaches every slot across 2026 and 2027, and February 2028');
    const disagreements = [];
    for (const slot of all) {
      const end = closes(slot);
      for (const at of instants(slot, end)) {
        if (at < slot) continue;
        const named = same(nextRunAt(at, schedule, null), slot);
        const recorded = walkRecords(schedule, slot, at);
        const inside = at < end;
        if (named === recorded || named !== inside || recorded === inside) {
          disagreements.push(`slot ${show(slot)} at ${show(at)}: getNextRun names it ${named}, `
            + `the walk records it ${recorded}, and it is ${inside ? 'inside' : 'past'} its window`);
        }
      }
    }
    assert.deepStrictEqual(disagreements.slice(0, 5), [],
      'getNextRun names an unserved slot exactly while it is inside its window, and the walk records it exactly once it is not');
  });

  test(`a run at its slot holds the routine for the whole window: ${schedule}`, () => {
    const fired = [];
    for (const slot of slots()) {
      const end = closes(slot);
      for (const at of instants(slot, end)) {
        if (at < slot || at >= end) continue;
        const next = nextRunAt(at, schedule, slot);
        if (next !== null) fired.push(`ran at ${show(slot)}, due again at ${show(at)}: ${show(next)}`);
      }
    }
    assert.deepStrictEqual(fired.slice(0, 5), [], 'a second run in one period');
  });
}

// THE CLOCK-CHANGE CASE, named on its own. Sunday 25 October 2026 is twenty-five
// hours long. A weekly routine due at 00:30 that ran at 00:31 is twenty-four
// hours and fourteen minutes past its run at 23:45 that night, still on the
// same Sunday, and must not be due again.
test('a weekly routine that ran early on the long day is not due again late that night', () => {
  const ranAt = new Date(2026, 9, 25, 0, 31);
  const lateThatNight = new Date('2026-10-25T23:45:00.000Z');
  assert.strictEqual(lateThatNight.getDay(), 0, 'still Sunday');
  assert.strictEqual(nextRunAt(lateThatNight, 'every sunday at 00:30', ranAt), null,
    'the run at 00:31 served the 00:30 slot, and it was due a second time the same night');
});
