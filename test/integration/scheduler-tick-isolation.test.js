'use strict';
// One routine's failed start is one routine's failure.
//
// The tick called executeRoutine inside its routine loop with no try/catch,
// and executeRoutine rethrows a start that throws, having released its hold
// first, on the stated grounds that what the caller does about a failed start
// is not that function's business. Nothing was the caller's business either:
// the throw left the loop, left the interval callback and left the process,
// and there is no uncaughtException handler anywhere in the server. So one
// routine ended the whole pass, every routine declared after it went
// unconsidered, the end-of-tick bookkeeping never ran, and sixty seconds later
// the same thing happened again.
//
// THE THROW HERE IS REAL, which is why this sits at the integration level
// rather than against the unit suite's fake spawn. A prompt carrying a NUL
// byte reaches spawn as an argument Node refuses, and spawn throws
// ERR_INVALID_ARG_VALUE synchronously, through the whole production path with
// nothing stood in for. Measured against the unfixed tick: the tick threw out
// of t.mock.timers.tick(), the routine declared after it had no state at all,
// and routineSlots.observedAt was still null.
//
// WHAT THE CARD SAID THE ROUTE WAS, AND WHAT IT ACTUALLY IS. The card and its
// acceptance criteria both name a routine that declares a schedule and no prompt:
// the prompt normalises to null, reaches the spawn arguments, and spawn was
// said to throw synchronously on a non-string argument. It does not. Node
// coerces the argument, and the routine ran with the literal prompt "null"
// (measured on Node 24; the coercion is in the spawn binding rather than in
// the JavaScript validation, which checks strings for NUL bytes and lets
// everything else through). The defect the card is about is real and its
// consequence was exactly as described; that one route to it is not.
//
// So the `mute` fixture is read by two tests rather than one. The criterion,
// that a promptless routine never ends the pass, is asserted on its own and
// holds whichever way a Node jumps. What the routine does instead is a
// separate test, and it is the one that changed: the coercion was carded
// against the routine data model, the data model now refuses a routine with
// nothing to say, and that test asserts the spawn does not happen rather than
// characterising what it used to send. The evidence that the behaviour changed
// is the part worth keeping, which is why it was flipped rather than deleted.
//
// WHICH IS ALSO WHY `mute` IS NEVER WAITED ON. A refused routine starts no
// child and writes no run record, so there is nothing to settle: every test
// below asserts its ABSENCE from the run state instead, which is the same fact
// the old wait was standing in for.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const h = require('../helpers/harness.js');
const { agentFile } = require('../helpers/workspace.js');
const { calledFrom } = require('../helpers/stack.js');

const scheduler = require('../../lib/scheduler.js');

// Built rather than written, so the byte that makes this fixture work is
// visible in the source instead of being an invisible character in it.
const NUL = String.fromCharCode(0);

const MUTE = 'mute:mute-check';
const FAULTY = 'faulty:faulty-check';
const STEADY = 'steady:steady-check';
const ALL = [MUTE, FAULTY, STEADY];

// July 2026, local time, so the fixture is timezone-independent. Each test
// owns its own day: a run stamped on a shared day would suppress another
// test's routine through the ordinary schedule rule.
function dayAt(day, hour, minute) { return new Date(2026, 6, day, hour, minute, 0); }

const clock = { at: dayAt(1, 9, 30) };
let prevDeps = null;

before(async () => {
  await h.boot({
    agents: {
      // Declared FIRST, and due at the same time as the others, so every pass
      // in this file meets the malformed routine before it meets anything
      // else. Whatever a routine with no prompt does, it does it ahead of the
      // two routines whose state the tests read.
      mute: agentFile({
        name: 'mute', type: 'specialist', order: 1,
        routines: [{ name: 'mute-check', schedule: 'every day at 09:00', enabled: true }],
      }),
      // The thrower. Its prompt reaches spawn as an argument Node refuses.
      faulty: agentFile({
        name: 'faulty', type: 'specialist', order: 2,
        routines: [{ name: 'faulty-check', schedule: 'every day at 09:00', prompt: `bad${NUL}body`, enabled: true }],
      }),
      // The control, declared LAST so it is only ever reached by a pass that
      // survived both of the routines above it.
      steady: agentFile({
        name: 'steady', type: 'specialist', order: 3,
        routines: [{ name: 'steady-check', schedule: 'every day at 09:00', prompt: 'steady body', enabled: true }],
      }),
    },
  });
  h.writeScenario([
    { match: { agent: 'steady', promptIncludes: 'steady body' }, turn: [{ text: 'control ran' }] },
  ]);
  prevDeps = scheduler.wireSchedulerDeps({ now: () => clock.at });
});

after(async () => {
  if (prevDeps) scheduler.wireSchedulerDeps(prevDeps);
  await h.shutdown();
});

// Ticks of the real scheduler with the console captured. The server armed a
// tick at boot and a second start is a no-op, so the real one is stopped
// before the mocked one this drives is armed.
//
// The tick is driven INSIDE the capture and not wrapped in a try, so a pass
// that ends by throwing fails its test where it happened rather than being
// swallowed here and reported as a missing record somewhere else.
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

// A tick sees every routine in the workspace, so a test that says nothing
// about the others still fires them. A run recorded late on the test's own day
// suppresses them through the ordinary schedule rule.
function quieten(day, live) {
  for (const key of ALL) {
    if (live.includes(key)) continue;
    h.internal.routineState[key] = { lastRun: dayAt(day, 23, 0).toISOString(), status: 'completed', duration: 1 };
  }
}

function begin(day, live) {
  clock.at = dayAt(day, 9, 30);
  for (const key of live) delete h.internal.routineState[key];
  quieten(day, live);
}

// The signals file the run-outcome path appends to, read the way the signal
// suite reads it. Keyed by the real month, because recordEvent stamps its own
// clock rather than the scheduler's.
function readEvents() {
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const file = path.join(h.workspaceDir, '.rundock', 'state', `events-${month}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function routineEvents(name) {
  return readEvents().filter(e => e.e === 'routine_run' && e.d && e.d.routine === name);
}

function settled(key) {
  return h.waitUntil(() => {
    const s = h.internal.routineState[key];
    return s && s.status !== 'running';
  });
}

test('a routine whose start throws leaves the routines after it to run', async (t) => {
  begin(1, ALL);

  const { errors } = driveTicks(t);

  // The failure half. Without it "the others ran" is satisfied by a pass in
  // which nothing threw at all.
  const failed = h.internal.routineState[FAULTY];
  assert.strictEqual(failed.status, 'failed', 'the routine whose start threw is recorded as failed');
  assert.match(failed.error, /null byte/i, 'and the record carries the reason the failure gave');
  assert.strictEqual(failed.lastRun, dayAt(1, 9, 30).toISOString(),
    'stamped at the instant its start was attempted, which is the stamp its own start wrote');
  assert.ok(errors.some(e => e.includes('faulty-check') && /null byte/i.test(e)),
    'and the log names the routine and why, at the moment it happened');

  // The isolation itself: a routine declared AFTER the thrower, started on the
  // same pass.
  const control = h.internal.routineState[STEADY];
  assert.ok(control, 'the routine after the thrower was started on the same pass');
  assert.strictEqual(control.lastRun, dayAt(1, 9, 30).toISOString(), 'on that pass and not a later one');

  assert.ok(await settled(STEADY), 'the control run finished');
  assert.strictEqual(h.internal.routineState[MUTE], undefined,
    'the promptless routine was refused, so it started nothing and recorded nothing');
});

test('the end-of-tick bookkeeping survives a start that throws', async (t) => {
  begin(2, ALL);

  driveTicks(t);

  assert.strictEqual(h.internal.routineState[FAULTY].status, 'failed', 'this pass met the throwing start');
  // Everything after the routine loop: the observation stamp and its write.
  // The escape used to skip both, which is what made the next wake report as
  // unserved the very slots the scheduler had been awake for.
  assert.strictEqual(h.internal.routineSlots.observedAt, dayAt(2, 9, 30).toISOString(),
    'the pass still recorded that the scheduler was awake and looking');
  const file = path.join(h.workspaceDir, '.rundock', 'routine-slots.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.strictEqual(saved.observedAt, dayAt(2, 9, 30).toISOString(),
    'and wrote it, which is the half that protects the next process');

  assert.ok(await settled(STEADY), 'the control run finished');
  assert.strictEqual(h.internal.routineState[MUTE], undefined,
    'the promptless routine was refused, so it started nothing and recorded nothing');
});

test('a start that throws is attempted once in its period, not once a minute', async (t) => {
  begin(3, ALL);

  const { errors } = driveTicks(t, 3);

  // THE DECISION THIS PINS. A failed start keeps the lastRun its own start
  // stamped, so the ordinary double-fire suppression holds it for the rest of
  // its period exactly as a successful run would. A start that throws on the
  // routine's own contents throws again sixty seconds later, and a
  // minute-by-minute retry of a permanently malformed routine is a louder
  // failure than the silent one this card exists to end, not a quieter one.
  const announced = errors.filter(e => e.includes('faulty-check') && e.includes('failed to start'));
  assert.strictEqual(announced.length, 1, 'three passes, one attempt: the failure did not retry every tick');
  assert.strictEqual(h.internal.routineState[FAULTY].lastRun, dayAt(3, 9, 30).toISOString(),
    'and the record still belongs to the attempt that was made');

  assert.ok(await settled(STEADY), 'the control run finished');
  assert.strictEqual(h.internal.routineState[MUTE], undefined,
    'the promptless routine was refused, so it started nothing and recorded nothing');
});

test('the routine that threw is released, so the next period reaches it again', async (t) => {
  begin(4, ALL);
  driveTicks(t);
  assert.strictEqual(h.internal.routineState[FAULTY].status, 'failed', 'the first period met the throwing start');
  assert.ok(await settled(STEADY), 'the first control run finished');
  assert.strictEqual(h.internal.routineState[MUTE], undefined,
    'the promptless routine was refused, so it started nothing and recorded nothing');

  // A hold that outlived the throw would turn executeRoutine's refusal into
  // the answer instead, and the routine would never be attempted again for
  // the life of the process. What is asserted is the attempt, not the absence.
  clock.at = dayAt(5, 9, 30);
  const { logs } = driveTicks(t);

  assert.strictEqual(h.internal.routineState[FAULTY].lastRun, dayAt(5, 9, 30).toISOString(),
    'the next period attempted the routine again, so nothing was still holding it');
  assert.ok(!logs.some(l => l.includes('faulty-check') && l.includes('previous run has not finished')),
    'and it was attempted rather than refused as still in flight');
  assert.strictEqual(h.internal.routineState[STEADY].lastRun, dayAt(5, 9, 30).toISOString(),
    'and the pass after the failure was an ordinary one');

  assert.ok(await settled(STEADY), 'the second control run finished');
  assert.strictEqual(h.internal.routineState[MUTE], undefined,
    'the promptless routine was refused, so it started nothing and recorded nothing');
});

test('a routine that declares a schedule and no prompt does not end the pass', async (t) => {
  // The thrower is quietened, so the only routine that could end this pass is
  // the malformed one, and it is declared before the control.
  begin(6, [MUTE, STEADY]);

  driveTicks(t);

  // Deliberately says nothing about WHICH disposition the malformed routine
  // gets, so the criterion does not rest on the refusal below staying the
  // answer. What it asserts is that the pass carried ON past it, in the two
  // places a pass that ended there would show it: the routine declared AFTER
  // the malformed one ran on this very pass, and the bookkeeping below the
  // routine loop happened. If a Node ever restores the throw the card assumed,
  // the routine is recorded as a failed start instead and this test is still
  // the one that holds.
  assert.strictEqual(h.internal.routineState[STEADY].lastRun, dayAt(6, 9, 30).toISOString(),
    'the routine declared after the malformed one ran on the same pass');
  assert.strictEqual(h.internal.routineSlots.observedAt, dayAt(6, 9, 30).toISOString(),
    'and the pass reached its own end, rather than leaving at the malformed routine');

  assert.ok(await settled(STEADY), 'the control run finished');
  assert.strictEqual(h.internal.routineState[MUTE], undefined,
    'the promptless routine was refused, so it started nothing and recorded nothing');
});

// THE DEFECT THIS FILE CHARACTERISED, NOW ASSERTED AS GONE. A routine that
// declares a schedule and no prompt used to reach the spawn: the null was
// pushed into the argument list, Node coerced it, and the agent was started on
// the four characters "null". Nothing about it looked unhealthy from any
// angle. The routine got a run record, a duration and a completed status, the
// panel showed it running and then done, and the only thing wrong was what the
// agent had been asked to do.
//
// The test that recorded that is this one, flipped rather than deleted: the
// data model now answers whether a routine has anything to say, the tick's
// refusal gate reads that answer, and the spawn never happens. What is
// asserted is the ARGUMENT LIST of a real child, because that is where the
// coercion lived; a test that only read the run state would go green again for
// a refusal that still spawned.
test('a promptless routine is refused rather than spawned, so no agent is handed the word null', async (t) => {
  begin(7, [MUTE, STEADY]);
  h.clearInvocations();

  driveTicks(t);

  // The invocation log is written by the child, so a spawn that did happen
  // lands after the tick. The control is waited on first for exactly that
  // reason: the log is read once a child of this pass has finished writing to
  // it, so an empty log is a spawn that never happened rather than one that
  // has not got there yet.
  assert.ok(await settled(STEADY), 'the control run finished');

  const muteSpawns = h.readInvocations().filter(i => {
    const argv = i.argv || [];
    return argv.includes('--agent') && argv[argv.indexOf('--agent') + 1] === 'mute';
  });
  assert.deepStrictEqual(muteSpawns.map(i => (i.argv || []).slice(-1)[0]), [],
    'the promptless routine reached a child, and the last argument is what it was asked to do');
  assert.strictEqual(h.internal.routineState[MUTE], undefined,
    'and it recorded no run, so nothing on the list claims it did anything');
  // WHAT IS NOT ASSERTED HERE, and why. The refusal's log line is announced
  // once per routine for the life of the process, and the first test in this
  // file already spent this routine's. The line itself is pinned in
  // test/integration/scheduler-gating.test.js, beside the three refusals it
  // shares its wording with.
});


// The trace has to outlive the process it was written in: the failure is a
// malformed routine, and the thing a maintainer does about one is open the app
// again. A record whose reason is dropped on load would leave that restart
// looking exactly like the silence this card removed, with all twenty-six
// existing state tests still green, because nothing else writes this field.
//
// Last in the file: loadRoutineState is the workspace-switch path and clears
// the slot records beside the run state, so it runs after every test that
// reads them.
test('a failed start survives the restart it will be read after', async (t) => {
  begin(8, ALL);
  driveTicks(t);
  assert.ok(await settled(STEADY), 'the control run finished');
  assert.strictEqual(h.internal.routineState[MUTE], undefined,
    'the promptless routine was refused, so it started nothing and recorded nothing');

  const file = path.join(h.workspaceDir, '.rundock', 'routine-state.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.strictEqual(saved[FAULTY].status, 'failed', 'the failure reached the file');
  assert.match(saved[FAULTY].error, /null byte/i, 'with its reason, which is the part only this path writes');

  // This reload also clears the slot records, and four tests follow it. They
  // are safe for a reason worth stating rather than leaving to be rediscovered:
  // each drives its own tick, which re-stamps the observation before anything
  // reads it. The safety is in what those tests do, not in where this one sits,
  // so moving either does not break the other.
  h.internal.loadRoutineState();
  const restored = h.internal.routineState[FAULTY];
  assert.strictEqual(restored.status, 'failed', 'and the read back agrees with the write');
  assert.match(restored.error, /null byte/i, 'reason included, rather than dropped by a reader that never expected it');
});

// THE TWO THINGS THE FAILURE PATH MUST NOT DO. Both were stated in a comment
// at recordFailedStart and enforced by nothing, which is a comment rather than
// a requirement. Measured before these tests existed: adding both calls left
// every test in this file green, and every test in the signals and scheduler
// suites green with them.
//
// The broadcast is the serious half. broadcastRoutineUpdate reaches a
// dependency that throws when it is unwired, and this path runs INSIDE the
// catch that keeps the pass alive, so a throw raised here escapes exactly as
// the original one did and silently re-opens the defect this card closes. It
// is a regression guard rather than a live defect, because today's boot always
// wires it, and that is precisely why nothing would catch it.
test('a failed start tells the clients nothing', async (t) => {
  // The thrower alone, so the count is the whole pass and is decided inside
  // one synchronous tick rather than by whenever a child happens to end.
  begin(9, [FAULTY]);

  let broadcasts = 0;
  const prev = scheduler.wireSchedulerDeps({ getWssClients: () => { broadcasts++; return []; } });
  try {
    driveTicks(t);
  } finally {
    scheduler.wireSchedulerDeps(prev);
  }

  assert.strictEqual(h.internal.routineState[FAULTY].status, 'failed', 'this pass met the throwing start');
  assert.strictEqual(broadcasts, 1,
    'one broadcast, the one the start itself makes before spawning; the failure adds none');
});

// The other half, and it matters on its own. A failed start emitted as a run
// event is indistinguishable in the events file from a real fast failure: the
// status is the same word and a duration of zero is legal for both. The file
// is what any later measurement of how often routines fail would be counted
// from, so a start that never became a subprocess must not be in it.
test('a failed start is not counted among the runs', async (t) => {
  begin(10, [FAULTY, STEADY]);

  driveTicks(t);

  // The control, in the same file on the same pass: the outcome path DOES
  // record a run event, so the absence below is this path's silence rather
  // than a signals layer that was never going to write anything.
  assert.ok(await settled(STEADY), 'the control run finished');
  assert.ok(await h.waitUntil(() => routineEvents('steady-check').length > 0),
    'a run that really ran is in the events file');
  assert.strictEqual(routineEvents('faulty-check').length, 0,
    'and a start that never became a subprocess is not, whatever it would have looked like there');

  // The promptless routine is quietened on this day rather than refused, so
  // its record is the one `quieten` seeded. Nothing here waits on it: a
  // refusal starts no child, so there has never been anything to settle.
  assert.strictEqual(routineEvents('mute-check').length, 0,
    'and neither is a routine that was never started at all');
});

// The requirement above, stated as the consequence rather than as the rule: a
// start can throw somewhere other than the spawn, and when it does the catch
// still has to hold. This drives the very dependency the failure path is
// forbidden to touch, so a broadcast added there throws while handling a throw
// and leaves the pass exactly as broken as it was before this card.
test('a start that throws away from the spawn is isolated too', async (t) => {
  begin(11, [FAULTY, STEADY]);

  const prev = scheduler.wireSchedulerDeps({
    getWssClients: () => { throw new Error('wss clients not available'); },
  });
  try {
    driveTicks(t);
  } finally {
    scheduler.wireSchedulerDeps(prev);
  }

  const failed = h.internal.routineState[FAULTY];
  assert.strictEqual(failed.status, 'failed', 'the routine whose start threw at the broadcast is recorded');
  assert.match(failed.error, /wss clients not available/, 'with the reason that throw gave, not the spawn\'s');
  // THE INVARIANT, asserted where a start throws at something OTHER than the
  // spawn, which is the shape of the edit that would break it. A failed record
  // always carries lastRun: without it getNextRun reads the routine as still
  // due and the once-per-period decision above becomes a once-per-minute
  // retry, while loadRoutineState drops the record on restart because the
  // field is not a string. Today the record is inherited from the start, and
  // the guard is what makes that inheritance optional rather than required.
  assert.strictEqual(failed.lastRun, dayAt(11, 9, 30).toISOString(),
    'and it is stamped, whether or not the start got far enough to stamp it itself');
  assert.strictEqual(h.internal.routineState[STEADY].status, 'failed',
    'and the routine after it was still reached, rather than the pass ending at the first one');
  assert.strictEqual(h.internal.routineSlots.observedAt, dayAt(11, 9, 30).toISOString(),
    'and the bookkeeping below the loop still ran');
});

// The other half of the stamp decision, and until this test it was prose. The
// failure path CARRIES the instant the start wrote rather than taking the
// tick's, and under a frozen clock those two are the same value, so nothing
// could tell them apart.
//
// The clock here advances a second on every read, which is what a clock does.
// The tick reads it once at the top and beginRun reads it twice more on its
// way to the record, so an inherited stamp is strictly later than the tick's
// instant and a restamped one is exactly equal to it. That is the whole
// distinction, asserted without counting reads.
test('a failed start is held for THIS period even when it inherits an older stamp', async (t) => {
  // The case the fallback does not cover. beginRun stamps a running record as
  // its first act, so ordinarily the failure path inherits a stamp from this
  // period. If beginRun throws BEFORE that write, what it inherits is whatever
  // the last run left, which can be days old, and a stale stamp does not
  // suppress: the routine reads as due again on the very next tick and retries
  // every sixty seconds, which is the outcome the once-per-period decision and
  // the documentation both rule out.
  //
  // Substituting only when the stamp is ABSENT does not reach this. The stamp
  // is present; it is just from the wrong period. Hence a floor rather than a
  // fallback.
  begin(13, [FAULTY]);
  h.internal.routineState[FAULTY] = {
    lastRun: dayAt(12, 9, 5).toISOString(), status: 'completed', duration: 1,
  };

  const base = dayAt(13, 9, 30);
  // A single-shot throw on the start's OWN first reading of the clock, so the
  // start dies ahead of its own stamp while the tick's earlier reading still
  // reaches the failure path.
  //
  // It matches a FRAME rather than a substring of the stack, and that is not
  // cosmetic. `beginRun` is a prefix of `beginRunRecord`, which arrived with
  // the run-records change; a substring test would have selected whichever of
  // the two appeared first and said nothing about it. When this was written no
  // such pair existed, which is exactly why the guard belongs here rather than
  // in the memory of whoever adds the next function.
  //
  // It selects on the call site rather than on a count. Counting was tried and
  // was wrong twice: the tick reads once, then once per routine to ask whether
  // each is due, and that total moves whenever the fixture or the iteration
  // order changes. A test whose setup has to be re-derived every time the
  // fixture grows is a test that will one day be quietly aimed at the wrong
  // reading and still pass.
  //
  // Single-shot on purpose: throwing on every later reading would kill the
  // due-check of the routine after this one, which nothing here catches, and
  // the pass would die for a reason unrelated to what this test is about.
  let thrown = false;
  const prev = scheduler.wireSchedulerDeps({
    now: () => {
      if (!thrown && calledFrom('beginRun')) {
        thrown = true;
        throw new Error('clock unavailable');
      }
      return base;
    },
  });
  let errors;
  try {
    ({ errors } = driveTicks(t, 3));
  } finally {
    scheduler.wireSchedulerDeps(prev);
  }

  // Proves the setup did what it claims BEFORE anything is concluded from it.
  // Without this the test passes for the ordinary reason: this routine's spawn
  // throws anyway, after the start has written its own stamp, so the record is
  // already of this period and the floor is never exercised.
  assert.ok(thrown, 'the clock threw inside the start, so the record it inherited is the stale one');
  assert.strictEqual(h.internal.routineState[FAULTY].status, 'failed',
    'the pass met a start that threw before it could stamp');

  // The retry is what the stale stamp causes, so the retry is what to count.
  // Asserting the FINAL stamp would prove nothing: a later pass writes one of
  // this period on its way through, so the record looks correct afterwards
  // whether or not the first failure was ever held. The damage is the extra
  // attempt, and it is only visible while it is happening.
  const announced = errors.filter(e => e.includes('faulty-check') && e.includes('failed to start'));
  assert.strictEqual(announced.length, 1,
    'three passes, one attempt: a stamp from an earlier period did not let it retry every tick');
});

test('a failed start keeps the stamp its own start wrote', async (t) => {
  begin(12, [FAULTY]);

  const base = dayAt(12, 9, 30);
  let reads = 0;
  const prev = scheduler.wireSchedulerDeps({ now: () => new Date(base.getTime() + (reads++ * 1000)) });
  try {
    driveTicks(t);
  } finally {
    scheduler.wireSchedulerDeps(prev);
  }

  const failed = h.internal.routineState[FAULTY];
  assert.strictEqual(failed.status, 'failed', 'this pass met the throwing start');
  assert.ok(new Date(failed.lastRun) > base,
    'the record carries the instant its own start stamped, not the one the tick was judged at');
});
