'use strict';
// Characterization: the scheduler's interval tick and the codex routine
// failure path. The tick had never been driven (a real 60s interval is
// untestable); node:test mock timers advance it deterministically against
// the stub runtime. Pinned ahead of the scheduler's own extraction slice.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const h = require('../helpers/harness.js');
const { agentFile } = require('../helpers/workspace.js');

before(async () => {
  await h.boot({
    agents: {
      runner: agentFile({
        name: 'runner', type: 'specialist', order: 1,
        routines: [{ name: 'tick-check', schedule: 'every day at 00:00', prompt: 'tick routine body' }],
      }),
      'codex-runner': agentFile({
        name: 'codex-runner', type: 'specialist', order: 2, runtime: 'codex',
        routines: [{ name: 'codex-check', schedule: 'every day at 00:00', prompt: 'codex routine body' }],
      }),
    },
  });
});
after(h.shutdown);

test('the scheduler tick discovers a due routine and executes it end to end', async (t) => {
  h.writeScenario([
    { match: { agent: 'runner', promptIncludes: 'tick routine body' }, turn: [{ text: 'routine ran' }] },
  ]);
  // The routine is due (00:00 has passed, no lastRun) but must not fire for
  // the codex agent yet: clear any state and let the tick decide.
  delete h.internal.routineState['runner:tick-check'];
  // Pre-mark the codex routine as already run today so this test drives ONLY
  // the claude path; the codex failure path is the next test's job.
  h.internal.routineState['codex-runner:codex-check'] = {
    lastRun: new Date().toISOString(), status: 'completed', duration: 1,
  };

  // The server arms the tick at boot, and a second start is now a no-op
  // rather than a second interval, so the boot tick has to go before this
  // test can arm the mocked one it drives. Stopped before the mock timers
  // are installed so the handle being cleared is the real one it came from.
  h.internal.stopScheduler();
  t.mock.timers.enable({ apis: ['setInterval'] });
  h.internal.startScheduler();
  t.mock.timers.tick(60_000);
  t.mock.timers.reset();

  await h.waitUntil(() => {
    const s = h.internal.routineState['runner:tick-check'];
    return s && s.status !== 'running';
  });
  const state = h.internal.routineState['runner:tick-check'];
  assert.strictEqual(state.status, 'completed', 'the tick fired the due routine through the stub runtime');
  assert.ok(typeof state.duration === 'number', 'the outcome recorded a duration');
});

test('a codex routine whose thread cannot start records a failed run, not a hang', async () => {
  // Exhaust the client's overload retries so thread/start ultimately
  // rejects; the rejection path must record the failure and move on.
  h.writeCodexScenario([], { overload: { method: 'thread/start', times: 10 } });
  const agent = h.internal.discoverAgents().find(a => a.id === 'codex-runner');
  assert.strictEqual(agent.runtime, 'codex');
  delete h.internal.routineState['codex-runner:codex-check'];

  h.internal.executeRoutine(agent, { name: 'codex-check', prompt: 'codex routine body' }, 'codex-runner:codex-check');
  await h.waitUntil(() => {
    const s = h.internal.routineState['codex-runner:codex-check'];
    return s && s.status !== 'running';
  }, { timeout: 15000 });
  const state = h.internal.routineState['codex-runner:codex-check'];
  assert.strictEqual(state.status, 'failed', 'the rejected thread start records a failed outcome');
});
