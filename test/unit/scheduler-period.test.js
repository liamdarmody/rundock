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
// THE WINDOW IS COMPUTED HERE, independently: the slot's calendar day for a
// daily and a weekly routine and a set of days, and the slot's calendar month
// for a monthly one.
// Taking it from the scheduler would let the two readers agree on a wrong
// window and pass.
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
function* months() {
  for (let m = new Date(FIRST); m < LAST; m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) yield m;
}

const nextDay = (s) => new Date(s.getFullYear(), s.getMonth(), s.getDate() + 1);
const nextMonth = (s) => new Date(s.getFullYear(), s.getMonth() + 1, 1);

// Each schedule with its slots and its window, written out longhand. The times
// are chosen to land on the clock changes: 00:30 on both changing Sundays, and
// 01:30 on 28 March 2027, inside the hour the clocks skip.
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
  // A set of days has a slot on each chosen day and on no other: weekday is
  // Monday to Friday, and a list is its days. Sunday at 01:30 is inside the
  // hour the clocks skip on 28 March 2027 and the hour they repeat on 31
  // October 2027.
  {
    schedule: 'every weekday at 00:30',
    slots: () => [...days()].filter(d => d.getDay() >= 1 && d.getDay() <= 5)
      .map(d => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 30)),
    closes: nextDay,
  },
  {
    schedule: 'every monday, wednesday and sunday at 01:30',
    slots: () => [...days()].filter(d => [1, 3, 0].includes(d.getDay()))
      .map(d => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 1, 30)),
    closes: nextDay,
  },
  {
    schedule: 'every saturday and sunday at 00:30',
    slots: () => [...days()].filter(d => d.getDay() === 6 || d.getDay() === 0)
      .map(d => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 30)),
    closes: nextDay,
  },
  {
    schedule: 'on day 1 of every month at 00:30',
    slots: () => [...months()].map(m => new Date(m.getFullYear(), m.getMonth(), 1, 0, 30)),
    closes: nextMonth,
  },
  {
    schedule: 'on day 15 of every month at 09:00',
    slots: () => [...months()].map(m => new Date(m.getFullYear(), m.getMonth(), 15, 9, 0)),
    closes: nextMonth,
  },
  {
    schedule: 'on day 28 of every month at 01:30',
    slots: () => [...months()].map(m => new Date(m.getFullYear(), m.getMonth(), 28, 1, 30)),
    closes: nextMonth,
  },
  {
    schedule: 'on the last day of every month at 23:30',
    slots: () => [...months()].map(m => new Date(m.getFullYear(), m.getMonth() + 1, 0, 23, 30)),
    closes: nextMonth,
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

// A DAY NOT CHOSEN HAS NO SLOT OF ITS OWN. On every day a set leaves out, at
// any hour, the slot getNextRun names is a later one on a chosen day, so the
// tick never fires that day and the row never names it; and a walk across a
// week nobody watched records the chosen days' slots and no others, so that
// day never shows as missed.
test('a set of days names and records no slot on a day it leaves out', () => {
  const schedule = 'every monday, wednesday and sunday at 01:30';
  const chosen = [1, 3, 0];
  const wrong = [];
  for (const d of days()) {
    if (chosen.includes(d.getDay())) continue;
    for (const hour of [0, 1, 9, 23]) {
      const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, 45);
      const named = nextRunAt(at, schedule, null);
      if (!named || !chosen.includes(named.getDay()) || named <= at) {
        wrong.push(`at ${show(at)} getNextRun names ${show(named)}`);
      }
    }
  }
  assert.deepStrictEqual(wrong.slice(0, 5), [], 'a day the set leaves out was given a slot');

  // Anchored on Monday 5 January 2026, unwatched until midday Monday the 12th.
  const parsed = sched.parseSchedule(schedule);
  const key = 'sweep:unchosen';
  const anchor = new Date(2026, 0, 5, 1, 30);
  sched.routineSlots.routines[key] = { due: anchor.toISOString(), schedule: sched.scheduleShape(parsed), missed: [] };
  sched.recordPassedSlots(key, parsed, new Date(anchor.getTime() - MINUTE), new Date(2026, 0, 12, 12, 0), true);
  const recorded = sched.routineSlots.routines[key].missed.map(m => m.slot);
  delete sched.routineSlots.routines[key];
  assert.deepStrictEqual(recorded, [
    new Date(2026, 0, 5, 1, 30), new Date(2026, 0, 7, 1, 30), new Date(2026, 0, 11, 1, 30),
  ].map(d => d.toISOString()), 'Monday, Wednesday and Sunday, and nothing on the four days between');
});
