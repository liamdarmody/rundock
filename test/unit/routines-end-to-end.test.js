'use strict';
// The roster the client actually receives, rendered by the view that actually
// renders it.
//
// WHY THIS FILE EXISTS. Every other test of this list builds its routine
// objects by hand, with nextRun, lastStart, lastSlot and missedSlot already on
// them. That proves the view reads those fields. It says nothing about whether
// anything PUTS them there, so the lines in lib/agents/discovery.js that
// attach them could be deleted and Missed and Caught up would become
// unreachable in the real product with the whole suite green.
//
// That is the door class again, in the data flow rather than in the wiring,
// and the answer is the one that ended it there: a thing is tested by the
// surface it actually reaches a user through. The surface here is the roster
// discoverAgents builds, so this walks the whole way: a real workspace, real
// agent files, the scheduler's two real stores, discoverAgents, and then the
// real view with the real stylesheet.
//
// Every instant is built from local components and read back through local
// getters, and the zone is set before the first require, so nothing here
// describes the machine it runs on.
process.env.TZ = 'Europe/London';

const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf-8');
const { agentFile, makeWorkspace, cleanup } = require('../helpers/workspace.js');
const { invalidateAgentCache, discoverAgents } = require('../../lib/agents/discovery.js');
const sched = require('../../lib/scheduler.js');
const config = require('../../lib/config.js');

after(cleanup);

// Thursday 20 August 2026, twenty past nine. One agent, four routines, all on
// the same schedule, so the only thing separating the rows is what happened.
const NOW = new Date(2026, 7, 20, 9, 20);
const TODAYS_SLOT = new Date(2026, 7, 20, 7, 0);
const YESTERDAYS_SLOT = new Date(2026, 7, 19, 7, 0);
const TOMORROWS_SLOT = new Date(2026, 7, 21, 7, 0);
const SCHEDULE = 'every day at 07:00';
const iso = (d) => d.toISOString();

const NAMES = ['Ran on time', 'Caught up', 'Missed', 'Failed'];

// What the scheduler's two stores hold in each of the four cases. Written as
// the scheduler itself writes them: `lastRun` is the moment a finished run
// ENDED and `duration` is its length in whole seconds, which is why the row
// cannot read lateness off `lastRun` directly.
function seedStores() {
  const state = {
    // Fired on its slot and then worked for eleven minutes, which is an
    // ordinary length for an agent run. Punctual.
    'piper:Ran on time': { lastRun: iso(new Date(2026, 7, 20, 7, 11, 12)), status: 'completed', duration: 11 * 60 },
    // The machine was shut at 7:00 and opened at 9:14, so this one started
    // late and took two minutes.
    'piper:Caught up': { lastRun: iso(new Date(2026, 7, 20, 9, 16)), status: 'completed', duration: 120 },
    // Last ran two days ago; yesterday's slot went by with nobody watching.
    'piper:Missed': { lastRun: iso(new Date(2026, 7, 18, 7, 0, 30)), status: 'completed', duration: 30 },
    'piper:Failed': { lastRun: iso(new Date(2026, 7, 20, 7, 0, 5)), status: 'failed', duration: 5 },
  };
  const slots = {
    'piper:Ran on time': { due: iso(TODAYS_SLOT), schedule: 'daily:7:0', missed: [] },
    'piper:Caught up': { due: iso(TODAYS_SLOT), schedule: 'daily:7:0', missed: [] },
    'piper:Missed': { due: iso(TODAYS_SLOT), schedule: 'daily:7:0', missed: [{ slot: iso(YESTERDAYS_SLOT) }] },
    'piper:Failed': { due: iso(TODAYS_SLOT), schedule: 'daily:7:0', missed: [] },
  };
  for (const key of Object.keys(sched.routineState)) delete sched.routineState[key];
  Object.assign(sched.routineState, state);
  for (const key of Object.keys(sched.routineSlots.routines)) delete sched.routineSlots.routines[key];
  Object.assign(sched.routineSlots.routines, slots);
}

/** The roster a connected client would be sent, from real files and real stores. */
function roster(fn, seed = seedStores, names = NAMES) {
  const dir = makeWorkspace({
    agents: {
      piper: agentFile({
        name: 'piper', displayName: 'Piper', type: 'specialist', order: 1,
        // enabled, out loud. These four have run history, so they are routines
        // somebody turned on; a fixture leaning on the reader's default would
        // draw four rows offering to turn on routines that have already run.
        routines: names.map(name => ({ name, schedule: SCHEDULE, prompt: 'p', enabled: true })),
      }),
    },
  });
  const originalWorkspace = config.getWorkspace();
  config.setWorkspace(dir);
  invalidateAgentCache();
  const previousDeps = sched.wireSchedulerDeps({ now: () => NOW });
  const stateBefore = JSON.parse(JSON.stringify(sched.routineState));
  const slotsBefore = JSON.parse(JSON.stringify(sched.routineSlots));
  try {
    // Discovery migrates a routine's representation lazily on read, so let that
    // happen before the stores are seeded and the roster is taken.
    discoverAgents();
    invalidateAgentCache();
    seed();
    return fn(discoverAgents());
  } finally {
    config.setWorkspace(originalWorkspace);
    invalidateAgentCache();
    sched.wireSchedulerDeps(previousDeps);
    for (const key of Object.keys(sched.routineState)) delete sched.routineState[key];
    Object.assign(sched.routineState, stateBefore);
    for (const key of Object.keys(sched.routineSlots.routines)) delete sched.routineSlots.routines[key];
    Object.assign(sched.routineSlots, slotsBefore);
  }
}

const EDITOR_MODEL_SRC = read('public', 'routine-editor-model.js');
// Loaded before the routines model, which reads the shared no-guide next step
// off it, in the order index.html loads them.
const SKILLS_MODEL_SRC = read('public', 'skills-model.js');
const MODEL_SRC = read('public', 'routines-model.js');
const VIEW_SRC = read('public', 'views', 'routines.js');
const ROUTINES_CSS = read('public', 'styles', 'views', 'routines.css');

/** The client shell, handed exactly what the server sent. */
function render(agents) {
  const dom = new JSDOM('<!doctype html><html><head><style>' + ROUTINES_CSS + '</style></head><body>'
    + '<nav class="nav-rail"><button class="nav-item" data-nav="routines"></button></nav>'
    + '<div id="view-routines"><div id="routines-content"></div></div>'
    + '</body></html>', { runScripts: 'dangerously' });
  const w = dom.window;
  w.eval(EDITOR_MODEL_SRC);
  w.eval(SKILLS_MODEL_SRC);
  w.eval(MODEL_SRC);
  w.eval(VIEW_SRC);
  w.agents = agents;
  w.esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  w.ws = { send: () => {} };
  w.routinesNow = () => NOW;
  w.Intl = { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: 'Europe/London' }) }) };
  w.renderRoutines();
  return { w, doc: w.document, dom };
}

const text = (el) => el.textContent.replace(/\s+/g, ' ').trim();

// The row for a named routine, rather than the row in a given position. The
// list is ordered by next run, so a position names whichever routine that
// ordering puts there, which is not what a claim about the missed row means.
function rowNamed(doc, name) {
  const found = [...doc.querySelectorAll('.routine-row')]
    .filter(r => text(r.querySelector('.rr-sentence')).includes(name));
  assert.strictEqual(found.length, 1, `expected exactly one row for "${name}"`);
  return found[0];
}

describe('the roster carries what the row renders', () => {
  test('the four rows the locked frame draws come out of a real workspace', () => {
    roster((agents) => {
      const { doc, dom } = render(agents);
      const rows = [...doc.querySelectorAll('.routine-row')];
      assert.strictEqual(rows.length, 4);
      // In next-run order, which puts the missed row first: out of a real
      // workspace, it is the only one of the four due again today.
      assert.deepStrictEqual(rows.map(r => text(r.querySelector('.run-status'))), [
        'Missed: Rundock was closed at 7:00am yesterday, London time',
        'Ran today, 7:00am, London time',
        'Caught up: ran today, 9:14am, London time, due 7:00am',
        'Failed: today, 7:00am, London time',
      ]);
      assert.deepStrictEqual(rows.map(r => r.querySelector('.run-status').className), [
        'run-status neutral', 'run-status ok', 'run-status ok-quiet', 'run-status failed',
      ]);
      assert.deepStrictEqual(rows.map(r => text(r.querySelector('.next-run'))), [
        'Next run: today, 7:00am, London time',
        'Next run: tomorrow, 7:00am, London time',
        'Next run: tomorrow, 7:00am, London time',
        'Next run: tomorrow, 7:00am, London time',
      ]);
      dom.window.close();
    });
  });

  // Each of these is a separate field on the roster, and each has one line in
  // discovery attaching it. Naming them one at a time says which line is load
  // bearing rather than leaving one assertion to cover four.
  test('a run that took eleven minutes still reads as punctual, end to end', () => {
    roster((agents) => {
      const { doc, dom } = render(agents);
      const first = rowNamed(doc, 'Ran on time');
      assert.strictEqual(text(first.querySelector('.run-status')), 'Ran today, 7:00am, London time',
        'the row is reading a completion time, so a long run reads as a late one');
      dom.window.close();
    });
  });

  test('a run that started late reads as caught up, end to end', () => {
    roster((agents) => {
      const { doc, dom } = render(agents);
      const second = rowNamed(doc, 'Caught up');
      assert.match(text(second.querySelector('.run-status')), /^Caught up: ran today, 9:14am/);
      dom.window.close();
    });
  });

  test('a slot that passed while the machine was closed reads as missed, end to end', () => {
    roster((agents) => {
      const { doc, dom } = render(agents);
      const third = rowNamed(doc, 'Missed');
      assert.match(text(third.querySelector('.run-status')), /^Missed: Rundock was closed/);
      dom.window.close();
    });
  });

  test('the roster names every fact the row needs, and no completion time', () => {
    roster((agents) => {
      const routines = agents.find(a => a.id === 'piper').routines;
      const byName = Object.fromEntries(routines.map(r => [r.name, r]));
      assert.strictEqual(byName['Ran on time'].lastStart, iso(new Date(2026, 7, 20, 7, 0, 12)),
        'the roster carries when the run BEGAN');
      assert.strictEqual(byName['Ran on time'].lastSlot, iso(TODAYS_SLOT));
      assert.strictEqual(byName['Ran on time'].nextRun, iso(TOMORROWS_SLOT));
      assert.strictEqual(byName['Missed'].missedSlot, iso(YESTERDAYS_SLOT));
      assert.strictEqual(byName['Missed'].nextRun, iso(TODAYS_SLOT),
        'a missed row pairs with today, all the way from the slot store');
    });
  });

  // THE MOMENT A CLOSED MACHINE IS REOPENED, which is the situation the missed
  // row exists to describe and the one a stale anchor gets wrong.
  //
  // The stores here hold exactly what four days of being shut leaves behind:
  // an anchor from the last tick that was ever awake, the misses that tick had
  // recorded, and a run older than both. The client asks for the roster the
  // moment it connects, which is BEFORE the first tick sixty seconds later,
  // and the tick does not rebroadcast. So this is the roster a real user sees
  // first, and the row it draws must not name a next run that has already
  // gone by.
  function seedReopened() {
    for (const key of Object.keys(sched.routineState)) delete sched.routineState[key];
    for (const key of Object.keys(sched.routineSlots.routines)) delete sched.routineSlots.routines[key];
    sched.routineState['piper:Missed'] = {
      lastRun: iso(new Date(2026, 7, 15, 7, 0, 20)), status: 'completed', duration: 20,
    };
    sched.routineSlots.routines['piper:Missed'] = {
      due: iso(new Date(2026, 7, 16, 7, 0)),
      schedule: 'daily:7:0',
      missed: [{ slot: iso(new Date(2026, 7, 19, 7, 0)) }],
    };
  }

  test('a machine reopened after days closed shows today, not a weekday that has gone', () => {
    roster((agents) => {
      const { doc, dom } = render(agents);
      const row = doc.querySelector('.routine-row');
      assert.match(text(row.querySelector('.run-status')), /^Missed: Rundock was closed/);
      assert.strictEqual(text(row.querySelector('.next-run')), 'Next run: today, 7:00am, London time');
      // The named failure, said as itself: no day word on this row is one
      // that has already been and gone.
      const line = text(row.querySelector('.rr-run-line'));
      for (const past of ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']) {
        assert.ok(!line.includes(`Next run: ${past}`), `the next run is ${past}, which has gone`);
      }
      assert.ok(!/Next run: yesterday/.test(line));
      dom.window.close();
    }, seedReopened, ['Missed']);
  });

  // AC-8 at the far end of the same walk: taking the roster and rendering the
  // whole list writes to neither store.
  test('building and rendering the whole list writes to neither store', () => {
    roster((agents) => {
      const stateBefore = JSON.stringify(sched.routineState);
      const slotsBefore = JSON.stringify(sched.routineSlots);
      const { dom } = render(agents);
      invalidateAgentCache();
      discoverAgents();
      assert.strictEqual(JSON.stringify(sched.routineState), stateBefore,
        'the value double-fire suppression reads has been written to');
      assert.strictEqual(JSON.stringify(sched.routineSlots), slotsBefore,
        'the slot records have been written to, and this view only ever reads them');
      dom.window.close();
    });
  });
});

// ===== A SCHEDULE THE SCHEDULER CANNOT READ =====
//
// `parseSchedule` accepts two shapes and returns null for everything else, at
// which point `getNextRun` returns null and the tick skips the routine with no
// error, no warning and no log line. A cron-scheduled routine therefore sits in
// a first-class Routines view looking exactly like a routine, with nothing
// saying it will never fire. The silence moved from a log nobody reads to a
// surface everybody reads.
//
// AND MIGRATION NEVER TOUCHES A SCHEDULE, so every such entry survives an
// upgrade exactly as written. Anyone arriving from cron arrives with these.
//
// DRIVEN FROM FRONTMATTER TO RENDERED ROW, which is the only place this can be
// proven. The judgement is the scheduler's grammar, the fact travels on the
// roster, and the words are the model's, so a test at any one of those three
// would pass while the row still drew as ordinary.
describe('a schedule the scheduler cannot read', () => {
  const CRON = '0 7 * * *';

  function cronWorkspace(fn) {
    const dir = makeWorkspace({
      agents: {
        piper: agentFile({
          name: 'piper', displayName: 'Piper', type: 'specialist', order: 1,
          routines: [
            // Written by somebody moving over from cron, exactly as their
            // crontab said it.
            { name: 'Cron briefing', schedule: CRON, prompt: 'p', enabled: true },
            // The contrast, and the whole of AC-8: a routine that is simply
            // not due yet. Both are enabled, both are unpaused, neither has
            // ever run. The only difference is whether Rundock can read the
            // schedule.
            { name: 'Not due yet', schedule: SCHEDULE, prompt: 'p', enabled: true },
            // Held back by the migration and nothing else, so it makes the
            // offer. Here rather than in a hand-built row because the evidence
            // claims this row comes out of real discovery.
            { name: 'Held back', schedule: SCHEDULE, prompt: 'p' },
            // THE COMBINATION NO FIXTURE IN THIS SUITE HAD. A schedule nothing
            // can read AND no `enabled` key, which is not a corner case: it is
            // every pre-existing cron routine after an upgrade, because the
            // migration fills `enabled: false` and never touches a schedule.
            // Writing the cron row as `enabled: true` above is what let the
            // two halves of this change pass separately while contradicting
            // each other on one row.
            { name: 'Cron and held back', schedule: CRON, prompt: 'p' },
            // Paused AND never turned on. Two reasons not to run, and the row
            // may promise nothing on the strength of either.
            { name: 'Paused and held back', schedule: SCHEDULE, prompt: 'p', paused: true },
          ],
        }),
      },
    });
    const originalWorkspace = config.getWorkspace();
    config.setWorkspace(dir);
    invalidateAgentCache();
    const previousDeps = sched.wireSchedulerDeps({ now: () => NOW });
    try {
      discoverAgents();
      invalidateAgentCache();
      const { doc, dom } = render(discoverAgents());
      try {
        return fn(doc);
      } finally {
        dom.window.close();
      }
    } finally {
      config.setWorkspace(originalWorkspace);
      invalidateAgentCache();
      sched.wireSchedulerDeps(previousDeps);
    }
  }

  // AC-9. Fails if the row renders as an ordinary routine.
  test('a cron schedule reaches the row saying it will not run, and what to change', () => {
    cronWorkspace((doc) => {
      const row = rowNamed(doc, 'Cron briefing');
      const words = text(row);
      assert.match(words, /cannot read this schedule/i,
        `the cron row says nothing about its schedule: ${words}`);
      // NAMES WHAT TO CHANGE, rather than only that something is wrong. A row
      // that says "unsupported" sends the reader to the documentation; a row
      // carrying the two shapes that work sends them to the editor.
      assert.match(words, /every day at 07:00/,
        'the row does not name a schedule that would work');
      assert.match(words, /every Monday at 07:00/,
        'the row does not name the weekly shape either');
      // And it does not promise a run, because there is no run to promise.
      assert.ok(!/Next run/.test(words), `the cron row still promises a next run: ${words}`);
    });
  });

  // A CRON SCHEDULE AND NO `enabled` KEY, which is every pre-existing cron
  // routine after an upgrade: the reader fills an absent key in as false, and
  // nothing ever rewrites a schedule. Both halves of the row have something to
  // say about such a routine, and only one of them can be true.
  test('a cron routine the upgrade held back does not both refuse and promise to run', () => {
    cronWorkspace((doc) => {
      const row = rowNamed(doc, 'Cron and held back');
      const words = text(row);
      // It still says the thing that is true and actionable.
      assert.match(words, /cannot read this schedule/i,
        'the row stopped naming the fault that has to be fixed first');
      // And it does not also promise that turning it on would start it, which
      // is false while the schedule cannot be read.
      assert.ok(!/Rundock will start running it/.test(words),
        `the row promises a run it cannot make: ${words}`);
      assert.strictEqual(row.querySelector('[data-routines-action="enable"]'), null,
        'the row offers a control whose consequence it cannot state truthfully');
      assert.ok(!/Next run/.test(words));
    });
  });

  // The offer still reaches a row that is held back and nothing else, so the
  // fix above withheld it from the right rows rather than from all of them.
  test('a routine held back by nothing but the switch still carries the offer', () => {
    cronWorkspace((doc) => {
      const row = rowNamed(doc, 'Held back');
      assert.ok(row.querySelector('.rr-offer-text'), 'the offer row lost its offer');
      assert.match(text(row), /Rundock will start running it/);
      assert.ok(row.querySelector('[data-routines-action="enable"]'), 'no control to press');
      assert.strictEqual(row.querySelector('.next-run'), null,
        'a routine that will not run advertises when it will');
    });
  });

  test('a paused routine that was never turned on says Paused and offers nothing', () => {
    cronWorkspace((doc) => {
      const row = rowNamed(doc, 'Paused and held back');
      assert.strictEqual(text(row.querySelector('.next-run')), 'Paused');
      assert.strictEqual(row.querySelector('[data-routines-action="enable"]'), null,
        'turning it on would leave it paused, so the offer promises a run it cannot make');
      assert.ok(!/Rundock will start running it/.test(text(row)));
    });
  });

  // AC-8. The two rows, side by side, in the rendered output rather than in
  // the model alone.
  test('the unreadable row is distinguishable from one that is simply not due yet', () => {
    cronWorkspace((doc) => {
      const cron = rowNamed(doc, 'Cron briefing');
      const waiting = rowNamed(doc, 'Not due yet');

      // The ordinary row says when it runs next and carries no complaint.
      assert.strictEqual(text(waiting.querySelector('.next-run')),
        'Next run: today, 7:00am, London time');
      assert.strictEqual(waiting.querySelector('.schedule-problem'), null,
        'a routine that is merely waiting is drawn as one that cannot run');

      // The cron row is the other way round.
      assert.ok(cron.querySelector('.schedule-problem'),
        'the unreadable row carries no mark of its own');
      assert.strictEqual(cron.querySelector('.next-run'), null);

      // Told apart by their WORDS, not only by a class, so the difference
      // survives a stylesheet that renders both the same. Compared by what
      // each row must not say rather than by whole-text inequality: the two
      // rows carry different routine names, so their full texts can never be
      // equal and an inequality between them can never fail.
      assert.ok(!/cannot read this schedule/i.test(text(waiting)),
        'the waiting row claims its schedule cannot be read');
      assert.ok(!/Next run/.test(text(cron)),
        'the unreadable row promises a next run');
    });
  });
});
