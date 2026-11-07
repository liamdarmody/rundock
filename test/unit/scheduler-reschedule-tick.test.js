'use strict';
// A routine moved to a later time on a day it has already run, driven through
// the tick with a child process the test controls.
//
// Two consequences of what the run stamp means need a run that is still going,
// or a start that throws, at the moment the new time arrives. Neither can be
// produced on demand by the stub binary the integration harness resolves, so
// the child here is a stand-in whose ending the test decides.
//
// THE STAMP IS WHEN THE LAST RUN FINISHED, OR WHEN IT STARTED WHILE IT IS STILL
// GOING. So a run that started at 20:01 and is still going at 20:30 has not
// served the 20:30 slot yet, and what keeps a second run from starting beside it
// is the hold on a routine in flight, not the stamp. When it finishes, its
// stamp serves 20:30. And a start at 20:30 that throws is stamped at 20:30, so
// the slot it was for counts as served and it is not retried that day.
//
// The zone is set before the first require, and every instant is built from
// local components on Friday 6 November 2026.
process.env.TZ = 'Europe/London';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { agentFile } = require('../helpers/workspace.js');
const { invalidateAgentCache } = require('../../lib/agents/discovery.js');
const { handleSetRoutineSchedule } = require('../../lib/protocol/handlers/team.js');
const config = require('../../lib/config.js');

const SCHEDULER_KEY = require.resolve('../../lib/scheduler.js');
const CLAUDE_KEY = require.resolve('../../lib/runtime/claude.js');

const AGENT = 'mover';
const ROUTINE = 'briefing';
const KEY = `${AGENT}:${ROUTINE}`;

const friday = (hour, minute) => new Date(2026, 10, 6, hour, minute);
const saturday = (hour, minute) => new Date(2026, 10, 7, hour, minute);

// A private scheduler whose children are the test's, loaded after the spawn is
// stood in for because the scheduler takes its spawn when it loads. The signal
// a stop would send is stood in for too, so nothing here can reach a real
// process by its id. Both are put back before the test returns.
function withScheduler(spawn, fn) {
  const claude = require(CLAUDE_KEY);
  const real = { spawnClaude: claude.spawnClaude, killProcessTree: claude.killProcessTree };
  const prevClaudeDeps = claude.wireClaudeRuntimeDeps({ getActualPort: () => 0 });
  claude.spawnClaude = spawn;
  claude.killProcessTree = () => {};
  const cached = require.cache[SCHEDULER_KEY];
  delete require.cache[SCHEDULER_KEY];
  try {
    const sched = require(SCHEDULER_KEY);
    const clock = { at: friday(20, 1) };
    sched.wireSchedulerDeps({ now: () => clock.at, getWssClients: () => [] });
    return fn(sched, clock);
  } finally {
    delete require.cache[SCHEDULER_KEY];
    if (cached) require.cache[SCHEDULER_KEY] = cached;
    Object.assign(claude, real);
    claude.wireClaudeRuntimeDeps(prevClaudeDeps);
  }
}

// A workspace holding one agent with one routine on `schedule`, torn down after.
function withWorkspace(schedule, fn) {
  const original = config.getWorkspace();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-reschedule-tick-'));
  config.setWorkspace(ws);
  fs.mkdirSync(path.join(ws, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.claude', 'agents', `${AGENT}.md`), agentFile({
    name: AGENT, displayName: 'Mover', type: 'specialist', order: 1,
    routines: [{ name: ROUTINE, schedule, prompt: 'p', enabled: true }],
  }));
  require('../helpers/approvals.js').seenHere(ws);
  invalidateAgentCache();
  try {
    return fn(ws);
  } finally {
    config.setWorkspace(original);
    invalidateAgentCache();
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

// Save a new schedule through the save handler, as the editor does.
function saveSchedule(ws, schedule) {
  const sent = [];
  handleSetRoutineSchedule({
    agents: { invalidateAgentCache, discoverSkills: () => [], flagRosterRefresh: () => {} },
    workspace: { isInsideWorkspace: (p) => p.startsWith(ws) },
  }, { send: (m) => sent.push(JSON.parse(m)), readyState: 1 }, {
    type: 'set_routine_schedule', agentId: AGENT, name: ROUTINE, occurrence: 0, schedule,
  });
  assert.strictEqual(sent[0].type, 'routine_rescheduled', `the save went through: ${JSON.stringify(sent[0])}`);
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

// The tick, armed on a mocked interval so a test decides when each pass runs.
function ticking(t, sched, fn) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  sched.startScheduler();
  try {
    return fn((clock, when) => {
      clock.at = when;
      t.mock.timers.tick(60_000);
    });
  } finally {
    sched.stopScheduler();
    t.mock.timers.reset();
  }
}

function everyMinute(from, to) {
  const out = [];
  for (let at = from.getTime(); at <= to.getTime(); at += 60_000) out.push(new Date(at));
  return out;
}

// What the scheduler says on the console while `fn` runs.
function logged(fn) {
  const lines = [];
  const real = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); };
  try {
    fn();
  } finally {
    console.log = real;
  }
  return lines;
}

test('a run still going at the new time serves it, so the routine runs once that day', (t) => {
  const children = [];
  withScheduler(() => { const c = fakeChild(); children.push(c); return c; }, (sched, clock) => {
    withWorkspace('every day at 20:01', (ws) => {
      ticking(t, sched, (tickAt) => {
        tickAt(clock, friday(20, 1));
        assert.strictEqual(children.length, 1, 'it started at 20:01');

        clock.at = friday(20, 10);
        saveSchedule(ws, 'every day at 20:30');

        // Due at 20:30, because a stamp from 20:01 has not served 20:30, and
        // held, because the run that stamp belongs to has not finished.
        const said = logged(() => tickAt(clock, friday(20, 30)));
        assert.strictEqual(children.length, 1, 'the 20:30 tick started nothing beside the run still going');
        assert.ok(said.some(line => line.includes('its previous run has not finished')),
          `the 20:30 tick found the routine due and held it for the run in flight; it said:\n${said.join('\n')}`);

        clock.at = friday(20, 41);
        children[0].emit('close', 0);
        assert.strictEqual(sched.routineState[KEY].lastRun, friday(20, 41).toISOString(),
          'the run that finished at 20:41 is stamped then');

        for (const when of everyMinute(friday(20, 42), friday(23, 59))) tickAt(clock, when);
        assert.strictEqual(children.length, 1, 'and that stamp served 20:30: one run that day');
        assert.strictEqual(sched.routineDisplayFacts(KEY, 'every day at 20:30').nextRun, saturday(20, 30).toISOString(),
          'the row looks to tomorrow');
      });
    });
  });
});

test('a start at the new time that throws is not retried that day, and the row names tomorrow', (t) => {
  const children = [];
  let starts = 0;
  const spawn = () => {
    starts += 1;
    if (starts > 1) throw new Error('spawn refused');
    const c = fakeChild();
    children.push(c);
    return c;
  };
  withScheduler(spawn, (sched, clock) => {
    withWorkspace('every day at 20:01', (ws) => {
      ticking(t, sched, (tickAt) => {
        tickAt(clock, friday(20, 1));
        clock.at = friday(20, 2);
        children[0].emit('close', 0);
        assert.strictEqual(sched.routineState[KEY].status, 'completed', 'the run at 20:01 finished');

        clock.at = friday(20, 10);
        saveSchedule(ws, 'every day at 20:30');

        tickAt(clock, friday(20, 30));
        assert.strictEqual(starts, 2, 'at 20:30 the tick tried to start it');
        assert.strictEqual(sched.routineState[KEY].status, 'failed', 'and the start that threw was recorded');
        assert.strictEqual(sched.routineState[KEY].lastRun, friday(20, 30).toISOString(),
          'stamped at 20:30, which serves the slot it was for');

        for (const when of everyMinute(friday(20, 31), friday(23, 59))) tickAt(clock, when);
        assert.strictEqual(starts, 2, 'so it was not retried at 20:31 or any time after that day');
        assert.strictEqual(sched.routineDisplayFacts(KEY, 'every day at 20:30').nextRun, saturday(20, 30).toISOString(),
          'and the row names tomorrow\'s 20:30');
      });
    });
  });
});
