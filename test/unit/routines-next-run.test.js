'use strict';
// The one path that produces every row's next-run time, and the wall it must
// not be read through.
//
// WHY THIS FILE EXISTS SEPARATELY FROM THE MODEL'S TESTS. The routines list is
// the FIRST consumer of the slot records. Until this card there was no reader
// at all, and the separation between the two stores held partly because of
// that. The scheduler keeps `routineState`, whose `lastRun` is the ONLY input
// to double-fire suppression, and it keeps the slot records, which say when a
// routine was due and which slots passed unserved. Reading the slot store's
// `due` into the suppression argument would type-check, would read as a tidy
// simplification, and would silently break catch-up. Nothing mechanical
// prevents it. This file is the mechanism.
//
// EVERY DATE IS BUILT FROM LOCAL COMPONENTS and read back through local
// getters, so nothing here describes the machine it runs on. The zone is set
// before the first require for the same reason the daylight-saving file sets
// one: node --test gives every file its own process, and continuous
// integration runs in UTC.
process.env.TZ = 'Europe/London';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { agentFile } = require('../helpers/workspace.js');
const { invalidateAgentCache, discoverAgents } = require('../../lib/agents/discovery.js');
const SCHEDULER_KEY = require.resolve('../../lib/scheduler.js');
const CLAUDE_KEY = require.resolve('../../lib/runtime/claude.js');

// A private copy per test, so wiring never leaks into the shared instance.
function freshScheduler() {
  const cached = require.cache[SCHEDULER_KEY];
  delete require.cache[SCHEDULER_KEY];
  const mod = require(SCHEDULER_KEY);
  delete require.cache[SCHEDULER_KEY];
  if (cached) require.cache[SCHEDULER_KEY] = cached;
  return mod;
}

// The shared instance, wired for the length of one test and put back after.
// Used where the assertion has to travel through discoverAgents, which
// requires the shared module rather than any private copy.
function withSharedScheduler(fn) {
  const sched = require(SCHEDULER_KEY);
  const prev = sched.wireSchedulerDeps({ now: () => NOW });
  const state = JSON.parse(JSON.stringify(sched.routineState));
  const slots = JSON.parse(JSON.stringify(sched.routineSlots));
  try {
    return withWorkspace(() => fn(sched));
  } finally {
    sched.wireSchedulerDeps(prev);
    for (const key of Object.keys(sched.routineState)) delete sched.routineState[key];
    Object.assign(sched.routineState, state);
    for (const key of Object.keys(sched.routineSlots.routines)) delete sched.routineSlots.routines[key];
    Object.assign(sched.routineSlots, slots);
  }
}

const SCHEDULE = 'every day at 07:00';
const KEY = 'piper:Compile the ops summary';

// A workspace holding one agent with one daily routine at 7:00am, torn down
// after. The mock's own setup: one routine, one agent, one execution target.
function withWorkspace(fn, opts = {}) {
  const config = require('../../lib/config.js');
  const original = config.getWorkspace();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'routines-next-run-'));
  config.setWorkspace(ws);
  const dir = path.join(ws, '.claude', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'piper.md'), agentFile({
    name: 'piper', displayName: 'Piper', type: 'specialist', order: 1,
    routines: [{ name: 'Compile the ops summary', schedule: SCHEDULE, prompt: 'p', ...(opts.routine || {}) }],
  }));
  invalidateAgentCache();
  try {
    return fn(freshScheduler(), ws);
  } finally {
    config.setWorkspace(original);
    invalidateAgentCache();
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

// A scheduler whose child processes never reach a real binary. Same technique
// and the same reason as test/unit/scheduler-lib.test.js: the wiring seam
// reaches the clock and the socket, and neither is a child process.
function withFakeSpawn(fn) {
  const claude = require(CLAUDE_KEY);
  const realSpawn = claude.spawnClaude;
  const prevDeps = claude.wireClaudeRuntimeDeps({ getActualPort: () => 0 });
  const started = [];
  claude.spawnClaude = (args, opts) => {
    started.push({ args, opts });
    const { EventEmitter } = require('node:events');
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    return child;
  };
  try {
    return fn(started);
  } finally {
    claude.spawnClaude = realSpawn;
    claude.wireClaudeRuntimeDeps(prevDeps);
  }
}

// The state a routine is in when it has been seen but never run: the tick has
// recorded where its slot is and nothing else.
function anchor(sched, due) {
  sched.routineSlots.observedAt = null;
  sched.routineSlots.routines[KEY] = { due: due.toISOString(), schedule: 'daily:7:0', missed: [] };
}

const NOW = new Date(2026, 7, 20, 9, 20);            // Thursday, twenty past nine
const TODAYS_SLOT = new Date(2026, 7, 20, 7, 0);
const YESTERDAYS_SLOT = new Date(2026, 7, 19, 7, 0);
const TOMORROWS_SLOT = new Date(2026, 7, 21, 7, 0);

describe('one path produces every row\'s next-run time', () => {
  // AC-5 and AC-15, and the value the card warns is constrained rather than
  // copy. A next-run time that has already passed stays on TODAY rather than
  // rolling to tomorrow, which is why a missed row can only ever pair with a
  // next run today. Two design frames wrote tomorrow here and both were wrong.
  test('a slot that has already passed today stays on today', () => {
    withWorkspace((sched) => {
      sched.wireSchedulerDeps({ now: () => NOW });
      anchor(sched, TODAYS_SLOT);
      assert.deepStrictEqual(sched.nextRunFor(KEY, SCHEDULE), TODAYS_SLOT);
    });
  });

  test('a missed row takes its next run from that same path and gets today', () => {
    withWorkspace((sched) => {
      sched.wireSchedulerDeps({ now: () => NOW });
      anchor(sched, TODAYS_SLOT);
      // Missed yesterday, machine closed. The last run was the day before.
      sched.routineSlots.routines[KEY].missed = [{ slot: YESTERDAYS_SLOT.toISOString() }];
      sched.routineState[KEY] = {
        lastRun: new Date(2026, 7, 18, 7, 0).toISOString(), status: 'completed', duration: 3,
      };
      const facts = sched.routineDisplayFacts(KEY, SCHEDULE);
      assert.strictEqual(facts.nextRun, TODAYS_SLOT.toISOString(), 'a missed row pairs with today, never tomorrow');
      assert.strictEqual(facts.missedSlot, YESTERDAYS_SLOT.toISOString());
      // The same instant the path gives on its own, not a value produced for
      // this row by a branch of its own.
      assert.strictEqual(facts.nextRun, sched.nextRunFor(KEY, SCHEDULE).toISOString());
    });
  });

  test('a slot the last run already served moves on to the next one', () => {
    withWorkspace((sched) => {
      sched.wireSchedulerDeps({ now: () => NOW });
      anchor(sched, TODAYS_SLOT);
      sched.routineState[KEY] = { lastRun: new Date(2026, 7, 20, 7, 0, 12).toISOString(), status: 'completed', duration: 3 };
      assert.deepStrictEqual(sched.nextRunFor(KEY, SCHEDULE), TOMORROWS_SLOT);
    });
  });

  test('a run that caught up late still serves the slot it was late for', () => {
    withWorkspace((sched) => {
      sched.wireSchedulerDeps({ now: () => NOW });
      anchor(sched, TODAYS_SLOT);
      sched.routineState[KEY] = { lastRun: new Date(2026, 7, 20, 9, 14).toISOString(), status: 'completed', duration: 3 };
      assert.deepStrictEqual(sched.nextRunFor(KEY, SCHEDULE), TOMORROWS_SLOT);
    });
  });

  test('a failed run has served its slot too, so the row looks forward', () => {
    withWorkspace((sched) => {
      sched.wireSchedulerDeps({ now: () => NOW });
      anchor(sched, TODAYS_SLOT);
      sched.routineState[KEY] = { lastRun: TODAYS_SLOT.toISOString(), status: 'failed', duration: 0 };
      assert.deepStrictEqual(sched.nextRunFor(KEY, SCHEDULE), TOMORROWS_SLOT);
    });
  });

  test('a weekly routine steps a week rather than a day', () => {
    withWorkspace((sched) => {
      sched.wireSchedulerDeps({ now: () => NOW });
      const thisMonday = new Date(2026, 7, 24, 8, 0);   // the coming Monday
      sched.routineSlots.routines[KEY] = { due: thisMonday.toISOString(), schedule: 'weekly:1:8:0', missed: [] };
      sched.routineState[KEY] = { lastRun: thisMonday.toISOString(), status: 'completed', duration: 3 };
      assert.deepStrictEqual(sched.nextRunFor(KEY, 'every monday at 08:00'), new Date(2026, 7, 31, 8, 0));
    });
  });

  test('a routine the slot records have never seen names no next run', () => {
    withWorkspace((sched) => {
      sched.wireSchedulerDeps({ now: () => NOW });
      assert.strictEqual(sched.nextRunFor(KEY, SCHEDULE), null);
      assert.deepStrictEqual(sched.routineDisplayFacts(KEY, SCHEDULE),
        { nextRun: null, lastStart: null, lastSlot: null, missedSlot: null });
    });
  });

  test('a schedule nothing can parse names no next run', () => {
    withWorkspace((sched) => {
      sched.wireSchedulerDeps({ now: () => NOW });
      anchor(sched, TODAYS_SLOT);
      assert.strictEqual(sched.nextRunFor(KEY, '0 7 * * *'), null);
      assert.deepStrictEqual(sched.routineDisplayFacts(KEY, '0 7 * * *'),
        { nextRun: null, lastStart: null, lastSlot: null, missedSlot: null });
    });
  });

  test('an anchor that is not a time names no next run', () => {
    withWorkspace((sched) => {
      sched.wireSchedulerDeps({ now: () => NOW });
      sched.routineSlots.routines[KEY] = { due: 'not a time', schedule: 'daily:7:0', missed: [] };
      assert.strictEqual(sched.nextRunFor(KEY, SCHEDULE), null);
    });
  });

  test('an anchor left absurdly far behind stops walking rather than counting the years', () => {
    withWorkspace((sched) => {
      sched.wireSchedulerDeps({ now: () => NOW });
      // What a restored backup or a clock set wrong produces. The walk is
      // bounded so a display value cannot cost thousands of steps.
      anchor(sched, new Date(2020, 0, 1, 7, 0));
      sched.routineState[KEY] = { lastRun: NOW.toISOString(), status: 'completed', duration: 3 };
      const next = sched.nextRunFor(KEY, SCHEDULE);
      assert.ok(next < NOW, 'the bound was reached and the walk stopped rather than running to today');
      assert.strictEqual(next.getHours(), 7, 'and it stopped on a slot, not part way through one');
    });
  });

  test('the slot the last run served is named, so a late run can be told from a punctual one', () => {
    withWorkspace((sched) => {
      sched.wireSchedulerDeps({ now: () => NOW });
      anchor(sched, TODAYS_SLOT);
      sched.routineState[KEY] = { lastRun: new Date(2026, 7, 20, 9, 14).toISOString(), status: 'completed', duration: 3 };
      assert.strictEqual(sched.routineDisplayFacts(KEY, SCHEDULE).lastSlot, TODAYS_SLOT.toISOString());
    });
  });

  test('a last run that is not a time names no slot', () => {
    withWorkspace((sched) => {
      sched.wireSchedulerDeps({ now: () => NOW });
      anchor(sched, TODAYS_SLOT);
      sched.routineState[KEY] = { lastRun: 'not a time', status: 'completed', duration: 3 };
      assert.strictEqual(sched.routineDisplayFacts(KEY, SCHEDULE).lastSlot, null);
      assert.deepStrictEqual(sched.nextRunFor(KEY, SCHEDULE), TODAYS_SLOT);
    });
  });
});

describe('when the last run began', () => {
  // `routineState.lastRun` is the moment a finished run ENDED, and `duration`
  // is how long it took. A row that measured lateness against the stamp would
  // be measuring the run's own length as much as its lateness, and an agent
  // run routinely lasts longer than the boundary the row uses.
  test('a finished run reports the moment it started, not the moment it ended', () => {
    withWorkspace((sched) => {
      sched.wireSchedulerDeps({ now: () => NOW });
      anchor(sched, TODAYS_SLOT);
      // Fired on its slot, worked for eleven minutes.
      sched.routineState[KEY] = {
        lastRun: new Date(2026, 7, 20, 7, 11, 12).toISOString(), status: 'completed', duration: 11 * 60,
      };
      assert.strictEqual(sched.lastRunStartedAt(KEY).toISOString(),
        new Date(2026, 7, 20, 7, 0, 12).toISOString());
      assert.strictEqual(sched.routineDisplayFacts(KEY, SCHEDULE).lastStart,
        new Date(2026, 7, 20, 7, 0, 12).toISOString());
    });
  });

  // Every writer that leaves the duration unset has already stamped the start:
  // a run in flight, one a dead process left behind, and a start that threw.
  //
  // The last two entries are not writers, they are FILES. routine-state.json
  // is on the user's disk, survives upgrades, and can be hand edited, so a
  // duration that is missing or is not a number is reachable without any code
  // producing it. Subtracting one of those gives an invalid date, and the row
  // would lose its whole second line rather than saying anything wrong, which
  // is the kind of failure nobody reports.
  test('a stamp with no duration is already the start', () => {
    withWorkspace((sched) => {
      sched.wireSchedulerDeps({ now: () => NOW });
      anchor(sched, TODAYS_SLOT);
      for (const state of [
        { lastRun: TODAYS_SLOT.toISOString(), status: 'running', duration: null },
        { lastRun: TODAYS_SLOT.toISOString(), status: 'interrupted', duration: null },
        { lastRun: TODAYS_SLOT.toISOString(), status: 'failed', duration: 0, error: 'spawn refused' },
        { lastRun: TODAYS_SLOT.toISOString(), status: 'completed' },
        { lastRun: TODAYS_SLOT.toISOString(), status: 'completed', duration: 'fast' },
      ]) {
        sched.routineState[KEY] = state;
        assert.strictEqual(sched.lastRunStartedAt(KEY).toISOString(), TODAYS_SLOT.toISOString(),
          `${state.status} moved the start`);
      }
    });
  });

  test('a routine that has never run has no start', () => {
    withWorkspace((sched) => {
      sched.wireSchedulerDeps({ now: () => NOW });
      assert.strictEqual(sched.lastRunStartedAt(KEY), null);
      sched.routineState[KEY] = { lastRun: 'not a time', status: 'completed', duration: 3 };
      assert.strictEqual(sched.lastRunStartedAt(KEY), null);
    });
  });

  // A run that began at 23:58 and finished after midnight served the slot on
  // the day it STARTED. Taking the slot from the end names the wrong day, and
  // the row would call a punctual run late by a whole period.
  test('the slot a run served is the one on the day it started', () => {
    withWorkspace((sched) => {
      const lateNight = new Date(2026, 7, 20, 23, 58);
      sched.wireSchedulerDeps({ now: () => new Date(2026, 7, 21, 9, 0) });
      sched.routineSlots.routines[KEY] = {
        due: new Date(2026, 7, 21, 23, 58).toISOString(), schedule: 'daily:23:58', missed: [],
      };
      sched.routineState[KEY] = {
        // Started 23:58 on the twentieth, ran nine minutes, finished on the
        // twenty first.
        lastRun: new Date(2026, 7, 21, 0, 7).toISOString(), status: 'completed', duration: 9 * 60,
      };
      const facts = sched.routineDisplayFacts(KEY, 'every day at 23:58');
      assert.strictEqual(facts.lastSlot, lateNight.toISOString(),
        'the slot was taken from the day the run ended rather than the day it began');
      assert.strictEqual(facts.lastStart, lateNight.toISOString());
    });
  });
});

describe('the two stores stay apart', () => {
  // AC-8. Everything this view adds is a READ. The value double-fire
  // suppression depends on is untouched by all of it, and so is the slot
  // store: a display that wrote back into either would be the defect this
  // whole card was warned about.
  test('nothing this view adds writes to either store', () => {
    // The SHARED instance, not a private copy, because the assertion below
    // travels through discoverAgents, and discovery requires the shared module
    // at use time. A private copy would leave the roster reading a different
    // pair of stores from the ones this test wrote to, which would pass while
    // proving nothing. The wiring is put back afterwards.
    withSharedScheduler((sched) => {
      anchor(sched, TODAYS_SLOT);
      sched.routineSlots.routines[KEY].missed = [{ slot: YESTERDAYS_SLOT.toISOString() }];
      sched.routineState[KEY] = {
        lastRun: new Date(2026, 7, 18, 7, 0).toISOString(), status: 'completed', duration: 3,
      };
      const stateBefore = JSON.stringify(sched.routineState);
      const slotsBefore = JSON.stringify(sched.routineSlots);

      sched.nextRunFor(KEY, SCHEDULE);
      sched.routineDisplayFacts(KEY, SCHEDULE);
      // And through the surface the client actually receives it on.
      const agents = discoverAgents();
      const routine = agents.find(a => a.id === 'piper').routines[0];
      assert.strictEqual(routine.nextRun, TODAYS_SLOT.toISOString(), 'the roster carries the value');

      assert.strictEqual(JSON.stringify(sched.routineState), stateBefore,
        'the value double-fire suppression reads has been written to');
      assert.strictEqual(JSON.stringify(sched.routineSlots), slotsBefore,
        'the slot records have been written to, and this view only ever reads them');
    });
  });


  // AC-9. The separation, proven by a test rather than asserted in a comment.
  //
  // THE MUTATION THIS EXISTS TO CATCH, in its exact form: in the tick, change
  //   getNextRun(routine.schedule, routineState[key]?.lastRun)
  // to
  //   getNextRun(routine.schedule, routineSlots.routines[key]?.due)
  // The types match, it reads as a tidy simplification, and it turns this test
  // red because the slot store's `due` is today's slot, which the daily
  // suppression then reads as "already ran today" and the catch-up run this
  // routine is still owed never happens.
  test('a slot already gone today is still caught up when nothing has run', () => {
    // The fake spawn is installed BEFORE the scheduler is loaded: the module
    // destructures spawnClaude at load, so a copy made first holds the real
    // one and this test would reach whatever binary happens to be on the
    // machine.
    withFakeSpawn((started) => {
      withWorkspace((sched) => {
        sched.wireSchedulerDeps({ now: () => NOW, getWssClients: () => [] });
        // Nothing has run. The machine was closed at 7:00am and opened at
        // twenty past nine, which is the ordinary case for a laptop.
        assert.deepStrictEqual(sched.routineState, {});

        const timer = { fn: null };
        const realSetInterval = global.setInterval;
        global.setInterval = (fn) => { timer.fn = fn; return { unref() {} }; };
        try {
          sched.startScheduler();
        } finally {
          global.setInterval = realSetInterval;
        }
        timer.fn();
        sched.stopScheduler();

        assert.strictEqual(started.length, 1,
          'the slot that went by while the machine was closed was not caught up');
        assert.strictEqual(sched.routineState[KEY].status, 'running');
        // And the anchor the tick left behind is today's slot, which is what
        // the row renders and what must never be fed back in above.
        assert.strictEqual(sched.routineSlots.routines[KEY].due, TODAYS_SLOT.toISOString());
      });
    });
  });
});
