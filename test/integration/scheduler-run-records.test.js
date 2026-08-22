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

const scheduler = require('../../lib/scheduler.js');

// Built rather than written, so the byte that makes the faulty fixture throw
// is visible in the source instead of being an invisible character in it.
const NUL = String.fromCharCode(0);

const KEEPER = 'keeper:briefing';
const TWINS = 'twins:check';
const FAULTY = 'faulty:faulty-check';
const RENAMED = 'keeper:briefing-renamed';
const ALL = [KEEPER, TWINS, FAULTY, RENAMED];

const KEEPER_BODY = 'keeper routine body';
const TWIN_EARLY = 'twin early body';
const TWIN_LATE = 'twin late body';

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
    },
  });
  keeperAgentFile = path.join(h.workspaceDir, '.claude', 'agents', 'keeper.md');
  h.writeScenario([
    // The delay holds the child open past the synchronous tick, which is what
    // lets a test move the clock between a run's start and its end and read
    // the record while it is still open.
    { match: { agent: 'keeper' }, delayMs: 200, turn: [{ text: 'keeper ran' }] },
    { match: { agent: 'twins' }, turn: [{ text: 'twin ran' }] },
  ]);
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

function settled(key) {
  return h.waitUntil(() => {
    const s = h.internal.routineState[key];
    return s && s.status !== 'running';
  });
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

// AC-6 and AC-22. The only failure that hands this file a reason today is a
// start that threw: a child's exit code carries no message, and reading what
// the child said is explicitly another card. So this is the test that a reason
// reaches the record at all.
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
  for (const status of records().map(r => r.status)) {
    assert.ok(['running', 'succeeded', 'failed'].includes(status), `"${status}" is outside the record vocabulary`);
  }
  // Not producible yet, and so never written: routines start the moment they
  // are found due, and the child handle is never kept, so nothing can reach a
  // run to cancel it.
  const written = new Set(records().map(r => r.status));
  assert.ok(!written.has('queued'), 'nothing queues a run, so no record claims it');
  assert.ok(!written.has('cancelled'), 'nothing can cancel a run, so no record claims it');

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
  assert.ok(await settled(KEEPER), 'the run finished');
  assert.strictEqual(records().length, 1, 'a record really was written on this pass');

  assert.deepStrictEqual(Object.keys(h.internal.routineState[KEEPER]).sort(), ['duration', 'lastRun', 'status'],
    'the routine state kept its shape: no run id, no record fields, nothing new');
  assert.strictEqual(h.internal.routineState[KEEPER].lastRun, dayAt(9, 5, 30).toISOString(),
    'and its stamp is the one the run wrote, not one a record moved');
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
// grows. beginRun is excluded because its readings are deeper in the same stack
// and are a different case, already pinned elsewhere.
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
      const stack = new Error().stack;
      if (!thrown && stack.includes('executeRoutine') && !stack.includes('beginRun')) {
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
    ['agent', 'durationMs', 'endedAt', 'error', 'id', 'routine', 'startedAt', 'status'],
    'which is the whole record: identity, ownership, both instants, the outcome, how long, and any reason');
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
