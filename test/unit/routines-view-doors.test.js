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
  {
    file: 'app.js',
    line: "else if(nav==='routines')",
    surface: 'the Routines entry on the nav rail',
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
    for (const entry of [...RENDERERS, ...ROUTES, ...REPLIES]) {
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
        assert.ok(/routine-editor\.js$/.test(rel),
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
  // check below unfalsifiable: the editor resolves where a save goes by
  // asking whether the shell has BOTH a rail entry called routines and a panel
  // called sidebar-routines, and a test that supplies that panel itself
  // answers its own question. Rename the panel in index.html and the editor
  // silently starts landing saves on the team chart, with this file green.
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

describe('the ways this list gets drawn, pressed', () => {
  test('the roster arriving from the server draws the list', () => {
    const { w, dom } = shell();
    const body = appPiece(/case 'agents':([\s\S]*?)\bbreak;/, 'the roster case of the client dispatch');
    w.drawn = 0;
    const realRender = w.renderRoutines;
    w.renderRoutines = () => { w.drawn++; realRender(); };
    for (const name of ['renderAgentList', 'renderOrgChart', 'renderRoutinesSidebar', 'renderConvoList']) {
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
    w.shown = null;
    w.showView = (v) => { w.shown = v; };
    w.drawn = 0;
    const realRender = w.renderRoutines;
    w.renderRoutines = () => { w.drawn++; realRender(); };
    w.closeFindBar = () => {};
    w.setNavState = () => {};
    w.switchNav = (nav) => {
      assert.strictEqual(nav, 'routines', 'the rail entry asks for another section');
      w.eval(`(function () {${body}\n})()`);
    };
    entry.click();
    assert.strictEqual(w.shown, 'routines', 'the rail entry does not show this view');
    assert.strictEqual(w.drawn, 1, 'the rail entry shows the view without drawing anything into it');
    assert.strictEqual(doc.querySelectorAll('.routine-row').length, 1);
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

    // The three pieces that carry a reader to a section, all real.
    w.eval(`function setNavState(nav) {${appPiece(/function setNavState\(nav\) \{([\s\S]*?)\n\}/, 'setNavState')}\n}`);
    w.eval(`function showView(v) {${appPiece(/^function showView\(v\) \{(.*)\}\s*$/m, 'showView')}}`);
    w.closeFindBar = () => {};
    w.eval(`function switchNav(nav) {${appPiece(/function switchNav\(nav\) \{([\s\S]*?)\n\}/, 'switchNav')}\n}`);

    // Start somewhere else, so arriving is something the save has to do.
    w.setNavState('team');
    assert.ok(!doc.getElementById('sidebar-team').classList.contains('hidden'), 'sanity: on the team panel');

    w.addRoutine();
    const option = w.RundockRoutineEditorModel.skillChoices({ skills: w.skills }).options[0];
    w.routineEditorPick(option.key);
    w.saveRoutine();
    assert.strictEqual(w.sent.length, 1, 'sanity: the editor asked for the routine to be written');
    assert.ok(doc.getElementById('sidebar-routines').classList.contains('hidden'),
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
    assert.ok(doc.getElementById('sidebar-routines'),
      'index.html carries no routines sidebar panel, so the editor cannot reach this view');

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
  test('the roster dispatch has one writer for this panel', () => {
    const body = appPiece(/case 'agents':([\s\S]*?)\bbreak;/, 'the roster case of the client dispatch');
    assert.ok(!/(?<![.\w$])renderRoutinesSidebar\(/.test(body),
      'the roster dispatch still draws the legacy team-sidebar listing into this panel, so the '
      + 'scope list survives only by being drawn second on that line');
  });

  // The outcome, with the REAL legacy renderer loaded rather than stubbed out.
  // Stubbing it is what let the ordering dependency sit unnoticed: a no-op
  // cannot clobber anything, so the test could not tell the two orders apart.
  test('after a real roster arrives the panel holds the scope list and no legacy rows', () => {
    const { doc, w, dom } = shell();
    w.eval(TEAM_SRC);
    w.formatScheduleShort = (x) => String(x);
    w.getGuide = () => null;
    for (const name of ['renderOrgChart', 'renderConvoEmptyAgents', 'renderConvoList', 'renderAgentList']) {
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
    w.formatScheduleShort = (x) => String(x);
    w.getGuide = () => null;
    for (const name of ['renderOrgChart', 'renderConvoEmptyAgents', 'renderConvoList', 'renderAgentList']) {
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
    assert.deepStrictEqual([...new Set(found)].sort(), [...new Set(REPLIES.map(r => r.call))].sort(),
      'the client calls into this view from somewhere this file does not list, or a listed '
      + 'call no longer exists. Add the row and the test that drives it, or remove the row.');
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
  // one, which already carries a Routines section inside it. There IS an
  // element called sidebar-routines, NESTED in the team panel, so revealing it
  // by name succeeds, throws nothing, and leaves the reader looking at an
  // empty sidebar because the parent stayed hidden. So the assertion is not
  // that an element was found: it is that what was revealed can actually be
  // seen.
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
