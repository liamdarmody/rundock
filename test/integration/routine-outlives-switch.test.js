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

// A workspace whose keeper runs `prompt` every day at 09:00 as keep-check, and
// any `others` beside it on the same schedule. With `held`, the keep-check
// child holds its turn until the file named by the returned `release` exists.
// `state` is written as the workspace's routine state file.
function keeperWorkspace(prompt, { held = false, state = null, others = [] } = {}) {
  const routines = [{ name: ROUTINE, prompt }, ...others];
  const dir = makeWorkspace({
    claudeMd: '# Keeper fixture\n',
    agents: {
      [AGENT]: agentFile({
        name: AGENT, type: 'specialist', order: 1,
        routines: routines.map(r => ({ name: r.name, schedule: SCHEDULE, prompt: r.prompt, enabled: true })),
      }),
    },
  });
  const release = path.join(dir, 'release-run');
  fs.writeFileSync(path.join(dir, 'stub-scenario.json'), JSON.stringify({
    rules: routines.map(r => ({
      match: { promptIncludes: r.prompt },
      ...(held && r.name === ROUTINE ? { untilFile: release } : {}),
      turn: [{ text: 'kept' }],
    })),
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

// ===== WHERE THE ENDING LANDS =====
//
// Every test below starts a run in A, switches to B, and lets the run end
// there. B holds a routine of the same key, which last ran the day before: the
// collision that let A's ending stamp B's file, so that B's routine read as
// not due that day.

const stateFile = (dir) => path.join(dir, '.rundock', 'routine-state.json');
const ranTheDayBefore = (day) => ({ lastRun: dayAt(day - 1, 9, 0).toISOString(), status: 'completed', duration: 3 });
const promptedWith = (dir, body) => promptsIn(dir).filter(p => String(p.prompt).includes(body)).length;
const closedIn = (dir) => recordsIn(dir).filter(r => r.status !== 'running').length;

test(`a run that outlives a switch records its ending in its own workspace and no other (${SIDE})`, async (t) => {
  const before = ranTheDayBefore(6);
  const a = keeperWorkspace('origin body', { held: true });
  const b = keeperWorkspace('same key elsewhere body', { state: { [KEY]: before } });
  await startHeldRun(t, a, dayAt(6, 9, 30));

  await choose(b.dir);
  const bBytes = fs.readFileSync(stateFile(b.dir));
  assert.deepStrictEqual(h.internal.routineState[KEY], before, 'the open state is B\'s own');

  clock.at = dayAt(6, 9, 40);
  assertEndedAsItsChildSaid(a, await finish(a), 'after switching to B');

  assert.ok(fs.readFileSync(stateFile(b.dir)).equals(bBytes),
    `B's state file is byte-identical before and after A's run ended:\n${fs.readFileSync(stateFile(b.dir), 'utf-8')}`);
  assert.deepStrictEqual(h.internal.routineState[KEY], before, 'and B\'s state for that key, in memory, is unchanged');
  assert.deepStrictEqual(stateIn(a.dir)[KEY], { lastRun: dayAt(6, 9, 40).toISOString(), status: 'completed', duration: 600 },
    'A\'s entry moved from running to the run\'s outcome, stamped with its ending');
});

// Carrying on in B, which is what most people do next: B's ticks run B's
// routines, and B's routine of the same key, held while A's run was going,
// runs on the first tick after that run ends. Delayed, not lost.
test(`carrying on in B: its ticks run its routines, and the one sharing the run's key runs once that run ends (${SIDE})`, async (t) => {
  const a = keeperWorkspace('origin for B ticks body', { held: true });
  const b = keeperWorkspace('B same key body', {
    state: { [KEY]: ranTheDayBefore(8), [`${AGENT}:side-check`]: ranTheDayBefore(8) },
    others: [{ name: 'side-check', prompt: 'B side body' }],
  });
  await startHeldRun(t, a, dayAt(8, 9, 30));
  await choose(b.dir);

  clock.at = dayAt(8, 9, 31);
  tick(t);
  await h.waitUntil(() => closedIn(b.dir) === 1);
  assert.strictEqual(promptedWith(b.dir, 'B side body'), 1, 'B\'s tick ran B\'s routine while A\'s run went on');
  assert.strictEqual(promptedWith(b.dir, 'B same key body'), 0,
    'and held the one sharing the key of A\'s run, which is still going');

  clock.at = dayAt(8, 9, 40);
  await finish(a);

  clock.at = dayAt(8, 9, 41);
  tick(t);
  await h.waitUntil(() => closedIn(b.dir) === 2, { timeout: 4000 });
  assert.strictEqual(promptedWith(b.dir, 'B same key body'), 1,
    'B\'s routine of the same key ran on the first tick after A\'s run ended, because nothing stamped it');
  assert.strictEqual(promptedWith(a.dir, 'origin for B ticks body'), 1, 'and nothing ran in A');
});

// The inverse: the run ends in B's time, then A is opened again. And the
// retry: A fires at its next slot as usual, because its stamp is its real
// ending.
test(`coming back after the run ended elsewhere: A reads its real outcome, B never changed, and A fires at its next slot (${SIDE})`, async (t) => {
  const a = keeperWorkspace('inverse body', { held: true });
  const b = keeperWorkspace('inverse elsewhere body', { state: { [KEY]: ranTheDayBefore(10) } });
  await startHeldRun(t, a, dayAt(10, 9, 30));
  await choose(b.dir);
  const bBytes = fs.readFileSync(stateFile(b.dir));

  clock.at = dayAt(10, 9, 40);
  await finish(a);
  await choose(a.dir);

  assert.deepStrictEqual(h.internal.routineState[KEY], { lastRun: dayAt(10, 9, 40).toISOString(), status: 'completed', duration: 600 },
    'A reads the run\'s real outcome, never interrupted');
  assert.ok(fs.readFileSync(stateFile(b.dir)).equals(bBytes), 'and B\'s state never changed');

  clock.at = dayAt(10, 10, 0);
  tick(t);
  await h.delay(300);
  assert.strictEqual(promptedWith(a.dir, 'inverse body'), 1, 'A\'s routine is not run again in the period it already ran in');

  clock.at = dayAt(11, 9, 1);
  tick(t);
  await h.waitUntil(() => closedIn(a.dir) === 2);
  assert.strictEqual(promptedWith(a.dir, 'inverse body'), 2, 'and runs at its next slot as usual');
});

// The control failing, which must fail closed: A cannot be written when the
// run ends. The error names A's file, B is untouched, A's last good file is
// unchanged, and A's routine is not due again that period, because the stamp
// its start wrote is still there. At worst it reads interrupted.
test('an origin workspace that cannot be written at the ending fails closed',
  { skip: process.getuid && process.getuid() === 0 ? 'root writes through folder permissions' : false },
  async (t) => {
    const a = keeperWorkspace('unwritable origin body', { held: true });
    const b = keeperWorkspace('unwritable elsewhere body', { state: { [KEY]: ranTheDayBefore(12) } });
    await startHeldRun(t, a, dayAt(12, 9, 30));
    await choose(b.dir);
    const aBytes = fs.readFileSync(stateFile(a.dir));
    const bBytes = fs.readFileSync(stateFile(b.dir));

    const errors = [];
    const realError = console.error;
    console.error = (...args) => { errors.push(args.map(String).join(' ')); };
    const rundock = path.join(a.dir, '.rundock');
    fs.chmodSync(rundock, 0o500);
    try {
      clock.at = dayAt(12, 9, 40);
      await finish(a);
    } finally {
      fs.chmodSync(rundock, 0o755);
      console.error = realError;
    }

    assert.ok(errors.some(line => line.includes(stateFile(a.dir))),
      `the ending logged an error naming A's file:\n${errors.join('\n')}`);
    assert.ok(fs.readFileSync(stateFile(b.dir)).equals(bBytes), 'B is untouched');
    assert.ok(fs.readFileSync(stateFile(a.dir)).equals(aBytes), 'and A\'s last good file is unchanged');

    await choose(a.dir);
    assert.strictEqual(h.internal.routineState[KEY].status, 'interrupted', 'at worst A\'s row reads interrupted');
    clock.at = dayAt(12, 10, 0);
    tick(t);
    await h.delay(300);
    assert.strictEqual(promptedWith(a.dir, 'unwritable origin body'), 1,
      'and A\'s routine is not due again that period, because the stamp its start wrote is still there');
  });

// ===== EVERY LATER STEP USES THE WORKSPACE THE RUN STARTED IN =====
//
// Read once, at the start. Each test switches between the start and the step
// it is about.

const real = (p) => fs.realpathSync(p);
const argAfter = (argv, flag) => { const i = argv.indexOf(flag); return i < 0 ? null : argv[i + 1]; };
const pidsIn = (dir) => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, '.rundock', 'child-pids.json'), 'utf-8')).map(r => r.pid); } catch (e) { return []; }
};

// The plain session a run falls back to when Claude Code cannot load the
// agent's file. Its working folder, its spawn environment (the workspace the
// permission hook is told it answers for) and its arguments are the starting
// workspace's, though B is open when it starts.
test(`a run that falls back after a switch runs its plain session in its own workspace (${SIDE})`, async (t) => {
  const a = keeperWorkspace('fallback body');
  const b = keeperWorkspace('fallback elsewhere body');
  // The keeper's file has no description, so the stub, reading it as Claude
  // Code does, refuses --agent keeper. The refusal is held until the switch.
  const refusal = path.join(a.dir, 'release-refusal');
  const scenario = path.join(a.dir, 'stub-scenario.json');
  fs.writeFileSync(scenario, JSON.stringify({ ...JSON.parse(fs.readFileSync(scenario, 'utf-8')), loadAgentFiles: true, refusalUntilFile: refusal }));

  await choose(a.dir);
  clock.at = dayAt(14, 9, 30);
  tick(t);
  await h.waitUntil(() => invocationsIn(a.dir).length === 1);
  await choose(b.dir);
  fs.writeFileSync(refusal, '');
  await h.waitUntil(() => closedIn(a.dir) === 1);

  const [asAgent, plain] = invocationsIn(a.dir);
  assert.strictEqual(argAfter(asAgent.argv, '--agent'), AGENT, 'the run started as its agent, and was refused');
  assert.ok(plain && !plain.argv.includes('--agent'), `the plain session started, and it started in A: ${JSON.stringify(invocationsIn(b.dir))}`);
  assert.strictEqual(real(plain.cwd), real(a.dir), 'its working folder is the workspace the run started in');
  assert.strictEqual(plain.env.RUNDOCK_WORKSPACE, a.dir, 'and so is the workspace its permission hook answers for');
  assert.strictEqual(argAfter(plain.argv, '--add-dir'), a.dir, 'and the workspace its arguments name');
  assert.deepStrictEqual(plain.argv.filter(arg => String(arg).includes(b.dir)), [], 'nothing it was given names B');
  assert.deepStrictEqual(invocationsIn(b.dir), [], 'and nothing started in B');
  assert.strictEqual(recordsIn(a.dir)[0].status, 'succeeded', 'the plain session\'s outcome is the run\'s');
});

// The pid file a child is taken off when it closes is the one it was
// registered in.
test(`a run's child is taken off the pid file it was registered in, though another workspace is open (${SIDE})`, async (t) => {
  const a = keeperWorkspace('pid file body', { held: true });
  const b = keeperWorkspace('pid file elsewhere body');
  const pid = await startHeldRun(t, a, dayAt(15, 9, 30));
  assert.ok(pidsIn(a.dir).includes(pid), 'the child was registered in A\'s pid file');

  await choose(b.dir);
  await finish(a);
  await h.waitUntil(() => !pidsIn(a.dir).includes(pid), { timeout: 2000 });
  assert.ok(!pidsIn(a.dir).includes(pid), 'and taken off it when it closed, with B open');
});

// ===== A CODEX ROUTINE =====
//
// Codex routines run on one app-server the whole Rundock process shares with
// Codex conversations. A switch shuts that server down, which ended any Codex
// routine turn on it. The server a routine turn runs on is now held until the
// turn ends: the switch interrupts the conversation turns of the workspace
// being left, and the server shuts down once its last routine turn has ended.

const SCRIBE_KEY = 'scribe:note-check';
const appServerLog = (dir) => invocationsIn(dir).filter(e => e.mode === 'app-server');
const appServerPid = (dir) => { const spawn = appServerLog(dir).find(e => e.event === 'spawn'); return spawn ? spawn.pid : null; };
const requests = (dir, method) => appServerLog(dir).filter(e => e.method === method);
const turnFor = (dir, body) => requests(dir, 'turn/start').find(e => JSON.stringify(e.params.input).includes(body));

// A workspace whose scribe, a Codex agent, runs `prompt` every day at 09:00.
// `rule` is merged into the routine's rule; `appServer` and `rules` into the
// stub app-server's scenario.
function scribeWorkspace(prompt, { rule = {}, appServer = {}, rules = [] } = {}) {
  const dir = makeWorkspace({
    claudeMd: '# Scribe fixture\n',
    agents: {
      scribe: agentFile({
        name: 'scribe', description: 'Writes things down', type: 'specialist', order: 1, runtime: 'codex',
        routines: [{ name: 'note-check', schedule: SCHEDULE, prompt, enabled: true }],
      }),
    },
  });
  fs.writeFileSync(path.join(dir, 'stub-codex-scenario.json'), JSON.stringify({
    appServer: { ...appServer, rules: [...rules, { match: { promptIncludes: prompt }, text: 'noted', ...rule }] },
  }));
  return dir;
}

async function startCodexRun(t, dir, at) {
  await choose(dir);
  clock.at = at;
  tick(t);
}

test('a Codex routine turn survives a switch, which interrupts only the conversation turns being left', async (t) => {
  const release = path.join(h.workspaceDir, `release-codex-${process.pid}`);
  const a = scribeWorkspace('codex routine body', {
    rule: { untilFile: release },
    rules: [{ match: { promptIncludes: 'codex conversation body' }, deltas: ['working '], holdForInterrupt: true }],
  });
  const b = keeperWorkspace('codex elsewhere body');
  await startCodexRun(t, a, dayAt(16, 9, 30));
  await h.waitUntil(() => turnFor(a, 'codex routine body'));
  assert.ok(turnFor(a, 'codex routine body'), 'the routine\'s turn started on the shared app-server');
  const server = appServerPid(a);

  // A conversation in A, on the same server, with a turn going.
  const convoId = h.freshConvoId('carry');
  client.send({ type: 'chat', conversationId: convoId, agent: 'scribe', content: 'codex conversation body' });
  await h.waitUntil(() => turnFor(a, 'codex conversation body'));
  const convoThread = turnFor(a, 'codex conversation body').params.threadId;
  const routineThread = turnFor(a, 'codex routine body').params.threadId;
  assert.notStrictEqual(convoThread, routineThread, 'two turns, on two threads');

  await choose(a);
  await h.waitUntil(() => requests(a, 'turn/interrupt').length > 0, { timeout: 3000 });
  assert.deepStrictEqual(requests(a, 'turn/interrupt').map(e => e.params.threadId), [convoThread],
    're-selecting the workspace interrupted the conversation\'s turn, and only that one');
  await choose(b.dir);
  await h.delay(300);
  assert.deepStrictEqual(recordsIn(a).map(r => r.status), ['running'], 'the routine run is still going after both switches');
  assert.ok(h.pidAlive(server), 'and so is the app-server it runs on');
  assert.deepStrictEqual(requests(a, 'turn/interrupt').map(e => e.params.threadId), [convoThread],
    'its turn was never interrupted');

  fs.writeFileSync(release, '');
  await h.waitUntil(() => closedIn(a) === 1);
  assert.strictEqual(recordsIn(a)[0].status, 'succeeded', 'the run ends with the outcome its turn gave');
  assert.strictEqual(stateIn(a)[SCRIBE_KEY].status, 'completed', 'recorded in its own workspace');
  assert.ok(await h.waitForPidExit(server, 5000), 'and the app-server shut down once its last routine turn ended');
});

// The switch lands while the app-server is still starting, before any routine
// or conversation holds it. Nothing will ever hold it as the shared server
// again, so once the routine's turn on it ends nobody would shut it down.
test('a switch while the app-server is still starting leaves no app-server nothing will shut down', async (t) => {
  const started = path.join(h.workspaceDir, `release-codex-start-${process.pid}`);
  const a = scribeWorkspace('codex start body', { appServer: { initializeUntilFile: started } });
  const b = keeperWorkspace('codex start elsewhere body');
  await startCodexRun(t, a, dayAt(17, 9, 30));
  await h.waitUntil(() => requests(a, 'initialize').length > 0);
  const server = appServerPid(a);
  assert.ok(server, 'the app-server was spawned, and is held in its start');

  await choose(b.dir);
  fs.writeFileSync(started, '');
  await h.waitUntil(() => closedIn(a) === 1);

  assert.strictEqual(recordsIn(a)[0].status, 'succeeded', 'the run went on once the server had started');
  const [thread] = requests(a, 'thread/start');
  assert.strictEqual(thread.params.cwd, a, 'and its thread was opened in the workspace the run started in');
  assert.ok(await h.waitForPidExit(server, 5000), 'no app-server outlives the run');
});

// The control failing: the deferred shutdown meets an app-server that does not
// stop on SIGTERM. It is sent SIGKILL after the grace period, as any shutdown
// of it is.
test('an app-server that stalls on the deferred shutdown is killed after the grace period', async (t) => {
  const release = path.join(h.workspaceDir, `release-codex-stall-${process.pid}`);
  const a = scribeWorkspace('codex stall body', { rule: { untilFile: release }, appServer: { ignoreSigterm: true } });
  const b = keeperWorkspace('codex stall elsewhere body');
  await startCodexRun(t, a, dayAt(18, 9, 30));
  await h.waitUntil(() => turnFor(a, 'codex stall body'));
  const server = appServerPid(a);

  await choose(b.dir);
  fs.writeFileSync(release, '');
  await h.waitUntil(() => closedIn(a) === 1);
  assert.strictEqual(recordsIn(a)[0].status, 'succeeded', 'the run ended with its turn');

  await h.waitUntil(() => appServerLog(a).some(e => e.event === 'sigterm-ignored'), { timeout: 3000 });
  assert.ok(appServerLog(a).some(e => e.event === 'sigterm-ignored'), 'the deferred shutdown sent SIGTERM, which it ignored');
  assert.ok(h.pidAlive(server), 'so it was still running');
  assert.ok(await h.waitForPidExit(server, 6000), 'until SIGKILL ended it after the grace period');
});

// ===== RUNDOCK STOPPED WHILE A RUN OUTLIVES A SWITCH =====
//
// The control this change leans on, failing: the process that could have
// recorded the run's ending is gone. The child is a real orphan now, and the
// next launch on its workspace reaps it from the pid file it was registered
// in and closes its record as interrupted, so the cleanup still reaps what it
// exists for. Two processes of their own, because one that has stopped cannot
// be the one asserting.

const ROOT = path.join(__dirname, '..', '..');
const { spawn } = require('node:child_process');
const { makeTempDir } = require('../helpers/workspace.js');

// The first Rundock: starts the run in A, switches to B as the open path does
// (stop the conversation children, set the workspace, clean up orphans), says
// so, and waits to be stopped.
const FIRST_RUNDOCK = `
const fs = require('fs');
const path = require('path');
const [a, b] = process.argv.slice(1);
const srv = require(${JSON.stringify(path.join(ROOT, 'server.js'))})._internal;
srv.setWorkspace(a);
const keeper = srv.discoverAgents().find(agent => agent.id === ${JSON.stringify(AGENT)});
srv.executeRoutine(keeper, keeper.routines.find(r => r.name === ${JSON.stringify(ROUTINE)}), ${JSON.stringify(KEY)});
const started = setInterval(() => {
  if (!fs.existsSync(path.join(a, 'stub-invocations.jsonl'))) return;
  clearInterval(started);
  srv.killAllChildren();
  srv.setWorkspace(b);
  srv.cleanOrphanedProcesses();
  console.log('switched');
}, 20);
setInterval(() => {}, 1 << 30);
`;

function launch(args, env) {
  const proc = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const said = { text: '' };
  proc.stdout.on('data', (d) => { said.text += d; });
  proc.stderr.on('data', (d) => { said.text += d; });
  const closed = new Promise((resolve) => proc.once('close', resolve));
  return { proc, said, stop: async () => { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM'); await closed; } };
}

test('a run that outlived a switch is reaped by the next launch on its workspace once Rundock has stopped', async () => {
  const a = keeperWorkspace('stopped run body', { held: true });
  const b = keeperWorkspace('stopped elsewhere body');
  const env = { ...process.env, RUNDOCK_DISABLE_SCHEDULER: '1' };
  delete env.WORKSPACE;

  const first = launch(['-e', FIRST_RUNDOCK, a.dir, b.dir], { ...env, HOME: makeTempDir('first-home-') });
  try {
    assert.ok(await h.waitUntil(() => first.said.text.includes('switched'), { timeout: 15000 }),
      `the first Rundock started the run and switched:\n${first.said.text}`);
  } finally {
    await first.stop();
  }
  const [child] = invocationsIn(a.dir);
  assert.ok(child && h.pidAlive(child.pid), 'Rundock stopping left the run\'s child running: a real orphan now');
  assert.deepStrictEqual(recordsIn(a.dir).map(r => r.status), ['running'], 'with its record left open');
  assert.ok(pidsIn(a.dir).includes(child.pid), 'and its pid still in the file it was registered in');

  const next = launch([path.join(ROOT, 'server.js')], { ...env, HOME: makeTempDir('next-home-'), WORKSPACE: a.dir, PORT: '0' });
  try {
    assert.ok(await h.waitUntil(() => /Routines: /.test(next.said.text), { timeout: 15000 }),
      `the next launch opened A:\n${next.said.text}`);
    assert.match(next.said.text, /\[Cleanup\] Killed 1 orphaned process tree\(s\) from a previous session/,
      'its cleanup signalled the orphan, by its own account');
    assert.ok(await h.waitForPidExit(child.pid, 4000), 'and the orphan is gone');
    assert.deepStrictEqual(recordsIn(a.dir).map(r => r.status), ['interrupted'], 'its record closed as interrupted');
  } finally {
    await next.stop();
  }
});
