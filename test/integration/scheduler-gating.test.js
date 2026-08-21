'use strict';
// A routine's own fields decide whether the tick runs it.
//
// The data model shipped runOn, enabled and paused and the scheduler read
// none of them, so a paused routine fired, a disabled routine fired, and a
// routine reserved for hardware that does not exist yet ran locally.
//
// Every test here drives the real tick, and every refusal test asserts the
// ordinary routine fired on that very tick. "It did not fire" is the absence
// of something, and absence is satisfied by a scheduler that was never going
// to run anything; the control firing beside it is what makes the absence
// mean the gate rather than the path being broken.
//
// The refused routines are seeded with a run from the PREVIOUS day, so the
// assertion is that their stored state is untouched rather than merely
// missing. A refusal that quietly stamped a run would still leave nothing
// spawned, and would still be a routine that never fires again.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const h = require('../helpers/harness.js');
const { agentFile } = require('../helpers/workspace.js');

const scheduler = require('../../lib/scheduler.js');
const { invalidateAgentCache } = require('../../lib/agents/discovery.js');

// Wednesday 2026-07-01 local time, so the fixture is timezone-independent.
// Each refused routine comes due at its own hour, and each test sets the clock
// just past that hour. A single instant that made all three due at once would
// mean the first test's tick announced all three refusals, and the other two
// would then be asserting against an announcement already spent.
const PAST_NINE = new Date(2026, 6, 1, 9, 30, 0);
const PAST_TEN = new Date(2026, 6, 1, 10, 30, 0);
const PAST_ELEVEN = new Date(2026, 6, 1, 11, 30, 0);
const PAST_NOON = new Date(2026, 6, 1, 12, 30, 0);
const LATE = new Date(2026, 6, 1, 23, 30, 0);
// The next two Thursdays. The flip test needs a routine that is not due on
// the Wednesday every other test runs on, or its announcement would be spent
// before it starts, and it needs two separate due windows.
const THURSDAY = new Date(2026, 6, 2, 6, 30, 0);
const NEXT_THURSDAY = new Date(2026, 6, 9, 6, 30, 0);
// Yesterday, so it cannot suppress today's run: the refused routines have to
// be genuinely due, or they prove nothing.
const YESTERDAY = { lastRun: new Date(2026, 5, 30, 9, 5, 0).toISOString(), status: 'completed', duration: 7 };

const PAUSED = 'sleeper:paused-check';
const DISABLED = 'retiree:disabled-check';
const ELSEWHERE = 'traveller:elsewhere-check';
const ORDINARY = 'worker:ordinary-check';
const QUIET = 'mute:quiet-check';

const FLIP = 'flipper:flip-check';

function flipperFile(paused) {
  return agentFile({
    name: 'flipper', type: 'specialist', order: 6,
    routines: [{ name: 'flip-check', schedule: 'every thursday at 06:00', prompt: 'flip body', paused }],
  });
}

const clock = { at: PAST_NINE };
let prevDeps = null;

before(async () => {
  await h.boot({
    agents: {
      sleeper: agentFile({
        name: 'sleeper', type: 'specialist', order: 1,
        routines: [{ name: 'paused-check', schedule: 'every day at 09:00', prompt: 'paused body', paused: true }],
      }),
      retiree: agentFile({
        name: 'retiree', type: 'specialist', order: 2,
        routines: [{ name: 'disabled-check', schedule: 'every day at 10:00', prompt: 'disabled body', enabled: false }],
      }),
      traveller: agentFile({
        name: 'traveller', type: 'specialist', order: 3,
        routines: [{ name: 'elsewhere-check', schedule: 'every day at 11:00', prompt: 'elsewhere body', runOn: 'agent-computer' }],
      }),
      // Declares none of the three fields, so it is also the proof that a
      // routine written before they existed still fires on the model's
      // defaults rather than being refused by an absent value.
      worker: agentFile({
        name: 'worker', type: 'specialist', order: 4,
        routines: [{ name: 'ordinary-check', schedule: 'every day at 08:00', prompt: 'ordinary body' }],
      }),
      // Due only late in the day, so nothing else in this file wakes it and
      // the announcement test can count from zero.
      // Weekly, on a day no other test in this file visits, so its
      // announcements are all its own.
      flipper: flipperFile(true),
      mute: agentFile({
        name: 'mute', type: 'specialist', order: 5,
        routines: [{ name: 'quiet-check', schedule: 'every day at 23:00', prompt: 'quiet body', paused: true }],
      }),
    },
  });
  prevDeps = scheduler.wireSchedulerDeps({ now: () => clock.at });
});

after(async () => {
  if (prevDeps) scheduler.wireSchedulerDeps(prevDeps);
  await h.shutdown();
});

// One tick of the real scheduler, with the console captured. The server armed
// a tick at boot and a second start is a no-op, so the real one goes before
// the mocked one this drives is armed.
function driveTick(t, ticks = 1) {
  const logs = [];
  const realLog = console.log;
  h.internal.stopScheduler();
  t.mock.timers.enable({ apis: ['setInterval'] });
  console.log = (...args) => logs.push(args.join(' '));
  try {
    h.internal.startScheduler();
    for (let i = 0; i < ticks; i++) t.mock.timers.tick(60_000);
  } finally {
    console.log = realLog;
    h.internal.stopScheduler();
    t.mock.timers.reset();
  }
  return logs;
}

// The control has to be able to fire again on the next test's tick, and a run
// recorded at 09:30 suppresses every later one that day.
function armControl() {
  h.writeScenario([
    { match: { agent: 'worker', promptIncludes: 'ordinary body' }, turn: [{ text: 'routine ran' }] },
  ]);
  delete h.internal.routineState[ORDINARY];
}

// Stamped with the wired clock, so this says the control fired on the tick
// just driven. A bare truthiness check on its state would also be satisfied
// by the run it did in the previous test, which would make every refusal
// test's proof-of-life assertion pass without the tick doing anything at all.
function assertControlFiredOnThisTick() {
  const state = h.internal.routineState[ORDINARY];
  assert.ok(state, 'the ordinary routine ran');
  assert.strictEqual(state.lastRun, clock.at.toISOString(),
    'the ordinary routine fired on the tick just driven, so that tick was live');
}

function seed(key) {
  h.internal.routineState[key] = { ...YESTERDAY };
}

test('a paused routine does not fire', (t) => {
  clock.at = PAST_NINE;
  armControl();
  seed(PAUSED);

  const logs = driveTick(t);

  assert.deepStrictEqual(h.internal.routineState[PAUSED], YESTERDAY,
    'the refused routine kept yesterday\'s run: refusing is not recorded as a run');
  assertControlFiredOnThisTick();
  assert.ok(logs.some(l => l.includes('paused-check') && l.includes('paused is true')),
    'the refusal is announced and names the field that caused it');
});

test('a disabled routine does not fire', (t) => {
  clock.at = PAST_TEN;
  armControl();
  seed(DISABLED);

  const logs = driveTick(t);

  assert.deepStrictEqual(h.internal.routineState[DISABLED], YESTERDAY,
    'the refused routine kept yesterday\'s run: refusing is not recorded as a run');
  assertControlFiredOnThisTick();
  assert.ok(logs.some(l => l.includes('disabled-check') && l.includes('enabled is false')),
    'the refusal is announced and names the field that caused it');
});

test('a routine whose runOn is not supported does not fire', (t) => {
  clock.at = PAST_ELEVEN;
  armControl();
  seed(ELSEWHERE);

  const logs = driveTick(t);

  assert.deepStrictEqual(h.internal.routineState[ELSEWHERE], YESTERDAY,
    'the refused routine kept yesterday\'s run: refusing is not recorded as a run');
  assertControlFiredOnThisTick();
  assert.ok(logs.some(l => l.includes('elsewhere-check') && l.includes('runOn is agent-computer')),
    'the refusal is announced and names the field that caused it');
});

test('a routine declaring none of the three fields still fires, and runs through', async (t) => {
  clock.at = PAST_NOON;
  armControl();

  const logs = driveTick(t);

  assert.ok(logs.some(l => l.includes('Running routine') && l.includes('ordinary-check')),
    'the ordinary routine was announced as running, not refused');
  await h.waitUntil(() => {
    const s = h.internal.routineState[ORDINARY];
    return s && s.status !== 'running';
  });
  assert.strictEqual(h.internal.routineState[ORDINARY].status, 'completed',
    'the routine the gate let through ran to completion exactly as before');
});

test('a refusal is announced once, not on every tick for as long as it stays due', (t) => {
  clock.at = LATE;

  const logs = driveTick(t, 3);

  // Filtered on the refusal line rather than on the routine name. Any line
  // mentioning the routine is also satisfied by the tick RUNNING it, which is
  // the fault this whole file exists to fix, and a count of one would then be
  // green for the opposite of the reason claimed.
  const announcements = logs.filter(l => l.includes('Not running routine') && l.includes('quiet-check'));
  assert.strictEqual(announcements.length, 1,
    'a routine refused for the same reason says so once; a refusal never records a run, so it stays due all day');
  assert.strictEqual(h.internal.routineState[QUIET], undefined,
    'and three ticks later it still has not run');
});

// The line that forgets an announcement is a WRITE, and a write is proved by
// removing it rather than by breaking a read. Nothing else in this file can
// see it: every other routine keeps one setting for the whole run, and for
// those a scheduler that never forgot anything behaves identically. This is
// the case where it does not: refused, released, refused again for the same
// reason, which has to be announced twice or the second refusal is invisible
// to whoever is reading the log to find out why nothing ran.
test('a routine refused, released and refused again says so both times', async (t) => {
  const file = path.join(h.workspaceDir, '.claude', 'agents', 'flipper.md');
  h.writeScenario([
    { match: { agent: 'flipper', promptIncludes: 'flip body' }, turn: [{ text: 'routine ran' }] },
  ]);

  clock.at = THURSDAY;
  const first = driveTick(t);
  assert.strictEqual(h.internal.routineState[FLIP], undefined, 'refused, so nothing ran');

  fs.writeFileSync(file, flipperFile(false));
  invalidateAgentCache();
  driveTick(t);
  await h.waitUntil(() => {
    const s = h.internal.routineState[FLIP];
    return s && s.status !== 'running';
  });
  assert.strictEqual(h.internal.routineState[FLIP].status, 'completed',
    'released, so it ran: the release is real and not just a quieter refusal');

  fs.writeFileSync(file, flipperFile(true));
  invalidateAgentCache();
  clock.at = NEXT_THURSDAY;
  const third = driveTick(t);

  const announced = (logs) => logs.filter(l => l.includes('Not running routine') && l.includes('flip-check'));
  assert.strictEqual(announced(first).length, 1, 'the first refusal was announced');
  assert.strictEqual(announced(third).length, 1, 'and so was the refusal a week later, after the release in between');
});
