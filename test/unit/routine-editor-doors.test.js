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
const SCOPE_MODEL_SRC = read('public', 'routines-scope-model.js');
const PANEL_SRC = read('public', 'views', 'routines-panel.js');
const SKILLS_VIEW_SRC = read('public', 'views', 'skills.js');
const APP_SRC = read('public', 'app.js');
const INDEX_SRC = read('public', 'index.html');

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
  // The door this file named as missing while the routines view did not exist.
  // It arrived with that view, this row arrived with it, and the enumeration
  // above went red in between, which is the whole point of the check.
  //
  // AND IT IS NOW THE ONLY UNSCOPED ONE. The team sidebar's Routines section
  // carried a second, and went with the listing it sat under. A door removed
  // is a row removed, on the same rule that a door added is a row added.
  {
    call: 'addRoutine',
    file: 'views/routines.js',
    surface: 'the Add control in the routines view empty state',
    scoped: false,
    pressedBy: 'the empty state door opens the editor across the whole team',
  },
  // The fourth door, and the only one whose scope is decided by something the
  // reader did on another surface. It arrived with the routines panel, and it
  // is the door that matters most now that the profile stops offering Add
  // routine once an agent has one.
  {
    call: 'addRoutineForAgent',
    file: 'views/routines-panel.js',
    surface: 'the plus in the routines panel header, which inherits the scope',
    scoped: true,
    pressedBy: 'the panel door opens the editor on whatever the panel is scoped to',
  },
  // The fifth door, and the only one that starts from the SKILL rather than
  // from an agent, a list or a panel. It lands on the schedule step only when
  // exactly one agent has the skill; a skill two agents share opens a picker
  // scoped to that skill, asking only which agent, and a skill nobody has
  // offers no door at all, both pressed by their own tests below.
  {
    call: 'addRoutineForSkill',
    file: 'views/skills.js',
    surface: 'the Schedule this skill control on a skill\'s own page',
    scoped: 'only when exactly one agent has the skill',
    pressedBy: 'the skill door opens the editor at the schedule step for that skill',
  },
  // The sixth door, and the only one that opens onto a routine that ALREADY
  // EXISTS. Every door above starts a routine; this one changes when one runs.
  // It is scoped by construction rather than by choice: it names the routine it
  // was pressed on, so the agent comes with it and there is nothing to pick.
  {
    call: 'editRoutineSchedule',
    file: 'views/routines.js',
    surface: 'the Edit schedule control on a routine row',
    scoped: 'by the routine it is pressed on',
    pressedBy: 'the edit door opens the editor on the routine it was pressed on',
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
const ENTRY_CALLS = ['addRoutine', 'addRoutineForAgent', 'addRoutineForSkill', 'editRoutineSchedule', 'openRoutineEditor'];

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

// THE SHELL IS CUT OUT OF index.html, and that is a correction rather than
// tidiness. It used to be written here, and what it wrote was the arrangement
// this pass has just reversed: a routines panel NESTED inside the team panel.
// Every door below opens onto the shell, and the editor decides where a save
// leaves to by asking that shell what it has, so a hand-written copy of the
// page is a proof that agrees with itself after the page has moved on. That is
// the exact defect an earlier card found on this suite: a test supplying the
// very panel whose existence it was checking.
function shellMarkup() {
  const rail = /<nav class="nav-rail"[\s\S]*?<\/nav>/.exec(INDEX_SRC);
  assert.ok(rail, 'index.html no longer carries a nav rail');
  const sidebar = /<aside class="sidebar"[\s\S]*?<\/aside>/.exec(INDEX_SRC);
  assert.ok(sidebar, 'index.html no longer carries a sidebar');
  return '<!doctype html><html><body>' + rail[0] + sidebar[0]
    + '<div id="profile-content"></div>'
    + '<div id="view-routine-editor"><div id="routine-editor-content"></div></div>'
    + '<div id="view-routines"><div id="routines-content"></div></div>'
    + '<div id="view-skills"><div id="skill-detail-content"></div></div>'
    + '</body></html>';
}

function shell() {
  const dom = new JSDOM(shellMarkup(), { runScripts: 'dangerously' });
  const w = dom.window;
  w.eval(MODEL_SRC);
  w.eval(VIEW_SRC);
  w.eval(PROFILE_SRC);
  w.eval(TEAM_SRC);
  w.eval(SKILLS_MODEL_SRC);
  w.eval(ROUTINES_MODEL_SRC);
  w.eval(SCOPE_MODEL_SRC);
  w.eval(ROUTINES_SRC);
  w.eval(PANEL_SRC);
  w.eval(SKILLS_VIEW_SRC);

  w.agents = [
    {
      id: 'piper', displayName: 'Piper', role: 'Ops summaries', colour: '#E87A5A',
      icon: 'P', status: 'active', runtime: 'claude',
      routines: [{ name: 'Existing routine', schedule: 'every day at 08:00' }],
    },
    { id: 'doc', displayName: 'Doc', colour: '#6BC67E', icon: 'D', status: 'active', runtime: 'claude' },
  ];
  w.conversations = [];
  w.currentSkillId = null;
  w.currentView = 'skills';
  w.skills = [
    { id: 'ops-summary', slug: 'ops-summary', name: 'Compile the ops summary',
      assignedAgents: [{ id: 'piper', name: 'Piper' }] },
    { id: 'reading-digest', slug: 'reading-digest', name: 'Refresh the reading digest',
      assignedAgents: [{ id: 'doc', name: 'Doc' }] },
  ];
  w.skillsLoaded = true;
  w.esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  w.formatTimeAgo = () => 'a while ago';
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

// The unscoped door, opened the way a reader opens it: on a workspace with
// nothing scheduled, from the routines view's own empty state. There is one
// unscoped door now, so every walk that used to start at the sidebar starts
// here, and none of them starts by calling the entry function.
function pressUnscopedDoor(doc, w) {
  w.agents = w.agents.map(a => ({ ...a, routines: [] }));
  w.renderRoutines();
  return press(doc, '[data-routines-action="add"]');
}

// The scoped door, opened the way a reader opens it: from the agent's own
// profile. It is also the ONLY door into the editor's zero-skills state, since
// the routines view answers a workspace with no skills with an offer to build
// one rather than with an offer to schedule one.
// THE AGENT'S ROUTINES ARE CLEARED FIRST, and that is the door's condition
// rather than a convenience. The offer is feature discovery: it teaches that
// routines exist, in the one place where an agent with no schedule is being
// looked at, and it goes once that agent has one. So the state this door
// exists in is the state it is pressed in.
function pressScopedDoor(doc, dom, agentId) {
  const w = dom.window;
  w.agents = w.agents.map(a => (a.id === agentId ? { ...a, routines: [] } : a));
  w.showProfile = w.RundockProfileView.showProfile;
  w.showProfile(agentId);
  return press(doc, '[data-profile-action="add-routine"]');
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
    pressScopedDoor(doc, dom, 'piper');
    assert.match(editorText(doc), /Pick a skill Piper already has/);
    assert.deepStrictEqual(
      [...doc.querySelectorAll('[data-skill-key]')].map(r => r.getAttribute('data-skill-key')),
      ['ops-summary:piper'],
      'the scoped door offers that agent\'s skills and no others',
    );
    dom.window.close();
  });

  // THE DOOR WHOSE SCOPE COMES FROM SOMEWHERE ELSE, pressed from both sides of
  // that scope. A plus that opened the agent-agnostic picker while the panel
  // beside it read "Piper" would be the only Add routine control left on a
  // workspace where every agent already has one, pointing at the wrong agent.
  test('the panel door opens the editor on whatever the panel is scoped to', () => {
    const { doc, w, dom } = shell();
    w.agents[1].routines = [{ name: 'Doc\'s routine', schedule: 'every day at 09:00' }];
    w.renderRoutinesPanel();

    press(doc, '#routines-add-btn');
    assert.match(editorText(doc), /Pick a skill any of your agents already has/,
      'the plus on All scoped the editor to an agent nobody had chosen');

    press(doc, '[data-scope="piper"]');
    press(doc, '#routines-add-btn');
    assert.match(editorText(doc), /Pick a skill Piper already has/,
      'the plus did not inherit the scope the panel is on');
    assert.deepStrictEqual(
      [...doc.querySelectorAll('[data-skill-key]')].map(r => r.getAttribute('data-skill-key')),
      ['ops-summary:piper'],
      'the scoped plus offers that agent\'s skills and no others',
    );
    dom.window.close();
  });

  // The unscoped door, and now the only one. A workspace that has never
  // scheduled anything reaches the editor through this control or through an
  // agent's own profile, and through nothing else.
  test('the empty state door opens the editor across the whole team', () => {
    const { doc, w, dom } = shell();
    pressUnscopedDoor(doc, w);
    assert.match(editorText(doc), /Pick a skill any of your agents already has/);
    assert.deepStrictEqual(
      [...doc.querySelectorAll('[data-skill-key]')].map(r => r.getAttribute('data-skill-key')),
      ['ops-summary:piper', 'reading-digest:doc'],
      'the empty state door offers every agent\'s skills',
    );
    assert.match(editorText(doc), /Piper/);
    assert.match(editorText(doc), /Doc/);
    dom.window.close();
  });

  // The team sidebar's Routines section is gone, and with it the Add control
  // that hung off its divider. Pinned here rather than assumed, because the
  // walks below no longer touch that panel at all and would not notice it
  // coming back.
  //
  // THE DOOR THAT STARTS FROM A SKILL.
  //
  // A skill page is where somebody decides they trust a skill, which is the
  // moment they want it on a schedule. Pressed here, never called: the whole
  // reason this file exists is that calling the handler is what let four
  // entry points look covered while nothing touched their controls.
  test('the skill door opens the editor at the schedule step for that skill', () => {
    const { doc, w, dom } = shell();
    w.selectSkill = w.RundockSkillsView.selectSkill;
    w.selectSkill('ops-summary');

    // SECONDARY WEIGHT IS PART OF WHAT THIS CONTROL IS, so it is asserted
    // rather than left to the eye. Promoting it to the primary button would
    // otherwise keep every test green.
    const control = doc.querySelector('[data-skills-action="schedule-skill"]');
    assert.ok(control.classList.contains('settings-btn'),
      'the control carries the secondary button class');
    assert.ok(!control.classList.contains('settings-btn-primary'),
      'the routines surface is the primary way in; this one is the shortcut, not a rival front door');

    press(doc, '[data-skills-action="schedule-skill"]');

    // Step one is already done, so the editor opens on step two with the
    // skill named in the sentence rather than on a list of one.
    assert.ok(doc.querySelector('select[data-routine-field="frequency"]'),
      'the skill door lands on the schedule step, not on the picker');
    assert.match(editorText(doc), /Compile the ops summary/);
    assert.strictEqual(doc.querySelector('[data-skill-key]'), null,
      'nothing is left to pick, so no picker is drawn');

    // And the agent is the one that has it, carried all the way to the save
    // rather than asserted off internal state.
    choose(doc, w, 'frequency', 'day');
    choose(doc, w, 'time', '09:00');
    press(doc, '.re-actions .settings-btn-primary');
    press(doc, '[data-routine-editor="save"]');
    assert.strictEqual(w.sent.length, 1);
    assert.strictEqual(w.sent[0].agentId, 'piper',
      'one agent has this skill, so no choice was needed and none was invented');
    assert.strictEqual(w.sent[0].routine.skill, 'ops-summary');
    dom.window.close();
  });

  // A skill can be assigned to more than one agent. Taking the first is a
  // guess wearing the shape of a decision, so the ambiguous case opens the
  // picker scoped to the pressed skill and lets the reader say which agent.
  // It keeps what the reader already decided: the skill stays chosen, the
  // only rows offered are its agents, and none of them is selected for them.
  test('a skill two agents share keeps the skill and asks only which agent', () => {
    const { doc, w, dom } = shell();
    // The pressed skill is deliberately NOT first in the workspace list, so
    // the ordering assertion below can fail. With it first the assertion would
    // hold whether or not anything ordered it.
    w.skills = [
      { id: 'reading-digest', slug: 'reading-digest', name: 'Refresh the reading digest',
        assignedAgents: [{ id: 'doc', name: 'Doc' }] },
      { id: 'ops-summary', slug: 'ops-summary', name: 'Compile the ops summary',
        assignedAgents: [{ id: 'piper', name: 'Piper' }, { id: 'doc', name: 'Doc' }] },
    ];
    w.selectSkill = w.RundockSkillsView.selectSkill;
    w.selectSkill('ops-summary');

    press(doc, '[data-skills-action="schedule-skill"]');

    // Not the schedule step: the agent has not been decided, so nothing is
    // shown as decided.
    assert.strictEqual(doc.querySelector('select[data-routine-field="frequency"]'), null,
      'an ambiguous skill must not land on the schedule step, which would mean an agent was chosen');
    // The lead asks the one question that is open. The reader chose the skill
    // by pressing its control; asking them to pick a skill again would ask a
    // question they just answered.
    assert.match(editorText(doc), /Pick which agent runs Compile the ops summary/,
      'the lead names the pressed skill and asks only which agent runs it');
    // The picker keeps the skill and offers only the agent choice: one row per
    // agent that has the pressed skill, and no other skill, because every
    // other skill is a choice the reader already declined by pressing this
    // one.
    assert.deepStrictEqual(
      [...doc.querySelectorAll('[data-skill-key]')].map(r => r.getAttribute('data-skill-key')),
      ['ops-summary:piper', 'ops-summary:doc'],
      'one row per agent that has the pressed skill, and nothing else on offer',
    );
    assert.strictEqual(doc.querySelector('.re-row.sel'), null,
      'nothing is preselected, because preselecting one of two agents is the guess this avoids');

    // The reader resolves it, and the agent they chose is the one that is saved.
    press(doc, '[data-skill-key="ops-summary:doc"]');
    press(doc, '.re-actions .settings-btn-primary');
    choose(doc, w, 'frequency', 'day');
    press(doc, '.re-actions .settings-btn-primary');
    press(doc, '[data-routine-editor="save"]');
    assert.strictEqual(w.sent[0].agentId, 'doc');
    dom.window.close();
  });

  // The case that made this control lie. A routine runs a skill AS an agent,
  // and the picker is built by walking each skill's assigned agents, so a
  // skill nobody has produces no row and can never be reached through it.
  // Pressing the control on such a skill used to land the reader on an offer
  // to build a skill, while they were looking at one, or on a list of every
  // other skill with the one they pressed missing.
  test('a skill no agent has offers no way to schedule it', () => {
    const { doc, w, dom } = shell();
    w.skills = [
      { id: 'unclaimed', slug: 'unclaimed', name: 'Nobody has this one', assignedAgents: [] },
      { id: 'ops-summary', slug: 'ops-summary', name: 'Compile the ops summary',
        assignedAgents: [{ id: 'piper', name: 'Piper' }] },
    ];
    w.selectSkill = w.RundockSkillsView.selectSkill;
    w.selectSkill('unclaimed');

    assert.strictEqual(doc.querySelector('[data-skills-action="schedule-skill"]'), null,
      'a control that cannot lead where its label says must not be on the page at all');

    // And the page still says what to do instead, which is to give it an agent.
    assert.match(doc.getElementById('skill-detail-content').textContent,
      /Want to assign this to a specific agent\?/,
      'the step this reader actually needs is still offered');

    // The control returns as soon as an agent has it, so this is a guard on
    // the state rather than the control having been dropped.
    w.selectSkill('ops-summary');
    assert.ok(doc.querySelector('[data-skills-action="schedule-skill"]'),
      'a skill an agent has still offers the way in');
    dom.window.close();
  });

  // The section itself, by its own label, rather than the whole page's text:
  // a change that dropped the section and appended its reason to the Used by
  // card instead would still pass a whole-page substring check, which is the
  // vanished-section state this test exists to catch.
  //
  // "Routine" OR "Routines", NOT "Schedule". The design review pass renamed
  // this heading to name the thing the box holds (a single routine, in the
  // case every fixture here builds) rather than the feature; it pluralises
  // only where the box is actually about to list more than one. Matched by
  // pattern rather than a fixed string so this helper does not have to be
  // read as endorsing one spelling over the other.
  function scheduleSection(doc) {
    const label = Array.from(doc.querySelectorAll('#skill-detail-content .profile-section-label'))
      .find(el => /^Routines?$/.test(el.textContent.trim()));
    return label ? label.closest('.profile-card-section') : null;
  }

  // The control used to vanish with nothing under its own heading. Both
  // shapes of the skill page are driven here, side by side, so the difference
  // between them is a diff a reader can check: one carries the control, the
  // other carries the reason the control is missing, and neither is silent.
  test('a skill page with no agent states why it cannot be scheduled, unlike a skill page with one', () => {
    const { doc, w, dom } = shell();
    w.skills = [
      { id: 'unclaimed', slug: 'unclaimed', name: 'Nobody has this one', assignedAgents: [] },
      { id: 'ops-summary', slug: 'ops-summary', name: 'Compile the ops summary',
        assignedAgents: [{ id: 'piper', name: 'Piper' }] },
    ];
    w.selectSkill = w.RundockSkillsView.selectSkill;

    w.selectSkill('unclaimed');
    const unclaimedSchedule = scheduleSection(doc);
    assert.ok(unclaimedSchedule, 'no Schedule section on the page for a skill with no agent');
    assert.ok(unclaimedSchedule.textContent.includes(w.RundockRoutineEditorModel.UNASSIGNED_REASON),
      `the Schedule section does not say why it cannot be scheduled: ${unclaimedSchedule.textContent}`);
    assert.strictEqual(unclaimedSchedule.querySelector('[data-skills-action="schedule-skill"]'), null,
      'a control that cannot lead where its label says is still on the page');

    w.selectSkill('ops-summary');
    const assignedSchedule = scheduleSection(doc);
    assert.ok(assignedSchedule, 'no Schedule section on the page for a skill with an agent');
    assert.ok(assignedSchedule.querySelector('[data-skills-action="schedule-skill"]'),
      'a skill an agent has lost its way in to schedule it');
    assert.ok(!assignedSchedule.textContent.includes(w.RundockRoutineEditorModel.UNASSIGNED_REASON),
      'a skill an agent has carries a reason for an absence that is not true of it');
    dom.window.close();
  });

  // SAME SHAPE AS THE AGENT PROFILE'S ROUTINES CARD: once a routine exists
  // for this skill, the control that offers to make one is redundant and
  // goes, replaced by the routine itself, the same way the profile page's
  // Routines card stops offering "Add routine" once the agent has one.
  test('a skill already scheduled shows the routine instead of the button', () => {
    const { doc, w, dom } = shell();
    // The default fixture gives piper a routine with no `skill` field, which
    // must not match anything; this scopes one to ops-summary specifically.
    w.agents[0].routines = [
      { name: 'Existing routine', schedule: 'every day at 08:00', skill: 'unrelated-skill' },
      { name: 'Compile the ops summary daily', schedule: 'every day at 09:00', skill: 'ops-summary' },
    ];
    w.skills = [
      { id: 'ops-summary', slug: 'ops-summary', name: 'Compile the ops summary',
        assignedAgents: [{ id: 'piper', name: 'Piper' }] },
    ];
    w.selectSkill = w.RundockSkillsView.selectSkill;
    w.selectSkill('ops-summary');

    const section = scheduleSection(doc);
    assert.ok(section, 'no Schedule section on the page for a scheduled skill');
    assert.strictEqual(section.querySelector('[data-skills-action="schedule-skill"]'), null,
      'the button stayed up beside the routine it duplicates');
    assert.match(section.textContent, /Compile the ops summary daily/,
      'the routine that exists for this skill is not shown');
    assert.doesNotMatch(section.textContent, /Existing routine/,
      'a routine scheduling a different skill leaked into this one\'s Schedule card');

    // Pressing the routine is wired to the same handler the agent profile's
    // own routine rows use, scoped to the agent that owns it.
    const row = section.querySelector('[data-agent-id]');
    assert.strictEqual(row.getAttribute('onclick'), 'showRoutinesForAgent(this.dataset.agentId)',
      'the routine row does not use the same destination the profile page\'s routine rows do');
    assert.strictEqual(row.dataset.agentId, 'piper');
    dom.window.close();
  });

  // The Used by card, directly above Schedule on the same page, already says
  // an unassigned skill is available to all agents. The Schedule card's
  // reason must not deny that in the same breath: a page that both offers a
  // skill to every agent and states nobody has it is contradicting itself,
  // which is exactly what AC-5 forbids, and it does not matter that the
  // string came from one shared constant if that constant disagrees with
  // the card sitting above it.
  test('the Used by card and the Schedule card do not contradict each other on an unassigned skill\'s page', () => {
    const { doc, w, dom } = shell();
    // Named to hold no false match for the phrases this test checks are
    // absent: 'unclaimed' elsewhere in the packet names its skill 'Nobody
    // has this one', which would make the skill's own display name the
    // thing this assertion caught rather than any claim the page makes.
    w.skills = [{ id: 'unclaimed', slug: 'unclaimed', name: 'Orphan skill', assignedAgents: [] }];
    w.selectSkill = w.RundockSkillsView.selectSkill;
    w.selectSkill('unclaimed');
    const page = doc.getElementById('skill-detail-content').textContent;

    assert.match(page, /Available to all agents/, 'sanity: the Used by card renders what this test compares against');
    assert.ok(!/nobody has/i.test(page), 'the page states nobody has the skill against its own Used by card');
    assert.ok(!/no agent has/i.test(page), 'the page states no agent has the skill against its own Used by card');
    dom.window.close();
  });

  // The breadcrumb belongs to the door that opened the editor, and this door
  // came from a skill. A control reading "Back to Piper" here would be the
  // exact fault the agent breadcrumb was written to stop: a label that names
  // a destination the press does not go to.
  test('the skill door\'s breadcrumb returns to the skill, not to the agent', () => {
    const { doc, w, dom } = shell();
    w.selectSkill = w.RundockSkillsView.selectSkill;
    w.selectSkill('ops-summary');
    press(doc, '[data-skills-action="schedule-skill"]');

    const back = doc.querySelector('[data-routine-editor="back"]');
    assert.ok(back, 'the skill door renders a breadcrumb');
    assert.match(back.textContent, /Compile the ops summary/,
      'the label names the skill the editor was opened from');

    w.currentSkillId = null;
    press(doc, '[data-routine-editor="back"]');
    assert.strictEqual(w.currentSkillId, 'ops-summary', 'and the press goes where the label says');
    assert.strictEqual(w.navigatedTo, null);
    dom.window.close();
  });

  // THE DEAD END, and it is reachable without doing anything unusual. The
  // skill list is replaced whenever a skill is saved in the background or the
  // workspace changes, and the editor can be open across either. Leaving by
  // the breadcrumb then called selectSkill for a skill that is no longer in
  // the list, which returns doing nothing, while state had already been
  // nulled. Every control in the editor answers nothing from that moment, and
  // the rail is the only way out.
  test('the skill breadcrumb still leaves when the skill has gone from the list', () => {
    const { doc, w, dom } = shell();
    w.selectSkill = w.RundockSkillsView.selectSkill;
    w.selectSkill('ops-summary');
    press(doc, '[data-skills-action="schedule-skill"]');

    // The workspace changed under the open editor.
    w.skills = [];
    w.currentSkillId = null;
    w.profileShown = null;

    press(doc, '[data-routine-editor="back"]');

    // This door carried an agent, so that is the nearest place the reader
    // meant to be.
    assert.strictEqual(w.currentSkillId, null, 'the skill page cannot be opened, so it was not');
    assert.strictEqual(w.profileShown, 'piper',
      'the press must still land somewhere rather than leaving a dead editor on screen');
    dom.window.close();
  });

  test('a skill door carrying no agent falls through to the routines list', () => {
    const { doc, w, dom } = shell();
    // Two agents have it, so the door carries no agent to fall back to.
    w.skills = [
      { id: 'ops-summary', slug: 'ops-summary', name: 'Compile the ops summary',
        assignedAgents: [{ id: 'piper', name: 'Piper' }, { id: 'doc', name: 'Doc' }] },
    ];
    w.selectSkill = w.RundockSkillsView.selectSkill;
    w.selectSkill('ops-summary');
    press(doc, '[data-skills-action="schedule-skill"]');

    w.skills = [];
    w.currentSkillId = null;
    w.navigatedTo = null;

    press(doc, '[data-routine-editor="back"]');
    assert.strictEqual(w.profileShown, null, 'no agent was carried, so there is no profile to show');
    assert.strictEqual(w.navigatedTo, 'routines',
      'with no skill and no agent the reader still leaves, to the list of routines');
    dom.window.close();
  });

  // ASSERTED AGAINST THE SOURCE AND NOT AGAINST THIS FILE'S DOM. An earlier
  // version of this test looked for the control in a document nothing had
  // rendered the roster into, which is an assertion that cannot fail for the
  // reason it states: it would have passed against a sidebar that had the
  // control back. What the panel actually holds once it is drawn is proven in
  // team-sidebar.test.js, which delivers a roster through the real dispatch
  // into the real markup. What belongs HERE is the doors claim: that the view
  // renders no way in and names no way in.
  test('the team sidebar offers no way into the editor', () => {
    assert.ok(!/data-sidebar-action/.test(TEAM_SRC),
      'views/team.js renders a sidebar action again and is not a listed door');
    for (const call of ENTRY_CALLS) {
      assert.ok(!new RegExp(`(?<![.\\w$])${call}\\(`).test(TEAM_SRC),
        `views/team.js reaches the editor through ${call} and is not a listed door`);
    }
  });
});

describe('the whole journey, by pressing only', () => {
  // Not one control here is reached by calling its handler. If any rendered
  // control loses its handler, or its handler is renamed, this walk stops.
  test('a routine can be made from the profile door without calling anything', () => {
    const { doc, w, dom } = shell();
    pressScopedDoor(doc, dom, 'piper');
    press(doc, '[data-skill-key="ops-summary:piper"]');
    press(doc, '.re-actions .settings-btn-primary');

    choose(doc, w, 'frequency', 'monday');
    choose(doc, w, 'time', '07:00');
    press(doc, '[data-run-on="local"]');

    assert.match(editorText(doc), /Run Compile the ops summary every Monday at 7:00am, on this computer\./);
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

  test('the same journey from the unscoped door reaches another agent\'s skill', () => {
    const { doc, w, dom } = shell();
    pressUnscopedDoor(doc, w);
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
    pressUnscopedDoor(doc, w);
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
    pressScopedDoor(doc, dom, 'piper');
    press(doc, '[data-routine-editor="create-skill"]');
    assert.strictEqual(talkedTo, 'doc', 'the offer reaches the agent that builds skills');
    dom.window.close();
  });

  // The breadcrumb, pressed, from the door that renders one.
  test('the breadcrumb returns to the profile the editor was opened from', () => {
    const { doc, w, dom } = shell();
    pressScopedDoor(doc, dom, 'piper');
    w.showProfile = (id) => { w.profileShown = id; };
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

    pressUnscopedDoor(doc, w);
    states.push(doc.getElementById('routine-editor-content').innerHTML);
    press(doc, '[data-skill-key="ops-summary:piper"]');
    press(doc, '.re-actions .settings-btn-primary');
    states.push(doc.getElementById('routine-editor-content').innerHTML);
    press(doc, '.re-actions .settings-btn-primary');
    states.push(doc.getElementById('routine-editor-content').innerHTML);

    const { doc: emptyDoc, w: emptyW, dom: emptyDom } = shell();
    emptyW.skills = [];
    pressScopedDoor(emptyDoc, emptyDom, 'piper');
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
    for (const [src, label] of [[PROFILE_SRC, 'views/profile.js'], [ROUTINES_SRC, 'views/routines.js']]) {
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

// ===== THE DOOR ONTO A ROUTINE THAT ALREADY EXISTS =====
//
// Every door above starts a routine. This one changes when an existing one
// runs, so what it has to carry is not a scope but an IDENTITY: the agent, the
// name, and which of that agent's routines of that name it is. A door that
// dropped the last part would open on one routine's times and save over
// another's, and the reader would have no way to tell from the screen.
//
// Pressed rather than called, like every other door here.
describe('the edit door', () => {
  test('the edit door opens the editor on the routine it was pressed on', () => {
    const { doc, w, dom } = shell();
    w.renderRoutines();

    const control = press(doc, '.routine-row [data-routines-action="edit"]');
    assert.strictEqual(control.getAttribute('aria-label'), 'Edit schedule',
      'the control says what it opens, since a pencil on a row could mean renaming it');

    // Step one is not behind this door: the skill was chosen when the routine
    // was made and is not being chosen again.
    assert.ok(doc.querySelector('select[data-routine-field="frequency"]'),
      'the edit door lands on the schedule step, not on the picker');
    assert.strictEqual(doc.querySelector('[data-skill-key]'), null,
      'nothing is left to pick, so no picker is drawn');

    // AC-2, read off the rendered controls rather than off internal state: a
    // select asked to show a value it does not have shows its first one
    // instead, which is the failure this has to be able to see. The shell's
    // routine runs at 08:00, which is not the editor's own default.
    assert.strictEqual(doc.querySelector('select[data-routine-field="frequency"]').value, 'day');
    assert.strictEqual(doc.querySelector('select[data-routine-field="time"]').value, '08:00');
    assert.match(editorText(doc), /Existing routine/, 'and it names the routine being changed');

    // And the identity travels all the way to the message, rather than being
    // asserted off state the reader cannot see.
    choose(doc, w, 'time', '16:00');
    press(doc, '.re-actions .settings-btn-primary');
    press(doc, '[data-routine-editor="save"]');
    assert.deepStrictEqual(w.sent, [{
      type: 'set_routine_schedule',
      agentId: 'piper',
      name: 'Existing routine',
      occurrence: 0,
      schedule: 'every day at 16:00',
    }]);
    dom.window.close();
  });

  // Nothing makes a routine name unique within a file, and the writer counts
  // namesakes on purpose so a second can be made through this interface. The
  // row the reader pressed is the routine that moves.
  test('pressing the second routine of a name edits that one, not the first', () => {
    const { doc, w, dom } = shell();
    w.agents = w.agents.map(a => (a.id === 'piper' ? {
      ...a,
      routines: [
        { name: 'Twin', schedule: 'every day at 07:00' },
        { name: 'Twin', schedule: 'every day at 18:00' },
      ],
    } : a));
    w.renderRoutines();

    // The rows are ordered by next run rather than by file position, so the
    // one carrying 18:00 is found by what it shows rather than by its index.
    const rows = [...doc.querySelectorAll('.routine-row')];
    const second = rows.filter(r => /6:00pm/.test(r.textContent))[0];
    assert.ok(second, 'sanity: the later of the two namesakes is on the page');
    second.querySelector('[data-routines-action="edit"]').click();

    assert.strictEqual(doc.querySelector('select[data-routine-field="time"]').value, '18:00',
      'the editor opened on the times of the row that was pressed');
    press(doc, '.re-actions .settings-btn-primary');
    press(doc, '[data-routine-editor="save"]');
    assert.strictEqual(w.sent.length, 1);
    assert.strictEqual(w.sent[0].occurrence, 1,
      'the message names the namesake the reader pointed at');
    assert.strictEqual(w.sent[0].schedule, 'every day at 18:00');
    dom.window.close();
  });

  // A routine whose schedule this editor could not have built is exactly where
  // the control is worth most: it is a routine that fires nothing, and this is
  // the way to fix it. The door opens, and the editor accounts for the
  // difference rather than the row hiding the way in.
  test('a routine on a schedule the picker cannot show still opens, and says so', () => {
    const { doc, w, dom } = shell();
    w.agents = w.agents.map(a => (a.id === 'piper'
      ? { ...a, routines: [{ name: 'Hand written', schedule: 'every fortnight at 07:00' }] }
      : a));
    w.renderRoutines();
    press(doc, '.routine-row [data-routines-action="edit"]');

    const note = doc.querySelector('[data-routine-editor="stored-schedule"]');
    assert.ok(note, 'the editor accounts for a schedule its controls cannot show');
    assert.match(note.textContent, /every fortnight at 07:00/,
      'and names the stored one rather than describing it');

    // NOTHING IS PRE-FILLED FROM IT, not even the half a pattern would have
    // recognised. A cadence of "fortnight" and a time of 07:00 split apart
    // cleanly, and a door that handed those over would put 07:00 on the time
    // control while the frequency control silently showed its first option: a
    // schedule the reader never set, wearing the authority of their own.
    assert.strictEqual(doc.querySelector('select[data-routine-field="time"]').value, '09:00',
      'the stored time is not one half of a schedule this editor can build, so it is not shown as one');
    assert.strictEqual(doc.querySelector('select[data-routine-field="frequency"]').value, 'day');
    dom.window.close();
  });
});

// The Schedule card on an unassigned skill's page reads
// `routineEditorModel().UNASSIGNED_REASON` with no null guard, matching how
// `renderSkillsEmpty` reads `skillsModel()` elsewhere in the same file: a
// missing model fails loudly rather than the page quietly keeping stale
// content, which is what a guarded call would have done instead. The comment
// beside that call asserts index.html loads routine-editor-model.js before
// views/skills.js. A comment cannot fail, so this pins the order itself, cut
// out of the real page the way every shell above cuts its markup: a
// reordering fails here BY NAME, rather than as an uncaught exception on the
// one page a reader would meet it, an unassigned skill's own.
describe('the script order the unguarded model read depends on', () => {
  test('index.html loads routine-editor-model.js before views/skills.js', () => {
    const editorModelAt = INDEX_SRC.indexOf('<script src="/routine-editor-model.js">');
    const skillsViewAt = INDEX_SRC.indexOf('<script src="/views/skills.js">');
    assert.ok(editorModelAt !== -1, 'index.html no longer loads routine-editor-model.js');
    assert.ok(skillsViewAt !== -1, 'index.html no longer loads views/skills.js');
    assert.ok(editorModelAt < skillsViewAt,
      'views/skills.js now loads before routine-editor-model.js, so its unguarded '
      + 'routineEditorModel().UNASSIGNED_REASON read on an unassigned skill\'s page will throw');
  });
});
