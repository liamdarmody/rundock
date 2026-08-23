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
const RAIL_SRC = read('public', 'rail-presence.js');
const VIEW_SRC = read('public', 'views', 'routines.js');
const SKILLS_SRC = read('public', 'views', 'skills.js');

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

function shell(routines = FOUR_ROWS) {
  const dom = new JSDOM('<!doctype html><html><head><style>' + ROUTINES_CSS + '</style></head><body>'
    + '<nav class="nav-rail">'
    + '<button class="nav-item" data-nav="skills"></button>'
    + '<button class="nav-item" data-nav="routines"></button>'
    + '</nav>'
    + '<div id="sidebar-team"><div id="sidebar-routines"></div></div>'
    + '<div id="sidebar-skills"><div class="skills-sidebar-list" id="skills-sidebar-list"></div></div>'
    + '<div id="view-routines"><div id="routines-content"></div></div>'
    + '</body></html>', { runScripts: 'dangerously' });
  const w = dom.window;
  w.eval(EDITOR_MODEL_SRC);
  w.eval(MODEL_SRC);
  w.eval(RAIL_SRC);
  w.eval(VIEW_SRC);
  w.eval(SKILLS_SRC);

  w.agents = [{
    id: 'piper', displayName: 'Piper', colour: '#E87A5A', icon: 'P',
    status: 'onTeam', runtime: 'claude', routines,
  }];
  w.skills = [];
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

describe('the rail icon appears with the first routine', () => {
  // AC-10. The same mechanism the Skills rail uses, not a second
  // implementation of the same rule.
  test('the rail entry is hidden until a routine exists', () => {
    const { doc, w, dom } = shell([]);
    w.renderRoutines();
    assert.strictEqual(doc.querySelector('[data-nav="routines"]').style.display, 'none',
      'a workspace with no routines carries no Routines entry');
    dom.window.close();
  });

  test('the rail entry appears with the first routine', () => {
    const { doc, w, dom } = shell([routine('First', { nextRun: iso(TOMORROWS_SLOT) })]);
    w.renderRoutines();
    assert.strictEqual(doc.querySelector('[data-nav="routines"]').style.display, '');
    dom.window.close();
  });

  test('both rails are gated by the one helper, not by two copies of the rule', () => {
    const { w, dom } = shell([]);
    // Behaviour first: the Skills rail answers to the same call, so the two
    // are not merely similar.
    w.skills = [];
    w.renderSkills();
    assert.strictEqual(dom.window.document.querySelector('[data-nav="skills"]').style.display, 'none');
    w.skills = [{ id: 's', name: 'A skill' }];
    w.renderSkills();
    assert.strictEqual(dom.window.document.querySelector('[data-nav="skills"]').style.display, '');
    // And structurally: neither view reaches for the rail on its own.
    for (const [src, label] of [[VIEW_SRC, 'views/routines.js'], [SKILLS_SRC, 'views/skills.js']]) {
      assert.match(src, /railPresence\(/, `${label} does not use the shared gate`);
      assert.ok(!/nav-item\[data-nav/.test(src.replace(/railPresence\([^)]*\)/g, '')),
        `${label} reaches into the rail itself instead of going through the gate`);
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

describe('the empty state', () => {
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
