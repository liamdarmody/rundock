'use strict';
// Characterization tests for getNextRun (server.js scheduler grammar parser).
// Uses node:test mock timers to pin Date, so results are deterministic and
// independent of when the suite runs. All dates are constructed with local
// components so the tests are timezone-independent.
//
// getNextRun supports exactly two grammars:
//   "every day at HH:MM"
//   "every <weekday> at HH:MM"
// Everything else silently returns null. Those silent-null behaviors are
// pinned AS-IS below; if they should later warn or throw, these tests flip
// deliberately.
const { test, describe, mock, afterEach } = require('node:test');
const assert = require('node:assert');

const { _internal: srv } = require('../../server.js');

// Wednesday 2026-07-01 10:30:00 local time
const WED_1030 = new Date(2026, 6, 1, 10, 30, 0);

function atTime(date) {
  mock.timers.enable({ apis: ['Date'], now: date.getTime() });
}

afterEach(() => mock.timers.reset());

describe('getNextRun: daily grammar', () => {
  test('before the target time: next run is today at HH:MM', () => {
    atTime(WED_1030);
    const next = srv.getNextRun('every day at 14:00', null);
    assert.deepStrictEqual(next, new Date(2026, 6, 1, 14, 0, 0));
  });

  test('after the target time: next run is tomorrow', () => {
    atTime(WED_1030);
    const next = srv.getNextRun('every day at 09:00', null);
    assert.deepStrictEqual(next, new Date(2026, 6, 2, 9, 0, 0));
  });

  test('exactly at the target time: now > target is false, so next run is today (due immediately)', () => {
    atTime(new Date(2026, 6, 1, 14, 0, 0));
    const next = srv.getNextRun('every day at 14:00', null);
    assert.deepStrictEqual(next, new Date(2026, 6, 1, 14, 0, 0));
  });

  test('already ran today at/after the scheduled hour: returns null (no re-run)', () => {
    atTime(new Date(2026, 6, 1, 14, 30, 0));
    const lastRun = new Date(2026, 6, 1, 14, 5, 0).toISOString();
    assert.strictEqual(srv.getNextRun('every day at 14:00', lastRun), null);
  });

  test('ran yesterday: due today', () => {
    atTime(new Date(2026, 6, 1, 14, 30, 0));
    const lastRun = new Date(2026, 5, 30, 14, 1, 0).toISOString();
    const next = srv.getNextRun('every day at 14:00', lastRun);
    // Past today's target with no run today yet -> target rolls to tomorrow,
    // but the scheduler's `now >= nextRun` check makes it fire then.
    assert.deepStrictEqual(next, new Date(2026, 6, 2, 14, 0, 0));
  });

  test('pinned as-is: lastRun earlier today but BEFORE the scheduled hour does not suppress (getHours comparison)', () => {
    atTime(new Date(2026, 6, 1, 14, 30, 0));
    const lastRun = new Date(2026, 6, 1, 13, 59, 0).toISOString(); // ran 13:59, schedule 14:00
    const next = srv.getNextRun('every day at 14:00', lastRun);
    assert.notStrictEqual(next, null);
  });

  test('pinned as-is: suppression compares getHours() only, so a 14:59 run yesterday-style edge inside the same hour suppresses', () => {
    // lastRun 14:59 today, schedule 14:00 -> lastRun.getHours() (14) >= 14 -> null
    atTime(new Date(2026, 6, 1, 15, 30, 0));
    const lastRun = new Date(2026, 6, 1, 14, 59, 0).toISOString();
    assert.strictEqual(srv.getNextRun('every day at 14:00', lastRun), null);
  });

  test('single-digit hour "every day at 9:00" does NOT match the \\d{2} grammar (pinned as-is: silently null)', () => {
    atTime(WED_1030);
    assert.strictEqual(srv.getNextRun('every day at 9:00', null), null);
  });

  test('uppercase schedule text is normalised (toLowerCase)', () => {
    atTime(WED_1030);
    const next = srv.getNextRun('Every Day at 14:00', null);
    assert.deepStrictEqual(next, new Date(2026, 6, 1, 14, 0, 0));
  });
});

describe('getNextRun: weekly grammar', () => {
  test('target weekday later this week', () => {
    atTime(WED_1030); // Wednesday
    const next = srv.getNextRun('every friday at 08:00', null);
    assert.deepStrictEqual(next, new Date(2026, 6, 3, 8, 0, 0));
  });

  test('target weekday earlier this week rolls to next week', () => {
    atTime(WED_1030);
    const next = srv.getNextRun('every monday at 08:00', null);
    assert.deepStrictEqual(next, new Date(2026, 6, 6, 8, 0, 0));
  });

  test('same weekday, time already past: next week', () => {
    atTime(WED_1030);
    const next = srv.getNextRun('every wednesday at 09:00', null);
    assert.deepStrictEqual(next, new Date(2026, 6, 8, 9, 0, 0));
  });

  test('same weekday, time still ahead: today', () => {
    atTime(WED_1030);
    const next = srv.getNextRun('every wednesday at 18:00', null);
    assert.deepStrictEqual(next, new Date(2026, 6, 1, 18, 0, 0));
  });

  test('ran less than a day ago on the target weekday: returns null', () => {
    atTime(new Date(2026, 6, 1, 18, 30, 0)); // Wednesday evening
    const lastRun = new Date(2026, 6, 1, 18, 1, 0).toISOString();
    assert.strictEqual(srv.getNextRun('every wednesday at 18:00', lastRun), null);
  });

  test('ran more than a day ago: not suppressed', () => {
    atTime(WED_1030);
    const lastRun = new Date(2026, 5, 24, 18, 1, 0).toISOString(); // last Wednesday
    const next = srv.getNextRun('every wednesday at 18:00', lastRun);
    assert.deepStrictEqual(next, new Date(2026, 6, 1, 18, 0, 0));
  });

  test('pinned as-is: lastRun <1 day ago on a DIFFERENT weekday does not suppress', () => {
    atTime(WED_1030);
    const lastRun = new Date(2026, 5, 30, 23, 0, 0).toISOString(); // Tuesday night
    const next = srv.getNextRun('every wednesday at 18:00', lastRun);
    assert.notStrictEqual(next, null);
  });

  test('unknown weekday word returns null silently (pinned as-is)', () => {
    atTime(WED_1030);
    assert.strictEqual(srv.getNextRun('every weekday at 08:00', null), null);
    assert.strictEqual(srv.getNextRun('every fortnight at 08:00', null), null);
  });

  test('pinned as-is: "every morning at 08:00" is treated as an unknown weekday, not daily', () => {
    atTime(WED_1030);
    assert.strictEqual(srv.getNextRun('every morning at 08:00', null), null);
  });
});

describe('getNextRun: silent-null inputs (pinned as-is)', () => {
  test('null/undefined/empty schedule', () => {
    assert.strictEqual(srv.getNextRun(null, null), null);
    assert.strictEqual(srv.getNextRun(undefined, null), null);
    assert.strictEqual(srv.getNextRun('', null), null);
  });

  test('cron syntax is unsupported and silently null', () => {
    atTime(WED_1030);
    assert.strictEqual(srv.getNextRun('0 9 * * 1', null), null);
  });

  test('free-text schedules are silently null', () => {
    atTime(WED_1030);
    assert.strictEqual(srv.getNextRun('daily at 09:00', null), null);
    assert.strictEqual(srv.getNextRun('every hour', null), null);
    assert.strictEqual(srv.getNextRun('weekdays at 09:00', null), null);
  });

  test('pinned as-is: out-of-range HH:MM values are accepted and rolled over by Date (25:99 -> next day 02:39)', () => {
    atTime(WED_1030);
    const next = srv.getNextRun('every day at 25:99', null);
    assert.deepStrictEqual(next, new Date(2026, 6, 2, 2, 39, 0));
  });
});
