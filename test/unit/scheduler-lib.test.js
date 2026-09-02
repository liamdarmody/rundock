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
const { EventEmitter } = require('node:events');

const SCHEDULER_KEY = require.resolve('../../lib/scheduler.js');
const CLAUDE_KEY = require.resolve('../../lib/runtime/claude.js');
const CODEX_GLUE_KEY = require.resolve('../../lib/runtime/codex-glue.js');
const { createCodexAppServer } = require('../../codex-appserver.js');
const { discoverAgents, invalidateAgentCache } = require('../../lib/agents/discovery.js');
const { agentFile } = require('../helpers/workspace.js');
const asfx = require('../fixtures/codex-appserver-protocol.js');
const fx = require('../fixtures/session-transcript.js');
const PROMPT_KEY = require.resolve('../../lib/agents/prompt.js');
const STUB_CODEX = path.join(__dirname, '..', 'helpers', 'stub-codex', 'codex');
const WORKSPACE_HANDLERS_KEY = require.resolve('../../lib/protocol/handlers/workspace.js');

const AGENT = { id: 'runner', name: 'Runner' };
const ROUTINE = { name: 'r', prompt: 'p' };
const KEY = 'runner:r';

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

// The real workspace switch, closed over the scheduler under test.
//
// handleSetWorkspace IS the switch; loadRoutineState is one of the eleven
// things its open path calls. A test that drives the call instead of the
// switch leaves the invariant open to the one change that would break it: a
// reset added to openWorkspace, beside the two resets that belong there, with
// every scheduler test still green.
//
// The handler destructures loadRoutineState at load, so a copy required while
// the test's own scheduler sits in the cache closes over that one rather than
// the shared instance the rest of the suite runs against. Same technique as
// freshScheduler, one module further out, and undone the same way.
function freshWorkspaceHandlers(sched) {
  const cachedSched = require.cache[SCHEDULER_KEY];
  const cachedHandlers = require.cache[WORKSPACE_HANDLERS_KEY];
  require.cache[SCHEDULER_KEY] = { id: SCHEDULER_KEY, filename: SCHEDULER_KEY, loaded: true, exports: sched };
  delete require.cache[WORKSPACE_HANDLERS_KEY];
  try {
    return require(WORKSPACE_HANDLERS_KEY);
  } finally {
    delete require.cache[WORKSPACE_HANDLERS_KEY];
    if (cachedHandlers) require.cache[WORKSPACE_HANDLERS_KEY] = cachedHandlers;
    if (cachedSched) require.cache[SCHEDULER_KEY] = cachedSched;
    else delete require.cache[SCHEDULER_KEY];
  }
}

function enterTempWorkspace() {
  const config = require('../../lib/config.js');
  const original = config.getWorkspace();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-lib-'));
  config.setWorkspace(ws);
  return {
    ws,
    config,
    leave() {
      config.setWorkspace(original);
      // TOLERANT ON PURPOSE, and the reason is a property of the scheduler
      // rather than a flake. A run in flight writes its record to the
      // directory it STARTED in, deliberately, so that a workspace switch
      // cannot orphan a record from its own beginning. A test that leaves a
      // run going therefore has a writer that can recreate this directory in
      // between the walk and the unlink, and the removal fails with ENOTEMPTY.
      //
      // Retried, then left to the operating system. A stray temp directory
      // costs nothing, while a throw here reports as a failure of whichever
      // test happened to run last, which is the least informative place a
      // failure can appear.
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          fs.rmSync(ws, { recursive: true, force: true });
          return;
        } catch (e) { /* a late record recreated it; try again */ }
      }
    },
  };
}

function withTempWorkspace(fn) {
  const t = enterTempWorkspace();
  try {
    return fn(t.ws, t.config);
  } finally {
    t.leave();
  }
}

// The same workspace, held for a lifetime that outlives a synchronous return.
// The codex path is asynchronous, so a sync finally would tear the workspace
// down while the run under test was still going. One mechanism, two lifetimes,
// rather than two mechanisms.
async function withTempWorkspaceAsync(fn) {
  const t = enterTempWorkspace();
  try {
    return await fn(t.ws, t.config);
  } finally {
    t.leave();
  }
}

// Poll until a predicate holds. The codex path settles over several
// microtasks and then over whatever the fake does, so a fixed flush would be
// a guess at how many.
async function until(predicate, tries = 200) {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return true;
    await new Promise(r => setTimeout(r, 5));
  }
  return false;
}

// A scheduler whose child processes are the test's to drive.
//
// WHY NOT THE SEAM THAT EXISTS. wireSchedulerDeps is the file's own injection
// point and it reaches exactly two things, the WebSocket clients and the
// clock. Neither is a child process. A test that has to decide how a child
// ends, or make the spawn itself fail, needs the module the scheduler imports
// rather than a dep it is handed, and adding a spawn dep to the wiring surface
// would put a seam in production code that only tests would ever use.
//
// lib/scheduler.js destructures spawnClaude at load, so a copy required after
// the export is swapped closes over the fake, and the swap is undone before
// the shared instance the rest of the suite runs against can see it. The port
// dep is wired because the real getSpawnEnv still runs on the way to the fake.
//
// Nothing here reaches a real binary, which matters more than usual next to
// this code: resolveClaudeBin memoises whatever `which claude` finds, and the
// unit suite has no equivalent of the integration harness's refusal to run
// against it, so a unit test that reaches the real spawn runs whatever happens
// to be installed on the machine.
//
// `fakeKill` is the signal a stop sends, stood in for the same way and for a
// sharper reason than the spawn. A stand-in child carries whatever process id
// the test gave it, and the real signaller would send SIGTERM to that id on
// the machine running the suite, where it belongs to something else entirely.
//
// THE REAL SIGNALLER IS NEVER LEFT IN PLACE, whether a test asked for a
// stand-in or not. Leaving it for the tests that do not stop a run makes the
// hazard depend on a caller remembering a trailing argument, and the caller
// who forgets is by definition the one who just wrote a test that stops a run.
// A test that omits it gets a stand-in that records instead, and reaching that
// stand-in is reported as a failure of that test once the real one is back.
// Deliberately checked after the restore rather than thrown from inside the
// signaller: a stop swallows what its signaller throws, on purpose, so a throw
// raised there would be logged and the test would pass.
async function withFakeSpawn(fakeSpawn, fn, fakeKill) {
  const claude = require(CLAUDE_KEY);
  const realSpawn = claude.spawnClaude;
  const realKill = claude.killProcessTree;
  // Checked before it is replaced, in every test that uses this helper: a
  // stand-in can stand in for a name that no longer exists and never say so.
  assert.strictEqual(typeof realKill, 'function',
    'the runtime module has no killProcessTree to stand in for, so the scheduler imports nothing');
  const prevClaudeDeps = claude.wireClaudeRuntimeDeps({ getActualPort: () => 0 });
  const unclaimedStops = [];
  claude.spawnClaude = fakeSpawn;
  claude.killProcessTree = fakeKill || ((target, signal) => { unclaimedStops.push([target, signal]); });
  let result;
  try {
    const sched = freshScheduler();
    sched.wireSchedulerDeps({ getWssClients: () => [] });
    result = await fn(sched);
  } finally {
    claude.spawnClaude = realSpawn;
    claude.killProcessTree = realKill;
    claude.wireClaudeRuntimeDeps(prevClaudeDeps);
  }
  assert.deepStrictEqual(unclaimedStops, [],
    'this test stopped a run without standing in for the signaller, so with the stand-in absent it '
    + 'would have signalled that process id on the machine running the suite');
  return result;
}

// A scheduler whose codex app-server is the test's to drive.
//
// Same reason as withFakeSpawn, and the same answer to "why not the seam that
// exists": wireSchedulerDeps reaches the WebSocket clients and the clock, and
// nothing else. A test that has to hold a turn subscription and decide how the
// turn ends needs the module the scheduler imports, not a dep it is handed.
// The system prompt builder is stood in for as well, because it has wiring of
// its own that has nothing to do with what is under test here.
async function withFakeCodex(server, fn) {
  const glue = require(CODEX_GLUE_KEY);
  const prompt = require(PROMPT_KEY);
  const real = {
    getCodexAppServer: glue.getCodexAppServer,
    waitForCodexReady: glue.waitForCodexReady,
    buildSystemPrompt: prompt.buildSystemPrompt,
  };
  glue.getCodexAppServer = async () => server;
  glue.waitForCodexReady = async () => {};
  prompt.buildSystemPrompt = () => 'system prompt';
  try {
    const sched = freshScheduler();
    sched.wireSchedulerDeps({ getWssClients: () => [] });
    return await fn(sched);
  } finally {
    Object.assign(glue, { getCodexAppServer: real.getCodexAppServer, waitForCodexReady: real.waitForCodexReady });
    prompt.buildSystemPrompt = real.buildSystemPrompt;
  }
}

// Starting a run is the only way to observe that a routine was released, so
// every release test below starts one. A run left going outlives its test: it
// records its outcome later, into whatever workspace the next test has set,
// which is where the stray "failed to persist routine state" lines in this
// file's output came from. So every started run is driven to an end before its
// test returns. A start always writes 'running' first, so leaving that state
// is the signal the run has ended, whatever it ended as.
async function endedAfter(sched, start) {
  assert.strictEqual(sched.routineState[KEY].status, 'running', 'the start under test is a real run');
  await start();
  assert.ok(await until(() => sched.routineState[KEY].status !== 'running'),
    'and it was ended rather than left going');
}

// The codex turn events, TAKEN FROM THE CLIENT rather than written here.
//
// The scheduler decides whether a turn has ended by reading ev.type,
// ev.willRetry and ev.status. A test that hand-builds those events asserts a
// contract its own author invented: rename willRetry in the client and every
// error becomes terminal, a routine is released mid-turn, a second run starts
// alongside the first, and every test in this file stays green while saying
// the opposite. Verified by doing it.
//
// A client that was never started refuses its first request, and that refusal
// runs the same event construction the live paths run: one error event and one
// terminal event, built by the client, with no process spawned and nothing
// left running.
async function realTurnEvents() {
  const server = createCodexAppServer({ binPath: '/nonexistent', cwd: os.tmpdir(), requestTimeoutMs: 200 });
  const seen = [];
  const sub = server.startTurn('thread-contract', 'contract probe');
  sub.on('event', (ev) => seen.push(ev));

  // The retryable error comes from the streaming path, which is the only one
  // that ever sets the flag true and is a different construction site from the
  // two below. Fed as a wire notification built by the fixture the stub and
  // the client's own tests share, so the shape is not this file's either. The
  // turn state exists from the synchronous startTurn above until the refusal
  // below is handled, so this ordering is microtask-deterministic.
  const wire = asfx.errorNotification('thread-contract', 'turn-contract', { message: 'rate limited', willRetry: true });
  server._onNotification(wire.method, wire.params);
  const retryable = seen.find(e => e.type === 'error');
  assert.ok(retryable && retryable.willRetry === true, 'the client built a retryable error');

  assert.ok(await until(() => seen.some(e => e.type === 'done')), 'the client reached a terminal event');
  const error = seen.filter(e => e.type === 'error').find(e => e !== retryable);
  assert.ok(error, 'and emitted a non-retryable error alongside it');
  return { error, retryable, done: seen.find(e => e.type === 'done') };
}

// The thread a run is filed under, TAKEN FROM THE CLIENT for the same reason
// the events above are.
//
// executeRoutine destructures what startThread resolves and hands the id it
// finds to startTurn. Every codex test below stood a two-method literal in for
// the client, with a key this file chose, so nothing tied that key to the
// producer. Rename it there and the turn is filed under `undefined` while the
// notifications carry the real id, turn/completed finds no state and bails, no
// `done` ever reaches the promise the routine is released by, and the routine
// is held for the life of the process: the one failure the comment on that
// promise says the design refuses to rest on.
//
// The success token comes back with it, and for the same reason. The
// scheduler branches on the status of the terminal event, and every test
// below overwrote that one field with a token of its own, so the contract
// test could only pin that a `done` HAS a status and never what a successful
// one says. Rename the token and every successful codex routine records as
// failed, in the routine state and in the signal, and the interface shows a
// permanently failing routine while the tests stay green.
//
// Two tokens are read, because the client owns the value on one path and
// passes it through on the other: a turn the stub really completes, and a
// turn/completed carrying no status at all, where the client's own default is
// the only thing that can name it.
//
// A real thread takes a real request round-trip, so this drives the repo's
// stub app-server, binPath injected, the way codex-appserver's own tests drive
// it. Nothing here can reach an installed codex. Started once for the file and
// shut down before the answer is returned, because the answer is a frozen
// object rather than a live client.
let codexRun = null;
function realCodexRun() {
  if (!codexRun) codexRun = startRealCodexRun();
  return codexRun;
}

async function startRealCodexRun() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-lib-codex-'));
  const server = createCodexAppServer({ binPath: STUB_CODEX, cwd: dir, requestTimeoutMs: 15000 });
  try {
    await server.start();
    const thread = await server.startThread({ cwd: dir });
    // The id read as the value the client returned rather than by a name this
    // file chose, so a rename has to reach the SCHEDULER's destructure, which
    // is what the tests are about, rather than stopping here in the helper.
    const [threadId] = Object.values(thread);
    const seen = [];
    server.startTurn(threadId, 'contract probe').on('event', (ev) => seen.push(ev));
    assert.ok(await until(() => seen.some(e => e.type === 'done'), 3000),
      'the probe turn reached its terminal event');
    return { thread, done: seen.find(e => e.type === 'done'), defaulted: defaultedDone() };
  } finally {
    await server.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The terminal event for a turn that completes without saying how, which is
// the one success token the client owns rather than relays. Same never-started
// client as realTurnEvents, and the same fixture, with the status removed from
// the wire so the client has to supply it.
function defaultedDone() {
  const server = createCodexAppServer({ binPath: '/nonexistent', cwd: os.tmpdir(), requestTimeoutMs: 200 });
  const seen = [];
  server.startTurn('thread-default', 'default probe').on('event', (ev) => seen.push(ev));
  const wire = asfx.turnCompleted('thread-default', 'turn-default');
  delete wire.params.turn.status;
  server._onNotification(wire.method, wire.params);
  const done = seen.find(e => e.type === 'done');
  assert.ok(done, 'the client ended the turn on a completion carrying no status');
  return done;
}

// The agent that sends a routine down the codex branch, DISCOVERED rather
// than declared. All four codex tests take that branch because of the runtime
// field, and discovery is what really decides it: the field is case-folded,
// anything unrecognised falls back to claude, and an orchestrator is forced to
// claude whatever its file says. A literal here asserts none of that, and the
// tests would keep taking the branch after discovery stopped putting anything
// on it.
function realCodexAgent(dir) {
  const agentsDir = path.join(dir, '.claude', 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, 'runner.md'),
    agentFile({ name: 'Runner', type: 'specialist', order: 1, runtime: 'codex', body: 'runner instructions' }));
  invalidateAgentCache();
  const agent = discoverAgents().find(a => a.id === 'runner');
  assert.ok(agent, 'the roster carries the agent this test wrote');
  assert.strictEqual(agent.runtime, 'codex',
    'and discovery put it on the codex runtime, which is what sends its routines down the branch under test');
  return agent;
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
//
// WHY BOTH THIS AND THE SPAWN TEST BELOW, since one guard catches both. They
// throw from different statements, and only one of them needs a stand-in for a
// module: this one is reachable through the file's own wiring, so it is the
// cheaper test and it is kept for that. The one below throws from the spawn,
// which is what AC-6 is about, and reading it against a criterion that names
// the spawn should not require believing that a throw from the line above
// behaves the same way.
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

// AC-7 in its sharpest form. The claude path used to release only from the
// child's close event, on the strength of close following error. That holds
// for a binary that is not there, which is the case easy to reach and easy to
// test. It is not established for the failures a tick is most likely to meet,
// which are the file-descriptor exhaustion ones: a process under that pressure
// is exactly when a spawn fails, and whether the handle still closes after the
// error is a question about a Node version rather than about this file. So the
// error routes to the same outcome and the question stops mattering.
test('a child that reports an error and never closes does not hold the routine', async () => {
  await withTempWorkspaceAsync(async () => {
    const child = new EventEmitter();
    await withFakeSpawn(() => child, async (sched) => {
      assert.strictEqual(sched.executeRoutine(AGENT, ROUTINE, KEY), true, 'the first run started');
      child.emit('error', Object.assign(new Error('too many open files'), { code: 'EMFILE' }));
      assert.strictEqual(sched.routineState[KEY].status, 'failed',
        'the error was recorded as an outcome rather than waiting for a close that may never come');
      assert.strictEqual(sched.executeRoutine(AGENT, ROUTINE, KEY), true,
        'and it released the routine, so the next start was allowed');
      await endedAfter(sched, async () => { child.emit('close', 0); });
    });
  });
});

// The run record's AC-6, on the path that only a fake spawn can reach.
//
// A child that never launched reports an Error with a message: the binary is
// missing, the descriptors are exhausted, the executable is not executable.
// That reason is the whole of what a maintainer has to go on, because no child
// existed to write anything. The outcome handler used to close the record with
// no reason at all on every path, so this failure and a routine that ran and
// exited non-zero were indistinguishable in the history, and only one of them
// genuinely has nothing to say.
//
// This test lives here rather than beside the rest of the run-record suite
// because the event cannot be produced against a real spawn: the integration
// harness resolves a stub that does launch. The fake spawn is the only place
// this path exists.
test('a child that never launched puts the reason it gave in the run record', async () => {
  await withTempWorkspaceAsync(async () => {
    const child = new EventEmitter();
    await withFakeSpawn(() => child, async (sched) => {
      assert.strictEqual(sched.executeRoutine(AGENT, ROUTINE, KEY), true, 'the run started');

      // Opened before anything went wrong, so the assertion below is about the
      // ending rather than about whether a record exists at all.
      const [opened] = sched.readRunRecords();
      assert.strictEqual(opened.status, 'running', 'the run opened a record');

      child.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }));

      const [rec] = sched.readRunRecords();
      assert.strictEqual(rec.id, opened.id, 'the same record was closed rather than a second one written');
      assert.strictEqual(rec.status, 'failed', 'a child that never launched is a failed run');
      assert.strictEqual(rec.error, 'spawn claude ENOENT',
        'carrying the reason the failure gave, which is all anyone has when there was no child');
      assert.strictEqual(sched.routineState[KEY].status, 'failed',
        'and the routine state agrees, in its own vocabulary');

      // No close is driven afterwards. The run already reached an outcome, so
      // the routine is released and a close would be swallowed by the
      // record-once guard; the test beside this one is what covers that.
      child.emit('close', 0);
    });
  });
});

// The cost of listening to both: a failure that reports twice must not be
// recorded twice. Counted through the broadcast, which happens once when a run
// starts and once per outcome, so a second outcome is a third broadcast.
test('a failure reported as both an error and a close records one outcome', async () => {
  await withTempWorkspaceAsync(async () => {
    const child = new EventEmitter();
    let broadcasts = 0;
    await withFakeSpawn(() => child, async (sched) => {
      sched.wireSchedulerDeps({ getWssClients: () => { broadcasts += 1; return []; } });
      sched.executeRoutine(AGENT, ROUTINE, KEY);
      child.emit('error', Object.assign(new Error('no such file'), { code: 'ENOENT' }));
      child.emit('close', -2);
      assert.strictEqual(broadcasts, 2,
        'the start and one outcome, not the start and the same outcome twice');
    });
  });
});

// THE MECHANISM THE ROUTINES RAIL DEPENDS ON, asserted rather than assumed.
//
// The failure dot on the Routines rail entry is raised and cleared by the
// client's handling of an `agents` message, and its own tests drive that
// message into a document. That proves the client's half. Whether such a
// message ARRIVES when a run finishes is a fact about this file, and without
// it the dot would appear only on the next unrelated roster: a pause, a
// delete, a reconnect. So the run is driven to an outcome through the real
// executeRoutine and what reaches a connected client is read off the socket.
test('a run reaching an outcome sends the roster to connected clients', async () => {
  await withTempWorkspaceAsync(async () => {
    const child = new EventEmitter();
    const sent = [];
    await withFakeSpawn(() => child, async (sched) => {
      sched.wireSchedulerDeps({
        getWssClients: () => [{ readyState: 1, send: (msg) => sent.push(JSON.parse(msg)) }],
      });
      sched.executeRoutine(AGENT, ROUTINE, KEY);
      assert.deepStrictEqual(sent.map(m => m.type), ['agents'],
        'a run starting tells connected clients');

      child.emit('close', 1);
      assert.deepStrictEqual(sent.map(m => m.type), ['agents', 'agents'],
        'a run FINISHING tells connected clients, which is what raises the failure dot');
      assert.ok(Array.isArray(sent[1].agents),
        'the message carries the roster the rail reads its routines out of');
    });
  });
});

// The same path for a run that succeeded, which is what CLEARS the dot.
test('a run that succeeds also sends the roster, which is what clears the dot', async () => {
  await withTempWorkspaceAsync(async () => {
    const child = new EventEmitter();
    const sent = [];
    await withFakeSpawn(() => child, async (sched) => {
      sched.wireSchedulerDeps({
        getWssClients: () => [{ readyState: 1, send: (msg) => sent.push(JSON.parse(msg)) }],
      });
      sched.executeRoutine(AGENT, ROUTINE, KEY);
      child.emit('close', 0);
      assert.strictEqual(sent.length, 2, 'the start and the outcome');
      assert.strictEqual(sent[1].type, 'agents');
    });
  });
});

// The contract the two tests below rest on, asserted against the client that
// owns it. Without this they rest on nothing: the fields are read by the
// scheduler and supplied by the tests, so the tests agree with themselves.
test('the codex fields the scheduler reads are the ones the client emits', async () => {
  const { error, retryable, done } = await realTurnEvents();
  // Both construction sites, because renaming either one alone would leave the
  // other still answering and this test still green.
  for (const [what, ev] of [['a failed start', error], ['a streamed turn error', retryable]]) {
    assert.strictEqual(ev.type, 'error', `${what} is typed error`);
    assert.ok(Object.hasOwn(ev, 'willRetry'),
      `${what} carries willRetry, which is how the scheduler decides an error ended the turn: renamed, every error ends it and a routine is released mid-run`);
  }
  assert.strictEqual(done.type, 'done', 'a turn ending is typed done');
  assert.ok(Object.hasOwn(done, 'status'),
    'and the scheduler decides success by reading status on it');

  // The thread the run is filed under, from the same client. The scheduler
  // destructures this key and hands what it finds to startTurn.
  const { thread, done: completed, defaulted } = await realCodexRun();
  assert.ok(Object.hasOwn(thread, 'threadId'),
    'startThread resolves the key the scheduler destructures: renamed, the turn is filed under undefined, turn/completed finds no state, no done arrives, and the routine is held for the life of the process');

  // What a successful one SAYS, which is the half the assertion above cannot
  // reach: the scheduler reads this exact token as success.
  assert.strictEqual(completed.status, 'completed',
    'a turn that ran to the end says completed, and the scheduler records success on that token alone: rename it and every successful routine records as failed');
  assert.strictEqual(defaulted.status, completed.status,
    'and a completion that carries no status gets the same token from the client, so the default cannot drift away from the value it stands in for');
});

// The codex half of AC-7, and the half this card's own change made worse. The
// outcome promise resolved only on a `done` event. Before single-flight, a
// turn that never reached one left stale running state and the next window
// fired anyway; afterwards it holds the routine for the life of the process.
// A self-healing failure turned into a permanent one, on a path the card never
// mentioned.
//
// The reasoning that fixed the claude path applies unchanged: do not try to
// establish that every turn ends with `done`. The client documents it as
// terminal and exactly once and every path in it reaches one today, and a
// routine held on that staying true is held forever when it stops being true.
test('a codex turn that ends without a done event does not hold the routine', async () => {
  await withTempWorkspaceAsync(async (dir) => {
    const CODEX_AGENT = realCodexAgent(dir);
    const real = await realTurnEvents();
    const sub = new EventEmitter();
    // The client's own thread result, so the scheduler destructures the real
    // key, and what it hands on is recorded rather than ignored.
    const run = await realCodexRun();
    const { thread } = run;
    let filedUnder;
    const server = { startThread: async () => thread, startTurn: (threadId) => { filedUnder = threadId; return sub; } };
    await withFakeCodex(server, async (sched) => {
      assert.strictEqual(sched.executeRoutine(CODEX_AGENT, ROUTINE, KEY), true, 'the run started');
      assert.ok(await until(() => sub.listenerCount('event') > 0), 'the run reached the turn subscription');
      assert.ok(Object.values(thread).includes(filedUnder),
        'and filed it under the id the client gave it, rather than under undefined');

      // The client's own non-retryable error, verbatim.
      sub.emit('event', real.error);

      assert.ok(await until(() => sched.routineState[KEY] && sched.routineState[KEY].status !== 'running'),
        'the turn ending without a done event still recorded an outcome');
      assert.strictEqual(sched.routineState[KEY].status, 'failed', 'and recorded it as a failure');
      assert.strictEqual(sched.executeRoutine(CODEX_AGENT, ROUTINE, KEY), true,
        'and released the routine, so the next start was allowed');
      await endedAfter(sched, async () => {
        await until(() => sub.listenerCount('event') > 1);
        sub.emit('event', run.done);
      });
    });
  });
});

// The other side of that, and the reason the fix reads willRetry rather than
// treating every error as an ending. A retryable error is not an ending: the
// turn is still going, and releasing there would let a second run start
// alongside the first, which is the fault this whole change exists to stop.
test('a codex error that will be retried is not an ending', async () => {
  await withTempWorkspaceAsync(async (dir) => {
    const CODEX_AGENT = realCodexAgent(dir);
    const real = await realTurnEvents();
    const sub = new EventEmitter();
    // The client's own thread result, so the scheduler destructures the real
    // key, and what it hands on is recorded rather than ignored.
    const run = await realCodexRun();
    const { thread } = run;
    let filedUnder;
    const server = { startThread: async () => thread, startTurn: (threadId) => { filedUnder = threadId; return sub; } };
    await withFakeCodex(server, async (sched) => {
      assert.strictEqual(sched.executeRoutine(CODEX_AGENT, ROUTINE, KEY), true, 'the run started');
      assert.ok(await until(() => sub.listenerCount('event') > 0), 'the run reached the turn subscription');
      assert.ok(Object.values(thread).includes(filedUnder),
        'and filed it under the id the client gave it, rather than under undefined');

      // The client's own retryable error, verbatim: no field of it is named
      // here, so a rename in the client arrives intact rather than being
      // papered over by a literal this file wrote.
      sub.emit('event', real.retryable);
      await until(() => false, 4); // give a wrong release time to happen

      assert.strictEqual(sched.routineState[KEY].status, 'running', 'the turn is still going');
      assert.strictEqual(sched.executeRoutine(CODEX_AGENT, ROUTINE, KEY), false,
        'so the routine is still held');

      sub.emit('event', run.done);
      assert.ok(await until(() => sched.routineState[KEY].status !== 'running'), 'the turn then ended');
      assert.strictEqual(sched.routineState[KEY].status, 'completed', 'as a success, because the retry worked');
      assert.strictEqual(sched.executeRoutine(CODEX_AGENT, ROUTINE, KEY), true, 'and released the routine');
      await endedAfter(sched, async () => {
        await until(() => sub.listenerCount('event') > 1);
        sub.emit('event', run.done);
      });
    });
  });
});

// AC-5 on the codex path. The rejection handler was implemented and only ever
// exercised for the outcome it records, never for the release it also owes.
test('a codex run that cannot start its thread releases the routine', async () => {
  await withTempWorkspaceAsync(async (dir) => {
    const CODEX_AGENT = realCodexAgent(dir);
    const server = {
      startThread: async () => { throw new Error('thread/start refused'); },
      startTurn: () => { throw new Error('never reached'); },
    };
    await withFakeCodex(server, async (sched) => {
      assert.strictEqual(sched.executeRoutine(CODEX_AGENT, ROUTINE, KEY), true, 'the run started');
      assert.ok(await until(() => sched.routineState[KEY] && sched.routineState[KEY].status !== 'running'),
        'the rejected start recorded an outcome');
      assert.strictEqual(sched.routineState[KEY].status, 'failed', 'as a failure');
      assert.strictEqual(sched.executeRoutine(CODEX_AGENT, ROUTINE, KEY), true,
        'and released the routine, which the outcome test alone never checked');
      // The second start rejects on its own, so ending it is only a matter of
      // waiting for it rather than driving it.
      await endedAfter(sched, async () => {});
    });
  });
});

// The decision that the in-flight set is NOT reset by a workspace switch,
// pinned so it cannot be quietly corrected into consistency with the two
// states beside it that ARE reset. Those describe the workspace being left.
// A run in flight is a child process that is still running, and clearing its
// key would free the routine to start again while the first run was still
// going, with the eventual release then having nothing to release.
//
// Driven through the real switch handler, re-selecting the same workspace
// (which the open path treats as a switch, and which keeps the state file the
// test wrote). Killing the children is ctx's, injected, and stubbed here: the
// child in this test is the test's to end, and what is pinned is that the
// SWITCH does not let go of a routine whose run is still going.
test('the workspace switch does not release a run that is still going', async () => {
  await withTempWorkspaceAsync(async (dir, config) => {
    const child = new EventEmitter();
    await withFakeSpawn(() => child, async (sched) => {
      assert.strictEqual(sched.executeRoutine(AGENT, ROUTINE, KEY), true, 'the run started');

      const sent = [];
      const ws = { send: (raw) => sent.push(JSON.parse(raw)) };
      const noop = () => {};
      const ctx = {
        signals: { phaseTimer: () => ({ mark: noop, summary: () => '' }), reportStartup: noop },
        runtime: { killAllChildren: noop, cleanOrphanedProcesses: noop },
        workspace: {
          setWorkspaceRoot: (d) => config.setWorkspace(d),
          armAgentsDirWatcher: noop, armFileTreeWatcher: noop, healWorkspaceIfMoved: noop,
          saveRecentWorkspace: noop, fileTreeForSend: () => [],
        },
        agents: { armAgentsDirWatcher: noop, invalidateAgentCache: noop },
        store: { clearSearchFailure: noop, ensureSearchEngine: noop },
      broadcast: noop,
        // The switch tells every connected client where the scheduler went, so
        // a window that did not ask stops promising runs it will not get.
        broadcast: noop,
      };
      // WHAT PROVES THE SWITCH'S RESETS RAN, planted before the switch and
      // read after it.
      //
      // This test used to prove that from the run state's status: a live run
      // persists 'running', the load rewrote 'running' to 'interrupted', and
      // finding 'interrupted' meant the load had been through. It no longer
      // rewrites a run this process is still running, and correcting that is
      // the whole point of the change beside this one, so the proof has to
      // come from somewhere the correction cannot reach.
      //
      // Both stores the load rebuilds are given a fact that exists only on
      // disk, for a routine with no live run to complicate it. Neither value
      // can be in memory unless the load put it there, and only
      // loadRoutineState and the slot load it calls ever put them there. That
      // is a strictly wider proof than the status was: the status said the run
      // state had been rebuilt and said nothing at all about the slot records
      // being reloaded beside it.
      const PLANTED_KEY = 'planted:by-the-file';
      const PLANTED_STAMP = '2026-08-10T07:00:00.000Z';
      const OBSERVED_AT = '2026-08-10T07:01:00.000Z';
      const rundock = path.join(dir, '.rundock');
      const stateFile = path.join(rundock, 'routine-state.json');
      const onDisk = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      onDisk[PLANTED_KEY] = { lastRun: PLANTED_STAMP, status: 'completed', duration: 2 };
      fs.writeFileSync(stateFile, JSON.stringify(onDisk));
      fs.writeFileSync(path.join(rundock, 'routine-slots.json'),
        JSON.stringify({ observedAt: OBSERVED_AT, routines: {} }));
      assert.strictEqual(sched.routineState[PLANTED_KEY], undefined,
        'and it is only on disk: nothing in memory knows about it yet');
      assert.strictEqual(sched.routineSlots.observedAt, null,
        'nor about the observation beside it');

      const handlers = freshWorkspaceHandlers(sched);
      handlers.handleSetWorkspace(ctx, ws, { type: 'set_workspace', path: dir });
      assert.ok(sent.some(m => m.type === 'workspace_set'),
        'the switch ran its open path to the end rather than into the rollback');

      // REPLACES the assertion on KEY's status being rewritten to
      // 'interrupted', which said "the switch rebuilt the run state from the
      // workspace file" and now says it of a value the correction cannot
      // touch.
      assert.deepStrictEqual(sched.routineState[PLANTED_KEY],
        { lastRun: PLANTED_STAMP, status: 'completed', duration: 2 },
        'the switch rebuilt the run state from the workspace file');
      assert.strictEqual(sched.routineSlots.observedAt, OBSERVED_AT,
        'and reloaded the slot records beside it, which the old proof never covered');
      assert.strictEqual(sched.routineState[KEY].status, 'running',
        'while the run that is still going goes on saying so, which is what the switch must not change');
      assert.strictEqual(sched.executeRoutine(AGENT, ROUTINE, KEY), false,
        'and the hold survived it, because the child it describes is still running');
      child.emit('close', 0);
      assert.strictEqual(sched.executeRoutine(AGENT, ROUTINE, KEY), true,
        'the run ending is the only thing that releases it, switch or no switch');
      await endedAfter(sched, async () => { child.emit('close', 0); });
    });
  });
});

// AC-6, at the call site it is about rather than at one that stands in for it.
test('a start whose spawn throws does not hold the routine', async () => {
  await withTempWorkspaceAsync(async () => {
    await withFakeSpawn(() => { throw new Error('spawn refused'); }, async (sched) => {
      const start = () => sched.executeRoutine(AGENT, ROUTINE, KEY);
      assert.throws(start, /spawn refused/);
      assert.throws(start, /spawn refused/,
        'the second start reached the same throw, so the first one released the routine on its way out');
    });
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

// ===== A RUN CUT OFF BY A RESTART =====
// The routine state and the run's own record are two stores answering one
// question, and only the first of them was ever corrected on startup. A run
// the process died in the middle of loaded back as 'interrupted' in the state
// and stayed 'running' in its record, permanently, in the file the run-detail
// screen renders. The reason written there, 'running', is untrue: a run that
// will never run again is not running.
//
// WHAT THESE TESTS ARE CAREFUL OF, and it is the trap the observation card's
// own suite was built around: an unknown file list and an empty one look
// identical to a careless assertion. Every case below asserts the status and
// the reason that separate them, and the case with a transcript asserts a
// NON-EMPTY list whose contents could only have come from the file it wrote.
//
// $HOME IS CONSTRUCTED RATHER THAN INHERITED, in every one of them. The
// transcript root is $HOME/.claude/projects, so a test running under the
// developer's own home reads whatever transcripts happen to be on that machine
// and answers differently on the next one. A run with no transcript is the
// case two of these tests are about, and inheriting a home is how that case
// stops being reachable.

function enterTempHome() {
  const real = Object.prototype.hasOwnProperty.call(process.env, 'HOME') ? process.env.HOME : null;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-restart-home-'));
  process.env.HOME = home;
  return {
    home,
    leave() {
      // Restored by ABSENCE where it was absent: assigning back an undefined
      // leaves the string "undefined" behind, which is a home directory that
      // exists nowhere and would quietly change what every later test reads.
      if (real === null) delete process.env.HOME;
      else process.env.HOME = real;
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

function withTempHome(fn) {
  const t = enterTempHome();
  try { return fn(t.home); } finally { t.leave(); }
}

async function withTempHomeAsync(fn) {
  const t = enterTempHome();
  try { return await fn(t.home); } finally { t.leave(); }
}

// A transcript filed the way the agent tool files one: named for the session,
// under a directory named for the working directory the run happened in.
function writeTranscript(home, sessionId, lines) {
  const dir = path.join(home, '.claude', 'projects', '-w-restart');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), lines.join(''));
}

// Read straight off the disk rather than through readRunRecords, so what is
// asserted is the file a restarted process would meet rather than a reading
// performed by the module under test.
function runRecords(ws) {
  const dir = path.join(ws, '.rundock', 'runs');
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return []; }
  return names.map(n => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf-8')));
}

// The real workspace open path, driven for a scheduler that has only just been
// created. Boot calls loadRoutineState directly and the switch calls it through
// this handler, so driving the handler exercises the larger of the two, and
// neither one is the closer this card must not be proven by.
function openWorkspace(sched, dir, config) {
  const noop = () => {};
  const sent = [];
  const ws = { send: (raw) => sent.push(JSON.parse(raw)) };
  const ctx = {
    signals: { phaseTimer: () => ({ mark: noop, summary: () => '' }), reportStartup: noop },
    runtime: { killAllChildren: noop, cleanOrphanedProcesses: noop },
    workspace: {
      setWorkspaceRoot: (d) => config.setWorkspace(d),
      armAgentsDirWatcher: noop, armFileTreeWatcher: noop, healWorkspaceIfMoved: noop,
      saveRecentWorkspace: noop, fileTreeForSend: () => [],
    },
    agents: { armAgentsDirWatcher: noop, invalidateAgentCache: noop },
    store: { clearSearchFailure: noop, ensureSearchEngine: noop },
    // The switch announces where the scheduler went to every connected client.
    broadcast: noop,
  };
  freshWorkspaceHandlers(sched).handleSetWorkspace(ctx, ws, { type: 'set_workspace', path: dir });
  assert.ok(sent.some(m => m.type === 'workspace_set'),
    'the open path ran to the end rather than into the rollback');
}

/**
 * Start a run, lose the process it was running in, and open the workspace
 * again in a scheduler that never saw it.
 *
 * A SECOND PRIVATE MODULE INSTANCE IS WHAT A RESTART IS, from this file's
 * point of view. Which runs this process opened is module state, so a new
 * instance starts without it exactly as a new process does. Ending the child
 * would defeat the whole test: what is being reproduced is a run with no
 * ending, because the process that would have written one is gone.
 *
 * `beforeRestart` is handed the open record, so a test can put a transcript on
 * disk under the session id the run really allocated rather than one it made
 * up. The two are separate uuids and nothing may assume they match.
 */
async function restartAcrossALiveRun(dir, config, beforeRestart) {
  const child = new EventEmitter();
  await withFakeSpawn(() => child, async (dying) => {
    assert.strictEqual(dying.executeRoutine(AGENT, ROUTINE, KEY), true, 'the run started');
  });
  const open = runRecords(dir);
  assert.strictEqual(open.length, 1, 'the dead process left one record behind');
  assert.strictEqual(open[0].status, 'running', 'open, because only an ending closes one');
  if (beforeRestart) beforeRestart(open[0]);

  const restarted = freshScheduler();
  restarted.wireSchedulerDeps({ getWssClients: () => [] });
  openWorkspace(restarted, dir, config);

  const after = runRecords(dir);
  assert.strictEqual(after.length, 1, 'still one record, not a second one beside it');
  assert.strictEqual(after[0].id, open[0].id, 'and it is the one the run itself opened');
  return { before: open[0], record: after[0], sched: restarted };
}

// AC-1, AC-5 and AC-6. The restart is real: the run is live when the first
// scheduler is abandoned, and the second one is driven through the workspace
// open path rather than by calling the closer.
test('a run cut off by a restart stops claiming it is running, and agrees with the routine state', async () => {
  await withTempWorkspaceAsync(async (dir, config) => {
    await withTempHomeAsync(async () => {
      const { record, sched } = await restartAcrossALiveRun(dir, config);
      assert.notStrictEqual(record.status, 'running',
        'a run that will never run again is not running, and its record no longer says it is');
      assert.strictEqual(record.status, 'interrupted',
        'it carries the routine state own word for a run the process died inside');
      assert.strictEqual(sched.routineState[KEY].status, 'interrupted',
        'which is what the routine state says about that same run');
      assert.strictEqual(record.status, sched.routineState[KEY].status,
        'so the two stores agree about whether that run is still going');
    });
  });
});

// AC-3. 'running' was the untrue reason. What replaces it names which way the
// answer was lost rather than going quiet about it.
test('a run cut off by a restart names the reason its changes cannot be established', async () => {
  await withTempWorkspaceAsync(async (dir, config) => {
    await withTempHomeAsync(async () => {
      const { record } = await restartAcrossALiveRun(dir, config);
      assert.strictEqual(record.filesStatus, 'unknown',
        'nobody can say what a run interrupted with no transcript changed');
      assert.strictEqual(record.filesReason, 'no-transcript',
        'and the record names which way it could not be told, rather than keeping the untrue "running"');
    });
  });
});

// AC-4. The distinction the observation card went to real trouble to keep. A
// default of [] anywhere on this path erases it permanently and silently: the
// record would read as a run that changed nothing.
test('a restart never turns an unknown file list into an empty one', async () => {
  await withTempWorkspaceAsync(async (dir, config) => {
    await withTempHomeAsync(async () => {
      const { record } = await restartAcrossALiveRun(dir, config);
      // THE SETUP, ASSERTED BEFORE ANYTHING IS CONCLUDED FROM IT. An open
      // record already carries a null list, so a load that closed nothing
      // satisfies every assertion below without the closing existing at all.
      assert.strictEqual(record.status, 'interrupted',
        'the record really was closed by the restart, so the list below is one the closing wrote');
      assert.strictEqual(record.files, null, 'the list is absent');
      assert.ok(!Array.isArray(record.files),
        'and absent rather than empty, because an empty array is an answer and this is the lack of one');
      assert.strictEqual(record.filesStatus, 'unknown', 'with the status that says which of the two this is');
    });
  });
});

// AC-2. The transcript surviving a restart mid-run was one of the three named
// reasons the transcript was chosen over the live stream. This is the card
// collecting that.
test('where the transcript survives the restart, the record reports what the run changed', async () => {
  await withTempWorkspaceAsync(async (dir, config) => {
    await withTempHomeAsync(async (home) => {
      const { record } = await restartAcrossALiveRun(dir, config, (open) => {
        assert.ok(open.sessionId, 'the run opened a session of its own, which is what ties it to a transcript');
        writeTranscript(home, open.sessionId, [
          fx.prompt(open.sessionId, 'go'),
          fx.completed(open.sessionId, { file: '/w/written-before-the-restart.md', outcome: 'create' }),
        ]);
      });
      assert.strictEqual(record.filesStatus, 'known', 'the transcript on disk answered the question');
      assert.strictEqual(record.filesReason, null, 'with nothing standing in the way');
      assert.deepStrictEqual((record.files || []).map(f => f.path), ['/w/written-before-the-restart.md'],
        'and it names the file the transcript recorded, which is the only place that path could have come from');
    });
  });
});

// AC-8. The startup path is also the workspace-switch path, and a switch
// happens while runs of this process are still going. Their records are the
// one kind that is open for a true reason.
test('a run that is still going in this process keeps reporting running', async () => {
  await withTempWorkspaceAsync(async (dir) => {
    await withTempHomeAsync(async () => {
      const child = new EventEmitter();
      await withFakeSpawn(() => child, async (sched) => {
        assert.strictEqual(sched.executeRoutine(AGENT, ROUTINE, KEY), true, 'the run started');
        assert.strictEqual(runRecords(dir)[0].status, 'running', 'and its record says so');

        // Planted so the reload has something to prove it happened with. The
        // two assertions this test used to close on were the proof that the
        // load ran at all: the routine state came back rewritten. It no longer
        // is, for the live run this test is about, so the load needs a fact of
        // its own that only a load could deliver.
        const stateFile = path.join(dir, '.rundock', 'routine-state.json');
        const onDisk = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
        onDisk['planted:by-the-file'] = { lastRun: '2026-08-10T07:00:00.000Z', status: 'completed', duration: 2 };
        fs.writeFileSync(stateFile, JSON.stringify(onDisk));
        assert.strictEqual(sched.routineState['planted:by-the-file'], undefined, 'and it is only on disk');

        sched.loadRoutineState();

        assert.ok(sched.routineState['planted:by-the-file'], 'the reload really ran');

        const [record] = runRecords(dir);
        assert.strictEqual(record.status, 'running',
          'a run whose child is alive in this very process is not closed by a reload');
        assert.strictEqual(record.endedAt, null, 'nothing was written as its ending');
        assert.strictEqual(record.filesReason, 'running',
          'and its list is unsettled for the true reason, because it really has not finished');

        // WHERE THE TWO STORES USED TO DISAGREE, AND WHY THEY NO LONGER DO.
        // This is the account the previous version of these two assertions
        // asked for, written at the place it said the change would land.
        //
        // What the two assertions here used to say: that the routine state
        // came back 'interrupted' while the record stayed 'running', that the
        // two stores therefore disagreed knowingly, and that the record was
        // the one telling the truth. The reason given was that a file on disk
        // cannot tell a dead process's leftovers from a run that is still
        // going, while the record can, because this process knows which runs
        // it opened.
        //
        // What changed: the routine state is now read on the same evidence.
        // The in-flight set names every routine whose run this process started
        // and has not yet ended, so the load can tell the two apart in the
        // state exactly as the record close already did, and it does. The
        // disagreement was tolerated because closing a live run's record to
        // manufacture agreement would have been a lie; fixing it from the
        // other side costs no lie at all, and it is the fix, because the load
        // is also the workspace-switch path and a switch happens while runs
        // are still going.
        //
        // REPLACES 'the routine state was rewritten by the load' with the
        // opposite claim, and the notStrictEqual on the two stores with the
        // strictEqual that says they now agree.
        assert.strictEqual(sched.routineState[KEY].status, 'running',
          'the routine state is not rewritten for a run this process is still running');
        assert.strictEqual(record.status, sched.routineState[KEY].status,
          'so the two stores agree here, and both of them are right');

        child.emit('close', 0);
      });
    });
  });
});

// A record that is not open is not this card business. Rewriting one would
// replace a settled outcome, and the file list that came with it, on every
// startup for the life of the workspace.
test('a restart leaves a run that already reached an outcome exactly as it was', async () => {
  await withTempWorkspaceAsync(async (dir, config) => {
    await withTempHomeAsync(async () => {
      const child = new EventEmitter();
      await withFakeSpawn(() => child, async (sched) => {
        assert.strictEqual(sched.executeRoutine(AGENT, ROUTINE, KEY), true, 'the run started');
        child.emit('close', 0);
      });
      const [closed] = runRecords(dir);
      assert.strictEqual(closed.status, 'succeeded', 'the run reached its outcome before the process died');

      const restarted = freshScheduler();
      restarted.wireSchedulerDeps({ getWssClients: () => [] });
      openWorkspace(restarted, dir, config);

      assert.deepStrictEqual(runRecords(dir)[0], closed, 'and the restart rewrote no field of it');
    });
  });
});

// AC-7, and it is the way this card most likely breaks something already
// shipped. routineState.lastRun is the ONLY input to double-fire suppression.
// This card touches startup, which is where the stores are loaded together, so
// it is one line from stamping the moment an orphan was noticed into lastRun:
// that would type-check, would read as a tidy simplification, and would cost
// the routine the catch-up run it is still owed today.
//
// Both instants are constructed in LOCAL time, because getNextRun compares
// calendar days and hours in local time. A test that mixed a UTC literal into
// that comparison would answer differently by timezone, which is a test whose
// result depends on the machine it runs on.
test('closing a restart-orphaned record writes nothing to the value double-fire suppression reads', () => {
  withTempWorkspace((ws) => {
    withTempHome(() => {
      const cutOff = new Date(2026, 7, 11, 9, 0, 0);       // yesterday's run, cut off mid-flight
      const nextMorning = new Date(2026, 7, 12, 10, 0, 0);  // the restart, after today's slot passed
      const dir = path.join(ws, '.rundock');
      fs.mkdirSync(path.join(dir, 'runs'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'routine-state.json'), JSON.stringify({
        [KEY]: { lastRun: cutOff.toISOString(), status: 'running', duration: null },
      }));
      fs.writeFileSync(path.join(dir, 'runs', 'orphan.json'), JSON.stringify({
        id: 'orphan', agent: 'runner', routine: 'r', sessionId: null,
        status: 'running', startedAt: cutOff.toISOString(), endedAt: null,
        durationMs: null, error: null, files: null, filesStatus: 'unknown', filesReason: 'running',
      }));

      const sched = freshScheduler();
      sched.wireSchedulerDeps({ getWssClients: () => [], now: () => nextMorning });
      sched.loadRoutineState();

      // THE SETUP, ASSERTED BEFORE ANYTHING IS CONCLUDED FROM IT. A load that
      // closed nothing would satisfy every assertion below while proving
      // nothing about the closing.
      assert.strictEqual(runRecords(ws)[0].status, 'interrupted',
        'the orphaned record really was closed by this load');

      assert.deepStrictEqual(sched.routineState[KEY],
        { lastRun: cutOff.toISOString(), status: 'interrupted', duration: null },
        'and the run state carries what it carried, with only the status the load already rewrote');
      assert.strictEqual(sched.routineState[KEY].lastRun, cutOff.toISOString(),
        'lastRun byte for byte the value on disk, untouched by the closing');
      assert.deepStrictEqual(sched.getNextRun('every day at 09:00', sched.routineState[KEY].lastRun),
        new Date(2026, 7, 12, 9, 0, 0),
        'so the catch-up run this routine is still owed today is still owed');
    });
  });
});

// A start that threw is an ending too, and it has to leave the run
// unreachable. A handle left in the map would answer every later stop with yes
// while signalling at a process id that no longer belongs to anything of ours.
test('a start that throws leaves no run behind for a later stop to find', async () => {
  await withTempWorkspaceAsync(async (dir) => {
    await withTempHomeAsync(async () => {
      const signalled = [];
      await withFakeSpawn(() => { throw new Error('spawn refused'); }, async (sched) => {
        assert.throws(() => sched.executeRoutine(AGENT, ROUTINE, KEY), /spawn refused/,
          'the start threw, having opened a record first');
        const [record] = runRecords(dir);
        assert.ok(record, 'the record it opened on the way is on disk');
        assert.strictEqual(record.status, 'failed', 'closed as a failure by the guard that rethrew');

        assert.deepStrictEqual(sched.runningRuns(), [],
          'and nothing is listed as going, because that run is over');
        assert.strictEqual(sched.cancelRun(record.id), false,
          'so a stop aimed at the id its record was opened under is refused');
        assert.deepStrictEqual(signalled, [], 'and signals nothing');
      }, (target, signal) => { signalled.push([target, signal]); });
    });
  });
});

// ===== A CHILD THAT WILL NOT GO WHEN ASKED =====
//
// The ordinary stop ASKS. On this runtime it is a termination signal, and a
// process is entitled to trap it, to take its time, or to ignore it outright,
// and this codebase has children that trap theirs. The signaller does not
// escalate on its own, so a child that ignores the ask goes on running, its
// ending never arrives, the single-flight hold is never released, and the
// routine never runs again for the life of the process, while every further
// stop request answers yes and sends nothing.
//
// That is a routine that was stopped and never runs again, which is worse than
// one that could not be stopped at all. So this drives a real child that really
// traps the signal, with the real signaller, and asks twice.
test('a routine whose child ignores the first stop is released by the second, and runs at its next slot', async (t) => {
  await withTempWorkspaceAsync(async (dir) => {
    await withTempHomeAsync(async () => {
      const claude = require(CLAUDE_KEY);
      const realSignaller = claude.killProcessTree;
      writeRoutineAgent(dir, [{ name: 'late', schedule: 'every day at 23:00', prompt: 'p', enabled: true }]);

      const spawned = [];
      const trapping = [];
      // Traps the termination signal and carries on, which is the whole
      // fixture: nothing here can be ended by asking.
      //
      // IT SAYS WHEN THE TRAP IS UP, and waiting for that is not politeness. A
      // child signalled between its spawn and the line that installs the
      // handler dies on the default handling, which is a fixture proving the
      // opposite of what it was written for while looking exactly like a fix
      // that works. This one did that first.
      const spawnStubbornChild = () => {
        const proc = require('node:child_process').spawn(
          process.execPath,
          ['-e', "process.on('SIGTERM', () => {}); console.log('trapping'); setInterval(() => {}, 100000)"],
          { detached: true, stdio: ['ignore', 'pipe', 'ignore'] },
        );
        proc.stdout.setEncoding('utf-8');
        proc.stdout.on('data', (chunk) => { if (chunk.includes('trapping')) trapping.push(proc.pid); });
        spawned.push(proc);
        return proc;
      };

      let clock = new Date(2026, 7, 12, 23, 0, 0);
      try {
        await withFakeSpawn(spawnStubbornChild, async (sched) => {
          sched.wireSchedulerDeps({ getWssClients: () => [], now: () => clock });
          t.mock.timers.enable({ apis: ['setInterval'] });
          try {
            sched.startScheduler();
            t.mock.timers.tick(60_000);
            assert.strictEqual(spawned.length, 1, 'the slot fired the routine');

            assert.ok(await until(() => trapping.length === 1, 600),
              'the child has its trap up, so what follows is about a signal being refused');

            const [live] = sched.runningRuns();
            assert.ok(live, 'the run is reachable');
            assert.strictEqual(sched.cancelRun(live.id), true, 'and the first stop is asked for');

            // THE ASK IS REFUSED, asserted rather than assumed, because
            // everything below is only worth anything if the child survived
            // it. Given time to die and still here afterwards.
            await until(() => false, 30);
            assert.strictEqual(sched.routineState[LATE_KEY].status, 'running',
              'the child trapped the signal and carried on, so the run is still going');
            assert.strictEqual(spawned[0].exitCode, null, 'and its process is genuinely still alive');

            // A SECOND REQUEST INSIDE THE WAIT IS STILL ONLY AN ASK. Somebody
            // pressing twice in a moment is not evidence the first ask failed.
            clock = new Date(2026, 7, 12, 23, 0, 1);
            assert.strictEqual(sched.cancelRun(live.id), true, 'a request a second later is answered');
            await until(() => false, 20);
            assert.strictEqual(sched.routineState[LATE_KEY].status, 'running',
              'and sends nothing stronger yet, because the first ask has not had its time');

            // Once that time is up, asking again sends the signal a child
            // cannot decline.
            clock = new Date(2026, 7, 12, 23, 0, 5);
            assert.strictEqual(sched.cancelRun(live.id), true, 'the request after the wait is answered');
            assert.ok(await until(() => sched.routineState[LATE_KEY].status !== 'running', 600),
              'and this one ended the child, which no signal it could trap would have done');
            assert.strictEqual(sched.routineState[LATE_KEY].status, 'cancelled', 'recorded as a stop');
            assert.strictEqual(runRecords(dir)[0].status, 'cancelled', 'in the record too');

            // AND THE POINT OF ALL OF IT. A routine that was stopped and never
            // runs again is worse than one that could not be stopped.
            clock = new Date(2026, 7, 13, 23, 0, 0);
            t.mock.timers.tick(60_000);
            assert.strictEqual(spawned.length, 2,
              'the next slot fired it, so the hold a stubborn child used to keep forever is gone');
            assert.ok(await until(() => sched.runningRuns().length > 0), 'the second run is going');
            assert.ok(await until(() => trapping.length === 2, 600), 'and its child has its trap up too');
            const [next] = sched.runningRuns();
            sched.cancelRun(next.id);
            clock = new Date(2026, 7, 13, 23, 0, 5);
            sched.cancelRun(next.id);
            assert.ok(await until(() => sched.routineState[LATE_KEY].status !== 'running', 600),
              'and it can be ended the same way');
          } finally {
            sched.stopScheduler();
            t.mock.timers.reset();
          }
        }, realSignaller);
      } finally {
        for (const proc of spawned) { try { process.kill(-proc.pid, 'SIGKILL'); } catch (e) { /* already gone */ } }
      }
    });
  });
});

// ===== THE STOP, AGAINST THE SIGNALLER THAT REALLY SENDS IT =====
//
// The other runtime's stop is pinned against the real client because a wrong
// method name is swallowed, logged, and the run recorded as stopped while it
// goes on running. This runtime has the same hazard and needs the same proof:
// every other test here stands the signaller in, deliberately, so nothing else
// in this file shows that the name the scheduler imports exists, that it takes
// a child handle rather than only a process id, or that signalling through it
// produces the close the ending depends on.
//
// So this one uses the real export against a real child. The child is a node
// process of the suite's own making rather than anything resembling an agent:
// what is under test is the signalling, not what is signalled.
test('the signaller the scheduler imports is real, takes a child handle, and ends the run', async () => {
  await withTempWorkspaceAsync(async (dir) => {
    await withTempHomeAsync(async () => {
      // THE EXPORT ITSELF, resolved unstubbed, under the name the scheduler
      // destructures. A rename in the runtime module leaves this undefined,
      // and leaves the scheduler's own binding undefined with it.
      const claude = require(CLAUDE_KEY);
      assert.strictEqual(typeof claude.killProcessTree, 'function',
        'the name the scheduler imports as its signaller is not a function on the runtime module');
      const realSignaller = claude.killProcessTree;

      // A child that will not exit on its own, so the close below can only
      // have come from the signal. Detached, which is what the signaller
      // relies on to reach a whole process group.
      const spawned = [];
      const spawnRealChild = () => {
        const proc = require('node:child_process').spawn(
          process.execPath, ['-e', 'setInterval(() => {}, 100000)'],
          { detached: true, stdio: 'ignore' },
        );
        spawned.push(proc);
        return proc;
      };

      try {
        // The real export is handed in deliberately, so the scheduler's own
        // destructured binding is the real function rather than a stand-in.
        await withFakeSpawn(spawnRealChild, async (sched) => {
          assert.strictEqual(sched.executeRoutine(AGENT, ROUTINE, KEY), true, 'the run started');
          assert.strictEqual(spawned.length, 1, 'and really spawned a child');
          assert.ok(spawned[0].pid, 'with a process id, which is what a signal needs');
          assert.strictEqual(runRecords(dir)[0].status, 'running', 'its record is open');

          const [live] = sched.runningRuns();
          assert.ok(live, 'the run is reachable');
          assert.strictEqual(sched.cancelRun(live.id), true, 'and is stopped');

          // Nothing here emits a close. If the signal did not reach the child,
          // this waits out its tries and fails, which is the whole point.
          assert.ok(await until(() => sched.routineState[KEY].status !== 'running', 600),
            'the child really ended, so the signal reached it through the handle it was given');
          assert.strictEqual(sched.routineState[KEY].status, 'cancelled', 'recorded as a stop');
          assert.strictEqual(runRecords(dir)[0].status, 'cancelled', 'in the record too');
          assert.strictEqual(sched.executeRoutine(AGENT, ROUTINE, KEY), true, 'and the routine was released');
          await endedAfter(sched, async () => {
            const next = sched.runningRuns()[0];
            assert.ok(next, 'the second run is reachable');
            sched.cancelRun(next.id);
          });
        }, realSignaller);
      } finally {
        for (const proc of spawned) { try { process.kill(-proc.pid, 'SIGKILL'); } catch (e) { /* already gone */ } }
      }
    });
  });
});

// WHAT 'cancelled' CLAIMS, pinned rather than left to be inferred from the one
// path where a stop plainly worked.
//
// The word means a stop was asked for before the run ended. It does not claim
// the stop is what ended it, and nothing in the scheduler could support the
// stronger reading: the signal is delivered by the operating system and the
// ending is whatever the child reports. This drives the case furthest from the
// stronger reading, where the signal never left at all and the child then
// exited successfully of its own accord, so that the meaning cannot be
// quietly narrowed later without this turning red.
test('a run whose stop never left, and which then ends well, reads as what it really was', async () => {
  await withTempWorkspaceAsync(async (dir) => {
    await withTempHomeAsync(async () => {
      const child = Object.assign(new EventEmitter(), { pid: 4245 });
      let attempts = 0;
      await withFakeSpawn(() => child, async (sched) => {
        assert.strictEqual(sched.executeRoutine(AGENT, ROUTINE, KEY), true, 'the run started');
        const [live] = sched.runningRuns();

        // CANCELLED MEANS DELIVERED. The signaller throws, so the ask never
        // went, and the caller is told so rather than told a comfortable yes.
        assert.strictEqual(sched.cancelRun(live.id), false, 'the ask did not go, and the caller is told');
        assert.strictEqual(attempts, 1, 'though it did reach the signaller');

        // The child exits ZERO, on its own, untouched: the signal never left,
        // so nothing about this ending was caused by the stop.
        child.emit('close', 0);
        assert.ok(await until(() => sched.routineState[KEY].status !== 'running'), 'the run ended');

        assert.strictEqual(runRecords(dir)[0].status, 'succeeded',
          'and reads as the ending it actually had, because no stop was ever delivered');
        assert.notStrictEqual(runRecords(dir)[0].status, 'cancelled',
          'never as a stop the user would wrongly believe worked');
        assert.strictEqual(sched.routineState[KEY].status, 'completed',
          'in the vocabulary that store uses for the same fact');
      }, () => { attempts += 1; throw new Error('no such process'); });
    });
  });
});

// ===== THE STOP, AGAINST THE CLIENT THAT REALLY RECEIVES IT =====
//
// The codex stopper calls a method on whatever getCodexAppServer returned. A
// test that supplies its own object with a method of that name proves the
// scheduler calls something it was handed, and nothing about whether the real
// client has such a method or takes the thread id first. If it does not, the
// call throws a TypeError, stopLiveRun logs it, the turn goes on running and
// the run is recorded as stopped: the "recorded, and then did not happen"
// failure this whole section exists to remove, one layer further down.
//
// So these drive the REAL client class, the one getCodexAppServer builds,
// against the repository's stub app-server, and read the wire. The stub logs
// every request it receives, so what is asserted is that an interrupt naming
// this thread left the client, not that a double was called.

// The real client, over the stub binary, shut down before the test returns so
// no app-server outlives it.
async function withRealCodexClient(dir, fn) {
  const server = createCodexAppServer({ binPath: STUB_CODEX, cwd: dir, requestTimeoutMs: 15000 });
  try {
    await server.start();
    return await fn(server);
  } finally {
    await server.shutdown();
  }
}

// Every request the stub app-server received, read off its own log.
function stubRequests(dir) {
  const file = path.join(dir, 'stub-invocations.jsonl');
  let raw;
  try { raw = fs.readFileSync(file, 'utf-8'); } catch (e) { return []; }
  return raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

async function untilRequest(dir, method, tries = 400) {
  let hit = null;
  await until(() => (hit = stubRequests(dir).find(e => e.method === method)) != null, tries);
  return hit;
}

// A turn that will not end on its own, so there is something still running to
// stop. The stub completes such a turn only when an interrupt reaches it,
// which is what makes the ending below evidence that one did.
const HANGING_ROUTINE = { name: 'r', prompt: 'keep going until somebody stops this run' };

function writeHangingScenario(dir) {
  fs.writeFileSync(path.join(dir, 'stub-codex-scenario.json'), JSON.stringify({
    appServer: {
      rules: [{
        match: { promptIncludes: HANGING_ROUTINE.prompt },
        deltas: ['working '],
        hangAfterDeltas: true,
      }],
    },
  }));
}

test('stopping a codex run sends the real client an interrupt naming the thread its turn is on', async () => {
  await withTempWorkspaceAsync(async (dir) => {
    await withTempHomeAsync(async () => {
      const CODEX_AGENT = realCodexAgent(dir);
      writeHangingScenario(dir);
      await withRealCodexClient(dir, async (server) => {
        await withFakeCodex(server, async (sched) => {
          assert.strictEqual(sched.executeRoutine(CODEX_AGENT, HANGING_ROUTINE, KEY), true, 'the run started');

          // The thread the turn is really on, taken off the wire rather than
          // from anything this test chose.
          const started = await untilRequest(dir, 'turn/start');
          assert.ok(started, 'the run reached a turn on the app-server');
          const threadId = started.params.threadId;
          assert.ok(threadId, 'which is filed under a thread');

          // THE TURN IS GENUINELY STILL GOING, asserted rather than assumed,
          // and this is what makes the ending below evidence of anything. The
          // ending is what proves the interrupt landed, and it only proves
          // that if the turn would not have ended anyway. Given time to
          // finish and asserted still unfinished afterwards, so an app-server
          // that stopped holding this turn open fails here rather than
          // passing further down on the recorded word alone.
          await until(() => false, 20);
          assert.strictEqual(sched.routineState[KEY].status, 'running',
            'the turn has not ended on its own, so it is being held open as this fixture asks');
          assert.strictEqual(runRecords(dir)[0].status, 'running', 'and its record says so too');
          assert.strictEqual(stubRequests(dir).filter(e => e.method === 'turn/interrupt').length, 0,
            'and nothing has been interrupted yet, so the stop below is the first');

          const [live] = sched.runningRuns();
          assert.ok(live, 'the run is reachable');
          assert.strictEqual(sched.cancelRun(live.id), true, 'and is stopped');

          // THE ASSERTION THE STAND-IN COULD NOT MAKE. This entry exists only
          // if the real client has the method the scheduler calls and sent a
          // request for it, and its thread is the one the client's own turn
          // was started on. Rename the method on the client and no entry
          // arrives; change which parameter carries the thread and this
          // compares unequal.
          const interrupt = await untilRequest(dir, 'turn/interrupt');
          assert.ok(interrupt, 'an interrupt left the client and reached the app-server');
          assert.strictEqual(interrupt.params.threadId, threadId,
            'naming the thread the turn is on rather than some other identifier');

          assert.ok(await until(() => sched.routineState[KEY].status !== 'running'),
            'the interrupted turn then ended, which the stub only does when an interrupt reaches it');
          assert.strictEqual(sched.routineState[KEY].status, 'cancelled', 'recorded as a stop');
          assert.strictEqual(sched.executeRoutine(CODEX_AGENT, HANGING_ROUTINE, KEY), true,
            'and the routine was released');
          await endedAfter(sched, async () => {
            const [next] = sched.runningRuns();
            assert.ok(next, 'the second run is reachable, which is what ends it');
            sched.cancelRun(next.id);
          });
        });
      });
    });
  });
});

// A stop asked for before there is anything to send it with. On this runtime
// that window is several awaits wide: the app-server may still be booting, and
// a thread and a turn have to exist before a turn can be interrupted. The
// intent is remembered and honoured when the turn appears, and the client
// holds the interrupt until the turn it names has been acknowledged, so it is
// sent once and it is not refused for arriving early.
test('a codex run stopped before its turn exists never starts one', async () => {
  await withTempWorkspaceAsync(async (dir) => {
    await withTempHomeAsync(async () => {
      const CODEX_AGENT = realCodexAgent(dir);
      writeHangingScenario(dir);
      await withRealCodexClient(dir, async (server) => {
        await withFakeCodex(server, async (sched) => {
          assert.strictEqual(sched.executeRoutine(CODEX_AGENT, HANGING_ROUTINE, KEY), true, 'the run started');

          // BEFORE THE TURN EXISTS, asserted rather than assumed: the run is
          // already reachable, and nothing has reached the app-server yet.
          assert.deepStrictEqual(stubRequests(dir).filter(e => e.method === 'turn/start'), [],
            'no turn has been started, so there is nothing yet to interrupt');
          const [live] = sched.runningRuns();
          assert.ok(live, 'and the run is reachable all the same');
          assert.strictEqual(sched.cancelRun(live.id), true, 'so it can be stopped now');

          // THE ENTIRE PURPOSE OF STOPPING A ROUTINE IS TO STOP IT DOING
          // THINGS. A stop that arrived before the turn is honoured by never
          // starting the turn: no thread, no turn, no interrupt, because
          // there is nothing to interrupt, asserted on the wire.
          assert.ok(await until(() => sched.routineState[KEY].status !== 'running'), 'the run ended');
          assert.strictEqual(sched.routineState[KEY].status, 'cancelled', 'recorded as a stop');
          const wire = stubRequests(dir);
          assert.deepStrictEqual(wire.filter(e => e.method === 'thread/start'), [],
            'no thread was started either: the stop arrived before the thread, so the '
            + 'earlier of the two checkpoints is the one that has to hold, and a run '
            + 'that started a thread it never used would prove only the later one');
          assert.deepStrictEqual(wire.filter(e => e.method === 'turn/start'), [],
            'no turn start ever reached the app server');
          assert.deepStrictEqual(wire.filter(e => e.method === 'turn/interrupt'), [],
            'and nothing needed interrupting, because nothing was started');
        });
      });
    });
  });
});

// The LATER of the two checkpoints, witnessed on its own. The test above
// cancels before the thread, so the earlier checkpoint honours the stop and
// the later one is never consulted; deleting the later one alone would leave
// that test green. This one lets the run pass the earlier checkpoint, lands
// the stop while the thread is still starting, and requires that no turn
// begins: the window between thread and turn is exactly where a run gains
// write access, so this is the point at which the check most matters.
test('a stop that lands while the thread is starting still prevents the turn', async () => {
  await withTempWorkspaceAsync(async (dir) => {
    await withTempHomeAsync(async () => {
      const CODEX_AGENT = realCodexAgent(dir);
      const { thread } = await realCodexRun();
      let releaseThread;
      const threadGate = new Promise((res) => { releaseThread = res; });
      let threadAsked;
      const askedThread = new Promise((res) => { threadAsked = res; });
      let turnsStarted = 0;
      const server = {
        startThread: async () => { threadAsked(); await threadGate; return thread; },
        startTurn: () => { turnsStarted += 1; return new EventEmitter(); },
        interruptTurn: async () => {},
      };
      await withFakeCodex(server, async (sched) => {
        assert.strictEqual(sched.executeRoutine(CODEX_AGENT, ROUTINE, KEY), true, 'the run started');
        // PAST THE EARLIER CHECKPOINT, proven rather than assumed: the thread
        // request has been made, so the first check already answered "go on".
        await askedThread;
        const [live] = sched.runningRuns();
        assert.ok(live, 'the run is reachable while its thread starts');
        assert.strictEqual(sched.cancelRun(live.id), true, 'and the stop is accepted there');
        releaseThread();
        assert.ok(await until(() => sched.routineState[KEY].status !== 'running'), 'the run ended');
        assert.strictEqual(sched.routineState[KEY].status, 'cancelled', 'recorded as a stop');
        assert.strictEqual(turnsStarted, 0,
          'and the turn never started: a thread the stop overtook is abandoned before the work');
      });
    });
  });
});

// A signal that never left has not created the hazard the send-once guard
// exists for, which is a second signal to a process id that may by then belong
// to somebody else. Discarding the stopper on a failed attempt leaves the run
// going with nothing able to stop it and every later request answering yes.
test('a stop that could not be sent is retried by the next request, and one that was sent is not', async () => {
  await withTempWorkspaceAsync(async (dir) => {
    await withTempHomeAsync(async () => {
      const child = Object.assign(new EventEmitter(), { pid: 4244 });
      const attempts = [];
      let refuse = true;
      await withFakeSpawn(() => child, async (sched) => {
        assert.strictEqual(sched.executeRoutine(AGENT, ROUTINE, KEY), true, 'the run started');
        const [live] = sched.runningRuns();

        assert.strictEqual(sched.cancelRun(live.id), false, 'the first ask did not go, and says so');
        assert.strictEqual(attempts.length, 1, 'though it reached the signaller');
        assert.strictEqual(sched.routineState[KEY].status, 'running',
          'the run is still going, because nothing was actually signalled');

        assert.strictEqual(sched.cancelRun(live.id), false, 'the second ask did not go either');
        assert.strictEqual(attempts.length, 2,
          'and reached the signaller again, because the first signal never left');

        // Now let one land. After that the guard applies: a signal that did go
        // out is not sent a second time to a process id that may be reused.
        refuse = false;
        assert.strictEqual(sched.cancelRun(live.id), true, 'the third ask went');
        assert.strictEqual(attempts.length, 3, 'and landed');
        assert.strictEqual(sched.cancelRun(live.id), true, 'a fourth request is still answered');
        assert.strictEqual(attempts.length, 3,
          'but does not repeat the signal that has already gone out. This test moves in '
          + 'milliseconds, so it is inside the wait a further request has to clear before it may '
          + 'send a stronger signal; what happens once that wait is over has its own test');

        child.emit('close', null);
        assert.ok(await until(() => sched.routineState[KEY].status !== 'running'), 'the run ended');
        assert.strictEqual(sched.routineState[KEY].status, 'cancelled', 'as a stop');
      }, (target, signal) => {
        attempts.push([target, signal]);
        if (refuse) throw new Error('no such process');
      });
    });
  });
});

// The asynchronous half of the same thing, and the reason the stopper cannot
// simply be called and forgotten. Driven through a stand-in here because what
// is under test is what this file does with a refusal, not what the client
// calls its interrupt: the call shape is pinned against the real client above.
test('a stop whose request is refused lets nothing escape, and the run still ends', async () => {
  await withTempWorkspaceAsync(async (dir) => {
    await withTempHomeAsync(async () => {
      const CODEX_AGENT = realCodexAgent(dir);
      const run = await realCodexRun();
      const { thread } = run;
      const sub = new EventEmitter();
      let asked = 0;
      const server = {
        startThread: async () => thread,
        startTurn: () => sub,
        interruptTurn: async () => { asked += 1; throw new Error('no active turn to interrupt'); },
      };
      await withFakeCodex(server, async (sched) => {
        assert.strictEqual(sched.executeRoutine(CODEX_AGENT, ROUTINE, KEY), true, 'the run started');
        assert.ok(await until(() => sub.listenerCount('event') > 0), 'and reached its turn');

        const [live] = sched.runningRuns();
        assert.strictEqual(sched.cancelRun(live.id), true, 'the stop was asked for');
        assert.ok(await until(() => asked > 0), 'and the request was made');

        // A rejected request is not an ending. The turn is still going, and
        // the only thing that ends it is the turn itself.
        assert.strictEqual(sched.routineState[KEY].status, 'running',
          'the refusal did not end the run, because a refused stop stopped nothing');

        // Asked once, then waited on. Calling the stop inside a poll
        // predicate makes the poll itself the thing being tested, and hides
        // how many requests it took.
        assert.strictEqual(sched.cancelRun(live.id), true, 'a later request is answered');
        assert.ok(await until(() => asked > 1),
          'and tries again rather than answering yes and sending nothing');

        sub.emit('event', run.done);
        assert.ok(await until(() => sched.routineState[KEY].status !== 'running'), 'the turn then ended');
        // ENDED AS WHAT IT REALLY WAS. Both stops were refused, so no stop
        // was ever delivered to this run, and the rejection handler must have
        // cleared the cancelled flag both times: a record reading 'cancelled'
        // here would tell the user a stop worked that they were just told did
        // not, which is the precise falsehood the delivered-not-requested
        // rule exists to remove.
        assert.strictEqual(sched.routineState[KEY].status, 'completed',
          'a run whose every stop was refused ends as the ending it really had, never as a stop');
        assert.strictEqual(sched.executeRoutine(CODEX_AGENT, ROUTINE, KEY), true, 'and released the routine');
        await endedAfter(sched, async () => {
          await until(() => sub.listenerCount('event') > 1);
          sub.emit('event', run.done);
        });
      });
    });
  });
});

// ===== REACHING A RUN THAT IS STILL GOING =====
//
// A routine that has gone wrong is exactly the one somebody wants to stop, and
// until now the only remedy was quitting the application: the child was a
// local of the function that spawned it, so nothing outside the run could
// reach it, and the record had no state for a run somebody stopped.
//
// The identity is the RUN's own uuid rather than the routine key, because that
// is what a record is filed under and the key is neither unique nor stable.

test('a routine whose run is going can be reached from outside it and stopped', async () => {
  await withTempWorkspaceAsync(async (dir) => {
    await withTempHomeAsync(async () => {
      const child = Object.assign(new EventEmitter(), { pid: 4242 });
      const signalled = [];
      await withFakeSpawn(() => child, async (sched) => {
        assert.strictEqual(sched.executeRoutine(AGENT, ROUTINE, KEY), true, 'the run started');

        // IDENTIFIED BEFORE IT IS STOPPED, because a caller outside the run
        // holds an id and nothing else, and an id that named nothing would
        // make the stop below unreachable in the product however well it
        // worked when a test handed it the answer.
        const live = sched.runningRuns();
        assert.strictEqual(live.length, 1, 'the run that is going can be listed from outside it');
        assert.strictEqual(live[0].agent, AGENT.id, 'and says which agent it belongs to');
        assert.strictEqual(live[0].routine, ROUTINE.name, 'and which routine');
        assert.strictEqual(live[0].id, runRecords(dir)[0].id,
          'under the id its record is filed by, which is the run own uuid rather than the routine key');
        assert.strictEqual(live[0].key, KEY,
          'and it names the routine it is held under, which is what the single-flight key is');
        assert.strictEqual(live[0].startedAt, runRecords(dir)[0].startedAt,
          'and when it began, the same instant its record carries');

        assert.strictEqual(sched.cancelRun(live[0].id), true, 'and it can be stopped');
        assert.deepStrictEqual(signalled, [[child, 'SIGTERM']],
          'through the handle the run held, and to the whole tree the run started rather than to one process');

        // A signalled child closes with no exit code, which is not the same
        // event as a child that ran and exited non-zero.
        child.emit('close', null);
        assert.ok(await until(() => sched.routineState[KEY].status !== 'running'), 'the run then ended');

        const [record] = runRecords(dir);
        assert.strictEqual(record.status, 'cancelled',
          'and the record says somebody stopped it');
        assert.notStrictEqual(record.status, 'failed',
          'rather than that it failed, which is a different fact about a different run');
        assert.strictEqual(record.error, null, 'with no reason, because nothing went wrong');
        assert.ok(record.endedAt, 'and a real ending: this one was witnessed, unlike a run nobody saw stop');
        assert.strictEqual(typeof record.durationMs, 'number', 'of a known length, for the same reason');
        // The ending really ran, which is what separates a stopped run from an
        // abandoned one. There is no transcript in this fixture, so 'unknown'
        // is the honest answer to what it changed; what matters is that the
        // reason is the observation's rather than the untrue 'running' the
        // opening wrote.
        assert.strictEqual(record.filesReason, 'no-transcript',
          'and the ending settled what it changed, rather than leaving the opening untrue "running"');
        assert.strictEqual(sched.routineState[KEY].status, 'cancelled',
          'the routine state says the same word, so the two stores describe it in one vocabulary');
        assert.deepStrictEqual(sched.runningRuns(), [],
          'and a run that has ended is no longer reachable');
      }, (target, signal) => { signalled.push([target, signal]); });
    });
  });
});

// A cancelled routine that never runs again is worse than one that could not
// be cancelled, so the single-flight hold has to be released by a stop exactly
// as it is by an ordinary ending.
//
// DRIVEN THROUGH THE TICK, with a real agent file and a real schedule, rather
// than by asking executeRoutine whether it would start. The hold is what
// executeRoutine reads, so asking it is close to asking the guard about
// itself; what the routine is owed is a run at its next slot, and this waits
// for one.
test('a routine whose run was stopped fires again at its next slot', async (t) => {
  await withTempWorkspaceAsync(async (dir) => {
    await withTempHomeAsync(async () => {
      writeRoutineAgent(dir, [{ name: 'late', schedule: 'every day at 23:00', prompt: 'p', enabled: true }]);
      const children = [];
      let clock = new Date(2026, 7, 12, 23, 0, 0);
      await withFakeSpawn(() => {
        const c = Object.assign(new EventEmitter(), { pid: 1000 + children.length });
        children.push(c);
        return c;
      }, async (sched) => {
        sched.wireSchedulerDeps({ getWssClients: () => [], now: () => clock });
        t.mock.timers.enable({ apis: ['setInterval'] });
        try {
          sched.startScheduler();
          t.mock.timers.tick(60_000);
          assert.strictEqual(children.length, 1, 'the slot fired the routine');

          clock = new Date(2026, 7, 12, 23, 5, 0);
          const [live] = sched.runningRuns();
          assert.ok(live, 'the run is reachable');
          assert.strictEqual(sched.cancelRun(live.id), true, 'and is stopped part way through');
          children[0].emit('close', null);
          assert.ok(await until(() => sched.routineState[LATE_KEY].status !== 'running'), 'the run ended');
          assert.strictEqual(sched.routineState[LATE_KEY].status, 'cancelled', 'as a stop');

          // RELEASED BUT NOT UNSUPPRESSED, and the two are different. A stop
          // that also cleared the period's stamp would fire the routine again
          // sixty seconds later, all night.
          clock = new Date(2026, 7, 12, 23, 30, 0);
          t.mock.timers.tick(60_000);
          assert.strictEqual(children.length, 1,
            'the rest of the period is still held, exactly as it is after any other ending');

          clock = new Date(2026, 7, 13, 23, 0, 0);
          t.mock.timers.tick(60_000);
          assert.strictEqual(children.length, 2,
            'and the next slot fired it, which is what a stop must not cost the routine');
          children[1].emit('close', 0);
          assert.ok(await until(() => sched.routineState[LATE_KEY].status !== 'running'), 'and that run ended too');
        } finally {
          sched.stopScheduler();
          t.mock.timers.reset();
        }
      }, () => {});
    });
  });
});

// Stopping a run is a request from outside, so it arrives whenever it likes,
// including after the run it names has already finished. Every one of those is
// a no, said quietly.
test('stopping a run that has already ended is harmless', async () => {
  await withTempWorkspaceAsync(async (dir) => {
    await withTempHomeAsync(async () => {
      const child = Object.assign(new EventEmitter(), { pid: 4243 });
      const signalled = [];
      await withFakeSpawn(() => child, async (sched) => {
        assert.strictEqual(sched.cancelRun('a-run-that-never-existed'), false,
          'an id nothing answers to is refused rather than thrown at');

        assert.strictEqual(sched.executeRoutine(AGENT, ROUTINE, KEY), true, 'a run started');
        const [live] = sched.runningRuns();
        await endedAfter(sched, async () => { child.emit('close', 0); });

        const [record] = runRecords(dir);
        assert.strictEqual(record.status, 'succeeded', 'and reached its own ending first');

        assert.strictEqual(sched.cancelRun(live.id), false,
          'so stopping it now is refused: there is nothing left to stop');
        assert.deepStrictEqual(signalled, [],
          'and nothing was signalled, which matters because that id belonged to a real process');
        assert.deepStrictEqual(runRecords(dir)[0], record,
          'the settled record is untouched, still saying how the run really ended');
        assert.strictEqual(sched.routineState[KEY].status, 'completed',
          'and so is the routine state');
      }, (target, signal) => { signalled.push([target, signal]); });
    });
  });
});

// THE OTHER RUNTIME, because a run is a run. A stop that reached only the
// runtime whose child is a process would leave every routine on the other one
// exactly as unreachable as both used to be, and nothing would say so.
//
// A codex run has no child of its own to signal: it is a turn on the shared
// app-server, and the way to stop one is the client own interrupt, which ends
// the turn through the same terminal event every other codex ending arrives
// by.
test('a codex routine is stopped through the turn it is running', async () => {
  await withTempWorkspaceAsync(async (dir) => {
    await withTempHomeAsync(async () => {
      const CODEX_AGENT = realCodexAgent(dir);
      const run = await realCodexRun();
      const { thread } = run;
      const sub = new EventEmitter();
      const interrupted = [];
      let filedUnder;
      const server = {
        startThread: async () => thread,
        startTurn: (threadId) => { filedUnder = threadId; return sub; },
        interruptTurn: async (threadId) => { interrupted.push(threadId); },
      };
      await withFakeCodex(server, async (sched) => {
        // The instant the tick judged it due, kept apart from the instant the
        // start stamps, so an assertion that the stamp is not the run record's
        // beginning is able to fail. Same reason as the suppression test.
        const DUE = new Date(Date.now() - 120000);
        assert.strictEqual(sched.executeRoutine(CODEX_AGENT, ROUTINE, KEY, DUE), true, 'the run started');
        assert.ok(await until(() => sub.listenerCount('event') > 0), 'and reached the turn subscription');
        const stampedByTheStart = sched.routineState[KEY].lastRun;
        assert.notStrictEqual(stampedByTheStart, runRecords(dir)[0].startedAt,
          'the stamp and the run record beginning are different instants here');

        const [live] = sched.runningRuns();
        assert.ok(live, 'a codex run is reachable from outside it too');
        assert.strictEqual(sched.cancelRun(live.id), true, 'and can be stopped');
        assert.ok(await until(() => interrupted.length > 0), 'the turn was interrupted');
        assert.deepStrictEqual(interrupted, [filedUnder],
          'on the thread the client filed it under, rather than on an id this test invented');

        // THE REQUEST PATH ON THIS RUNTIME, OBSERVED BEFORE THE TURN ENDS.
        // The ending stamps lastRun from the clock, so a stop that wrote the
        // field when it was asked for would be overwritten by the terminal
        // event below and nothing after it could tell. This runtime's stop is
        // asynchronous, so the request has already been made and answered by
        // the time this runs, which is the moment worth looking at.
        assert.strictEqual(sched.routineState[KEY].lastRun, stampedByTheStart,
          'the interrupt wrote nothing to lastRun: byte for byte what the start left there');
        assert.notStrictEqual(sched.routineState[KEY].lastRun, runRecords(dir)[0].startedAt,
          'and not the beginning off the run record the stop had just reached');
        assert.strictEqual(sched.routineState[KEY].status, 'running',
          'and the run still reads as going, because asking for a stop is not an ending');
        assert.strictEqual(sched.routineSlots.routines[KEY], undefined,
          'with nothing written into the slot store by the request');

        // The turn then ends the way the client ends an interrupted one, and
        // the ending is the client own terminal event rather than one written
        // here.
        sub.emit('event', run.done);
        assert.ok(await until(() => sched.routineState[KEY].status !== 'running'), 'the turn ended');
        assert.strictEqual(sched.routineState[KEY].status, 'cancelled',
          'recorded as a stop rather than as a failure, whichever way the turn reported itself');
        assert.strictEqual(sched.executeRoutine(CODEX_AGENT, ROUTINE, KEY), true,
          'and the routine is released, exactly as an ordinary codex ending releases it');
        await endedAfter(sched, async () => {
          await until(() => sub.listenerCount('event') > 1);
          sub.emit('event', run.done);
        });
      });
    });
  });
});

// ===== A LOAD THAT MEETS BOTH KINDS OF RUN =====
//
// `loadRoutineState` rewrites any persisted entry whose status is 'running' to
// 'interrupted', on the reasoning that a file on disk cannot tell a dead
// process's leftovers from a run that is still going. That is true of the FILE
// and untrue of the PROCESS: the in-flight set names every routine whose run
// this process started and has not yet ended, and it is deliberately not
// cleared by the load for exactly the reason that makes it usable here, which
// is that the child of a run in flight is not dropped by a workspace switch.
//
// The load runs at boot AND on every workspace switch, and a switch happens
// while runs of this process are still going. So the same load meets both
// kinds of entry, and the two are told apart by the one piece of evidence that
// can tell them apart rather than by the file they share.
//
// BOTH KINDS AT ONCE, IN ONE FILE, IN ONE LOAD, which is the case a fixture
// with one entry cannot build. A fix that simply stopped rewriting, or that
// stopped rewriting whenever anything at all was in flight, satisfies a
// one-entry fixture of either kind on its own and fails this one.
test('a load that meets a live run and a dead process leftover at once tells them apart', async () => {
  await withTempWorkspaceAsync(async (dir, config) => {
    await withTempHomeAsync(async () => {
      const DEAD_KEY = 'sleeper:nightly';
      const DEAD_STAMP = '2026-08-11T09:00:00.000Z';
      const child = new EventEmitter();
      await withFakeSpawn(() => child, async (sched) => {
        assert.strictEqual(sched.executeRoutine(AGENT, ROUTINE, KEY), true, 'the live run started');
        const liveStamp = sched.routineState[KEY].lastRun;

        // The leftover is added to the file the live run has just written, so
        // one load meets both. Read and rewritten rather than replaced, because
        // replacing it would take the live run's own entry out of the file and
        // there would be nothing for the load to get right.
        const file = path.join(dir, '.rundock', 'routine-state.json');
        const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
        assert.strictEqual(onDisk[KEY].status, 'running',
          'the live run persisted "running" before its spawn, which is what makes the two entries look alike');
        onDisk[DEAD_KEY] = { lastRun: DEAD_STAMP, status: 'running', duration: null };
        fs.writeFileSync(file, JSON.stringify(onDisk));

        openWorkspace(sched, dir, config);

        assert.strictEqual(sched.routineState[KEY].status, 'running',
          'the run whose child is alive in this process is still reported as running, because it is');
        assert.strictEqual(sched.routineState[DEAD_KEY].status, 'interrupted',
          'and the entry no live run answers for is still closed, in the same load, from the same file');

        // Neither reading moves the field the suppression reads. The guard on
        // that is its own test; these two say it of this path specifically,
        // where both stamps were in hand at once.
        assert.strictEqual(sched.routineState[KEY].lastRun, liveStamp,
          'the live entry keeps its stamp');
        assert.strictEqual(sched.routineState[DEAD_KEY].lastRun, DEAD_STAMP,
          'and so does the closed one, so it stays suppressed for the window it started in');

        await endedAfter(sched, async () => { child.emit('close', 0); });
      });
    });
  });
});

// ===== THE VALUE DOUBLE-FIRE SUPPRESSION READS =====
//
// `routineState.lastRun` is the only input to the suppression, and the slot
// store must never be joined to it. Reaching into a live run to stop it, and
// switching workspaces across one, are two separate ways to arrive at that
// field by accident. So this is ONE fixture driven through BOTH of them,
// rather than an assertion written twice in two places that can drift apart.
//
// THE FIXTURE IS UNUSUAL IN TWO PLACES AT ONCE, deliberately. The routine
// carries a stamp from an earlier period AND a slot recorded as having passed
// unserved, and the recorded slot is the NEWER of the two instants. A fixture
// that made one of those unusual at a time would let a join to the slot store
// agree with the right answer by arithmetic and never be seen.
//
// THE CLOCK MOVES between the start, the switch and the stop, and that is what
// makes a wrong source visible at all. Under a frozen clock the run's own
// beginning, the switch and the ending all carry the same instant, so a value
// lifted out of the run record would read exactly like the value the ending
// wrote and every assertion below would pass on a broken build.
//
// Local time throughout, because getNextRun compares calendar days and hours
// in local time and a UTC literal mixed into that answers differently by
// timezone.
test('neither stopping a run nor switching workspaces across one reaches the value double-fire suppression reads', async () => {
  await withTempWorkspaceAsync(async (dir, config) => {
    await withTempHomeAsync(async () => {
      const SCHEDULE = 'every day at 09:00';
      const YESTERDAY = new Date(2026, 7, 11, 9, 0, 0);     // the last run anybody finished
      const MISSED = new Date(2026, 7, 12, 9, 0, 0);        // today's slot, passed while nobody watched
      // THE RUN'S BEGINNING AND THE RUN'S STAMP ARE DIFFERENT INSTANTS, which
      // is the third thing this fixture makes unusual. The tick judges a
      // routine due at one reading of the clock and hands that instant on as
      // the run's beginning, while the stamp is a reading of its own. Left
      // equal, as they are when nothing separates them, an assertion that the
      // stamp is not the record's beginning cannot fail.
      const DUE = new Date(2026, 7, 12, 9, 58, 0);          // when the tick judged it due
      const START = new Date(2026, 7, 12, 10, 0, 0);        // the catch-up run, started late
      const SWITCH = new Date(2026, 7, 12, 10, 5, 0);       // a workspace switch while it runs
      const STOP = new Date(2026, 7, 12, 10, 10, 0);        // somebody stops it
      const TOMORROW = new Date(2026, 7, 13, 8, 0, 0);      // before the next slot

      const rundock = path.join(dir, '.rundock');
      fs.mkdirSync(rundock, { recursive: true });
      fs.writeFileSync(path.join(rundock, 'routine-state.json'), JSON.stringify({
        [KEY]: { lastRun: YESTERDAY.toISOString(), status: 'completed', duration: 4 },
      }));
      fs.writeFileSync(path.join(rundock, 'routine-slots.json'), JSON.stringify({
        observedAt: YESTERDAY.toISOString(),
        routines: { [KEY]: { due: MISSED.toISOString(), schedule: 'daily@9', missed: [{ slot: MISSED.toISOString() }] } },
      }));

      let clock = START;
      const child = new EventEmitter();
      await withFakeSpawn(() => child, async (sched) => {
        sched.wireSchedulerDeps({ getWssClients: () => [], now: () => clock });
        openWorkspace(sched, dir, config);

        // THE FIXTURE, ASSERTED BEFORE ANYTHING IS CONCLUDED FROM IT. A load
        // that dropped either store would satisfy most of what follows while
        // proving nothing: there would be no slot instant to be joined and no
        // earlier stamp to be overwritten.
        assert.strictEqual(sched.routineState[KEY].lastRun, YESTERDAY.toISOString(),
          'the earlier period stamp loaded');
        assert.deepStrictEqual(sched.routineSlots.routines[KEY].missed, [{ slot: MISSED.toISOString() }],
          'and so did the slot that passed unserved, which is the instant a join would reach for');
        assert.deepStrictEqual(sched.getNextRun(SCHEDULE, sched.routineState[KEY].lastRun), MISSED,
          'so the catch-up run this routine is still owed today is owed');

        assert.strictEqual(sched.executeRoutine(AGENT, ROUTINE, KEY, DUE), true, 'the catch-up run started');
        const stampedByTheStart = sched.routineState[KEY].lastRun;
        assert.strictEqual(stampedByTheStart, START.toISOString(),
          'the start stamped the clock, which is the only writer on this path and is left exactly as it was');
        assert.strictEqual(runRecords(dir)[0].startedAt, DUE.toISOString(),
          'while the run record carries the instant it was judged due, so the two are telling apart');
        assert.notStrictEqual(stampedByTheStart, runRecords(dir)[0].startedAt,
          'which is what makes an assertion that the stamp is not the record beginning able to fail at all');

        // HALF TWO, exercised: a workspace switch across a run that is still
        // going. The switch reloads both stores, so it holds the run record,
        // the slot record and the run state at once, which is one line away
        // from stamping any of them into the field below.
        //
        // PLANTED SO THE SWITCH CAN BE PROVEN TO HAVE HAPPENED. The proof used
        // to be that the slot store's observation still read as the fixture
        // wrote it, which it already did from the first load with no tick in
        // between, so it held whether or not the second load ran and the
        // assertions after it could not tell a switch that left lastRun alone
        // from a switch that never happened. This entry is on disk and not in
        // memory, so only a load can put it there.
        const PLANTED_KEY = 'planted:by-the-file';
        const PLANTED_STAMP = '2026-08-09T07:00:00.000Z';
        const stateFile = path.join(rundock, 'routine-state.json');
        const onDisk = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
        onDisk[PLANTED_KEY] = { lastRun: PLANTED_STAMP, status: 'completed', duration: 2 };
        fs.writeFileSync(stateFile, JSON.stringify(onDisk));
        assert.strictEqual(sched.routineState[PLANTED_KEY], undefined,
          'and it is only on disk: nothing in memory knows about it yet');

        clock = SWITCH;
        openWorkspace(sched, dir, config);
        assert.strictEqual(sched.routineState[PLANTED_KEY] && sched.routineState[PLANTED_KEY].lastRun,
          PLANTED_STAMP,
          'the switch really re-read the stores rather than being skipped over');
        assert.deepStrictEqual(sched.routineSlots.routines[KEY].missed, [{ slot: MISSED.toISOString() }],
          'with the slot records reloaded beside them, still holding the instant a join would reach for');
        assert.strictEqual(sched.routineState[KEY].lastRun, stampedByTheStart,
          'and it wrote nothing to lastRun: byte for byte what the start left there');
        assert.notStrictEqual(sched.routineState[KEY].lastRun, SWITCH.toISOString(),
          'in particular not the moment the switch happened');

        // HALF ONE, exercised: the run is reached from outside and stopped.
        clock = STOP;
        const live = sched.runningRuns();
        assert.strictEqual(live.length, 1, 'the run that is still going can be identified from outside it');
        const startedAtOnRecord = runRecords(dir)[0].startedAt;
        assert.strictEqual(sched.cancelRun(live[0].id), true, 'and stopped');

        // THE REQUEST ITSELF, OBSERVED BEFORE ANY ENDING CAN COVER FOR IT.
        //
        // These assertions are the whole of what pins this half, and they have
        // to happen HERE. The ending that follows stamps lastRun from the
        // clock, so a stop that wrote the field at request time, from the run
        // record's beginning or from the slot store, would be overwritten a
        // statement later and every assertion after the ending would still
        // pass. The stop is the moment all three wrong sources are in hand at
        // once, so it is the moment worth looking at.
        assert.strictEqual(sched.routineState[KEY].lastRun, stampedByTheStart,
          'asking for the stop wrote nothing to lastRun: byte for byte what the start left there');
        assert.notStrictEqual(sched.routineState[KEY].lastRun, STOP.toISOString(),
          'in particular not the moment the stop was asked for');
        assert.notStrictEqual(sched.routineState[KEY].lastRun, startedAtOnRecord,
          'and not the beginning off the run record the stop had just reached');
        assert.notStrictEqual(sched.routineState[KEY].lastRun, MISSED.toISOString(),
          'and never the slot store, which must not be joined to this field at all');
        assert.strictEqual(sched.routineState[KEY].status, 'running',
          'and asking for a stop is not an ending, so the run still reads as going');
        assert.deepStrictEqual(sched.routineSlots.routines[KEY].missed, [{ slot: MISSED.toISOString() }],
          'with nothing added to the slot store by the request either');

        child.emit('close', null);
        assert.ok(await until(() => sched.routineState[KEY].status !== 'running'), 'the stopped run ended');

        // The ending stamps the clock, exactly as an ordinary ending does.
        // Every other instant in this fixture is a wrong source that was in
        // scope at the moment of the write, so each is ruled out by name.
        assert.strictEqual(sched.routineState[KEY].lastRun, STOP.toISOString(),
          'the ending stamped the clock');
        assert.notStrictEqual(sched.routineState[KEY].lastRun, stampedByTheStart,
          'rather than the run record own beginning, which the stop had in hand');
        assert.notStrictEqual(sched.routineState[KEY].lastRun, MISSED.toISOString(),
          'and never the slot store, which must not be joined to this field at all');
        assert.notStrictEqual(sched.routineState[KEY].lastRun, YESTERDAY.toISOString(),
          'and not the stamp it replaced');

        // The slot store is untouched in the other direction too: stopping a
        // run is not a slot passing unserved, and recording one here would
        // put a gap on a routine that was served.
        assert.deepStrictEqual(sched.routineSlots.routines[KEY].missed, [{ slot: MISSED.toISOString() }],
          'the slot record is exactly as it was, with nothing added by the stop');

        // AND THE SUPPRESSION BEHAVES AS IT DOES AFTER ANY OTHER ENDING,
        // which is the property the field exists for rather than a property
        // of its bytes.
        assert.strictEqual(sched.getNextRun(SCHEDULE, sched.routineState[KEY].lastRun), null,
          'the routine is held for the rest of the period it already ran in');
        clock = TOMORROW;
        assert.deepStrictEqual(sched.getNextRun(SCHEDULE, sched.routineState[KEY].lastRun),
          new Date(2026, 7, 13, 9, 0, 0),
          'and is due again at its next slot, which is what a stopped run must not cost it');
      }, () => {});
    });
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

// ===== SLOTS THAT PASSED UNSERVED =====
// The scheduled instant used to be a local value, recomputed every tick and
// thrown away, so nothing anywhere knew when a routine had been DUE. These
// pin the persistence of that instant and of the time the scheduler last
// observed, and the side of the workspace-switch line the pair sits on.

function writeRoutineAgent(ws, routines) {
  const dir = path.join(ws, '.claude', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'nightly.md'), agentFile({
    name: 'nightly', type: 'specialist', order: 1, routines,
  }));
  invalidateAgentCache();
}

// One tick at a fixed instant, with the routine's time still ahead of it so
// the tick observes without spawning anything.
function observeOnce(t, sched, when) {
  sched.wireSchedulerDeps({ now: () => when });
  t.mock.timers.enable({ apis: ['setInterval'] });
  try {
    sched.startScheduler();
    t.mock.timers.tick(60_000);
  } finally {
    sched.stopScheduler();
    t.mock.timers.reset();
  }
}

// enabled out loud: every test using this fixture is about slot arithmetic for
// a routine in SERVICE, and a routine with no `enabled` key is owed no slot
// records at all, so leaning on the default would make these tests measure the
// wrong rule.
const LATE_ROUTINE = [{ name: 'late', schedule: 'every day at 23:00', prompt: 'p', enabled: true }];
const LATE_KEY = 'nightly:late';

test('the due instant and the last observed time are persisted, and survive a restart', (t) => {
  withTempWorkspace((ws) => {
    const sched = freshScheduler();
    writeRoutineAgent(ws, LATE_ROUTINE);
    const observed = new Date(2026, 7, 15, 8, 0, 0);
    const due = new Date(2026, 7, 15, 23, 0, 0);
    observeOnce(t, sched, observed);

    assert.strictEqual(sched.routineSlots.routines[LATE_KEY].due, due.toISOString(),
      'the instant the routine is next due is held rather than recomputed and dropped');
    assert.strictEqual(sched.routineSlots.observedAt, observed.toISOString(),
      'and so is the time the scheduler last observed');

    const onDisk = JSON.parse(fs.readFileSync(path.join(ws, '.rundock', 'routine-slots.json'), 'utf-8'));
    assert.strictEqual(onDisk.routines[LATE_KEY].due, due.toISOString(), 'both reached the workspace file');
    assert.strictEqual(onDisk.observedAt, observed.toISOString());

    // The restart. Losing the in-memory copy is what a new process starts
    // from, so clobbering it is the only honest way to show the values below
    // were read back rather than never lost.
    sched.routineSlots.observedAt = null;
    delete sched.routineSlots.routines[LATE_KEY];
    sched.loadRoutineSlots();
    assert.strictEqual(sched.routineSlots.routines[LATE_KEY].due, due.toISOString(),
      'a restarted process knows when the routine was due');
    assert.strictEqual(sched.routineSlots.observedAt, observed.toISOString(),
      'and when it was last watching, which is what tells it what it missed');
  });
});

// WHICH SIDE OF THE WORKSPACE-SWITCH LINE. loadRoutineState drops the run
// state and the announcements because those describe the workspace being
// left, while the in-flight set survives because it describes child processes
// that are still running. Slot records describe a workspace: the keys are
// workspace-local and collide freely, so carrying A's gaps into B would file
// them under B's routines. The last observed time is workspace-scoped for the
// same reason and for a second one: while B was open, nobody was watching A,
// which is precisely the condition the record exists to describe.
//
// Driven through the real switch handler rather than through loadRoutineState,
// for the reason the in-flight test above gives: a reset added to
// openWorkspace beside the two that belong there would leave this green.
test('a workspace switch replaces the slot records the way it replaces the run state', (t) => {
  const sched = freshScheduler();
  const config = require('../../lib/config.js');
  const original = config.getWorkspace();
  const slotsRef = sched.routineSlots; // held BEFORE any call: identity must survive
  const wsA = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-slots-a-'));
  const wsB = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-slots-b-'));
  const noop = () => {};
  const switchTo = (dir) => {
    const ctx = {
      signals: { phaseTimer: () => ({ mark: noop, summary: () => '' }), reportStartup: noop },
      runtime: { killAllChildren: noop, cleanOrphanedProcesses: noop },
      workspace: {
        setWorkspaceRoot: (d) => config.setWorkspace(d),
        armAgentsDirWatcher: noop, armFileTreeWatcher: noop, healWorkspaceIfMoved: noop,
        saveRecentWorkspace: noop, fileTreeForSend: () => [],
      },
      agents: { armAgentsDirWatcher: noop, invalidateAgentCache: noop },
      store: { clearSearchFailure: noop, ensureSearchEngine: noop },
      broadcast: noop,
    };
    const sent = [];
    freshWorkspaceHandlers(sched).handleSetWorkspace(ctx, { send: (raw) => sent.push(JSON.parse(raw)) },
      { type: 'set_workspace', path: dir });
    assert.ok(sent.some(m => m.type === 'workspace_set'),
      'the switch ran its open path to the end rather than into the rollback');
    invalidateAgentCache();
  };
  try {
    config.setWorkspace(wsA);
    writeRoutineAgent(wsA, LATE_ROUTINE);
    observeOnce(t, sched, new Date(2026, 7, 15, 8, 0, 0));
    assert.ok(slotsRef.routines[LATE_KEY], "workspace A's slot state was recorded");

    switchTo(wsB);
    assert.strictEqual(sched.routineSlots, slotsRef, 'routineSlots is never reassigned');
    assert.deepStrictEqual(Object.keys(slotsRef.routines), [],
      "workspace A's records did not follow the switch into B");
    assert.strictEqual(slotsRef.observedAt, null,
      'and neither did the time A was last observed: B has its own, or none');

    switchTo(wsA);
    assert.ok(slotsRef.routines[LATE_KEY], "and A's own records came back when A did");
    assert.strictEqual(slotsRef.observedAt, new Date(2026, 7, 15, 8, 0, 0).toISOString());
  } finally {
    config.setWorkspace(original);
    invalidateAgentCache();
    fs.rmSync(wsA, { recursive: true, force: true });
    fs.rmSync(wsB, { recursive: true, force: true });
  }
});

// The sibling of the recordRoutineRun case in the characterization suite, at
// the one call site that runs sixty times an hour rather than once a run.
test('a tick survives an unwritable .rundock, and says so once rather than once a minute', (t) => {
  withTempWorkspace((ws) => {
    const sched = freshScheduler();
    writeRoutineAgent(ws, LATE_ROUTINE);
    fs.writeFileSync(path.join(ws, '.rundock'), 'a file, not a directory'); // mkdir will fail
    const errors = [];
    t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));

    sched.wireSchedulerDeps({ now: () => new Date(2026, 7, 15, 8, 0, 0) });
    t.mock.timers.enable({ apis: ['setInterval'] });
    try {
      assert.doesNotThrow(() => {
        sched.startScheduler();
        t.mock.timers.tick(180_000);
      }, 'three ticks against an unwritable workspace, none of them fatal');
    } finally {
      sched.stopScheduler();
      t.mock.timers.reset();
    }

    assert.strictEqual(sched.routineSlots.routines[LATE_KEY].due, new Date(2026, 7, 15, 23, 0, 0).toISOString(),
      'this process still knows when the routine is due: the file is protection for the NEXT one');
    assert.strictEqual(errors.filter(e => e.includes('Failed to persist routine slots')).length, 1,
      'the outage was announced once, not once per tick');
  });
});

// A due instant absurdly far behind: a workspace restored from an old backup,
// or a clock that was years wrong. Walking a slot at a time from there would
// enumerate a record for every day since, which is neither quick nor useful,
// and would do it again on every tick if the walk left `due` where it found it.
test('a due instant years behind is bounded rather than enumerated, and resyncs', (t) => {
  withTempWorkspace((ws) => {
    const sched = freshScheduler();
    writeRoutineAgent(ws, LATE_ROUTINE);
    const warnings = [];
    t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));

    // The stale file is written by the scheduler itself, three years ago.
    observeOnce(t, sched, new Date(2023, 7, 15, 8, 0, 0));
    assert.strictEqual(sched.routineSlots.routines[LATE_KEY].due, new Date(2023, 7, 15, 23, 0, 0).toISOString());

    const daysSince = 1096; // 2023-08-15 to 2026-08-15, two leap-free years and one leap
    observeOnce(t, sched, new Date(2026, 7, 15, 8, 0, 0));
    const missed = sched.routineSlots.routines[LATE_KEY].missed;
    assert.ok(missed.length > 0, 'the slots it did walk were recorded');
    assert.ok(missed.length < daysSince, `the walk stopped short of every day since (${missed.length})`);
    assert.ok(warnings.some(w => w.includes(LATE_KEY)), 'and said which routine it gave up on');
    // WHICH END IT KEPT. Walking forward from the ancient anchor and stopping
    // at a cap keeps the oldest slots and drops the recent ones, which is the
    // wrong half: nobody opening a laptop wants 2023 and nothing about last
    // week. The bound is applied to where the walk STARTS.
    assert.strictEqual(missed[missed.length - 1].slot, new Date(2026, 7, 14, 23, 0, 0).toISOString(),
      'the last record is last night, the slot immediately before today');
    assert.ok(new Date(missed[0].slot) > new Date(2024, 0, 1),
      `the walk did not spend its budget on 2023 (first record ${missed[0].slot})`);
    assert.strictEqual(sched.routineSlots.routines[LATE_KEY].due, new Date(2026, 7, 15, 23, 0, 0).toISOString(),
      'the due instant resynced to today');

    const bounded = missed.length;
    observeOnce(t, sched, new Date(2026, 7, 15, 9, 0, 0));
    assert.strictEqual(sched.routineSlots.routines[LATE_KEY].missed.length, bounded,
      'so the next tick walks nothing: giving up once is giving up');
  });
});

// A routine RENAMED while the machine slept, which is the case that makes
// both halves of this necessary. The new name is a key the scheduler has
// never seen, so it has no history and must not be handed one: a rename would
// otherwise report the whole sleep as gaps the moment the machine woke. And
// the old name keeps what it earned, because a gap record is history and a
// rename is not a reason to lose it. The announcement map answers the same
// question the other way, on purpose: a silence outliving what it described
// is handed to whatever is written under the name next.
test('a routine renamed while the machine slept wakes with no history, and the old name keeps its own', (t) => {
  withTempWorkspace((ws) => {
    const sched = freshScheduler();
    writeRoutineAgent(ws, LATE_ROUTINE);
    observeOnce(t, sched, new Date(2026, 7, 15, 8, 0, 0));
    assert.ok(sched.routineSlots.routines[LATE_KEY], 'the original name was being watched');

    writeRoutineAgent(ws, [{ name: 'renamed', schedule: 'every day at 23:00', prompt: 'p', enabled: true }]);
    observeOnce(t, sched, new Date(2026, 7, 21, 8, 0, 0));

    assert.deepStrictEqual(sched.routineSlots.routines['nightly:renamed'].missed, [],
      'six days of sleep were not billed to a name the scheduler had never seen');
    assert.strictEqual(sched.routineSlots.routines['nightly:renamed'].due, new Date(2026, 7, 21, 23, 0, 0).toISOString(),
      'it starts from the slot it is next due, which is what the next wake compares against');
    assert.ok(sched.routineSlots.routines[LATE_KEY],
      'and the old name was not swept off with the roster, unlike its announcement');
  });
});

// WRITER AND READER, MADE TO AGREE. The record's shape is stated twice in
// production: once where a slot is pushed, once where the load path names the
// fields it will keep. Nothing but a round trip makes those two agree, and the
// failure is silent in the worst possible way: the filter is per record, so a
// renamed field leaves the file parsing cleanly and coming back empty, with no
// error and no log line.
//
// It also lands exactly where the feature is for. These records are written
// just before a process dies and are only ever of use once it restarts, so
// every in-memory assertion in this diff could stay green while a laptop
// closed for five days reopened showing nothing.
test('a missed record survives the file it is written to, with its content intact', (t) => {
  withTempWorkspace((ws) => {
    const sched = freshScheduler();
    writeRoutineAgent(ws, LATE_ROUTINE);
    observeOnce(t, sched, new Date(2026, 7, 15, 8, 0, 0));
    observeOnce(t, sched, new Date(2026, 7, 17, 8, 0, 0));

    const nights = [
      { slot: new Date(2026, 7, 15, 23, 0, 0).toISOString() },
      { slot: new Date(2026, 7, 16, 23, 0, 0).toISOString() },
    ];
    assert.deepStrictEqual(sched.routineSlots.routines[LATE_KEY].missed, nights,
      'two unwatched nights went by and both were recorded');

    const file = path.join(ws, '.rundock', 'routine-slots.json');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf-8')).routines[LATE_KEY].missed, nights,
      'and reached the file in the shape they were written in');

    // What a restart starts from: nothing in memory, everything on disk.
    delete sched.routineSlots.routines[LATE_KEY];
    sched.loadRoutineSlots();
    assert.deepStrictEqual(sched.routineSlots.routines[LATE_KEY].missed, nights,
      'and came back off it, which is the only moment they are ever read');
  });
});

test('a slot entry with no due instant is dropped on load, without taking the file with it', (t) => {
  withTempWorkspace((ws) => {
    const sched = freshScheduler();
    writeRoutineAgent(ws, LATE_ROUTINE);
    observeOnce(t, sched, new Date(2026, 7, 15, 8, 0, 0));
    observeOnce(t, sched, new Date(2026, 7, 17, 8, 0, 0));

    // Production's own file with one field taken back out: a hand edit, a
    // truncated write, an older shape. An entry with no due instant has
    // nothing to walk from, so keeping it would walk from an invalid date.
    const file = path.join(ws, '.rundock', 'routine-slots.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.strictEqual(saved.routines[LATE_KEY].missed.length, 2, 'the entry about to be damaged had real history');
    delete saved.routines[LATE_KEY].due;
    fs.writeFileSync(file, JSON.stringify(saved, null, 2));

    sched.loadRoutineSlots();
    assert.strictEqual(sched.routineSlots.routines[LATE_KEY], undefined,
      'the entry was dropped whole rather than loaded with nothing to anchor it');
    assert.strictEqual(sched.routineSlots.observedAt, saved.observedAt,
      'and the rest of the file still loaded: one bad entry is not a lost workspace');
  });
});

// Weekly is half the grammar, and the walk steps by a different amount for it.
test('a weekly routine walks a week at a time, so a fortnight closed leaves two records', (t) => {
  withTempWorkspace((ws) => {
    const sched = freshScheduler();
    writeRoutineAgent(ws, [{ name: 'weekly', schedule: 'every friday at 23:00', prompt: 'p', enabled: true }]);
    const key = 'nightly:weekly';

    observeOnce(t, sched, new Date(2026, 7, 21, 8, 0, 0)); // Friday 21 August 2026
    assert.strictEqual(sched.routineSlots.routines[key].due, new Date(2026, 7, 21, 23, 0, 0).toISOString(),
      'on its own weekday the slot is today, still ahead at 08:00');

    observeOnce(t, sched, new Date(2026, 8, 4, 8, 0, 0)); // two Fridays later
    assert.deepStrictEqual(sched.routineSlots.routines[key].missed, [
      { slot: new Date(2026, 7, 21, 23, 0, 0).toISOString() },
      { slot: new Date(2026, 7, 28, 23, 0, 0).toISOString() },
    ], 'two Fridays passed unwatched, and the thirteen days between them are not slots');
    assert.strictEqual(sched.routineSlots.routines[key].due, new Date(2026, 8, 4, 23, 0, 0).toISOString(),
      "and today's Friday is still to come rather than already gone");
  });
});

// The complaint is throttled per outage, so the flag that throttles it has to
// end with the workspace it described. Otherwise the first unwritable
// workspace silences every one that follows it, for the life of the process.
test('a second unwritable workspace is announced too, rather than silenced by the first', (t) => {
  const sched = freshScheduler();
  const config = require('../../lib/config.js');
  const original = config.getWorkspace();
  const wsA = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-unwritable-a-'));
  const wsB = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-unwritable-b-'));
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
  const complaints = () => errors.filter(e => e.includes('Failed to persist routine slots')).length;
  try {
    for (const ws of [wsA, wsB]) {
      writeRoutineAgent(ws, LATE_ROUTINE);
      fs.writeFileSync(path.join(ws, '.rundock'), 'a file, not a directory');
    }
    config.setWorkspace(wsA);
    observeOnce(t, sched, new Date(2026, 7, 15, 8, 0, 0));
    assert.strictEqual(complaints(), 1, "workspace A's outage was announced");

    config.setWorkspace(wsB);
    sched.loadRoutineState();
    observeOnce(t, sched, new Date(2026, 7, 15, 9, 0, 0));
    assert.strictEqual(complaints(), 2, "and so was workspace B's, which is a different workspace failing");
  } finally {
    config.setWorkspace(original);
    invalidateAgentCache();
    fs.rmSync(wsA, { recursive: true, force: true });
    fs.rmSync(wsB, { recursive: true, force: true });
  }
});

// THE CLOSED LAPTOP, END TO END, through the boot path rather than around it.
//
// Every other test here walks from state the same scheduler instance put in
// memory a moment earlier, so the load path is exercised and the walk is
// exercised and nothing joins them. That is the double sweep's finding one
// level up: the record survives the file, and nothing proved the walk can
// start from what the loader admitted. A second scheduler module IS the
// second process: its own empty state, filled only by loadRoutineState.
test('a second process loads the file and walks from what it read, which is the closed laptop', (t) => {
  withTempWorkspace((ws) => {
    const before = freshScheduler();
    writeRoutineAgent(ws, LATE_ROUTINE);
    observeOnce(t, before, new Date(2026, 7, 15, 8, 0, 0));
    assert.deepStrictEqual(before.routineSlots.routines[LATE_KEY].missed, [], 'nothing was owed when the lid closed');

    const after = freshScheduler();
    assert.strictEqual(after.routineSlots.observedAt, null,
      'the new process starts knowing nothing, which is what makes the rest of this mean something');

    after.loadRoutineState(); // the boot path, and the workspace-switch path
    assert.strictEqual(after.routineSlots.observedAt, new Date(2026, 7, 15, 8, 0, 0).toISOString(),
      'and takes its last observation off disk');

    observeOnce(t, after, new Date(2026, 7, 17, 8, 0, 0));
    assert.deepStrictEqual(after.routineSlots.routines[LATE_KEY].missed, [
      { slot: new Date(2026, 7, 15, 23, 0, 0).toISOString() },
      { slot: new Date(2026, 7, 16, 23, 0, 0).toISOString() },
    ], 'the walk started from the loaded instants and named exactly the nights between them and the tick');
    assert.strictEqual(after.routineSlots.routines[LATE_KEY].due, new Date(2026, 7, 17, 23, 0, 0).toISOString(),
      'and resynced to tonight');
  });
});

// A routine edited while the machine was closed. The walk starts from an
// instant computed under the OLD schedule and would step using the NEW one,
// so every record it wrote would name an hour, or a weekday, that was never
// scheduled. Reachable by editing a routine and closing the lid.
test('a schedule edited while the machine was closed resyncs instead of recording the old hour', (t) => {
  withTempWorkspace((ws) => {
    const sched = freshScheduler();
    writeRoutineAgent(ws, LATE_ROUTINE); // 23:00
    observeOnce(t, sched, new Date(2026, 7, 15, 8, 0, 0));

    writeRoutineAgent(ws, [{ name: 'late', schedule: 'every day at 22:00', prompt: 'p', enabled: true }]);
    observeOnce(t, sched, new Date(2026, 7, 17, 8, 0, 0));
    assert.deepStrictEqual(sched.routineSlots.routines[LATE_KEY].missed, [],
      'two nights passed, and neither is recorded at an hour the routine was never due at');
    assert.strictEqual(sched.routineSlots.routines[LATE_KEY].due, new Date(2026, 7, 17, 22, 0, 0).toISOString(),
      'the anchor moved to the schedule actually in force');

    // And the resync is a pause, not an off switch: under the new schedule the
    // walk works again, at the new hour.
    observeOnce(t, sched, new Date(2026, 7, 19, 8, 0, 0));
    assert.deepStrictEqual(sched.routineSlots.routines[LATE_KEY].missed, [
      { slot: new Date(2026, 7, 17, 22, 0, 0).toISOString() },
      { slot: new Date(2026, 7, 18, 22, 0, 0).toISOString() },
    ], 'every recorded slot names 22:00, which is when the routine was actually due');
  });
});

// Being paused does not exempt a routine from records for periods that passed
// entirely unobserved, which is pinned rather than endorsed: see the block
// comment in lib/scheduler.js, and the boundary test below for the other side
// of the line. Whether a paused routine should SHOW gaps is the routines
// view's ruling, and this is what makes changing it deliberate.
test('a paused routine accrues records for the days nobody was watching at all', (t) => {
  withTempWorkspace((ws) => {
    const sched = freshScheduler();
    // enabled out loud, so this fixture differs from an ordinary routine in
    // exactly the one field it is about. A block with no `enabled` key is not
    // in service at all and is owed no records, which is a different rule.
    writeRoutineAgent(ws, [{ name: 'late', schedule: 'every day at 23:00', prompt: 'p', enabled: true, paused: true }]);
    observeOnce(t, sched, new Date(2026, 7, 15, 8, 0, 0));
    observeOnce(t, sched, new Date(2026, 7, 17, 8, 0, 0));

    assert.deepStrictEqual(sched.routineSlots.routines[LATE_KEY].missed, [
      { slot: new Date(2026, 7, 15, 23, 0, 0).toISOString() },
      { slot: new Date(2026, 7, 16, 23, 0, 0).toISOString() },
    ], 'being paused did not stop the slots being recorded');
  });
});

// The other half of the resync, which the resync test cannot show because it
// has no history yet when the edit lands. Slots recorded before an edit passed
// under the schedule that was in force when they did. Editing the routine
// afterwards is not a reason to lose them, and dropping them would be the
// quiet way to make an edit erase a week of gaps.
test('a schedule edit resyncs the anchor without discarding the history already recorded', (t) => {
  withTempWorkspace((ws) => {
    const sched = freshScheduler();
    writeRoutineAgent(ws, LATE_ROUTINE); // 23:00
    observeOnce(t, sched, new Date(2026, 7, 15, 8, 0, 0));
    observeOnce(t, sched, new Date(2026, 7, 17, 8, 0, 0));
    const earned = [
      { slot: new Date(2026, 7, 15, 23, 0, 0).toISOString() },
      { slot: new Date(2026, 7, 16, 23, 0, 0).toISOString() },
    ];
    assert.deepStrictEqual(sched.routineSlots.routines[LATE_KEY].missed, earned, 'two nights were already recorded');

    writeRoutineAgent(ws, [{ name: 'late', schedule: 'every day at 22:00', prompt: 'p', enabled: true }]);
    observeOnce(t, sched, new Date(2026, 7, 19, 8, 0, 0));
    assert.deepStrictEqual(sched.routineSlots.routines[LATE_KEY].missed, earned,
      'the edit added nothing and took nothing away');
    assert.strictEqual(sched.routineSlots.routines[LATE_KEY].due, new Date(2026, 7, 19, 22, 0, 0).toISOString(),
      'only the anchor moved');
  });
});

// A file written before the anchor carried its schedule, which every workspace
// already running this scheduler has. There is nothing to compare, so the walk
// cannot vouch for what the anchor was computed under, and treating an absent
// shape as a match would walk the old file under whatever schedule is current.
test('an anchor stored without its schedule resyncs on the first wake rather than being trusted', (t) => {
  withTempWorkspace((ws) => {
    const sched = freshScheduler();
    writeRoutineAgent(ws, LATE_ROUTINE);
    observeOnce(t, sched, new Date(2026, 7, 15, 8, 0, 0));

    const file = path.join(ws, '.rundock', 'routine-slots.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.ok(saved.routines[LATE_KEY].schedule, 'the anchor normally carries its schedule');
    delete saved.routines[LATE_KEY].schedule; // the older shape
    fs.writeFileSync(file, JSON.stringify(saved, null, 2));
    sched.loadRoutineSlots();

    observeOnce(t, sched, new Date(2026, 7, 17, 8, 0, 0));
    assert.deepStrictEqual(sched.routineSlots.routines[LATE_KEY].missed, [],
      'the first wake on an older file records nothing rather than guessing');

    // One wake of silence, not a permanent one.
    observeOnce(t, sched, new Date(2026, 7, 19, 8, 0, 0));
    assert.deepStrictEqual(sched.routineSlots.routines[LATE_KEY].missed, [
      { slot: new Date(2026, 7, 17, 23, 0, 0).toISOString() },
      { slot: new Date(2026, 7, 18, 23, 0, 0).toISOString() },
    ], 'and the wake after it walks normally, from an anchor it can vouch for');
  });
});

// THE BOUNDARY OF WHAT A RECORD IS, at the exact edge, in one test.
//
// A record is a slot whose whole period went by with the scheduler not
// watching. A slot that passed while the scheduler was AWAKE and was not
// served leaves nothing, even once its period closes: the machine was on and
// said so at the time, in the refusal log and in the routine's own state. The
// gap this card exists to close is the one with no trace at all.
//
// Both halves are one test on purpose. Either alone is satisfied by a walk
// that records everything or nothing.
test('a slot the scheduler was awake for leaves no record; a day it was closed for leaves one', (t) => {
  withTempWorkspace((ws) => {
    const sched = freshScheduler();
    writeRoutineAgent(ws, [{ name: 'late', schedule: 'every day at 05:00', prompt: 'p', paused: true, enabled: true }]);

    observeOnce(t, sched, new Date(2026, 7, 15, 4, 0, 0));  // awake before the slot
    observeOnce(t, sched, new Date(2026, 7, 15, 9, 0, 0));  // reopened after it, paused, nothing served it
    observeOnce(t, sched, new Date(2026, 7, 15, 23, 0, 0)); // still awake as its day closes
    observeOnce(t, sched, new Date(2026, 7, 16, 9, 0, 0));  // and into the next
    assert.deepStrictEqual(sched.routineSlots.routines[LATE_KEY].missed, [],
      'the 05:00 slot passed unserved while the scheduler watched it happen, so it is not a gap');

    observeOnce(t, sched, new Date(2026, 7, 18, 9, 0, 0));  // closed for all of the 17th
    assert.deepStrictEqual(sched.routineSlots.routines[LATE_KEY].missed, [
      { slot: new Date(2026, 7, 17, 5, 0, 0).toISOString() },
    ], 'a day nobody was watching at all leaves exactly one, and being paused did not exempt it');
  });
});

// A routine deleted and re-added under the same name. The days in between are
// days on which no slot existed to pass, so walking from the old anchor would
// record gaps for a routine that did not exist. Same answer as a changed
// schedule, deliberately in the same shape: history stays, anchor unknown, the
// first tick after it returns resyncs without walking.
test('a routine removed and re-added later wakes with no records for the days it did not exist', (t) => {
  withTempWorkspace((ws) => {
    const sched = freshScheduler();
    writeRoutineAgent(ws, LATE_ROUTINE);
    observeOnce(t, sched, new Date(2026, 7, 15, 8, 0, 0));
    observeOnce(t, sched, new Date(2026, 7, 17, 8, 0, 0));
    const earned = [
      { slot: new Date(2026, 7, 15, 23, 0, 0).toISOString() },
      { slot: new Date(2026, 7, 16, 23, 0, 0).toISOString() },
    ];
    assert.deepStrictEqual(sched.routineSlots.routines[LATE_KEY].missed, earned, 'two real nights were recorded');

    writeRoutineAgent(ws, undefined); // the routine is deleted from the agent
    observeOnce(t, sched, new Date(2026, 7, 19, 8, 0, 0));

    writeRoutineAgent(ws, LATE_ROUTINE); // and written back, days later
    observeOnce(t, sched, new Date(2026, 7, 21, 8, 0, 0));
    assert.deepStrictEqual(sched.routineSlots.routines[LATE_KEY].missed, earned,
      'nothing was recorded for the days the routine did not exist, and nothing it had earned was lost');
    assert.strictEqual(sched.routineSlots.routines[LATE_KEY].due, new Date(2026, 7, 21, 23, 0, 0).toISOString(),
      'the anchor resynced to the schedule that is back in force');
  });
});

// The narrower half of the same rule: a routine can be declared, and refusable,
// and still have no anchor anyone can vouch for, because its schedule stopped
// parsing. An unparseable schedule never fires, so the days it spans are days
// on which nothing was due, exactly like the days after a deletion.
test('a schedule that stopped parsing loses its anchor too, not just a routine that vanished', (t) => {
  withTempWorkspace((ws) => {
    const sched = freshScheduler();
    writeRoutineAgent(ws, LATE_ROUTINE);
    observeOnce(t, sched, new Date(2026, 7, 15, 8, 0, 0));

    // A documented pitfall: the hour must be zero-padded, so this parses as a
    // routine and never matches as a schedule.
    writeRoutineAgent(ws, [{ name: 'late', schedule: 'every day at 9:00', prompt: 'p', enabled: true }]);
    observeOnce(t, sched, new Date(2026, 7, 17, 8, 0, 0));

    writeRoutineAgent(ws, LATE_ROUTINE);
    observeOnce(t, sched, new Date(2026, 7, 19, 8, 0, 0));
    assert.deepStrictEqual(sched.routineSlots.routines[LATE_KEY].missed, [],
      'no slot passed on the days the schedule named no time at all');
    assert.strictEqual(sched.routineSlots.routines[LATE_KEY].due, new Date(2026, 7, 19, 23, 0, 0).toISOString(),
      'and the anchor resynced once the schedule parsed again');
  });
});

// ===========================================================================
// TWO INSTANCES OPEN ON ONE WORKSPACE
// ===========================================================================
//
// The documented always-on setup keeps Rundock up on a server and up on the
// laptop, with one workspace synced between them. The documentation says that
// runs the routine twice. This is that claim, checked against the code that
// decides it rather than against a description of it, because the description
// has been wrong before.
//
// WHAT DECIDES IT, READ RATHER THAN SUMMARISED. The tick asks
//
//     const nextRun = getNextRun(routine.schedule, routineState[key]?.lastRun);
//
// and `routineState` is a module-owned object in memory. It is filled by
// loadRoutineState, which runs when the process starts and whenever the
// workspace changes, and at no other time: nothing on the tick path reads the
// file. saveRoutineState writes
// the whole object out on each run, so one instance's write never merges into
// another's memory either.
//
// SO THE SYNC TOOL IS NOT THE VARIABLE, and this test is built to make that
// unarguable: the two instances share ONE DIRECTORY. That is the strongest
// sync anything could have, instantaneous and lossless, and both instances
// still fire. A tool that copies the file more slowly, or not at all, cannot
// do better than the same directory does.
//
// A SECOND MODULE INSTANCE IS A SECOND PROCESS, for the reason freshScheduler
// is used elsewhere in this file: its own empty state, filled only by its own
// load.
test('two instances on one workspace both fire the routine, sharing one state file', async (t) => {
  const claude = require(CLAUDE_KEY);
  const realSpawn = claude.spawnClaude;
  const realKill = claude.killProcessTree;
  const prevClaudeDeps = claude.wireClaudeRuntimeDeps({ getActualPort: () => 0 });
  const children = [];
  claude.spawnClaude = () => { const child = new EventEmitter(); children.push(child); return child; };
  claude.killProcessTree = () => {};
  const temp = enterTempWorkspace();
  const BRIEFING = 'nightly:briefing';
  // Twenty past nine, with the routine due at seven. Past due on both ticks,
  // so nothing here depends on which instance ticks first.
  const NOW = new Date(2026, 7, 20, 9, 20);
  const stateFile = path.join(temp.ws, '.rundock', 'routine-state.json');
  try {
    writeRoutineAgent(temp.ws, [{ name: 'briefing', schedule: 'every day at 07:00', prompt: 'p', enabled: true }]);
    const laptop = freshScheduler();
    const server = freshScheduler();
    for (const instance of [laptop, server]) {
      instance.wireSchedulerDeps({ getWssClients: () => [] });
      // The boot path, which is the only thing that ever fills the object the
      // suppression reads. Both start knowing nothing, because nothing has run.
      instance.loadRoutineState();
    }
    assert.ok(!fs.existsSync(stateFile), 'sanity: no run has been recorded yet');

    observeOnce(t, laptop, NOW);
    assert.strictEqual(children.length, 1, 'the first instance fired the routine');
    const onDisk = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    assert.strictEqual(typeof onDisk[BRIEFING].lastRun, 'string',
      'and wrote the run to the file both instances share');

    // THE WHOLE MECHANISM, IN ONE ASSERTION. The other instance is looking at
    // the same directory, and the run it would be suppressed by is sitting in
    // it. Its own copy is still empty, because nothing since its boot has read
    // that file.
    assert.strictEqual(server.routineState[BRIEFING], undefined,
      'the second instance has not seen the first instance\'s run, and never will while it stays up');

    observeOnce(t, server, NOW);
    assert.strictEqual(children.length, 2,
      'so it fired the same routine again, with the state file shared and current');

    // Said the other way round, so a reader is not left inferring it from a
    // spawn count: what the suppression was asked, on the instant it decided.
    assert.ok(server.getNextRun('every day at 07:00', laptop.routineState[BRIEFING].lastRun) === null,
      'the run the first instance recorded WOULD have suppressed the second, had it been asked with it');
  } finally {
    for (const child of children) child.emit('close', 0);
    claude.spawnClaude = realSpawn;
    claude.killProcessTree = realKill;
    claude.wireClaudeRuntimeDeps(prevClaudeDeps);
    temp.leave();
  }
});
