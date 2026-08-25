'use strict';
// The agent profile: Skills, then Routines, then Configuration.
//
// WHAT THIS FILE IS ACTUALLY GUARDING.
//
// The profile used to interpolate a run's raw status word straight into the
// markup and print things like "Last run: 4h ago (interrupted)". The three-tone
// ruling took three design rounds and two rejections to settle, and it never
// reached this surface, so the one place a person met a routine while looking
// at an agent was the one place the vocabulary was raw. It also printed
// statuses the ruling has no tone for at all.
//
// THE DEFECT IS DELETED RATHER THAN FIXED. The Routines box carries a name and
// a schedule and nothing else, so there is no outcome on this page to get
// wrong, and outcomes live on the routines view where the model already
// decides both the words and the tone. That is cheaper than teaching a second
// surface the ruling, and it is only cheaper while it stays true, which is what
// the status walk below is for: EVERY status a run record can carry is driven
// through this page, and the list is read out of the scheduler rather than
// written here, so a fifth status arrives as a failure rather than as a
// screenshot somebody notices later.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { statusesTheSchedulerRecords } = require('../helpers/scheduler-statuses.js');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf-8');
const APP_SRC = read('public', 'app.js');
const PROFILE_SRC = read('public', 'views', 'profile.js');
const EDITOR_MODEL_SRC = read('public', 'routine-editor-model.js');
const SKILLS_MODEL_SRC = read('public', 'skills-model.js');
const ROUTINES_MODEL_SRC = read('public', 'routines-model.js');
const ROUTINES_SRC = read('public', 'views', 'routines.js');

// The three boxes, in the order the conformance mock draws them.
const BOXES = ['Skills', 'Routines', 'Configuration'];

/**
 * Every status a run record can carry, READ OUT OF THE SCHEDULER.
 *
 * Written here as a list, this test would say what its author remembered on
 * the day. `interrupted` is the exact case that makes the point: it arrived
 * with the restarted-run card, months after the surface that printed it was
 * written, and nothing asked the profile about it. So the list is derived from
 * the two places that write a status into the run state, and a sixth one
 * appearing anywhere else in that file is a gap this cannot see and the
 * sanity check below is what bounds it.
 */

const ROUTINES = [
  { name: 'Compile the ops summary', schedule: 'every day at 07:00', state: null },
  { name: 'Draft the stand-up notes', schedule: 'every monday at 08:30', state: null },
];

function shellMarkup() {
  return '<!doctype html><html><body>'
    + '<button class="nav-item" data-nav="team"></button>'
    + '<button class="nav-item" data-nav="routines"></button>'
    + '<div id="view-profile"><div id="profile-content"></div></div>'
    + '<div id="view-routines"><div id="routines-content"></div></div>'
    + '</body></html>';
}

function appPiece(pattern, label) {
  const m = APP_SRC.match(pattern);
  assert.ok(m && m[1] && m[1].trim(), `app.js no longer carries ${label}`);
  return m[1];
}

function shell({ routines = ROUTINES, tedRoutines = [] } = {}) {
  const dom = new JSDOM(shellMarkup(), { runScripts: 'dangerously' });
  const w = dom.window;
  w.eval(EDITOR_MODEL_SRC);
  w.eval(SKILLS_MODEL_SRC);
  w.eval(ROUTINES_MODEL_SRC);
  w.eval(ROUTINES_SRC);
  w.eval(PROFILE_SRC);
  w.agents = [
    {
      id: 'piper', displayName: 'Piper', role: 'Ops', colour: '#E87A5A', icon: 'P',
      status: 'onTeam', runtime: 'claude', model: 'sonnet', routines,
    },
    {
      id: 'ted', displayName: 'Ted', role: 'Inventory', colour: '#6BC67E', icon: 'T',
      status: 'onTeam', runtime: 'claude', model: 'haiku', routines: tedRoutines,
    },
  ];
  w.conversations = [];
  w.skills = [
    { id: 'ops', name: 'Compile the ops summary', description: 'The morning numbers', assignedAgents: [{ id: 'piper' }] },
    { id: 'inv', name: 'Update the shared inventory sheet', description: 'Stock counts', assignedAgents: [{ id: 'ted' }] },
  ];
  w.esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  w.formatTimeAgo = () => 'a while ago';
  w.getGuide = () => ({ id: 'doc', displayName: 'Wren' });
  w.ws = { send: () => {} };
  w.routinesNow = () => new Date(2026, 7, 24, 9, 20);
  w.Intl = { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: 'Europe/London' }) }) };
  w.setNavState = () => {};
  w.showView = (v) => { w.shown = v; };
  w.closeFindBar = () => {};
  w.startConversation = () => {};
  w.addToTeam = () => {};
  w.openConversation = () => {};
  w.selectSkill = () => {};
  w.addRoutineForAgent = () => {};
  // The rail's own routines arm, cut out of app.js and run, so the route a row
  // takes is the route the page ships rather than one restated here.
  w.switchNav = (nav) => {
    w.navigatedTo = nav;
    if (nav !== 'routines') return;
    w.eval(`(function () {${appPiece(/else if\(nav==='routines'\)\s*\{([\s\S]*?)\}/, "switchNav's routines arm")}\n})()`);
  };
  return { w, doc: w.document, dom };
}

function profileText(doc) {
  return doc.getElementById('profile-content').textContent.replace(/\s+/g, ' ').trim();
}

function boxLabels(doc) {
  return [...doc.querySelectorAll('.profile-card .profile-section-label')].map(el => el.textContent.trim());
}

function routinesBox(doc) {
  const label = [...doc.querySelectorAll('.profile-card .profile-section-label')]
    .filter(el => el.textContent.trim() === 'Routines')[0];
  assert.ok(label, 'the profile carries no Routines box');
  return label.closest('.profile-card');
}

describe('the profile is three boxes', () => {
  test('the boxes are Skills, then Routines, then Configuration', () => {
    const { w, doc, dom } = shell();
    w.showProfile('piper');
    assert.deepStrictEqual(boxLabels(doc), BOXES,
      'the profile no longer reads Skills, Routines, Configuration in that order');
    dom.window.close();
  });

  // AC-B6. A box that vanished once you used it would take the concept with
  // it, and an agent's own schedules are what a reader came to this page for.
  test('the Routines box is on the page whether or not the agent has any', () => {
    for (const [who, routines] of [['piper', ROUTINES], ['ted', []]]) {
      const { w, doc, dom } = shell({ routines, tedRoutines: routines });
      w.showProfile(who);
      assert.ok(routinesBox(doc), `${who} has no Routines box`);
      assert.deepStrictEqual(boxLabels(doc), BOXES, `${who}'s profile is not three boxes`);
      dom.window.close();
    }
  });

  // AC-B2. Not "no status word today": the row's whole text, so anything added
  // to it later fails here rather than passing because nobody asserted it.
  test('a routine row is its name and its schedule and nothing else', () => {
    const { w, doc, dom } = shell();
    w.showProfile('piper');
    const model = w.RundockRoutinesModel;
    const rows = [...routinesBox(doc).querySelectorAll('.profile-card-item')];
    assert.strictEqual(rows.length, ROUTINES.length, 'the box does not list this agent\'s routines');
    rows.forEach((row, i) => {
      const routine = ROUTINES[i];
      const schedule = model.scheduleWords(routine.schedule);
      assert.ok(schedule, 'sanity: the model has words for this schedule');
      assert.strictEqual(row.textContent.replace(/\s+/g, ' ').trim(), `${routine.name} ${schedule}`,
        'a routine row on the profile carries something beyond a name and a schedule');
    });
    dom.window.close();
  });

  // AC-B7, and the defect this card deletes.
  //
  // Every status, driven, on both row shapes: a run that ended and a run still
  // going. The assertion is on the WHOLE page rather than on the row, because
  // the word reaching any part of this profile is the fault.
  test('no status a run record can carry reaches the page', () => {
    const statuses = statusesTheSchedulerRecords();
    // NAMED IN BOTH DIRECTIONS. The walk reads the statuses out of the source,
    // and these read the statuses back at it, so neither a word dropped from
    // the file nor a walk that stops seeing one can pass unnoticed. The two
    // named here are the ones nothing else in the product renders, which makes
    // them the likeliest to be leaked raw by a surface that never met them.
    assert.ok(statuses.includes('interrupted'),
      'sanity: the status a run the process died inside carries is not in the list this walk drives');
    assert.ok(statuses.includes('cancelled'),
      'sanity: the status a run somebody stopped carries is not in the list this walk drives');
    assert.ok(statuses.includes('completed'),
      'sanity: the ordinary outcome is not in the list, so the walk has stopped reading the writer');
    assert.ok(statuses.length >= 5,
      `sanity: only ${statuses.length} statuses were found, so this walk is reading the wrong thing`);

    for (const status of statuses) {
      const routines = ROUTINES.map(r => ({
        ...r, state: { status, lastRun: new Date(2026, 7, 24, 5, 0).toISOString() },
      }));
      const { w, doc, dom } = shell({ routines });
      w.showProfile('piper');
      const shown = profileText(doc);
      assert.ok(!shown.includes(status),
        `the profile prints the raw status word "${status}"`);
      // And no outcome in the routines view's own vocabulary either: the
      // outcome is not restated in better words here, it is not on this page.
      for (const word of ['Ran ', 'Failed', 'Missed', 'Caught up', 'Last run', 'Running now', 'Not yet run']) {
        assert.ok(!shown.includes(word),
          `the profile reports an outcome ("${word}"), which belongs to the routines view`);
      }
      dom.window.close();
    }
  });

  // AC-B4. Pause and delete live in one place, so a reader learns one place to
  // change a routine rather than two that might disagree.
  test('pause and delete appear nowhere on the profile', () => {
    const { w, doc, dom } = shell();
    w.showProfile('piper');
    const card = doc.getElementById('profile-content');
    assert.strictEqual(card.querySelector('[data-routines-action]'), null,
      'a routines control is rendered on the profile');
    assert.ok(!/Pause|Delete|Resume/i.test(profileText(doc)),
      'the profile offers to pause or delete a routine');
    assert.ok(!/routinesSetPaused|routinesAskDelete/.test(PROFILE_SRC),
      'views/profile.js names a pause or delete handler');
    dom.window.close();
  });

  // THE FALLBACK, DRIVEN RATHER THAN PROMISED IN A COMMENT. The model has
  // plain words only for the schedules the editor offers, and returns nothing
  // for anything else. A routine written by hand, or by a future editor this
  // one has not caught up with, carries such a schedule, and the row shows the
  // stored string rather than an empty line. Every other fixture here resolves
  // to model words, so without this the branch is unreachable from any test.
  test('a schedule the model has no words for is shown as it was stored', () => {
    const stored = 'every fortnight at 07:00';
    const { w, doc, dom } = shell({ routines: [{ name: 'Reconcile the ledger', schedule: stored, state: null }] });
    assert.strictEqual(w.RundockRoutinesModel.scheduleWords(stored), null,
      'sanity: the model does have words for this schedule, so the fallback is not what is being driven');
    w.showProfile('piper');
    const rows = [...routinesBox(doc).querySelectorAll('.profile-card-item')];
    assert.strictEqual(rows.length, 1, 'the row did not render at all');
    assert.strictEqual(rows[0].textContent.replace(/\s+/g, ' ').trim(), `Reconcile the ledger ${stored}`,
      'a routine whose schedule the model cannot translate shows nothing, or shows something else');
    dom.window.close();
  });
});

describe('Add routine teaches that routines exist, and then stops', () => {
  // AC-B5. The button is feature discovery rather than repeat use: it exists
  // to say the concept is there, in the one place where an agent with no
  // schedule is being looked at.
  test('Add routine is offered while the agent has none', () => {
    const { w, doc, dom } = shell({ routines: [] });
    w.showProfile('piper');
    const button = doc.querySelector('[data-profile-action="add-routine"]');
    assert.ok(button, 'an agent with no routines is not offered a way to make one');
    assert.ok(routinesBox(doc).contains(button), 'the offer is not inside the Routines box');
    assert.strictEqual(button.className, 'settings-btn-primary',
      'the offer is not the small in-card primary the mock draws');
    dom.window.close();
  });

  test('Add routine is gone once the agent has one', () => {
    const { w, doc, dom } = shell({ routines: [ROUTINES[0]] });
    w.showProfile('piper');
    assert.strictEqual(doc.querySelector('[data-profile-action="add-routine"]'), null,
      'the profile still offers Add routine to an agent that already has one');
    dom.window.close();
  });
});

// THE ROW'S DESTINATION IS NOT PRESSED HERE, and that is deliberate rather
// than a gap. Where a row lands the reader is a ROUTE, and every route into the
// routines section is enumerated and pressed in routines-view-doors.test.js,
// against the source, so a route added later fails there until somebody lists
// it. Pressing it here as well would be a second proof of one thing in the file
// that does not own it, and the one that does not own it is the one that goes
// stale. What this file owns is the row: that it exists, and what it says.
describe('a routine row carries the destination the routes file presses', () => {
  test('a row is a control that opens the routines view for this agent', () => {
    const { w, doc, dom } = shell();
    w.showProfile('piper');
    const row = routinesBox(doc).querySelector('.profile-card-item');
    assert.match(row.getAttribute('onclick') || '', /^showRoutinesForAgent\('piper'\)$/,
      'a routine row on the profile does not open the routines view for this agent');
    dom.window.close();
  });
});
