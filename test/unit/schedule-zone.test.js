'use strict';
// Whose clock a schedule follows, and which zone the window is told.
//
// THE SERVER AND THE WINDOW CAN BE IN DIFFERENT ZONES. A Rundock on a server
// reached through a tunnel puts the window on the person's own computer and
// the scheduler somewhere else. The scheduler sets a slot's hour on its own
// process's clock, so a schedule is read in the server's zone, and the window
// has to be told which zone that is rather than name its own.
//
// THE ZONE IS SET HERE, AND CHANGED HERE, ON PURPOSE. This process starts in
// UTC, and UTC plays the window. Each roster is built with process.env.TZ set
// to the zone the server is in for that test, which Node follows at once
// inside one process, and the zone goes back to UTC before the window draws
// anything. Nothing here reads the zone of the machine it runs on.
process.env.TZ = 'UTC';

const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf-8');
const { agentFile, makeWorkspace, cleanup } = require('../helpers/workspace.js');
const { invalidateAgentCache, rosterMessage } = require('../../lib/agents/discovery.js');
const sched = require('../../lib/scheduler.js');
const config = require('../../lib/config.js');

after(cleanup);

const WINDOW_ZONE = 'UTC';
// Wednesday 7 October 2026, 05:00 UTC: 06:00 in London and 01:00 in New York,
// so the routine's hour is still ahead in every zone used here and its next
// run is today's slot.
const NOW = new Date(Date.UTC(2026, 9, 7, 5, 0));
const SCHEDULE = 'every day at 08:00';
const SKILL_KEY = 'morning-briefing:piper';

/** Run `fn` as the server does, in `zone`, then come back to the window's. */
function asServer(zone, fn) {
  process.env.TZ = zone;
  try { return fn(); } finally { process.env.TZ = WINDOW_ZONE; }
}

/** The hour and minute an instant reads as in a named zone. */
function clockIn(instant, zone) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(instant);
}

function workspace() {
  return makeWorkspace({
    agents: {
      piper: agentFile({
        name: 'piper', displayName: 'Piper', type: 'specialist', order: 1,
        routines: [{ name: 'Morning briefing', schedule: SCHEDULE, prompt: 'Run the morning-briefing skill.', enabled: true }],
      }),
    },
  });
}

/**
 * Hold the scheduler on one workspace and one instant for the length of `fn`,
 * with its stores read from that workspace, and put everything back after.
 */
function onWorkspace(dir, fn) {
  const previousWorkspace = config.getWorkspace();
  config.setWorkspace(dir);
  sched.loadRoutineState();
  invalidateAgentCache();
  const previousDeps = sched.wireSchedulerDeps({ now: () => NOW, getWssClients: () => [] });
  try {
    return fn();
  } finally {
    sched.wireSchedulerDeps(previousDeps);
    config.setWorkspace(previousWorkspace);
    invalidateAgentCache();
  }
}

/**
 * The roster a server in `zone` sends: built by the one builder every roster
 * goes through, and turned into JSON and back the way the socket carries it.
 */
function rosterFrom(zone, dir) {
  return asServer(zone, () => onWorkspace(dir, () => JSON.parse(JSON.stringify(rosterMessage()))));
}

/** Run `fn` with this process's Intl answering `options` for the default zone. */
function withIntlAnswering(options, fn) {
  const real = Intl.DateTimeFormat;
  Intl.DateTimeFormat = function () { return { resolvedOptions: () => options }; };
  try { return fn(); } finally { Intl.DateTimeFormat = real; }
}

const EDITOR_MODEL_SRC = read('public', 'routine-editor-model.js');
const EDITOR_VIEW_SRC = read('public', 'views', 'routine-editor.js');
const SKILLS_MODEL_SRC = read('public', 'skills-model.js');
const MODEL_SRC = read('public', 'routines-model.js');
const VIEW_SRC = read('public', 'views', 'routines.js');
const APP_SRC = read('public', 'app.js');

// The client's roster case, cut out of app.js and RUN, so what the window
// knows about the server's zone is what that case records and nothing a test
// planted.
const ROSTER_CASE = (() => {
  const found = APP_SRC.match(/case 'agents': ([\s\S]*?) break;/);
  assert.ok(found && found[1].trim(), 'app.js no longer carries the roster case of the client dispatch');
  return found[1];
})();

/**
 * A window in this process's zone, which is UTC, with the routines list and
 * the routine editor loaded the way index.html loads them.
 */
function windowShell() {
  const dom = new JSDOM('<!doctype html><html><body>'
    + '<nav class="nav-rail"><button class="nav-item" data-nav="routines"></button></nav>'
    + '<div id="view-routines"><div id="routines-content"></div></div>'
    + '<div id="view-routine-editor"><div id="routine-editor-content"></div></div>'
    + '</body></html>', { runScripts: 'dangerously' });
  const w = dom.window;
  for (const src of [EDITOR_MODEL_SRC, SKILLS_MODEL_SRC, MODEL_SRC, VIEW_SRC, EDITOR_VIEW_SRC]) w.eval(src);
  w.esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  w.sent = [];
  w.ws = { send: (m) => w.sent.push(JSON.parse(m)) };
  w.showView = () => {};
  w.setNavState = () => {};
  w.switchNav = () => {};
  w.showProfile = () => {};
  w.routinesNow = () => NOW;
  w.skills = [{ id: 'morning-briefing', slug: 'morning-briefing', name: 'Morning briefing',
    assignedAgents: [{ id: 'piper', name: 'Piper' }] }];
  w.skillsLoaded = true;
  // Everything else the roster case draws, which this file does not own.
  for (const stub of ['renderAgentList', 'renderOrgChart', 'renderRoutinesPanel', 'renderConvoList',
    'runDetailRosterUpdated', 'setRosterWorkspace']) {
    w[stub] = () => {};
  }
  // The window really is in UTC: its own Intl says so, unstubbed.
  assert.strictEqual(w.eval('Intl.DateTimeFormat().resolvedOptions().timeZone'), WINDOW_ZONE,
    'sanity: the window is not in the zone this file says it is');
  return { w, doc: w.document, dom };
}

/** A roster arriving at the window, through the client's own dispatch. */
function arrive(w, message) {
  w.d = message;
  w.eval(`(function (d) {${ROSTER_CASE}\n})(window.d)`);
}

const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
const zoneCaption = (doc) => text(doc.querySelector('[data-routine-editor="workspace-caveat"]'));
const readyCaption = (doc) => text(doc.querySelector('.re-caption'));
const nextRunOnRow = (doc) => text(doc.querySelector('.routine-row .next-run'));

/** Open the editor on Piper's skill, as the agent's Add routine button does. */
function openOnSchedule(w) {
  w.addRoutineForAgent('piper');
  w.routineEditorPick(SKILL_KEY);
  w.routineEditorStep('schedule');
}

describe('the server says which zone it reads a schedule in', () => {
  test('a roster carries the zone the server process is in', () => {
    const dir = workspace();
    assert.strictEqual(rosterFrom('Europe/London', dir).zone, 'Europe/London');
    assert.strictEqual(rosterFrom('America/New_York', dir).zone, 'America/New_York');
  });

  // Read when the roster is built, never once at start: a server whose zone
  // moves under it reports the move in the next roster it sends.
  test('the zone is read each time a roster is built, not kept from the first', () => {
    const dir = workspace();
    const seen = ['Europe/London', 'America/New_York', 'Europe/London'].map(zone => rosterFrom(zone, dir).zone);
    assert.deepStrictEqual(seen, ['Europe/London', 'America/New_York', 'Europe/London']);
  });
});

describe('the editor names the server\'s zone, never the window\'s', () => {
  // The most common next step: read the caption, save a daily 08:00 routine.
  // The zone the caption names has to be the zone the slot is worked out in,
  // which is the whole of what the caption is for.
  test('with the server on London and the window on UTC, the caption names London and the slot is 08:00 London', () => {
    const dir = workspace();
    const message = rosterFrom('Europe/London', dir);
    const { w, doc, dom } = windowShell();
    arrive(w, message);
    openOnSchedule(w);
    w.routineEditorSetField('time', '08:00');

    const caption = zoneCaption(doc);
    assert.ok(caption.startsWith(
      'Piper reads this on the clock of the computer Rundock runs on, London time, never the Agent Computer\'s.'),
    `the caption does not say whose clock it is: ${caption}`);
    assert.doesNotMatch(caption, /UTC|your local time/i, 'the window\'s zone was presented as the schedule\'s');

    w.routineEditorStep('ready');
    assert.ok(readyCaption(doc).startsWith('London time. '), `the ready caption: ${readyCaption(doc)}`);
    assert.doesNotMatch(readyCaption(doc), /UTC/);

    doc.querySelector('[data-routine-editor="save"]').click();
    const saved = w.sent.find(m => m.type === 'save_routine');
    assert.ok(saved, 'the save was not sent');
    assert.strictEqual(saved.routine.schedule, SCHEDULE);

    // The slot the tick fires at, worked out by the server in its own zone.
    const slot = asServer('Europe/London', () => onWorkspace(dir, () => sched.getNextRun(saved.routine.schedule, null)));
    assert.strictEqual(slot.toISOString(), '2026-10-07T07:00:00.000Z');
    // The place the caption named is the zone the server reported, and the
    // slot reads 08:00 in exactly that zone.
    assert.ok(caption.includes(`${w.RundockRoutineEditorModel.timezoneWords(message.zone)} time`));
    assert.strictEqual(clockIn(slot, message.zone), '08:00');
    assert.notStrictEqual(clockIn(slot, WINDOW_ZONE), '08:00',
      'sanity: in the window\'s zone the same slot is another hour, which is what naming it would have hidden');
    dom.window.close();
  });

  // The retry: an editor opened again after the server's zone moved names the
  // zone it reports now, not the one from the first opening.
  test('opened, closed, and opened again after the zone changed, the editor names the new zone', () => {
    const dir = workspace();
    const { w, doc, dom } = windowShell();
    arrive(w, rosterFrom('Europe/London', dir));
    openOnSchedule(w);
    assert.match(zoneCaption(doc), /runs on, London time, never/);
    w.routineEditorLeave();

    arrive(w, rosterFrom('America/New_York', dir));
    openOnSchedule(w);
    assert.match(zoneCaption(doc), /runs on, New York time, never/);
    assert.doesNotMatch(zoneCaption(doc), /London/);
    dom.window.close();
  });
});

describe('the zone goes from one to another and back', () => {
  // The inverse action. The caption and the row both follow the server's zone
  // there and back, and the row's next run is the hour its own sentence says.
  test('London, New York, London: the caption and the row follow it both ways', () => {
    const dir = workspace();
    const { w, doc, dom } = windowShell();
    const seen = [];
    for (const zone of ['Europe/London', 'America/New_York', 'Europe/London']) {
      arrive(w, rosterFrom(zone, dir));
      openOnSchedule(w);
      seen.push({ caption: (zoneCaption(doc).match(/runs on, (.+?) time, never/) || [])[1], next: null });
      w.routineEditorLeave();
      w.renderRoutines();
      seen[seen.length - 1].next = nextRunOnRow(doc);
      assert.match(text(doc.querySelector('.routine-row .rr-sentence')), /^Every day at 8:00am, run: Morning briefing/);
    }
    assert.deepStrictEqual(seen, [
      { caption: 'London', next: 'Next run: today, 8:00am, London time' },
      { caption: 'New York', next: 'Next run: today, 8:00am, New York time' },
      { caption: 'London', next: 'Next run: today, 8:00am, London time' },
    ]);
    dom.window.close();
  });
});

describe('a server that reports no zone', () => {
  // The path failing: the runtime gives no zone. The server says nothing
  // rather than guess, and ICU's own word for not knowing counts as nothing.
  test('a runtime with no zone, or one that does not know it, reports none', () => {
    const dir = workspace();
    assert.strictEqual(withIntlAnswering({}, () => rosterFrom('Europe/London', dir)).zone, null);
    assert.strictEqual(withIntlAnswering({ timeZone: 'Etc/Unknown' }, () => rosterFrom('Europe/London', dir)).zone, null);
  });

  // The path failing harder: asking Intl at all throws. The roster still goes
  // out whole, reporting no zone, because a roster that failed to build over
  // a fact it carries only for showing would take the team list down with it.
  test('a runtime whose Intl throws reports no zone, and the roster still builds', () => {
    const dir = workspace();
    const real = Intl.DateTimeFormat;
    let roster = null;
    Intl.DateTimeFormat = function () { throw new RangeError('no time zone data'); };
    try {
      assert.doesNotThrow(() => { roster = rosterFrom('Europe/London', dir); }, 'the throw escaped the roster builder');
    } finally {
      Intl.DateTimeFormat = real;
    }
    assert.strictEqual(Intl.DateTimeFormat, real, 'sanity: Intl is back as it was');
    assert.strictEqual(roster.zone, null);
    assert.strictEqual(roster.workspace, dir, 'and the rest of the roster is there');
    assert.deepStrictEqual(roster.agents.find(a => a.id === 'piper').routines.map(r => r.name), ['Morning briefing']);
  });

  // An older server sends no field at all. The caption still says whose clock
  // it is, names no place, and never falls back to the window's zone.
  test('a roster with no zone leaves the captions naming no place, and never the window\'s', () => {
    const dir = workspace();
    const message = rosterFrom('Europe/London', dir);
    delete message.zone;
    const { w, doc, dom } = windowShell();
    arrive(w, message);
    openOnSchedule(w);
    assert.ok(zoneCaption(doc).startsWith(
      'Piper reads this on the clock of the computer Rundock runs on, never the Agent Computer\'s.'),
    `the caption: ${zoneCaption(doc)}`);
    assert.doesNotMatch(zoneCaption(doc), /UTC| time,/);
    w.routineEditorStep('ready');
    assert.ok(readyCaption(doc).startsWith('Runs on each computer that has this workspace open, while Rundock is open there.'), `the ready caption: ${readyCaption(doc)}`);
    assert.doesNotMatch(readyCaption(doc), /UTC/);
    dom.window.close();
  });
});

describe('the reported zone is for showing, and is stored nowhere', () => {
  // The scheduler's two stores are what the tick decides with. A zone written
  // into either is a second input beside the last run, which is the defect the
  // stores are kept apart to prevent. So the same pass is run twice, once with
  // the server reporting its zone and once with it reporting none, and both
  // files must come out byte for byte the same.
  test('a pass with and without the field leaves both scheduler files byte-identical', (t) => {
    function pass(reports) {
      const dir = workspace();
      const run = () => asServer('Europe/London', () => onWorkspace(dir, () => {
        t.mock.timers.enable({ apis: ['setInterval'] });
        try {
          sched.startScheduler();
          t.mock.timers.tick(60_000);
        } finally {
          sched.stopScheduler();
          t.mock.timers.reset();
        }
        const zone = rosterMessage().zone;
        sched.saveRoutineState();
        sched.saveRoutineSlots();
        return {
          zone,
          state: fs.readFileSync(path.join(dir, '.rundock', 'routine-state.json')),
          slots: fs.readFileSync(path.join(dir, '.rundock', 'routine-slots.json')),
        };
      }));
      return reports ? run() : withIntlAnswering({}, run);
    }
    const withField = pass(true);
    const without = pass(false);
    assert.strictEqual(withField.zone, 'Europe/London', 'sanity: the first pass reported a zone');
    assert.strictEqual(without.zone, null, 'sanity: the second reported none');
    assert.ok(withField.slots.includes('Morning briefing'), 'sanity: the tick wrote the routine\'s slot');
    assert.ok(withField.state.equals(without.state), 'routine-state.json differs with the zone reported');
    assert.ok(withField.slots.equals(without.slots), 'routine-slots.json differs with the zone reported');
    for (const file of [withField.state, withField.slots]) {
      assert.ok(!file.includes('London'), 'the reported zone reached a scheduler file');
    }
  });
});
