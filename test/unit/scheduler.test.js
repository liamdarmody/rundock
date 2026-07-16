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

  test('after the target time with no run today: due NOW (same-day catch-up)', () => {
    // Deliberate flip (routine-state card): the old behaviour rolled a
    // past-due target to tomorrow BEFORE the scheduler compared now >= nextRun,
    // which made the fire condition unsatisfiable except in the single
    // millisecond HH:MM:00.000. A past-due, not-yet-run daily target now stays
    // today so the next tick fires it.
    atTime(WED_1030);
    const next = srv.getNextRun('every day at 09:00', null);
    assert.deepStrictEqual(next, new Date(2026, 6, 1, 9, 0, 0));
    assert.ok(new Date() >= next, 'scheduler fire condition (now >= nextRun) is satisfied');
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

  test('ran yesterday: due today (fires on the next tick)', () => {
    atTime(new Date(2026, 6, 1, 14, 30, 0));
    const lastRun = new Date(2026, 5, 30, 14, 1, 0).toISOString();
    const next = srv.getNextRun('every day at 14:00', lastRun);
    // Deliberate flip (routine-state card): yesterday's run does not suppress
    // today; the past-due target stays today so the scheduler actually fires.
    assert.deepStrictEqual(next, new Date(2026, 6, 1, 14, 0, 0));
    assert.ok(new Date() >= next, 'scheduler fire condition (now >= nextRun) is satisfied');
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

  test('same weekday, time already past, no run today: due NOW (same-day catch-up)', () => {
    // Deliberate flip (routine-state card): see the daily catch-up test.
    atTime(WED_1030);
    const next = srv.getNextRun('every wednesday at 09:00', null);
    assert.deepStrictEqual(next, new Date(2026, 6, 1, 9, 0, 0));
    assert.ok(new Date() >= next, 'scheduler fire condition (now >= nextRun) is satisfied');
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

describe('routine state persistence (.rundock/routine-state.json)', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  let tmpDir, prevWorkspace;

  function setupTmpWorkspace() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-routine-state-'));
    prevWorkspace = srv.getWorkspace();
    srv.setWorkspace(tmpDir);
  }
  function teardownTmpWorkspace() {
    srv.setWorkspace(prevWorkspace);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  function stateFile() { return path.join(tmpDir, '.rundock', 'routine-state.json'); }

  test('recordRoutineRun persists to disk; loadRoutineState restores after a simulated restart', () => {
    setupTmpWorkspace();
    try {
      const state = { lastRun: new Date(2026, 6, 1, 14, 5, 0).toISOString(), status: 'completed', duration: 12 };
      srv.recordRoutineRun('cos:morning-briefing', state);
      assert.ok(fs.existsSync(stateFile()), 'state file written');

      // Simulated restart: in-memory state gone, disk state remains.
      delete srv.routineState['cos:morning-briefing'];
      assert.strictEqual(srv.routineState['cos:morning-briefing'], undefined);

      srv.loadRoutineState();
      assert.deepStrictEqual(srv.routineState['cos:morning-briefing'], state);
    } finally { teardownTmpWorkspace(); }
  });

  test('THE CARD SCENARIO: routine ran, server restarted in the same window -> not due again', () => {
    setupTmpWorkspace();
    try {
      // 14:05 - the daily 14:00 routine runs and its state is persisted.
      srv.recordRoutineRun('cos:morning-briefing', { lastRun: new Date(2026, 6, 1, 14, 5, 0).toISOString(), status: 'completed', duration: 12 });

      // 14:30 - the user quit and reopened Rundock (restart inside the window).
      atTime(new Date(2026, 6, 1, 14, 30, 0));
      for (const key of Object.keys(srv.routineState)) delete srv.routineState[key];
      srv.loadRoutineState();

      // The scheduler's exact due-check inputs: suppressed, no double-fire.
      const next = srv.getNextRun('every day at 14:00', srv.routineState['cos:morning-briefing']?.lastRun);
      assert.strictEqual(next, null, 'routine must not be due again after restart');

      // Control: WITHOUT persistence (pre-fix behaviour) the same routine IS
      // due again - proving the state file is what closes the hole.
      const nextWithoutPersistence = srv.getNextRun('every day at 14:00', undefined);
      assert.notStrictEqual(nextWithoutPersistence, null);
      assert.ok(new Date() >= nextWithoutPersistence, 'without persisted state the routine would double-fire');
    } finally { teardownTmpWorkspace(); }
  });

  test('a run left in status running (server died mid-run) loads as interrupted and still suppresses', () => {
    setupTmpWorkspace();
    try {
      srv.recordRoutineRun('cos:morning-briefing', { lastRun: new Date(2026, 6, 1, 14, 5, 0).toISOString(), status: 'running', duration: null });
      for (const key of Object.keys(srv.routineState)) delete srv.routineState[key];
      srv.loadRoutineState();
      assert.strictEqual(srv.routineState['cos:morning-briefing'].status, 'interrupted');

      atTime(new Date(2026, 6, 1, 14, 30, 0));
      assert.strictEqual(srv.getNextRun('every day at 14:00', srv.routineState['cos:morning-briefing'].lastRun), null);
    } finally { teardownTmpWorkspace(); }
  });

  test('missing state file: loadRoutineState starts empty without throwing', () => {
    setupTmpWorkspace();
    try {
      srv.loadRoutineState();
      assert.deepStrictEqual(srv.routineState, {});
    } finally { teardownTmpWorkspace(); }
  });

  test('corrupted state file: loadRoutineState starts empty without throwing', () => {
    setupTmpWorkspace();
    try {
      fs.mkdirSync(path.join(tmpDir, '.rundock'), { recursive: true });
      fs.writeFileSync(stateFile(), 'not json {{{');
      srv.loadRoutineState();
      assert.deepStrictEqual(srv.routineState, {});
    } finally { teardownTmpWorkspace(); }
  });

  test('entries without a string lastRun are dropped on load (defensive against hand edits)', () => {
    setupTmpWorkspace();
    try {
      fs.mkdirSync(path.join(tmpDir, '.rundock'), { recursive: true });
      fs.writeFileSync(stateFile(), JSON.stringify({
        'good:routine': { lastRun: '2026-07-01T14:05:00.000Z', status: 'completed', duration: 3 },
        'bad:routine': { status: 'completed' },
        'worse:routine': null
      }));
      srv.loadRoutineState();
      assert.ok(srv.routineState['good:routine']);
      assert.strictEqual(srv.routineState['bad:routine'], undefined);
      assert.strictEqual(srv.routineState['worse:routine'], undefined);
    } finally { teardownTmpWorkspace(); }
  });

  test('loadRoutineState replaces prior workspace state (workspace switch does not leak)', () => {
    setupTmpWorkspace();
    try {
      srv.routineState['stale:from-other-workspace'] = { lastRun: '2026-07-01T00:00:00.000Z', status: 'completed', duration: 1 };
      srv.loadRoutineState(); // tmp workspace has no state file
      assert.strictEqual(srv.routineState['stale:from-other-workspace'], undefined);
    } finally { teardownTmpWorkspace(); }
  });

  test('recordRoutineRun survives an unwritable .rundock (scheduler must not die)', () => {
    setupTmpWorkspace();
    try {
      fs.writeFileSync(path.join(tmpDir, '.rundock'), 'a file, not a directory'); // mkdir will fail
      assert.doesNotThrow(() => srv.recordRoutineRun('cos:x', { lastRun: new Date().toISOString(), status: 'completed', duration: 1 }));
      assert.ok(srv.routineState['cos:x'], 'in-memory state still recorded');
      delete srv.routineState['cos:x'];
    } finally { teardownTmpWorkspace(); }
  });
});
