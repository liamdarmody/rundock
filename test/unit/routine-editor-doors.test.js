'use strict';
// Every way into the routine editor, enumerated and pressed.
//
// WHY THIS FILE IS A MANIFEST AND NOT A LIST OF TESTS.
//
// Four separate reviews of this editor each found a different way in with no
// test behind it: a destination resolved inside the router, a message case in
// the client dispatch, a control on an agent's profile, a control in the team
// sidebar. Each was fixed by testing the one that had been named. None of them
// asked what the next one was, so the next one arrived.
//
// The rule that ends it: an entry point is tested by the surface a user
// touches, or it is not tested. Applied to ALL of them rather than to the one
// most recently found.
//
// So this file does two things. It ENUMERATES the doors below, and it checks
// that enumeration against the source, so a door added later fails here until
// somebody lists it and says which test presses it. And it walks the whole
// journey by pressing rendered controls only, never by calling the functions
// behind them, because calling the function is exactly what let four doors go
// untested while looking covered.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf-8');
const MODEL_SRC = read('public', 'routine-editor-model.js');
// Loaded before the routines model, which reads the shared no-guide next step
// off it, in the order index.html loads them.
const SKILLS_MODEL_SRC = read('public', 'skills-model.js');
const VIEW_SRC = read('public', 'views', 'routine-editor.js');
const PROFILE_SRC = read('public', 'views', 'profile.js');
const TEAM_SRC = read('public', 'views', 'team.js');
const ROUTINES_MODEL_SRC = read('public', 'routines-model.js');
const ROUTINES_SRC = read('public', 'views', 'routines.js');
const APP_SRC = read('public', 'app.js');

// ===== THE ENUMERATION =====
//
// Every call into the editor from anywhere in the client, with the surface it
// belongs to and the test that presses that surface. Adding a way in means
// adding a row here, which means naming the test.
const DOORS = [
  {
    call: 'addRoutineForAgent',
    file: 'views/profile.js',
    surface: 'the Add routine control on an agent profile',
    scoped: true,
    pressedBy: 'the profile door opens the editor scoped to that agent',
  },
  {
    call: 'addRoutine',
    file: 'views/team.js',
    surface: 'the Add control in the sidebar Routines section',
    scoped: false,
    pressedBy: 'the sidebar door opens the editor across the whole team',
  },
  // The door this file named as missing while the routines view did not exist.
  // It arrived with that view, this row arrived with it, and the enumeration
  // above went red in between, which is the whole point of the check.
  {
    call: 'addRoutine',
    file: 'views/routines.js',
    surface: 'the Add control in the routines view empty state',
    scoped: false,
    pressedBy: 'the empty state door opens the editor across the whole team',
  },
];

// Doors that exist in the flow but are deliberately not pressed here, each
// with the reason. A named exclusion is a decision; an unnamed one is how this
// went round four times.
const NOT_PRESSED = [
  {
    what: 'a keyboard or command-palette route',
    why: 'there is none. The palette indexes files, conversations, agents and skills, not routines. '
      + 'Asserted below rather than asserted by me.',
  },
];

// Where the client can call into the editor from. Everything the editor
// exports that OPENS it; the rest of its surface is reached from inside.
const ENTRY_CALLS = ['addRoutine', 'addRoutineForAgent', 'openRoutineEditor'];

function clientFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.name === 'vendor') continue;
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith('.js') && rel !== 'public/views/routine-editor.js') out.push(rel);
    }
  };
  walk('public');
  return out;
}

describe('every door into the editor is enumerated', () => {
  // THE CHECK THAT ENDS THE LOOP. A new way in fails here, by name, until it
  // is listed with the test that presses it.
  test('no way into the editor exists that this file does not name', () => {
    const found = [];
    for (const rel of clientFiles()) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
      for (const call of ENTRY_CALLS) {
        // A call, not a mention: the name followed by an opening bracket.
        const re = new RegExp(`(?<![.\\w$])${call}\\(`, 'g');
        for (const _ of src.matchAll(re)) found.push(`${call} in ${rel.replace('public/', '')}`);
      }
    }
    const named = DOORS.map(d => `${d.call} in ${d.file}`);
    assert.deepStrictEqual(
      [...new Set(found)].sort(), [...new Set(named)].sort(),
      'a way into the editor is not listed in DOORS, or a listed one no longer exists. '
      + 'Add the row and the test that presses its surface, or remove the row.',
    );
  });

  test('every door names a test, and every named test exists', () => {
    const suite = fs.readFileSync(__filename, 'utf-8');
    for (const door of DOORS) {
      assert.ok(door.pressedBy && door.surface, `${door.call} needs a surface and a test`);
      assert.ok(suite.includes(`test('${door.pressedBy}'`),
        `DOORS names "${door.pressedBy}" but no test in this file has that name`);
    }
  });

  test('a door left unpressed says why', () => {
    for (const excluded of NOT_PRESSED) {
      assert.ok(excluded.what && excluded.why && excluded.why.length > 40,
        'an exclusion without a reason is how this went round four times');
    }
  });

  // The second exclusion, checked rather than asserted by me.
  test('there is no command-palette route into the editor', () => {
    const palette = read('public', 'palette-model.js') + read('public', 'views', 'palette.js');
    for (const call of ENTRY_CALLS) {
      assert.ok(!new RegExp(`(?<![.\\w$])${call}\\(`).test(palette),
        `the palette reaches the editor through ${call} and is not listed as a door`);
    }
  });
});

// ===== PRESSING THEM =====

function shell() {
  const dom = new JSDOM('<!doctype html><html><body>'
    + '<button class="nav-item" data-nav="team"></button><div id="sidebar-team">'
    + '<div id="sidebar-routines"></div></div>'
    + '<div id="profile-content"></div>'
    + '<div id="view-routine-editor"><div id="routine-editor-content"></div></div>'
    + '<div id="view-routines"><div id="routines-content"></div></div>'
    + '</body></html>', { runScripts: 'dangerously' });
  const w = dom.window;
  w.eval(MODEL_SRC);
  w.eval(VIEW_SRC);
  w.eval(PROFILE_SRC);
  w.eval(TEAM_SRC);
  w.eval(SKILLS_MODEL_SRC);
  w.eval(ROUTINES_MODEL_SRC);
  w.eval(ROUTINES_SRC);

  w.agents = [
    {
      id: 'piper', displayName: 'Piper', role: 'Ops summaries', colour: '#E87A5A',
      icon: 'P', status: 'active', runtime: 'claude',
      routines: [{ name: 'Existing routine', schedule: 'every day at 08:00' }],
    },
    { id: 'doc', displayName: 'Doc', colour: '#6BC67E', icon: 'D', status: 'active', runtime: 'claude' },
  ];
  w.conversations = [];
  w.skills = [
    { id: 'ops-summary', slug: 'ops-summary', name: 'Compile the ops summary',
      assignedAgents: [{ id: 'piper', name: 'Piper' }] },
    { id: 'reading-digest', slug: 'reading-digest', name: 'Refresh the reading digest',
      assignedAgents: [{ id: 'doc', name: 'Doc' }] },
  ];
  w.skillsLoaded = true;
  w.esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  w.formatTimeAgo = () => 'a while ago';
  w.formatScheduleShort = (s) => s;
  w.getGuide = () => ({ id: 'doc' });
  w.sent = [];
  w.ws = { send: (m) => w.sent.push(JSON.parse(m)) };
  w.navigatedTo = null;
  w.switchNav = (nav) => { w.navigatedTo = nav; };
  w.profileShown = null;
  w.showProfile = (id) => { w.profileShown = id; };
  w.showView = () => {};
  w.setNavState = () => {};
  w.startConversation = () => {};
  w.addToTeam = () => {};
  w.openConversation = () => {};
  w.selectSkill = () => {};
  w.renderOrgChart = () => {};
  w.renderAgentList = () => {};
  w.Intl = { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: 'Europe/London' }) }) };
  return { w, doc: w.document, dom };
}

// Press what is on the page. Never call the handler behind it: that is the
// habit that let four doors go untested while every test stayed green.
function press(doc, selector) {
  const el = doc.querySelector(selector);
  assert.ok(el, `nothing on the page matches ${selector}`);
  el.click();
  return el;
}

function choose(doc, w, field, value) {
  const select = doc.querySelector(`select[data-routine-field="${field}"]`);
  assert.ok(select, `no ${field} control on the page`);
  select.value = value;
  assert.strictEqual(select.value, value, `${value} is not one of the offered ${field} values`);
  select.dispatchEvent(new w.Event('change'));
}

function editorText(doc) {
  return doc.getElementById('routine-editor-content').textContent.replace(/\s+/g, ' ').trim();
}

describe('the doors, pressed', () => {
  test('the profile door opens the editor scoped to that agent', () => {
    const { doc, dom } = shell();
    dom.window.showProfile = dom.window.RundockProfileView.showProfile;
    dom.window.showProfile('piper');
    press(doc, '[data-profile-action="add-routine"]');
    assert.match(editorText(doc), /Pick a skill Piper already has/);
    assert.deepStrictEqual(
      [...doc.querySelectorAll('[data-skill-key]')].map(r => r.getAttribute('data-skill-key')),
      ['ops-summary:piper'],
      'the scoped door offers that agent\'s skills and no others',
    );
    dom.window.close();
  });

  test('the sidebar door opens the editor across the whole team', () => {
    const { doc, w, dom } = shell();
    w.renderRoutinesSidebar();
    press(doc, '[data-sidebar-action="add-routine"]');
    assert.match(editorText(doc), /Pick a skill any of your agents already has/);
    assert.deepStrictEqual(
      [...doc.querySelectorAll('[data-skill-key]')].map(r => r.getAttribute('data-skill-key')),
      ['ops-summary:piper', 'reading-digest:doc'],
      'the unscoped door offers every agent\'s skills',
    );
    assert.match(editorText(doc), /Piper/);
    assert.match(editorText(doc), /Doc/);
    dom.window.close();
  });

  // The third door, and the one the sidebar cannot be: with no routines yet
  // the sidebar section is not on the page at all (pinned below), so a
  // workspace that has never scheduled anything reaches the editor through
  // this control and no other.
  test('the empty state door opens the editor across the whole team', () => {
    const { doc, w, dom } = shell();
    w.agents = w.agents.map(a => ({ ...a, routines: [] }));
    w.renderRoutines();
    press(doc, '[data-routines-action="add"]');
    assert.match(editorText(doc), /Pick a skill any of your agents already has/);
    assert.deepStrictEqual(
      [...doc.querySelectorAll('[data-skill-key]')].map(r => r.getAttribute('data-skill-key')),
      ['ops-summary:piper', 'reading-digest:doc'],
      'the empty state door offers every agent\'s skills',
    );
    dom.window.close();
  });

  // The sidebar section renders nothing until a routine exists, so the
  // unscoped door appears with the first one. Worth pinning: it is why the
  // routines view's own empty state is a door in its own right rather than a
  // duplicate of this one.
  test('the sidebar door appears with the first routine and not before', () => {
    const { doc, w, dom } = shell();
    w.agents = w.agents.map(a => ({ ...a, routines: [] }));
    w.renderRoutinesSidebar();
    assert.strictEqual(doc.querySelector('[data-sidebar-action="add-routine"]'), null,
      'no routines yet, so this section is not on the page at all');
    dom.window.close();
  });
});

describe('the whole journey, by pressing only', () => {
  // Not one control here is reached by calling its handler. If any rendered
  // control loses its handler, or its handler is renamed, this walk stops.
  test('a routine can be made from the profile door without calling anything', () => {
    const { doc, w, dom } = shell();
    dom.window.showProfile = dom.window.RundockProfileView.showProfile;
    dom.window.showProfile('piper');

    press(doc, '[data-profile-action="add-routine"]');
    press(doc, '[data-skill-key="ops-summary:piper"]');
    press(doc, '.re-actions .settings-btn-primary');

    choose(doc, w, 'frequency', 'monday');
    choose(doc, w, 'time', '07:00');
    press(doc, '[data-run-on="local"]');

    assert.match(editorText(doc), /Every Monday at 7:00am, run: Compile the ops summary, on this computer\./);
    press(doc, '.re-actions .settings-btn-primary');

    assert.match(editorText(doc), /London time\. Runs while Rundock is open here\./);
    press(doc, '[data-routine-editor="save"]');

    assert.strictEqual(w.sent.length, 1);
    assert.deepStrictEqual(w.sent[0].routine, {
      name: 'Compile the ops summary',
      schedule: 'every monday at 07:00',
      skill: 'ops-summary',
      prompt: 'Run the ops-summary skill.',
      runOn: 'local',
    });
    assert.strictEqual(w.navigatedTo, null, 'pressing save is not the same as having saved');
    dom.window.close();
  });

  test('the same journey from the sidebar door reaches another agent\'s skill', () => {
    const { doc, w, dom } = shell();
    w.renderRoutinesSidebar();
    press(doc, '[data-sidebar-action="add-routine"]');
    press(doc, '[data-skill-key="reading-digest:doc"]');
    press(doc, '.re-actions .settings-btn-primary');
    choose(doc, w, 'frequency', 'day');
    choose(doc, w, 'time', '06:30');
    press(doc, '.re-actions .settings-btn-primary');
    press(doc, '[data-routine-editor="save"]');

    assert.strictEqual(w.sent[0].agentId, 'doc', 'the unscoped door carries the agent the skill belongs to');
    assert.strictEqual(w.sent[0].routine.schedule, 'every day at 06:30');
    dom.window.close();
  });

  // The Edit link on the confirmation step is a control like any other.
  test('the confirmation step can be edited by pressing its own link', () => {
    const { doc, w, dom } = shell();
    w.renderRoutinesSidebar();
    press(doc, '[data-sidebar-action="add-routine"]');
    press(doc, '[data-skill-key="ops-summary:piper"]');
    press(doc, '.re-actions .settings-btn-primary');
    choose(doc, w, 'frequency', 'friday');
    press(doc, '.re-actions .settings-btn-primary');

    press(doc, '.re-confirm .re-link');
    assert.ok(doc.querySelector('select[data-routine-field="frequency"]'), 'Edit returns to the step that built it');
    assert.strictEqual(doc.querySelector('select[data-routine-field="frequency"]').value, 'friday',
      'and what was already chosen is still chosen');
    dom.window.close();
  });

  // The offer in the zero-skills state, pressed.
  test('the offer in an empty workspace is pressed, not called', () => {
    const { doc, w, dom } = shell();
    w.skills = [];
    let talkedTo = null;
    w.startConversation = (id) => { talkedTo = id; };
    w.renderRoutinesSidebar();
    press(doc, '[data-sidebar-action="add-routine"]');
    press(doc, '[data-routine-editor="create-skill"]');
    assert.strictEqual(talkedTo, 'doc', 'the offer reaches the agent that builds skills');
    dom.window.close();
  });

  // The breadcrumb, pressed, from the door that renders one.
  test('the breadcrumb returns to the profile the editor was opened from', () => {
    const { doc, w, dom } = shell();
    dom.window.showProfile = (id) => { w.profileShown = id; };
    w.RundockProfileView.showProfile('piper');
    press(doc, '[data-profile-action="add-routine"]');
    w.profileShown = null;
    press(doc, '[data-routine-editor="back"]');
    assert.strictEqual(w.profileShown, 'piper');
    assert.strictEqual(w.navigatedTo, null);
    dom.window.close();
  });
});

describe('every control the editor renders resolves to something', () => {
  // A handler renamed on one side and not the other produces a control that
  // silently does nothing when pressed. The walks above catch that for the
  // controls they touch; this catches it for every control in every state,
  // including states a walk does not reach.
  test('no rendered control names a handler that does not exist', () => {
    const { doc, w, dom } = shell();
    const states = [];

    w.renderRoutinesSidebar();
    press(doc, '[data-sidebar-action="add-routine"]');
    states.push(doc.getElementById('routine-editor-content').innerHTML);
    press(doc, '[data-skill-key="ops-summary:piper"]');
    press(doc, '.re-actions .settings-btn-primary');
    states.push(doc.getElementById('routine-editor-content').innerHTML);
    press(doc, '.re-actions .settings-btn-primary');
    states.push(doc.getElementById('routine-editor-content').innerHTML);

    const { doc: emptyDoc, w: emptyW, dom: emptyDom } = shell();
    emptyW.skills = [];
    emptyW.renderRoutinesSidebar();
    press(emptyDoc, '[data-sidebar-action="add-routine"]');
    states.push(emptyDoc.getElementById('routine-editor-content').innerHTML);

    const handlers = new Set();
    for (const html of states) {
      for (const m of html.matchAll(/on(?:click|change)="([a-zA-Z_$][\w$]*)\(/g)) handlers.add(m[1]);
    }
    assert.ok(handlers.size >= 6, `sanity: found only ${handlers.size} handlers across the editor's states`);
    for (const name of handlers) {
      assert.strictEqual(typeof w[name], 'function',
        `a control calls ${name}() and nothing by that name is published`);
    }
    dom.window.close();
    emptyDom.window.close();
  });

  // The same for the two doors, which live in other views and are the ones
  // that kept going untested.
  test('both doors name handlers the editor actually publishes', () => {
    const { w, dom } = shell();
    for (const [src, label] of [[PROFILE_SRC, 'views/profile.js'], [TEAM_SRC, 'views/team.js']]) {
      for (const call of ENTRY_CALLS) {
        if (!new RegExp(`(?<![.\\w$])${call}\\(`).test(src)) continue;
        assert.strictEqual(typeof w[call], 'function',
          `${label} calls ${call}() and the editor does not publish it`);
      }
    }
    // And the client dispatch's calls into the editor, for the same reason.
    for (const call of ['routineEditorSaved', 'routineEditorFailed', 'routineEditorSkillsArrived']) {
      assert.ok(new RegExp(`(?<![.\\w$])${call}\\(`).test(APP_SRC),
        `the client dispatch no longer calls ${call}()`);
      assert.strictEqual(typeof w[call], 'function', `${call} is not published`);
    }
    dom.window.close();
  });
});
