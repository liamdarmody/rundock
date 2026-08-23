'use strict';
// The scheduler's lifecycle, driven the way a user reaches it.
//
// WHY THIS FILE EXISTS AND THE EIGHT BEFORE IT DID NOT CATCH THIS.
//
// Eight suites proved the tick: catch-up, single-flight, missed slots, run
// records, the schedule grammar, DST. Every one of them armed the tick by
// calling startScheduler() itself. Not one asked who calls it in the product,
// and the answer was one boot path guarded by `if (WORKSPACE)`. Install, open,
// choose a folder, and nothing was watching the clock until a restart.
//
// So nothing in this file calls startScheduler or stopScheduler. Every test
// arms the scheduler by sending the message the client sends when someone
// picks a folder ({type:'set_workspace'}, public/app.js), and reads the result
// through the tick's own behaviour. Calling the starter is exactly the habit
// that let the defect ship while the suite stayed green.
//
// The server boots here with NO workspace, which is the state a first run
// starts in and the state the defect needed.
//
// NOTHING HERE DEPENDS ON THE MACHINE. The clock is wired through the
// scheduler's seam, the home directory is a temp dir the harness makes, every
// workspace is built by the test that uses it, and the interval is driven by
// mock timers rather than elapsed time. The two instants are local-time
// constructions, so a schedule written in local time and a clock read in local
// time agree in any zone.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const h = require('../helpers/harness.js');
const { agentFile, makeWorkspace, makeTempDir } = require('../helpers/workspace.js');

const scheduler = require('../../lib/scheduler.js');

const KEY = 'punctual:clock-check';
const SCHEDULE = 'every day at 09:00';
const ROUTINE_BODY = 'clock routine body';
// Wednesday 2026-07-01, local time.
const BEFORE_NINE = new Date(2026, 6, 1, 8, 0, 0);
const AFTER_NINE = new Date(2026, 6, 1, 9, 30, 0);

function punctualAgents() {
  return {
    punctual: agentFile({
      name: 'punctual', type: 'specialist', order: 1,
      routines: [{ name: 'clock-check', schedule: SCHEDULE, prompt: ROUTINE_BODY }],
    }),
  };
}

// A workspace with a routine due at 09:00 every day.
function punctualWorkspace() {
  return makeWorkspace({ claudeMd: '# Punctual fixture\n', agents: punctualAgents() });
}

// A workspace with an agent and no routines: a tick over it does exactly one
// thing, which is what makes the clock reads below countable.
function idleWorkspace() {
  return makeWorkspace({
    claudeMd: '# Idle fixture\n',
    agents: { idle: agentFile({ name: 'idle', type: 'specialist', order: 1 }) },
  });
}

// What the stub recorded in a given workspace. The stub writes to its cwd, and
// a routine runs with cwd set to the workspace it belongs to, so this asks the
// question per workspace rather than only for the harness fixture.
function promptsIn(dir) {
  const file = path.join(dir, 'stub-prompts.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

// Choose a folder, exactly as the interface does it. The reply is awaited so
// the open has finished before anything is asserted about it.
async function choose(client, dir) {
  const since = client.messages.length;
  client.send({ type: 'set_workspace', path: dir });
  const { msg } = await client.waitFor(
    m => m.type === 'workspace_set' || m.type === 'workspace_error',
    { since, label: `workspace_set for ${dir}` },
  );
  assert.strictEqual(msg.type, 'workspace_set', `choosing ${dir} failed: ${msg.message}`);
  return msg;
}

// Hand the scheduler a REAL interval handle before mock timers are enabled.
//
// Mock timers are per test, and a handle made by one test's instance poisons
// the next: clearing it inside a LATER instance leaves that instance unable to
// fire anything at all. That is node's behaviour rather than Rundock's, and it
// reproduces in a plain node --test file with no Rundock in it. The scheduler
// is holding exactly such a handle at the end of every test below, and the
// next workspace change clears it, so without this the second test onwards
// would drive a tick that can never fire and read that as the defect.
//
// Arming on real timers first means the clear that happens under the mock is a
// clear of a real handle, which is safe. Nothing here calls the starter: this
// is the same workspace-set path every test drives, down the same socket.
async function armOnRealTimers(client) {
  await choose(client, idleWorkspace());
}

before(async () => {
  // The fixture the harness builds is a punctual workspace, because the one
  // test that lets a routine run to completion needs the stub's scenario and
  // its logs to sit in the workspace the harness knows the name of.
  await h.boot({ workspace: false, agents: punctualAgents() });
});
after(h.shutdown);

// The state the defect needed, pinned before anything below changes it: an
// installed Rundock that has been opened and not yet pointed at a folder.
test('a first run has no workspace and nothing watching the clock', () => {
  assert.strictEqual(h.internal.getWorkspace(), null, 'no workspace yet');
  assert.strictEqual(h.internal.schedulerRunning(), false,
    'and no scheduler: there is nothing for one to watch');
});

describe('choosing a workspace starts the scheduler', () => {
  // AC-1 and AC-2. The routine is watched NOT firing an hour before its time
  // and then firing after it, from the same fixture, because "it did not fire"
  // on its own is satisfied by a scheduler that was never going to fire.
  test('choosing a folder arms the tick, and the routine runs when its time comes', async (t) => {
    h.writeScenario([
      { match: { agent: 'punctual', promptIncludes: ROUTINE_BODY }, turn: [{ text: 'routine ran' }] },
    ]);
    const client = await h.connect();
    const clock = { at: BEFORE_NINE };
    const prevDeps = scheduler.wireSchedulerDeps({ now: () => clock.at });
    // Enabled BEFORE the folder is chosen, so the interval the open arms is
    // the one this test drives. There is no other way to get hold of it
    // without calling the starter.
    t.mock.timers.enable({ apis: ['setInterval'] });
    try {
      await choose(client, h.workspaceDir);

      t.mock.timers.tick(60_000);
      assert.strictEqual(h.internal.routineState[KEY], undefined,
        'an hour before its time the routine has not run');

      clock.at = AFTER_NINE;
      t.mock.timers.tick(60_000);
      const started = h.internal.routineState[KEY];
      assert.ok(started,
        'choosing the folder armed a tick: past 09:00 the routine fired, with nobody calling the starter');
      assert.strictEqual(started.lastRun, AFTER_NINE.toISOString(),
        'and it was stamped with the wired clock rather than the wall clock');

      clock.at = new Date(AFTER_NINE.getTime() + 60_000);
      const finished = await h.waitUntil(() => {
        const s = h.internal.routineState[KEY];
        return s && s.status !== 'running';
      });
      assert.ok(finished, 'the fired routine reached an outcome');
      assert.strictEqual(h.internal.routineState[KEY].status, 'completed',
        'the routine the chosen workspace released ran through to completion');
      assert.strictEqual(promptsIn(h.workspaceDir).length, 1,
        'and it ran once');
    } finally {
      t.mock.timers.reset();
      scheduler.wireSchedulerDeps(prevDeps);
      client.close();
    }
  });

  // AC-3. The trap this criterion exists for: a scheduler armed from a path
  // that fires often leaves two tickers, and two tickers are worse than none.
  // Counted rather than inferred, and calibrated against a single choose so
  // the number does not depend on how many clock reads one pass happens to
  // make.
  test('choosing a workspace twice leaves one ticker, not two', async (t) => {
    const dir = idleWorkspace();
    const client = await h.connect();
    await armOnRealTimers(client);
    let reads = 0;
    const prevDeps = scheduler.wireSchedulerDeps({ now: () => { reads++; return BEFORE_NINE; } });
    t.mock.timers.enable({ apis: ['setInterval'] });
    try {
      await choose(client, dir);
      reads = 0;
      t.mock.timers.tick(60_000);
      const oneTicker = reads;
      assert.ok(oneTicker > 0, 'sanity: one choose arms a tick that reads the clock');

      await choose(client, dir);
      reads = 0;
      t.mock.timers.tick(60_000);
      assert.strictEqual(reads, oneTicker,
        'the second choose did not add a second ticker: the minute cost exactly one pass');
    } finally {
      t.mock.timers.reset();
      scheduler.wireSchedulerDeps(prevDeps);
      client.close();
    }
  });
});

describe('switching away stops the scheduler that was running', () => {
  // AC-4. The old ticker is thirty seconds from firing when the switch
  // happens. If it survived, the next thirty seconds would fire it. A ticker
  // armed for the new workspace is only thirty seconds old and does not.
  //
  // Both halves are one test on purpose: "it did not fire" alone is satisfied
  // by a scheduler that was never armed, so the second half fires the same
  // ticker thirty seconds later to prove one was.
  test('switching away re-arms the tick rather than leaving the old one running', async (t) => {
    const first = idleWorkspace();
    const second = idleWorkspace();
    const client = await h.connect();
    await armOnRealTimers(client);
    let reads = 0;
    const prevDeps = scheduler.wireSchedulerDeps({ now: () => { reads++; return BEFORE_NINE; } });
    t.mock.timers.enable({ apis: ['setInterval'] });
    try {
      await choose(client, first);
      t.mock.timers.tick(30_000);

      await choose(client, second);
      reads = 0;
      t.mock.timers.tick(30_000);
      assert.strictEqual(reads, 0,
        'the ticker running for the old workspace was thirty seconds from its minute and is gone');

      t.mock.timers.tick(30_000);
      assert.ok(reads > 0,
        'and the workspace switched to has a ticker of its own, on its own minute');
    } finally {
      t.mock.timers.reset();
      scheduler.wireSchedulerDeps(prevDeps);
      client.close();
    }
  });

  // AC-5 and AC-6. The clock is advanced past a slot the workspace that was
  // LEFT was due at, and nothing about that workspace moves.
  //
  // THE THREE ABSENCES AT THE END OF THIS TEST DO NOT, ON THEIR OWN, PROVE
  // ANYTHING ABOUT THE STOP, and saying so is the point of this comment. The
  // tick reads the workspace root at use time, through discoverAgents, so a
  // ticker that survived the switch would discover the roster of the workspace
  // just ENTERED. It could never fire a routine belonging to the one that was
  // left, whether it was stopped, left running, or never armed. An absence
  // guaranteed by the scheduler's use-time read is not evidence about the
  // lifecycle, and a first version of this test asserted only that.
  //
  // So the absences stay, because they are what the criterion asks for in so
  // many words, and the observation that DOES differ is made beside them:
  // whether the ticker armed for the workspace that was left is still there
  // afterwards. That is read through the phase of the tick rather than through
  // anything it spawned. The pre-switch ticker is left thirty seconds from its
  // minute; if it survived, those thirty seconds would run a pass. They run
  // none, and the thirty after them run one, which is what proves a ticker
  // exists to have been counted at all.
  test('the previous workspace routine does not fire when its slot passes', async (t) => {
    const left = punctualWorkspace();
    const entered = idleWorkspace();
    const client = await h.connect();
    await armOnRealTimers(client);
    const clock = { at: BEFORE_NINE };
    let reads = 0;
    const prevDeps = scheduler.wireSchedulerDeps({ now: () => { reads++; return clock.at; } });
    t.mock.timers.enable({ apis: ['setInterval'] });
    try {
      await choose(client, left);

      // The premise, asserted rather than assumed: choosing the workspace armed
      // a ticker, and it is the mocked one this test can drive. Everything
      // below is about that ticker, so silence from a ticker that was never
      // armed would otherwise read as silence from one that was stopped.
      t.mock.timers.tick(60_000);
      assert.ok(reads > 0, 'the workspace that is about to be left had a ticker of its own');

      // Thirty seconds into its next minute, so the switch catches it mid-cycle
      // and its survival is a question the next thirty seconds answer.
      t.mock.timers.tick(30_000);

      await choose(client, entered);

      clock.at = AFTER_NINE;
      reads = 0;
      t.mock.timers.tick(30_000);
      assert.strictEqual(reads, 0,
        'past 09:00, and the ticker that was running for the workspace that was left did not '
        + 'complete the minute it was thirty seconds from: it is gone, not merely looking elsewhere');

      t.mock.timers.tick(30_000);
      assert.ok(reads > 0, 'while the workspace switched to has a ticker on its own minute');

      assert.strictEqual(h.internal.routineState[KEY], undefined,
        'past 09:00 and the routine belonging to the workspace that was left has no run state');
      assert.deepStrictEqual(promptsIn(left), [],
        'nothing was ever spawned in the workspace that was left');
      assert.strictEqual(fs.existsSync(path.join(left, '.rundock', 'routine-state.json')), false,
        'and no run was recorded there');
    } finally {
      t.mock.timers.reset();
      scheduler.wireSchedulerDeps(prevDeps);
      client.close();
    }
  });

  // AC-4 again, for the switch that has nowhere to land. A workspace that
  // disappears clears the pointer through the picker's own refresh, and the
  // scheduler that was running for it must go with it. This is the case where
  // the stop is the only thing doing the work: there is no new workspace whose
  // start could cover for it.
  //
  // The pointer is put there by the product's own workspace setter rather than
  // by choosing over the wire, and that is forced rather than chosen: opening a
  // folder writes to its .rundock, and those writes recreate the directory
  // faster than a test can delete it, so a workspace opened over the wire never
  // reads as vanished. test/integration/workspace-picker.test.js sets the
  // pointer the same way for the same reason. The clearing itself, which is
  // what this test is about, still goes through the real handler over the real
  // socket.
  test('a workspace that disappears takes its ticker with it', async (t) => {
    const doomed = makeTempDir('rundock-test-doomed-');
    const client = await h.connect();
    await armOnRealTimers(client);
    const clock = { at: BEFORE_NINE };
    let reads = 0;
    const prevDeps = scheduler.wireSchedulerDeps({ now: () => { reads++; return clock.at; } });
    t.mock.timers.enable({ apis: ['setInterval'] });
    try {
      h.internal.setWorkspace(doomed);
      assert.strictEqual(h.internal.schedulerRunning(), true,
        'the workspace it is about to lose had a ticker, so there is one to stop');
      fs.rmSync(doomed, { recursive: true, force: true });

      // The refresh the client sends whenever it asks what workspaces exist.
      // It is what notices the directory has gone and clears the pointer.
      const since = client.messages.length;
      client.send({ type: 'get_workspaces' });
      await client.waitFor(m => m.type === 'workspaces', { since, label: 'workspaces' });
      assert.strictEqual(h.internal.getWorkspace(), null,
        'the pointer to the vanished workspace is cleared');
      // Asked of the interval handle the tick itself depends on. Counting tick
      // bodies below is the behaviour, but a ticker that survives a clear can
      // sit on a handle the mock clock never drives, and then silence proves
      // nothing. This is the assertion that goes red when the stop is removed.
      assert.strictEqual(h.internal.schedulerRunning(), false,
        'and the ticker that was running for it is stopped rather than left over');

      clock.at = AFTER_NINE;
      reads = 0;
      t.mock.timers.tick(180_000);
      assert.strictEqual(reads, 0,
        'three minutes past a slot the old workspace was due at, and no tick body ran at all');
      assert.strictEqual(h.internal.routineState[KEY], undefined,
        'so nothing started');
    } finally {
      t.mock.timers.reset();
      scheduler.wireSchedulerDeps(prevDeps);
      client.close();
    }
  });
});

describe('what the lifecycle must not disturb', () => {
  // AC-10. lastRun is the sole input to double-fire suppression. Opening a
  // workspace must not write it, or every open re-arms or cancels a run that
  // was already decided. Asserted on the file as well as the object, because
  // the file is what survives the restart the suppression exists for.
  test('choosing a workspace does not write the value suppression reads', async (t) => {
    const dir = punctualWorkspace();
    const alreadyRan = new Date(2026, 6, 1, 9, 5, 0);
    const stateFile = path.join(dir, '.rundock', 'routine-state.json');
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(
      { [KEY]: { lastRun: alreadyRan.toISOString(), status: 'completed', duration: 3 } }, null, 2));
    const before = fs.readFileSync(stateFile, 'utf-8');

    const client = await h.connect();
    await armOnRealTimers(client);
    const clock = { at: AFTER_NINE };
    const prevDeps = scheduler.wireSchedulerDeps({ now: () => clock.at });
    t.mock.timers.enable({ apis: ['setInterval'] });
    try {
      await choose(client, dir);
      assert.strictEqual(h.internal.routineState[KEY].lastRun, alreadyRan.toISOString(),
        'the open read the suppression value and left it alone');

      t.mock.timers.tick(60_000);
      assert.strictEqual(h.internal.routineState[KEY].lastRun, alreadyRan.toISOString(),
        'and the tick it armed did not re-fire a routine that had already run today');
      assert.deepStrictEqual(promptsIn(dir), [], 'nothing was spawned');
      assert.strictEqual(fs.readFileSync(stateFile, 'utf-8'), before,
        'the file the suppression is read from after a restart is byte-identical');
    } finally {
      t.mock.timers.reset();
      scheduler.wireSchedulerDeps(prevDeps);
      client.close();
    }
  });

  // The tick reads two stores that have to describe the same workspace: the
  // roster, through getWorkspace() at use time, and routineState. The root
  // changes first, so anything armed before the state is loaded is armed into a
  // window where the two disagree, and a tick landing there judges the new
  // roster against the old workspace's lastRun.
  //
  // WHY THIS IS OBSERVED AT THE ARMING RATHER THAN THROUGH A TICK. The window
  // is inside one synchronous call: nothing yields between the arm and the load
  // today, so no tick can be driven into it, and a test that advanced the clock
  // would pass under either ordering and prove nothing. What distinguishes the
  // two orderings is the state that EXISTS at the moment the interval is
  // created, so that is what this reads, by standing in front of setInterval
  // and taking a copy. The scheduler's is the only sixty-second interval armed
  // on this path.
  //
  // Both workspaces declare the same agent and the same routine name, so they
  // share a routine key. That is the case the disagreement actually bites in,
  // and the one a workspace copied or renamed produces by accident.
  test('the state a tick will read is loaded before the tick is armed', async (t) => {
    const ranAt = new Date(2026, 6, 1, 9, 5, 0);
    const left = punctualWorkspace();
    const leftState = path.join(left, '.rundock', 'routine-state.json');
    fs.mkdirSync(path.dirname(leftState), { recursive: true });
    fs.writeFileSync(leftState, JSON.stringify(
      { [KEY]: { lastRun: ranAt.toISOString(), status: 'completed', duration: 3 } }, null, 2));
    // Same agent, same routine, so the same key. Never run.
    const entered = punctualWorkspace();

    const client = await h.connect();
    await armOnRealTimers(client);
    const clock = { at: AFTER_NINE };
    const prevDeps = scheduler.wireSchedulerDeps({ now: () => clock.at });
    t.mock.timers.enable({ apis: ['setInterval'] });
    const armed = [];
    const wrapped = global.setInterval;
    global.setInterval = (fn, ms, ...rest) => {
      if (ms === 60_000) armed.push(JSON.parse(JSON.stringify(h.internal.routineState)));
      return wrapped(fn, ms, ...rest);
    };
    try {
      await choose(client, left);
      assert.strictEqual(h.internal.routineState[KEY].lastRun, ranAt.toISOString(),
        'the workspace being left has a run recorded for the shared key');

      armed.length = 0;
      await choose(client, entered);

      assert.strictEqual(armed.length, 1,
        'exactly one tick was armed while entering the workspace');
      assert.strictEqual(armed[0][KEY], undefined,
        'and at the moment it was armed the state already described the workspace being ENTERED, '
        + 'which has never run this routine. Armed first, it would have held the run the workspace '
        + 'being LEFT recorded at 09:05, and suppressed a routine that was due');
    } finally {
      global.setInterval = wrapped;
      t.mock.timers.reset();
      scheduler.wireSchedulerDeps(prevDeps);
      client.close();
    }
  });

  // AC-11. A run that was in flight when the workspace changed must not be
  // fired again by the scheduler the change arms. The hold that prevents it is
  // deliberately not cleared by the state reload a switch performs, and this
  // pins that: the switch goes away and comes back, and the routine that was
  // running is not started a second time in its window.
  test('a routine mid-run when the workspace is switched is not re-fired by the new start', async (t) => {
    const elsewhere = idleWorkspace();
    // Held open long enough that the switch below happens while the run is
    // genuinely in flight rather than after it.
    h.writeScenario([
      { match: { agent: 'punctual', promptIncludes: ROUTINE_BODY }, delayMs: 4000, turn: [{ text: 'still going' }] },
    ]);
    h.clearPrompts();
    delete h.internal.routineState[KEY];

    const client = await h.connect();
    await armOnRealTimers(client);
    // A day after the run the first test in this file left behind, so the
    // routine is due again rather than suppressed by it.
    const dueAgain = new Date(2026, 6, 2, 9, 30, 0);
    const clock = { at: dueAgain };
    const prevDeps = scheduler.wireSchedulerDeps({ now: () => clock.at });
    t.mock.timers.enable({ apis: ['setInterval'] });
    try {
      await choose(client, h.workspaceDir);
      t.mock.timers.tick(60_000);
      assert.strictEqual(h.internal.routineState[KEY].status, 'running',
        'the routine is in flight at the moment the workspace changes');
      // The stub writes its prompt log from the child, so the spawn is
      // observable a moment after the tick that caused it.
      const spawned = await h.waitUntil(() => promptsIn(h.workspaceDir).length === 1);
      assert.ok(spawned, `it started once, not ${promptsIn(h.workspaceDir).length} times`);

      await choose(client, elsewhere);
      await choose(client, h.workspaceDir);

      t.mock.timers.tick(60_000);
      // Real elapsed time, because this asserts something did NOT happen: a
      // second spawn would take about as long to show up as the first did.
      await h.delay(500);
      assert.strictEqual(promptsIn(h.workspaceDir).length, 1,
        'the scheduler the switch armed did not start the run again');
    } finally {
      t.mock.timers.reset();
      scheduler.wireSchedulerDeps(prevDeps);
      client.close();
    }
  });
});
