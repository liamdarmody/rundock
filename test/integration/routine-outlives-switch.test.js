'use strict';
// A routine run in flight outlives a workspace switch, and its ending lands in
// the workspace it started in.
//
// THE FAULT. The open path stops every conversation child, points the server
// at the new folder, reloads the routine state and then runs the orphan
// cleanup over the pid file of the workspace being opened. A routine's child
// is registered in that file like any other, so re-selecting the workspace a
// run started in, or going away and coming back, signalled the run as an
// orphan of a previous session and recorded it as failed with no reason. A
// switch to another workspace left it running, and its ending then stamped the
// other workspace's routine state, so that workspace's routine of the same
// name was skipped for the day.
//
// HOW IT IS DRIVEN. Nothing in the server is stubbed. The switch is the
// message the window sends, over the socket, through the real open path with
// the real killAllChildren and cleanOrphanedProcesses. The child is the stub
// claude, held open until the test writes its release file, so the test
// decides when a run ends rather than racing a delay, and the outcome each run
// records is the one its child gave.
//
// THE PROCESS TABLE. Whether the cleanup can read a command line decides which
// side of its recycled-pid guard a record meets: assumed ours where nothing
// can be read (a command sandbox that blocks `ps`), matched on the command
// where /proc or `ps` answers. The fix decides before either side is reached,
// so every test here must pass on both. Each test names the side this machine
// gave it, so a run's record says which one it proved.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const h = require('../helpers/harness.js');
const { agentFile, makeWorkspace } = require('../helpers/workspace.js');
const scheduler = require('../../lib/scheduler.js');
const { commandLineCapability } = require('../../lib/runtime/claude.js');

const AGENT = 'keeper';
const ROUTINE = 'keep-check';
const KEY = `${AGENT}:${ROUTINE}`;
const SCHEDULE = 'every day at 09:00';

const table = commandLineCapability();
const SIDE = table.ok ? `process table read through ${table.source}` : 'no process table readable';

// July 2026, local components, so the schedule and the clock agree in any zone.
function dayAt(day, hour, minute) { return new Date(2026, 6, day, hour, minute, 0); }
const clock = { at: dayAt(1, 9, 30) };
let prevDeps = null;
let client;

before(async () => {
  await h.boot({ workspace: false, agents: { idle: agentFile({ name: 'idle', type: 'specialist', order: 1 }) } });
  prevDeps = scheduler.wireSchedulerDeps({ now: () => clock.at });
  client = await h.connect();
});

after(async () => {
  if (prevDeps) scheduler.wireSchedulerDeps(prevDeps);
  await h.shutdown();
});

// A workspace whose keeper runs `prompt` every day at 09:00. With `held`, its
// child holds the turn until the file named by the returned `release` exists.
function keeperWorkspace(prompt, { held = false, state = null } = {}) {
  const dir = makeWorkspace({
    claudeMd: '# Keeper fixture\n',
    agents: {
      [AGENT]: agentFile({
        name: AGENT, type: 'specialist', order: 1,
        routines: [{ name: ROUTINE, schedule: SCHEDULE, prompt, enabled: true }],
      }),
    },
  });
  const release = path.join(dir, 'release-run');
  fs.writeFileSync(path.join(dir, 'stub-scenario.json'), JSON.stringify({
    rules: [{ match: { promptIncludes: prompt }, ...(held ? { untilFile: release } : {}), turn: [{ text: 'kept' }] }],
  }));
  if (state) {
    fs.mkdirSync(path.join(dir, '.rundock'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.rundock', 'routine-state.json'), JSON.stringify(state, null, 2));
  }
  return { dir, release };
}

// Choose a folder exactly as the window does, and wait for the open to finish.
async function choose(dir) {
  const since = client.messages.length;
  client.send({ type: 'set_workspace', path: dir });
  const { msg } = await client.waitFor(m => m.type === 'workspace_set' || m.type === 'workspace_error',
    { since, label: `workspace_set for ${dir}` });
  assert.strictEqual(msg.type, 'workspace_set', `choosing ${dir} failed: ${msg.message}`);
}

// Make a new workspace exactly as the window does.
async function create(name) {
  const since = client.messages.length;
  client.send({ type: 'create_workspace', name });
  const { msg } = await client.waitFor(m => m.type === 'workspace_set' || m.type === 'workspace_error',
    { since, label: `workspace_set for a new workspace ${name}` });
  assert.strictEqual(msg.type, 'workspace_set', `creating ${name} failed: ${msg.message}`);
  return msg.path;
}

// One tick of the real scheduler on mock timers, as the other scheduler suites
// drive it: the interval the open armed is stopped first.
function tick(t) {
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

const invocationsIn = (dir) => h.readAppendedLog(path.join(dir, 'stub-invocations.jsonl'));
const promptsIn = (dir) => h.readAppendedLog(path.join(dir, 'stub-prompts.jsonl'));
const stateIn = (dir) => {
  const file = path.join(dir, '.rundock', 'routine-state.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : {};
};
function recordsIn(dir) {
  const runs = path.join(dir, '.rundock', 'runs');
  if (!fs.existsSync(runs)) return [];
  return fs.readdirSync(runs).filter(n => /^[0-9a-f-]{36}\.json$/.test(n))
    .map(n => JSON.parse(fs.readFileSync(path.join(runs, n), 'utf-8')));
}

// Start a held run in `a`, from a tick at `at`, and return its child's pid.
async function startHeldRun(t, a, at) {
  await choose(a.dir);
  clock.at = at;
  tick(t);
  await h.waitUntil(() => invocationsIn(a.dir).length > 0);
  const spawned = invocationsIn(a.dir);
  assert.strictEqual(spawned.length, 1, 'the tick started one child in the workspace the routine belongs to');
  assert.strictEqual(stateIn(a.dir)[KEY].status, 'running', 'and the run says so');
  return spawned[0].pid;
}

// Release a held run and wait for its record to close.
async function finish(a) {
  fs.writeFileSync(a.release, '');
  await h.waitUntil(() => recordsIn(a.dir).some(r => r.status !== 'running'));
  const records = recordsIn(a.dir);
  assert.strictEqual(records.length, 1, `one run, one record: ${JSON.stringify(records)}`);
  return records[0];
}

// What every switch below must leave a held run: its child alive, and its
// record still open. A signal takes a moment to land and a dead child a moment
// to be reaped, so this waits that moment first: an absence needs real time to
// show.
async function assertStillGoing(a, pid, how) {
  await h.delay(300);
  assert.deepStrictEqual(recordsIn(a.dir).map(r => r.status), ['running'],
    `${how}: the switch ended the run, which a switch must never do`);
  assert.ok(h.pidAlive(pid), `${how}: the switch signalled the run's child, which is no longer alive`);
}

// The ending: the outcome its child gave.
function assertEndedAsItsChildSaid(a, record, how) {
  assert.strictEqual(record.status, 'succeeded', `${how}: the run ended as its child said, not as a switch made it`);
}

// Re-selecting the open workspace: the open path treats it as a switch.
test(`re-selecting the workspace a run started in sends its child nothing (${SIDE})`, async (t) => {
  const a = keeperWorkspace('same workspace body', { held: true });
  const pid = await startHeldRun(t, a, dayAt(1, 9, 30));

  await choose(a.dir);
  await assertStillGoing(a, pid, 'after re-selecting it');

  assertEndedAsItsChildSaid(a, await finish(a), 'after re-selecting it');
});

// The undo: away and straight back while the run goes on. The
// cleanup on reopening A sends the child nothing, the row says running, and
// the ending lands in A.
test(`going away and coming back while a run goes on sends its child nothing (${SIDE})`, async (t) => {
  const a = keeperWorkspace('away and back body', { held: true });
  const b = keeperWorkspace('the other workspace body');
  const pid = await startHeldRun(t, a, dayAt(2, 9, 30));

  await choose(b.dir);
  await assertStillGoing(a, pid, 'after switching away');
  await choose(a.dir);
  await assertStillGoing(a, pid, 'after coming back');
  assert.strictEqual(h.internal.routineState[KEY].status, 'running',
    'and the row reloaded on coming back says running, not interrupted');

  assertEndedAsItsChildSaid(a, await finish(a), 'after coming back');
  assert.strictEqual(h.internal.routineState[KEY].status, 'completed', 'the ending landed in the open row');
});

// A switch to another workspace.
test(`switching to another workspace sends a run's child nothing (${SIDE})`, async (t) => {
  const a = keeperWorkspace('other workspace body', { held: true });
  const b = keeperWorkspace('somewhere else body');
  const pid = await startHeldRun(t, a, dayAt(3, 9, 30));

  await choose(b.dir);
  await assertStillGoing(a, pid, 'after switching to another workspace');

  assertEndedAsItsChildSaid(a, await finish(a), 'after switching to another workspace');
});

// A switch to a workspace made there and then.
test(`making a new workspace sends a run's child nothing (${SIDE})`, async (t) => {
  const a = keeperWorkspace('new workspace body', { held: true });
  const pid = await startHeldRun(t, a, dayAt(4, 9, 30));

  await create(`Carried Over ${process.pid}`);
  await assertStillGoing(a, pid, 'after making a new workspace');

  assertEndedAsItsChildSaid(a, await finish(a), 'after making a new workspace');
});

// MOVED HERE FROM test/unit/scheduler-lib.test.js, where it drove the real
// switch handler with killAllChildren and cleanOrphanedProcesses stubbed as
// no-ops. Those two are what killed the run, so a test that stubbed them could
// not see it. Every assertion it made is kept, now through the real open path
// with a real child.
//
// The decision it pins: the in-flight hold is not reset by a switch, unlike
// the two states beside it that are. Those describe the workspace being left.
// A run in flight is a child process that is still running, and clearing its
// key would free the routine to start again while the first run was going.
test('the workspace switch does not release a run that is still going', async (t) => {
  const a = keeperWorkspace('held across the switch body', { held: true });
  await startHeldRun(t, a, dayAt(5, 9, 30));

  // WHAT PROVES THE SWITCH'S RESETS RAN, planted after the run started and
  // read after the switch. Both stores the load rebuilds are given a fact that
  // exists only on disk, for a routine with no live run to complicate it.
  const PLANTED_KEY = 'planted:by-the-file';
  const PLANTED_STAMP = '2026-07-05T07:00:00.000Z';
  const OBSERVED_AT = '2026-07-05T07:01:00.000Z';
  const rundock = path.join(a.dir, '.rundock');
  const onDisk = stateIn(a.dir);
  onDisk[PLANTED_KEY] = { lastRun: PLANTED_STAMP, status: 'completed', duration: 2 };
  fs.writeFileSync(path.join(rundock, 'routine-state.json'), JSON.stringify(onDisk));
  fs.writeFileSync(path.join(rundock, 'routine-slots.json'), JSON.stringify({ observedAt: OBSERVED_AT, routines: {} }));
  assert.strictEqual(h.internal.routineState[PLANTED_KEY], undefined,
    'and it is only on disk: nothing in memory knows about it yet');
  assert.notStrictEqual(h.internal.routineSlots.observedAt, OBSERVED_AT, 'nor about the observation beside it');

  // Re-selecting the open workspace, which the open path treats as a switch;
  // choose() asserts the switch ran its open path to the end rather than into
  // the rollback.
  await choose(a.dir);

  assert.deepStrictEqual(h.internal.routineState[PLANTED_KEY],
    { lastRun: PLANTED_STAMP, status: 'completed', duration: 2 },
    'the switch rebuilt the run state from the workspace file');
  assert.strictEqual(h.internal.routineSlots.observedAt, OBSERVED_AT,
    'and reloaded the slot records beside it');
  assert.strictEqual(h.internal.routineState[KEY].status, 'running',
    'while the run that is still going goes on saying so, which is what the switch must not change');
  const keeper = h.internal.discoverAgents().find(agent => agent.id === AGENT);
  const routine = keeper.routines.find(r => r.name === ROUTINE);
  assert.strictEqual(h.internal.executeRoutine(keeper, routine, KEY, clock.at), false,
    'and the hold survived it, because the child it describes is still running');

  await finish(a);
  assert.strictEqual(h.internal.executeRoutine(keeper, routine, KEY, clock.at), true,
    'the run ending is the only thing that releases it, switch or no switch');
  // The second run's child is released already, so it ends on its own.
  await h.waitUntil(() => recordsIn(a.dir).filter(r => r.status !== 'running').length === 2);
  assert.strictEqual(recordsIn(a.dir).filter(r => r.status !== 'running').length, 2, 'and the second run ended too');
});
