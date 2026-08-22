'use strict';
// A run leaves a record of its own.
//
// Before this card there was no history. routineState holds ONE slot per
// routine and every run overwrites its predecessor, so nothing could say what
// happened yesterday, how often a routine has failed, or how long it usually
// takes. These tests are about the store that can.
//
// WHAT EVERY TEST HERE HAS TO BE CAREFUL OF, and it is the reason several of
// them look heavier than their assertion. A test that sees two records is
// indistinguishable from a test that would see two whatever the writer did,
// unless one record per run is proved by making the writer produce a different
// number. So the accumulation tests assert the COUNT and the IDS and the
// STATUSES together: removing the opening write leaves none, giving every run
// the same identity leaves one, and removing the closing write leaves records
// that never stop saying 'running'. Each of those is a different failure.
//
// Setup is the scheduler-tick-isolation template: stop the boot-armed tick
// first, mock setInterval, then start, so the interval being driven is the
// mocked one. The clock is the scheduler's own seam, so every instant in this
// file is chosen rather than measured, and nothing rests on real elapsed time.
//
// A tick sees every routine in the workspace, so each test names the routines
// it wants live and the rest are quietened with a stamp late on its own day.
// Each test also owns a day, because a run stamped on a shared day suppresses
// another test's routine through the ordinary schedule rule.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const h = require('../helpers/harness.js');
const { agentFile, makeWorkspace } = require('../helpers/workspace.js');
const { calledFrom } = require('../helpers/stack.js');

const scheduler = require('../../lib/scheduler.js');

// Built rather than written, so the byte that makes the faulty fixture throw
// is visible in the source instead of being an invisible character in it.
const NUL = String.fromCharCode(0);

const KEEPER = 'keeper:briefing';
const TWINS = 'twins:check';
const FAULTY = 'faulty:faulty-check';
const CRASHER = 'crasher:crash-check';
const CODEX = 'codex-keeper:codex-check';
const MISMATCH = 'mismatched:whoami';
const RENAMED = 'keeper:briefing-renamed';
const ALL = [KEEPER, TWINS, FAULTY, CRASHER, CODEX, MISMATCH, RENAMED];

const KEEPER_BODY = 'keeper routine body';
const TWIN_EARLY = 'twin early body';
const TWIN_LATE = 'twin late body';
const CRASH_BODY = 'crasher routine body';
const MISMATCH_BODY = 'mismatched routine body';

// September 2026, local components, so the fixture is timezone-independent.
function dayAt(day, hour, minute) { return new Date(2026, 8, day, hour, minute, 0); }

const clock = { at: dayAt(1, 5, 30) };
let prevDeps = null;
let keeperAgentFile = null;

before(async () => {
  await h.boot({
    agents: {
      keeper: agentFile({
        name: 'keeper', type: 'specialist', order: 1,
        routines: [{ name: 'briefing', schedule: 'every day at 05:00', prompt: KEEPER_BODY }],
      }),
      // TWO ROUTINES SHARING A NAME UNDER ONE AGENT, which the data model
      // deliberately allows and test/unit/routine-model.test.js pins. They
      // share the key `twins:check`, so the key can never tell their runs
      // apart. Different times, because sharing a key also means sharing the
      // single-flight hold and the double-fire suppression: at 05:00 only the
      // first is due, and at 09:00 only the second is.
      twins: agentFile({
        name: 'twins', type: 'specialist', order: 2,
        routines: [
          { name: 'check', schedule: 'every day at 05:00', prompt: TWIN_EARLY },
          { name: 'check', schedule: 'every day at 09:00', prompt: TWIN_LATE },
        ],
      }),
      // The thrower. Its prompt reaches spawn as an argument Node refuses, so
      // the start throws synchronously through the whole production path with
      // nothing stood in for.
      faulty: agentFile({
        name: 'faulty', type: 'specialist', order: 3,
        routines: [{ name: 'faulty-check', schedule: 'every day at 05:00', prompt: `bad${NUL}body` }],
      }),
      // A run whose CHILD fails, which is the only way a routine fails in the
      // field: the CLI crashing, running out of memory, an expired login, the
      // process killed at quit. Every one of those arrives as a non-zero close
      // code on a child that really started, which is a different path from the
      // start that never reached one.
      crasher: agentFile({
        name: 'crasher', type: 'specialist', order: 4,
        routines: [{ name: 'crash-check', schedule: 'every day at 05:00', prompt: CRASH_BODY }],
      }),
      // The second runtime. Routines on it reach the same outcome closure by a
      // completely different route, so a record written on the claude path says
      // nothing about this one.
      'codex-keeper': agentFile({
        name: 'codex-keeper', type: 'specialist', order: 5, runtime: 'codex',
        routines: [{ name: 'codex-check', schedule: 'every day at 05:00', prompt: 'codex routine body' }],
      }),
      // THE ONLY AGENT IN THIS FILE WHOSE ID AND NAME DIFFER, and it exists for
      // exactly that. The id comes from the filename and the name from the
      // frontmatter, and every other fixture here sets them to the same string,
      // so a record carrying either one would look identical. A hand-written or
      // marketplace agent normally has them apart.
      mismatched: agentFile({
        name: 'Mismatched Display Name', type: 'specialist', order: 6,
        routines: [{ name: 'whoami', schedule: 'every day at 05:00', prompt: MISMATCH_BODY }],
      }),
    },
  });
  keeperAgentFile = path.join(h.workspaceDir, '.claude', 'agents', 'keeper.md');
  h.writeScenario([
    // The delay holds the child open past the synchronous tick, which is what
    // lets a test move the clock between a run's start and its end and read
    // the record while it is still open.
    { match: { agent: 'keeper' }, delayMs: 200, turn: [{ text: 'keeper ran' }] },
    { match: { agent: 'twins' }, turn: [{ text: 'twin ran' }] },
    // Exits non-zero WITHOUT a result envelope: an abnormal mid-run death, not
    // a routine that reported a failure. The delay holds it open past the
    // synchronous tick, the same as the keeper rule above.
    { match: { agent: 'crasher' }, delayMs: 200, crash: 1 },
    { match: { agent: 'mismatched' }, turn: [{ text: 'mismatched ran' }] },
  ]);
  // No rules: the codex stub answers an unmatched prompt with an ordinary turn
  // that completes, which is the successful path on that runtime.
  h.writeCodexScenario([]);
  prevDeps = scheduler.wireSchedulerDeps({ now: () => clock.at });
});

after(async () => {
  if (prevDeps) scheduler.wireSchedulerDeps(prevDeps);
  await h.shutdown();
});

function runsDir() { return path.join(h.workspaceDir, '.rundock', 'runs'); }

// Everything the store holds for this workspace, dropped so a test's counts
// are its own. Accumulation is proved WITHIN a test, by running twice, which
// is what the criterion is about; leaving the previous test's records in place
// would only make every count a running total nobody could reason about.
function wipeRuns() { fs.rmSync(runsDir(), { recursive: true, force: true }); }

function records() { return scheduler.readRunRecords(); }
function recordsFor(agentId) { return records().filter(r => r.agent === agentId); }

// The reader promises no order, because a directory listing has none to give,
// so a test that cares about which runs happened sorts by the instant each
// record carries. Asserting the reader's own sequence would be asserting the
// filesystem's.
function startedAts(recs) { return recs.map(r => r.startedAt).sort(); }

// A run recorded late on the test's own day suppresses a routine through the
// ordinary schedule rule, so a pass only ever starts the routines it names.
function quieten(day, live) {
  for (const key of ALL) {
    if (live.includes(key)) continue;
    h.internal.routineState[key] = { lastRun: dayAt(day, 23, 0).toISOString(), status: 'completed', duration: 1 };
  }
}

/** Move to a fresh day with `live` due and everything else quiet. */
function advance(day, live, hour = 5, minute = 30) {
  clock.at = dayAt(day, hour, minute);
  for (const key of live) delete h.internal.routineState[key];
  quieten(day, live);
}

/** As `advance`, and start from an empty store. */
function begin(day, live, hour = 5, minute = 30) {
  wipeRuns();
  advance(day, live, hour, minute);
}

// Ticks the real scheduler with the console captured. The server armed a tick
// at boot and a second start is a no-op, so the real one is stopped before the
// mocked one this drives is armed.
//
// The tick is driven INSIDE the capture and not wrapped in a try, so a pass
// that ends by throwing fails its test where it happened.
//
// Returns synchronously without yielding to the event loop, which several
// tests depend on: a child spawned by the pass cannot have closed yet, so the
// clock can still be moved before the run reaches its outcome.
function driveTicks(t, count = 1) {
  const logs = [];
  const errors = [];
  const real = { log: console.log, error: console.error };
  h.internal.stopScheduler();
  t.mock.timers.enable({ apis: ['setInterval'] });
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => errors.push(args.join(' '));
  try {
    h.internal.startScheduler();
    for (let i = 0; i < count; i++) t.mock.timers.tick(60_000);
  } finally {
    console.log = real.log;
    console.error = real.error;
    h.internal.stopScheduler();
    t.mock.timers.reset();
  }
  return { logs, errors };
}

function settled(key, opts) {
  return h.waitUntil(() => {
    const s = h.internal.routineState[key];
    return s && s.status !== 'running';
  }, opts);
}

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

// AC-1 to AC-5, AC-7, AC-8, AC-12 and AC-14, in the one place where all of
// them are visible at once: a run watched from the moment it starts to the
// moment it ends.
//
// The two instants are DIFFERENT chosen values rather than one frozen one, and
// the duration is asserted against the gap between them. A frozen clock would
// make startedAt, endedAt and a duration of zero all agree with a writer that
// stamped a constant, or with no writer at all.
test('a run leaves one record, open while it runs and closed when it ends', async (t) => {
  begin(1, [KEEPER]);

  driveTicks(t);

  // The child is still alive: the record exists and says so. This is also the
  // proof that the ending REPLACES this record rather than adding a second,
  // since the count below never changes.
  const open = records();
  assert.strictEqual(open.length, 1, 'the run that started opened exactly one record');
  assert.strictEqual(open[0].status, 'running', 'and it says the run is running');
  assert.strictEqual(open[0].endedAt, null, 'with no ending yet');
  assert.strictEqual(open[0].durationMs, null, 'and no duration yet');

  // THE OPEN RECORD IS ASSERTED IN FULL, not just for the two fields that
  // differ from a closed one. An open record is not a transient: it is what a
  // sleeping machine, a quit, or a killed process leaves behind, because the
  // closing write only ever runs from a live handler. So the run that never
  // finished is exactly the run a history most needs to show, and one carrying
  // an id and a start time and nothing else is dropped by any reader that
  // filters by agent. Asserting only the closed record hides this completely,
  // because the closing write rewrites the whole file from the handle and
  // repairs any omission before anything looks.
  assert.deepStrictEqual(Object.keys(open[0]).sort(),
    ['agent', 'durationMs', 'endedAt', 'error', 'files', 'filesReason', 'filesStatus', 'id', 'routine', 'sessionId', 'startedAt', 'status'],
    'an open record carries every field a closed one does');
  assert.strictEqual(open[0].agent, 'keeper', 'including the agent it belongs to');
  assert.strictEqual(open[0].routine, 'briefing', 'and the routine it belongs to');
  assert.strictEqual(open[0].startedAt, dayAt(1, 5, 30).toISOString(), 'and when it started');
  assert.strictEqual(open[0].error, null, 'and nothing has gone wrong yet');

  // Five minutes of the run's life, chosen rather than waited for.
  clock.at = dayAt(1, 5, 35);
  assert.ok(await settled(KEEPER), 'the run finished');

  const closed = records();
  assert.strictEqual(closed.length, 1, 'the run that ended left one record, not a second one');
  const rec = closed[0];
  assert.strictEqual(rec.id, open[0].id, 'and it is the same record the start opened');
  assert.strictEqual(typeof rec.id, 'string', 'a run carries an identity of its own');
  assert.ok(rec.id.length > 0, 'and it is not empty');
  assert.strictEqual(rec.agent, 'keeper', 'the record names the agent it belongs to');
  assert.strictEqual(rec.routine, 'briefing', 'and the routine it belongs to');
  assert.strictEqual(rec.status, 'succeeded', 'the outcome, in the record vocabulary');
  assert.strictEqual(rec.startedAt, dayAt(1, 5, 30).toISOString(), 'when the run started');
  assert.strictEqual(rec.endedAt, dayAt(1, 5, 35).toISOString(), 'when it ended');
  assert.strictEqual(rec.durationMs, 5 * 60 * 1000,
    'and how long it took, which is the gap between those two instants and not a constant');
  assert.strictEqual(rec.error, null, 'a run that succeeded gave no reason, so none is recorded');
});

// AC-6 and AC-22, on the first of the three failures that hand over a reason.
// The other two are a child that never launched and a codex turn that could not
// start, each covered by its own test. The failure with no reason to give is a
// child that ran and exited non-zero: an exit code is not a message, and
// reading what the child said is explicitly another card.
//
// It is also where a record could most easily be abandoned. The start throws
// out of executeRoutine, so nothing on the ordinary outcome path runs, and a
// record opened and never closed would sit at 'running' forever: the exact
// silence recordFailedStart removed from the routine state.
test('a start that throws closes its record as failed, with the reason it gave', async (t) => {
  begin(2, [FAULTY]);

  driveTicks(t);

  const recs = records();
  assert.strictEqual(recs.length, 1, 'the attempt left one record');
  const rec = recs[0];
  assert.strictEqual(rec.status, 'failed', 'closed as failed rather than abandoned at running');
  assert.match(rec.error, /null byte/i, 'carrying the reason the failure itself gave');
  assert.strictEqual(rec.agent, 'faulty', 'and naming the agent');
  assert.strictEqual(rec.routine, 'faulty-check', 'and the routine');
  assert.strictEqual(rec.endedAt, rec.startedAt,
    'a failure that never reached a child ends in the instant it began');
  assert.strictEqual(rec.durationMs, 0, 'so it took no time');

  // The two stores agree that this failed, in their own words. The routine
  // state keeps the tokens it shipped with; the record uses the frozen
  // vocabulary. Neither was renamed to match the other.
  assert.strictEqual(h.internal.routineState[FAULTY].status, 'failed',
    'and the routine state recorded the same failure, unchanged by this card');
});

// AC-4, AC-6 and AC-14 on the path that actually produces failures. Every
// other failed record in this file comes from a start that threw before there
// was a child, which is the rare case and is documented as the rare case. What
// happens in the field is a child that started and died: the CLI crashing,
// running out of memory, a login that expired overnight, the process killed
// when the app quit. All of them arrive as a non-zero close code, and this
// store exists to answer how often a routine has failed, so a history that
// called them all successes would answer it wrongly and confidently.
//
// The routine state records a failure here too, so without this test the two
// stores would disagree with only one of them tested.
test('a run whose child dies is recorded as failed, and gives no reason it does not have', async (t) => {
  begin(15, [CRASHER]);

  driveTicks(t);
  clock.at = dayAt(15, 5, 32);
  assert.ok(await settled(CRASHER), 'the run reached an outcome');

  const recs = records();
  assert.strictEqual(recs.length, 1, 'the run left one record');
  const rec = recs[0];
  assert.strictEqual(rec.status, 'failed', 'a child that exited non-zero is a failed run, not a succeeded one');
  assert.strictEqual(rec.agent, 'crasher', 'naming the agent');
  assert.strictEqual(rec.routine, 'crash-check', 'and the routine');
  assert.strictEqual(rec.startedAt, dayAt(15, 5, 30).toISOString(), 'started when the tick started it');
  assert.strictEqual(rec.endedAt, dayAt(15, 5, 32).toISOString(), 'and ended when its child did');
  assert.strictEqual(rec.durationMs, 2 * 60 * 1000, 'so it has a real duration, which a start that never ran does not');
  // NOT an omission. The child said nothing a record could carry: an exit code
  // is not a message, and reading what a routine wrote on its way out is
  // explicitly another card. A reason invented here would be this file's guess
  // rather than the failure's own words.
  assert.strictEqual(rec.error, null,
    'and no reason, because a non-zero exit gives none and the output is not read');

  assert.strictEqual(h.internal.routineState[CRASHER].status, 'failed',
    'the routine state agrees, in its own vocabulary');
});

// The second runtime. A routine on a codex agent reaches the same outcome
// closure by a completely different route: an app-server thread, a turn, and a
// promise, with no child process and no close event anywhere in it. A record
// written on the claude path proves nothing about this one, and until this test
// no codex agent existed in this file at all.
test('a routine on the codex runtime leaves a record too', async (t) => {
  begin(16, [CODEX]);

  driveTicks(t);
  // The codex path is asynchronous through a real app-server handshake, so it
  // gets room the claude path does not need.
  assert.ok(await settled(CODEX, { timeout: 20000 }), 'the codex run reached an outcome');

  // The branch is asserted, not assumed. Discovery is what decides a routine
  // takes the codex path, and a fixture whose runtime field stopped being
  // honoured would run this through the claude stub and produce an identical
  // record, leaving the test green and the path uncovered.
  assert.ok(h.codexTurnPrompts().some(prompt => prompt.includes('codex routine body')),
    'the routine really went through the codex app-server rather than a spawned child');

  const recs = records();
  assert.strictEqual(recs.length, 1, 'the codex run left one record');
  assert.strictEqual(recs[0].agent, 'codex-keeper', 'naming the agent whose runtime it ran on');
  assert.strictEqual(recs[0].routine, 'codex-check', 'and the routine');
  assert.strictEqual(recs[0].status, 'succeeded', 'in the same vocabulary the other runtime uses');
  assert.strictEqual(recs[0].startedAt, dayAt(16, 5, 30).toISOString(), 'and the instant the tick started it');
  assert.ok(recs[0].endedAt, 'and it was closed rather than left open');
});

// AC-7, pinned to the id rather than to a coincidence. Everything else keys on
// the agent id: the routine key the scheduler builds, the run state, the
// single-flight hold, and the signals event written beside this record. A
// record carrying the display name could not be joined back to any of them.
//
// The consequence is deferred, because nothing reads these records yet, and
// that is what makes it worth pinning now: the wrong string would be written to
// users' disks permanently and could not be re-derived afterwards.
test('the record names the agent by the id everything else keys on, not its display name', async (t) => {
  const agent = h.internal.discoverAgents().find(a => a.id === 'mismatched');
  // The fixture defends itself. Every other agent in this file has an id equal
  // to its name, so if this one ever collapsed to the same shape the assertion
  // below would pass while proving nothing.
  assert.ok(agent, 'the agent is on the roster');
  assert.strictEqual(agent.name, 'Mismatched Display Name', 'whose frontmatter name is not its id');
  assert.notStrictEqual(agent.name, agent.id, 'so the two really do diverge here');

  begin(17, [MISMATCH]);
  driveTicks(t);
  assert.ok(await settled(MISMATCH), 'the run finished');

  const [rec] = records();
  assert.strictEqual(rec.agent, 'mismatched', 'the record carries the id');
  assert.notStrictEqual(rec.agent, agent.name, 'and not the name a person reads on screen');
  assert.ok(h.internal.routineState[`${rec.agent}:${rec.routine}`],
    'so the record joins back to the run state, which is the point of carrying it');
});

// AC-6 on the OTHER kind of failure, and the distinction is the whole point.
// A child that exits non-zero says nothing a record could carry, so `error` is
// null there and that is honest. A codex turn that cannot start its thread is
// handed an object with a message, and the scheduler already prints that
// message to the console one line before the outcome is recorded. A record
// saying `failed` with no reason, beside a log line saying exactly why, is a
// reason discarded rather than a reason absent.
//
// The console line is what the assertion is anchored to, rather than a literal
// string of the client's. What must hold is that the record carries the same
// reason the failure gave, not that the reason reads any particular way.
test('a codex run that cannot start its thread records the reason it was given', async (t) => {
  begin(18, [CODEX]);
  // Exhaust the client's retries so thread/start ultimately rejects. This is
  // the rejection path, not a turn that ran and failed.
  h.writeCodexScenario([], { overload: { method: 'thread/start', times: 10 } });

  const errors = [];
  const realError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    driveTicks(t);
    assert.ok(await settled(CODEX, { timeout: 25000 }), 'the codex run reached an outcome');
  } finally {
    console.error = realError;
    h.writeCodexScenario([]);
  }

  const [rec] = records();
  assert.strictEqual(rec.status, 'failed', 'a thread that never started is a failed run');
  assert.ok(typeof rec.error === 'string' && rec.error.length > 0,
    'and the record carries a reason rather than nothing');

  const logged = errors.find(e => e.includes('codex-check') && e.includes('failed to run'));
  assert.ok(logged, 'the scheduler printed why, which is what proves a reason existed to be kept');
  assert.ok(logged.includes(rec.error),
    'and the record carries that same reason, rather than dropping it one line after it was printed');
});

// ---------------------------------------------------------------------------
// Accumulation
// ---------------------------------------------------------------------------

// AC-12, AC-13, AC-27 and AC-28. Two runs of ONE routine, on two days.
//
// Every assertion here is chosen so that a different fault produces a
// different failure: no opening write leaves zero records, one identity for
// every run leaves one, and no closing write leaves two that still say
// 'running'.
test('two runs of one routine leave two records, one for each', async (t) => {
  begin(3, [KEEPER]);
  driveTicks(t);
  assert.ok(await settled(KEEPER), 'the first run finished');
  assert.strictEqual(records().length, 1, 'one run so far, one record');

  advance(4, [KEEPER]);
  driveTicks(t);
  assert.ok(await settled(KEEPER), 'the second run finished');

  const recs = recordsFor('keeper');
  assert.strictEqual(recs.length, 2, 'the second run did not replace the first');
  assert.notStrictEqual(recs[0].id, recs[1].id,
    'the two runs have different identities, which is what stops one overwriting the other');
  assert.deepStrictEqual(startedAts(recs), [dayAt(3, 5, 30).toISOString(), dayAt(4, 5, 30).toISOString()],
    'and the two records are the two runs, each carrying the instant its own began');
  assert.deepStrictEqual(recs.map(r => r.status), ['succeeded', 'succeeded'],
    'both reached an ending, so neither was left open');
  assert.deepStrictEqual(recs.map(r => r.routine), ['briefing', 'briefing'],
    'and both belong to the one routine that ran twice');
});

// AC-2, on the question of WHICH instant a start is. The tick reads the clock
// once and judges every routine against that one reading. A record that read
// the clock again would describe the same start at a different moment, and the
// run's own elapsed time would be measured from a third. Under a frozen clock
// all of them are the same string and nothing can tell them apart.
//
// THE CLOCK HERE JUMPS ONCE, on its second reading, and then holds. That is
// what makes every reading nameable without counting any: the tick's is the
// only one before the jump, and everything the run does afterwards sees one
// other value. Counting readings was tried on this project twice and was wrong
// both times, because the total moves whenever a fixture grows.
//
// Five minutes, so the jump stays inside the routine's own day and the pass
// still judges it due.
test('a run is timed from the one instant the tick judged it due', async (t) => {
  begin(19, [KEEPER]);
  const base = dayAt(19, 5, 30);
  const JUMP = 5 * 60 * 1000;
  let reads = 0;
  const prev = scheduler.wireSchedulerDeps({
    now: () => new Date(base.getTime() + (reads++ === 0 ? 0 : JUMP)),
  });
  try {
    driveTicks(t);
    assert.ok(await settled(KEEPER), 'the run finished');
  } finally {
    scheduler.wireSchedulerDeps(prev);
  }

  // Proves the clock did what the test claims before anything is concluded
  // from it. A fake that never moved would make every assertion below pass
  // against code that reads the clock as often as it likes.
  assert.ok(reads > 1, 'the clock was read more than once, so its readings really do differ');

  const [rec] = records();
  assert.strictEqual(rec.startedAt, base.toISOString(),
    "the record's start is the tick's own reading, not a later one taken on the way to it");
  assert.strictEqual(rec.endedAt, new Date(base.getTime() + JUMP).toISOString(),
    'and its ending is a reading from after the jump, so the two are not the same value by accident');
  assert.strictEqual(rec.durationMs, JUMP, 'so the record spans the whole run');

  // The run's own elapsed time is measured from the same instant. Read from a
  // later reading it would be zero, because every reading after the first is
  // the same one.
  assert.strictEqual(h.internal.routineState[KEEPER].duration, JUMP / 1000,
    'and the routine state measured the run from that instant too, not from a reading of its own');

  // THE ONE READING DELIBERATELY LEFT ALONE, said here as well as at the code.
  // The routine state's stamp is the sole input to double-fire suppression and
  // is written by beginRun from its own reading. It stays there because moving
  // the suppression's input is a behaviour change this card has no business
  // making, and because an existing test drives a throw at exactly that read to
  // prove the failed-start floor.
  assert.strictEqual(h.internal.routineState[KEEPER].lastRun, new Date(base.getTime() + JUMP).toISOString(),
    'while the suppression stamp keeps its own later reading, which is deliberate');
});

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

// AC-9 and AC-10. The routine key `agentId:routineName` is neither unique nor
// stable, and this is the unique half: two routines under one agent, both
// named `check`, sharing one key, one state slot and one single-flight hold.
// Nothing keyed by the routine could tell their runs apart.
//
// The prompts are what make this two ROUTINES rather than one routine twice.
// Without them the test is satisfied by the accumulation above.
test('two routines sharing a name under one agent leave records that can be told apart', async (t) => {
  begin(5, [TWINS]);
  h.clearPrompts();

  driveTicks(t);
  assert.ok(await settled(TWINS), 'the 05:00 routine finished');

  // Same day, four hours on, and the clock alone: the run state is what makes
  // this work. The 05:00 routine is suppressed by the stamp its own run left,
  // and the 09:00 namesake reads that same stamp as too early to suppress it.
  // Re-quietening here would overwrite that stamp and silence both.
  clock.at = dayAt(5, 9, 30);
  driveTicks(t);
  assert.ok(await settled(TWINS), 'the 09:00 routine finished');

  const prompts = h.promptsFor('twins');
  assert.ok(prompts.includes(TWIN_EARLY), 'the first namesake ran');
  assert.ok(prompts.includes(TWIN_LATE), 'and so did the second, which is a different routine');

  const recs = recordsFor('twins');
  assert.strictEqual(recs.length, 2, 'two runs, two records');
  assert.notStrictEqual(recs[0].id, recs[1].id,
    'told apart by an identity of their own, which is the only thing that can: the key is the same for both');
  assert.deepStrictEqual(startedAts(recs), [dayAt(5, 5, 30).toISOString(), dayAt(5, 9, 30).toISOString()],
    'and each carries the instant its own run started');
  assert.deepStrictEqual(recs.map(r => r.routine), ['check', 'check'],
    'both name the routine they belong to, which for namesakes is the same name: the record says what it can vouch for');
});

// AC-11, the stable half. A rename produces a different key, so anything
// identified by the key would either lose its history or hand it to the new
// name. A record is written once and never rewritten, so what it says about
// itself survives an edit to the routine that made it.
test('renaming a routine leaves the records it already wrote untouched', async (t) => {
  const original = fs.readFileSync(keeperAgentFile, 'utf-8');
  begin(6, [KEEPER]);
  driveTicks(t);
  assert.ok(await settled(KEEPER), 'the run under the old name finished');
  const before = records();
  assert.strictEqual(before.length, 1, 'one run under the old name');

  try {
    fs.writeFileSync(keeperAgentFile, original.replace('name: briefing', 'name: briefing-renamed'));
    h.internal.invalidateAgentCache();

    advance(7, [RENAMED]);
    driveTicks(t);
    assert.ok(await settled(RENAMED), 'the run under the new name finished');

    const after = records();
    assert.strictEqual(after.length, 2, 'the rename added a record rather than replacing one');
    const kept = after.find(r => r.id === before[0].id);
    assert.deepStrictEqual(kept, before[0],
      'the record written before the rename is byte-for-byte what it was, still naming the routine that ran');
    assert.strictEqual(kept.routine, 'briefing', 'including the name the routine had at the time');
    const fresh = after.find(r => r.id !== before[0].id);
    assert.strictEqual(fresh.routine, 'briefing-renamed', 'and the new run recorded the name it ran under');
  } finally {
    fs.writeFileSync(keeperAgentFile, original);
    h.internal.invalidateAgentCache();
    delete h.internal.routineState[RENAMED];
  }
});

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

// AC-14, AC-15 and AC-16 together, because they are one decision seen from
// three sides: the record has its own words, it writes none it cannot mean,
// and the routine state keeps the words it shipped with.
test('records use the frozen vocabulary and the routine state keeps its own', async (t) => {
  begin(8, [KEEPER, FAULTY]);

  driveTicks(t);
  assert.ok(await settled(KEEPER), 'the run that succeeds finished');

  const statuses = records().map(r => r.status).sort();
  assert.deepStrictEqual(statuses, ['failed', 'succeeded'],
    'a pass with one success and one failure wrote exactly those two words');

  // AC-15, that no record carries a state the product cannot produce, is NOT
  // asserted here, and saying so is more honest than the assertion that used to
  // be. `queued` and `cancelled` cannot be driven: nothing queues a run, since
  // a routine starts the moment it is found due, and the child handle is never
  // kept, so nothing can reach a run to cancel it. An assertion that an
  // unreachable value is absent is an assertion that cannot fail, and this file
  // has already removed one promise nothing could hold. The criterion is a
  // property of the writer, which states its three statuses as literals and is
  // read in the diff. The set assertion above is what catches a fourth word
  // arriving, because it names the whole set rather than forbidding two members
  // of it.

  assert.strictEqual(h.internal.routineState[KEEPER].status, 'completed',
    'the routine state still says completed, which is the token on every user disk and was not renamed');
});

// ---------------------------------------------------------------------------
// Separation, which is the crux
// ---------------------------------------------------------------------------

// AC-17, AC-18 and AC-19. routineState is simultaneously the display record
// and the ONLY input to double-fire suppression, read as
// getNextRun(schedule, routineState[key]?.lastRun). A run record that reached
// it would move the instant the suppression fires on.
//
// This is a negative criterion, so removing the record writer cannot make it
// fail. That is what the first assertion is for: without a record on disk the
// test is satisfied by a build that has no run records at all. What it DOES
// catch is the mutation it exists for, a field or a stamp leaking across.
test('nothing a record writes reaches the value double-fire suppression reads', async (t) => {
  begin(9, [KEEPER]);

  driveTicks(t);
  // TWO CHOSEN INSTANTS, and the whole criterion rests on them. Frozen, the
  // instant the run started and the instant it ended are the same string, so a
  // record field fed into the suppression stamp would be indistinguishable from
  // the stamp the run wrote itself, and this test would defend its criterion
  // nowhere while appearing to defend it here.
  clock.at = dayAt(9, 5, 45);
  assert.ok(await settled(KEEPER), 'the run finished');
  const [rec] = records();
  assert.strictEqual(records().length, 1, 'a record really was written on this pass');

  assert.deepStrictEqual(Object.keys(h.internal.routineState[KEEPER]).sort(), ['duration', 'lastRun', 'status'],
    'the routine state kept its shape: no run id, no record fields, nothing new');
  assert.strictEqual(h.internal.routineState[KEEPER].lastRun, dayAt(9, 5, 45).toISOString(),
    'and its stamp is the one the RUN wrote when it ended');
  assert.strictEqual(rec.startedAt, dayAt(9, 5, 30).toISOString(),
    'while the record carries a different instant entirely');
  assert.notStrictEqual(h.internal.routineState[KEEPER].lastRun, rec.startedAt,
    'so a record field reaching the suppression stamp would move it, visibly');
  assert.deepStrictEqual(Object.keys(h.internal.routineSlots.routines[KEEPER]).sort(), ['due', 'missed', 'schedule'],
    'and the slot store kept its shape too');

  // The consequence, which is what the criterion is really about: the routine
  // is still held for the rest of its period. A stamp moved by a record would
  // show up here as a second run.
  driveTicks(t);
  assert.strictEqual(records().length, 1, 'the same day started no second run, so no second record');
});

// ---------------------------------------------------------------------------
// Failing safely
// ---------------------------------------------------------------------------

// AC-20, AC-21 and AC-30. A regular file where the store must create a folder,
// so mkdir throws for a real reason rather than through a stub. The routine
// still runs, the pass still finishes its bookkeeping, and the reader survives
// the same directory.
test('a workspace that cannot be written to does not stop the run or the pass', async (t) => {
  begin(10, [KEEPER]);
  fs.mkdirSync(path.dirname(runsDir()), { recursive: true });
  fs.writeFileSync(runsDir(), 'not a directory');
  h.clearPrompts();

  try {
    const { errors } = driveTicks(t);

    assert.ok(await settled(KEEPER), 'the run reached an outcome');
    assert.strictEqual(h.internal.routineState[KEEPER].status, 'completed',
      'the routine ran and completed, so an unwritable store did not stop it');
    assert.ok(h.promptsFor('keeper').includes(KEEPER_BODY), 'and the agent really was asked to do the work');
    assert.strictEqual(h.internal.routineSlots.observedAt, dayAt(10, 5, 30).toISOString(),
      'and the bookkeeping below the routine loop still ran, so the pass did not end either');
    assert.ok(errors.some(e => e.includes('run record')),
      'the failure was said once rather than swallowed silently');
    assert.deepStrictEqual(records(), [],
      'and the reader answers for an unreadable store rather than throwing out of its caller');
  } finally {
    fs.rmSync(runsDir(), { force: true });
  }
});

// AC-22 from the other side. Writing a record cannot throw, but getting as far
// as opening one can: it needs the clock, and it needs a workspace root to
// resolve a directory against. Opened outside the guard that releases the
// routine, that throw arrives after the routine has been added to the in-flight
// set and before anything exists to take it out again, and the routine is held
// for the life of the process: no spawn, no child, no close, nothing that will
// ever release it.
//
// The clock is the seam, because it is the one this file can make fail without
// making anything else pretend. Single-shot, and selected on the call site
// rather than on a count of readings: the tick reads once and then once per
// routine to ask whether each is due, and that total moves whenever the fixture
// grows. beginRun is excluded because a throw from inside it happens AFTER the
// record has been opened, which is a different case with a test of its own.
//
// The selection matches FRAMES, not substrings. `beginRun` is a prefix of
// `beginRunRecord`, so a substring exclusion would stop this fake firing the
// moment the clock reading moved inside the record opener, which is an ordinary
// refactor that leaves the case under test exactly as it is.
//
// What is asserted is that the SECOND start gets going. A routine still held
// would be turned away by the single-flight guard and would return false
// without throwing, which is the failure that looks like success.
//
// The message is asserted too, and that is the other half. A record handle that
// was never opened has nothing to close; closing it anyway raises a throw of its
// own from inside the catch, and the reason the start failed is replaced by the
// reason the cleanup failed.
test('a start that fails before its record is opened does not hold the routine', async () => {
  begin(14, [KEEPER]);
  const agent = { id: 'keeper', name: 'keeper' };
  const routine = { name: 'briefing', prompt: KEEPER_BODY };

  let thrown = false;
  const prev = scheduler.wireSchedulerDeps({
    now: () => {
      if (!thrown && calledFrom('executeRoutine') && !calledFrom('beginRun')) {
        thrown = true;
        throw new Error('clock unavailable');
      }
      return clock.at;
    },
  });
  try {
    const start = () => h.internal.executeRoutine(agent, routine, KEEPER);
    assert.throws(start, /clock unavailable/,
      'the start threw where the record is opened, and the reason that reached the caller is the start\'s own');
    // Proves the setup did what it claims before anything is concluded from it.
    assert.ok(thrown, 'the clock really did throw, so the record was never opened');
    assert.strictEqual(start(), true,
      'and the second start was allowed, so the first one released the routine on its way out');
  } finally {
    scheduler.wireSchedulerDeps(prev);
  }

  assert.ok(await settled(KEEPER), 'the run that did start finished');
});

// AC-22 IN THE COMBINATION IT NAMES, which nothing above exercises. The test
// beside this one forces the write to fail against a routine whose start
// SUCCEEDS, and the throwing routine is only ever driven against a writable
// store. The criterion is about neither on its own: it is about a record write
// failing on the path that runs INSIDE the catch that keeps the whole pass
// alive.
//
// That is the worst place for a swallowed failure to stop being swallowed. A
// throw raised there escapes exactly as the original one did, one routine ends
// the pass for every agent in the workspace, and it happens again sixty seconds
// later with nothing recorded and nothing shown. The write helper wraps both of
// its filesystem calls, so this holds by construction today; a criterion whose
// named combination is left to construction is the kind of claim this project
// has had wrong four times, every one a comment asserting what the code did not
// do.
//
// The routine that follows the thrower is the isolation half, and the empty
// store is what proves the write really was failing rather than the setup
// quietly not taking.
test('a start that throws while the record store is unwritable still fails safely', async (t) => {
  begin(20, [FAULTY, MISMATCH]);
  fs.mkdirSync(path.dirname(runsDir()), { recursive: true });
  fs.writeFileSync(runsDir(), 'not a directory');
  h.clearPrompts();

  try {
    const { errors } = driveTicks(t);

    // The store really could not be written, on this pass, for these runs.
    // Without this the whole test is satisfied by a writable store.
    assert.deepStrictEqual(records(), [], 'no record could be written at all');
    assert.ok(errors.some(e => e.includes('run record')),
      'and the write failure was reported rather than passing silently');

    // THE REASON IS THE START'S OWN. A throw escaping the record write would
    // replace it, and the routine state would explain a filesystem problem to
    // someone whose routine is malformed.
    const failed = h.internal.routineState[FAULTY];
    assert.strictEqual(failed.status, 'failed', 'the throwing start was recorded as a failed run');
    assert.match(failed.error, /null byte/i, 'carrying the reason its own start gave');
    assert.doesNotMatch(failed.error, /EEXIST|ENOTDIR|not a directory/i,
      'and not the reason the record store gave, which is a different problem entirely');
    assert.ok(errors.some(e => e.includes('faulty-check') && e.includes('failed to start')),
      'and the log names the routine that failed to start, beside the write failure');

    // The isolation half: a routine declared after the thrower, on the same
    // pass, with the write still failing under both of them.
    const after = h.internal.routineState[MISMATCH];
    assert.ok(after, 'the routine declared after the thrower was reached');
    assert.strictEqual(after.lastRun, dayAt(20, 5, 30).toISOString(), 'and started on that same pass');

    // And everything below the routine loop, which the original escape skipped.
    assert.strictEqual(h.internal.routineSlots.observedAt, dayAt(20, 5, 30).toISOString(),
      'the end-of-tick bookkeeping still ran, so the pass did not end at the thrower');

    assert.ok(await settled(MISMATCH), 'the run that did start finished');
    assert.ok(h.promptsFor('mismatched').includes(MISMATCH_BODY),
      'and it really did the work, rather than only being recorded as having started');
  } finally {
    fs.rmSync(runsDir(), { force: true });
  }
});

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

// AC-29. The scenario these records exist for is the one where the write and
// the read happen in different processes, so a reader that quietly disagrees
// with the writer about the shape would discard every record on every load
// with nothing red. This reads the file itself and holds the reader to it.
test('the reader returns what the writer wrote, from disk, keeping every field', async (t) => {
  begin(11, [KEEPER]);
  driveTicks(t);
  clock.at = dayAt(11, 5, 33);
  assert.ok(await settled(KEEPER), 'the run finished');

  const [rec] = records();
  const file = path.join(runsDir(), `${rec.id}.json`);
  assert.ok(fs.existsSync(file), 'the record is a file of its own, named for the run');
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.deepStrictEqual(rec, onDisk,
    'and the reader hands back exactly what is on disk, dropping no field the writer wrote');
  assert.deepStrictEqual(Object.keys(onDisk).sort(),
    ['agent', 'durationMs', 'endedAt', 'error', 'files', 'filesReason', 'filesStatus', 'id', 'routine', 'sessionId', 'startedAt', 'status'],
    'which is the whole record: identity, ownership, the session it ran under, both instants, the outcome, how long, any reason, and what it changed');
});

test('the reader keeps going past a file it cannot use', async (t) => {
  begin(12, [KEEPER]);
  driveTicks(t);
  assert.ok(await settled(KEEPER), 'the run finished');

  // A truncated write, and a file that parses to something that is not a
  // record. Both are reachable by hand-editing a directory the product invites
  // people to look in.
  fs.writeFileSync(path.join(runsDir(), 'half-written.json'), '{"id": "abc",');
  fs.writeFileSync(path.join(runsDir(), 'empty.json'), 'null');

  const recs = records();
  assert.strictEqual(recs.length, 1, 'the record that is a record is still returned');
  assert.strictEqual(recs[0].routine, 'briefing', 'and it is the real one');
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// AC-23, as behaviour rather than as prose. The run state and the slot records
// are dropped when the workspace changes because they describe the workspace
// being left. The in-flight set deliberately is not, because the child process
// of a run in flight is still running.
//
// A run's record follows the in-flight set: the run is what closes it, and the
// run outlives the switch. So the directory is fixed when the run starts. If
// it were resolved again at the end, the workspace that did the work would
// keep a record stuck at 'running' forever and the workspace the user happened
// to switch to would receive an ending for a run it never saw.
//
// Read through the filesystem rather than through the module's reader, because
// the reader answers for the workspace open NOW, which is the other one.
test('a run that outlives a workspace switch closes its record where it began', async (t) => {
  begin(13, [KEEPER]);
  const home = runsDir();
  const elsewhere = makeWorkspace({ agents: {}, claudeMd: '# Elsewhere\n' });

  driveTicks(t);
  // Synchronous with the pass: the child cannot have closed yet.
  h.internal.setWorkspace(elsewhere);
  clock.at = dayAt(13, 5, 40);

  try {
    assert.ok(await settled(KEEPER), 'the run finished, in a process now pointed somewhere else');

    const files = fs.readdirSync(home);
    assert.strictEqual(files.length, 1, 'the run left one record, where it started');
    const rec = JSON.parse(fs.readFileSync(path.join(home, files[0]), 'utf-8'));
    assert.strictEqual(rec.status, 'succeeded', 'closed rather than abandoned at running');
    assert.strictEqual(rec.endedAt, dayAt(13, 5, 40).toISOString(), 'with the instant it actually ended');
    assert.ok(!fs.existsSync(path.join(elsewhere, '.rundock', 'runs')),
      'and the workspace switched to received nothing: it never ran anything');
  } finally {
    h.internal.setWorkspace(h.workspaceDir);
  }
});
