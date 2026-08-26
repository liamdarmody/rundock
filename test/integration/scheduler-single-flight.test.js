'use strict';
// One run of a routine at a time.
//
// The executor used to spawn and return, holding neither the child, the
// promise, nor a flag. The only thing resembling a guard was the run's start
// time being stamped before the spawn, which the next-run calculation then
// suppressed on a same-day comparison. That is a rule about schedules, and it
// fails at exactly the case it looks like it covers: a run that outlives its
// window fires again at the next window, because its stored start time is
// stale rather than open.
//
// Every test here drives the real tick through the wired clock, so a run can
// be watched outliving its window with no real time passing. The run that
// outlives it is a real child process, hung on a scenario delay, and it is
// ended by killing it rather than by waiting for it.
//
// The held tests assert on the STORED STATE as well as on the absence of a
// second spawn. "Nothing spawned" is an absence, and an absence is satisfied
// by a tick that was never going to run anything; a routine firing beside the
// held one on the same tick is what makes the absence mean the guard.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const h = require('../helpers/harness.js');
const { agentFile } = require('../helpers/workspace.js');

const scheduler = require('../../lib/scheduler.js');

const SLOW = 'slow:slow-check';
const OTHER = 'other:other-check';
const TWIN = 'twin:twin-check';
const BRISK = 'brisk:brisk-check';
const FALL = 'faller:fall-check';
const ALL = [SLOW, OTHER, TWIN, BRISK, FALL];

// July 2026, local time, so the fixture is timezone-independent. Each test
// owns its own days: the run under test has to survive from one day to the
// next, and a shared day would mean one test's stamp suppressing another's.
function dayAt(day, hour, minute) { return new Date(2026, 6, day, hour, minute, 0); }

const clock = { at: dayAt(1, 9, 30) };
let prevDeps = null;

before(async () => {
  await h.boot({
    agents: {
      // Hangs on a scenario delay until the test kills it, which is what a run
      // outliving its window looks like from the scheduler's side.
      slow: agentFile({
        name: 'slow', type: 'specialist', order: 1,
        routines: [{ name: 'slow-check', schedule: 'every day at 09:00', prompt: 'slow body', enabled: true }],
      }),
      // The control. It fires on the same tick that holds the slow routine,
      // which is both the proof the tick was live and the proof that one
      // routine being in flight does not hold a different one.
      other: agentFile({
        name: 'other', type: 'specialist', order: 2,
        routines: [{ name: 'other-check', schedule: 'every day at 09:00', prompt: 'other body', enabled: true }],
      }),
      // Two routines, one agent, one name. The data model allows it on
      // purpose and the writer indexes namesakes by occurrence. They share one
      // state slot, and therefore one identity, and single-flight holds them
      // together for that reason. The second is due an hour earlier so it can
      // be due on a day the first is not, which is the only way its hold is
      // visibly the FIRST routine's run rather than its own.
      twin: agentFile({
        name: 'twin', type: 'specialist', order: 3,
        routines: [
          { name: 'twin-check', schedule: 'every day at 09:00', prompt: 'first twin body', enabled: true },
          { name: 'twin-check', schedule: 'every day at 07:00', prompt: 'second twin body', enabled: true },
        ],
      }),
      // Runs to completion in milliseconds, so its release is the success
      // path rather than the failure one.
      brisk: agentFile({
        name: 'brisk', type: 'specialist', order: 4,
        routines: [{ name: 'brisk-check', schedule: 'every day at 06:00', prompt: 'brisk body', enabled: true }],
      }),
      // Hangs like the slow routine, and belongs to the failure test alone, so
      // that test starts the run it later kills rather than inheriting one.
      faller: agentFile({
        name: 'faller', type: 'specialist', order: 5,
        routines: [{ name: 'fall-check', schedule: 'every day at 09:00', prompt: 'fall body', enabled: true }],
      }),
    },
  });
  h.writeScenario([
    { match: { agent: 'slow', promptIncludes: 'slow body' }, delayMs: 600000, turn: [{ text: 'never arrives' }] },
    { match: { agent: 'other', promptIncludes: 'other body' }, turn: [{ text: 'control ran' }] },
    { match: { agent: 'twin', promptIncludes: 'first twin body' }, delayMs: 600000, turn: [{ text: 'never arrives' }] },
    { match: { agent: 'twin', promptIncludes: 'second twin body' }, turn: [{ text: 'the twin should never run' }] },
    { match: { agent: 'brisk', promptIncludes: 'brisk body' }, turn: [{ text: 'brisk ran' }] },
    { match: { agent: 'faller', promptIncludes: 'fall body' }, delayMs: 600000, turn: [{ text: 'never arrives' }] },
  ]);
  prevDeps = scheduler.wireSchedulerDeps({ now: () => clock.at });
});

// The two prompts whose scenario rules hang. Every other run in this file
// exits in milliseconds, and signalling a pid that exited long ago is how a
// recycled pid gets signalled instead. Each of these is killed by the test
// that started it; this is the net under a test that failed before it could.
const HANGING = ['slow body', 'fall body', 'first twin body'];

after(async () => {
  for (const prompt of HANGING) for (const inv of spawns(prompt)) killPid(inv.pid);
  if (prevDeps) scheduler.wireSchedulerDeps(prevDeps);
  await h.shutdown();
});

// One tick of the real scheduler with the console captured. The server armed a
// tick at boot and a second start is a no-op, so the real one is stopped
// before the mocked one this drives is armed.
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

// A tick sees every routine in the workspace, so a test that says nothing
// about the others still fires them. A run recorded late on the test's own day
// suppresses them through the ordinary schedule rule, which leaves each tick
// carrying only the routines its test is about.
function quieten(day, live) {
  for (const key of ALL) {
    if (live.includes(key)) continue;
    h.internal.routineState[key] = { lastRun: dayAt(day, 23, 0).toISOString(), status: 'completed', duration: 1 };
  }
}

// Every spawn carrying this prompt, in order. The routine spawn passes the
// prompt as the last positional argument, and the stub logs its whole argv.
function spawns(prompt) {
  return h.readInvocations().filter(i => (i.argv || []).includes(prompt));
}

function killPid(pid) {
  try { process.kill(pid, 'SIGKILL'); } catch (e) { /* already gone */ }
}

// Wait for a spawned run to reach the stub, so its pid is available to kill.
// The invocation log is written by the child, so it lands after the tick.
async function waitForSpawns(prompt, count) {
  const arrived = await h.waitUntil(() => spawns(prompt).length >= count);
  assert.ok(arrived, `expected ${count} spawn(s) of "${prompt}", saw ${spawns(prompt).length}`);
  return spawns(prompt);
}

function settled(key) {
  return h.waitUntil(() => {
    const s = h.internal.routineState[key];
    return s && s.status !== 'running';
  });
}

test('a routine whose run outlives its window is not started a second time', async (t) => {
  clock.at = dayAt(1, 9, 30);
  delete h.internal.routineState[SLOW];
  delete h.internal.routineState[OTHER];
  quieten(1, [SLOW, OTHER]);

  driveTick(t);
  await waitForSpawns('slow body', 1);
  const held = { ...h.internal.routineState[SLOW] };
  assert.strictEqual(held.status, 'running', 'the slow routine started and has not finished');
  assert.strictEqual(held.lastRun, dayAt(1, 9, 30).toISOString(), 'and its run belongs to the first day');
  // The control ran on this tick too, and it has to be finished before the
  // next one or the guard under test would hold IT, and the control would stop
  // being a control. Waited for rather than assumed: on a loaded machine the
  // child outlives the tick that spawned it.
  assert.ok(await settled(OTHER), 'the control run from the first day has finished');

  // A day later. The stored start time is now stale rather than open, which is
  // exactly the case the schedule rule cannot see.
  clock.at = dayAt(2, 9, 30);
  quieten(2, [SLOW, OTHER]);
  const controlSpawns = spawns('other body').length;
  const logs = driveTick(t);

  // The stored state and the log line first: both are written synchronously by
  // the tick just driven. A spawn count is a lagging indicator, because the
  // invocation log is written by the child rather than by the server, so a
  // second run that HAD started would not be in it yet.
  assert.deepStrictEqual(h.internal.routineState[SLOW], held,
    'being held recorded nothing: the stored run is still the one that is in flight');
  assert.ok(logs.some(l => l.includes('Not starting routine') && l.includes('slow-check')),
    'and the tick said why, so a held routine is not mistaken for one that is not due');

  // The control, on the very tick that did the holding.
  assert.ok(logs.some(l => l.includes('Running routine') && l.includes('other-check')),
    'a different routine started on the same tick, so that tick was live');
  assert.strictEqual(h.internal.routineState[OTHER].lastRun, dayAt(2, 9, 30).toISOString(),
    'and its run belongs to this tick rather than to the day before');

  // The absence is read against a record this tick produced, not against time
  // having passed. The control's spawn from THIS tick appearing in the
  // invocation log is what makes the log current for this tick, so a second
  // slow spawn would be in it if there were one. Waiting for the control to
  // finish would only prove that some time elapsed, which is a reading rather
  // than a record.
  await waitForSpawns('other body', controlSpawns + 1);
  assert.strictEqual(spawns('slow body').length, 1,
    'the routine still in flight was not started a second time');
  assert.ok(await settled(OTHER), 'the control run from this tick has finished');

  // Ended here rather than left for the next test. A run this file starts is
  // this test's to finish, or the next test is reading state it did not make.
  killPid(spawns('slow body')[0].pid);
  assert.ok(await settled(SLOW), 'the run this test started has finished');
});

test('a run that fails releases the routine, and the next window starts a new one', async (t) => {
  clock.at = dayAt(8, 9, 30);
  delete h.internal.routineState[FALL];
  quieten(8, [FALL]);

  driveTick(t);
  const [running] = await waitForSpawns('fall body', 1);
  assert.strictEqual(h.internal.routineState[FALL].status, 'running',
    'this test started its own run rather than inheriting one');

  killPid(running.pid);
  assert.ok(await settled(FALL), 'the killed run reached an outcome');
  assert.strictEqual(h.internal.routineState[FALL].status, 'failed',
    'a run whose child dies is recorded as failed');

  clock.at = dayAt(9, 9, 30);
  quieten(9, [FALL]);
  const logs = driveTick(t);

  assert.ok(logs.some(l => l.includes('Running routine') && l.includes('fall-check')),
    'the failed run released the routine, so the next window started a new one');
  const started = await waitForSpawns('fall body', 2);
  assert.strictEqual(started.length, 2, 'exactly one further run, not two');
  assert.strictEqual(h.internal.routineState[FALL].lastRun, dayAt(9, 9, 30).toISOString(),
    'and the new run is stamped with this tick');

  killPid(started[1].pid);
  assert.ok(await settled(FALL), 'the run this test started has finished');
});

test('a run that completes releases the routine', async (t) => {
  clock.at = dayAt(4, 6, 30);
  delete h.internal.routineState[BRISK];
  quieten(4, [BRISK]);

  driveTick(t);
  assert.ok(await settled(BRISK), 'the first run reached an outcome');
  assert.strictEqual(h.internal.routineState[BRISK].status, 'completed', 'and it succeeded');

  clock.at = dayAt(5, 6, 30);
  quieten(5, [BRISK]);
  const logs = driveTick(t);

  assert.ok(logs.some(l => l.includes('Running routine') && l.includes('brisk-check')),
    'the completed run released the routine, so the next window started a new one');
  await waitForSpawns('brisk body', 2);
  assert.ok(await settled(BRISK), 'the second run reached an outcome');
  assert.strictEqual(h.internal.routineState[BRISK].lastRun, dayAt(5, 6, 30).toISOString(),
    'and the second run is stamped with the second tick');
});

// The identity decision, pinned so it cannot change silently. Two routines
// sharing a name under one agent share one state slot, and single-flight holds
// them together for that reason: a lock finer-grained than the state it
// protects would let one namesake run while the other's hold was still
// standing, and both would write the same slot.
test('two routines sharing a name under one agent are held together', async (t) => {
  // The whole test is vacuous if the roster carries one routine where the
  // fixture wrote two: there would be no namesake to hold, and every assertion
  // below would pass by describing a routine that does not exist. Asserted
  // rather than assumed, because the thing being pinned is precisely that the
  // data model still allows this.
  const twins = h.internal.discoverAgents()
    .find(a => a.id === 'twin').routines.filter(r => r.name === 'twin-check');
  assert.strictEqual(twins.length, 2, 'the fixture declares two routines of one name and the roster carries both');
  assert.notStrictEqual(twins[0].prompt, twins[1].prompt, 'and they are two different routines, not one read twice');

  clock.at = dayAt(6, 9, 30);
  delete h.internal.routineState[TWIN];
  quieten(6, [TWIN]);

  driveTick(t);
  await waitForSpawns('first twin body', 1);
  const held = { ...h.internal.routineState[TWIN] };
  assert.strictEqual(held.status, 'running', 'the first namesake started');
  assert.strictEqual(held.lastRun, dayAt(6, 9, 30).toISOString(),
    'and its run belongs to this drive, so the comparison below is against a run this test made');

  // 08:30 the next day: the first namesake (09:00) is not due, the second
  // (07:00) is, and it has never run. Anything it does now is its own.
  clock.at = dayAt(7, 8, 30);
  quieten(7, [TWIN, BRISK]);
  const controlSpawns = spawns('brisk body').length;
  const logs = driveTick(t);

  assert.deepStrictEqual(h.internal.routineState[TWIN], held,
    'and the shared state slot still describes the run that is in flight');
  const heldLines = logs.filter(l => l.includes('Not starting routine') && l.includes('twin-check'));
  assert.strictEqual(heldLines.length, 1,
    'the tick reached the namesake, found it due, and held it');

  assert.ok(logs.some(l => l.includes('Running routine') && l.includes('brisk-check')),
    'a routine of another name started on the same tick, so that tick was live');
  assert.strictEqual(h.internal.routineState[BRISK].lastRun, dayAt(7, 8, 30).toISOString(),
    'and the control run belongs to this tick rather than to an earlier test');

  // Read against this tick's own record, as above: the control's spawn landing
  // in the log is what makes the log current for the tick that held the
  // namesake.
  await waitForSpawns('brisk body', controlSpawns + 1);
  assert.strictEqual(spawns('second twin body').length, 0,
    'the namesake did not start: the two share one identity, so one run holds both');
  assert.ok(await settled(BRISK), 'the control run from this tick has finished');

  killPid(spawns('first twin body')[0].pid);
  await settled(TWIN);
});
