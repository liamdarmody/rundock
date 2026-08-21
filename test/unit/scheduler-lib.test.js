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
      fs.rmSync(ws, { recursive: true, force: true });
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
