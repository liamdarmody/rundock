'use strict';
// Run a routine now, and ask for consent only when what it runs has changed.
//
// A routine can be run by pressing a control on its row. That run is a run
// somebody is watching, so it moves nothing the scheduler decides with: the
// routine's own state, the slot records and the next-run instant are the same
// after it as before, and the record it leaves says it was started by hand.
//
// EVERY DATE IS BUILT FROM LOCAL COMPONENTS and the zone is set before the
// first require, for the reason routines-next-run.test.js gives: node --test
// gives every file its own process, and continuous integration runs in UTC.
process.env.TZ = 'Europe/London';

const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { agentFile, cleanup } = require('../helpers/workspace.js');
const { invalidateAgentCache } = require('../../lib/agents/discovery.js');
const { computePlanHash } = require('../../lib/agents/routines.js');
const SCHEDULER_KEY = require.resolve('../../lib/scheduler.js');
const CLAUDE_KEY = require.resolve('../../lib/runtime/claude.js');
const SIGNALS_KEY = require.resolve('../../lib/signals.js');

after(cleanup);

const SCHEDULE = 'every day at 07:00';
const AGENT = 'piper';
const ROUTINE = 'digest';
const KEY = `${AGENT}:${ROUTINE}`;
// Thursday 20 August 2026, twenty past nine: the same frame every routines
// test uses, so a slot, a run and a clock reading mean the same thing here as
// on the list.
const NOW = new Date(2026, 7, 20, 9, 20);
const TODAYS_SLOT = new Date(2026, 7, 20, 7, 0);
const TOMORROWS_SLOT = new Date(2026, 7, 21, 7, 0);

// The routine as the editor writes it: born approved, switched on, runnable.
function approvedRoutine(extra = {}) {
  const base = { name: ROUTINE, schedule: SCHEDULE, prompt: 'go', runOn: 'local', enabled: true, ...extra };
  return { ...base, planApprovedHash: computePlanHash(base) };
}

// A private scheduler per test, required AFTER the fakes below are in place,
// because the scheduler destructures its runtime and its signal writer at
// require time.
function freshScheduler() {
  const cached = require.cache[SCHEDULER_KEY];
  delete require.cache[SCHEDULER_KEY];
  const mod = require(SCHEDULER_KEY);
  delete require.cache[SCHEDULER_KEY];
  if (cached) require.cache[SCHEDULER_KEY] = cached;
  return mod;
}

/**
 * One workspace, one agent, one routine, a scheduler whose children never
 * reach a real binary, and the signal writer captured.
 *
 * The fake child is an emitter the test ends by hand, so a run can be held
 * open for as long as an assertion about "while it is going" needs.
 */
function withRun(fn, opts = {}) {
  const config = require('../../lib/config.js');
  const claude = require(CLAUDE_KEY);
  const signals = require(SIGNALS_KEY);
  const original = config.getWorkspace();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'run-now-'));
  config.setWorkspace(ws);
  const agentsDir = path.join(ws, '.claude', 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, `${AGENT}.md`), agentFile({
    name: AGENT, displayName: 'Piper', type: 'specialist', order: 1,
    routines: opts.routines || [opts.routine || approvedRoutine()],
  }));
  invalidateAgentCache();

  const realSpawn = claude.spawnClaude;
  const prevClaudeDeps = claude.wireClaudeRuntimeDeps({ getActualPort: () => 0 });
  const children = [];
  claude.spawnClaude = (args, spawnOpts) => {
    const { EventEmitter } = require('node:events');
    const child = new EventEmitter();
    child.args = args;
    child.opts = spawnOpts;
    child.pid = 4000 + children.length;
    child.kill = () => {};
    children.push(child);
    return child;
  };
  const realRecordEvent = signals.recordEvent;
  const events = [];
  signals.recordEvent = (name, fields) => events.push({ name, fields });
  try {
    const sched = freshScheduler();
    const clock = { at: opts.now || NOW };
    sched.wireSchedulerDeps({ now: () => clock.at, getWssClients: () => [] });
    const { discoverAgents } = require('../../lib/agents/discovery.js');
    const agent = discoverAgents().find(a => a.id === AGENT);
    const routine = agent.routines.find(r => r.name === ROUTINE);
    return fn({ sched, ws, agent, routine, children, events, clock });
  } finally {
    claude.spawnClaude = realSpawn;
    claude.wireClaudeRuntimeDeps(prevClaudeDeps);
    signals.recordEvent = realRecordEvent;
    config.setWorkspace(original);
    invalidateAgentCache();
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

const runsDir = (ws) => path.join(ws, '.rundock', 'runs');
function recordsOn(ws) {
  const dir = runsDir(ws);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map(name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8')));
}
const stateFile = (ws) => path.join(ws, '.rundock', 'routine-state.json');
const slotsFile = (ws) => path.join(ws, '.rundock', 'routine-slots.json');
const readIfThere = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null);

// ---------------------------------------------------------------------------
// The record says who started the run
// ---------------------------------------------------------------------------

describe('the run record carries an explicit trigger from both writers', () => {
  test('a run the tick starts is recorded as scheduled, open and closed', () => {
    withRun(({ sched, ws, agent, routine, children }) => {
      assert.strictEqual(sched.executeRoutine(agent, routine, KEY, NOW, 'scheduled'), true);
      const open = recordsOn(ws);
      assert.strictEqual(open.length, 1, 'one record is opened when the run starts');
      assert.strictEqual(open[0].status, 'running');
      assert.strictEqual(open[0].trigger, 'scheduled', 'the opening writer stamps the trigger');
      children[0].emit('close', 0);
      const closed = recordsOn(ws);
      assert.strictEqual(closed[0].status, 'succeeded');
      assert.strictEqual(closed[0].trigger, 'scheduled', 'the closing writer stamps it again rather than dropping it');
    });
  });

  test('a run somebody pressed is recorded as manual, open and closed', () => {
    withRun(({ sched, ws, agent, routine, children }) => {
      assert.strictEqual(sched.executeRoutine(agent, routine, KEY, NOW, 'manual'), true);
      assert.strictEqual(recordsOn(ws)[0].trigger, 'manual', 'the opening writer says the run was pressed');
      children[0].emit('close', 0);
      assert.strictEqual(recordsOn(ws)[0].trigger, 'manual', 'and so does the closing one');
    });
  });

  test('a record written before the field existed crosses the wire as written and reads as scheduled', () => {
    withRun(({ sched, ws }) => {
      const old = {
        id: 'old', agent: AGENT, routine: ROUTINE, sessionId: null, status: 'succeeded',
        startedAt: NOW.toISOString(), endedAt: NOW.toISOString(), durationMs: 1000, error: null,
        files: [], filesStatus: 'known', filesReason: null,
      };
      fs.mkdirSync(runsDir(ws), { recursive: true });
      fs.writeFileSync(path.join(runsDir(ws), 'old.json'), JSON.stringify(old));
      // The store's own rule: a record is forwarded whole, never rebuilt, so
      // the reader invents no field. The interpretation belongs to the
      // readers that name a run, and every one of them reads absence as the
      // tick's run, because nothing else could start one when it was written.
      const [record] = sched.readRunRecords();
      assert.deepStrictEqual(record, old, 'the reader hands the record over exactly as it was written');
      const model = require('../../public/run-detail-model.js');
      assert.strictEqual(model.triggerOf(record), 'scheduled');
      assert.strictEqual(model.describeRun(record, { now: NOW }).trigger, 'scheduled');
    });
  });

  test('get_run returns the field, whichever writer wrote it', () => {
    withRun(({ sched, ws, agent, routine, children }) => {
      sched.executeRoutine(agent, routine, KEY, NOW, 'manual');
      children[0].emit('close', 0);
      // The handler reaches the reader through the module, so the private
      // scheduler this test built has to be the one it reads.
      const runs = require('../../lib/protocol/handlers/runs.js');
      const shared = require(SCHEDULER_KEY);
      const realRead = shared.readRunRecords;
      shared.readRunRecords = () => sched.readRunRecords();
      const sent = [];
      try {
        runs.handleGetRun({}, { send: (m) => sent.push(JSON.parse(m)) }, { type: 'get_run', agentId: AGENT, routine: ROUTINE });
      } finally {
        shared.readRunRecords = realRead;
      }
      assert.strictEqual(sent.length, 1);
      assert.strictEqual(sent[0].run.trigger, 'manual');
    });
  });

  test('the run detail names a manual run as such, and a scheduled one as scheduled', () => {
    const model = require('../../public/run-detail-model.js');
    const base = {
      id: 'r1', agent: AGENT, routine: ROUTINE, status: 'succeeded', startedAt: NOW.toISOString(),
      endedAt: NOW.toISOString(), durationMs: 1000, error: null, files: [], filesStatus: 'known', filesReason: null,
    };
    const manual = model.describeRun({ ...base, trigger: 'manual' }, { now: NOW });
    const scheduled = model.describeRun({ ...base, trigger: 'scheduled' }, { now: NOW });
    const predating = model.describeRun(base, { now: NOW });
    assert.strictEqual(manual.trigger, 'manual');
    assert.strictEqual(scheduled.trigger, 'scheduled');
    assert.strictEqual(predating.trigger, 'scheduled', 'a record with no field is a tick\'s run');
    assert.match(manual.when, /started manually/, 'the words the screen shows say the run was pressed');
    assert.doesNotMatch(scheduled.when, /manually/, 'and a tick\'s run says nothing of the kind');
    assert.strictEqual(predating.when, scheduled.when, 'a predating record reads exactly as a scheduled one');
  });

  test('the routine_run event carries the trigger', () => {
    withRun(({ sched, agent, routine, children, events }) => {
      sched.executeRoutine(agent, routine, KEY, NOW, 'manual');
      children[0].emit('close', 0);
      const ran = events.filter(e => e.name === 'routine_run');
      assert.strictEqual(ran.length, 1, 'one routine_run event per run');
      assert.strictEqual(ran[0].fields.d.trigger, 'manual');
      assert.strictEqual(ran[0].fields.d.routine, ROUTINE);
    });
    withRun(({ sched, agent, routine, children, events }) => {
      sched.executeRoutine(agent, routine, KEY, NOW, 'scheduled');
      children[0].emit('close', 0);
      assert.strictEqual(events.filter(e => e.name === 'routine_run')[0].fields.d.trigger, 'scheduled');
    });
  });

  test('the tick itself starts runs as scheduled', () => {
    withRun(({ sched, ws }) => {
      // The tick reads the roster through discovery and decides due-ness from
      // the clock; the routine above is due at 07:00 and the clock says 09:20.
      const t = { mock: require('node:test').mock };
      t.mock.timers.enable({ apis: ['setInterval'] });
      try {
        sched.startScheduler();
        t.mock.timers.tick(60_000);
      } finally {
        sched.stopScheduler();
        t.mock.timers.reset();
      }
      const records = recordsOn(ws);
      assert.strictEqual(records.length, 1, 'the tick started the due routine');
      assert.strictEqual(records[0].trigger, 'scheduled');
    });
  });
});
