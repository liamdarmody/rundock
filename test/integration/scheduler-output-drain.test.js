'use strict';
// A routine that says a lot still finishes.
//
// The routine spawn used to ask for both output pipes and attach a reader to
// neither. Node's stdio streams start paused, so the kernel buffer filled and
// the child blocked on its next write. Measured on a throwaway parent and
// child: 128 KB of output completes in 26 ms, 160 KB never closes at all.
//
// A child that never ends never closes, and every mechanism downstream of the
// close event is correct on its own: no close means no outcome recorded, no
// outcome means the single-flight hold is never released, and a held routine
// is refused on every later tick. The routine stopped running for the life of
// the process, and its record sat open, reading as interrupted after a
// restart: the product reporting a run that was cut short when what happened
// is that it stopped listening.
//
// 160 KB is not exotic. Verbose stream output opens by enumerating every
// available tool, server and command before it carries a word of the model's
// answer.
//
// WHAT THIS FILE HAS TO BE CAREFUL OF. A test that believes it produced 200 KB
// and produced 2 KB passes for the wrong reason and proves nothing: the run it
// drove was never the run the hazard needs. So the volume is READ BACK from
// the child rather than inferred from the fixture, and the small control run
// beside it is asserted to be small, so the figure cannot be a constant the
// stub writes for every run.
//
// The clock is the scheduler's own seam, so both days below are chosen rather
// than waited for, and the tick driven is the mocked interval.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const h = require('../helpers/harness.js');
const { agentFile } = require('../helpers/workspace.js');

const scheduler = require('../../lib/scheduler.js');

const LOUD = 'loud:verbose';
const QUIET = 'quiet:brief';
const ALL = [LOUD, QUIET];

const LOUD_BODY = 'loud body';
const QUIET_BODY = 'quiet body';

// The payload the loud routine's child prints. Every envelope the stub emits
// carries it (two text deltas, the consolidated assistant message, the result),
// so what reaches stdout is several times this, and the assertions below read
// the real figure rather than this one.
const PAYLOAD = 'v'.repeat(200 * 1024);

// The two measurements the hazard was characterised by, kept as named
// constants because every assertion about volume is really about them.
const COMPLETED = 128 * 1024; // completed in 26 ms
const HUNG = 160 * 1024;      // never closed

// October 2026, local components, so the fixture is timezone-independent.
function dayAt(day, hour, minute) { return new Date(2026, 9, day, hour, minute, 0); }

const clock = { at: dayAt(1, 5, 30) };
let prevDeps = null;

before(async () => {
  await h.boot({
    agents: {
      // The routine under test: one that talks past the pipe buffer.
      loud: agentFile({
        name: 'loud', type: 'specialist', order: 1,
        routines: [{ name: 'verbose', schedule: 'every day at 05:00', prompt: LOUD_BODY }],
      }),
      // The control, and it earns its place twice. It fires on the same ticks,
      // so a tick that started nothing is told apart from one that started the
      // loud routine and lost it; and its output is small, so the byte count
      // below is proved to follow the run rather than being a number the stub
      // prints for everybody.
      quiet: agentFile({
        name: 'quiet', type: 'specialist', order: 2,
        routines: [{ name: 'brief', schedule: 'every day at 05:00', prompt: QUIET_BODY }],
      }),
    },
  });
  h.writeScenario([
    { match: { agent: 'loud', promptIncludes: LOUD_BODY }, turn: [{ text: PAYLOAD }] },
    { match: { agent: 'quiet', promptIncludes: QUIET_BODY }, turn: [{ text: 'brief' }] },
  ]);
  prevDeps = scheduler.wireSchedulerDeps({ now: () => clock.at });
});

// The hazard's own symptom, kept out of the test runner. A child blocked on a
// full pipe never exits, and a parent holding the other end of that pipe has
// an open handle for as long as it lives, so a run that hangs would hang this
// file instead of failing it: 8 seconds of assertion followed by a process
// that never returns. Every spawn this file made is signalled on the way out,
// and a run that ended long ago is simply not there to signal.
after(async () => {
  for (const inv of spawns(LOUD_BODY).concat(spawns(QUIET_BODY))) {
    try { process.kill(inv.pid, 'SIGKILL'); } catch (e) { /* already gone */ }
  }
  if (prevDeps) scheduler.wireSchedulerDeps(prevDeps);
  await h.shutdown();
});

// One tick of the real scheduler with the console captured. The server armed a
// tick at boot and a second start is a no-op, so the real one is stopped before
// the mocked one this drives is armed.
function driveTick(t) {
  const logs = [];
  const realLog = console.log;
  h.internal.stopScheduler();
  t.mock.timers.enable({ apis: ['setInterval'] });
  console.log = (...args) => logs.push(args.join(' '));
  try {
    h.internal.startScheduler();
    t.mock.timers.tick(60_000);
  } finally {
    console.log = realLog;
    h.internal.stopScheduler();
    t.mock.timers.reset();
  }
  return logs;
}

// A tick sees every routine in the workspace, so a day the test says nothing
// about still runs them. Nothing here needs quietening on the days it drives,
// because both routines are live on both of them; this exists so the state is
// as chosen on day one as it is on day two.
function makeDue(day, live) {
  clock.at = dayAt(day, 5, 30);
  for (const key of live) delete h.internal.routineState[key];
  for (const key of ALL) {
    if (live.includes(key)) continue;
    h.internal.routineState[key] = { lastRun: dayAt(day, 23, 0).toISOString(), status: 'completed', duration: 1 };
  }
}

function settled(key) {
  return h.waitUntil(() => {
    const s = h.internal.routineState[key];
    return s && s.status !== 'running';
  });
}

// Every spawn carrying this prompt. The routine spawn passes the prompt as the
// last positional argument and the stub logs its whole argv.
function spawns(prompt) {
  return h.readInvocations().filter(i => (i.argv || []).includes(prompt));
}

function outputsFor(agent) {
  return h.readStubOutputs().filter(o => o.agent === agent);
}

function recordsFor(agent) {
  return scheduler.readRunRecords().filter(r => r.agent === agent);
}

// AC-1 to AC-4 in one test, because they are one failure. The hazard does not
// produce a run that completes without recording, or a recorded run that keeps
// its hold: it produces a child that never ends, and everything after that is
// consequence. Four tests asserting a part each would each pass on a run that
// never reached the volume.
//
// AC-13 and AC-15 are the same test read as evidence: real volume through the
// real spawn path, and the second day proving the hold was released rather
// than assuming it from the first.
test('a routine whose output floods the pipe completes, records its outcome, and runs again the next day', async (t) => {
  makeDue(1, [LOUD, QUIET]);

  const logs = driveTick(t);
  assert.ok(logs.some(l => l.includes('Running routine') && l.includes('verbose')),
    'the tick started the loud routine');

  assert.ok(await settled(LOUD), 'the run ended rather than hanging on a full pipe');
  assert.ok(await settled(QUIET), 'and so did the control beside it');

  // THE SETUP, ASSERTED BEFORE ANYTHING IS CONCLUDED FROM IT. A run that
  // completed having printed 2 KB says nothing about a pipe buffer, and it is
  // what this test would silently become if the scenario stopped matching or
  // the payload stopped arriving.
  const loudOut = outputsFor('loud');
  assert.strictEqual(loudOut.length, 1, 'the loud child finished writing exactly once');
  assert.ok(loudOut[0].stdoutBytes > HUNG,
    `the child really emitted more than the ${HUNG} bytes measured never to close, `
    + `it emitted ${loudOut[0].stdoutBytes}`);

  // And the figure follows the run rather than being a constant: the control
  // printed a few hundred bytes through the identical path.
  const quietOut = outputsFor('quiet');
  assert.strictEqual(quietOut.length, 1, 'the control child finished writing once too');
  assert.ok(quietOut[0].stdoutBytes < COMPLETED,
    `the control stayed under the ${COMPLETED} bytes that always completed, `
    + `at ${quietOut[0].stdoutBytes}, so the count above is this run's own`);

  // AC-1 and AC-2: it finished, and the outcome reached both stores in their
  // own vocabularies.
  assert.strictEqual(h.internal.routineState[LOUD].status, 'completed',
    'the routine state recorded a completed run');
  assert.strictEqual(h.internal.routineState[LOUD].lastRun, dayAt(1, 5, 30).toISOString(),
    'stamped with the day it ran');
  const firstDay = recordsFor('loud');
  assert.strictEqual(firstDay.length, 1, 'the run left one record');
  assert.strictEqual(firstDay[0].status, 'succeeded', 'closed as succeeded rather than left open');
  assert.strictEqual(firstDay[0].endedAt, dayAt(1, 5, 30).toISOString(),
    'and it has an ending at all, which is the thing a child that never closes never gets');

  // AC-3 and AC-4. The hold lives until an outcome is recorded, so the only
  // way to see it released is to ask for another run. A second spawn a day
  // later is that question answered by the product rather than by reading the
  // set: a held routine is refused by the guard and spawns nothing.
  makeDue(2, [LOUD, QUIET]);
  const secondLogs = driveTick(t);
  assert.ok(!secondLogs.some(l => l.includes('Not starting routine') && l.includes('verbose')),
    'the guard did not refuse it, so nothing was still holding it');
  assert.ok(await h.waitUntil(() => spawns(LOUD_BODY).length >= 2),
    'it ran again at its next slot');
  assert.ok(await settled(LOUD), 'and that run ended too');
  assert.strictEqual(h.internal.routineState[LOUD].lastRun, dayAt(2, 5, 30).toISOString(),
    'with the second day stamped over the first');

  const bothDays = recordsFor('loud');
  assert.strictEqual(bothDays.length, 2, 'two runs left two records');
  assert.deepStrictEqual(bothDays.map(r => r.status).sort(), ['succeeded', 'succeeded'],
    'both of them closed');
  assert.strictEqual(outputsFor('loud').length, 2, 'and both children printed their piece');
});
