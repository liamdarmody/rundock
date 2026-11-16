'use strict';
// Whether a run served its slot, on the day the clocks go back.
//
// The tick asks one question of a routine's run stamp, for daily and weekly
// routines alike: is the stamp at or after the slot, and on that slot's own
// day. The day the clocks go back is where that question is easiest to get
// wrong, from either side. The hour from 01:00 to 02:00 happens twice, so a
// rule comparing full times has to resolve a slot inside it to one of the two;
// and the day is twenty-five hours long, so a rule counting twenty-four hours
// as a day ends before the day does.
//
// ITS OWN FILE, because it needs a timezone that has daylight saving and
// continuous integration runs in UTC, which has none. node --test gives every
// file its own process, so setting the zone here changes nothing anywhere
// else. It is set before the first require for the same reason. Every instant
// in the repeated hour is written in UTC, because a local time inside it names
// two instants.
process.env.TZ = 'Europe/London';

const { test } = require('node:test');
const assert = require('node:assert');

const SCHEDULER_KEY = require.resolve('../../lib/scheduler.js');

// A private copy per call, wired to a fixed clock, so no wiring leaks into the
// shared instance or between tests.
function getNextRunAt(now, schedule, lastRun) {
  const cached = require.cache[SCHEDULER_KEY];
  delete require.cache[SCHEDULER_KEY];
  const sched = require(SCHEDULER_KEY);
  delete require.cache[SCHEDULER_KEY];
  if (cached) require.cache[SCHEDULER_KEY] = cached;
  sched.wireSchedulerDeps({ now: () => now });
  return sched.getNextRun(schedule, lastRun.toISOString());
}

// Sunday 25 October 2026. The clocks go back at 02:00 British Summer Time, to
// 01:00 Greenwich Mean Time, so 01:00 to 02:00 happens twice: first at 00:00 to
// 01:00 UTC, then at 01:00 to 02:00 UTC.
const FIRST_0131 = new Date('2026-10-25T00:31:00.000Z');
const SECOND_0145 = new Date('2026-10-25T01:45:00.000Z');

// THE REPEATED HOUR. A routine due at 01:30 runs at the first 01:31, and the
// clock then reads 01:45 a second time an hour later. Comparing hours held it,
// because the stamp's hour and the scheduled hour are both 1. Comparing times
// holds it only because the slot for 01:30 that day resolves to the EARLIER of
// the two 01:30s, which the run is after. Were it to resolve to the later one,
// the run would be before its own slot and the routine would run twice in one
// night. Green before the comparison changed and after it, which is the point:
// it pins that the change kept the case the old comparison held.
test('a daily routine that ran in the first of the repeated hours is not run again in the second', () => {
  assert.strictEqual(getNextRunAt(SECOND_0145, 'every day at 01:30', FIRST_0131), null,
    'the run at the first 01:31 did not serve the slot at 01:30, so it was due again at the second 01:45');
});

// THE TWENTY-FIVE HOUR DAY. A weekly routine due at 00:30 on Sundays runs at
// 00:31, in summer time. At 23:45 that night, still Sunday, twenty-four hours
// and fourteen minutes have passed, because the day is an hour longer. Counting
// "ran less than a day ago" as served therefore stopped holding it before the
// day ended, and it ran a second time. Asking whether the run was on the slot's
// own day holds it to the end of that day.
test('a weekly routine that ran early on the long day is not run again late that night', () => {
  const ranAt = new Date('2026-10-24T23:31:00.000Z');    // 00:31 on Sunday, summer time
  const lateThatNight = new Date('2026-10-25T23:45:00.000Z'); // 23:45 on Sunday, winter time
  assert.strictEqual(lateThatNight.getDay(), 0, 'sanity: still Sunday');
  assert.strictEqual(getNextRunAt(lateThatNight, 'every sunday at 00:30', ranAt), null,
    'the run at 00:31 served the 00:30 slot, and it ran again the same night');
});
