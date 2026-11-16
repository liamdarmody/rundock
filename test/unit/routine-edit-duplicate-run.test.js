'use strict';
// What a schedule edit does to the guard that stops a routine firing twice.
//
// THE RISK THIS FILE EXISTS FOR IS NOT IN THE EDIT AT ALL. The scheduler keys
// run state as `${agent.id}:${routine.name}`, which is an IDENTITY and not the
// schedule text, and it compares that state's `lastRun` against a next run
// computed fresh from whatever schedule is on disk right now. So a routine that
// has already run today keeps its stamp when its schedule moves, and whether it
// then runs again, or never runs again, or catches up, is decided by a
// comparison written for a schedule that no longer exists.
//
// NOTHING HERE CHANGES THE SCHEDULER, AND NOTHING HERE MAY. The edit path is
// forbidden from touching `lastRun`, the slot store, or any other run-state
// file, so what these tests do is establish what the existing guard actually
// does across an edit, from the outside. Where the answer is surprising it is
// recorded as the answer rather than corrected here: correcting it would be a
// scheduler change, which is a different card.
//
// THE EDIT IS DRIVEN THROUGH THE REAL HANDLER, and the schedule handed to the
// scheduler is read back out of the FILE rather than restated. A test that
// asked getNextRun about a string it wrote itself would pass against a handler
// that wrote a different one.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { handleSetRoutineSchedule } = require('../../lib/protocol/handlers/team.js');
const { invalidateAgentCache, discoverAgents, extractFrontmatterText, parseRoutines } = require('../../lib/agents/discovery.js');
const config = require('../../lib/config.js');
const routinesModel = require('../../public/routines-model.js');
const { makeWorkspace, cleanup } = require('../helpers/workspace.js');

after(cleanup);

const SCHEDULER_KEY = require.resolve('../../lib/scheduler.js');

// A private copy of the scheduler per call, wired to a fixed clock, so no
// wiring and no run state leaks between tests or into the shared instance.
// Taken from the pattern routines-next-run.test.js already uses.
function withScheduler(now, fn) {
  const cached = require.cache[SCHEDULER_KEY];
  delete require.cache[SCHEDULER_KEY];
  const mod = require(SCHEDULER_KEY);
  delete require.cache[SCHEDULER_KEY];
  if (cached) require.cache[SCHEDULER_KEY] = cached;
  mod.wireSchedulerDeps({ now: () => now });
  return fn(mod);
}

// 2026-07-01 is a Wednesday and 2026-07-03 is a Friday. Every date below is
// built from local components, so this suite says the same thing in any zone.
const WED = [2026, 6, 1];
const FRI = [2026, 6, 3];
const SAT = [2026, 6, 4];
const at = ([y, m, d], hour, minute = 0) => new Date(y, m, d, hour, minute, 0);

const AGENT_NAME = 'piper';
const ROUTINE_NAME = 'Compile the ops summary';
// The scheduler's own key: identity, never the schedule. This is the whole
// reason a schedule edit reaches the guard at all.
const KEY = `${AGENT_NAME}:${ROUTINE_NAME}`;

function agentFile(schedule) {
  return [
    '---',
    `name: ${AGENT_NAME}`,
    'displayName: Piper',
    'routines:',
    `  - name: ${ROUTINE_NAME}`,
    `    schedule: ${schedule}`,
    '    prompt: Run the ops-summary skill.',
    '    skill: ops-summary',
    '    runOn: local',
    '    enabled: true',
    '---',
    '',
    '# Piper',
    '',
  ].join('\n');
}

/**
 * Move a routine from one schedule to another through the real interface, and
 * hand back the schedule the FILE now carries.
 *
 * It also reports whether anything under `.rundock/` changed, which is how the
 * card's own prohibition is checked rather than asserted: a schedule edit that
 * quietly stamped run state would satisfy every timing assertion below while
 * being exactly the thing this card must not do.
 */
function reschedule(from, to) {
  const dir = makeWorkspace({ agents: { [AGENT_NAME]: agentFile(from) } });
  const original = config.getWorkspace();
  config.setWorkspace(dir);
  invalidateAgentCache();
  discoverAgents();

  const runStateBefore = listRunState(dir);
  const sent = [];
  const ctx = {
    agents: { invalidateAgentCache, discoverSkills: () => [], flagRosterRefresh: () => {} },
    workspace: { isInsideWorkspace: (p) => p.startsWith(dir) },
  };
  const ws = { send: (m) => sent.push(JSON.parse(m)), readyState: 1 };
  try {
    handleSetRoutineSchedule(ctx, ws, {
      type: 'set_routine_schedule', agentId: AGENT_NAME, name: ROUTINE_NAME, occurrence: 0, schedule: to,
    });
    assert.strictEqual(sent[0].type, 'routine_rescheduled', 'sanity: the edit went through');
    const content = fs.readFileSync(path.join(dir, '.claude', 'agents', `${AGENT_NAME}.md`), 'utf-8');
    const written = parseRoutines(extractFrontmatterText(content), { owner: AGENT_NAME })
      .find(r => r.name === ROUTINE_NAME);
    assert.strictEqual(written.schedule, to, 'sanity: the file carries the new schedule');
    assert.deepStrictEqual(listRunState(dir), runStateBefore,
      'a schedule edit wrote run state, which is the one thing this card must not do');
    return written.schedule;
  } finally {
    config.setWorkspace(original);
    invalidateAgentCache();
  }
}

// Everything under .rundock, as name and bytes. Absent is its own answer and
// is not the same as present and empty.
function listRunState(dir) {
  const root = path.join(dir, '.rundock');
  if (!fs.existsSync(root)) return null;
  return fs.readdirSync(root).sort()
    .map(name => `${name}:${fs.readFileSync(path.join(root, name), 'utf-8')}`);
}

// The tick's own two lines, in the order it runs them: work out when this
// routine is next due from the schedule on disk and the stamp in run state,
// then fire it if that moment has arrived. Beside them, the next run the
// routine's row shows, read from the same state at the same instant, so a test
// can hold the row to what the tick will do.
function tickVerdict({ schedule, lastRun, now }) {
  return withScheduler(now, (sched) => {
    if (lastRun) sched.routineState[KEY] = { lastRun: lastRun.toISOString(), status: 'completed', duration: 30 };
    const nextRun = sched.getNextRun(schedule, sched.routineState[KEY] && sched.routineState[KEY].lastRun);
    const row = sched.routineDisplayFacts(KEY, schedule).nextRun;
    return { nextRun, due: !!nextRun && now >= nextRun, row: row ? new Date(row) : null };
  });
}

// The words that row puts beside the routine, from the model that draws it.
function rowWords(verdict, now) {
  const label = routinesModel.nextRunLabel({ nextRun: verdict.row ? verdict.row.toISOString() : null, now: now.toISOString() });
  return label ? label.text : null;
}

describe('a schedule edit and the guard that stops a second run', () => {
  // ===== MOVED LATER, ON A DAY IT HAS ALREADY RUN =====
  //
  // The suppression asks whether the stamp is at or after the scheduled TIME
  // and on the same day as that slot. A 9am run against a 2pm schedule fails
  // the first half, so it does not suppress, and the routine becomes due at
  // 2pm.
  //
  // NAMED PLAINLY BECAUSE IT IS A SECOND RUN: this routine runs twice on the
  // day it is moved, once at the old time before the edit and once at the new
  // time after it. That is the correct reading of "move it to 2pm" rather than
  // a defect, and it is what anybody reasoning about this behaviour needs to
  // know.
  test('moved to a later hour today, it becomes due at the new time rather than being suppressed', () => {
    const schedule = reschedule('every day at 09:00', 'every day at 14:00');
    const ranThisMorning = at(WED, 9, 5);

    const atEleven = tickVerdict({ schedule, lastRun: ranThisMorning, now: at(WED, 11) });
    assert.deepStrictEqual(atEleven.nextRun, at(WED, 14),
      'this morning\'s run did not suppress the new slot: it is a different slot');
    assert.strictEqual(atEleven.due, false, 'and at eleven it is not due yet');

    const atTwo = tickVerdict({ schedule, lastRun: ranThisMorning, now: at(WED, 14) });
    assert.deepStrictEqual(atTwo.nextRun, at(WED, 14));
    assert.strictEqual(atTwo.due, true, 'at two o\'clock the tick fires it');
  });

  // THE SAME MOVE INSIDE ONE HOUR, which is the case the hour comparison got
  // wrong. A run at 20:01 held a routine moved to 20:30 because both are in
  // hour 20, while the row promised 20:30 and nothing said why it never came.
  // The minute counts now, as the hour always did.
  test('moved later in the same hour today, it fires once at the new time', () => {
    const schedule = reschedule('every day at 20:01', 'every day at 20:30');
    // Started at 20:01 and stamped when it finished, two minutes later.
    const ranAtOnePast = at(FRI, 20, 3);

    const justBefore = tickVerdict({ schedule, lastRun: ranAtOnePast, now: at(FRI, 20, 29) });
    assert.deepStrictEqual(justBefore.nextRun, at(FRI, 20, 30),
      'the run at 20:01 did not serve the 20:30 slot, though both are in the same hour');
    assert.strictEqual(justBefore.due, false, 'and a minute before it, it is not due yet');

    const atTheNewTime = tickVerdict({ schedule, lastRun: ranAtOnePast, now: at(FRI, 20, 30) });
    assert.deepStrictEqual(atTheNewTime.nextRun, at(FRI, 20, 30));
    assert.strictEqual(atTheNewTime.due, true, 'at 20:30 the tick fires it');

    const afterIt = tickVerdict({ schedule, lastRun: at(FRI, 20, 31), now: at(FRI, 20, 45) });
    assert.strictEqual(afterIt.nextRun, null, 'and once it has run at 20:30 it is not run again that day');
  });

  // ===== MOVED EARLIER, TO AN HOUR THAT HAS ALREADY PASSED TODAY =====
  //
  // The routine had not run today: its old slot was still ahead of it. The
  // stamp is yesterday's, so the same-day test fails and nothing suppresses,
  // and a past-due target stays TODAY by design, which the tick reads as due
  // now. This is the missed-slot catch-up the scheduler already documents,
  // reached by an edit rather than by a machine having been asleep.
  test('moved to an hour that has already gone today, it catches up on the next tick', () => {
    const schedule = reschedule('every day at 14:00', 'every day at 09:00');
    const ranYesterday = at([2026, 5, 30], 14, 5);

    const verdict = tickVerdict({ schedule, lastRun: ranYesterday, now: at(WED, 11) });
    assert.deepStrictEqual(verdict.nextRun, at(WED, 9),
      'a past-due target stays today rather than rolling to tomorrow');
    assert.strictEqual(verdict.due, true, 'so the next tick serves it, the same day');
  });

  // THE HALF OF THAT CASE THE RISK NOTE DOES NOT NAME, and the one that decides
  // whether the identity-keyed guard is safe. Move a routine EARLIER on a day it
  // has already run, and the stamp is from today and from an hour at or after
  // the new one, so the suppression holds and there is no second run. Without
  // this the case above would read as "an earlier slot always catches up",
  // which would be a promise of a duplicate run every time somebody moved a
  // routine back an hour.
  test('moved earlier on a day it has already run, it is not run a second time', () => {
    const schedule = reschedule('every day at 09:00', 'every day at 08:00');
    const ranThisMorning = at(WED, 9, 5);

    const today = tickVerdict({ schedule, lastRun: ranThisMorning, now: at(WED, 11) });
    assert.strictEqual(today.nextRun, null,
      'the run it already had today is at or after the new hour, so it is not owed another');
    assert.strictEqual(today.due, false);

    const tomorrow = tickVerdict({ schedule, lastRun: ranThisMorning, now: at([2026, 6, 2], 11) });
    assert.deepStrictEqual(tomorrow.nextRun, at([2026, 6, 2], 8),
      'and the suppression lasts exactly one day, not longer');
    assert.strictEqual(tomorrow.due, true);
  });

  // ===== THE WEEKLY BRANCH AGREES WITH THE DAILY ONE =====
  //
  // Both shapes ask the stamp the same question: is it at or after the
  // scheduled time, on that slot's own day. The weekly suppression used to ask
  // only whether the stamp was on the target weekday and less than a day old,
  // whatever time either happened, so a weekly routine moved from Friday
  // morning to Friday afternoon waited a week while its row said that
  // afternoon. It runs that afternoon, as a daily routine moved the same way
  // does.
  test('a weekly routine moved later on its own day runs at the new time, as a daily one does', () => {
    const schedule = reschedule('every friday at 09:00', 'every friday at 14:00');
    const ranThisMorning = at(FRI, 9, 5);

    const sameDay = tickVerdict({ schedule, lastRun: ranThisMorning, now: at(FRI, 11) });
    assert.deepStrictEqual(sameDay.nextRun, at(FRI, 14),
      'this morning\'s run did not serve the afternoon slot');
    assert.strictEqual(sameDay.due, false, 'and at eleven it is not due yet');

    const atTwo = tickVerdict({ schedule, lastRun: ranThisMorning, now: at(FRI, 14) });
    assert.deepStrictEqual(atTwo.nextRun, at(FRI, 14));
    assert.strictEqual(atTwo.due, true, 'at two o\'clock the tick fires it');

    // Once, not every tick for the rest of the day.
    const ranAtTwo = at(FRI, 14, 2);
    const afterIt = tickVerdict({ schedule, lastRun: ranAtTwo, now: at(FRI, 14, 30) });
    assert.strictEqual(afterIt.nextRun, null, 'having run at the new time, it is not run again that day');

    const nextWeek = tickVerdict({ schedule, lastRun: ranAtTwo, now: at([2026, 6, 10], 14) });
    assert.deepStrictEqual(nextWeek.nextRun, at([2026, 6, 10], 14),
      'and the following Friday it runs at the new time again');
    assert.strictEqual(nextWeek.due, true);
  });

  // A weekly routine moved to a DIFFERENT weekday is not suppressed at all: the
  // stamp's day is not the target day, so the comparison fails on its first
  // half. The new day is the one that decides.
  test('a weekly routine moved to another weekday runs on that weekday', () => {
    const schedule = reschedule('every monday at 09:00', 'every friday at 09:00');
    const ranMonday = at([2026, 5, 29], 9, 5);

    const verdict = tickVerdict({ schedule, lastRun: ranMonday, now: at(WED, 11) });
    assert.deepStrictEqual(verdict.nextRun, at(FRI, 9),
      'Monday\'s run says nothing about a Friday schedule');
    assert.strictEqual(verdict.due, false, 'and Friday has not arrived yet');
  });

  // ===== MOVED LATER, TO A TIME THAT HAS ALREADY GONE =====
  //
  // The stamp is when the last run finished, and an edit leaves no mark of its
  // own, so a run at 7:00 says nothing about a 7:30 slot whether the move
  // happened at 7:10 or at 9:00. Moved at 9:00 to 7:30, the routine is owed
  // 7:30 and runs once on the next tick, late, exactly as a move to 8:30
  // does. Telling those two apart would need the moment of the edit as a
  // second input to the guard, and `lastRun` is the only input it has.
  test('moved after a run to a later time that has already gone today, it runs once, late', () => {
    const ranAtSeven = at(WED, 7, 2);
    for (const [to, slot] of [['every day at 07:30', at(WED, 7, 30)], ['every day at 08:30', at(WED, 8, 30)]]) {
      const schedule = reschedule('every day at 07:00', to);

      const atNine = tickVerdict({ schedule, lastRun: ranAtSeven, now: at(WED, 9) });
      assert.deepStrictEqual(atNine.nextRun, slot, `${to}: the 7:00 run did not serve the later slot`);
      assert.strictEqual(atNine.due, true, `${to}: so the next tick runs it, late`);

      const afterIt = tickVerdict({ schedule, lastRun: at(WED, 9, 1), now: at(WED, 9, 30) });
      assert.strictEqual(afterIt.nextRun, null, `${to}: and only once`);
    }
  });

  // ===== MOVED LATER, AND THEN BACK =====
  //
  // The inverse of the move, once the new time has come and gone. The run at
  // 20:30 is stamped after 20:01, so moving the routine back to 20:01 owes it
  // nothing more that day, and the row looks to tomorrow.
  test('moved later, run at the new time, then moved back, it is not run again that day', () => {
    reschedule('every day at 20:01', 'every day at 20:30');
    const schedule = reschedule('every day at 20:30', 'every day at 20:01');
    const ranAtHalfPast = at(FRI, 20, 31);

    for (const now of [at(FRI, 20, 45), at(FRI, 23, 59)]) {
      const verdict = tickVerdict({ schedule, lastRun: ranAtHalfPast, now });
      assert.strictEqual(verdict.nextRun, null, `at ${now.toTimeString().slice(0, 5)} it is not owed another run`);
      assert.deepStrictEqual(verdict.row, at(SAT, 20, 1), 'and its row looks to tomorrow');
      assert.strictEqual(rowWords(verdict, now), 'Next run: tomorrow, 8:01pm');
    }
  });

  // The undo: moved later and back again before the new time came. The run at
  // 20:01 is the run that day, and the edits in between leave nothing behind
  // that could ask for another.
  test('moved later and back again before the new time came, it runs once that day', () => {
    reschedule('every day at 20:01', 'every day at 20:30');
    const schedule = reschedule('every day at 20:30', 'every day at 20:01');
    const ranAtOnePast = at(FRI, 20, 3);

    for (const now of [at(FRI, 20, 20), at(FRI, 20, 30), at(FRI, 23, 59)]) {
      const verdict = tickVerdict({ schedule, lastRun: ranAtOnePast, now });
      assert.strictEqual(verdict.nextRun, null, `at ${now.toTimeString().slice(0, 5)} there is no second run`);
      assert.deepStrictEqual(verdict.row, at(SAT, 20, 1));
      assert.strictEqual(rowWords(verdict, now), 'Next run: tomorrow, 8:01pm');
    }
  });

  // ===== A ROUTINE THAT HAS NEVER RUN =====
  //
  // No stamp, so nothing to suppress with, on either branch. Included because
  // it is the commonest routine on a fresh workspace and a guard reading an
  // absent stamp as a recent one would hold every one of them back forever.
  test('a routine with no run behind it is due on the new schedule', () => {
    const schedule = reschedule('every day at 09:00', 'every day at 14:00');
    const verdict = tickVerdict({ schedule, lastRun: null, now: at(WED, 14, 30) });
    assert.deepStrictEqual(verdict.nextRun, at(WED, 14));
    assert.strictEqual(verdict.due, true);
  });
});
