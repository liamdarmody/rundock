'use strict';
// A slot that passed while nobody was watching leaves a record.
//
// The whole point of the card is the SEPARATION: a record that a slot passed
// must not land in the one field double-fire suppression reads, because that
// field is what decides whether the routine may still run. So every test here
// asserts both halves. "A record appeared" on its own is satisfied by code
// that records a gap and breaks the guard; "it still ran" on its own is
// satisfied by code that records nothing at all.
//
// Setup is the scheduler-clock template: stop the boot-armed tick FIRST, then
// mock setInterval, then start, so the interval being driven is the mocked one.
// The clock is the scheduler's own seam, so six days pass in one 60-second
// interval and nothing here rests on how late a tick arrived.
//
// One agent, one routine, and each test resets the timeline and re-establishes
// it with a REAL run rather than a hand-written state literal. What a run
// leaves behind is production's shape, not the test's guess at it.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const h = require('../helpers/harness.js');
const { agentFile } = require('../helpers/workspace.js');

const scheduler = require('../../lib/scheduler.js');

const AGENT = 'sleeper';
const KEY = 'sleeper:briefing';
const BODY = 'briefing routine body';

// August 2026, local components, so the fixture is timezone-independent.
const at = (day, hour, minute = 0) => new Date(2026, 7, day, hour, minute, 0);
const slot = (day) => at(day, 5).toISOString();

before(async () => {
  await h.boot({
    agents: {
      sleeper: agentFile({
        name: 'sleeper', type: 'specialist', order: 1,
        routines: [{ name: 'briefing', schedule: 'every day at 05:00', prompt: BODY, enabled: true }],
      }),
    },
  });
  h.writeScenario([
    { match: { agent: AGENT, promptIncludes: BODY }, turn: [{ text: 'routine ran' }] },
  ]);
});
after(h.shutdown);

// Everything the scheduler remembers about this routine, dropped so each test
// starts from a machine that has never seen it. Deliberately NOT a fresh
// module: these are the live objects production mutates.
function resetTimeline() {
  h.internal.stopScheduler();
  delete h.internal.routineState[KEY];
  h.internal.routineSlots.observedAt = null;
  for (const k of Object.keys(h.internal.routineSlots.routines)) delete h.internal.routineSlots.routines[k];
  h.clearPrompts();
}

function slots() { return h.internal.routineSlots.routines[KEY]; }
function missedSlots() { return (slots() ? slots().missed : []).map(m => m.slot); }
function runCount() { return h.promptsFor(AGENT).filter(p => p.includes(BODY)).length; }

/** Tick once, and wait for any run it started to reach an outcome. */
async function settle(t) {
  t.mock.timers.tick(60_000);
  await h.waitUntil(() => {
    const s = h.internal.routineState[KEY];
    return !s || s.status !== 'running';
  });
}

test('five days closed leave five records naming the five slots, and start no runs', async (t) => {
  const clock = { at: at(15, 5, 30) };
  const prevDeps = scheduler.wireSchedulerDeps({ now: () => clock.at });
  resetTimeline();
  t.mock.timers.enable({ apis: ['setInterval'] });
  try {
    h.internal.startScheduler();

    // Saturday the 15th: the routine is seen for the first time and runs. This
    // is what makes the machine "closed for five days" rather than "never
    // opened": there is an observation to be absent from.
    await settle(t);
    assert.strictEqual(runCount(), 1, 'the routine ran on the day the machine was open');
    assert.deepStrictEqual(missedSlots(), [],
      'a routine seen for the first time has no history, so no slot is reported missed');
    assert.strictEqual(slots().due, slot(15), "the day's scheduled instant is persisted, not discarded");
    const guardBefore = { ...h.internal.routineState[KEY] };

    // Six days later, in ONE punctual 60-second interval. The interval was not
    // late by a second; the clock moved. Detection that rested on how late a
    // tick arrived would have nothing to work with here.
    clock.at = at(21, 3, 0);
    await settle(t);

    assert.deepStrictEqual(missedSlots(), [slot(16), slot(17), slot(18), slot(19), slot(20)],
      'five closed days left five records, each naming the instant that passed');
    assert.deepStrictEqual(Object.keys(slots().missed[0]), ['slot'],
      'the record carries the scheduled instant and nothing else: no duration, no status, no claim a run happened');
    assert.strictEqual(runCount(), 1,
      'and five closed days produced zero catch-up runs: never five runs in one day');
    assert.deepStrictEqual(h.internal.routineState[KEY], guardBefore,
      'recording the gaps did not touch the field double-fire suppression reads');
    assert.strictEqual(slots().due, slot(21), 'the next due instant moved to today');

    // The routine is not broken by carrying records: at its own time, it runs.
    // Without this the assertions above are satisfied by a scheduler that
    // would never fire this routine again.
    clock.at = at(21, 5, 0);
    await settle(t);
    assert.strictEqual(runCount(), 2, 'at 05:00 on the sixth day it ran, once');
    assert.strictEqual(missedSlots().length, 5, 'and running did not disturb the records');
  } finally {
    h.internal.stopScheduler();
    t.mock.timers.reset();
    scheduler.wireSchedulerDeps(prevDeps);
  }
});

test('a routine carrying records still catches up within its own day, and is then suppressed', async (t) => {
  const clock = { at: at(15, 5, 30) };
  const prevDeps = scheduler.wireSchedulerDeps({ now: () => clock.at });
  resetTimeline();
  t.mock.timers.enable({ apis: ['setInterval'] });
  try {
    h.internal.startScheduler();
    await settle(t);
    assert.strictEqual(runCount(), 1, 'the routine ran on the day the machine was open');

    // Woken on the sixth day AFTER 05:00. Five slots are gone for good and
    // today's has passed but is still inside its own day, so it catches up.
    //
    // THIS IS THE CARD. Write the gap into routineState[KEY] and the daily
    // suppression fires on the instant it was noticed, and the catch-up run
    // below never happens.
    clock.at = at(21, 9, 0);
    await settle(t);

    assert.deepStrictEqual(missedSlots(), [slot(16), slot(17), slot(18), slot(19), slot(20)],
      'the five closed days were recorded');
    assert.strictEqual(runCount(), 2,
      "today's slot was caught up despite the records, so the guard was not corrupted");
    assert.strictEqual(h.internal.routineState[KEY].lastRun, at(21, 9).toISOString(),
      'the run stamped the field the guard reads, and the gaps did not');
    assert.strictEqual(h.internal.routineState[KEY].status, 'completed',
      'a real run, not a record dressed as one');

    // And the guard still guards: the same day, past the same hour, no second
    // run. A catch-up window without suppression is a double-fire.
    clock.at = at(21, 9, 30);
    await settle(t);
    assert.strictEqual(runCount(), 2, 'having run today, it did not run again');
    assert.strictEqual(missedSlots().length, 5, 'and no slot was invented for the day it ran');
  } finally {
    h.internal.stopScheduler();
    t.mock.timers.reset();
    scheduler.wireSchedulerDeps(prevDeps);
  }
});

test('a tick eleven hours late records nothing, because no scheduled slot passed', async (t) => {
  const clock = { at: at(15, 5, 30) };
  const prevDeps = scheduler.wireSchedulerDeps({ now: () => clock.at });
  resetTimeline();
  t.mock.timers.enable({ apis: ['setInterval'] });
  try {
    h.internal.startScheduler();
    await settle(t);
    assert.strictEqual(runCount(), 1, 'the routine ran at 05:30');

    // Eleven and a quarter hours pass between two ticks: a sleeping machine, a
    // starved event loop, a suspended laptop. Nothing can tell them apart, and
    // nothing here needs to, because no 05:00 slot lies between 05:30 and 23:45.
    clock.at = at(15, 23, 45);
    await settle(t);
    assert.deepStrictEqual(missedSlots(), [],
      'a very late tick that crossed no scheduled instant left no record');
    assert.strictEqual(runCount(), 1, 'and started no run');

    // The positive control, on the same routine through the same code: move
    // past a slot instead of merely arriving late, and the record appears. An
    // "it recorded nothing" assertion is otherwise satisfied by a tick that
    // records nothing ever.
    clock.at = at(17, 6, 0);
    await settle(t);
    assert.deepStrictEqual(missedSlots(), [slot(16)],
      'crossing an unwatched 05:00 is what writes a record, not the size of the gap');
  } finally {
    h.internal.stopScheduler();
    t.mock.timers.reset();
    scheduler.wireSchedulerDeps(prevDeps);
  }
});
