'use strict';
// The road from a click on "Stop" to the scheduler's own cancelRun, driven
// against a stubbed scheduler rather than a real spawned process.
//
// WHAT THIS FILE IS GUARDING. cancelRun (lib/scheduler.js) takes a run's own
// id, which is a UUID nothing on the client ever sees: the screen that shows
// a running routine knows it by agent + routine name, the same pair get_run
// already resolves by. This handler is the one place that pair is turned
// into the id cancelRun actually needs, via runningRuns(), so this test drives
// THAT resolution, not the stop machinery itself (scheduler-lib.test.js
// already drives cancelRun, forceStop escalation, and a real child process
// refusing a signal, at length, and none of that is repeated here).
//
// ALWAYS ANSWERS, same reasoning as handleGetRun's own tests: a handler that
// throws or returns early without replying leaves the screen waiting forever.
//
// WHAT THIS FILE DOES NOT PROVE. Because runningRuns() and cancelRun() are
// both replaced for every case here, nothing in this file shows that a run
// really ends 'cancelled' rather than 'failed', or that a real running run's
// shape actually carries `id`/`agent`/`routine`. That chain, driven against
// the real scheduler with a real signalled child, is
// test/integration/routine-run-cancel.test.js.
const { test, describe } = require('node:test');
const assert = require('node:assert');

const runs = require('../../lib/protocol/handlers/runs.js');
const scheduler = require('../../lib/scheduler.js');

/** A socket that keeps what was sent to it, parsed. */
function socket() {
  const sent = [];
  return { sent, send: (raw) => sent.push(JSON.parse(raw)) };
}

/** Stubs runningRuns() and cancelRun() for the body, restores both after. */
function withScheduler({ running = [], cancelled = () => true }, body) {
  const realRunning = scheduler.runningRuns;
  const realCancel = scheduler.cancelRun;
  const calls = [];
  scheduler.runningRuns = () => running;
  scheduler.cancelRun = (id) => { calls.push(id); return cancelled(id); };
  try { return body(calls); } finally {
    scheduler.runningRuns = realRunning;
    scheduler.cancelRun = realCancel;
  }
}

const LIVE = { id: 'run-abc', key: 'dev:Nightly build check', agent: 'dev', routine: 'Nightly build check', startedAt: '2026-08-27T22:00:00.000Z' };

describe('stopping a routine run', () => {
  test('a live run matched by agent and routine is stopped by its own id', () => {
    withScheduler({ running: [LIVE] }, (calls) => {
      const ws = socket();
      runs.handleCancelRoutineRun({}, ws, { type: 'cancel_routine_run', agentId: 'dev', routine: 'Nightly build check' });
      assert.deepStrictEqual(calls, ['run-abc'], 'cancelRun was not asked to stop the id runningRuns named');
      assert.strictEqual(ws.sent.length, 1, 'the handler did not reply, so the screen would wait forever');
      assert.strictEqual(ws.sent[0].type, 'routine_run_stop_requested');
      assert.strictEqual(ws.sent[0].stopped, true);
    });
  });

  test('the reply names the agent and routine that were asked for', () => {
    withScheduler({ running: [LIVE] }, () => {
      const ws = socket();
      runs.handleCancelRoutineRun({}, ws, { type: 'cancel_routine_run', agentId: 'dev', routine: 'Nightly build check' });
      assert.strictEqual(ws.sent[0].agentId, 'dev');
      assert.strictEqual(ws.sent[0].routine, 'Nightly build check');
    });
  });

  test('a routine with no live run answers stopped:false rather than throwing', () => {
    withScheduler({ running: [] }, (calls) => {
      const ws = socket();
      runs.handleCancelRoutineRun({}, ws, { type: 'cancel_routine_run', agentId: 'dev', routine: 'Nightly build check' });
      assert.deepStrictEqual(calls, [], 'cancelRun was called with nothing running to stop');
      assert.strictEqual(ws.sent[0].stopped, false);
    });
  });

  test('a different routine on the same agent is not stopped by a namesake elsewhere', () => {
    const other = { ...LIVE, id: 'run-xyz', key: 'dev:Spec review', routine: 'Spec review' };
    withScheduler({ running: [other] }, (calls) => {
      const ws = socket();
      runs.handleCancelRoutineRun({}, ws, { type: 'cancel_routine_run', agentId: 'dev', routine: 'Nightly build check' });
      assert.deepStrictEqual(calls, [], 'a different routine\'s run was reached instead');
      assert.strictEqual(ws.sent[0].stopped, false);
    });
  });

  test('a routine of the same name on a different agent is not stopped by its namesake', () => {
    const namesake = { ...LIVE, id: 'run-namesake', key: 'cos:Nightly build check', agent: 'cos' };
    withScheduler({ running: [namesake] }, (calls) => {
      const ws = socket();
      runs.handleCancelRoutineRun({}, ws, { type: 'cancel_routine_run', agentId: 'dev', routine: 'Nightly build check' });
      assert.deepStrictEqual(calls, [], 'the namesake on a different agent was stopped instead');
      assert.strictEqual(ws.sent[0].stopped, false);
    });
  });

  test('a request naming neither agent nor routine answers stopped:false without touching the scheduler', () => {
    withScheduler({ running: [LIVE] }, (calls) => {
      const ws = socket();
      runs.handleCancelRoutineRun({}, ws, { type: 'cancel_routine_run' });
      assert.deepStrictEqual(calls, []);
      assert.strictEqual(ws.sent[0].stopped, false);
      assert.strictEqual(ws.sent[0].agentId, null);
      assert.strictEqual(ws.sent[0].routine, null);
    });
  });

  test('cancelRun answering false (the run ended between the click and the ask) still replies honestly', () => {
    withScheduler({ running: [LIVE], cancelled: () => false }, () => {
      const ws = socket();
      runs.handleCancelRoutineRun({}, ws, { type: 'cancel_routine_run', agentId: 'dev', routine: 'Nightly build check' });
      assert.strictEqual(ws.sent[0].stopped, false);
    });
  });
});

describe('the contract this file is about to replace', () => {
  test('runningRuns and cancelRun are real functions on the scheduler, before anything below stubs them', () => {
    assert.strictEqual(typeof scheduler.runningRuns, 'function',
      'every case below replaces this; if it were not a real function to begin with, the stub would be standing in for nothing');
    assert.strictEqual(typeof scheduler.cancelRun, 'function',
      'every case below replaces this; if it were not a real function to begin with, the stub would be standing in for nothing');
  });
});

describe('the handler is registered', () => {
  test('cancel_routine_run reaches handleCancelRoutineRun through the real dispatch table', () => {
    const { buildDispatch } = require('../../lib/protocol/handlers/index.js');
    const dispatch = buildDispatch();
    assert.strictEqual(dispatch.cancel_routine_run, runs.handleCancelRoutineRun,
      'the message type a client would actually send is not wired to this handler');
  });
});
