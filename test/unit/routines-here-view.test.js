'use strict';
// The switch that turns routines off on this computer, as a person meets it on
// the Routines list: the row under the header text, its words on and off, what
// every routine row says while it is off, the keyboard, and a change that could
// not be saved.
//
// PRESSED, NOT CALLED. The switch is clicked as it sits on the page, and what
// it sends is read off the socket. The state it shows is only ever the one the
// server sent on the roster, so the tests hand the page a roster and press.
//
// The clock and the zone are supplied, and the computer's name is made up.
process.env.TZ = 'Europe/London';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf-8');
const INDEX_SRC = read('public', 'index.html');
const SCRIPTS = [
  read('public', 'readable-error.js'),
  read('public', 'routine-editor-model.js'),
  read('public', 'skills-model.js'),
  read('public', 'routines-model.js'),
  read('public', 'routines-scope-model.js'),
  read('public', 'views', 'routines.js'),
];
const ROUTINES_CSS = read('public', 'styles', 'views', 'routines.css');

const LEDGER = '/w/ledger';
const COMPUTER = 'quartz-desk';
const NOW = new Date(2026, 9, 6, 9, 20);

function routine(name, facts) {
  return {
    name, schedule: 'every day at 07:00', prompt: 'p', runOn: 'local', enabled: true, paused: false,
    state: null, nextRun: new Date(2026, 9, 7, 7, 0).toISOString(), lastStart: null, lastSlot: null,
    missedSlot: null, refusal: null, workspace: LEDGER, ...facts,
  };
}

const ROUTINES = [
  routine('Compile the ops summary'),
  routine('Reconcile the delivery log', { schedule: 'every monday at 08:00', nextRun: new Date(2026, 9, 12, 8, 0).toISOString() }),
  routine('Tidy the inbox', { paused: true, refusal: 'paused' }),
];

function shell(here, opts = {}) {
  const panel = /<div id="view-routines"[\s\S]*?<\/div>\s*<\/div>/.exec(INDEX_SRC);
  assert.ok(panel, 'index.html no longer carries the routines view panel');
  const dom = new JSDOM(`<!doctype html><html><head><style>${ROUTINES_CSS}</style></head><body>${panel[0]}</body></html>`,
    { runScripts: 'dangerously' });
  const w = dom.window;
  for (const src of SCRIPTS) w.eval(src);
  w.agents = [{ id: 'piper', displayName: 'Piper', colour: '#E87A5A', icon: 'P', status: 'onTeam', routines: opts.routines || ROUTINES }];
  w.skills = [];
  w.skillsLoaded = true;
  w.esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  w.sent = [];
  w.ws = { send: (msg) => w.sent.push(JSON.parse(msg)) };
  w.routinesNow = () => NOW;
  w.Intl = { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: 'Europe/London' }) }) };
  // What the roster carries, as app.js records it.
  w.rosterWorkspacePath = LEDGER;
  w.servingWorkspacePath = opts.serving === undefined ? LEDGER : opts.serving;
  w.rosterRoutinesHere = here;
  w.renderRoutines();
  return { w, doc: w.document, dom };
}

const text = (el) => el.textContent.replace(/\s+/g, ' ').trim();
const switchOf = (doc) => doc.querySelector('[data-routines-here] input');

describe('the switch row, on', () => {
  test('one row under the header text, with a native switch named for what it does', () => {
    const { doc, dom } = shell({ off: false, computer: COMPUTER });
    const rows = doc.querySelectorAll('[data-routines-here]');
    assert.strictEqual(rows.length, 1, 'the list carries no switch row, or more than one');
    const desc = doc.querySelector('.routines-header-desc');
    assert.ok(desc, 'sanity: the header text is drawn');
    assert.ok(desc.compareDocumentPosition(rows[0]) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
      'the switch row is not under the header text');
    assert.ok(rows[0].compareDocumentPosition(doc.querySelector('.routine-table')) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
      'the switch row is not above the list');

    const input = switchOf(doc);
    assert.strictEqual(input.type, 'checkbox');
    assert.strictEqual(input.getAttribute('role'), 'switch');
    assert.strictEqual(input.getAttribute('aria-label'), 'Routines on this computer');
    assert.strictEqual(input.checked, true);
    assert.strictEqual(text(doc.querySelector('.routines-here-word')), 'On');
    assert.strictEqual(text(doc.querySelector('.routines-here-title')), 'Routines on this computer');
    assert.strictEqual(text(doc.querySelector('.routines-here-hint')),
      'Turn it off here if another computer runs these routines, so each one runs once. '
      + `Applies to ledger on ${COMPUTER} only, and does not sync.`);
    dom.window.close();
  });

  test('the hint says this computer when no name can be read', () => {
    const { doc, dom } = shell({ off: false, computer: null });
    assert.match(text(doc.querySelector('.routines-here-hint')), /Applies to ledger on this computer only, and does not sync\.$/);
    dom.window.close();
  });

  test('every row keeps its next run, and the header its own line', () => {
    const { doc, dom } = shell({ off: false, computer: COMPUTER });
    assert.doesNotMatch(text(doc.getElementById('routines-content')), /Off on this computer/);
    assert.match(text(doc.querySelector('.routines-workspace')), /^These are the routines in ledger\. Rundock runs the routines/);
    dom.window.close();
  });

  test('nothing is drawn before the server has said', () => {
    const { doc, dom } = shell(null);
    assert.strictEqual(doc.querySelector('[data-routines-here]'), null, 'a switch was drawn from a guess');
    dom.window.close();
  });
});

describe('the switch row, off', () => {
  test('the header, the row and every routine row say routines are off here', () => {
    const { doc, dom } = shell({ off: true, computer: COMPUTER });
    assert.strictEqual(text(doc.querySelector('.routines-workspace')),
      'These are the routines in ledger. Routines are off on this computer, so none of these are running here.');
    assert.strictEqual(switchOf(doc).checked, false);
    assert.strictEqual(text(doc.querySelector('.routines-here-word')), 'Off');
    assert.strictEqual(text(doc.querySelector('.routines-here-title')), 'Routines are off on this computer');
    assert.strictEqual(text(doc.querySelector('.routines-here-hint')),
      'Nothing in ledger runs on a schedule here. Your other computers are not affected. Turn the switch on to run them here again.');
    assert.ok(doc.querySelector('[data-routines-here]').classList.contains('off'));

    const rows = [...doc.querySelectorAll('.routine-row')];
    assert.strictEqual(rows.length, 3);
    for (const row of rows) {
      assert.doesNotMatch(text(row), /Next run/, `${text(row.querySelector('.rr-sentence'))} still promises a run`);
    }
    const said = rows.map(r => text(r.querySelector('.next-run')));
    assert.deepStrictEqual(said.sort(), ['Off on this computer', 'Off on this computer', 'Paused'],
      'a routine row does not say Off on this computer, or a paused one stopped saying Paused');
    dom.window.close();
  });

  test('nothing turns amber or red', () => {
    const { doc, dom } = shell({ off: true, computer: COMPUTER });
    const off = [...doc.querySelectorAll('.next-run')].filter(el => text(el) === 'Off on this computer');
    for (const el of off) assert.strictEqual(el.className, 'next-run paused-label rr-paused-label');
    // The rules that draw the row and its words name neither alarm token.
    const own = ROUTINES_CSS.replace(/\/\*[\s\S]*?\*\//g, '').split('}').filter(r => /\.routines-here/.test(r));
    assert.ok(own.length >= 5, 'sanity: the switch row is styled');
    for (const rule of own) assert.doesNotMatch(rule, /--attention|--danger/, `${rule.trim()} is amber or red`);
    assert.strictEqual(doc.querySelector('.routine-row.paused-consent'), null);
    dom.window.close();
  });

  test('a routine nobody turned on is not offered Turn on, which would start nothing here', () => {
    const { doc, dom } = shell({ off: true, computer: COMPUTER }, { routines: [routine('Held back', { enabled: false, refusal: 'enabled' })] });
    assert.strictEqual(doc.querySelector('[data-routines-action="enable"]'), null);
    assert.strictEqual(text(doc.querySelector('.next-run')), 'Off on this computer');
    dom.window.close();
  });

  test('with Rundock moved elsewhere, the header says so, and the switch still shows this workspace\'s setting', () => {
    const { doc, dom } = shell({ off: true, computer: COMPUTER }, { serving: '/w/notes' });
    assert.match(text(doc.querySelector('.routines-workspace')), /Rundock has moved to notes/);
    assert.strictEqual(switchOf(doc).checked, false);
    assert.strictEqual(text(doc.querySelector('.routines-here-title')), 'Routines are off on this computer');
    dom.window.close();
  });
});

describe('pressing it', () => {
  test('is reachable by Tab, and Space on a native switch is a press', () => {
    const { doc, dom } = shell({ off: false, computer: COMPUTER });
    const input = switchOf(doc);
    assert.strictEqual(input.tagName, 'INPUT', 'Space toggles a native checkbox; anything else needs its own key handling');
    assert.ok(input.tabIndex >= 0 && !input.disabled, 'the switch is out of the tab order');
    input.focus();
    assert.strictEqual(doc.activeElement, input);
    dom.window.close();
  });

  test('asks the server, and moves only when the server answers', () => {
    const { w, doc, dom } = shell({ off: false, computer: COMPUTER });
    switchOf(doc).click();
    assert.deepStrictEqual(w.sent, [{ type: 'set_routines_here', on: false, workspace: LEDGER }]);
    assert.strictEqual(switchOf(doc).checked, true, 'the switch moved before the server said anything');

    // The server's answer, on the roster every window gets.
    w.rosterRoutinesHere = { off: true, computer: COMPUTER };
    w.renderRoutines();
    assert.strictEqual(switchOf(doc).checked, false);

    switchOf(doc).click();
    assert.deepStrictEqual(w.sent[1], { type: 'set_routines_here', on: true, workspace: LEDGER });
    dom.window.close();
  });

  test('a change that could not be saved leaves the switch as it was, with a short line under it', () => {
    const { w, doc, dom } = shell({ off: false, computer: COMPUTER });
    switchOf(doc).click();
    w.routinesHereFailed({ type: 'routines_here_failed', on: false, detail: 'EACCES: permission denied' });
    assert.strictEqual(switchOf(doc).checked, true, 'the switch shows a state the record does not hold');
    const problem = doc.querySelector('[data-routines-here-problem]');
    assert.ok(problem, 'nothing said the change did not happen');
    assert.strictEqual(problem.getAttribute('role'), 'alert');
    assert.strictEqual(text(problem), 'Could not turn routines off on this computer. They are still on here.');
    assert.match(text(doc.getElementById('routines-content')), /EACCES: permission denied/, 'the reason is not behind Details');

    // Pressing again clears it.
    switchOf(doc).click();
    w.rosterRoutinesHere = { off: true, computer: COMPUTER };
    w.renderRoutines();
    assert.strictEqual(doc.querySelector('[data-routines-here-problem]'), null);
    dom.window.close();
  });
});

describe('the record that cannot be read', () => {
  test('reads on, so the switch shows On', () => {
    // The server's answer when its record does not parse: on. The record's own
    // handling is driven in test/unit/routines-here.test.js.
    const { doc, dom } = shell({ off: false, computer: COMPUTER });
    assert.strictEqual(switchOf(doc).checked, true);
    assert.strictEqual(text(doc.querySelector('.routines-here-word')), 'On');
    dom.window.close();
  });
});
