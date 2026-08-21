'use strict';
// Seam tests for lib/scheduler.js. The scheduler's behaviour (the grammar,
// the tick, routine execution on both runtimes) is pinned by the existing
// characterization suite driving the wired module through the root's
// _internal re-exports; these tests pin the SEAMS themselves: unwired root
// deps refuse loudly, the wiring is restorable, routineState is mutated in
// place (never reassigned) so every holder of the object sees the same
// state, and persistence resolves the workspace at USE time so a switch
// redirects the very next read and write.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCHEDULER_KEY = require.resolve('../../lib/scheduler.js');

// A private copy per test: wiring one test's fakes must never leak into
// another test (or into the shared instance other requires would see).
function freshScheduler() {
  const cached = require.cache[SCHEDULER_KEY];
  delete require.cache[SCHEDULER_KEY];
  const mod = require(SCHEDULER_KEY);
  delete require.cache[SCHEDULER_KEY];
  if (cached) require.cache[SCHEDULER_KEY] = cached;
  return mod;
}

function withTempWorkspace(fn) {
  const config = require('../../lib/config.js');
  const original = config.getWorkspace();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-lib-'));
  try {
    config.setWorkspace(ws);
    return fn(ws, config);
  } finally {
    config.setWorkspace(original);
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

test('unwired root deps throw the named wiring error at first use', () => {
  withTempWorkspace(() => {
    const sched = freshScheduler();
    // executeRoutine records the run (persistence works: the workspace is
    // real), then broadcasts, which is the first wired-dep touch. The named
    // throw is the proof the module got exactly that far on its own.
    assert.throws(
      () => sched.executeRoutine({ id: 'runner', name: 'Runner' }, { name: 'r', prompt: 'p' }, 'runner:r'),
      /lib\/scheduler: getWssClients not wired \(call wireSchedulerDeps at boot\)/,
    );
  });
});

// A run is held from the moment it is started until it records an outcome, so
// a start that throws before there is anything to record would hold its
// routine for the life of the process: no spawn, no child, no close event,
// and therefore nothing that will ever release it. That is the one way the
// guard can turn from a protection into a routine that never runs again, and
// it needs no bug in the guard itself to happen.
//
// The test asserts the SECOND attempt gets as far as the first did. That is
// the assertion that can fail: a routine still held would be turned away by
// the guard and would return quietly, throwing nothing.
//
// The spawn itself is the other half, and it is not a throw. Node reports a
// child that never launched asynchronously, as an 'error' event followed by a
// 'close' with a negative code, so a routine whose runtime is missing entirely
// releases through the ordinary outcome path rather than through this one. The
// killed-child test in the integration suite pins that path.
test('a start that throws before the spawn does not hold the routine', () => {
  withTempWorkspace(() => {
    const sched = freshScheduler();
    // The broadcast is the first wired-dep touch, and it happens before any
    // child exists. An unwired dep at boot is exactly this shape.
    const start = () => sched.executeRoutine({ id: 'runner', name: 'Runner' }, { name: 'r', prompt: 'p' }, 'runner:r');
    assert.throws(start, /getWssClients not wired/);
    assert.throws(start, /getWssClients not wired/,
      'the second start reached the same throw, so the first one released the routine on its way out');
  });
});

test('wireSchedulerDeps returns the previous set, restorable by identity', () => {
  withTempWorkspace(() => {
    const sched = freshScheduler();
    const prev = sched.wireSchedulerDeps({ getWssClients: () => [] });
    assert.strictEqual(typeof prev.getWssClients, 'function');
    sched.wireSchedulerDeps(prev);
    assert.throws(
      () => sched.executeRoutine({ id: 'runner', name: 'Runner' }, { name: 'r', prompt: 'p' }, 'runner:r'),
      /getWssClients not wired/,
    );
  });
});

test('routine state follows the workspace at USE time, and routineState mutates in place', () => {
  const sched = freshScheduler();
  const config = require('../../lib/config.js');
  const original = config.getWorkspace();
  const stateRef = sched.routineState; // held BEFORE any call: identity must survive
  const wsA = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-ws-a-'));
  const wsB = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-ws-b-'));
  try {
    config.setWorkspace(wsA);
    sched.recordRoutineRun('cos:briefing', { lastRun: '2026-08-12T09:00:00Z', status: 'completed', duration: 3 });
    assert.ok(fs.existsSync(path.join(wsA, '.rundock', 'routine-state.json')),
      'the record landed in workspace A with no re-wiring');

    config.setWorkspace(wsB);
    sched.recordRoutineRun('cos:evening', { lastRun: '2026-08-12T18:00:00Z', status: 'completed', duration: 2 });
    assert.ok(fs.existsSync(path.join(wsB, '.rundock', 'routine-state.json')),
      'the very next record followed the switch to workspace B');

    // Back on A: loadRoutineState clears IN PLACE and restores A's view.
    // The evening run (recorded while B was active) is not in A's file.
    config.setWorkspace(wsA);
    sched.loadRoutineState();
    assert.strictEqual(sched.routineState, stateRef, 'routineState is never reassigned');
    assert.ok(stateRef['cos:briefing'], "workspace A's run restored through the held reference");
    assert.strictEqual(stateRef['cos:evening'], undefined, "workspace B's run is not in A's state");
  } finally {
    config.setWorkspace(original);
    fs.rmSync(wsA, { recursive: true, force: true });
    fs.rmSync(wsB, { recursive: true, force: true });
  }
});

test('a run left "running" by a dead server loads back as "interrupted", still suppressing a re-fire', () => {
  const sched = freshScheduler();
  withTempWorkspace((ws) => {
    const dir = path.join(ws, '.rundock');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'routine-state.json'), JSON.stringify({
      'cos:briefing': { lastRun: '2026-08-12T09:00:00Z', status: 'running', duration: null },
      'bad:entry': { status: 'completed' }, // no lastRun string: dropped
    }));
    sched.loadRoutineState();
    assert.strictEqual(sched.routineState['cos:briefing'].status, 'interrupted',
      'a running entry from a dead process surfaces honestly');
    assert.strictEqual(sched.routineState['cos:briefing'].lastRun, '2026-08-12T09:00:00Z',
      'lastRun survives so the window suppression still holds');
    assert.strictEqual(sched.routineState['bad:entry'], undefined, 'entries without a lastRun string are dropped');
  });
});

// ===== THE CLOCK SEAM =====
// The tick used to call the clock directly, so the only way to reach a
// scheduled instant was to wait for it. These pin the seam itself: the tick
// reads the wired clock, and it reads it once per tick, which is what makes
// the tick countable in the lifecycle tests below.

test('the tick reads the current time through the wired clock seam', (t) => {
  withTempWorkspace(() => {
    const sched = freshScheduler();
    let reads = 0;
    const fixed = new Date(2026, 6, 1, 8, 0, 0);
    sched.wireSchedulerDeps({ now: () => { reads += 1; return fixed; } });
    t.mock.timers.enable({ apis: ['setInterval'] });
    try {
      sched.startScheduler();
      t.mock.timers.tick(60_000);
      assert.strictEqual(reads, 1, 'the tick took its instant from the wired clock, once');
    } finally {
      t.mock.timers.reset();
    }
  });
});

// ===== LIFECYCLE =====
// startScheduler used to throw its interval handle away, so the tick could
// not be stopped and a second call quietly added a second one. The clock
// seam above is what makes these countable: a bare workspace discovers one
// agent with no routines, so a tick is exactly one clock read and nothing
// else, and the count is the number of ticks that ran.

function countingClock(sched, at = new Date(2026, 6, 1, 8, 0, 0)) {
  const clock = { reads: 0, at };
  sched.wireSchedulerDeps({ now: () => { clock.reads += 1; return clock.at; } });
  return clock;
}

test('a stopped scheduler fires nothing', (t) => {
  withTempWorkspace(() => {
    const sched = freshScheduler();
    const clock = countingClock(sched);
    t.mock.timers.enable({ apis: ['setInterval'] });
    try {
      sched.startScheduler();
      t.mock.timers.tick(60_000);
      // Proves the tick was LIVE before the stop. Without it, "no ticks after
      // the stop" is satisfied by a scheduler that was never running.
      assert.strictEqual(clock.reads, 1, 'the tick was running before the stop');

      clock.reads = 0;
      sched.stopScheduler();
      t.mock.timers.tick(180_000);
      assert.strictEqual(clock.reads, 0, 'three minutes passed and no tick ran');
    } finally {
      t.mock.timers.reset();
    }
  });
});

test('starting the scheduler twice leaves exactly one tick running', (t) => {
  withTempWorkspace(() => {
    const sched = freshScheduler();
    const clock = countingClock(sched);
    t.mock.timers.enable({ apis: ['setInterval'] });
    try {
      sched.startScheduler();
      sched.startScheduler();
      t.mock.timers.tick(60_000);
      assert.strictEqual(clock.reads, 1, 'one minute produced one tick, not two');
    } finally {
      sched.stopScheduler();
      t.mock.timers.reset();
    }
  });
});

test('a scheduler stopped and started again ticks normally', (t) => {
  withTempWorkspace(() => {
    const sched = freshScheduler();
    const clock = countingClock(sched);
    t.mock.timers.enable({ apis: ['setInterval'] });
    try {
      sched.startScheduler();
      sched.stopScheduler();
      clock.reads = 0;
      sched.startScheduler();
      t.mock.timers.tick(60_000);
      assert.strictEqual(clock.reads, 1, 'stopping is not a one-way door');
    } finally {
      sched.stopScheduler();
      t.mock.timers.reset();
    }
  });
});

test('stopping a scheduler that was never started is safe and does nothing', (t) => {
  withTempWorkspace(() => {
    const sched = freshScheduler();
    const clock = countingClock(sched);
    t.mock.timers.enable({ apis: ['setInterval'] });
    try {
      sched.stopScheduler();
      t.mock.timers.tick(60_000);
      assert.strictEqual(clock.reads, 0, 'nothing was armed, so nothing ticked');
      // And the no-op stop left the scheduler startable, which is the part
      // that would break if stopping recorded anything about having run.
      sched.startScheduler();
      t.mock.timers.tick(60_000);
      assert.strictEqual(clock.reads, 1, 'a start after a no-op stop still arms the tick');
    } finally {
      sched.stopScheduler();
      t.mock.timers.reset();
    }
  });
});
