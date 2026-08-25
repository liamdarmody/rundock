'use strict';
// The routines list as a person meets it: the rail icon that gates it, the
// four rows, the empty state and the delete confirmation.
//
// PRESSED, NOT CALLED. Every control here is reached by clicking what is on
// the page. Calling the handler behind a control is what let four ways into
// the routine editor go untested while every test stayed green, and the rule
// that ended that loop applies to this view too: an entry point is tested by
// the surface a user touches, or it is not tested.
//
// The clock, the zone and every instant are constructed explicitly. Nothing
// here reads the machine it runs on, and the zone is set before the first
// require because continuous integration runs in UTC.
process.env.TZ = 'Europe/London';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf-8');
const EDITOR_MODEL_SRC = read('public', 'routine-editor-model.js');
const MODEL_SRC = read('public', 'routines-model.js');
const VIEW_SRC = read('public', 'views', 'routines.js');
const INDEX_SRC = read('public', 'index.html');
const APP_SRC = read('public', 'app.js');
const SKILLS_SRC = read('public', 'views', 'skills.js');
const SKILLS_MODEL_SRC = read('public', 'skills-model.js');
const SCOPE_MODEL_SRC = read('public', 'routines-scope-model.js');
const PANEL_SRC = read('public', 'views', 'routines-panel.js');

// Thursday 20 August 2026, twenty past nine. One routine, one agent, one
// execution target, only the outcome changing: the locked frame's own setup.
const NOW = new Date(2026, 7, 20, 9, 20);
const TODAYS_SLOT = new Date(2026, 7, 20, 7, 0);
const YESTERDAYS_SLOT = new Date(2026, 7, 19, 7, 0);
const TOMORROWS_SLOT = new Date(2026, 7, 21, 7, 0);
const iso = (d) => d.toISOString();

function routine(name, facts) {
  return {
    name, schedule: 'every day at 07:00', prompt: 'p', runOn: 'local',
    enabled: true, paused: false,
    state: null, nextRun: null, lastStart: null, lastSlot: null, missedSlot: null,
    ...facts,
  };
}

// The four rows of the locked frame.
const FOUR_ROWS = [
  routine('Ran on time', {
    state: { status: 'completed', duration: 3 }, lastStart: iso(new Date(2026, 7, 20, 7, 0, 12)),
    lastSlot: iso(TODAYS_SLOT), nextRun: iso(TOMORROWS_SLOT),
  }),
  routine('Caught up', {
    state: { status: 'completed', duration: 3 }, lastStart: iso(new Date(2026, 7, 20, 9, 14)),
    lastSlot: iso(TODAYS_SLOT), nextRun: iso(TOMORROWS_SLOT),
  }),
  routine('Missed', {
    state: { status: 'completed', duration: 3 }, lastStart: iso(new Date(2026, 7, 18, 7, 0)),
    lastSlot: iso(new Date(2026, 7, 18, 7, 0)), missedSlot: iso(YESTERDAYS_SLOT),
    nextRun: iso(TODAYS_SLOT),
  }),
  routine('Failed', {
    state: { status: 'failed', duration: 0 }, lastStart: iso(TODAYS_SLOT),
    lastSlot: iso(TODAYS_SLOT), nextRun: iso(TOMORROWS_SLOT),
  }),
];

// The shipped stylesheets, loaded into the document so that what a tone LOOKS
// like can be read off the page rather than off a table beside it.
const ROUTINES_CSS = read('public', 'styles', 'views', 'routines.css');
const TOKENS_CSS = read('public', 'styles', 'tokens.css');

// The rail, the sidebar and both view panels are CUT OUT OF index.html rather
// than written here. Whether an entry is on the rail is a claim about the
// shipped page, and a hand-built rail in this file answers that question
// itself: the page could carry an inline style withdrawing an entry and every
// assertion here would still pass.
function pageParts() {
  const rail = /<nav class="nav-rail"[\s\S]*?<\/nav>/.exec(INDEX_SRC);
  assert.ok(rail, 'index.html no longer carries a nav rail');
  const sidebar = /<aside class="sidebar"[\s\S]*?<\/aside>/.exec(INDEX_SRC);
  assert.ok(sidebar, 'index.html no longer carries a sidebar');
  const routinesPanel = /<div id="view-routines"[\s\S]*?<\/div>\s*<\/div>/.exec(INDEX_SRC);
  assert.ok(routinesPanel, 'index.html no longer carries the routines view panel');
  const skillsPanel = /<div id="view-skills"[\s\S]*?<\/div>\s*<\/div>/.exec(INDEX_SRC);
  assert.ok(skillsPanel, 'index.html no longer carries the skills view panel');
  return rail[0] + sidebar[0] + routinesPanel[0] + skillsPanel[0];
}

// A named piece of app.js, cut out and RUN against the shell, which is the
// difference between checking the words are there and checking what they do.
// The extraction asserts the piece EXISTS, so a deleted one fails here rather
// than yielding an empty body that then passes every assertion about what it
// did not do.
function appPiece(pattern, label) {
  const found = APP_SRC.match(pattern);
  assert.ok(found && found[1] && found[1].trim(), `app.js no longer carries ${label}`);
  return found[1];
}

function shell(routines = FOUR_ROWS, opts = {}) {
  const dom = new JSDOM('<!doctype html><html><head><style>' + ROUTINES_CSS + '</style></head><body>'
    + pageParts() + '</body></html>', { runScripts: 'dangerously' });
  const w = dom.window;
  w.eval(EDITOR_MODEL_SRC);
  w.eval(SKILLS_MODEL_SRC);
  w.eval(MODEL_SRC);
  w.eval(SCOPE_MODEL_SRC);
  w.eval(VIEW_SRC);
  w.eval(PANEL_SRC);
  w.eval(SKILLS_SRC);

  w.agents = [{
    id: 'piper', displayName: 'Piper', colour: '#E87A5A', icon: 'P',
    status: 'onTeam', runtime: 'claude', routines,
  }];
  // Deliberately not called Doc: getGuide matches on type and checks no name,
  // so a workspace whose platform agent is called something else is the case a
  // hard-coded name gets wrong.
  if (opts.guide) w.agents.push({ id: 'archivist', displayName: 'Wren', type: 'platform', status: 'onTeam' });
  // A workspace with a skill by default, because that is the state the locked
  // empty-state copy was written for. The variant is a property of the
  // workspace, so the tests that want the other one say so.
  w.skills = opts.skills === undefined
    ? [{ id: 'sk', name: 'Compile the ops summary', assignedAgents: [{ id: 'piper', name: 'Piper' }] }]
    : opts.skills;
  w.skillsLoaded = opts.skillsLoaded === undefined ? true : opts.skillsLoaded;
  w.getGuide = () => w.agents.filter(a => a.type === 'platform')[0];
  w.routineEditorBuildSkill = () => { w.buildSkillFrom = 'routines'; };
  w.currentSkillId = null;
  w.esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  w.sent = [];
  w.ws = { send: (msg) => w.sent.push(JSON.parse(msg)) };
  w.addRoutine = () => { w.editorOpened = 'unscoped'; };
  w.showView = () => {};
  w.setNavState = () => {};
  w.currentView = 'routines';
  // The clock and the zone, supplied rather than read off the runner.
  w.routinesNow = () => NOW;
  w.Intl = { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: 'Europe/London' }) }) };
  return { w, doc: w.document, dom };
}

function press(doc, selector) {
  const el = doc.querySelector(selector);
  assert.ok(el, `nothing on the page matches ${selector}`);
  el.click();
  return el;
}

const rows = (doc) => [...doc.querySelectorAll('.routine-row')];
const text = (el) => el.textContent.replace(/\s+/g, ' ').trim();

// The row for a named routine, rather than the row in a given position.
//
// WHY THE POSITION IS NO LONGER THE HANDLE. The list is ordered by next run,
// so a test that reaches for the third row is asserting about whichever
// routine that ordering happens to put third, and a fixture edit silently
// moves what it is checking. The name is what a criterion about the missed row
// actually means.
function rowNamed(doc, name) {
  const found = rows(doc).filter(r => text(r.querySelector('.rr-sentence')).includes(name));
  assert.strictEqual(found.length, 1, `expected exactly one row for "${name}"`);
  return found[0];
}

// EVERY PROOF ON THIS CARD THAT CALLS A RENDER RATHER THAN PRESSING THE THING
// THAT DRAWS IT, with the reason it may.
//
// WHY THIS LIST EXISTS. A test that calls renderSkills proves the pane can be
// drawn. It does not prove anything draws it when a reader presses Skills, and
// the press is the only moment a criterion about opening an entry is about.
// That gap shipped once on this card: the line the opener gained had no test
// that went through the opener, so deleting it left the suite green while the
// first press of a session opened onto nothing.
//
// The rule that follows: a proof about a pane may call the render, but a proof
// about OPENING one may not, and every caller names the pressing proof it
// leans on. An unnamed exemption is how the routine editor's doors file went
// round four times.
const CALLED_NOT_PRESSED = [
  {
    file: 'test/unit/routines-view.test.js',
    test: 'both entries are on the rail on a workspace that has neither',
    why: 'the claim is that the two renders do not touch the rail, so the render is itself the '
      + 'surface under test: pressing an entry would exercise the opener instead of the thing '
      + 'that used to withdraw it.',
    pressedBy: 'pressing an entry on an empty workspace opens onto a pane that says what it is for',
  },
  {
    file: 'test/unit/routines-view.test.js',
    test: 'nothing withdraws an entry as the workspace fills and empties',
    why: 'the same claim across four renders. Filling and emptying a workspace is done by the '
      + 'renders, and pressing between each would test the opener four times and the rule once.',
    pressedBy: 'pressing an entry on an empty workspace opens onto a pane that says what it is for',
  },
  {
    file: 'test/unit/routines-view.test.js',
    test: 'skills still in flight are not read as no skills',
    why: 'what the pane SAYS is a property of the render. That a press reaches the render, with '
      + 'the list still in flight, is the pressing proof named beside it.',
    pressedBy: 'pressing Skills before the reply lands opens onto a pane that is waiting',
  },
  {
    file: 'test/unit/skills-empty.test.js',
    test: 'a workspace with no skills gets a pane rather than a blank one',
    why: 'every test in that file is about the words on the pane, which are the render\'s. '
      + 'Restating the press in each would prove the opener eight times and the copy once.',
    pressedBy: 'pressing an entry on an empty workspace opens onto a pane that says what it is for',
  },
  {
    file: 'test/unit/skills-empty.test.js',
    test: 'the pane says it is looking rather than offering, while it is looking',
    why: 'the same, for the waiting state. The press that reaches this state, and the message '
      + 'the press sends to end it, are in the pressing proof named beside it.',
    pressedBy: 'pressing Skills before the reply lands opens onto a pane that is waiting',
  },
];

describe('what this card proves by pressing, and what it proves by calling', () => {
  test('a proof that calls rather than presses names a reason and a pressing proof', () => {
    for (const entry of CALLED_NOT_PRESSED) {
      assert.ok(entry.why && entry.why.length > 60,
        `${entry.test} calls a render with no stated reason`);
      const suite = fs.readFileSync(path.join(ROOT, entry.file), 'utf-8');
      assert.ok(suite.includes(`test('${entry.test.replace(/'/g, "\\'")}'`),
        `this file exempts "${entry.test}" but ${entry.file} has no test by that name`);
      assert.ok(fs.readFileSync(__filename, 'utf-8').includes(`test('${entry.pressedBy}'`),
        `"${entry.test}" leans on "${entry.pressedBy}" and no test here has that name`);
    }
  });

  // THE OTHER HALF OF THE RULE, and the half a list cannot enforce on its own:
  // the opener has to be reached by running the shipped one, not by a copy of
  // it written here. Both arms are cut out of app.js at the moment they are
  // pressed, which is what makes a deleted call fail rather than a stale copy
  // keep passing.
  test('the openers this card presses are the shipped ones, cut out of the client', () => {
    for (const [pattern, label] of [
      [/else if\(nav==='routines'\)\s*\{([\s\S]*?)\}/, "switchNav's routines arm"],
      [/^\s*else if\(nav==='skills'\) \{(.*)\}\s*$/m, "switchNav's skills arm"],
      [/^function showView\(v\) \{(.*)\}\s*$/m, 'showView'],
    ]) {
      assert.ok(appPiece(pattern, label).trim(), `${label} could not be cut out of app.js`);
    }
    // And each arm draws something, rather than only revealing a panel. A
    // reveal with no draw is the defect the pressing proofs above exist for.
    //
    // The Skills arm is pinned to renderSkillsIfEmpty by name rather than to
    // "something that draws", because the two calls it could make differ only
    // in what they do to a pane somebody is already looking at, and a check
    // that accepted either would accept the one that rebuilds it.
    assert.match(appPiece(/^\s*else if\(nav==='skills'\) \{(.*)\}\s*$/m, "switchNav's skills arm"),
      /(?<![.\w$])renderSkillsIfEmpty\(/, 'the Skills opener reveals a panel without drawing into it');
    // The Routines arm is pinned to the ONE DESTINATION FUNCTION rather than
    // to renderRoutines, and pinned to the argument as well. That function
    // reveals the panel, sets the rail and draws, and its argument is the
    // scope: the rail asks for the whole team, so it must pass no agent. An
    // arm that passed one would open the rail entry on a filtered list.
    assert.match(appPiece(/else if\(nav==='routines'\)\s*\{([\s\S]*?)\}/, "switchNav's routines arm"),
      /(?<![.\w$])showRoutinesForAgent\(null\)/,
      'the Routines opener reveals a panel without drawing into it, or opens it scoped');
  });
});

describe('the rail is a map of places, always the same size', () => {
  // THE RULE THE WHOLE CHANGE BUYS. The rail names what the app can do. A user
  // learns it once, so it does not change shape underneath them. What a place
  // holds is that place's own business, and an empty place says what it is
  // for.
  //
  // AND IT IS ONE RULE, NOT TWO. Routines permanent while Skills is still
  // gated is the one outcome worse than gating both: the rail would carry two
  // rules with no way for a reader to tell which surfaces are permanent.
  test('both entries are on the rail on a workspace that has neither', () => {
    const { doc, w, dom } = shell([], { skills: [] });
    w.renderRoutines();
    w.renderSkills();
    for (const nav of ['skills', 'routines']) {
      const entry = doc.querySelector(`.nav-item[data-nav="${nav}"]`);
      assert.ok(entry, `the rail carries no ${nav} entry at all`);
      assert.notStrictEqual(entry.style.display, 'none',
        `the ${nav} entry was withdrawn from a workspace that has none`);
      assert.ok(!entry.classList.contains('hidden'), `the ${nav} entry is hidden by class`);
    }
    dom.window.close();
  });

  test('nothing withdraws an entry as the workspace fills and empties', () => {
    const { doc, w, dom } = shell([], { skills: [] });
    const displays = [];
    const note = () => {
      for (const nav of ['skills', 'routines']) {
        displays.push(doc.querySelector(`.nav-item[data-nav="${nav}"]`).style.display);
      }
    };
    w.renderRoutines(); w.renderSkills(); note();
    w.agents[0].routines = [routine('First', { nextRun: iso(TOMORROWS_SLOT) })];
    w.skills = [{ id: 's', name: 'A skill', assignedAgents: [] }];
    w.renderRoutines(); w.renderSkills(); note();
    w.agents[0].routines = [];
    w.skills = [];
    w.renderRoutines(); w.renderSkills(); note();
    assert.deepStrictEqual(displays, ['', '', '', '', '', ''],
      'the rail changed size as the workspace filled or emptied');
    dom.window.close();
  });

  // The page's own markup, because an entry can be withdrawn there as easily
  // as at runtime and this was where the routines entry was withdrawn.
  test('the page ships no rail entry it has hidden', () => {
    const rail = /<nav class="nav-rail"[\s\S]*?<\/nav>/.exec(INDEX_SRC)[0];
    for (const entry of rail.match(/<button class="nav-item[^>]*>/g) || []) {
      assert.ok(!/display\s*:\s*none/.test(entry), `index.html ships a hidden rail entry: ${entry}`);
    }
  });

  // THE HELPER IS DELETED, NOT LEFT WITH ONE CALLER OR NONE. A rule with no
  // callers is a rule the next person reinstates by finding it and assuming it
  // was meant.
  test('the gate is gone rather than left enforcing a rule nothing asks for', () => {
    assert.strictEqual(fs.existsSync(path.join(ROOT, 'public', 'rail-presence.js')), false,
      'the shared gate is still in the tree');
    assert.ok(!/rail-presence\.js/.test(INDEX_SRC), 'index.html still loads the shared gate');
    for (const [src, label] of [[VIEW_SRC, 'views/routines.js'], [SKILLS_SRC, 'views/skills.js']]) {
      assert.ok(!/railPresence\(/.test(src), `${label} still calls the withdrawn gate`);
      assert.ok(!/nav-item\[data-nav/.test(src),
        `${label} reaches into the rail itself, which is the rule coming back by hand`);
    }
  });

  // The condition the owner attached to permanence, and it is checked BY
  // OPENING THE ENTRY rather than by calling what the entry draws.
  //
  // WHY THAT DISTINCTION IS THE WHOLE TEST. Calling renderSkills proves the
  // pane can be drawn. It does not prove anything draws it when a reader
  // presses Skills, and the press is the only moment AC-11 is about. The one
  // line this change adds to the opener is the renderSkills call in switchNav's
  // skills arm, which is what fills the pane on the first press of a session,
  // before the skill list has arrived. Called rather than pressed, that line
  // can be deleted with every assertion here still passing while the first
  // press opens onto nothing.
  //
  // So the rail button is clicked as it sits in index.html, switchNav's own arm
  // is cut out of app.js and run, and showView is the shipped one, so "opens
  // onto" means the panel is revealed and has something in it.
  const ARMS = {
    routines: { pane: 'routines-content', panel: 'view-routines' },
    skills: { pane: 'skill-detail-content', panel: 'view-skills' },
  };

  function pressEntry(w, doc, nav) {
    const arm = nav === 'routines'
      ? appPiece(/else if\(nav==='routines'\)\s*\{([\s\S]*?)\}/, "switchNav's routines arm")
      : appPiece(/^\s*else if\(nav==='skills'\) \{(.*)\}\s*$/m, "switchNav's skills arm");
    // The shipped showView resolves the rail section from the view, so the
    // table it reads travels with it, in the same eval: a lexical declaration
    // loaded in an eval of its own is gone before the function runs. Cut out
    // rather than written here for the same reason the body is: a copy keeps
    // answering after the real one moves.
    w.eval(`${/const NAV_FOR_VIEW = \{[\s\S]*?\n\};/.exec(APP_SRC)[0]}\n`
      + `function showView(v) {${appPiece(/^function showView\(v\) \{(.*)\}\s*$/m, 'showView')}}`);
    w.closeFindBar = () => {};
    w.setNavState = () => {};
    // selectSkill is NOT stubbed: views/skills.js publishes the real one, and a
    // stub here would hide what pressing the entry does to a detail pane that
    // is already drawn, which is half of what these tests are about.
    let asked = null;
    w.switchNav = (asked_nav) => { asked = asked_nav; w.eval(`(function () {${arm}\n})()`); };
    const entry = doc.querySelector(`.nav-item[data-nav="${nav}"]`);
    assert.ok(entry, `the rail carries no ${nav} entry to press`);
    entry.click();
    assert.strictEqual(asked, nav, `the ${nav} entry asks the shell for another section`);
  }

  function paneText(doc, nav) {
    const panel = doc.getElementById(ARMS[nav].panel);
    assert.ok(panel, `the page carries no ${ARMS[nav].panel}`);
    assert.ok(!panel.classList.contains('hidden'),
      `pressing ${nav} left its panel hidden, so nothing was opened onto`);
    const pane = doc.getElementById(ARMS[nav].pane);
    assert.ok(pane, `the page carries no ${ARMS[nav].pane} to render into`);
    return pane.textContent.replace(/\s+/g, ' ').trim();
  }

  test('pressing an entry on an empty workspace opens onto a pane that says what it is for', () => {
    for (const nav of ['routines', 'skills']) {
      const { doc, w, dom } = shell([], { skills: [], guide: true });
      pressEntry(w, doc, nav);
      assert.ok(paneText(doc, nav).length > 20,
        `pressing ${nav} on a workspace with nothing in it opens onto a blank pane`);
      dom.window.close();
    }
  });

  // THE FIRST PRESS OF A SESSION, which is the one the opener's new line
  // exists for and the one a shell with skillsLoaded already true never
  // reaches. Nothing has replied yet, so the pane says it is looking and
  // offers nothing, and the press is what asks for the list.
  test('pressing Skills before the reply lands opens onto a pane that is waiting', () => {
    const { doc, w, dom } = shell([], { skills: [], skillsLoaded: false, guide: true });
    pressEntry(w, doc, 'skills');
    const shown = paneText(doc, 'skills');
    assert.match(shown, /Looking for skills your agents can run\./,
      'the first press of Skills in a session opens onto a blank pane');
    assert.ok(!shown.includes('Build a skill'),
      'the build offer was made before the skill list had arrived');
    assert.deepStrictEqual(w.sent, [{ type: 'get_skills' }],
      'the press did not ask for the list it is waiting on');
    dom.window.close();
  });

  // THE OTHER HALF OF THE OPENER'S RULE, and it is the half that has an
  // existing caller to protect. Drawing when nothing is drawn is what the
  // permanent entry needs. REDRAWING WHAT IS ALREADY THERE is a different
  // thing one line away, and it costs the reader their scroll position and any
  // card they had opened, on a press that used to be free.
  const SKILL_WITH_INSTRUCTIONS = {
    id: 'ops', name: 'Compile the ops summary', assignedAgents: [],
    description: 'Writes the daily summary.', instructions: 'Read the board. Write the summary.',
  };

  test('pressing Skills with a skill already open leaves that pane alone', () => {
    const { doc, w, dom } = shell([], { skills: [SKILL_WITH_INSTRUCTIONS], guide: true });
    // The pane as a reader leaves it: a skill opened from the sidebar, and its
    // Instructions card expanded by their own click. Both are done the way a
    // reader does them rather than by writing markup here.
    w.renderSkills();
    const row = doc.querySelector('.skill-sidebar-item[data-skill="ops"]');
    assert.ok(row, 'sanity: the sidebar lists the skill');
    row.click();
    const card = doc.getElementById('skill-instructions-ops');
    assert.ok(card, 'sanity: the detail pane draws the collapsible instructions card');
    assert.ok(card.classList.contains('hidden'), 'sanity: that card starts collapsed');
    card.parentElement.parentElement.click();
    assert.ok(!card.classList.contains('hidden'), 'sanity: a click opens it');
    const drawn = doc.getElementById('skill-detail-content').firstElementChild;

    pressEntry(w, doc, 'skills');

    assert.strictEqual(doc.getElementById('skill-detail-content').firstElementChild, drawn,
      'pressing the entry rebuilt a pane that already had something in it');
    const after = doc.getElementById('skill-instructions-ops');
    assert.ok(after && !after.classList.contains('hidden'),
      'pressing the entry collapsed a card the reader had opened');
    dom.window.close();
  });

  // And the same press when the pane is empty still draws, which is the case
  // the permanent entry exists for. Both halves in one file, because the two
  // are one line apart and a change that satisfies either alone is wrong.
  test('pressing Skills with nothing drawn still draws', () => {
    const { doc, w, dom } = shell([], { skills: [SKILL_WITH_INSTRUCTIONS], guide: true });
    assert.strictEqual(doc.getElementById('skill-detail-content').firstElementChild, null,
      'sanity: nothing has drawn the pane yet');
    pressEntry(w, doc, 'skills');
    assert.match(paneText(doc, 'skills'), /Compile the ops summary/,
      'pressing the entry left the pane as it found it, which was empty');
    dom.window.close();
  });

  // And the same entry, after the reply. The list is made to arrive by running
  // the client's own skills case rather than by setting the flag here: setting
  // it by hand would model a state the app never reaches, and it is that case
  // which draws the pane the press then reveals.
  test('pressing Skills after an empty reply opens onto the offer', () => {
    const { doc, w, dom } = shell([], { skills: [], skillsLoaded: false, guide: true });
    w.routineEditorSkillsArrived = () => {};
    w.palettePendingSkill = null;
    w.selectSkill = () => {};
    w.d = { type: 'skills', skills: [] };
    w.eval(`(function () {${appPiece(/case 'skills':([\s\S]*?)\bbreak;/, 'the skills case of the client dispatch')}\n})()`);
    assert.strictEqual(w.skillsLoaded, true, 'sanity: the reply is what marks the list arrived');
    pressEntry(w, doc, 'skills');
    const shown = paneText(doc, 'skills');
    assert.match(shown, /No skills yet\./);
    assert.match(shown, /Build a skill/);
    dom.window.close();
  });
});

describe('the four rows', () => {
  // AC-1 and AC-2. Two lines, and the second says what happened last time.
  test('each row carries two lines and the second says what happened last', () => {
    const { doc, w, dom } = shell();
    w.renderRoutines();
    assert.strictEqual(rows(doc).length, 4);
    for (const row of rows(doc)) {
      assert.ok(row.querySelector('.rr-sentence'), 'a row lost its sentence');
      assert.ok(row.querySelector('.rr-meta:not(.rr-run-line)'), 'a row lost its first line');
      assert.ok(row.querySelector('.rr-run-line .run-status'), 'a row lost its run status');
    }
    dom.window.close();
  });

  // AC-14, at the surface. Four rows, four tones, four leading words.
  test('each outcome renders its own tone and its own leading word', () => {
    const { doc, w, dom } = shell();
    w.renderRoutines();
    const statuses = rows(doc).map(r => r.querySelector('.run-status'));
    // In next-run order, which puts the missed row first: it is the only one
    // of the four due again today.
    assert.deepStrictEqual(statuses.map(s => s.className),
      ['run-status neutral', 'run-status ok', 'run-status ok-quiet', 'run-status failed']);
    assert.deepStrictEqual(statuses.map(s => text(s)), [
      'Missed: Rundock was closed at 7:00am yesterday, London time',
      'Ran today, 7:00am, London time',
      'Caught up: ran today, 9:14am, London time, due 7:00am',
      'Failed: today, 7:00am, London time',
    ]);
    // The ruling: a late run is a success and keeps the success class, and the
    // one state where nothing ran is the only one told apart by colour.
    assert.match(rowNamed(doc, 'Caught up').querySelector('.run-status').className, /ok-quiet/,
      'a late run must not be dressed as a warning');
    assert.match(rowNamed(doc, 'Missed').querySelector('.run-status').className, /neutral/,
      'a passed slot is history, not an error');
    dom.window.close();
  });

  // AC-6.
  test('the missed row names the cause and not the routine', () => {
    const { doc, w, dom } = shell();
    w.renderRoutines();
    const missed = text(rowNamed(doc, 'Missed').querySelector('.run-status'));
    assert.match(missed, /Rundock was closed/);
    assert.ok(!/routine/i.test(missed));
    dom.window.close();
  });

  // AC-3 and AC-4. Present on every row, including the one with the longest
  // status text, which is the row a layout drops it from.
  test('every row keeps its next-run fact, including the longest one', () => {
    const { doc, w, dom } = shell();
    w.renderRoutines();
    const next = rows(doc).map(r => r.querySelector('.next-run'));
    assert.ok(next.every(Boolean), 'a row dropped the next-run fact to make room for status');
    assert.deepStrictEqual(next.map(text), [
      'Next run: today, 7:00am, London time',
      'Next run: tomorrow, 7:00am, London time',
      'Next run: tomorrow, 7:00am, London time',
      'Next run: tomorrow, 7:00am, London time',
    ]);
    // The longest status is the missed one, and it is on the row that still
    // carries a next-run value.
    const longest = rows(doc)
      .map(r => ({ status: text(r.querySelector('.run-status')), next: text(r.querySelector('.next-run')) }))
      .sort((a, b) => b.status.length - a.status.length)[0];
    assert.match(longest.status, /^Missed:/);
    assert.strictEqual(longest.next, 'Next run: today, 7:00am, London time');
    dom.window.close();
  });

  // AC-15, at the surface.
  test('the missed row pairs with a next run today, never tomorrow', () => {
    const { doc, w, dom } = shell();
    w.renderRoutines();
    const line = text(rowNamed(doc, 'Missed').querySelector('.rr-run-line'));
    assert.match(line, /Next run: today/);
    assert.ok(!/tomorrow/.test(line));
    dom.window.close();
  });

  // AC-7.
  test('no time on the page is a raw timestamp', () => {
    const { doc, w, dom } = shell();
    w.renderRoutines();
    const page = text(doc.getElementById('routines-content'));
    assert.ok(!/\d{4}-\d{2}-\d{2}/.test(page), 'an ISO date reached the page');
    assert.ok(!/GMT|UTC/.test(page), 'an offset reached the page');
    dom.window.close();
  });

  // The frame's judgment call: the second line appears only once there is a
  // last-run fact worth pairing with next-run.
  test('a routine that has never run stays the single-line row, next run and all', () => {
    const { doc, w, dom } = shell([routine('Never run', { nextRun: iso(TOMORROWS_SLOT) })]);
    w.renderRoutines();
    assert.strictEqual(doc.querySelector('.rr-run-line'), null, 'nothing has happened, so there is no second line');
    assert.strictEqual(text(doc.querySelector('.rr-meta .next-run')), 'Next run: tomorrow, 7:00am, London time');
    dom.window.close();
  });

  test('a paused routine says so where its next run would be', () => {
    const { doc, w, dom } = shell([routine('Paused one', { paused: true, nextRun: iso(TOMORROWS_SLOT) })]);
    w.renderRoutines();
    assert.strictEqual(text(doc.querySelector('.next-run')), 'Paused');
    assert.match(doc.querySelector('.next-run').className, /paused-label/);
    assert.match(doc.querySelector('.routine-row').className, /paused/);
    dom.window.close();
  });

  test('the row names the agent and where the routine runs', () => {
    const { doc, w, dom } = shell();
    w.renderRoutines();
    const meta = text(rowNamed(doc, 'Ran on time').querySelector('.rr-meta:not(.rr-run-line)'));
    assert.match(meta, /Piper/);
    assert.match(meta, /Runs on this computer/);
    dom.window.close();
  });

  test('a routine name reaches the page as text, not as markup', () => {
    const { doc, w, dom } = shell([routine('<img src=x onerror=alert(1)>', { nextRun: iso(TOMORROWS_SLOT) })]);
    w.renderRoutines();
    assert.strictEqual(doc.querySelector('#routines-content img'), null);
    assert.match(text(doc.querySelector('.rr-sentence')), /<img src=x onerror=alert\(1\)>/);
    dom.window.close();
  });
});

describe('the ruling, against what the page resolves', () => {
  // WHY THIS READS THE PAGE AND NOT A TABLE. An earlier version of this card
  // declared colour and weight per tone in the model and asserted on that.
  // Nothing rendered it: the page's colour comes from .run-status.ok and its
  // neighbours in the stylesheet. So the headline proof of a ruling this
  // project spent three design rounds on was measuring a constant, and giving
  // Missed the danger colour in CSS moved the page and moved no test.
  //
  // These render the real view, with the real stylesheet in the document, and
  // read the resolved declaration off the spans the view actually emitted. A
  // rule added later that overrides these changes the answer, which is the
  // property a string search of the file would not have.
  function resolved() {
    const { doc, w, dom } = shell();
    w.renderRoutines();
    const out = {};
    for (const span of doc.querySelectorAll('.run-status')) {
      const tone = [...span.classList].filter(c => c !== 'run-status')[0];
      const style = dom.window.getComputedStyle(span);
      out[tone] = { colour: style.color, weight: Number(style.fontWeight) };
    }
    dom.window.close();
    return out;
  }

  test('the two successes resolve to one colour, and the late one is quieter', () => {
    const tone = resolved();
    assert.strictEqual(tone['ok'].colour, tone['ok-quiet'].colour,
      'a late run is a success and must share the success colour');
    assert.ok(tone['ok'].weight > tone['ok-quiet'].weight,
      'the two successes are told apart by weight, so they cannot share one');
  });

  test('the state where nothing ran resolves to neither success nor failure', () => {
    const tone = resolved();
    assert.notStrictEqual(tone['neutral'].colour, tone['ok'].colour,
      'a slot nobody served must not read as a run that happened');
    assert.notStrictEqual(tone['neutral'].colour, tone['failed'].colour,
      'the machine being off is not the routine failing');
  });

  test('a failure resolves to something neither success wears', () => {
    const tone = resolved();
    assert.notStrictEqual(tone['failed'].colour, tone['ok'].colour);
    assert.notStrictEqual(tone['failed'].colour, tone['ok-quiet'].colour);
  });

  test('nothing on this row reaches for amber', () => {
    // The palette spends that colour on "needs the user, not an error", which
    // none of these four states is, and amber reads as an alert whatever a
    // legend says. An interface that turns amber every time a laptop was shut
    // overnight teaches its user to stop trusting amber.
    for (const [tone, style] of Object.entries(resolved())) {
      assert.notStrictEqual(style.colour, 'var(--attention)', `${tone} is amber`);
    }
  });

  // The four tokens the rules above name are four different colours. Without
  // this, "neutral resolves to a different token" would still hold if two
  // tokens happened to carry the same value.
  test('the tokens those rules name are distinct colours', () => {
    const used = Object.values(resolved()).map(s => s.colour);
    const value = (token) => {
      const m = new RegExp(`--${token}:\\s*([^;]+);`).exec(TOKENS_CSS);
      assert.ok(m, `--${token} is declared nowhere`);
      return m[1].trim();
    };
    const names = [...new Set(used)].map(c => /^var\(--([\w-]+)\)$/.exec(c)[1]);
    const values = names.map(value);
    assert.strictEqual(new Set(values).size, values.length,
      `two of ${names.join(', ')} are the same colour, so the rows do not separate`);
    assert.ok(!names.includes('attention'));
  });
});

describe('the empty state, where a skill exists', () => {
  // AC-12. The way in belongs to no agent.
  test('the empty state offers an add that names no agent', () => {
    const { doc, w, dom } = shell([]);
    w.renderRoutines();
    const page = text(doc.getElementById('routines-content'));
    assert.match(page, /No routines yet\./);
    assert.match(page, /Pick a tested skill and give it a schedule\. Your agents take it from there\./);
    assert.match(page, /Looking at a skill you already trust\?/);
    assert.ok(!/Piper/.test(page), 'the empty state names no agent');
    assert.strictEqual(rows(doc).length, 0);
    dom.window.close();
  });

  test('the empty state\'s add is pressed, not called, and opens the agent-agnostic editor', () => {
    const { doc, w, dom } = shell([]);
    w.renderRoutines();
    press(doc, '[data-routines-action="add"]');
    assert.strictEqual(w.editorOpened, 'unscoped');
    dom.window.close();
  });

  // THE LOCKED COPY, WORD FOR WORD, and the point of asserting it at the
  // surface as well as in the model is that this state is the one the
  // amendment does NOT touch. A variant added beside it that quietly reworded
  // this one would be the amendment doing more than it was asked to.
  test('where any skill exists the locked copy is untouched, aside included', () => {
    const { doc, w, dom } = shell([]);
    w.renderRoutines();
    const page = text(doc.getElementById('routines-content'));
    assert.ok(page.includes('Pick a tested skill and give it a schedule. Your agents take it from there.'));
    assert.ok(page.includes('Looking at a skill you already trust? You can also schedule it right '
      + 'from its own page.'));
    assert.ok(!page.includes('Build a skill'), 'the build offer reached a workspace that has skills');
    assert.ok(!page.includes('Routines schedule skills your agents already have'),
      'the no-skills line reached a workspace that has skills');
    dom.window.close();
  });
});

describe('the empty state, where no skill exists', () => {
  // AMENDMENT 5. The locked body presupposes a tested skill, which gating
  // quietly guaranteed: you could not reach this view without having had a
  // routine, and you could not have had a routine without a skill. A permanent
  // rail entry removes the guarantee and exposes a state the locked copy was
  // never written for.
  test('a workspace with no skills is pointed one step back up the chain', () => {
    const { doc, w, dom } = shell([], { skills: [], guide: true });
    w.renderRoutines();
    const page = text(doc.getElementById('routines-content'));
    assert.match(page, /No routines yet\./);
    assert.match(page, /Routines schedule skills your agents already have\. Build one and it will show up here\./);
    assert.ok(!page.includes('Pick a tested skill'), 'the locked body was shown with nothing to pick');
    dom.window.close();
  });

  // The aside names the skill's own page as a second way in. With no skill
  // there is no such page, so the aside goes with it.
  test('the aside goes, because the path it names does not exist yet', () => {
    const { doc, w, dom } = shell([], { skills: [], guide: true });
    w.renderRoutines();
    const page = text(doc.getElementById('routines-content'));
    assert.ok(!/Looking at a skill you already trust/.test(page),
      'the aside points at a skill page this workspace has no skill for');
    assert.strictEqual(doc.querySelectorAll('.routines-empty-aside').length, 0);
    dom.window.close();
  });

  test('the one action offered builds a skill, and is pressed rather than called', () => {
    const { doc, w, dom } = shell([], { skills: [], guide: true });
    w.renderRoutines();
    const buttons = doc.querySelectorAll('#routines-content button');
    assert.strictEqual(buttons.length, 1, 'an empty state offers one action, never two');
    assert.strictEqual(buttons[0].textContent.trim(), 'Build a skill');
    buttons[0].click();
    assert.strictEqual(w.buildSkillFrom, 'routines',
      'the action does not reach the flow that opens a conversation with the guide');
    assert.strictEqual(w.editorOpened, undefined, 'a workspace with no skills was offered the picker');
    dom.window.close();
  });

  // The variant is chosen by the same question the picker answers, so the two
  // surfaces cannot disagree about whether a workspace has skills. A skill
  // nothing is assigned to cannot be scheduled, so it is not a skill this
  // question counts.
  test('an unassigned skill is not a skill this view can offer to schedule', () => {
    const { doc, w, dom } = shell([], { skills: [{ id: 'sk', name: 'Orphan', assignedAgents: [] }], guide: true });
    w.renderRoutines();
    const page = text(doc.getElementById('routines-content'));
    assert.match(page, /Routines schedule skills your agents already have\./);
    assert.ok(!page.includes('Pick a tested skill'),
      'the picker would open on nothing, so the offer to pick is false');
    dom.window.close();
  });

  // WITH NO GUIDE THE BUTTON GOES AND THE LINE MUST NOT BE LEFT INSTRUCTING AN
  // ACTION WITH NOTHING TO PRESS. "Build one and it will show up here" with no
  // Build a skill beside it is a dead end, so the same agent-independent
  // sentence the Skills pane uses is appended, and the shipped line is kept
  // whole rather than split.
  test('with no guide the action goes and a next step is appended', () => {
    const { doc, w, dom } = shell([], { skills: [], guide: false });
    w.renderRoutines();
    const page = text(doc.getElementById('routines-content'));
    assert.match(page, /No routines yet\./);
    assert.match(page, /Routines schedule skills your agents already have\. Build one and it will show up here\./);
    assert.match(page, /Skills are listed on each agent, so add one to an agent's file under skills: and it appears here\./);
    assert.strictEqual(doc.querySelectorAll('#routines-content button').length, 0,
      'a button was offered with no agent to fulfil it');
    dom.window.close();
  });

  // And the guide variant is unchanged by any of that: it already ends in a
  // next step of its own, so nothing is appended to it.
  test('with a guide the shipped line stands alone and keeps its action', () => {
    const { doc, w, dom } = shell([], { skills: [], guide: true });
    w.renderRoutines();
    const page = text(doc.getElementById('routines-content'));
    assert.match(page, /Routines schedule skills your agents already have\. Build one and it will show up here\./);
    assert.ok(!page.includes('Skills are listed on each agent'),
      'the no-guide sentence reached a workspace that has a guide');
    assert.ok(!/Wren|Doc/.test(page), 'this state names no agent in either variant');
    dom.window.close();
  });
});

describe('the variant does not flash', () => {
  // THE DEFECT THE DESIGNER FOUND BY DRAWING IT. "Skills have not arrived yet"
  // and "there are no skills" are different states and only one of them is an
  // offer. Without this guard a workspace that DOES have skills is told to
  // build one for a beat on every open.
  test('skills still in flight are not read as no skills', () => {
    const { doc, w, dom } = shell([], { skills: [], skillsLoaded: false, guide: true });
    w.renderRoutines();
    const page = text(doc.getElementById('routines-content'));
    assert.ok(!page.includes('Build a skill'),
      'the build offer was made before the skill list had arrived');
    assert.match(page, /No routines yet\./, 'the routines fact is known and is still said');
    assert.match(page, /Looking for skills your agents can run\./);
    dom.window.close();
  });

  test('the skill list arriving settles the variant', () => {
    const { doc, w, dom } = shell([], { skills: [], skillsLoaded: false, guide: true });
    w.renderRoutines();
    const waiting = text(doc.getElementById('routines-content'));
    // Both halves, or this test passes against a view that never waited: a
    // page showing the locked copy throughout would satisfy the second
    // assertion on its own.
    assert.ok(!waiting.includes('Pick a tested skill'),
      'the locked copy was shown before anything was known about skills');
    w.skills = [{ id: 'sk', name: 'Compile the ops summary', assignedAgents: [{ id: 'piper', name: 'Piper' }] }];
    w.skillsLoaded = true;
    w.renderRoutines();
    const page = text(doc.getElementById('routines-content'));
    assert.match(page, /Pick a tested skill and give it a schedule\./);
    assert.ok(!page.includes('Looking for skills'), 'the wait outlived the reply');
    dom.window.close();
  });
});

describe('delete says what stops', () => {
  // AC-11.
  test('pressing delete names the agent, the routine, the schedule and what survives', () => {
    const { doc, w, dom } = shell();
    w.renderRoutines();
    press(doc, '.routine-row [data-routines-action="delete"]');
    const confirm = doc.querySelector('.confirm-card');
    assert.ok(confirm, 'delete asked nothing');
    const body = text(confirm);
    assert.match(body, /Delete this routine\?/);
    assert.match(body, /This stops Piper running Missed, every day at 7:00am\./);
    assert.match(body, /The file it last updated stays exactly as it is\./);
    assert.match(body, /This can't be undone\./);
    assert.ok(!/are you sure/i.test(body));
    dom.window.close();
  });

  test('cancelling puts the list back and sends nothing', () => {
    const { doc, w, dom } = shell();
    w.renderRoutines();
    press(doc, '.routine-row [data-routines-action="delete"]');
    press(doc, '[data-routines-action="cancel-delete"]');
    assert.strictEqual(doc.querySelector('.confirm-card'), null);
    assert.strictEqual(rows(doc).length, 4);
    assert.deepStrictEqual(w.sent, []);
    dom.window.close();
  });

  test('confirming asks the server to remove that routine and no other', () => {
    const { doc, w, dom } = shell();
    w.renderRoutines();
    press(doc, '.routine-row [data-routines-action="delete"]');
    press(doc, '[data-routines-action="confirm-delete"]');
    // The first row on the page is the one due soonest, which is the missed
    // one, and the delete is addressed to it rather than to the first block in
    // the file.
    assert.deepStrictEqual(w.sent,
      [{ type: 'delete_routine', agentId: 'piper', name: 'Missed', occurrence: 0 }]);
    dom.window.close();
  });
});

describe('a namesake is identified, not assumed', () => {
  // Nothing makes a routine name unique within an agent, and the writer counts
  // namesakes on purpose so a second can be created here. A row that sent only
  // a name would have the server act on the first block of that name whatever
  // the reader pointed at, while the confirmation named the one they chose.
  const twins = [
    routine('Compile the ops summary', { nextRun: iso(TOMORROWS_SLOT) }),
    routine('Compile the ops summary', { nextRun: iso(TOMORROWS_SLOT) }),
    routine('Something else', { nextRun: iso(TOMORROWS_SLOT) }),
  ];

  test('deleting the second of two namesakes says which one', () => {
    const { doc, w, dom } = shell(twins);
    w.renderRoutines();
    rows(doc)[1].querySelector('[data-routines-action="delete"]').click();
    press(doc, '[data-routines-action="confirm-delete"]');
    assert.deepStrictEqual(w.sent, [{
      type: 'delete_routine', agentId: 'piper', name: 'Compile the ops summary', occurrence: 1,
    }]);
    dom.window.close();
  });

  test('pausing the second of two namesakes says which one', () => {
    const { doc, w, dom } = shell(twins);
    w.renderRoutines();
    rows(doc)[1].querySelector('[data-routines-action="pause"]').click();
    assert.strictEqual(w.sent[0].occurrence, 1);
    dom.window.close();
  });

  test('the count is per agent and per name, not a position in the list', () => {
    const { doc, w, dom } = shell(twins);
    w.renderRoutines();
    // The third row is the first routine of ITS name, so it is occurrence
    // zero even though it is third on the page.
    rows(doc)[2].querySelector('[data-routines-action="pause"]').click();
    assert.deepStrictEqual(w.sent, [{
      type: 'set_routine_paused', agentId: 'piper', name: 'Something else', occurrence: 0, paused: true,
    }]);
    dom.window.close();
  });
});

describe('pause stops what it says it stops', () => {
  test('pausing a running routine asks for it to be paused', () => {
    const { doc, w, dom } = shell();
    w.renderRoutines();
    press(doc, '.routine-row [data-routines-action="pause"]');
    assert.deepStrictEqual(w.sent,
      [{ type: 'set_routine_paused', agentId: 'piper', name: 'Missed', occurrence: 0, paused: true }]);
    dom.window.close();
  });

  test('a paused routine offers to resume rather than to pause again', () => {
    const { doc, w, dom } = shell([routine('Paused one', { paused: true, nextRun: iso(TOMORROWS_SLOT) })]);
    w.renderRoutines();
    assert.strictEqual(doc.querySelector('[data-routines-action="pause"]'), null);
    press(doc, '[data-routines-action="resume"]');
    assert.deepStrictEqual(w.sent,
      [{ type: 'set_routine_paused', agentId: 'piper', name: 'Paused one', occurrence: 0, paused: false }]);
    dom.window.close();
  });
});

describe('every control this view renders resolves to something', () => {
  // A handler renamed on one side and not the other produces a control that
  // silently does nothing when pressed. This catches it for every control in
  // every state, including states a walk does not reach.
  test('no rendered control names a handler that does not exist', () => {
    const { doc, w, dom } = shell();
    const states = [];
    w.renderRoutines();
    states.push(doc.getElementById('routines-content').innerHTML);
    press(doc, '.routine-row [data-routines-action="delete"]');
    states.push(doc.getElementById('routines-content').innerHTML);

    const { doc: emptyDoc, w: emptyW, dom: emptyDom } = shell([]);
    emptyW.renderRoutines();
    states.push(emptyDoc.getElementById('routines-content').innerHTML);

    const { doc: pausedDoc, w: pausedW, dom: pausedDom } = shell([routine('Paused one', { paused: true })]);
    pausedW.renderRoutines();
    states.push(pausedDoc.getElementById('routines-content').innerHTML);

    const handlers = new Set();
    for (const html of states) {
      for (const m of html.matchAll(/on(?:click|change)="([a-zA-Z_$][\w$]*)\(/g)) handlers.add(m[1]);
    }
    assert.ok(handlers.size >= 4, `sanity: found only ${handlers.size} handlers across this view's states`);
    for (const name of handlers) {
      assert.strictEqual(typeof w[name], 'function', `a control calls ${name}() and nothing by that name is published`);
    }
    dom.window.close();
    emptyDom.window.close();
    pausedDom.window.close();
  });
});

describe('the list is ordered by next run', () => {
  // ROSTER ORDER IS WHAT THIS FAILS AGAINST, so the fixture is built to
  // disagree with it on every position: written latest first, due soonest
  // last, with the paused one in the middle of the file. A view that renders
  // the roster as it arrives puts these on the page in exactly the order
  // below, and the assertion is the reverse of it.
  const OUT_OF_ORDER = [
    routine('Due last', { nextRun: iso(new Date(2026, 7, 23, 7, 0)) }),
    routine('Paused, written second', { paused: true, nextRun: iso(TOMORROWS_SLOT) }),
    routine('Due second', { nextRun: iso(TOMORROWS_SLOT) }),
    routine('Paused, written fourth', { paused: true }),
    routine('Due first', { nextRun: iso(new Date(2026, 7, 20, 18, 0)) }),
  ];

  const sentences = (doc) => rows(doc).map(r => text(r.querySelector('.rr-sentence')));

  test('the rows are drawn soonest first, not in the order the roster held them', () => {
    const { doc, w, dom } = shell(OUT_OF_ORDER);
    w.renderRoutines();
    assert.deepStrictEqual(sentences(doc).map(s => s.split('run: ')[1]), [
      'Due first', 'Due second', 'Due last', 'Paused, written second', 'Paused, written fourth',
    ], 'the page is in roster order, which is file order and is arbitrary to a reader');
    dom.window.close();
  });

  test('the paused routines are together at the end, in the order the file holds them', () => {
    const { doc, w, dom } = shell(OUT_OF_ORDER);
    w.renderRoutines();
    const paused = rows(doc).map(r => /\bpaused\b/.test(r.className));
    assert.deepStrictEqual(paused, [false, false, false, true, true],
      'a paused routine is not scheduled, so it belongs after everything that is');
    dom.window.close();
  });

  // AC-A3. The ordering moves rows and touches nothing on one. Asserted by
  // rendering the same routine in both orders and comparing the markup of its
  // row, so a change to any word, tone, control or handler inside it fails
  // here even though this card is about the list.
  test('no row says anything different for having been ordered', () => {
    const one = routine('Alone', {
      state: { status: 'completed', duration: 3 }, lastStart: iso(new Date(2026, 7, 20, 7, 0, 12)),
      lastSlot: iso(TODAYS_SLOT), nextRun: iso(TOMORROWS_SLOT),
    });
    const first = shell([one, routine('Later', { nextRun: iso(new Date(2026, 7, 23, 7, 0)) })]);
    first.w.renderRoutines();
    const alone = rowNamed(first.doc, 'Alone').outerHTML;
    first.dom.window.close();

    // The same routine, now second in the file and still first on the page.
    const second = shell([routine('Later', { nextRun: iso(new Date(2026, 7, 23, 7, 0)) }), one]);
    second.w.renderRoutines();
    assert.strictEqual(rowNamed(second.doc, 'Alone').outerHTML, alone,
      'ordering the list changed what a row says');
    assert.strictEqual(sentences(second.doc)[0].split('run: ')[1], 'Alone',
      'sanity: the row under test did move');
    second.dom.window.close();
  });

  // The handle a pause or a delete travels under is a position in the FILE,
  // and the rows are now in a different order from the file, so the two can
  // come apart in a way that was impossible before this card.
  test('a control on a reordered row still addresses the routine under it', () => {
    const { doc, w, dom } = shell(OUT_OF_ORDER);
    w.renderRoutines();
    rows(doc)[0].querySelector('[data-routines-action="pause"]').click();
    assert.deepStrictEqual(w.sent, [{
      type: 'set_routine_paused', agentId: 'piper', name: 'Due first', occurrence: 0, paused: true,
    }], 'the top row is the soonest, and pausing it must not pause the first block in the file');
    dom.window.close();
  });

  test('the row a delete confirmation names is the row the delete was pressed on', () => {
    const { doc, w, dom } = shell(OUT_OF_ORDER);
    w.renderRoutines();
    rows(doc)[0].querySelector('[data-routines-action="delete"]').click();
    assert.match(text(doc.querySelector('.confirm-card')), /Due first/);
    press(doc, '[data-routines-action="confirm-delete"]');
    assert.strictEqual(w.sent[0].name, 'Due first');
    dom.window.close();
  });
});

describe('the skill named on a row is reachable', () => {
  // The routine and the skill share a name, which is how the product connects
  // them: the editor writes the routine under the name of the skill it picked.
  const SKILL = { id: 'sk-ops', name: 'Compile the ops summary', assignedAgents: [{ id: 'piper', name: 'Piper' }] };
  const ONE = [routine('Compile the ops summary', { nextRun: iso(TOMORROWS_SLOT) })];

  const link = (doc) => doc.querySelector('.rr-sentence .rr-skill-link');

  // AC-B1, driven through the surface a reader touches: the name on the row is
  // pressed, and the assertion is what the skills pane then holds. selectSkill
  // is the shipped one, so "opens that skill's page" means the page.
  test('pressing the skill name opens that skill', () => {
    const { doc, w, dom } = shell(ONE, { skills: [SKILL] });
    w.renderRoutines();
    assert.ok(link(doc), 'the row draws no link at all');
    link(doc).click();
    assert.strictEqual(w.currentSkillId, 'sk-ops');
    assert.match(text(doc.getElementById('skill-detail-content')), /Compile the ops summary/,
      'the press left the skills pane on whatever it held before');
    dom.window.close();
  });

  // AC-B2.
  test('only the skill name is the link, and the schedule is not', () => {
    const { doc, w, dom } = shell(ONE, { skills: [SKILL] });
    w.renderRoutines();
    assert.strictEqual(text(link(doc)), 'Compile the ops summary',
      'the link covers more or less than the skill name');
    assert.strictEqual(doc.querySelectorAll('.rr-sentence .rr-skill-link').length, 1);
    // The schedule is on the line and outside the link, so the sentence still
    // reads as one sentence.
    const sentence = doc.querySelector('.rr-sentence');
    assert.strictEqual(text(sentence), 'Every day at 7:00am, run: Compile the ops summary');
    const outside = sentence.textContent.replace(link(doc).textContent, '');
    assert.match(outside, /Every day at 7:00am, run:/,
      'the schedule went inside the link');
    dom.window.close();
  });

  // AC-B3, driven rather than described. A routine outlives the skill it
  // names, because the two live in different files.
  test('a routine naming a skill that no longer exists is plain text', () => {
    const { doc, w, dom } = shell(ONE, { skills: [] });
    w.renderRoutines();
    assert.strictEqual(link(doc), null, 'a deleted skill was still offered as a destination');
    assert.strictEqual(text(doc.querySelector('.rr-sentence')),
      'Every day at 7:00am, run: Compile the ops summary',
      'the sentence lost words along with the link');
    dom.window.close();
  });

  test('a row whose skill is gone throws nothing when the sentence is pressed', () => {
    const { doc, w, dom } = shell(ONE, { skills: [] });
    w.renderRoutines();
    doc.querySelector('.rr-sentence').click();
    // And the handler itself, reached directly, is the same answer: a skill
    // deleted between the render and the press must not open a page for it.
    w.routinesOpenSkill(0);
    assert.strictEqual(w.currentSkillId, null);
    dom.window.close();
  });

  test('a skill list that has not arrived yet leaves the sentence plain', () => {
    const { doc, w, dom } = shell(ONE, { skills: [], skillsLoaded: false });
    w.renderRoutines();
    assert.strictEqual(link(doc), null);
    dom.window.close();
  });

  // The name reaches the page as text on both roads, and the link is one more
  // place it could stop doing so.
  test('a routine name reaches the link as text, not as markup', () => {
    const nasty = '<img src=x onerror=alert(1)>';
    const { doc, w, dom } = shell([routine(nasty, { nextRun: iso(TOMORROWS_SLOT) })],
      { skills: [{ id: 'sk-nasty', name: nasty, assignedAgents: [] }] });
    w.renderRoutines();
    assert.strictEqual(doc.querySelector('#routines-content img'), null);
    assert.strictEqual(text(link(doc)), nasty);
    dom.window.close();
  });

  // The row in the delete confirmation is there to say which routine is about
  // to go. It offers nothing, and a link is an offer.
  test('the row in the delete confirmation offers no link', () => {
    const { doc, w, dom } = shell(ONE, { skills: [SKILL] });
    w.renderRoutines();
    press(doc, '[data-routines-action="delete"]');
    assert.ok(doc.querySelector('.confirm-card'), 'sanity: the confirmation is on screen');
    assert.strictEqual(link(doc), null);
    assert.match(text(doc.querySelector('.routines-confirm-subject')), /Compile the ops summary/);
    dom.window.close();
  });

  // The jump has to land the reader on Skills with Skills lit. It used to have
  // to say so itself: selectSkill showed the skills view and touched no nav
  // state, so a jump that only called it left Routines lit over Skills. The
  // section is a property of the view now, so showing the view is what lights
  // the entry, and this route gets that without asking for it.
  //
  // THE REAL ROUTER IS RUN, not a stub of it: the three pieces are cut out of
  // app.js and evaluated against the rail as index.html ships it, in ONE eval,
  // because showView reads a table declared beside it and a lexical declaration
  // loaded in an eval of its own is gone before the function runs. A test that
  // asserted this view called a function named switchNav would pass against a
  // shell where switchNav did nothing to the rail.
  test('the rail shows Skills as active after the jump', () => {
    const { doc, w, dom } = shell(ONE, { skills: [SKILL] });
    w.eval([
      /const NAV_FOR_VIEW = \{[\s\S]*?\n\};/.exec(APP_SRC)[0],
      `function setNavState(nav) {${appPiece(/function setNavState\(nav\) \{([\s\S]*?)\n\}/, 'setNavState')}\n}`,
      `function showView(v) {${appPiece(/^function showView\(v\) \{(.*)\}\s*$/m, 'showView')}}`,
      `function switchNav(nav) {${appPiece(/function switchNav\(nav\) \{([\s\S]*?)\n\}/, 'switchNav')}\n}`,
    ].join('\n'));
    w.closeFindBar = () => {};
    w.renderSkillsIfEmpty = () => {};
    w.renderRoutines();

    const railEntry = (nav) => doc.querySelector(`.nav-item[data-nav="${nav}"]`);
    railEntry('routines').classList.add('active');
    assert.strictEqual(railEntry('skills').classList.contains('active'), false,
      'sanity: the reader is on Routines before the jump');

    link(doc).click();

    assert.strictEqual(railEntry('skills').classList.contains('active'), true,
      'the jump landed on Skills with another entry lit');
    assert.strictEqual(railEntry('routines').classList.contains('active'), false,
      'the entry the reader left is still lit');
    dom.window.close();
  });

  // The rail is set on THIS route and on no other. The other routes with the
  // same defect belong to the navigation inventory, which exists so somebody
  // enumerates rather than patches, and a card that quietly fixed them would
  // remove the reason for it.
  test('the route this card creates is the only one it fixes', () => {
    // selectSkill is the shared function four other routes go through: the
    // skills sidebar, the palette, the agent profile's skill card and the
    // dispatch's pending-skill reply. Setting the nav state inside it would
    // fix all four, which is the inventory card's job and not this one's.
    assert.ok(!/setNavState\(/.test(SKILLS_SRC),
      'views/skills.js now sets the nav state, which fixes four routes this card was told to leave');
    assert.ok(!/switchNav\((['"])skills\1\)/.test(SKILLS_SRC),
      'views/skills.js now routes to its own section, which is the same fix by another name');
  });
});

describe('the header is the skills view\'s header', () => {
  // The stylesheets that decide what a heading LOOKS like, loaded into the
  // document so the size question is answered by what the page resolves rather
  // than by reading a rule out of a file.
  const PROFILE_CSS = read('public', 'styles', 'views', 'profile.css');
  const SETTINGS_CSS = read('public', 'styles', 'views', 'settings.css');
  const SKILLS_CSS = read('public', 'styles', 'views', 'skills.css');
  const SCOPE_MODEL_SRC = read('public', 'routines-scope-model.js');
  const PANEL_SRC = read('public', 'views', 'routines-panel.js');

  // A document carrying the real page and the real stylesheets, with both
  // views drawn into it, so the two headers can be compared as the browser
  // resolves them rather than as two strings.
  function styled(routines = FOUR_ROWS, opts = {}) {
    const dom = new JSDOM('<!doctype html><html><head><style>'
      + TOKENS_CSS + PROFILE_CSS + SETTINGS_CSS + SKILLS_CSS + ROUTINES_CSS
      + '</style></head><body>' + pageParts()
      // The heading this card replaces, in the same document, so "no type size
      // changed" is a comparison rather than a claim.
      + '<div class="settings-section-title" id="the-old-heading">Routines</div>'
      + '</body></html>', { runScripts: 'dangerously' });
    const w = dom.window;
    w.eval(EDITOR_MODEL_SRC);
    w.eval(SKILLS_MODEL_SRC);
    w.eval(MODEL_SRC);
    w.eval(VIEW_SRC);
    w.eval(SKILLS_SRC);
    // The scope lives in the panel beside this list, so the panel and the
    // model it reads are loaded here rather than stubbed: the subtitle's whole
    // job is to agree with the rows, and a stubbed scope would let it agree
    // with a value the product never produces.
    w.eval(SCOPE_MODEL_SRC);
    w.eval(PANEL_SRC);
    w.agents = [{ id: 'piper', displayName: 'Piper', colour: '#E87A5A', icon: 'P', status: 'onTeam', routines }];
    w.skills = opts.skills === undefined
      ? [{ id: 'sk', name: 'Compile the ops summary', assignedAgents: [{ id: 'piper', name: 'Piper' }] }]
      : opts.skills;
    w.skillsLoaded = true;
    w.currentSkillId = null;
    w.currentView = 'skills';
    w.getGuide = () => null;
    w.esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    w.ws = { send: () => {} };
    w.showView = () => {};
    w.routinesNow = () => NOW;
    w.Intl = { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: 'Europe/London' }) }) };
    w.renderRoutines();
    return { w, doc: w.document, dom };
  }

  const routinesHeader = (doc) => doc.querySelector('#routines-content .profile-header');
  const skillsHeader = (doc) => doc.querySelector('#skill-detail-content .profile-header');

  // AC-C1. The same component, and it is asserted as the same ELEMENTS rather
  // than as a class name that happens to appear in both files.
  test('the routines header is built from the same blocks the skills header is', () => {
    const { doc, w, dom } = styled();
    w.selectSkill('sk');
    const shape = (header) => {
      assert.ok(header, 'a header is missing');
      return [...header.children].map(el => el.className || el.tagName.toLowerCase());
    };
    assert.deepStrictEqual(shape(routinesHeader(doc)), shape(skillsHeader(doc)));
    assert.ok(routinesHeader(doc).querySelector('.profile-avatar.skill-avatar'),
      'the glyph is not in the box the skills view puts its glyph in');
    assert.ok(routinesHeader(doc).querySelector('.profile-name'));
    dom.window.close();
  });

  // AC-C1, the other half: a clock rather than a bolt, and the clock is the
  // one the rail already draws for this section rather than a second drawing
  // of one.
  test('the glyph is the clock the rail draws, and not the skills bolt', () => {
    const { doc, w, dom } = styled();
    w.selectSkill('sk');
    const path = (header) => header.querySelector('.profile-avatar svg path').getAttribute('d');
    const routinesGlyph = path(routinesHeader(doc));
    assert.notStrictEqual(routinesGlyph, path(skillsHeader(doc)),
      'the routines header still draws the skills bolt');

    const railEntry = doc.querySelector('.nav-item[data-nav="routines"]');
    const railClock = railEntry.querySelector('.icon-filled path').getAttribute('d');
    assert.strictEqual(routinesGlyph.replace(/\s+/g, ' '), railClock.replace(/\s+/g, ' '),
      'the header draws a second clock rather than the one the rail already draws');
    dom.window.close();
  });

  // AC-C2, and it is the criterion the obvious change gets wrong. The heading
  // this replaced is already var(--title) at weight 700, exactly as
  // .profile-name is, so the size is correct today and must not move. Read off
  // the page with the shipped stylesheets in it, so a rule added later that
  // overrides either one changes this answer.
  test('the heading resolves to the size and weight the old one did', () => {
    const { doc, dom } = styled();
    const style = (el) => {
      const s = dom.window.getComputedStyle(el);
      return { size: s.fontSize, weight: s.fontWeight };
    };
    const before = style(doc.getElementById('the-old-heading'));
    const after = style(routinesHeader(doc).querySelector('.profile-name'));
    assert.deepStrictEqual(after, before,
      'this card moved a type size, and it was asked to move a component');
    assert.strictEqual(before.size, 'var(--title)', 'sanity: the heading resolves from the token');
    dom.window.close();
  });

  test('the two views resolve their headings to the same size and weight', () => {
    const { doc, w, dom } = styled();
    w.selectSkill('sk');
    const style = (el) => {
      const s = dom.window.getComputedStyle(el);
      return { size: s.fontSize, weight: s.fontWeight };
    };
    assert.deepStrictEqual(style(routinesHeader(doc).querySelector('.profile-name')),
      style(skillsHeader(doc).querySelector('.profile-name')));
    dom.window.close();
  });

  // AC-C3 at the surface. Nothing sets the scope yet, so the page takes the
  // unscoped sentence, and it is the locked one.
  test('the subtitle under the title is the locked sentence', () => {
    const { doc, dom } = styled();
    const subtitle = routinesHeader(doc).querySelector('.routines-subtitle');
    assert.ok(subtitle, 'the lead sentence did not move into the header');
    assert.strictEqual(text(subtitle),
      'Every scheduled skill across your team, and when it runs next.');
    dom.window.close();
  });

  // AC-C2, on the populated header. The subtitle is a subtitle: it takes the
  // body size, not the title size above it, so it cannot be mistaken for a
  // second heading.
  test('the subtitle resolves to the body size, not the title size', () => {
    const { doc, dom } = styled();
    const size = (el) => {
      assert.ok(el, 'an element this compares is not on the page');
      return dom.window.getComputedStyle(el).fontSize;
    };
    const subtitle = size(routinesHeader(doc).querySelector('.routines-subtitle'));
    assert.notStrictEqual(subtitle, size(routinesHeader(doc).querySelector('.profile-name')),
      'the subtitle is set at the title size, which is a type size this card was not asked to move');
    dom.window.close();
  });

  // AC-C3 AT THE SURFACE, WHICH IT COULD NOT BE UNTIL A SCOPE EXISTED. The
  // header used to read a scope global of its own, because nothing set one;
  // the destination function every way into this view goes through now does.
  // Driven through that function rather than by setting the state here, so
  // the two halves are shown to agree rather than assumed to.
  test('scoped to an agent, the subtitle on the page names that agent', () => {
    const { doc, w, dom } = styled();
    // A SECOND OWNER, BECAUSE A SCOPE IS NOT OFFERED BELOW TWO. A filter with
    // one option cannot change what the pane shows, so the panel withdraws it
    // and refuses the scope with it. Scoping a one-agent workspace is not a
    // state the product has, so a test that scoped one would be asserting
    // about a screen no reader can reach.
    w.agents.push({
      id: 'wren', displayName: 'Wren', colour: '#6BC67E', icon: 'W', status: 'onTeam',
      routines: [routine('Wren nightly', { nextRun: iso(TOMORROWS_SLOT) })],
    });
    w.renderRoutines();
    assert.strictEqual(text(routinesHeader(doc).querySelector('.routines-subtitle')),
      'Every scheduled skill across your team, and when it runs next.',
      'sanity: unscoped, the page carries the locked sentence');

    w.setNavState = () => {};
    w.showRoutinesForAgent('piper');
    assert.strictEqual(text(routinesHeader(doc).querySelector('.routines-subtitle')),
      'Every scheduled skill Piper runs, and when it runs next.',
      'the list is filtered to one agent and the sentence above it still says the whole team');

    // And leaving the scope puts the general sentence back, so a filtered
    // sentence cannot outlive the filter.
    w.showRoutinesForAgent(null);
    assert.strictEqual(text(routinesHeader(doc).querySelector('.routines-subtitle')),
      'Every scheduled skill across your team, and when it runs next.');
    dom.window.close();
  });

  test('a scope naming an agent the roster does not have keeps the general sentence', () => {
    const { doc, w, dom } = styled();
    w.agents.push({
      id: 'wren', displayName: 'Wren', colour: '#6BC67E', icon: 'W', status: 'onTeam',
      routines: [routine('Wren nightly', { nextRun: iso(TOMORROWS_SLOT) })],
    });
    w.setNavState = () => {};
    w.showRoutinesForAgent('nobody');
    assert.strictEqual(text(routinesHeader(doc).querySelector('.routines-subtitle')),
      'Every scheduled skill across your team, and when it runs next.',
      'a true general sentence beats a specific one with a hole in it');
    dom.window.close();
  });

  test('the sentence is in the header rather than in a paragraph below it', () => {
    const { doc, dom } = styled();
    const pane = doc.getElementById('routines-content');
    assert.strictEqual(pane.querySelector('.settings-section-title'), null,
      'the settings heading is still on a view that lists things');
    assert.ok(routinesHeader(doc).contains(pane.querySelector('.routines-subtitle')));
    dom.window.close();
  });

  // The empty pane carries the same header, but the header carries the title
  // alone now: the state line moved into the box below it, so the header has
  // nothing left to say about the state of the list.
  test('the empty pane carries the same header, with the title alone', () => {
    const { doc, dom } = styled([], { skills: [] });
    const header = routinesHeader(doc);
    assert.ok(header, 'the empty pane lost the header');
    assert.ok(header.querySelector('.profile-avatar.skill-avatar svg'));
    assert.strictEqual(text(header.querySelector('.profile-name')), 'Routines');
    assert.strictEqual(header.querySelector('.routines-subtitle'), null,
      'the state line is still the header\'s subtitle, so the pane reads as a sentence above a '
      + 'card rather than as a member of it');
    dom.window.close();
  });

  // THE STATE LINE AND THE ACTION ARE ONE THING, PROVEN AGAINST WHAT THE PAGE
  // RESOLVES. A box whose class name is right but which paints no padding is
  // not a box a reader sees as one, so this reads the computed style rather
  // than trusting the class name, and then proves containment with
  // `contains`, which cannot be satisfied by two elements that merely sit
  // near each other in the markup.
  //
  // PADDING, NOT BACKGROUND. jsdom cannot resolve a custom property inside a
  // `background` shorthand, so `background: var(--card)` reads back as no
  // colour at all whether or not the rule is even in the cascade: a proof
  // built on it would pass and fail for reasons that have nothing to do with
  // this card. Padding is a literal px value in the shipped rule, so it
  // resolves the same way a browser resolves it.
  test('the state line and the action are inside the box, not above it', () => {
    const { doc, dom } = styled([]);
    const box = doc.querySelector('#routines-content .routines-empty-card');
    assert.ok(box, 'the empty state has no box');
    const boxStyle = dom.window.getComputedStyle(box);
    assert.notStrictEqual(boxStyle.paddingTop, '0px',
      'sanity: the card resolves no padding, so this is not the box a reader sees');
    assert.strictEqual(boxStyle.textAlign, 'center',
      'sanity: the card resolves none of its own rule, so this is not the box a reader sees');

    const stateLine = doc.querySelector('#routines-content .routines-empty-state');
    assert.ok(stateLine, 'the state line is not on the page');
    assert.strictEqual(text(stateLine), 'No routines yet.');
    assert.ok(box.contains(stateLine), 'the state line sits outside the box');

    const action = doc.querySelector('[data-routines-action="add"]');
    assert.ok(action, 'the action is not on the page');
    assert.ok(box.contains(action), 'the action sits outside the box the state line is in');
    dom.window.close();
  });

  // The state line's own size, now that it lives in the box rather than the
  // header: still the body size the skills pane gives its own state line, and
  // still not the title size, so moving it did not also change what it looks
  // like.
  test('the state line resolves to the same size the skills pane gives its own', () => {
    const { doc, w, dom } = styled([], { skills: [] });
    w.renderSkillsEmpty(false);
    const size = (el) => {
      assert.ok(el, 'an element this compares is not on the page');
      return dom.window.getComputedStyle(el).fontSize;
    };
    const routinesState = size(doc.querySelector('#routines-content .routines-empty-state'));
    assert.strictEqual(routinesState, size(doc.querySelector('#skill-detail-content .skills-empty-state')),
      'the two panes give their state lines different sizes, so they are not one pattern');
    assert.notStrictEqual(routinesState, size(routinesHeader(doc).querySelector('.profile-name')),
      'the state line is set at the title size, which is a type size this card was not asked to move');
    dom.window.close();
  });

  // NO CALL TO ACTION IN THESE EMPTY STATES CARRIES AN ARROW. A control
  // decorated differently from every other control of its kind reads as a
  // different kind of control, and the SVG a browser actually draws is what is
  // checked, not a source-level mention of one.
  test('the add-routine action carries no arrow', () => {
    const { doc, dom } = styled([]);
    const action = doc.querySelector('[data-routines-action="add"]');
    assert.ok(action, 'the action is not on the page');
    assert.strictEqual(action.querySelectorAll('svg').length, 0,
      'the add-routine action carries a glyph no other control of its kind has');
    dom.window.close();
  });

  test('the build-a-skill action carries no arrow either', () => {
    const { doc, w, dom } = styled([], { skills: [] });
    w.getGuide = () => ({ id: 'archivist', displayName: 'Wren', type: 'platform' });
    w.renderRoutines();
    const action = doc.querySelector('[data-routines-action="build-skill"]');
    assert.ok(action, 'the action is not on the page');
    assert.strictEqual(action.querySelectorAll('svg').length, 0);
    dom.window.close();
  });

  test('the refusal still lands on the page whichever state the list is in', () => {
    const { doc, w, dom } = styled();
    w.routinesActionFailed({ message: 'Routine could not be paused.' });
    assert.strictEqual(text(doc.querySelector('[data-routines-problem]')),
      'Routine could not be paused.');
    dom.window.close();
  });
});

describe('the rail says when a routine has failed', () => {
  // The chrome's own stylesheet, loaded into the document so what the dot
  // LOOKS like is read off the element the page emits rather than off a token
  // name written beside it. The routines view's tone proof was once made
  // against a table nothing rendered, and giving a state the wrong colour in
  // CSS moved the page and moved no test.
  const SIDEBAR_CSS = read('public', 'styles', 'components', 'sidebar.css');

  const ran = (name) => routine(name, {
    state: { status: 'completed', duration: 3 }, lastStart: iso(new Date(2026, 7, 20, 7, 0, 12)),
    lastSlot: iso(TODAYS_SLOT), nextRun: iso(TOMORROWS_SLOT),
  });
  const failed = (name) => routine(name, {
    state: { status: 'failed', duration: 0 }, lastStart: iso(TODAYS_SLOT),
    lastSlot: iso(TODAYS_SLOT), nextRun: iso(TOMORROWS_SLOT),
  });
  const interrupted = (name) => routine(name, {
    state: { status: 'interrupted', duration: 0 }, lastStart: iso(TODAYS_SLOT),
    lastSlot: iso(TODAYS_SLOT), nextRun: iso(TOMORROWS_SLOT),
  });
  const missed = (name) => routine(name, {
    state: { status: 'completed', duration: 3 }, lastStart: iso(new Date(2026, 7, 18, 7, 0)),
    lastSlot: iso(new Date(2026, 7, 18, 7, 0)), missedSlot: iso(YESTERDAYS_SLOT),
    nextRun: iso(TODAYS_SLOT),
  });
  const caughtUp = (name) => routine(name, {
    state: { status: 'completed', duration: 3 }, lastStart: iso(new Date(2026, 7, 20, 9, 14)),
    lastSlot: iso(TODAYS_SLOT), nextRun: iso(TOMORROWS_SLOT),
  });
  const paused = (name) => routine(name, { paused: true, nextRun: iso(TOMORROWS_SLOT) });
  // A paused routine whose last run FAILED. This is the fixture the pause
  // clause needs: a paused routine with no run history is indistinguishable
  // from one that has never run, so it passes whether or not pause is read.
  const pausedAfterFailure = (name) => routine(name, {
    state: { status: 'failed', duration: 0 }, lastStart: iso(TODAYS_SLOT),
    lastSlot: iso(TODAYS_SLOT), paused: true, nextRun: iso(TOMORROWS_SLOT),
  });
  const inFlight = (name) => routine(name, {
    state: { status: 'running' }, lastStart: iso(TODAYS_SLOT),
    lastSlot: iso(TODAYS_SLOT), nextRun: iso(TOMORROWS_SLOT),
  });

  // The rail as index.html ships it, with the chrome stylesheet in the
  // document and the real updater cut out of app.js and run against it.
  function railShell(routines) {
    const dom = new JSDOM('<!doctype html><html><head><style>' + TOKENS_CSS + SIDEBAR_CSS
      + '</style></head><body>' + pageParts() + '</body></html>', { runScripts: 'dangerously' });
    const w = dom.window;
    w.eval(EDITOR_MODEL_SRC);
    w.eval(SKILLS_MODEL_SRC);
    w.eval(MODEL_SRC);
    w.agents = [{ id: 'piper', displayName: 'Piper', status: 'onTeam', routines }];
    w.eval('function updateRoutineFailureBadge() {'
      + appPiece(/function updateRoutineFailureBadge\(\) \{([\s\S]*?)\n\}/, 'the routines failure badge')
      + '\n}');
    return { w, doc: w.document, dom };
  }

  const dot = (doc) => doc.querySelector('.nav-item[data-nav="routines"] .nav-badge-failed');

  // What a rendered element is filled with, as the page resolves it. The
  // chrome declares its badges with the `background` shorthand, so that is the
  // property asked for: the longhand a shorthand carrying a custom property
  // never reaches answers with a transparent default and would make every
  // comparison below pass against a badge with no colour at all.
  function fill(dom, el) {
    const value = dom.window.getComputedStyle(el).getPropertyValue('background');
    assert.ok(value && value !== 'rgba(0, 0, 0, 0)',
      'the element resolves to no fill, so nothing here is measuring a colour');
    return value;
  }

  // AC-D1.
  test('a failed most recent completed run raises the dot', () => {
    const { w, doc, dom } = railShell([failed('Nightly report')]);
    w.updateRoutineFailureBadge();
    assert.ok(dot(doc), 'a routine failed overnight and the rail says nothing');
    dom.window.close();
  });

  test('a run the process died inside raises it too', () => {
    const { w, doc, dom } = railShell([interrupted('Nightly report')]);
    w.updateRoutineFailureBadge();
    assert.ok(dot(doc), 'a run that did not finish is not a run that succeeded');
    dom.window.close();
  });

  // AC-D2, and it is the whole reason this card exists. Each of the four
  // asserted on its own, because "none of these four raises it" asserted as
  // one is a single failure that could be any of them.
  test('a missed slot does not raise the dot', () => {
    const { w, doc, dom } = railShell([missed('Nightly report')]);
    w.updateRoutineFailureBadge();
    assert.strictEqual(dot(doc), null,
      'a dot that rises on a missed slot teaches its reader to ignore the dot');
    dom.window.close();
  });

  test('a catch-up does not raise the dot', () => {
    const { w, doc, dom } = railShell([caughtUp('Nightly report')]);
    w.updateRoutineFailureBadge();
    assert.strictEqual(dot(doc), null, 'a late run is a success');
    dom.window.close();
  });

  // THE PAUSE CLAUSE, DRIVEN SO THAT THE PAUSE IS THE ONLY THING BETWEEN THE
  // ROUTINE AND A DOT. A paused routine with no run history proves nothing:
  // the never-run branch answers it either way. This fixture raises the dot
  // the moment the paused flag stops being read.
  test('a paused routine does not raise the dot', () => {
    const { w, doc, dom } = railShell([pausedAfterFailure('Nightly report')]);
    w.updateRoutineFailureBadge();
    assert.strictEqual(dot(doc), null,
      'a paused routine can never succeed again, so a dot it raised could never be cleared');
    dom.window.close();
  });

  test('the same routine unpaused does raise it, so the pause is what decides', () => {
    const { w, doc, dom } = railShell([failed('Nightly report')]);
    w.updateRoutineFailureBadge();
    assert.ok(dot(doc), 'sanity: without the pause this fixture raises the dot');
    dom.window.close();
  });

  // The never-run case is kept, as its own case rather than as the one that
  // discharges the pause clause.
  test('a paused routine that has never run does not raise the dot either', () => {
    const { w, doc, dom } = railShell([paused('Nightly report')]);
    w.updateRoutineFailureBadge();
    assert.strictEqual(dot(doc), null);
    dom.window.close();
  });

  // AC-D3 has no way to fire for a paused routine, which is exactly why pause
  // has to clear the dot rather than merely not raise it: a dot left up by a
  // paused routine would sit there until it was resumed or deleted.
  test('pausing a failed routine clears the dot in the same page', () => {
    const { w, doc, dom } = railShell([failed('Nightly report')]);
    w.updateRoutineFailureBadge();
    assert.ok(dot(doc), 'sanity: the failure raised it');
    w.agents[0].routines = [pausedAfterFailure('Nightly report')];
    w.updateRoutineFailureBadge();
    assert.strictEqual(dot(doc), null,
      'the user paused the routine and the rail is still alarming about it');
    dom.window.close();
  });

  // AC-D1 read literally, at the rail. A failure and then a night with the
  // machine shut is still a failure nobody has seen.
  test('a slot missed after a failure does not mask the failure on the rail', () => {
    const { w, doc, dom } = railShell([routine('Nightly report', {
      state: { status: 'failed', duration: 0 },
      lastStart: iso(new Date(2026, 7, 19, 7, 0)), lastSlot: iso(new Date(2026, 7, 19, 7, 0)),
      missedSlot: iso(YESTERDAYS_SLOT), nextRun: iso(TODAYS_SLOT),
    })]);
    w.updateRoutineFailureBadge();
    assert.ok(dot(doc), 'a missed slot hid a failed run behind the most ordinary event there is');
    dom.window.close();
  });

  test('a run still in flight does not raise the dot', () => {
    const { w, doc, dom } = railShell([inFlight('Nightly report')]);
    w.updateRoutineFailureBadge();
    assert.strictEqual(dot(doc), null,
      'a run that has not finished has no outcome to report yet');
    dom.window.close();
  });

  test('a routine that has never run does not raise the dot', () => {
    const { w, doc, dom } = railShell([routine('Never run', { nextRun: iso(TOMORROWS_SLOT) })]);
    w.updateRoutineFailureBadge();
    assert.strictEqual(dot(doc), null);
    dom.window.close();
  });

  test('a workspace with no routines at all does not raise the dot', () => {
    const { w, doc, dom } = railShell([]);
    w.updateRoutineFailureBadge();
    assert.strictEqual(dot(doc), null);
    dom.window.close();
  });

  // AC-D3, without a reload: the same document, a second roster.
  test('the dot clears when that routine next succeeds, in the same page', () => {
    const { w, doc, dom } = railShell([failed('Nightly report')]);
    w.updateRoutineFailureBadge();
    assert.ok(dot(doc), 'sanity: the failure raised it');
    w.agents[0].routines = [ran('Nightly report')];
    w.updateRoutineFailureBadge();
    assert.strictEqual(dot(doc), null, 'the routine recovered and the rail is still alarming');
    dom.window.close();
  });

  test('the dot is not drawn twice when the failure is still there', () => {
    const { w, doc, dom } = railShell([failed('Nightly report')]);
    w.updateRoutineFailureBadge();
    w.updateRoutineFailureBadge();
    assert.strictEqual(doc.querySelectorAll('.nav-item[data-nav="routines"] .nav-badge-failed').length, 1);
    dom.window.close();
  });

  // AC-D5. One failure among many raises it, and somebody else's success is
  // not that routine's recovery.
  test('one failure among several routines raises the dot', () => {
    const { w, doc, dom } = railShell([ran('First'), missed('Second'), failed('Third'), caughtUp('Fourth')]);
    w.updateRoutineFailureBadge();
    assert.ok(dot(doc), 'a failure was lost among the routines that are fine');
    dom.window.close();
  });

  test('another routine succeeding does not clear a failure', () => {
    const { w, doc, dom } = railShell([failed('First'), routine('Second', { nextRun: iso(TOMORROWS_SLOT) })]);
    w.updateRoutineFailureBadge();
    assert.ok(dot(doc));
    w.agents[0].routines = [failed('First'), ran('Second')];
    w.updateRoutineFailureBadge();
    assert.ok(dot(doc), 'one routine recovering cleared another routine\'s failure');
    dom.window.close();
  });

  test('a failure on any agent raises it, not only the first', () => {
    const { w, doc, dom } = railShell([ran('First')]);
    w.agents.push({ id: 'wren', displayName: 'Wren', status: 'onTeam', routines: [failed('Second')] });
    w.updateRoutineFailureBadge();
    assert.ok(dot(doc), 'only the first agent\'s routines were looked at');
    dom.window.close();
  });

  // AC-D4, PROVEN AGAINST WHAT THE PAGE RESOLVES. The dot's colour is read off
  // the element the updater appended, with the shipped stylesheet in the
  // document, and compared with the badge that already exists beside it. A
  // rule added later that overrides either one changes this answer, which is
  // the property a search of the stylesheet would not have.
  test('the dot resolves to the danger token, not the attention token', () => {
    const { w, doc, dom } = railShell([failed('Nightly report')]);
    w.updateRoutineFailureBadge();
    const failure = fill(dom, dot(doc));

    // The unread badge, drawn onto the same page by the same chrome, so this
    // is two rendered elements compared rather than one string matched.
    const unreadBadge = doc.createElement('span');
    unreadBadge.className = 'nav-badge';
    doc.querySelector('.nav-item[data-nav="conversations"]').appendChild(unreadBadge);
    const attention = fill(dom, unreadBadge);

    assert.strictEqual(failure, 'var(--danger)', 'the dot does not resolve to the danger token');
    assert.strictEqual(attention, 'var(--attention)', 'sanity: the unread badge is still amber');
    assert.notStrictEqual(failure, attention,
      'amber is spent on needs the user rather than on an error, and a failure is an error');
    dom.window.close();
  });

  // Without this, "the dot is not the attention token" would still hold if the
  // two tokens happened to carry the same colour.
  test('the two tokens are different colours', () => {
    const value = (token) => {
      const m = new RegExp(`--${token}:\\s*([^;]+);`).exec(TOKENS_CSS);
      assert.ok(m, `--${token} is declared nowhere`);
      return m[1].trim();
    };
    assert.notStrictEqual(value('danger'), value('attention'),
      'the danger and attention tokens carry the same colour, so the dot says nothing new');
  });

  // AND IT IS RAISED BY THE SURFACE THAT CARRIES IT, not by a call in a test.
  // The roster broadcast is the only thing that tells the client a run
  // finished, so it is the message that has to update the rail. Cut out of
  // app.js and run, so deleting the call fails here rather than leaving the
  // suite green while the dot never appears in the product.
  //
  // THE SERVER HALF IS NOT ASSUMED. broadcastRoutineUpdate in lib/scheduler.js
  // sends `{type: 'agents'}` to every connected client from recordOutcome,
  // which is where both endings of a run land, and that is driven rather than
  // described in "a run reaching an outcome sends the roster to connected
  // clients" in test/unit/scheduler-lib.test.js. Without it, everything below
  // would prove the dot updates on a roster and prove nothing about whether a
  // roster ever arrives.
  test('the roster arriving from the server raises and clears the dot', () => {
    const { w, doc, dom } = railShell([]);
    const body = appPiece(/case 'agents':([\s\S]*?)\bbreak;/, 'the roster case of the client dispatch');
    for (const name of ['renderAgentList', 'renderOrgChart', 'renderConvoList', 'renderRoutines',
      'renderRoutinesPanel']) {
      w[name] = () => {};
    }
    // Also called by the roster case: the workspace the roster was read from.
    // Nothing on the rail reads it, so it is stubbed here and driven where it
    // matters, in test/unit/routines-end-to-end.test.js.
    w.setServingWorkspace = () => {};
    w.d = { type: 'agents', agents: [{ id: 'piper', displayName: 'Piper', status: 'onTeam', routines: [failed('Nightly report')] }] };
    w.eval(`(function () {${body}\n})()`);
    assert.ok(dot(doc), 'a roster carrying a failure arrived and the rail says nothing');

    w.d = { type: 'agents', agents: [{ id: 'piper', displayName: 'Piper', status: 'onTeam', routines: [ran('Nightly report')] }] };
    w.eval(`(function () {${body}\n})()`);
    assert.strictEqual(dot(doc), null, 'the recovery arrived and the rail is still alarming');
    dom.window.close();
  });

  // The badge belongs to the chrome. The view must not reach into the rail,
  // which is the rule the withdrawn presence gate left behind.
  test('the view does not reach into the rail to draw it', () => {
    assert.ok(!/nav-badge-failed/.test(VIEW_SRC),
      'the routines view draws the rail badge, which is the rail rule coming back by hand');
  });
});

// ===== THE ROW FOR A ROUTINE NOBODY HAS TURNED ON =====
//
// After an upgrade these are the rows a person meets, so what they say is the
// whole of whether the upgrade reads as safe or as broken. Asserted against
// the RENDERED row, because a model field nobody draws discharges nothing.
describe('a routine the upgrade held back', () => {
  const HELD = [routine('Held back', { enabled: false, nextRun: iso(TOMORROWS_SLOT) })];

  test('the row offers to turn it on and says Rundock will start running it', () => {
    const { doc, w, dom } = shell(HELD);
    w.renderRoutines();
    const row = rowNamed(doc, 'Held back');
    const words = text(row);
    assert.match(words, /Not running/, 'the row does not say it is not running');
    assert.match(words, /Rundock will start running it/,
      'the row does not say what turning it on does');
    // And it does not promise a run it will not make.
    assert.strictEqual(row.querySelector('.next-run'), null,
      'a routine that will not run still advertises a next run');
    assert.ok(!/Next run/.test(words), `the row still promises a next run: ${words}`);
    dom.window.close();
  });

  test('pressing the offer asks for the routine to be turned on', () => {
    const { doc, w, dom } = shell(HELD);
    w.renderRoutines();
    press(doc, '[data-routines-action="enable"]');
    assert.deepStrictEqual(w.sent,
      [{ type: 'set_routine_enabled', agentId: 'piper', name: 'Held back', occurrence: 0, enabled: true }]);
    dom.window.close();
  });

  // The offer belongs to the state, not to the list. A routine that is running
  // must not carry an invitation to change that.
  // A NAME DOES NOT IDENTIFY A ROUTINE, and this control is addressed by the
  // same triple as every other one on the row. It matters more here than
  // anywhere else on the list: a file full of routines an upgrade held back is
  // exactly where two of one name turn up, and turning on the wrong one starts
  // a job the reader did not ask for while the one they pointed at stays off.
  test('turning on the second of two namesakes says which one', () => {
    const held = [
      routine('Compile the ops summary', { enabled: false, nextRun: iso(TOMORROWS_SLOT) }),
      routine('Compile the ops summary', { enabled: false, nextRun: iso(TOMORROWS_SLOT) }),
    ];
    const { doc, w, dom } = shell(held);
    w.renderRoutines();
    rows(doc)[1].querySelector('[data-routines-action="enable"]').click();
    assert.deepStrictEqual(w.sent, [{
      type: 'set_routine_enabled', agentId: 'piper', name: 'Compile the ops summary',
      occurrence: 1, enabled: true,
    }]);
    dom.window.close();
  });

  // THE DELETE CONFIRMATION DRAWS A ROW TOO, and it makes two decisions about
  // it that nothing was pressing: it withholds every control, and it keeps the
  // schedule fault. Both could have been inverted without a failure.
  //
  // The fault stays because somebody about to remove a routine is entitled to
  // know it was never going to run: that is often the reason they are there.
  // The offer goes because that surface is a question, not a list.
  test('the delete confirmation keeps the schedule fault and offers no controls', () => {
    const { doc, w, dom } = shell([
      routine('Cron one', { schedule: '0 7 * * *', scheduleReadable: false, enabled: true }),
    ]);
    w.renderRoutines();
    press(doc, '.routine-row [data-routines-action="delete"]');
    assert.ok(doc.querySelector('.confirm-card'), 'no confirmation was drawn');
    // The row the confirmation is ABOUT, which it draws beside the card.
    const subject = doc.querySelector('.routines-confirm-subject');
    assert.ok(subject, 'the confirmation names no routine');
    assert.match(text(subject), /cannot read this schedule/i,
      'the confirmation hides that the routine was never going to run');
    assert.strictEqual(subject.querySelector('[data-routines-action="pause"]'), null,
      'the confirmation offers a control on the row it is asking about');
    dom.window.close();
  });

  test('the delete confirmation offers no way to turn a held-back routine on', () => {
    const { doc, w, dom } = shell([
      routine('Held one', { enabled: false, nextRun: iso(TOMORROWS_SLOT) }),
    ]);
    w.renderRoutines();
    press(doc, '.routine-row [data-routines-action="delete"]');
    assert.ok(doc.querySelector('.confirm-card'), 'no confirmation was drawn');
    assert.strictEqual(doc.querySelector('[data-routines-action="enable"]'), null,
      'the confirmation offers to turn on the routine it is asking about deleting');
    dom.window.close();
  });

  test('a routine that is running is offered nothing to turn on', () => {
    const { doc, w, dom } = shell();
    w.renderRoutines();
    assert.strictEqual(doc.querySelector('[data-routines-action="enable"]'), null,
      'an ordinary row offers to turn on a routine that is already on');
    dom.window.close();
  });
});
