'use strict';
// Run a routine now, and ask for consent only when what it runs has changed.
// A pressed run is watched, so it moves nothing the scheduler decides with,
// and its record says it was pressed. Dates are local components and the
// zone is set before the first require, as routines-next-run.test.js does.
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
const NOW = new Date(2026, 7, 20, 9, 20);
const TODAYS_SLOT = new Date(2026, 7, 20, 7, 0);
const TOMORROWS_SLOT = new Date(2026, 7, 21, 7, 0);
// The routine as the editor writes it: born approved, switched on, runnable.
function approvedRoutine(extra = {}) {
  const base = { name: ROUTINE, schedule: SCHEDULE, prompt: 'go', runOn: 'local', enabled: true, ...extra };
  return { ...base, planApprovedHash: computePlanHash(base) };
}
// A private scheduler, required after the fakes are in place (it destructures
// its runtime and signal writer at require time).
function freshScheduler() {
  const cached = require.cache[SCHEDULER_KEY];
  delete require.cache[SCHEDULER_KEY];
  const mod = require(SCHEDULER_KEY);
  delete require.cache[SCHEDULER_KEY];
  if (cached) require.cache[SCHEDULER_KEY] = cached;
  return mod;
}
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
      assert.strictEqual(ran[0].fields.d.status, 'completed', 'a pressed run ends in the vocabulary a tick\'s run records');
    });
    withRun(({ sched, agent, routine, children, events }) => {
      sched.executeRoutine(agent, routine, KEY, NOW, 'scheduled');
      children[0].emit('close', 0);
      assert.strictEqual(events.filter(e => e.name === 'routine_run')[0].fields.d.trigger, 'scheduled');
    });
  });
});

// ---------------------------------------------------------------------------
// The run message, through the real dispatch, into the single-flight entry
// ---------------------------------------------------------------------------
function tick(sched) {
  const { mock } = require('node:test');
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    sched.startScheduler();
    mock.timers.tick(60_000);
  } finally {
    sched.stopScheduler();
    mock.timers.reset();
  }
}
// The real handler table, its run entry pointed at this test's private
// scheduler: the module is the seam that makes the shipped road drivable.
function withDispatch(fn, opts = {}) {
  return withRun((run) => {
    const shared = require(SCHEDULER_KEY);
    const real = shared.runRoutineNow;
    shared.runRoutineNow = run.sched.runRoutineNow;
    const { buildDispatch } = require('../../lib/protocol/handlers/index.js');
    const sent = [];
    const ws = { send: (m) => sent.push(JSON.parse(m)), readyState: 1 };
    const ctx = { agents: { invalidateAgentCache: () => invalidateAgentCache() } };
    const press = (extra = {}) => buildDispatch().run_routine_now(ctx, ws,
      { type: 'run_routine_now', agentId: AGENT, name: ROUTINE, occurrence: 0, ...extra });
    try {
      return fn({ ...run, sent, press });
    } finally {
      shared.runRoutineNow = real;
    }
  }, opts);
}

const started = (sent) => sent.filter(m => m.type === 'routine_run_started');
const refused = (sent) => sent.filter(m => m.type === 'routine_action_error');

describe('the run message, driven through the real dispatch', () => {
  test('two presses during one run start one run, and the second is answered on the row\'s road', () => {
    withDispatch(({ press, sent, children, ws }) => {
      press();
      assert.strictEqual(children.length, 1, 'the first press starts a run');
      assert.strictEqual(started(sent).length, 1, 'and is answered as started');
      assert.strictEqual(started(sent)[0].agentId, AGENT);
      assert.strictEqual(started(sent)[0].name, ROUTINE);
      assert.ok(started(sent)[0].runId, 'naming the run it started');
      assert.strictEqual(recordsOn(ws)[0].trigger, 'manual');
      press();
      assert.strictEqual(children.length, 1, 'a second press during the run starts nothing');
      assert.strictEqual(refused(sent).length, 1, 'and is refused');
      assert.strictEqual(refused(sent)[0].reason, 'running', 'naming the reason');
      assert.strictEqual(refused(sent)[0].name, ROUTINE, 'on the row it was pressed on');
      assert.match(refused(sent)[0].message, /already running/);
      children[0].emit('close', 0);
      press();
      assert.strictEqual(children.length, 2, 'once the run has ended a press starts another');
    });
  });
  test('a run target this release cannot run is refused, naming the target', () => {
    withDispatch(({ press, sent, children }) => {
      press();
      assert.strictEqual(children.length, 0);
      assert.strictEqual(refused(sent)[0].reason, 'runOn');
    }, { routine: approvedRoutine({ runOn: 'agent-computer' }) });
  });
  test('a routine with nothing to send is refused, naming the prompt', () => {
    withDispatch(({ press, sent, children }) => {
      press();
      assert.strictEqual(children.length, 0);
      assert.strictEqual(refused(sent)[0].reason, 'prompt');
    }, { routine: { name: ROUTINE, schedule: SCHEDULE, runOn: 'local', enabled: true } });
  });
  test('a paused routine runs when pressed: a press is not the tick', () => {
    withDispatch(({ press, sent, children }) => {
      press();
      assert.strictEqual(children.length, 1, 'paused holds the tick and nothing else');
      assert.strictEqual(refused(sent).length, 0);
    }, { routine: approvedRoutine({ paused: true }) });
  });
  test('a routine nobody has turned on runs when pressed', () => {
    withDispatch(({ press, sent, children }) => {
      press();
      assert.strictEqual(children.length, 1, 'the switch is consent to run unattended, and this run is attended');
      assert.strictEqual(refused(sent).length, 0);
    }, { routine: approvedRoutine({ enabled: false }) });
  });
  test('a routine whose plan awaits approval runs when pressed', () => {
    withDispatch(({ press, sent, children, routine }) => {
      assert.strictEqual(require(SCHEDULER_KEY).routineRefusal(routine), 'approval', 'sanity: the tick would refuse it');
      press();
      assert.strictEqual(children.length, 1, 'approval is consent to run unattended, and running it is how somebody decides whether to give it');
      assert.strictEqual(refused(sent).length, 0);
    }, { routine: { name: ROUTINE, schedule: SCHEDULE, prompt: 'go', runOn: 'local', enabled: true, planApprovedHash: 'pending' } });
  });
  test('the reasons a press can be refused for are exactly the three that leave nothing to run', () => {
    const sched = require(SCHEDULER_KEY);
    assert.deepStrictEqual(sched.MANUAL_RUN_REFUSALS.slice().sort(), ['prompt', 'runOn', 'running']);
    const ok = approvedRoutine();
    assert.strictEqual(sched.manualRunRefusal(ok, 'nobody:nothing'), null);
    assert.strictEqual(sched.manualRunRefusal({ ...ok, paused: true }, 'nobody:nothing'), null);
    assert.strictEqual(sched.manualRunRefusal({ ...ok, enabled: false }, 'nobody:nothing'), null);
    assert.strictEqual(sched.manualRunRefusal({ ...ok, planApprovedHash: undefined }, 'nobody:nothing'), null);
    assert.strictEqual(sched.manualRunRefusal({ ...ok, runOn: 'agent-computer' }, 'nobody:nothing'), 'runOn');
    assert.strictEqual(sched.manualRunRefusal({ ...ok, prompt: '' }, 'nobody:nothing'), 'prompt');
  });
  test('a routine the roster does not carry is refused rather than invented', () => {
    withDispatch(({ press, sent, children }) => {
      press({ name: 'never-written' });
      press({ agentId: 'nobody' });
      press({ occurrence: undefined });
      assert.strictEqual(children.length, 0);
      assert.strictEqual(refused(sent).length, 3, 'every request that cannot be met is answered');
      assert.match(refused(sent)[0].message, /could not be found/);
      assert.match(refused(sent)[1].message, /not found/);
      assert.match(refused(sent)[2].message, /Which routine/);
    });
  });
  test('a press on the second of two namesakes runs that one', () => {
    withDispatch(({ press, children }) => {
      press({ occurrence: 1 });
      assert.strictEqual(children.length, 1);
      assert.ok(children[0].args.some(a => typeof a === 'string' && a.includes('second body')), 'the run carries the namesake the press pointed at');
    }, { routines: [approvedRoutine({ prompt: 'first body' }), approvedRoutine({ prompt: 'second body' })] });
  });
});

// ---------------------------------------------------------------------------
// A manual run moves no schedule
// ---------------------------------------------------------------------------

describe('a manual run leaves the scheduler\'s own facts exactly as they were', () => {
  const EARLY = new Date(2026, 7, 20, 6, 30);
  const YESTERDAY_RUN = new Date(2026, 7, 19, 7, 0, 12);
  test('routineState, its file, the slot records and the next-run instant are unchanged, and the slot then fires on the tick', () => {
    withRun(({ sched, ws, agent, routine, children, clock }) => {
      sched.recordRoutineRun(KEY, { lastRun: YESTERDAY_RUN.toISOString(), status: 'completed', duration: 3 });
      const stateBefore = JSON.stringify(sched.routineState[KEY]);
      const fileBefore = readIfThere(stateFile(ws));
      const slotsBefore = JSON.stringify(sched.routineSlots);
      const slotsFileBefore = readIfThere(slotsFile(ws));
      const nextBefore = sched.nextRunFor(KEY, SCHEDULE);
      assert.deepStrictEqual(nextBefore, TODAYS_SLOT, 'sanity: the next run is today\'s slot');
      const answer = sched.runRoutineNow(agent, routine, KEY);
      assert.strictEqual(answer.started, true);
      assert.strictEqual(JSON.stringify(sched.routineState[KEY]), stateBefore, 'a run in flight that somebody pressed is not written into the state the tick decides with');
      children[0].emit('close', 0);
      assert.strictEqual(JSON.stringify(sched.routineState[KEY]), stateBefore, 'nor is its ending');
      assert.strictEqual(readIfThere(stateFile(ws)), fileBefore, 'the persisted file is byte-for-byte what it was');
      assert.strictEqual(JSON.stringify(sched.routineSlots), slotsBefore, 'the slot records are untouched');
      assert.strictEqual(readIfThere(slotsFile(ws)), slotsFileBefore);
      assert.deepStrictEqual(sched.nextRunFor(KEY, SCHEDULE), nextBefore, 'so the routine fires next at exactly the instant it would have');
      assert.strictEqual(recordsOn(ws).length, 1, 'the run itself is on record');
      assert.strictEqual(recordsOn(ws)[0].trigger, 'manual');
      clock.at = new Date(2026, 7, 20, 7, 1);
      tick(sched);
      assert.strictEqual(children.length, 2, 'the slot the manual run did not serve fires when it comes');
      children[1].emit('close', 0);
      const records = recordsOn(ws).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      assert.deepStrictEqual(records.map(r => r.trigger), ['manual', 'scheduled']);
      assert.strictEqual(sched.routineState[KEY].status, 'completed');
      assert.notStrictEqual(sched.routineState[KEY].lastRun, YESTERDAY_RUN.toISOString(), 'and the scheduled run is the one that moves lastRun');
    }, { now: EARLY });
  });
  test('a manual run that fails, or is stopped, still writes nothing into the state', () => {
    withRun(({ sched, ws, agent, routine, children }) => {
      const fileBefore = readIfThere(stateFile(ws));
      assert.strictEqual(sched.runRoutineNow(agent, routine, KEY).started, true);
      children[0].emit('close', 1);
      assert.strictEqual(sched.routineState[KEY], undefined, 'a failed press leaves no state slot behind');
      assert.strictEqual(readIfThere(stateFile(ws)), fileBefore);
      assert.strictEqual(recordsOn(ws)[0].status, 'failed', 'the record still says what happened');
      assert.strictEqual(recordsOn(ws)[0].trigger, 'manual');
    });
  });
});

// ---------------------------------------------------------------------------
// The row's verdicts are computed from scheduled runs only
// ---------------------------------------------------------------------------

describe('the row\'s on-time, caught-up and missed verdicts ignore a manual run', () => {
  const model = require('../../public/routines-model.js');
  const ZONE = 'Europe/London';
  function statusLine(sched) {
    const facts = sched.routineDisplayFacts(KEY, SCHEDULE);
    const state = sched.routineState[KEY] || null;
    const row = model.row({
      name: ROUTINE, schedule: SCHEDULE, agentName: 'Piper', runOn: 'local', enabled: true, paused: false,
      lastStart: facts.lastStart, lastSlot: facts.lastSlot, missedSlot: facts.missedSlot, nextRun: facts.nextRun,
      scheduleReadable: facts.scheduleReadable, lastRunStatus: state ? state.status : null, refusal: null,
      prompt: 'go', now: NOW, zone: ZONE,
    });
    return { facts, status: row.status, nextRun: row.nextRun };
  }
  const HISTORIES = {
    'on time': { state: { lastRun: new Date(2026, 7, 20, 7, 0, 15).toISOString(), status: 'completed', duration: 3 } }, 'caught up': { state: { lastRun: new Date(2026, 7, 20, 9, 14, 3).toISOString(), status: 'completed', duration: 3 } },
    missed: {
      state: { lastRun: new Date(2026, 7, 18, 7, 0, 3).toISOString(), status: 'completed', duration: 3 },
      slots: { due: TODAYS_SLOT.toISOString(), schedule: 'daily:7:0', missed: [{ slot: new Date(2026, 7, 19, 7, 0).toISOString() }] },
    },
  };
  for (const [verdict, history] of Object.entries(HISTORIES)) {
    test(`a manual run leaves the ${verdict} line exactly as it was, during and after`, () => {
      withRun(({ sched, agent, routine, children }) => {
        sched.recordRoutineRun(KEY, history.state);
        if (history.slots) sched.routineSlots.routines[KEY] = history.slots;
        const before = statusLine(sched);
        assert.ok(before.status, `sanity: the ${verdict} history renders a status line`);
        assert.ok(before.status.text.toLowerCase().includes(verdict.split(' ')[0]), `sanity: it reads as ${verdict}`);
        assert.strictEqual(sched.runRoutineNow(agent, routine, KEY).started, true);
        assert.deepStrictEqual(statusLine(sched), before, 'while the pressed run is going');
        children[0].emit('close', 0);
        assert.deepStrictEqual(statusLine(sched), before, 'and after it has ended');
      });
    });
  }
  test('a failed manual run does not turn the row red', () => {
    withRun(({ sched, agent, routine, children }) => {
      sched.recordRoutineRun(KEY, HISTORIES['on time'].state);
      const before = statusLine(sched);
      assert.strictEqual(sched.runRoutineNow(agent, routine, KEY).started, true);
      children[0].emit('close', 1);
      assert.deepStrictEqual(statusLine(sched), before, 'a test run that failed is on its own record, not on the row\'s verdict about the schedule');
    });
  });
});

// ---------------------------------------------------------------------------
// Consent is change-consent
// ---------------------------------------------------------------------------

describe('approval is consent to a changed plan, and nothing else asks for it', () => {
  const routines = require('../../lib/agents/routines.js');
  const { PLAN_FIELDS, planApproved } = routines;
  const approve = (routine) => ({ ...routine, planApprovedHash: computePlanHash(routine) });
  test('each plan field lapses approval when it changes, and each other field keeps it, walked from the hash inputs', () => {
    const base = approve({ name: ROUTINE, schedule: SCHEDULE, prompt: 'go', skill: 'ops', runOn: 'local', enabled: true, paused: false, timezone: 'Europe/London' });
    assert.strictEqual(planApproved(base), true, 'sanity');
    assert.deepStrictEqual(PLAN_FIELDS.slice().sort(), ['prompt', 'runOn', 'skill'], 'what a routine RUNS is its prompt, its skill and where it runs: nothing else is the plan');
    for (const field of PLAN_FIELDS) {
      assert.strictEqual(planApproved({ ...base, [field]: `changed-${field}` }), false, `a change to "${field}" changes what this runs, so consent lapses`);
    }
    for (const [field, value] of Object.entries({ schedule: 'every weekday at 09:30', timezone: 'Australia/Sydney', paused: true, enabled: false })) {
      assert.ok(!PLAN_FIELDS.includes(field), `sanity: "${field}" is not a plan field`);
      assert.strictEqual(planApproved({ ...base, [field]: value }), true, `a change to "${field}" changes when or whether, not what, so consent stands`);
    }
  });
  test('editing the skill\'s own body keeps approval, on the roster the tick reads', () => {
    withRun(({ ws }) => {
      const { discoverAgents } = require('../../lib/agents/discovery.js');
      const skillDir = path.join(ws, '.claude', 'skills', 'ops');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: ops\ndescription: the ops summary\n---\nCompile the summary.\n');
      invalidateAgentCache();
      const before = discoverAgents().find(a => a.id === AGENT).routines[0];
      assert.strictEqual(before.refusal, null, 'sanity: approved and runnable');
      const hashBefore = computePlanHash(before);
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: ops\ndescription: the ops summary\n---\nCompile the summary, and file it.\n');
      invalidateAgentCache();
      const after = discoverAgents().find(a => a.id === AGENT).routines[0];
      assert.strictEqual(computePlanHash(after), hashBefore, 'the hash reads the routine, never the skill\'s file');
      assert.strictEqual(after.refusal, null, 'so a skill edited in place keeps the routine scheduled');
    }, { routine: approvedRoutine({ skill: 'ops' }) });
  });
  test('a routine written through the editor\'s save road is approved from birth, on the roster the tick reads', () => {
    withRun(({ ws }) => {
      const { discoverAgents } = require('../../lib/agents/discovery.js');
      const { buildDispatch } = require('../../lib/protocol/handlers/index.js');
      const sent = [];
      const ctx = {
        agents: { invalidateAgentCache: () => invalidateAgentCache(), discoverSkills: () => [], flagRosterRefresh: () => {} },
        workspace: { isInsideWorkspace: (p) => p.startsWith(ws) },
      };
      buildDispatch().save_routine(ctx, { send: (m) => sent.push(JSON.parse(m)), readyState: 1 }, {
        type: 'save_routine', agentId: AGENT,
        routine: { name: 'fresh', schedule: 'every day at 08:00', skill: 'ops', prompt: 'Use the ops skill.', runOn: 'local' },
      });
      assert.ok(sent.some(m => m.type === 'routine_saved'), 'the save landed');
      invalidateAgentCache();
      const fresh = discoverAgents().find(a => a.id === AGENT).routines.find(r => r.name === 'fresh');
      assert.ok(fresh, 'the routine is on the roster');
      assert.strictEqual(planApproved(fresh), true, 'making it is the consent');
      assert.strictEqual(fresh.refusal, null, 'and the tick would run it with nothing else asked');
    });
  });
});

// ---------------------------------------------------------------------------
// The roster carries in-flight beside refusal
// ---------------------------------------------------------------------------

describe('the roster carries whether a run is in flight, stamped beside the refusal', () => {
  const shared = require(SCHEDULER_KEY);
  function rosterRoutine() {
    const { discoverAgents } = require('../../lib/agents/discovery.js');
    invalidateAgentCache();
    return discoverAgents().find(a => a.id === AGENT).routines.find(r => r.name === ROUTINE);
  }
  test('the in-flight fact is read from the scheduler\'s live runs, keyed the way the single-flight hold is', () => {
    withRun(() => {
      const real = shared.runningRuns;
      try {
        shared.runningRuns = () => [];
        let r = rosterRoutine();
        assert.strictEqual(r.running, null, 'nothing going: the fact is null, not absent');
        assert.strictEqual(r.refusal, null, 'and the refusal is stamped beside it');
        shared.runningRuns = () => [{ id: 'x', key: KEY, agent: AGENT, routine: ROUTINE, startedAt: NOW.toISOString(), trigger: 'manual' }];
        r = rosterRoutine();
        assert.deepStrictEqual(r.running, { trigger: 'manual', startedAt: NOW.toISOString() }, 'a pressed run in flight reaches the roster with the word that says it was pressed');
        shared.runningRuns = () => [{ id: 'y', key: KEY, agent: AGENT, routine: ROUTINE, startedAt: NOW.toISOString(), trigger: 'scheduled' }];
        assert.strictEqual(rosterRoutine().running.trigger, 'scheduled');
        shared.runningRuns = () => [{ id: 'z', key: 'someone:else', agent: 'someone', routine: 'else', startedAt: NOW.toISOString(), trigger: 'manual' }];
        assert.strictEqual(rosterRoutine().running, null, 'another routine\'s run is not this row\'s');
      } finally {
        shared.runningRuns = real;
      }
    });
  });
  test('on the live path, a pressed run puts the fact on the roster and its ending takes it off', () => {
    withRun(({ sched, agent, routine, children }) => {
      const real = shared.runningRuns;
      shared.runningRuns = sched.runningRuns;
      try {
        const idle = rosterRoutine();
        assert.strictEqual(idle.running, null);
        assert.strictEqual(sched.runRoutineNow(agent, routine, KEY).started, true);
        const going = rosterRoutine();
        assert.strictEqual(going.running.trigger, 'manual');
        assert.deepStrictEqual(going.state, idle.state, 'while the state slot is exactly what it was: a pressed run writes nothing there');
        children[0].emit('close', 0);
        assert.strictEqual(rosterRoutine().running, null);
      } finally {
        shared.runningRuns = real;
      }
    });
  });
});

// ---------------------------------------------------------------------------
// The row: Run first, paused-ness as a state, two paused states told apart
// ---------------------------------------------------------------------------

describe('the row', () => {
  const { JSDOM } = require('jsdom');
  const ROOT = path.join(__dirname, '..', '..');
  const readSrc = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf-8');
  const ZONE = 'Europe/London';
  const iso = (d) => d.toISOString();
  const PLAY = '6 3 20 12 6 21 6 3';
  function rowFacts(name, facts) {
    return {
      name, schedule: SCHEDULE, prompt: 'p', runOn: 'local', enabled: true, paused: false,
      state: null, nextRun: null, lastStart: null, lastSlot: null, missedSlot: null,
      scheduleReadable: true, refusal: null, running: null, ...facts,
    };
  }
  function shell(routines) {
    const dom = new JSDOM('<!doctype html><html><head><style>' + readSrc('public', 'styles', 'views', 'routines.css')
      + '</style></head><body><nav class="nav-rail"><button class="nav-item" data-nav="routines"></button></nav>'
      + '<div id="view-routines"><div id="routines-content"></div></div></body></html>', { runScripts: 'dangerously' });
    const w = dom.window;
    w.eval(readSrc('public', 'routine-editor-model.js'));
    w.eval(readSrc('public', 'skills-model.js'));
    w.eval(readSrc('public', 'routines-model.js'));
    w.eval(readSrc('public', 'views', 'routines.js'));
    w.agents = [{ id: AGENT, name: AGENT, displayName: 'Piper', type: 'specialist', colour: '#E87A5A', icon: 'P', routines }];
    w.skills = [];
    w.skillsLoaded = true;
    w.esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    w.sent = [];
    w.ws = { send: (m) => w.sent.push(JSON.parse(m)) };
    w.routinesNow = () => NOW;
    w.Intl = { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: ZONE }) }) };
    w.renderRoutines();
    return { w, doc: w.document, dom };
  }
  const rows = (doc) => [...doc.querySelectorAll('.routine-row')];
  const text = (el) => el.textContent.replace(/\s+/g, ' ').trim();
  const rowNamed = (doc, name) => {
    const found = rows(doc).filter(r => text(r.querySelector('.rr-sentence')).includes(name));
    assert.strictEqual(found.length, 1, `expected one row for "${name}"`);
    return found[0];
  };
  const playGlyphs = (el) => [...el.querySelectorAll('svg polygon')].filter(p => p.getAttribute('points') === PLAY);
  const STATES = [
    rowFacts('Idle', { state: { status: 'completed', duration: 3 }, lastStart: iso(new Date(2026, 7, 20, 7, 0, 12)), lastSlot: iso(TODAYS_SLOT), nextRun: iso(TOMORROWS_SLOT) }),
    rowFacts('Paused by hand', { paused: true, refusal: 'paused', nextRun: iso(TOMORROWS_SLOT) }),
    rowFacts('Plan changed', { refusal: 'approval', nextRun: iso(TOMORROWS_SLOT) }),
    rowFacts('Not enabled', { enabled: false, refusal: 'enabled', nextRun: iso(TOMORROWS_SLOT) }),
    rowFacts('Never run', { nextRun: iso(TOMORROWS_SLOT) }),
    rowFacts('In flight', { state: { status: 'completed', duration: 3 }, lastStart: iso(TODAYS_SLOT), lastSlot: iso(TODAYS_SLOT), nextRun: iso(TOMORROWS_SLOT), running: { trigger: 'manual', startedAt: iso(NOW) } }),
    rowFacts('Tick in flight', { state: { status: 'running' }, lastStart: iso(TODAYS_SLOT), nextRun: iso(TOMORROWS_SLOT), running: { trigger: 'scheduled', startedAt: iso(NOW) } }),
  ];
  test('every row carries Run first in its action group, with the play glyph, disabled exactly while a run is in flight', () => {
    const { doc, dom } = shell(STATES);
    assert.strictEqual(rows(doc).length, STATES.length);
    for (const facts of STATES) {
      const row = rowNamed(doc, facts.name);
      const actions = row.querySelector('.rr-actions');
      assert.ok(actions, `${facts.name}: the row has an action group`);
      const first = actions.firstElementChild;
      assert.strictEqual(first.getAttribute('data-routines-action'), 'run', `${facts.name}: Run is first in the group`);
      assert.strictEqual(playGlyphs(first).length, 1, `${facts.name}: Run bears the play glyph`);
      assert.strictEqual(first.hasAttribute('disabled'), !!facts.running, `${facts.name}: Run is disabled exactly while a run of this routine is in flight`);
      assert.strictEqual(first.getAttribute('title'), facts.running ? 'Run in progress' : 'Run now');
      const order = [...actions.children].map(el => el.getAttribute('data-routines-action'));
      assert.deepStrictEqual(order.slice(-2), ['edit', 'delete'], `${facts.name}: Edit schedule and Delete keep their places after Run`);
    }
    dom.window.close();
  });
  test('pressing Run sends one message naming the routine, and a refusal is drawn on the row\'s road', () => {
    const { doc, w, dom } = shell([STATES[0], rowFacts('Idle', { nextRun: iso(TOMORROWS_SLOT) })]);
    rows(doc)[1].querySelector('[data-routines-action="run"]').click();
    assert.deepStrictEqual(w.sent, [{ type: 'run_routine_now', agentId: AGENT, name: 'Idle', occurrence: 1 }], 'the press names the namesake it was pressed on and asks for nothing else');
    w.routinesActionFailed({ type: 'routine_action_error', agentId: AGENT, name: 'Idle', message: 'Routine "Idle" is already running.', reason: 'running' });
    const problem = doc.querySelector('[data-routines-problem]');
    assert.ok(problem, 'the refusal is drawn on the list the control was pressed on');
    assert.match(text(problem), /already running/);
    dom.window.close();
  });
  test('the play glyph appears once per row and only on Run, and paused-ness is one switch bound to set_routine_paused', () => {
    const { doc, w, dom } = shell(STATES);
    for (const facts of STATES) {
      const row = rowNamed(doc, facts.name);
      const glyphs = playGlyphs(row);
      assert.strictEqual(glyphs.length, 1, `${facts.name}: one play glyph on the row`);
      assert.strictEqual(glyphs[0].closest('button').getAttribute('data-routines-action'), 'run', `${facts.name}: and it is Run's`);
      const switches = row.querySelectorAll('[role="switch"]');
      if (facts.refusal === 'approval') {
        assert.strictEqual(switches.length, 0, `${facts.name}: a consent-paused row has one action, and it is not the switch`);
        continue;
      }
      assert.strictEqual(switches.length, 1, `${facts.name}: one state control for paused-ness`);
      assert.strictEqual(switches[0].getAttribute('aria-checked'), String(!!facts.paused), `${facts.name}: the switch shows the state`);
      assert.strictEqual(playGlyphs(switches[0]).length, 0, `${facts.name}: the switch never wears the play glyph`);
      w.sent.length = 0;
      switches[0].click();
      assert.deepStrictEqual(w.sent, [{ type: 'set_routine_paused', agentId: AGENT, name: facts.name, occurrence: 0, paused: !facts.paused }], `${facts.name}: pressing the switch flips paused through the one message`);
    }
    dom.window.close();
  });
  test('a self-applied pause and a withdrawn consent render as two paused rows with different sentences and different actions', () => {
    const { doc, w, dom } = shell([STATES[1], STATES[2]]);
    const self = rowNamed(doc, 'Paused by hand');
    const consent = rowNamed(doc, 'Plan changed');
    const selfLabel = self.querySelector('.rr-paused-label');
    assert.ok(selfLabel, 'the self-paused row carries the paused label');
    assert.strictEqual(text(selfLabel), 'Paused', 'a sentence that names no change');
    assert.ok(self.classList.contains('paused') && !self.classList.contains('paused-consent'));
    assert.strictEqual(self.querySelector('.rr-consent-line'), null);
    const consentText = consent.querySelector('.rr-consent-text');
    assert.ok(consentText, 'the consent-paused row carries the consent sentence');
    assert.match(text(consentText), /^Paused: what this runs has changed/, 'a sentence that names the change');
    assert.ok(consent.classList.contains('paused-consent') && !consent.classList.contains('paused'));
    assert.strictEqual(consent.querySelector('.rr-paused-label'), null);
    assert.strictEqual(consent.querySelector('.next-run'), null, 'and no next run is promised on it');
    assert.notStrictEqual(text(selfLabel), text(consentText), 'the two sentences differ');
    const selfAction = self.querySelector('[data-routines-action="resume"]');
    const consentAction = consent.querySelector('[data-routines-action="approve"]');
    assert.ok(selfAction && consentAction);
    assert.strictEqual(text(selfAction), 'Resume');
    assert.strictEqual(text(consentAction), 'Review and resume');
    assert.strictEqual(self.querySelector('[data-routines-action="approve"]'), null, 'the self-paused row offers no approval');
    assert.strictEqual(consent.querySelector('[data-routines-action="resume"], [data-routines-action="pause"]'), null, 'the consent-paused row offers no pause switch');
    selfAction.click();
    consentAction.click();
    assert.deepStrictEqual(w.sent.map(m => m.type), ['set_routine_paused', 'approve_routine_plan'], 'the bound actions differ');
    assert.strictEqual(w.sent[0].paused, false);
    const colour = (el) => w.getComputedStyle(el).color;
    assert.strictEqual(colour(selfLabel), 'var(--text-3)');
    assert.strictEqual(colour(consentText), 'var(--attention)');
    dom.window.close();
  });
  test('a pressed run in flight says so in its own words, and Run reads the roster\'s fact rather than the state slot', () => {
    const { doc, dom } = shell([
      STATES[5], STATES[6],
      rowFacts('Stale roster', { state: { status: 'running' }, lastStart: iso(TODAYS_SLOT), running: undefined }),
    ]);
    const manual = rowNamed(doc, 'In flight');
    assert.strictEqual(text(manual.querySelector('.run-status.live')), 'Running now (started manually)');
    assert.ok(manual.querySelector('.rr-view-run'), 'and offers the way into the run');
    assert.strictEqual(manual.querySelectorAll('.rr-run-line').length, 1, 'the verdict line yields to the live one');
    assert.ok(manual.querySelector('[data-routines-action="run"]').hasAttribute('disabled'));
    const tick = rowNamed(doc, 'Tick in flight');
    assert.strictEqual(text(tick.querySelector('.run-status.live')), 'Still going');
    assert.ok(tick.querySelector('[data-routines-action="run"]').hasAttribute('disabled'));
    const stale = rowNamed(doc, 'Stale roster');
    assert.strictEqual(text(stale.querySelector('.run-status.live')), 'Still going');
    assert.ok(!stale.querySelector('[data-routines-action="run"]').hasAttribute('disabled'));
    dom.window.close();
  });
  test('the delete confirmation draws the row with no Run, no switch and no consent action', () => {
    const { doc, dom } = shell([STATES[1]]);
    doc.querySelector('[data-routines-action="delete"]').click();
    const row = doc.querySelector('.routine-row');
    assert.ok(row, 'the confirmation shows the row it asks about');
    assert.strictEqual(row.querySelector('.rr-actions'), null);
    assert.strictEqual(row.querySelector('[role="switch"]'), null);
    assert.strictEqual(row.querySelector('[data-routines-action="run"]'), null);
    assert.strictEqual(text(row.querySelector('.rr-paused-label')), 'Paused', 'the state is still said');
    dom.window.close();
  });
});
