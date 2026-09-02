'use strict';
// The real path from a Stop press to a run record that says 'cancelled', not
// 'failed'.
//
// WHY THIS FILE EXISTS. test/unit/routine-run-stop-transport.test.js drives
// handleCancelRoutineRun's own resolution logic (agent+routine -> a run id,
// then a reply) against a stubbed scheduler, and never touches
// lib/scheduler.js at all: the stub always returns a boolean, and nothing
// checks what a real cancelled run's record ends up saying. The distinction
// that matters is exactly the one a stub cannot prove: a run whose child
// exits non-zero on its own is recorded 'failed', and a run whose child was
// signalled because somebody asked it to stop is recorded 'cancelled', and
// those are told apart by one flag (`run.cancelled`) set before the signal
// goes out. This file drives a real hanging child through the real WS server,
// the real dispatch table and the real scheduler, signals it the same way a
// Stop press does, and reads the ending back from both stores it lands in:
// routineState (the routines list's own summary) and the run-record file
// scheduler.readRunRecords() serves handleGetRun from.
//
// Setup mirrors scheduler-single-flight.test.js: a routine whose scenario
// hangs on a long delay until its child is signalled, driven through a real
// tick with a mocked interval so nothing here rests on wall-clock time.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const h = require('../helpers/harness.js');
const { agentFile } = require('../helpers/workspace.js');

const scheduler = require('../../lib/scheduler.js');

const AGENT_ID = 'dev';
const ROUTINE = 'Nightly build check';
const KEY = 'dev:Nightly build check';
const PROMPT = 'stoppable routine body';

// October 2026, local components, so the fixture is timezone-independent and
// shares no day with another integration test's own fixture.
function dayAt(day, hour, minute) { return new Date(2026, 9, day, hour, minute, 0); }

const clock = { at: dayAt(1, 9, 0) };
let prevDeps = null;

before(async () => {
  await h.boot({
    agents: {
      dev: agentFile({
        name: 'dev', type: 'specialist', order: 1,
        routines: [{ name: ROUTINE, schedule: 'every day at 09:00', prompt: PROMPT, enabled: true }],
      }),
    },
  });
  h.writeScenario([
    { match: { agent: AGENT_ID, promptIncludes: PROMPT }, delayMs: 600000, turn: [{ text: 'never arrives' }] },
  ]);
  prevDeps = scheduler.wireSchedulerDeps({ now: () => clock.at });
});

after(async () => {
  // Net under a test that failed before it could stop its own run: nothing
  // here should still be hanging by this point, but a recycled pid is worse
  // than a redundant signal to one that already exited.
  for (const inv of spawns()) killPid(inv.pid);
  if (prevDeps) scheduler.wireSchedulerDeps(prevDeps);
  await h.shutdown();
});

// One tick of the real scheduler with the console left alone: this file has
// no interest in the log lines the way scheduler-single-flight.test.js does,
// only in the run the tick starts. The real boot-armed tick is stopped first,
// the same as every scheduler integration test that mocks setInterval.
function driveTick(t) {
  h.internal.stopScheduler();
  t.mock.timers.enable({ apis: ['setInterval'] });
  try {
    h.internal.startScheduler();
    t.mock.timers.tick(60_000);
  } finally {
    h.internal.stopScheduler();
    t.mock.timers.reset();
  }
}

function spawns() {
  return h.readInvocations().filter(i => (i.argv || []).includes(PROMPT));
}

async function waitForSpawn() {
  const arrived = await h.waitUntil(() => spawns().length >= 1);
  assert.ok(arrived, 'expected the stoppable routine to spawn a child');
  return spawns()[0];
}

function settled() {
  return h.waitUntil(() => {
    const s = h.internal.routineState[KEY];
    return s && s.status !== 'running';
  });
}

function killPid(pid) {
  try { process.kill(pid, 'SIGKILL'); } catch (e) { /* already gone */ }
}

test('a Stop press through the real WS server ends the run "cancelled", never "failed"', async (t) => {
  driveTick(t);
  await waitForSpawn();
  assert.strictEqual(h.internal.routineState[KEY].status, 'running', 'the routine did not start for real');

  // THE CONTRACT test/unit/routine-run-stop-transport.test.js STUBS, PINNED
  // HERE AGAINST THE REAL PRODUCER. That file replaces scheduler.runningRuns
  // entirely, so nothing there would notice runningRuns() being renamed, or
  // its entries losing the `agent`/`routine`/`id` keys the handler resolves
  // by. A genuinely running run, reported by the real scheduler, is asserted
  // to carry exactly that shape before this test goes anywhere near a stop.
  assert.strictEqual(typeof scheduler.runningRuns, 'function');
  assert.strictEqual(typeof scheduler.cancelRun, 'function');
  const live = scheduler.runningRuns().find(r => r.agent === AGENT_ID && r.routine === ROUTINE);
  assert.ok(live, 'the scheduler does not report the run this test just started as running');
  assert.strictEqual(typeof live.id, 'string', 'runningRuns() entries no longer carry an id the handler can act on');
  assert.strictEqual(live.agent, AGENT_ID);
  assert.strictEqual(live.routine, ROUTINE);

  const client = await h.connect();
  try {
    client.send({ type: 'cancel_routine_run', agentId: AGENT_ID, routine: ROUTINE });
    const { msg: stopReply } = await client.waitFor(
      m => m.type === 'routine_run_stop_requested', { label: 'routine_run_stop_requested' },
    );
    assert.strictEqual(stopReply.stopped, true, 'the handler did not think it stopped a live run');

    assert.ok(await settled(), 'the signalled run never reached an ending');
    // THE ASSERTION THIS FILE EXISTS FOR. A run whose child dies on its own
    // is 'failed' (scheduler-single-flight.test.js pins that, by killing a
    // run nobody asked to stop); a run whose child was signalled because a
    // stop was asked for first must read differently, in both stores that
    // outcome is written to.
    assert.strictEqual(h.internal.routineState[KEY].status, 'cancelled',
      'a run ended by a stop request must read "cancelled" in the routine summary, not "failed"');

    client.send({ type: 'get_run', agentId: AGENT_ID, routine: ROUTINE });
    const { msg: runReply } = await client.waitFor(m => m.type === 'run', { label: 'get_run reply' });
    assert.ok(runReply.run, 'no run record came back for the routine this test just stopped');
    assert.strictEqual(runReply.run.id, live.id, 'read back a different run than the one this test stopped');
    assert.strictEqual(runReply.run.status, 'cancelled',
      'the persisted run record ended "cancelled": this is the word run-detail.js actually reads');
  } finally {
    client.close();
  }
});
