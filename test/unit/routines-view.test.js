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
const SKILLS_SRC = read('public', 'views', 'skills.js');
const SKILLS_MODEL_SRC = read('public', 'skills-model.js');

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

function shell(routines = FOUR_ROWS, opts = {}) {
  const dom = new JSDOM('<!doctype html><html><head><style>' + ROUTINES_CSS + '</style></head><body>'
    + pageParts() + '</body></html>', { runScripts: 'dangerously' });
  const w = dom.window;
  w.eval(EDITOR_MODEL_SRC);
  w.eval(MODEL_SRC);
  w.eval(VIEW_SRC);
  w.eval(SKILLS_MODEL_SRC);
  w.eval(SKILLS_SRC);

  w.agents = [{
    id: 'piper', displayName: 'Piper', colour: '#E87A5A', icon: 'P',
    status: 'onTeam', runtime: 'claude', routines,
  }];
  if (opts.guide) w.agents.push({ id: 'doc', displayName: 'Doc', type: 'platform', status: 'onTeam' });
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

  // The condition the owner attached to permanence, checked at the surface:
  // an entry that can be opened onto nothing is what the gate existed to
  // prevent, so permanence is only safe once neither pane can be empty.
  test('neither permanent entry opens onto a pane with nothing in it', () => {
    const { doc, w, dom } = shell([], { skills: [], guide: true });
    w.renderRoutines();
    w.renderSkills();
    for (const id of ['routines-content', 'skill-detail-content']) {
      const pane = doc.getElementById(id);
      assert.ok(pane, `the page carries no ${id} to render into`);
      assert.ok(pane.textContent.replace(/\s+/g, ' ').trim().length > 20,
        `#${id} is a blank pane on a workspace with nothing in it`);
    }
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
    assert.deepStrictEqual(statuses.map(s => s.className),
      ['run-status ok', 'run-status ok-quiet', 'run-status neutral', 'run-status failed']);
    assert.deepStrictEqual(statuses.map(s => text(s)), [
      'Ran today, 7:00am, London time',
      'Caught up: ran today, 9:14am, London time, due 7:00am',
      'Missed: Rundock was closed at 7:00am yesterday, London time',
      'Failed: today, 7:00am, London time',
    ]);
    // The ruling: a late run is a success and keeps the success class, and the
    // one state where nothing ran is the only one told apart by colour.
    assert.match(statuses[1].className, /ok-quiet/, 'a late run must not be dressed as a warning');
    assert.match(statuses[2].className, /neutral/, 'a passed slot is history, not an error');
    dom.window.close();
  });

  // AC-6.
  test('the missed row names the cause and not the routine', () => {
    const { doc, w, dom } = shell();
    w.renderRoutines();
    const missed = text(rows(doc)[2].querySelector('.run-status'));
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
      'Next run: tomorrow, 7:00am, London time',
      'Next run: tomorrow, 7:00am, London time',
      'Next run: today, 7:00am, London time',
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
    const line = text(rows(doc)[2].querySelector('.rr-run-line'));
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
    const meta = text(rows(doc)[0].querySelector('.rr-meta:not(.rr-run-line)'));
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

  test('with no guide the action goes and the state and the mechanism stay', () => {
    const { doc, w, dom } = shell([], { skills: [], guide: false });
    w.renderRoutines();
    const page = text(doc.getElementById('routines-content'));
    assert.match(page, /No routines yet\./);
    assert.match(page, /Routines schedule skills your agents already have\./);
    assert.strictEqual(doc.querySelectorAll('#routines-content button').length, 0,
      'a button was offered with no agent to fulfil it');
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
    assert.match(body, /This stops Piper running Ran on time, every day at 7:00am\./);
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
    assert.deepStrictEqual(w.sent,
      [{ type: 'delete_routine', agentId: 'piper', name: 'Ran on time', occurrence: 0 }]);
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
      [{ type: 'set_routine_paused', agentId: 'piper', name: 'Ran on time', occurrence: 0, paused: true }]);
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
