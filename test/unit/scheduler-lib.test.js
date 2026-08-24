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
async function withFakeSpawn(fakeSpawn, fn) {
  const claude = require(CLAUDE_KEY);
  const realSpawn = claude.spawnClaude;
  const prevClaudeDeps = claude.wireClaudeRuntimeDeps({ getActualPort: () => 0 });
  claude.spawnClaude = fakeSpawn;
  try {
    const sched = freshScheduler();
    sched.wireSchedulerDeps({ getWssClients: () => [] });
    return await fn(sched);
  } finally {
    claude.spawnClaude = realSpawn;
    claude.wireClaudeRuntimeDeps(prevClaudeDeps);
  }
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
      };
      const handlers = freshWorkspaceHandlers(sched);
      handlers.handleSetWorkspace(ctx, ws, { type: 'set_workspace', path: dir });
      assert.ok(sent.some(m => m.type === 'workspace_set'),
        'the switch ran its open path to the end rather than into the rollback');

      // Only loadRoutineState writes this value, so it is the proof the
      // switch's resets really ran rather than being skipped over.
      assert.strictEqual(sched.routineState[KEY].status, 'interrupted',
        'the switch rebuilt the run state from the workspace file');
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

        sched.loadRoutineState();

        const [record] = runRecords(dir);
        assert.strictEqual(record.status, 'running',
          'a run whose child is alive in this very process is not closed by a reload');
        assert.strictEqual(record.endedAt, null, 'nothing was written as its ending');
        assert.strictEqual(record.filesReason, 'running',
          'and its list is unsettled for the true reason, because it really has not finished');

        // WHERE THE TWO STORES DELIBERATELY DISAGREE, asserted here rather
        // than smoothed over, because a divergence nothing states is one the
        // next reader meets as a bug.
        //
        // The criterion behind the test above asks the record and the routine
        // state to agree about whether a run is still going. ON THIS PATH THEY
        // DO NOT, and the record is the one telling the truth.
        //
        // Why. loadRoutineState rewrites a routine whose PERSISTED status is
        // 'running' to 'interrupted', because a file on disk cannot tell a
        // dead process's leftovers from a run that is still going. That is
        // pre-existing behaviour, is what the workspace-switch test above
        // relies on to prove the resets ran, and is untouched by this card.
        // The RECORD can tell the two apart, because this process knows which
        // runs it opened, so it stays 'running'.
        //
        // WHICH REQUIREMENT WINS, AND WHY. Keeping a live run's record open
        // wins. Closing it to make the two stores agree would write that a run
        // still going was cut short: a false statement, produced to satisfy a
        // criterion, about the exact case the criterion for this test exists
        // to protect. Agreement is worth having where both stores can be
        // right, and it is not worth buying with a lie. Making the ROUTINE
        // STATE respect a live run instead would fix the disagreement from the
        // other side, and that is a change to startup behaviour older than
        // this card and is not made here.
        //
        // If that pre-existing behaviour is ever fixed, this assertion is
        // where it lands: it fails, and this comment is the account of what
        // changed and why the divergence used to be tolerated.
        assert.strictEqual(sched.routineState[KEY].status, 'interrupted',
          'the routine state was rewritten by the load, which is behaviour older than this card');
        assert.notStrictEqual(record.status, sched.routineState[KEY].status,
          'so the two stores disagree here, knowingly, and the record is the one that is right');

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

const LATE_ROUTINE = [{ name: 'late', schedule: 'every day at 23:00', prompt: 'p' }];
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

    writeRoutineAgent(ws, [{ name: 'renamed', schedule: 'every day at 23:00', prompt: 'p' }]);
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
    writeRoutineAgent(ws, [{ name: 'weekly', schedule: 'every friday at 23:00', prompt: 'p' }]);
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

    writeRoutineAgent(ws, [{ name: 'late', schedule: 'every day at 22:00', prompt: 'p' }]);
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
    writeRoutineAgent(ws, [{ name: 'late', schedule: 'every day at 23:00', prompt: 'p', paused: true }]);
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

    writeRoutineAgent(ws, [{ name: 'late', schedule: 'every day at 22:00', prompt: 'p' }]);
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
    writeRoutineAgent(ws, [{ name: 'late', schedule: 'every day at 05:00', prompt: 'p', paused: true }]);

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
    writeRoutineAgent(ws, [{ name: 'late', schedule: 'every day at 9:00', prompt: 'p' }]);
    observeOnce(t, sched, new Date(2026, 7, 17, 8, 0, 0));

    writeRoutineAgent(ws, LATE_ROUTINE);
    observeOnce(t, sched, new Date(2026, 7, 19, 8, 0, 0));
    assert.deepStrictEqual(sched.routineSlots.routines[LATE_KEY].missed, [],
      'no slot passed on the days the schedule named no time at all');
    assert.strictEqual(sched.routineSlots.routines[LATE_KEY].due, new Date(2026, 7, 19, 23, 0, 0).toISOString(),
      'and the anchor resynced once the schedule parsed again');
  });
});
