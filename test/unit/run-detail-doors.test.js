'use strict';
// Every way into the run detail screen, and every reply that reaches it,
// enumerated and PRESSED.
//
// WHY THIS FILE IS A MANIFEST AND NOT A LIST OF TESTS.
//
// The routine editor's doors file exists because four separate reviews each
// found a different way in with no test behind it, and each was fixed by
// testing the one that had been named. None asked what the next one was, so
// the next one arrived. The routines list's doors file exists because the same
// class turned up there immediately. The rule that ended it, and the rule this
// file applies from the first commit rather than after the fourth review: an
// entry point is tested by the surface a user touches, applied to all of them
// rather than to the one most recently found.
//
// So this enumerates three things, checked against the source, so one added
// later fails here until somebody lists it and names the test that presses it:
//
//   DOORS      every call that OPENS this screen
//   REPLIES    every call the client's dispatch makes INTO this screen
//   SHOWN      that the shell can actually reveal what the doors navigate to
//
// AND THE SURFACES ARE PRESSED. The way in is a control on a routines row, and
// it is CLICKED as markup cut out of index.html. Calling openRunDetail
// directly would prove the function works and prove nothing about whether any
// reader can reach it, which is the exact habit that cost two cards five
// review rounds each.
process.env.TZ = 'Europe/London';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf-8');
const APP_SRC = read('public', 'app.js');
const INDEX_SRC = read('public', 'index.html');
const MODEL_SRC = read('public', 'run-detail-model.js');
const VIEW_SRC = read('public', 'views', 'run-detail.js');
// The list this screen is opened from, and everything it needs to draw a row.
const EDITOR_MODEL_SRC = read('public', 'routine-editor-model.js');
const SKILLS_MODEL_SRC = read('public', 'skills-model.js');
const ROUTINES_MODEL_SRC = read('public', 'routines-model.js');
const ROUTINES_VIEW_SRC = read('public', 'views', 'routines.js');

// ===== THE ENUMERATION =====

// Everything this screen exports that OPENS it. The rest of its surface is
// reached from inside.
const ENTRY_CALLS = ['openRunDetail'];

// Every way in, keyed by the call and the file it sits in. Adding one means
// adding a row here, which means naming the test that presses its surface.
const DOORS = [
  {
    call: 'openRunDetail',
    file: 'views/routines.js',
    surface: 'the View last run control on a routines row',
    pressedBy: 'the routines row control opens this screen for that routine',
  },
];

// Every call the client's message dispatch makes INTO this screen. A reply
// that is correct and lands on another screen is the defect the editor card
// was built around, so the calls that carry a reply here are enumerated like
// the ones that open.
const REPLIES = [
  {
    call: 'runArrived',
    on: "case 'run':",
    surface: 'the record coming back from the server',
    pressedBy: 'the record arriving from the server draws this screen',
  },
];

// Ways in that exist in the flow and are deliberately not pressed here, each
// with the reason. A named exclusion is a decision; an unnamed one is how the
// editor's version of this file went round four times.
const NOT_PRESSED = [
  {
    what: 'a keyboard or command-palette route to this screen',
    why: 'there is none. The palette indexes files, conversations, agents and skills, and it '
      + 'reaches no nav section directly, let alone one run. Asserted below rather than asserted by me.',
  },
  {
    what: 'a deep link or a URL naming a run',
    why: 'the client has no router and no URL state at all: every view change goes through '
      + 'switchNav or a destination function. Asserted below rather than asserted by me.',
  },
  {
    what: 'the nav rail',
    why: 'the rail is a map of PLACES and one run is not a place: this screen is always opened '
      + 'from something that names which run. Asserted below by checking the rail has no entry for it.',
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

describe('every way into this screen is enumerated', () => {
  // THE CHECK THAT ENDS THE LOOP. A new way in fails here, by name, until it
  // is listed with the test that presses its surface.
  test('no way into this screen exists that this file does not name', () => {
    const found = [];
    for (const rel of clientFiles()) {
      if (rel === 'public/views/run-detail.js') continue;  // its own declarations
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
      for (const call of ENTRY_CALLS) {
        // A call, not a mention: the name followed by an opening bracket.
        const re = new RegExp(`(?<![.\\w$])${call}\\(`, 'g');
        for (const _ of src.matchAll(re)) found.push(`${call} in ${rel.replace('public/', '')}`);
      }
    }
    assert.deepStrictEqual([...new Set(found)].sort(), [...new Set(DOORS.map(d => `${d.call} in ${d.file}`))].sort(),
      'a way into this screen is not listed in DOORS, or a listed one no longer exists. '
      + 'Add the row and the test that presses its surface, or remove the row.');
  });

  test('no reply reaches this screen that this file does not name', () => {
    const published = Object.keys(require(path.join(ROOT, 'public', 'views', 'run-detail.js')));
    const found = [];
    for (const rel of clientFiles()) {
      if (rel === 'public/views/run-detail.js') continue;
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
      for (const call of published) {
        if (ENTRY_CALLS.includes(call)) continue;  // enumerated above, as a door
        if (new RegExp(`(?<![.\\w$])${call}\\(`).test(src)) found.push(call);
      }
    }
    assert.deepStrictEqual([...new Set(found)].sort(), [...new Set(REPLIES.map(r => r.call))].sort(),
      'the client calls into this screen from somewhere this file does not list, or a listed '
      + 'call no longer exists. Add the row and the test that drives it, or remove the row.');
  });

  test('every door names a test, and every named test exists', () => {
    const suite = fs.readFileSync(__filename, 'utf-8');
    for (const entry of [...DOORS, ...REPLIES]) {
      assert.ok(entry.pressedBy, `${entry.call} needs a test`);
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

  // The three exclusions, checked rather than asserted by me.
  test('nothing reaches this screen except the doors named here', () => {
    const palette = read('public', 'palette-model.js') + read('public', 'views', 'palette.js');
    assert.ok(!/run-detail|openRunDetail/.test(palette),
      'the palette now reaches this screen and needs a row');
    assert.ok(!/<button[^>]*data-nav="run-detail"/.test(INDEX_SRC),
      'the rail now carries an entry for one run, which is not a place');
    for (const rel of clientFiles()) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
      assert.ok(!/window\.location\.hash|popstate|pushState/.test(src),
        `${rel} reads or writes URL state, so a deep link can reach this screen and needs a row`);
    }
  });

  test('every reply is on the case this file says it is on', () => {
    for (const reply of REPLIES) {
      const at = APP_SRC.indexOf(reply.on);
      assert.ok(at !== -1, `app.js no longer carries ${reply.on}`);
      const arm = APP_SRC.slice(at, APP_SRC.indexOf('break;', at));
      assert.ok(new RegExp(`(?<![.\\w$])${reply.call}\\(`).test(arm),
        `${reply.on} no longer calls ${reply.call}`);
    }
  });
});

// ===== PRESSING THEM =====

/**
 * A shell carrying the REAL routines panel and the REAL run detail panel, cut
 * out of index.html rather than written again here.
 *
 * A view that renders into an element the page does not have is a silent
 * no-op, and a copy of the markup in this file would keep passing after the
 * page stopped carrying it.
 */
function shellMarkup() {
  const rail = /<nav class="nav-rail"[\s\S]*?<\/nav>/.exec(INDEX_SRC);
  assert.ok(rail, 'index.html no longer carries a nav rail');
  const routines = /<div id="view-routines"[\s\S]*?<\/div>\s*<\/div>/.exec(INDEX_SRC);
  assert.ok(routines, 'index.html no longer carries the routines view panel');
  const detail = /<div id="view-run-detail"[\s\S]*?<\/div>\s*<\/div>/.exec(INDEX_SRC);
  assert.ok(detail, 'index.html no longer carries the run detail view panel');
  return '<!doctype html><html><body>' + rail[0] + routines[0] + detail[0] + '</body></html>';
}

const ROUTINE = {
  name: 'Compile the ops summary', schedule: 'every day at 07:00', prompt: 'p', runOn: 'local',
  enabled: true, paused: false,
  // A last-run fact, because the way in only appears on a row that has one:
  // a routine that has never run has no record and an entry point onto
  // nothing is worse than none.
  state: { status: 'completed', lastRun: new Date(2026, 7, 24, 7, 0, 20).toISOString() },
  nextRun: new Date(2026, 7, 25, 7, 0).toISOString(),
  lastStart: new Date(2026, 7, 24, 7, 0).toISOString(),
  lastSlot: new Date(2026, 7, 24, 7, 0).toISOString(),
  missedSlot: null,
};

const NOW = new Date(2026, 7, 24, 9, 20);

function shell() {
  const dom = new JSDOM(shellMarkup(), { runScripts: 'dangerously' });
  const w = dom.window;
  w.eval(EDITOR_MODEL_SRC);
  w.eval(SKILLS_MODEL_SRC);
  w.eval(ROUTINES_MODEL_SRC);
  w.eval(ROUTINES_VIEW_SRC);
  w.eval(MODEL_SRC);
  w.eval(VIEW_SRC);
  // TWO ROUTINES, NOT ONE, and that is the difference between a test that can
  // fail and one that cannot. With a single row every index is zero, so a
  // control that opened whichever run happened to be first would pass. The
  // second row is the one pressed below.
  w.agents = [{
    id: 'piper', displayName: 'Piper', colour: '#E87A5A', icon: 'P', status: 'onTeam',
    routines: [{ ...ROUTINE, name: 'Some other routine' }, ROUTINE],
  }];
  w.esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  w.sent = [];
  w.ws = { send: (m) => w.sent.push(JSON.parse(m)) };
  w.shown = null;
  w.showView = (v) => { w.shown = v; };
  w.navState = null;
  w.setNavState = (v) => { w.navState = v; };
  w.switchNav = () => {};
  w.routinesNow = () => NOW;
  w.runDetailNow = () => NOW;
  w.Intl = { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: 'Europe/London' }) }) };
  return { w, doc: w.document, dom };
}

const RECORD = {
  id: 'run-1', agent: 'piper', routine: 'Compile the ops summary', sessionId: 's1',
  status: 'succeeded', startedAt: '2026-08-24T06:00:00.000Z', endedAt: '2026-08-24T06:00:13.000Z',
  durationMs: 13000, error: null,
  files: [{ path: '/w/Ops Summary.md', tool: 'Edit', change: 'edited', at: null, source: 'transcript' }],
  filesStatus: 'known', filesReason: null,
};

describe('the doors, pressed', () => {
  test('the routines row control opens this screen for that routine', () => {
    const { w, doc, dom } = shell();
    w.renderRoutines();
    // PRESSED AS MARKUP. The control is found on the rendered row and clicked,
    // so what it calls is read off the page rather than out of this file.
    const controls = doc.querySelectorAll('[data-routines-action="view-run"]');
    assert.strictEqual(controls.length, 2, 'a row with a last run carries no way into that run');
    // The SECOND row, so a control that opened the first routine whatever was
    // pressed fails here rather than passing on an index that happens to be
    // zero.
    controls[1].click();
    assert.strictEqual(w.shown, 'run-detail', 'the control does not show this screen');
    assert.deepStrictEqual(w.sent, [{ type: 'get_run', agentId: 'piper', routine: 'Compile the ops summary' }],
      'the control opened the screen without asking the server for anything');
    // And the screen it opened is not blank: a door onto an empty panel is a
    // door nobody can tell from a broken one.
    assert.match(doc.getElementById('run-detail-content').textContent, /Compile the ops summary/);
    dom.window.close();
  });

  test('a routine that has never run offers no way into a run it does not have', () => {
    const { w, doc, dom } = shell();
    w.agents[0].routines = w.agents[0].routines.map(r => ({ ...r, state: null, lastStart: null, lastSlot: null }));
    w.renderRoutines();
    assert.strictEqual(doc.querySelector('[data-routines-action="view-run"]'), null,
      'a routine with no last run offers a way into a record that does not exist');
    dom.window.close();
  });

  test('the record arriving from the server draws this screen', () => {
    const { w, doc, dom } = shell();
    w.renderRoutines();
    doc.querySelectorAll('[data-routines-action="view-run"]')[1].click();
    assert.match(doc.getElementById('run-detail-content').textContent, /Reading this run's record/,
      'sanity: the screen is waiting on the reply before it arrives');
    // THE DISPATCH ARM IS CUT OUT OF app.js AND RUN, rather than matched as a
    // string: a case that carries the right words and calls nothing is the
    // defect this enumerates against.
    const at = APP_SRC.indexOf("case 'run':");
    assert.ok(at !== -1, 'app.js no longer carries the run case of the client dispatch');
    const body = APP_SRC.slice(at + "case 'run':".length, APP_SRC.indexOf('break;', at));
    w.d = { type: 'run', runId: null, agentId: 'piper', routine: 'Compile the ops summary', run: RECORD };
    w.eval(`(function () {${body}\n})()`);
    const text = doc.getElementById('run-detail-content').textContent;
    assert.match(text, /Ops Summary\.md/, 'the record arrived and the screen was left on its waiting line');
    assert.match(text, /Edited/);
    dom.window.close();
  });
});

describe('the shell can show what the doors navigate to', () => {
  test('the section the doors ask for is one the shell can reveal', () => {
    // The screen resolves where to go by name. showView hides every panel it
    // knows about and reveals the one asked for, so a panel it does not know
    // about is a screen that opens onto whatever was already there, with
    // nothing thrown and every other test green.
    const known = /function showView\(v\) \{ currentView=v; \[([^\]]*)\]/.exec(APP_SRC);
    assert.ok(known, 'app.js no longer carries showView in the shape this reads');
    const names = known[1].split(',').map(s => s.trim().replace(/^'|'$/g, ''));
    assert.ok(names.includes('run-detail'),
      'showView does not know this panel, so opening it leaves the previous screen on display');
    assert.ok(/id="view-run-detail"/.test(INDEX_SRC), 'index.html carries no panel for this screen');
    assert.ok(/id="run-detail-content"/.test(INDEX_SRC), 'index.html carries no content element for this screen');
    assert.ok(/<script src="\/views\/run-detail\.js"><\/script>/.test(INDEX_SRC),
      'the page does not load this screen, so nothing it exports resolves in a browser');
    assert.ok(/<script src="\/run-detail-model\.js"><\/script>/.test(INDEX_SRC),
      'the page does not load the model this screen reads every word from');
    assert.ok(/<link rel="stylesheet" href="\/styles\/views\/run-detail\.css">/.test(INDEX_SRC),
      'the page does not load this screen\'s stylesheet, so its three tones resolve to nothing');
  });
});
