'use strict';
// Every way the routines list gets drawn, and every way the shell arrives at
// it, enumerated and pressed.
//
// WHY THIS FILE IS A MANIFEST AND NOT A LIST OF TESTS.
//
// The routine editor's doors file exists because four separate reviews each
// found a different way IN with no test behind it, and each was fixed by
// testing the one that had been named. None asked what the next one was, so
// the next one arrived. The rule that ended it: an entry point is tested by
// the surface a user touches, applied to all of them rather than to the one
// most recently found.
//
// That file covers who opens the EDITOR. Nothing covered who renders this
// VIEW, and the same class turned up here immediately: renderRoutines was
// reached only through the roster case of the client dispatch, and deleting
// that call left the whole suite green while the rail entry never appeared and
// the list never refreshed.
//
// So this enumerates two things, because a list that is never drawn and a list
// that cannot be reached are the same defect from a user's side:
//
//   RENDERERS  every call to renderRoutines in the client
//   ROUTES     every way the shell arrives at the routines section
//
// Both are checked against the source, so one added later fails here until
// somebody lists it and names the test that presses it. And the surfaces are
// PRESSED: a rail button is clicked as markup, and a dispatch case is cut out
// of app.js and run, rather than matched as a string.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf-8');
const APP_SRC = read('public', 'app.js');
const INDEX_SRC = read('public', 'index.html');
const VIEW_SRC = read('public', 'views', 'routines.js');
const MODEL_SRC = read('public', 'routines-model.js');
const EDITOR_MODEL_SRC = read('public', 'routine-editor-model.js');
// Loaded before the routines model, which reads the shared no-guide next step
// off it, in the order index.html loads them.
const SKILLS_MODEL_SRC = read('public', 'skills-model.js');
const EDITOR_VIEW_SRC = read('public', 'views', 'routine-editor.js');
const PROFILE_VIEW_SRC = read('public', 'views', 'profile.js');
// The run detail screen, which is opened from a row on this list and returns
// here. Loaded so the return journey is pressed rather than described.
const RUN_DETAIL_MODEL_SRC = read('public', 'run-detail-model.js');
const RUN_DETAIL_VIEW_SRC = read('public', 'views', 'run-detail.js');

// ===== THE ENUMERATION =====
//
// Every call to renderRoutines anywhere in the client, keyed by the text of
// the line it sits on so two calls in one file are two rows rather than one.
// Adding a way to draw this list means adding a row here, which means naming
// the test.
const RENDERERS = [
  {
    file: 'app.js',
    line: "case 'agents':",
    surface: 'the roster arriving from the server',
    pressedBy: 'the roster arriving from the server draws the list',
  },
  // THE RAIL NO LONGER DRAWS THIS LIST ITSELF and neither does the profile.
  // Both arrive through one destination function, which is where the drawing
  // moved to. Two routes into one section with two copies of the same three
  // calls is how `openRoutineEditor` ended up lighting Team on a routines
  // surface, so the rail's arm passes no agent and a profile row passes one.
  {
    file: 'views/routines.js',
    line: 'function showRoutinesForAgent(agentId)',
    surface: 'every arrival at this list, from the rail with no agent and from a profile row with one',
    pressedBy: 'the rail entry shows the view and draws the list',
  },
  {
    file: 'app.js',
    line: "case 'skills':",
    surface: 'the skill list arriving from the server, which settles which empty state this shows',
    pressedBy: 'the skill list arriving redraws the list that asks about skills',
  },
  {
    file: 'views/routines.js',
    line: 'function routinesAskDelete(index)',
    surface: 'the Delete control on a row, which redraws into the confirmation',
    pressedBy: 'the view redraws itself for its own controls',
  },
  {
    file: 'views/routines.js',
    line: 'function routinesCancelDelete()',
    surface: 'Cancel on the confirmation, which redraws back into the list',
    pressedBy: 'the view redraws itself for its own controls',
  },
  {
    file: 'views/routines.js',
    line: 'function routinesConfirmDelete()',
    surface: 'Delete routine on the confirmation, which redraws the list',
    pressedBy: 'the view redraws itself for its own controls',
  },
  {
    file: 'views/routines.js',
    line: 'function routinesActionFailed(reply)',
    surface: 'a refused pause or delete coming back from the server',
    pressedBy: 'a refused action is answered on this list and nowhere else',
  },
];

// Every call the client's message dispatch makes INTO this view. A reply that
// is correct and lands on another screen is the defect the editor card was
// built around, and it happened three times on this one, so the calls that
// carry a reply here are enumerated like the ones that draw.
const REPLIES = [
  {
    call: 'routinesActionFailed',
    on: "case 'routine_action_error':",
    surface: 'the refusal a pause or delete came back with',
    pressedBy: 'a refused action is answered on this list and nowhere else',
  },
  {
    call: 'routinesActionCleared',
    on: "case 'routine_deleted':",
    surface: 'a delete that went through, which retires the last refusal',
    pressedBy: 'a change that goes through retires the last refusal',
  },
  {
    call: 'routinesActionCleared',
    on: "case 'routine_paused':",
    surface: 'a pause that went through, which retires the last refusal',
    pressedBy: 'a change that goes through retires the last refusal',
  },
];

// Every way the shell arrives at the routines section.
const ROUTES = [
  {
    what: "the rail entry's own onclick",
    pressedBy: 'the rail entry shows the view and draws the list',
  },
  {
    what: 'the routine editor leaving for the list after a save',
    pressedBy: 'a saved routine leaves the editor for this view',
  },
  {
    what: 'the section the rail entry reveals in the sidebar',
    pressedBy: 'every section the rail carries reveals a sidebar the reader can see',
  },
  // The run detail screen is opened FROM a row on this list and its back
  // control returns here, so it is a route in exactly the sense this file
  // means: a way the shell arrives at the routines section. Enumerated when it
  // arrived, because the exclusion below went red the moment it did.
  {
    what: 'the run detail screen leaving for the list it was opened from',
    pressedBy: 'the run detail back control returns to this view',
  },
  {
    what: "a routine row in the Routines box on an agent's profile",
    pressedBy: 'a routine row on a profile opens this list scoped to that agent',
  },
];

// Every call the client makes into this view TO LAND A READER ON IT. Separate
// from REPLIES because the two fail differently: a reply that arrives on the
// wrong screen is a message handled in the wrong place, and a route that
// arrives with the wrong scope is a list that has silently lost rows. Both are
// checked against the source by the same rule, so one added later fails by
// name until somebody lists it with the test that presses its surface.
const ENTRIES = [
  {
    call: 'showRoutinesForAgent',
    from: 'public/app.js',
    surface: "the rail's own arm, which passes no agent and so asks for the whole team",
    pressedBy: 'the rail entry shows the view and draws the list',
  },
  {
    call: 'showRoutinesForAgent',
    from: 'public/views/profile.js',
    surface: "a routine row in the Routines box on an agent's profile",
    pressedBy: 'a routine row on a profile opens this list scoped to that agent',
  },
];

// Ways in that exist in the flow and are deliberately not pressed here, each
// with the reason. A named exclusion is a decision; an unnamed one is how the
// editor's version of this file went round four times.
const NOT_PRESSED = [
  {
    what: 'a keyboard or command-palette route to the routines section',
    why: 'there is none. The palette indexes files, conversations, agents and skills, and it '
      + 'reaches no nav section directly. Asserted below rather than asserted by me.',
  },
  {
    what: 'a deep link or a URL',
    why: 'the client has no router and no URL state at all: every view change goes through '
      + 'switchNav or a destination function. Asserted below rather than asserted by me.',
  },
];

function clientFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.name === 'vendor') continue;
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith('.js')) out.push(rel);
    }
  };
  walk('public');
  return out;
}

// The call site of every renderRoutines call, as "file: the line it is on or
// the function it is in". A call inside a function is attributed to that
// function's declaration, which is the stable thing to name: the body around
// it moves, the declaration does not.
function renderCallSites() {
  const sites = [];
  for (const rel of clientFiles()) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!/(?<![.\w$])renderRoutines\(/.test(lines[i])) continue;
      if (/^\s*function renderRoutines/.test(lines[i])) continue;  // the declaration itself
      let owner = lines[i].trim();
      // A branch is named by its condition and a function by its declaration,
      // both without the body: the body moves, the construct that carries the
      // call does not, so a row here survives an unrelated edit on the same
      // line and still fails when the call moves somewhere new.
      if (/^case /.test(owner)) owner = owner.slice(0, owner.indexOf(':') + 1);
      else if (/^(else if|if )/.test(owner)) owner = owner.slice(0, owner.indexOf('{')).trim();
      else {
        for (let j = i; j >= 0; j--) {
          if (/^(async )?function \w+\(/.test(lines[j])) { owner = lines[j].replace(/\s*\{\s*$/, '').trim(); break; }
        }
      }
      sites.push(`${rel.replace('public/', '')}: ${owner}`);
    }
  }
  return [...new Set(sites)].sort();
}

describe('every way this list gets drawn is enumerated', () => {
  // THE CHECK THAT ENDS THE LOOP. A new call fails here, by name, until it is
  // listed with the test that presses its surface.
  test('no call that draws this list exists that this file does not name', () => {
    const named = RENDERERS.map(r => `${r.file}: ${r.line}`).sort();
    assert.deepStrictEqual(renderCallSites(), named,
      'something draws the routines list from a place this file does not list, or a listed '
      + 'one no longer exists. Add the row and the test that presses its surface, or remove it.');
  });

  test('every renderer names a test, and every named test exists', () => {
    const suite = fs.readFileSync(__filename, 'utf-8');
    for (const entry of [...RENDERERS, ...ROUTES, ...REPLIES, ...ENTRIES]) {
      assert.ok(entry.pressedBy, `${entry.file || entry.what || entry.call} needs a test`);
      assert.ok(suite.includes(`test('${entry.pressedBy}'`),
        `this file names "${entry.pressedBy}" but no test here has that name`);
    }
  });

  test('a way in left unpressed says why', () => {
    for (const excluded of NOT_PRESSED) {
      assert.ok(excluded.what && excluded.why && excluded.why.length > 40,
        'an exclusion without a reason is how the editor version went round four times');
    }
  });

  // The two exclusions, checked rather than asserted by me.
  test('nothing reaches the routines section except the routes named here', () => {
    for (const rel of clientFiles()) {
      if (rel === 'public/app.js') continue;
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
      for (const m of src.matchAll(/(?:switchNav|showView|setNavState)\((['"])([\w-]+)\1\)/g)) {
        if (m[2] !== 'routines') continue;
        // Three files may, and each is listed in ROUTES above with the test
        // that presses it: the editor, which leaves for this list after a
        // save; this view itself, which names its own section on the one
        // destination function every route runs through; and the run detail
        // screen, whose back control returns here. Widened deliberately rather
        // than loosened, so a fourth file navigating here still fails until
        // somebody names it.
        assert.ok(/routine-editor\.js$|views\/routines\.js$|views\/run-detail\.js$/.test(rel),
          `${rel} navigates to the routines section and is not a listed route`);
      }
    }
    // The palette navigates, but only to the sections it indexes: files and
    // skills. It has never indexed routines, which is why it is excluded here
    // rather than enumerated.
    const palette = read('public', 'palette-model.js') + read('public', 'views', 'palette.js');
    const reached = [...palette.matchAll(/switchNav\((['"])([\w-]+)\1\)/g)].map(m => m[2]);
    assert.deepStrictEqual([...new Set(reached)].sort(), ['files', 'skills'],
      'the palette now reaches another section; if it reaches routines it needs a row');
  });

  test('the client has no URL router, so there is no route this file cannot see', () => {
    for (const rel of clientFiles()) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
      assert.ok(!/window\.location\.hash|popstate|pushState/.test(src),
        `${rel} reads or writes URL state, so a deep link can reach a view and needs a row`);
    }
  });
});

// ===== PRESSING THEM =====

// A shell carrying the REAL nav rail and the REAL view panel, cut out of
// index.html rather than written again here. A view that renders into an
// element the page does not have is a silent no-op, and a copy of the markup
// in this file would keep passing after the page stopped carrying it.
function shellMarkup() {
  const rail = /<nav class="nav-rail"[\s\S]*?<\/nav>/.exec(INDEX_SRC);
  assert.ok(rail, 'index.html no longer carries a nav rail');
  const panel = /<div id="view-routines"[\s\S]*?<\/div>\s*<\/div>/.exec(INDEX_SRC);
  assert.ok(panel, 'index.html no longer carries the routines view panel');
  // THE SIDEBAR IS CUT OUT OF THE PAGE TOO, and that is a correction rather
  // than tidiness. It used to be written here, which made the destination
  // check below unfalsifiable: the editor resolves where a save goes by asking
  // whether the shell has BOTH a rail entry called routines and the view panel
  // the router shows by that name, and a test that supplies either of them
  // itself answers its own question. Rename either in index.html and the
  // editor silently starts landing saves on the team chart, this file green.
  const sidebar = /<aside class="sidebar"[\s\S]*?<\/aside>/.exec(INDEX_SRC);
  assert.ok(sidebar, 'index.html no longer carries a sidebar');
  return '<!doctype html><html><body>' + rail[0] + sidebar[0]
    + '<div id="view-home"></div>' + panel[0] + '</body></html>';
}

const ROUTINE = {
  name: 'Compile the ops summary', schedule: 'every day at 07:00', prompt: 'p', runOn: 'local',
  enabled: true, paused: false, state: null,
  nextRun: new Date(2026, 7, 21, 7, 0).toISOString(), lastStart: null, lastSlot: null, missedSlot: null,
};

function shell({ routines = [ROUTINE] } = {}) {
  const dom = new JSDOM(shellMarkup(), { runScripts: 'dangerously' });
  const w = dom.window;
  w.eval(EDITOR_MODEL_SRC);
  w.eval(SKILLS_MODEL_SRC);
  w.eval(MODEL_SRC);
  w.eval(VIEW_SRC);
  w.agents = [{ id: 'piper', displayName: 'Piper', colour: '#E87A5A', icon: 'P', status: 'onTeam', routines }];
  w.esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  w.ws = { send: () => {} };
  w.routinesNow = () => new Date(2026, 7, 20, 9, 20);
  w.Intl = { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: 'Europe/London' }) }) };
  return { w, doc: w.document, dom };
}

// A named piece of app.js, cut out and RUN against stubs, which is the
// difference between checking the words are there and checking what they do.
// The extraction asserts the piece EXISTS, so a deleted one fails here rather
// than yielding an empty body that then passes every assertion about what it
// did not do.
function appPiece(pattern, label) {
  const m = APP_SRC.match(pattern);
  assert.ok(m && m[1] && m[1].trim(), `app.js no longer carries ${label}`);
  return m[1];
}

// A shell with two agents and a real profile panel, cut out of index.html. The
// second agent is what makes a scope observable at all: on a workspace with one
// agent, a scoped list and an unscoped one are the same list.
function twoAgentShell() {
  const { w, doc, dom } = shell();
  const profilePanel = /<div id="view-profile"[\s\S]*?<\/div>\s*<\/div>/.exec(INDEX_SRC);
  assert.ok(profilePanel, 'index.html no longer carries a profile panel');
  doc.body.insertAdjacentHTML('beforeend', profilePanel[0]);
  w.eval(PROFILE_VIEW_SRC);
  w.agents = [
    w.agents[0],
    { id: 'ted', displayName: 'Ted', colour: '#6BC67E', icon: 'T', status: 'onTeam',
      routines: [{ ...ROUTINE, name: 'Reconcile the delivery log' }] },
  ];
  w.conversations = [];
  w.skills = [];
  w.formatTimeAgo = () => 'a while ago';
  w.getGuide = () => ({ id: 'doc' });
  w.showView = () => {};
  w.setNavState = () => {};
  w.switchNav = () => {};
  w.startConversation = () => {};
  w.addToTeam = () => {};
  w.openConversation = () => {};
  w.selectSkill = () => {};
  w.addRoutineForAgent = () => {};
  return { w, doc, dom };
}

// Arrive by the route a reader takes: render that agent's profile and press a
// routine row on it. Never by calling the destination function, which would say
// nothing about whether any row reaches it.
function pressProfileRow(w, doc, agentId) {
  w.showProfile(agentId);
  const row = doc.querySelector('#profile-content .profile-card-item[onclick^="showRoutinesForAgent"]');
  assert.ok(row, `the profile for ${agentId} carries no routine row that opens this list`);
  row.click();
  return row;
}

describe('the ways this list gets drawn, pressed', () => {
  test('the roster arriving from the server draws the list', () => {
    const { w, dom } = shell();
    const body = appPiece(/case 'agents':([\s\S]*?)\bbreak;/, 'the roster case of the client dispatch');
    w.drawn = 0;
    const realRender = w.renderRoutines;
    w.renderRoutines = () => { w.drawn++; realRender(); };
    // Everything else the roster case calls. updateRoutineFailureBadge is
    // among them: it puts the failure dot on the rail rather than anything in
    // this view, so what it does is driven where the rail is drawn, in
    // "the roster arriving from the server raises and clears the dot" in
    // test/unit/routines-view.test.js. Named here so this case can run at all,
    // and named there so it is not merely named.
    for (const name of ['renderAgentList', 'renderOrgChart', 'renderConvoList',
      'updateRoutineFailureBadge']) {
      w[name] = () => {};
    }
    w.d = { type: 'agents', agents: w.agents };
    w.eval(`(function () {${body}\n})()`);
    assert.strictEqual(w.drawn, 1, 'a roster arrived and the routines list was not redrawn');
    assert.strictEqual(w.document.querySelectorAll('.routine-row').length, 1);
    dom.window.close();
  });

  // THE REPLY THAT SETTLES WHICH EMPTY STATE THIS SHOWS. The list asks whether
  // the workspace has a skill, so the message that answers that question has
  // to redraw it. Without this call the pane sits on its waiting line until
  // the next roster broadcast, which on a workspace with no routines is the
  // rest of the session.
  test('the skill list arriving redraws the list that asks about skills', () => {
    const { w, doc, dom } = shell({ routines: [] });
    w.skills = [];
    w.skillsLoaded = false;
    w.getGuide = () => ({ id: 'doc' });
    w.renderRoutines();
    assert.match(doc.getElementById('routines-content').textContent, /Looking for skills/,
      'sanity: the list is waiting on the reply before it arrives');

    const body = appPiece(/case 'skills':([\s\S]*?)\bbreak;/, 'the skills case of the client dispatch');
    w.renderSkills = () => {};
    w.selectSkill = () => {};
    w.routineEditorSkillsArrived = () => {};
    w.palettePendingSkill = null;
    w.d = { type: 'skills', skills: [] };
    w.eval(`(function () {${body}\n})()`);

    assert.match(doc.getElementById('routines-content').textContent,
      /Routines schedule skills your agents already have/,
      'the reply arrived and the list was left on its waiting line');
    dom.window.close();
  });

  test('the rail entry shows the view and draws the list', () => {
    const { w, doc, dom } = shell();
    // The rail entry is PRESSED as it sits in index.html, so what it calls is
    // read off the page rather than out of this file.
    const entry = doc.querySelector('.nav-item[data-nav="routines"]');
    assert.ok(entry, 'index.html no longer carries a Routines rail entry');
    const body = appPiece(/else if\(nav==='routines'\)\s*\{([\s\S]*?)\}/, "switchNav's routines arm");
    w.shown = null;
    w.showView = (v) => { w.shown = v; };
    w.navState = null;
    w.setNavState = (v) => { w.navState = v; };
    w.closeFindBar = () => {};
    w.switchNav = (nav) => {
      assert.strictEqual(nav, 'routines', 'the rail entry asks for another section');
      w.eval(`(function () {${body}\n})()`);
    };
    entry.click();
    assert.strictEqual(w.shown, 'routines', 'the rail entry does not show this view');
    assert.strictEqual(w.navState, 'routines', 'the rail says one section and the pane shows another');
    assert.strictEqual(doc.querySelectorAll('.routine-row').length, 1,
      'the rail entry shows the view without drawing anything into it');
    dom.window.close();
  });

  // THE OTHER ROUTE, and the one that carries a scope. Pressed as markup on a
  // rendered profile, because what a row does is the claim: calling the
  // destination function would say nothing about whether any row calls it.
  //
  // The scope is checked in BOTH directions in one walk. A list that shows the
  // agent's routines proves nothing on a workspace with one agent, and a scope
  // that never clears is a list that has silently lost rows the next time
  // somebody arrives from the rail.
  test('a routine row on a profile opens this list scoped to that agent', () => {
    const { w, doc, dom } = twoAgentShell();
    pressProfileRow(w, doc, 'piper');
    let listed = doc.getElementById('routines-content').textContent;
    assert.match(listed, /Compile the ops summary/, 'the list does not carry the agent whose row was pressed');
    assert.ok(!listed.includes('Reconcile the delivery log'),
      'the list carries another agent, so the row opened it unscoped');

    // And the rail, which asks for everybody, gets everybody.
    w.eval(`(function () {${appPiece(/else if\(nav==='routines'\)\s*\{([\s\S]*?)\}/, "switchNav's routines arm")}\n})()`);
    listed = doc.getElementById('routines-content').textContent;
    assert.match(listed, /Reconcile the delivery log/,
      'the rail entry inherited the last profile\'s scope, so the list has lost rows');
    dom.window.close();
  });

  // A DELETE CONFIRMATION DOES NOT SURVIVE A CHANGE OF SCOPE, and this is a
  // destructive action rather than a cosmetic one.
  //
  // The pending delete is a POSITION in the list, and the scope decides what
  // the list contains, so a confirmation opened against one list addresses a
  // different routine under the next. The render only drops the index when it
  // falls off the end, so whenever the next list is long enough the reader is
  // shown a confirmation they never asked for, naming a routine they never
  // pointed at, and confirming it deletes that one.
  //
  // Driven in the direction that RE-AIMS rather than the one that merely
  // strands: the confirmation is opened on the first row of the whole-team
  // list, which belongs to one agent, and the reader then arrives scoped to
  // another agent whose own list is long enough to have a first row.
  test('a delete confirmation cannot be re-aimed by arriving from somewhere else', () => {
    const { w, doc, dom } = twoAgentShell();
    w.sent = [];
    w.ws = { send: (m) => w.sent.push(JSON.parse(m)) };

    w.renderRoutines();
    doc.querySelectorAll('[data-routines-action="delete"]')[0].click();
    const confirmation = doc.querySelector('.confirm-card');
    assert.ok(confirmation, 'sanity: pressing Delete did not open a confirmation');
    assert.match(doc.getElementById('routines-content').textContent, /Compile the ops summary/,
      'sanity: the confirmation is not the one the reader opened');

    pressProfileRow(w, doc, 'ted');
    assert.strictEqual(doc.querySelector('.confirm-card'), null,
      'a confirmation the reader never opened is on the page, aimed at another agent\'s routine');

    // And the control behind it cannot act either, which is the half that
    // matters: a stale confirmation that is merely invisible would still
    // delete when the next Enter reaches it.
    w.routinesConfirmDelete();
    assert.deepStrictEqual(w.sent, [],
      'a routine was deleted that the reader never asked to delete');
    dom.window.close();
  });

  // The scope is a filter, and a filter with nothing left to show must not be
  // mistaken for a workspace with nothing in it. The empty state speaks for the
  // whole team: it says nothing is scheduled and offers a picker spanning every
  // agent. Nothing on this page names the scope, so under one that reads as a
  // claim about the workspace, and the claim is false.
  test('a scoped list that empties does not say the workspace is empty', () => {
    const { w, doc, dom } = twoAgentShell();
    pressProfileRow(w, doc, 'piper');
    assert.match(doc.getElementById('routines-content').textContent, /Compile the ops summary/,
      'sanity: the scoped list is not showing the agent it was opened for');

    // The agent's last routine goes, and the roster comes back without it.
    w.agents = w.agents.map(a => (a.id === 'piper' ? { ...a, routines: [] } : a));
    w.renderRoutines();

    const shown = doc.getElementById('routines-content').textContent;
    assert.ok(!/No routines yet/.test(shown),
      'the page says the workspace has nothing scheduled while another agent still does');
    assert.match(shown, /Reconcile the delivery log/,
      'the filter had nothing left to show and was drawn empty rather than dropped');
    dom.window.close();
  });

  // THE RETURN JOURNEY, pressed on the control a reader touches rather than by
  // calling what it calls. The run detail screen is opened from a row here and
  // its only way back is this control; a rename of the section it asks for
  // strands the reader on a screen with no exit and throws nothing.
  test('the run detail back control returns to this view', () => {
    const { w, doc, dom } = shell();
    w.eval(RUN_DETAIL_MODEL_SRC);
    w.eval(RUN_DETAIL_VIEW_SRC);
    // The panel the screen draws into, cut out of the real page.
    const panel = /<div id="view-run-detail"[\s\S]*?<\/div>\s*<\/div>/.exec(INDEX_SRC);
    assert.ok(panel, 'index.html no longer carries the run detail view panel');
    doc.body.insertAdjacentHTML('beforeend', panel[0]);
    w.showView = () => {};
    w.setNavState = () => {};
    w.navigatedTo = null;
    w.switchNav = (nav) => { w.navigatedTo = nav; };
    w.openRunDetail('piper', 'Compile the ops summary');
    const back = doc.querySelector('[data-run-detail="back"]');
    assert.ok(back, 'the run detail screen carries no way back');
    back.click();
    assert.strictEqual(w.navigatedTo, 'routines',
      'the run detail screen leaves for somewhere other than the list it was opened from');
    dom.window.close();
  });

  test('the view redraws itself for its own controls', () => {
    const { w, doc, dom } = shell();
    w.renderRoutines();
    doc.querySelector('[data-routines-action="delete"]').click();
    assert.ok(doc.querySelector('.confirm-card'), 'Delete did not redraw into the confirmation');
    doc.querySelector('[data-routines-action="cancel-delete"]').click();
    assert.strictEqual(doc.querySelector('.confirm-card'), null, 'Cancel did not redraw back');
    doc.querySelector('[data-routines-action="delete"]').click();
    doc.querySelector('[data-routines-action="confirm-delete"]').click();
    assert.strictEqual(doc.querySelector('.confirm-card'), null, 'Confirm did not redraw');
    dom.window.close();
  });

  test('a saved routine leaves the editor for this view', () => {
    // The editor decides where to go by asking whether the shell can reach a
    // section: a rail entry AND a sidebar panel for it. Both have to be true
    // of the real page, or a save silently lands somewhere else.
    //
    // AND THE SAVE IS DRIVEN, not just the resolution read. Asserting what
    // routinesListNav returns says where the editor WOULD go. The failure this
    // is written against is a rename of either half in index.html sending a
    // real save to the team chart with nothing thrown, so the save has to
    // actually travel: the editor is opened, a routine is picked and written,
    // and the server's confirmation is what makes it leave.
    const { doc, w, dom } = shell();
    w.eval(EDITOR_VIEW_SRC);
    // Both halves of the destination, read off the real page rather than
    // supplied here, so a rename of either fails this rather than falling back
    // to the team panel in silence.
    assert.ok(doc.querySelector('[data-nav="routines"]'),
      'index.html carries no routines rail entry, so the editor cannot reach this view');
    assert.ok(doc.getElementById('view-routines'),
      'index.html carries no routines view panel, so the editor cannot reach this view');

    w.skills = [{ id: 'sk', name: 'Compile the ops summary', slug: 'ops', assignedAgents: [{ id: 'piper', name: 'Piper' }] }];
    w.skillsLoaded = true;
    w.setNavState = () => {};
    w.showView = () => {};
    w.sent = [];
    w.ws = { send: (msg) => w.sent.push(JSON.parse(msg)) };
    w.navigatedTo = null;
    w.switchNav = (nav) => { w.navigatedTo = nav; };
    w.addRoutine();
    const option = w.RundockRoutineEditorModel.skillChoices({ skills: w.skills }).options[0];
    w.routineEditorPick(option.key);
    w.saveRoutine();
    assert.strictEqual(w.sent.length, 1, 'sanity: the editor asked for the routine to be written');
    assert.strictEqual(w.navigatedTo, null, 'the editor left on send rather than on the reply');

    w.routineEditorSaved();
    assert.strictEqual(w.navigatedTo, w.RundockRoutineEditorModel.SAVE_DESTINATION,
      'a written routine landed somewhere other than the list of routines');
    assert.strictEqual(w.navigatedTo, 'routines');
    dom.window.close();
  });
});

describe('every reply that reaches this view is enumerated', () => {
  // The same check as the one above, on the other kind of path: a call added
  // to the dispatch fails here by name until it is listed with its test.
  test('no reply reaches this view that this file does not name', () => {
    const published = Object.keys(require(path.join(ROOT, 'public', 'views', 'routines.js')));
    const found = [];
    for (const rel of clientFiles()) {
      if (rel === 'public/views/routines.js') continue;
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
      for (const call of published) {
        if (call === 'renderRoutines') continue;  // enumerated above, as a render
        if (new RegExp(`(?<![.\\w$])${call}\\(`).test(src)) found.push(call);
      }
    }
    assert.deepStrictEqual([...new Set(found)].sort(),
      [...new Set([...REPLIES, ...ENTRIES].map(r => r.call))].sort(),
      'the client calls into this view from somewhere this file does not list, or a listed '
      + 'call no longer exists. Add the row and the test that drives it, or remove the row.');
  });

  // And an entry is named with the file it is called from, so moving the call
  // fails here rather than passing on the strength of the name alone.
  test('every entry is called from the file this file says it is called from', () => {
    for (const entry of ENTRIES) {
      const src = read(...entry.from.split('/'));
      assert.ok(new RegExp(`(?<![.\\w$])${entry.call}\\(`).test(src),
        `${entry.from} no longer calls ${entry.call}`);
    }
  });

  test('every reply is on the case this file says it is on', () => {
    for (const reply of REPLIES) {
      const body = appPiece(new RegExp(`${reply.on}([\\s\\S]*?)\\bbreak;`), `the ${reply.on} case`);
      assert.ok(new RegExp(`(?<![.\\w$])${reply.call}\\(`).test(body),
        `${reply.on} no longer calls ${reply.call}`);
    }
  });

  // THE DEFECT THIS EXISTS FOR, driven rather than described. A refused pause
  // or delete used to travel the SAVE road, whose case posts to the
  // conversation transcript and calls the editor's save-failure callback. The
  // reader pressed a control on this list and the reply arrived on a screen
  // they were not looking at, while the editor was poked outside any save.
  test('a refused action is answered on this list and nowhere else', () => {
    const { w, doc, dom } = shell();
    w.renderRoutines();
    w.said = [];
    w.addSystemMsg = (t) => w.said.push(t);
    w.editorTold = [];
    w.routineEditorFailed = (m) => w.editorTold.push(m);
    const body = appPiece(/case 'routine_action_error':([\s\S]*?)\bbreak;/, 'the refusal case');
    w.d = {
      type: 'routine_action_error', agentId: 'piper',
      name: 'Compile the ops summary', message: 'Routine "Compile the ops summary" could not be paused.',
    };
    w.eval(`(function () {${body}\n})()`);

    const problem = doc.querySelector('[data-routines-problem]');
    assert.ok(problem, 'the list the control was pressed on says nothing');
    assert.strictEqual(problem.textContent.trim(),
      'Routine "Compile the ops summary" could not be paused.',
      'the server knows which of several things went wrong, so its words are the ones shown');
    assert.deepStrictEqual(w.said, [], 'the refusal went to the conversation transcript as well');
    assert.deepStrictEqual(w.editorTold, [],
      'a refused delete called the editor\'s save-failure callback outside any save');
    dom.window.close();
  });

  test('a refusal with nothing in it still says something', () => {
    const { w, doc, dom } = shell();
    w.renderRoutines();
    w.routinesActionFailed({ type: 'routine_action_error' });
    const problem = doc.querySelector('[data-routines-problem]');
    assert.ok(problem && problem.textContent.trim(), 'silence is the failure this path exists to prevent');
    dom.window.close();
  });

  test('a change that goes through retires the last refusal', () => {
    for (const type of ['routine_deleted', 'routine_paused']) {
      const { w, doc, dom } = shell();
      w.routinesActionFailed({ message: 'Routine could not be paused.' });
      assert.ok(doc.querySelector('[data-routines-problem]'));
      w.said = [];
      w.addSystemMsg = (t) => w.said.push(t);
      const body = appPiece(new RegExp(`case '${type}':([\\s\\S]*?)\\bbreak;`), `the ${type} case`);
      w.d = { type, agentId: 'piper', name: 'Compile the ops summary' };
      w.eval(`(function () {${body}\n})()`);
      w.renderRoutines();
      assert.strictEqual(doc.querySelector('[data-routines-problem]'), null,
        `${type} left last time's refusal on the page`);
      dom.window.close();
    }
  });

  // And the refusal does not outlive the reader's next attempt, whichever
  // control they reach for.
  test('the next action the reader takes clears the last refusal', () => {
    for (const press of [
      (doc) => doc.querySelector('[data-routines-action="pause"]').click(),
      (doc) => doc.querySelector('[data-routines-action="delete"]').click(),
    ]) {
      const { w, doc, dom } = shell();
      w.renderRoutines();
      w.routinesActionFailed({ message: 'Routine could not be paused.' });
      press(doc);
      w.renderRoutines();
      assert.strictEqual(doc.querySelector('[data-routines-problem]'), null);
      dom.window.close();
    }
  });
});

describe('the shell can actually show what it navigates to', () => {
  // THE BUG THIS CATCHES, and it is a silent one rather than a throw. The
  // routines section has no sidebar panel of its own; its panel is the team
  // one, resolved through the router's own map. There used to be an empty
  // element under the routines name NESTED in the team panel, left there by
  // the listing the team sidebar carried, so revealing it by name succeeded,
  // threw nothing, and left the reader looking at an empty sidebar because the
  // parent stayed hidden. The listing and the element are both gone; the
  // assertion that caught it stays, because the map can name a nested panel
  // again. It is not that an element was found: it is that what was revealed
  // can actually be seen.
  test('every section the rail carries reveals a sidebar the reader can see', () => {
    const { doc, w, dom } = shell();
    // Both cut out of app.js and run, so the mapping under test is the one
    // the page ships rather than one restated here. `const` at the top of an
    // eval binds inside it, so the declaration is taken as a `var` to put it
    // where the function body will look for it.
    w.eval(appPiece(/(const SIDEBAR_FOR = \{[^}]*\};)/, 'the sidebar map').replace('const ', 'var '));
    const body = appPiece(/function setNavState\(nav\) \{([\s\S]*?)\n\}/, 'setNavState');
    w.eval(`function setNavState(nav) {${body}\n}`);
    for (const entry of doc.querySelectorAll('.nav-item[data-nav]')) {
      const nav = entry.getAttribute('data-nav');
      w.setNavState(nav);
      assert.strictEqual(entry.classList.contains('active'), true, `${nav} did not become the active entry`);
      const panel = doc.getElementById(`sidebar-${w.SIDEBAR_FOR[nav] || nav}`);
      assert.ok(panel, `${nav} reveals no sidebar panel`);
      for (let el = panel; el; el = el.parentElement) {
        assert.ok(!el.classList.contains('hidden'),
          `${nav} reveals a panel that stays out of sight inside #${el.id || el.tagName}`);
      }
    }
    dom.window.close();
  });

  test('the view panel this list renders into is on the page', () => {
    const { doc, dom } = shell();
    assert.ok(doc.getElementById('view-routines'), 'index.html carries no routines view panel');
    assert.ok(doc.getElementById('routines-content'), 'index.html carries no element to render into');
    // And showView knows about it, or the panel never becomes visible.
    assert.match(APP_SRC, /showView\(v\) \{[\s\S]*?'routines'/, 'showView does not list the routines panel');
    dom.window.close();
  });
});
