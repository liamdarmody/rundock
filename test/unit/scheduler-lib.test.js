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
