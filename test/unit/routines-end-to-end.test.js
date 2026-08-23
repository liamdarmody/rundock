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
        routines: names.map(name => ({ name, schedule: SCHEDULE, prompt: 'p' })),
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

describe('the roster carries what the row renders', () => {
  test('the four rows the locked frame draws come out of a real workspace', () => {
    roster((agents) => {
      const { doc, dom } = render(agents);
      const rows = [...doc.querySelectorAll('.routine-row')];
      assert.strictEqual(rows.length, 4);
      assert.deepStrictEqual(rows.map(r => text(r.querySelector('.run-status'))), [
        'Ran today, 7:00am, London time',
        'Caught up: ran today, 9:14am, London time, due 7:00am',
        'Missed: Rundock was closed at 7:00am yesterday, London time',
        'Failed: today, 7:00am, London time',
      ]);
      assert.deepStrictEqual(rows.map(r => r.querySelector('.run-status').className), [
        'run-status ok', 'run-status ok-quiet', 'run-status neutral', 'run-status failed',
      ]);
      assert.deepStrictEqual(rows.map(r => text(r.querySelector('.next-run'))), [
        'Next run: tomorrow, 7:00am, London time',
        'Next run: tomorrow, 7:00am, London time',
        'Next run: today, 7:00am, London time',
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
      const first = doc.querySelectorAll('.routine-row')[0];
      assert.strictEqual(text(first.querySelector('.run-status')), 'Ran today, 7:00am, London time',
        'the row is reading a completion time, so a long run reads as a late one');
      dom.window.close();
    });
  });

  test('a run that started late reads as caught up, end to end', () => {
    roster((agents) => {
      const { doc, dom } = render(agents);
      const second = doc.querySelectorAll('.routine-row')[1];
      assert.match(text(second.querySelector('.run-status')), /^Caught up: ran today, 9:14am/);
      dom.window.close();
    });
  });

  test('a slot that passed while the machine was closed reads as missed, end to end', () => {
    roster((agents) => {
      const { doc, dom } = render(agents);
      const third = doc.querySelectorAll('.routine-row')[2];
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
