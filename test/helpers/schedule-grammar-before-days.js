'use strict';
// The schedule grammar as it was before sets of days, frozen.
//
// Two readings, both copied rather than imported, because each is a record of
// what an earlier build did and must not move when the scheduler does:
//
// - `parse0157` and `isWritable0157` are 0.15.7, the last release before sets
//   of days: `lib/scheduler.js` and `lib/agents/routines.js` at the v0.15.7
//   tag. It read every day and one named weekday, and nothing else.
// - `parseBefore` is the scheduler on main just before sets of days, which
//   read the two monthly forms as well, matched after the daily one and before
//   the weekly one.
//
// The patterns are named here so the evidence file's quotation of them can be
// checked against the ones these readings run (test/unit/routine-days.test.js).

const WEEKDAYS = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
const DAILY = /every day at (\d{2}):(\d{2})/;
const WEEKLY = /every (\w+) at (\d{2}):(\d{2})/;
const MONTHLY = /on (?:day 0?([1-9]|1\d|2[0-8])|the last day) of every month at (\d{2}):(\d{2})/;
// 0.15.7's save check, which the writer folds the case for before it asks.
const SAVE_CHECK_0157 = /^every (day|monday|tuesday|wednesday|thursday|friday|saturday|sunday) at ([01]\d|2[0-3]):[0-5]\d$/;

function daily(s) {
  const dailyMatch = s.match(DAILY);
  return dailyMatch ? { kind: 'daily', hour: parseInt(dailyMatch[1]), minute: parseInt(dailyMatch[2]) } : null;
}

// Undefined when the weekly pattern does not match, so a caller can go on;
// null when it matches a word that is not a day, which ends the read.
function weekly(s) {
  const weeklyMatch = s.match(WEEKLY);
  if (!weeklyMatch) return undefined;
  const day = WEEKDAYS[weeklyMatch[1]];
  if (day === undefined) return null;
  return { kind: 'weekly', day, hour: parseInt(weeklyMatch[2]), minute: parseInt(weeklyMatch[3]) };
}

function parse0157(schedule) {
  if (!schedule) return null;
  const s = schedule.toLowerCase();
  const d = daily(s);
  if (d) return d;
  const w = weekly(s);
  return w === undefined ? null : w;
}

function isWritable0157(value) {
  if (typeof value !== 'string') return false;
  return SAVE_CHECK_0157.test(value.trim().toLowerCase());
}

function parseBefore(schedule) {
  if (!schedule) return null;
  const s = schedule.toLowerCase();
  const d = daily(s);
  if (d) return d;
  const monthlyMatch = s.match(MONTHLY);
  if (monthlyMatch) {
    const day = monthlyMatch[1] ? parseInt(monthlyMatch[1]) : 'last';
    return { kind: 'monthly', day, hour: parseInt(monthlyMatch[2]), minute: parseInt(monthlyMatch[3]) };
  }
  const w = weekly(s);
  return w === undefined ? null : w;
}

module.exports = { WEEKDAYS, DAILY, WEEKLY, MONTHLY, parse0157, isWritable0157, parseBefore };
