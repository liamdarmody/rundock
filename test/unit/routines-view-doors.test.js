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
const SCOPE_MODEL_SRC = read('public', 'routines-scope-model.js');
const PANEL_SRC = read('public', 'views', 'routines-panel.js');
const TEAM_SRC = read('public', 'views', 'team.js');
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
  // The scope changing is a redraw of this list, not only of the panel. The
  // panel is the only surface that can change which routines are listed
  // without changing which routines exist, so a scope pressed and no list
  // redrawn leaves the reader looking at somebody else's routines.
  {
    file: 'views/routines-panel.js',
    line: 'function setRoutinesScope(agentId)',
    surface: 'a scope row in the routines panel',
    pressedBy: 'pressing a scope redraws the list into that agent alone',
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
    on: "case 'routine_enabled':",
    surface: 'a routine turned on, which retires the last refusal',
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
  w.eval(SCOPE_MODEL_SRC);
  w.eval(VIEW_SRC);
  w.eval(PANEL_SRC);
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
    // AND THE PANEL BESIDE IT, which is the half a roster broadcast is the
    // only chance to correct. The roster is what arrives when a routine is
    // added or deleted, so the counts and the scope rows are stale from that
    // moment until something redraws them.
    assert.ok(w.document.querySelector('#sidebar-routines [data-scope="all"]'),
      'a roster arrived and the routines panel was not redrawn');
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
    // THE SHIPPED ROUTER, not a stub of it. The rail no longer follows a second
    // call each destination makes for itself: showView resolves the section
    // from NAV_FOR_VIEW and sets it, so a stubbed showView sets no rail and a
    // stubbed setNavState answers a question nothing asks any more. Both are cut
    // out of app.js here, in one eval so the functions close over the tables the
    // way they do in the file, and the rail is then read off the page.
    w.eval([
      /const NAV_FOR_VIEW = \{[\s\S]*?\n\};/.exec(APP_SRC)[0],
      `function setNavState(nav) {${appPiece(/function setNavState\(nav\) \{([\s\S]*?)\n\}/, 'setNavState')}\n}`,
      `function showView(v) {${appPiece(/^function showView\(v\) \{(.*)\}\s*$/m, 'showView')}}`,
    ].join('\n'));
    w.closeFindBar = () => {};
    w.switchNav = (nav) => {
      assert.strictEqual(nav, 'routines', 'the rail entry asks for another section');
      w.eval(`(function () {${body}\n})()`);
    };
    entry.click();
    assert.ok(!doc.getElementById('view-routines').classList.contains('hidden'),
      'the rail entry does not show this view');
    assert.deepStrictEqual(
      [...doc.querySelectorAll('.nav-item[data-nav].active')].map(e => e.dataset.nav), ['routines'],
      'the rail says one section and the pane shows another');
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

  // The one surface that changes WHICH routines are listed without changing
  // which exist. Pressed as markup, because the failure it is written against
  // is a panel that repaints itself and leaves the list alone.
  test('pressing a scope redraws the list into that agent alone', () => {
    const { doc, w, dom } = shell();
    w.agents.push({
      id: 'doc', displayName: 'Doc', colour: '#6BC67E', icon: 'D', status: 'onTeam',
      routines: [Object.assign({}, ROUTINE, { name: 'Refresh the reading digest' })],
    });
    w.renderRoutinesPanel();
    w.renderRoutines();
    assert.strictEqual(doc.querySelectorAll('.routine-row').length, 2, 'sanity: both routines listed');

    doc.querySelector('[data-scope="doc"]').click();
    const rows = [...doc.querySelectorAll('.routine-row')];
    assert.strictEqual(rows.length, 1, 'pressing a scope did not redraw the list');
    assert.match(rows[0].textContent, /Refresh the reading digest/);

    doc.querySelector('[data-scope="all"]').click();
    assert.strictEqual(doc.querySelectorAll('.routine-row').length, 2,
      'pressing All did not restore every routine');
    dom.window.close();
  });

  // THE DEFECT A SCOPE FILTER INTRODUCES INTO A LIST ADDRESSED BY POSITION, and
  // it is the namesake defect arriving by a different road. pendingDelete was
  // an index into allRoutines(), and allRoutines() is now filtered, so pressing
  // a scope while a confirmation is open re-resolves that index against a
  // different set of routines. The confirmation goes on naming the routine the
  // reader pressed Delete on and the server is told to remove whatever now sits
  // at that position.
  //
  // A confirmation that names one thing and acts on another is worse than no
  // confirmation, because the dialogue is specific and wrong.
  test('a pending delete cannot be retargeted by a scope change', () => {
    const { doc, w, dom } = shell({ routines: [
      Object.assign({}, ROUTINE, { name: 'Compile the ops summary' }),
      Object.assign({}, ROUTINE, { name: 'Sweep the inbox' }),
      Object.assign({}, ROUTINE, { name: 'Chase the stragglers' }),
    ] });
    w.agents.push({
      id: 'mira', displayName: 'Mira', colour: '#A07AE8', icon: 'M', status: 'onTeam',
      routines: [
        Object.assign({}, ROUTINE, { name: 'Post the weekly note' }),
        Object.assign({}, ROUTINE, { name: 'Archive last month' }),
      ],
    });
    w.renderRoutinesPanel();
    w.renderRoutines();

    // Position 1 on All is Piper's second routine.
    doc.querySelectorAll('[data-routines-action="delete"]')[1].click();
    assert.ok(doc.querySelector('.confirm-card'), 'sanity: the confirmation is open');
    assert.match(doc.querySelector('.routines-confirm-subject').textContent, /Sweep the inbox/,
      'sanity: the confirmation names the routine that was pressed');

    // Position 1 among Mira's two is a different routine entirely.
    doc.querySelector('[data-scope="mira"]').click();

    const subject = doc.querySelector('.routines-confirm-subject');
    if (subject) {
      assert.match(subject.textContent, /Sweep the inbox/,
        'the confirmation changed subject when the scope changed, so Delete would remove '
        + 'a routine the reader never pressed Delete on');
    }

    // Whatever the panel decided to show, confirming must still send the
    // routine the reader pressed, or nothing at all.
    doc.querySelector('[data-scope="all"]').click();
    const confirm = doc.querySelector('[data-routines-action="confirm-delete"]');
    if (confirm) {
      w.sent = [];
      w.ws = { send: (m) => w.sent.push(JSON.parse(m)) };
      confirm.click();
      assert.strictEqual(w.sent.length, 1, 'the confirmation sent nothing');
      assert.strictEqual(w.sent[0].name, 'Sweep the inbox',
        'the confirmation removed a routine other than the one it named');
      assert.strictEqual(w.sent[0].agentId, 'piper');
    }
    dom.window.close();
  });

  // A confirmation is raised on the list the reader is looking at, so leaving
  // that list abandons it. It must not be waiting when they come back: a
  // destructive question the reader has navigated away from and then had
  // re-presented is one they will answer without re-reading.
  // THE CASE IDENTITY ALONE DOES NOT COVER, and it is why arriving clears the
  // confirmation rather than trusting the resolution to drop it. Identity drops
  // a confirmation whose routine has left the list, which covers every scope
  // change. It does NOT cover arriving at a list the routine is still in: press
  // Delete on All, walk away, come back through the rail, and the question is
  // still sitting there waiting to be answered by someone who has stopped
  // reading it. Arriving is the reader leaving and returning, so the question
  // goes with the visit.
  test('arriving from the rail clears a confirmation even when the scope is unchanged', () => {
    const { doc, w, dom } = shell();
    w.showView = () => {};
    w.setNavState = () => {};
    w.renderRoutinesPanel();
    w.renderRoutines();
    doc.querySelector('[data-routines-action="delete"]').click();
    assert.ok(doc.querySelector('.confirm-card'), 'sanity: the confirmation is open on All');

    // The rail's own arm, cut out of app.js, which arrives with no agent. The
    // scope is All before and after, so nothing about the list changes and the
    // routine the confirmation names is still in it.
    w.eval(`(function () {${appPiece(/else if\(nav==='routines'\)\s*\{([\s\S]*?)\}/, "switchNav's routines arm")}\n})()`);

    assert.strictEqual(doc.querySelector('.confirm-card'), null,
      'a destructive confirmation survived a visit and is waiting for a reader who has stopped reading it');
    w.sent = [];
    w.ws = { send: (m) => w.sent.push(JSON.parse(m)) };
    w.routinesConfirmDelete();
    assert.deepStrictEqual(w.sent, [],
      'the control behind the cleared confirmation can still delete');
    dom.window.close();
  });

  test('a confirmation the reader navigated away from does not come back', () => {
    const { doc, w, dom } = shell();
    w.agents.push({
      id: 'mira', displayName: 'Mira', colour: '#A07AE8', icon: 'M', status: 'onTeam',
      routines: [Object.assign({}, ROUTINE, { name: 'Post the weekly note' })],
    });
    w.renderRoutinesPanel();
    w.renderRoutines();
    doc.querySelector('[data-routines-action="delete"]').click();
    assert.ok(doc.querySelector('.confirm-card'), 'sanity: the confirmation is open');

    doc.querySelector('[data-scope="mira"]').click();
    assert.strictEqual(doc.querySelector('.confirm-card'), null,
      'sanity: leaving the list the confirmation was raised on closed it');

    doc.querySelector('[data-scope="all"]').click();
    assert.strictEqual(doc.querySelector('.confirm-card'), null,
      'a destructive confirmation the reader walked away from was re-presented to them');
    dom.window.close();
  });

  // The subject the confirmation DRAWS, which the send path does not cover: a
  // resolution that matched on agent and name alone would draw the first
  // namesake while the send carried the second, so the reader would read a
  // question about one routine and remove another that looks identical.
  test('the confirmation draws the namesake it was raised on', () => {
    const { doc, w, dom } = shell({ routines: [
      Object.assign({}, ROUTINE, { name: 'Weekly digest', schedule: 'every day at 07:00' }),
      Object.assign({}, ROUTINE, { name: 'Weekly digest', schedule: 'every day at 18:00' }),
    ] });
    w.renderRoutines();
    doc.querySelectorAll('[data-routines-action="delete"]')[1].click();
    const subject = doc.querySelector('.routines-confirm-subject');
    assert.ok(subject, 'sanity: the confirmation drew its subject');
    assert.match(subject.textContent, /6:00pm|18:00/,
      'the confirmation drew the first routine of that name rather than the one pressed');
    dom.window.close();
  });

  // AC-10, DRIVEN ALL THE WAY TO THE SCREEN.
  //
  // The test below asserts the NAME of the destination, which discriminates a
  // rename but stops one step short of the criterion. The criterion is about a
  // reader who saves a routine and is left looking at the wrong place, and the
  // fallback that does it is silent: routinesListNav checks the shell has both
  // a rail entry called routines and a panel called sidebar-routines, and
  // quietly answers 'team' when either is missing. Nothing throws and nothing
  // is logged.
  //
  // So nothing here is stubbed that decides where the reader ends up. The
  // router and the section switch are cut out of app.js and run, the save
  // travels, the server's confirmation is what makes the editor leave, and
  // what is asserted is the sidebar the reader is actually looking at.
  test('a saved routine leaves the reader looking at the routines panel', () => {
    const { doc, w, dom } = shell();
    w.eval(EDITOR_VIEW_SRC);
    w.skills = [{ id: 'sk', name: 'Compile the ops summary', slug: 'ops', assignedAgents: [{ id: 'piper', name: 'Piper' }] }];
    w.skillsLoaded = true;
    w.sent = [];
    w.ws = { send: (msg) => w.sent.push(JSON.parse(msg)) };

    // The pieces that carry a reader to a section, all real, and the table that
    // resolves one from the other. In ONE eval: showView reads NAV_FOR_VIEW,
    // and a lexical declaration loaded in an eval of its own is gone before the
    // function that closes over it runs.
    w.closeFindBar = () => {};
    w.eval([
      /const NAV_FOR_VIEW = \{[\s\S]*?\n\};/.exec(APP_SRC)[0],
      `function setNavState(nav) {${appPiece(/function setNavState\(nav\) \{([\s\S]*?)\n\}/, 'setNavState')}\n}`,
      `function showView(v) {${appPiece(/^function showView\(v\) \{(.*)\}\s*$/m, 'showView')}}`,
      `function switchNav(nav) {${appPiece(/function switchNav\(nav\) \{([\s\S]*?)\n\}/, 'switchNav')}\n}`,
    ].join('\n'));

    // Start somewhere else, so arriving is something the save has to do.
    w.setNavState('team');
    assert.ok(!doc.getElementById('sidebar-team').classList.contains('hidden'), 'sanity: on the team panel');

    w.addRoutine();
    const option = w.RundockRoutineEditorModel.skillChoices({ skills: w.skills }).options[0];
    w.routineEditorPick(option.key);
    w.saveRoutine();
    assert.strictEqual(w.sent.length, 1, 'sanity: the editor asked for the routine to be written');
    // WHICH SCREEN, not which panel. The panel was the proxy for this until the
    // rail and the sidebar became properties of the view: the editor is one of
    // the routines surfaces, so its panel is up the whole time the editor is,
    // and a hidden panel no longer means the editor has not left. The view on
    // screen is the thing this sentence is actually about.
    assert.ok(doc.getElementById('view-routines').classList.contains('hidden'),
      'the editor left on send rather than waiting for the reply');

    // The server confirms. This is the moment the editor leaves.
    w.routineEditorSaved();

    const panel = doc.getElementById('sidebar-routines');
    for (let el = panel; el; el = el.parentElement) {
      assert.ok(!el.classList.contains('hidden'),
        `a saved routine left the reader with the routines panel out of sight inside #${el.id || el.tagName}`);
    }
    assert.ok(doc.getElementById('sidebar-team').classList.contains('hidden'),
      'a saved routine landed the reader on the team panel, which is exactly the silent fallback');
    const view = doc.getElementById('view-routines');
    assert.ok(!view.classList.contains('hidden'), 'the routines view is not the one on screen');
    assert.ok(panel.querySelector('[data-scope]'),
      'the reader arrived at the panel and it is not holding the scope list');
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

describe('one mount, one renderer', () => {
  // THE PANEL AND THE LEGACY TEAM-SIDEBAR LISTING SHARE AN ELEMENT, and they
  // cannot stop sharing it here. team.js looks the mount up by the literal id
  // `sidebar-routines`; the router reveals a section's panel by that same
  // name, and the editor resolves where a save lands by checking a rail entry
  // and a panel of that name exist. So the id is load-bearing in three places
  // and a distinct one for the scope panel is not available from this branch.
  //
  // WHAT IS AVAILABLE IS THAT THE OTHER WRITER STOPS RUNNING. Correctness was
  // resting on call order: the legacy renderer drew its rows into this element
  // and the panel drew over them, on one line, in one order. Any caller that
  // ran the two the other way round put the roster-style rows back on screen,
  // which is the arrangement this whole card reverses.
  // ONE WRITER FOR THIS MOUNT, asserted against the client rather than against
  // a call that used to be in the dispatch. The listing that shared this
  // element is gone, so the ordering hazard is gone with it, and what is left
  // is the property that mattered: exactly one module renders into this panel.
  // A second one added later re-creates a race that was only ever survivable
  // by luck of call order.
  test('exactly one module renders into the routines panel', () => {
    const writers = clientFiles().filter((rel) => (
      fs.readFileSync(path.join(ROOT, rel), 'utf-8').includes("getElementById('sidebar-routines')")
    ));
    assert.deepStrictEqual(writers, ['public/views/routines-panel.js'],
      'something other than the panel addresses the routines panel mount, so two renderers '
      + 'can write to one element and the winner is decided by call order');
  });

  // The outcome, with the real team module loaded alongside, because that is
  // the shell the dispatch actually runs in. The roster-style markup is named
  // explicitly rather than assumed absent: it is what used to be written into
  // this element, and asserting its absence is what would notice it returning.
  test('after a real roster arrives the panel holds the scope list and no legacy rows', () => {
    const { doc, w, dom } = shell();
    w.eval(TEAM_SRC);
    w.getGuide = () => null;
    // updateRoutineFailureBadge is stubbed with the rest: it draws the failure
    // dot on the nav rail rather than in this panel, and what it does is driven
    // in test/unit/routines-view.test.js.
    for (const name of ['renderOrgChart', 'renderConvoEmptyAgents', 'renderConvoList', 'renderAgentList',
      'updateRoutineFailureBadge']) {
      w[name] = () => {};
    }
    const body = appPiece(/case 'agents':([\s\S]*?)\bbreak;/, 'the roster case of the client dispatch');
    w.d = { type: 'agents', agents: w.agents };
    w.eval(`(function () {${body}\n})()`);

    const panel = doc.getElementById('sidebar-routines');
    assert.ok(panel.querySelector('[data-scope]'), 'the panel is not holding the scope list');
    assert.strictEqual(panel.querySelector('.routine-item'), null,
      'the legacy roster-style rows were drawn into the scope panel');
    assert.strictEqual(panel.querySelector('[data-sidebar-action]'), null,
      'the legacy Add control was drawn into the scope panel');
    dom.window.close();
  });

  // The workspace AC-2 protects. The legacy renderer empties its mount when
  // there are no routines, so on exactly this workspace a clobber does not
  // draw the wrong thing, it draws nothing, and the panel disappears.
  test('with no routines the panel is neither emptied nor hidden', () => {
    const { doc, w, dom } = shell({ routines: [] });
    w.eval(TEAM_SRC);
    w.getGuide = () => null;
    // updateRoutineFailureBadge is stubbed with the rest: it draws the failure
    // dot on the nav rail rather than in this panel, and what it does is driven
    // in test/unit/routines-view.test.js.
    for (const name of ['renderOrgChart', 'renderConvoEmptyAgents', 'renderConvoList', 'renderAgentList',
      'updateRoutineFailureBadge']) {
      w[name] = () => {};
    }
    // Revealed first, by the real router, because the panel is correctly
    // hidden until a reader goes there. What this asserts is that the roster
    // arriving does not take it away again.
    w.eval(`function setNavState(nav) {${appPiece(/function setNavState\(nav\) \{([\s\S]*?)\n\}/, 'setNavState')}\n}`);
    w.setNavState('routines');
    const body = appPiece(/case 'agents':([\s\S]*?)\bbreak;/, 'the roster case of the client dispatch');
    w.d = { type: 'agents', agents: w.agents };
    w.eval(`(function () {${body}\n})()`);

    const panel = doc.getElementById('sidebar-routines');
    assert.ok(panel.querySelector('[data-scope="all"]'),
      'the panel went blank on the workspace that has nothing in it');
    assert.ok(!panel.classList.contains('hidden'), 'the roster arriving hid the panel');
    dom.window.close();
  });
});

describe('the workspace switch puts the sidebar back', () => {
  // THE SECOND HARD-CODED LIST OF PANELS, driven rather than described. The
  // router's list was extended when this panel was lifted out of the team one.
  // The workspace-switch reset carried its own copy of that list, one name
  // short, so switching workspace while on this view left the routines panel
  // on screen stacked above the conversations panel the reset reveals.
  //
  // Two lists of the same thing is one list that is wrong, so the reset is
  // routed through the router and this drives the real code to prove it.
  test('switching workspace leaves exactly one sidebar on screen', () => {
    const { doc, w, dom } = shell();
    const setNav = appPiece(/function setNavState\(nav\) \{([\s\S]*?)\n\}/, 'setNavState');
    w.eval(`function setNavState(nav) {${setNav}\n}`);
    const reset = appPiece(/function resetSidebarForWorkspace\(\) \{([\s\S]*?)\n\}/,
      'the sidebar reset a workspace switch runs');

    // The reader is on the routines view when the switch happens.
    w.setNavState('routines');
    assert.ok(!doc.getElementById('sidebar-routines').classList.contains('hidden'),
      'sanity: the routines panel is on screen before the switch');

    w.eval(`(function () {${reset}\n})()`);

    const visible = [...doc.querySelectorAll('.sidebar > div[id^="sidebar-"]')]
      .filter(el => !el.classList.contains('hidden')).map(el => el.id);
    assert.deepStrictEqual(visible, ['sidebar-conversations'],
      'a workspace switch left more than one sidebar panel on screen, stacked in one column');
  });

  // The scope is an agent id, and agent ids belong to the workspace that owned
  // them. Carried into the next one it names an agent that may not be there.
  test('switching workspace forgets the scope the last one was left on', () => {
    const { doc, w, dom } = shell();
    w.agents.push({
      id: 'mira', displayName: 'Mira', colour: '#A07AE8', icon: 'M', status: 'onTeam',
      routines: [Object.assign({}, ROUTINE, { name: 'Post the weekly note' })],
    });
    w.eval(`function setNavState(nav) {${appPiece(/function setNavState\(nav\) \{([\s\S]*?)\n\}/, 'setNavState')}\n}`);
    w.renderRoutinesPanel();
    doc.querySelector('[data-scope="mira"]').click();
    assert.strictEqual(w.routinesScopeAgentId(), 'mira', 'sanity: scoped before the switch');

    const reset = appPiece(/function resetSidebarForWorkspace\(\) \{([\s\S]*?)\n\}/,
      'the sidebar reset a workspace switch runs');
    w.eval(`(function () {${reset}\n})()`);
    assert.strictEqual(w.routinesScopeAgentId(), null,
      'an agent id from the previous workspace was carried into the next one');
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
    for (const type of ['routine_deleted', 'routine_paused', 'routine_enabled']) {
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
    for (const [action, routines] of [
      ['pause', undefined],
      ['delete', undefined],
      // The offer on a routine the upgrade held back is a control like any
      // other, so it clears the last refusal like any other. It needs a row in
      // that state to exist at all, which is why this loop carries the
      // workspace as well as the press.
      ['enable', [{ ...ROUTINE, enabled: false }]],
    ]) {
      const press = (doc) => doc.querySelector(`[data-routines-action="${action}"]`).click();
      const { w, doc, dom } = shell(routines ? { routines } : {});
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
    // setNavState is cut out of app.js and run, so the mapping under test is
    // the one the page ships rather than one restated here.
    const body = appPiece(/function setNavState\(nav\) \{([\s\S]*?)\n\}/, 'setNavState');
    w.eval(`function setNavState(nav) {${body}\n}`);
    for (const entry of doc.querySelectorAll('.nav-item[data-nav]')) {
      const nav = entry.getAttribute('data-nav');
      w.setNavState(nav);
      assert.strictEqual(entry.classList.contains('active'), true, `${nav} did not become the active entry`);
      // BY ITS OWN NAME, and that is the half that changed. A section used to
      // be able to reveal another section's panel through an alias map, which
      // is how the routines panel came to be a child of the team one: revealed
      // by name, nested out of sight, and green.
      const panel = doc.getElementById(`sidebar-${nav}`);
      assert.ok(panel, `${nav} reveals no sidebar panel of its own`);
      for (let el = panel; el; el = el.parentElement) {
        assert.ok(!el.classList.contains('hidden'),
          `${nav} reveals a panel that stays out of sight inside #${el.id || el.tagName}`);
      }
      // AND EVERY OTHER PANEL IS PUT AWAY. Revealing is only half of what the
      // router does, and the half that is easy to leave out: a panel the
      // router never hides is a panel that stacks under the next one, which is
      // what a panel newly lifted out of another panel is one edit away from.
      for (const other of doc.querySelectorAll('.sidebar > div[id^="sidebar-"]')) {
        if (other.id === `sidebar-${nav}`) continue;
        assert.ok(other.classList.contains('hidden'),
          `${nav} left #${other.id} on screen beside the panel it revealed`);
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
