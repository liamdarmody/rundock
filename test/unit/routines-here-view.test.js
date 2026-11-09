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

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
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
  if (opts.scope) w.routinesScopeAgentId = () => opts.scope;
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

  test('a routine nobody turned on is offered Turn on as it is with routines on, since that writes the agent file every computer reads', () => {
    const held = [routine('Held back', { enabled: false, refusal: 'enabled' })];
    for (const off of [false, true]) {
      const { doc, dom } = shell({ off, computer: COMPUTER }, { routines: held });
      assert.ok(doc.querySelector('[data-routines-action="enable"]'), `Turn on is not offered with routines ${off ? 'off' : 'on'} here`);
      dom.window.close();
    }
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

describe('the switch with no routines listed', () => {
  // A workspace with no routines yet, and a list scoped to an agent that has
  // none: both are drawn by the empty pane, and both are a workspace whose
  // routines can be off on this computer.
  const EMPTY = [
    ['a workspace with no routines yet', { routines: [] }],
    ['a list scoped to an agent with none', { scope: 'nobody' }],
  ];

  for (const [what, opts] of EMPTY) {
    test(`${what}: the row is there, off, with the same words`, () => {
      const { doc, dom } = shell({ off: true, computer: COMPUTER }, opts);
      assert.strictEqual(doc.querySelectorAll('.routine-row').length, 0, 'sanity: nothing is listed');
      assert.ok(doc.querySelector('.routines-empty-card'), 'sanity: the empty pane is drawn');
      assert.strictEqual(doc.querySelectorAll('[data-routines-here]').length, 1, 'the empty pane carries no switch');
      assert.strictEqual(switchOf(doc).checked, false);
      assert.strictEqual(text(doc.querySelector('.routines-here-word')), 'Off');
      assert.strictEqual(text(doc.querySelector('.routines-here-title')), 'Routines are off on this computer');
      assert.strictEqual(text(doc.querySelector('.routines-here-hint')),
        'Nothing in ledger runs on a schedule here. Your other computers are not affected. Turn the switch on to run them here again.');
      dom.window.close();
    });

    test(`${what}: pressing it asks the server, and a failure is said under it`, () => {
      const { w, doc, dom } = shell({ off: true, computer: COMPUTER }, opts);
      switchOf(doc).click();
      assert.deepStrictEqual(w.sent, [{ type: 'set_routines_here', on: true, workspace: LEDGER }]);
      w.routinesHereFailed({ type: 'routines_here_failed', on: true, detail: 'EACCES: permission denied' });
      assert.strictEqual(text(doc.querySelector('[data-routines-here-problem]')),
        'Could not turn routines back on on this computer. They are still off here.');
      assert.strictEqual(switchOf(doc).checked, false);
      dom.window.close();
    });
  }

  test('on, the empty pane draws it on, and pressing it turns routines off', () => {
    const { w, doc, dom } = shell({ off: false, computer: COMPUTER }, { routines: [] });
    assert.strictEqual(switchOf(doc).checked, true);
    switchOf(doc).click();
    assert.deepStrictEqual(w.sent, [{ type: 'set_routines_here', on: false, workspace: LEDGER }]);
    dom.window.close();
  });
});

describe('the focus, across the redraw a press causes', () => {
  test('the switch that was pressed is focused again once the answer is drawn', () => {
    const { w, doc, dom } = shell({ off: false, computer: COMPUTER });
    switchOf(doc).focus();
    switchOf(doc).click();
    w.rosterRoutinesHere = { off: true, computer: COMPUTER };
    w.renderRoutines();
    assert.strictEqual(doc.activeElement, switchOf(doc), 'the redraw left the focus on the page rather than the switch');
    assert.strictEqual(switchOf(doc).checked, false);
    dom.window.close();
  });

  test('a redraw nobody pressed leaves the focus where it was', () => {
    const { w, doc, dom } = shell({ off: false, computer: COMPUTER });
    assert.notStrictEqual(doc.activeElement, switchOf(doc));
    w.renderRoutines();
    assert.notStrictEqual(doc.activeElement, switchOf(doc), 'a redraw pulled the focus onto the switch');
    dom.window.close();
  });
});

// ===== FROM THE SERVER'S ROSTER, THROUGH THE SHELL'S OWN ROSTER CASE =====
//
// Everything above hands the page the switch's state. Here the state is what
// the server's own roster message carries, read from a real record, and it
// reaches the page through app.js's own `agents` case, cut out and run, so a
// roster case that did not record it would leave the page with nothing.

const here = require('../../lib/agents/routines-here.js');
const config = require('../../lib/config.js');
const { rosterMessage } = require('../../lib/agents/discovery.js');
const { handleSetRoutinesHere } = require('../../lib/protocol/handlers/routines-here.js');

const APP_SRC = read('public', 'app.js');
// A named piece of app.js, cut out so it can be RUN. The extraction asserts
// the piece exists, so a renamed or deleted one fails here rather than yielding
// an empty body that passes every assertion about what it did not do.
function appPiece(pattern, label) {
  const found = APP_SRC.match(pattern);
  assert.ok(found && found[1] && found[1].trim(), `app.js no longer carries ${label}`);
  return found[1];
}
const AGENTS_CASE = appPiece(/case 'agents': ([\s\S]*?) break;/, 'the roster case of the client dispatch');
const FAILED_CASE = appPiece(/case 'routines_here_failed':([\s\S]*?)\bbreak;/, 'the switch failure case of the client dispatch');
const WRITERS = [
  appPiece(/(function setServingWorkspace\(path\) \{[\s\S]*?\n\})/, 'the writer for the serving workspace'),
  appPiece(/(function setRosterWorkspace\(path\) \{[\s\S]*?\n\})/, 'the writer for the roster workspace'),
];

// A page that has been told nothing: no roster, no workspace, no switch state.
// Its one way in is `receive`, which runs the shell's own cases.
function window_(routines) {
  const panel = /<div id="view-routines"[\s\S]*?<\/div>\s*<\/div>/.exec(INDEX_SRC);
  assert.ok(panel, 'index.html no longer carries the routines view panel');
  const dom = new JSDOM(`<!doctype html><html><head><style>${ROUTINES_CSS}</style></head><body>${panel[0]}</body></html>`,
    { runScripts: 'dangerously' });
  const w = dom.window;
  for (const src of SCRIPTS) w.eval(src);
  w.skills = [];
  w.skillsLoaded = true;
  w.esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  w.routinesNow = () => NOW;
  w.Intl = { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: 'Europe/London' }) }) };
  for (const src of WRITERS) w.eval(src);
  for (const stub of ['renderAgentList', 'renderOrgChart', 'renderRoutinesPanel', 'renderConvoList', 'runDetailRosterUpdated']) {
    w.eval(`window.${stub} = () => {};`);
  }
  w.eval(`window.receive = function (d) { switch (d.type) { case 'agents': ${AGENTS_CASE} break; case 'routines_here_failed': ${FAILED_CASE} break; } };`);
  // The roster's agents are this page's own fixture, so its rows are known.
  w.withRoutines = routines;
  return { w, doc: w.document, dom };
}

// What the server sends, as the page receives it: the real message, through
// JSON, with the page's fixture agents in place of what discovery found.
function sent(message, w) {
  const d = JSON.parse(JSON.stringify(message));
  // Each routine read out of the workspace the roster names, as discovery reads them.
  if (w.withRoutines) {
    d.agents = [{ id: 'piper', displayName: 'Piper', colour: '#E87A5A', icon: 'P', status: 'onTeam',
      routines: w.withRoutines.map(r => ({ ...r, workspace: d.workspace })) }];
  }
  return d;
}

describe('the switch\'s state, from the server\'s roster', () => {
  let tmp;
  let ledger;
  let record;
  let previousName;
  let previousWorkspace;
  const ACTIVE = [
    routine('Compile the ops summary'),
    routine('Reconcile the delivery log', { schedule: 'every monday at 08:00', nextRun: new Date(2026, 9, 12, 8, 0).toISOString() }),
  ];

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'routines-here-view-')));
    ledger = path.join(tmp, 'ledger');
    fs.mkdirSync(path.join(ledger, '.claude', 'agents'), { recursive: true });
    record = path.join(tmp, 'install', 'routines-here.json');
    fs.mkdirSync(path.dirname(record), { recursive: true });
    here.configureRoutinesHere(record);
    previousName = here.wireHostname(() => `${COMPUTER}.local`);
    previousWorkspace = config.getWorkspace();
    config.setWorkspace(ledger);
  });

  afterEach(() => {
    here.wireHostname(previousName);
    here.configureRoutinesHere(null);
    config.setWorkspace(previousWorkspace);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const rowsSay = (doc) => [...doc.querySelectorAll('.routine-row')].map(r => text(r.querySelector('.next-run')));

  test('off on the record: the switch is off, and every row says so; on again: the switch is on', () => {
    const { w, doc, dom } = window_(ACTIVE);
    w.renderRoutines();
    assert.strictEqual(doc.querySelector('[data-routines-here]'), null, 'sanity: a page told nothing draws no switch');

    here.setOffHere(ledger, true);
    w.receive(sent(rosterMessage([]), w));
    assert.strictEqual(switchOf(doc).checked, false, 'the roster said off and the switch is on');
    assert.strictEqual(text(doc.querySelector('.routines-here-word')), 'Off');
    assert.deepStrictEqual(rowsSay(doc), ['Off on this computer', 'Off on this computer']);
    assert.match(text(doc.querySelector('.routines-here-hint')), /^Nothing in ledger runs on a schedule here\./);

    here.setOffHere(ledger, false);
    w.receive(sent(rosterMessage([]), w));
    assert.strictEqual(switchOf(doc).checked, true, 'the roster said on and the switch is off');
    assert.strictEqual(text(doc.querySelector('.routines-here-word')), 'On');
    assert.match(text(doc.querySelector('.routines-here-hint')), new RegExp(`Applies to ledger on ${COMPUTER} only`));
    for (const said of rowsSay(doc)) assert.match(said, /^Next run/);
    dom.window.close();
  });

  test('a roster with no switch state, from a server with no workspace open, draws no switch and no row saying off', () => {
    // THE CHOICE: no switch. The server sends the state whenever a workspace
    // is open, so a roster without it is one with no workspace, where there is
    // nothing to turn off. A switch drawn then would show a state nobody read,
    // and pressing it would ask about a workspace that is not open.
    const { w, doc, dom } = window_(ACTIVE);
    here.setOffHere(ledger, true);
    w.receive(sent(rosterMessage([]), w));
    assert.strictEqual(switchOf(doc).checked, false, 'sanity: the switch was drawn off');

    config.setWorkspace(null);
    const none = rosterMessage([]);
    assert.strictEqual(none.routinesHere, null, 'sanity: with no workspace open the server sends no switch state');
    w.receive(sent(none, w));
    assert.strictEqual(doc.querySelector('[data-routines-here]'), null, 'a switch was kept from the last roster, or guessed');
    assert.ok(!rowsSay(doc).includes('Off on this computer'), 'a row still says off after the roster stopped saying so');

    // A roster that names a workspace and carries no state is treated the same.
    const { routinesHere, ...bare } = sent(rosterMessage([]), w);
    w.receive({ ...bare, workspace: ledger });
    assert.strictEqual(doc.querySelector('[data-routines-here]'), null);
    dom.window.close();
  });

  test('a record that does not parse reaches the page as on', () => {
    fs.writeFileSync(record, `{"workspaces": {"${ledger}": {"off": true}`);
    const error = console.error;
    console.error = () => {};
    let message;
    try { message = rosterMessage([]); } finally { console.error = error; }
    assert.strictEqual(message.routinesHere.off, false, 'a record nobody can read turned routines off');
    assert.ok(fs.readdirSync(path.dirname(record)).some(n => n.startsWith('routines-here.json.unparsed-')),
      'sanity: the record was set aside');

    const { w, doc, dom } = window_(ACTIVE);
    w.receive(sent(message, w));
    assert.strictEqual(switchOf(doc).checked, true);
    assert.strictEqual(text(doc.querySelector('.routines-here-word')), 'On');
    dom.window.close();
  });

  // Two windows on one server: each window's socket reaches the real route,
  // and every roster the route sends reaches both through their own cases.
  function twoWindows() {
    const windows = [window_(null), window_(null)];
    const ctx = { broadcast: (textSent) => { for (const { w } of windows) w.receive(sent(JSON.parse(textSent), w)); } };
    for (const { w } of windows) {
      w.ws = { send: (textSent) => handleSetRoutinesHere(ctx, { send: (reply) => w.receive(JSON.parse(reply)) }, JSON.parse(textSent)) };
      w.receive(sent(rosterMessage(), w));
    }
    return { windows, ctx };
  }

  test('a failure in one window is dropped there once another window\'s change arrives', (t) => {
    const { windows: [first, second], ctx } = twoWindows();
    assert.strictEqual(switchOf(first.doc).checked, true, 'sanity: both windows start on');

    const error = console.error;
    console.error = () => {};
    t.mock.method(fs, 'renameSync', () => { throw new Error('permission denied'); });
    try { switchOf(first.doc).click(); } finally { t.mock.restoreAll(); console.error = error; }
    assert.strictEqual(text(first.doc.querySelector('[data-routines-here-problem]')),
      'Could not turn routines off on this computer. They are still on here.');

    // A roster that changes nothing about the switch keeps the line.
    ctx.broadcast(JSON.stringify(rosterMessage()));
    assert.ok(first.doc.querySelector('[data-routines-here-problem]'), 'a roster that changed nothing dropped the line');

    switchOf(second.doc).click();
    assert.strictEqual(here.offHere(ledger), true, 'sanity: the second window turned routines off');
    for (const { doc } of [first, second]) assert.strictEqual(switchOf(doc).checked, false);
    assert.strictEqual(first.doc.querySelector('[data-routines-here-problem]'), null,
      'the first window still says its change did not happen, under a switch that now shows it done');
    for (const { dom } of [first, second]) dom.window.close();
  });

  test('a failure is dropped when the window moves to another workspace', (t) => {
    const { windows: [first] } = twoWindows();
    const error = console.error;
    console.error = () => {};
    t.mock.method(fs, 'renameSync', () => { throw new Error('permission denied'); });
    try { switchOf(first.doc).click(); } finally { t.mock.restoreAll(); console.error = error; }
    assert.ok(first.doc.querySelector('[data-routines-here-problem]'), 'sanity: the failure is said');

    const notes = path.join(tmp, 'notes');
    fs.mkdirSync(path.join(notes, '.claude', 'agents'), { recursive: true });
    config.setWorkspace(notes);
    first.w.receive(sent(rosterMessage(), first.w));
    assert.strictEqual(first.doc.querySelector('[data-routines-here-problem]'), null,
      'a failure raised in ledger is still said in notes');
    first.dom.window.close();
  });
});
