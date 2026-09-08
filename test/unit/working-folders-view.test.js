'use strict';
// The working folders block as a person meets it, in Settings under Workspace.
//
// PRESSED, NOT CALLED. Every control here is reached by clicking or typing into
// what the page actually renders, because the value of this surface is entirely
// in what it says and what it does when touched. The rules it describes are
// enforced elsewhere and tested there; what is tested here is that the block
// tells the truth about them and that adding, removing and undoing send exactly
// what the server expects.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf-8');
const VIEW_SRC = read('public', 'views', 'settings.js');
const SETTINGS_CSS = read('public', 'styles', 'views', 'settings.css');
const TOKENS_CSS = read('public', 'styles', 'tokens.css');
const APP_SRC = read('public', 'app.js');

const HOME = '/Users/someone';
const PROJECTS = `${HOME}/Projects`;
const CLAUDE_DIR = `${HOME}/Claude`;

function shell(folders = [], opts = {}) {
  const dom = new JSDOM(
    `<!doctype html><html><head><style>${TOKENS_CSS}${SETTINGS_CSS}</style></head>`
    + '<body><div id="settings-content"></div></body></html>',
    { runScripts: 'dangerously' });
  const w = dom.window;
  w.esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  w.escAttr = (t) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  w.eval(VIEW_SRC);
  w.sent = [];
  w.ws = { readyState: 1, send: (m) => w.sent.push(JSON.parse(m)) };
  w.WebSocket = { OPEN: 1 };
  w.currentView = 'settings';
  w.agents = [];
  w.skills = [];
  w.workspaceMode = opts.mode || 'knowledge';
  // The Workspace pane also draws the runtimes card, which is not what these
  // tests are about: given as the plainest state that renders, so the block
  // under test is reached through the real pane rather than in isolation.
  w.runtimeStatus = null;
  w.currentWorkspacePath = `${HOME}/Workspaces/build-team`;
  w.workingFoldersArrived({ folders, home: HOME, rejected: opts.rejected || [] });
  return { w, doc: w.document };
}

// The block is rendered as part of the Workspace pane, never on its own, so
// every test reaches it the way the product does.
function render(w) {
  w.renderSettingsSection('workspace');
  return w.document.getElementById('settings-content');
}

const rows = (el) => [...el.querySelectorAll('.wf-row')].filter(r => !r.classList.contains('wf-add'));

// ONE PRESS IS ONE INVOCATION. jsdom runs inline onclick attributes itself when
// runScripts is 'dangerously', so dispatching the event AND evaluating the
// attribute fired every handler twice. The tests still passed, because these
// handlers happen to be idempotent on a second call and the assertions read the
// last message rather than counting them, which means a control that sent twice
// would have gone unnoticed. Dispatch only, and count.
function press(doc, selector) {
  const el = doc.querySelector(selector);
  assert.ok(el, `nothing on the page matches ${selector}`);
  el.dispatchEvent(new doc.defaultView.Event('click', { bubbles: true }));
  return el;
}

const sentOf = (w, type) => w.sent.filter(m => m.type === type);

describe('what the block says about what naming a folder does', () => {
  test('it says what naming a folder does NOT do, including the limit in the default mode', () => {
    // The copy must never claim a named folder is covered the way the workspace
    // is. The workspace sits on the macOS Knowledge-mode operating-system write
    // allowlist and a named folder does not, so for terminal writes in the
    // default mode the cards stop and the write still fails. Claiming parity
    // there is the trust-it-with-everything promise this copy exists to avoid.
    //
    // The excluded folder is the RUNTIME's own home, ~/.claude, and it has to be
    // named. Calling it "Rundock's own configuration folder" points a reader at
    // .rundock inside the workspace, which is covered, so it says the opposite
    // of what it means.
    const el = render(shell([{ path: PROJECTS, missing: false }]).w);
    const prose = [...el.querySelectorAll('.wf-prose, .wf-note')].map(n => n.textContent).join(' ');
    assert.match(prose, /Knowledge mode on macOS/i, 'the mode where the limit applies is named');
    assert.match(prose, /refused by the operating system/i, 'and what still refuses, in the reader\'s terms');
    assert.match(prose, /still raises a card/i,
      'and that the refusal comes BACK as a card, which is the part a reader actually meets');
    assert.match(prose, /Code mode is where they end/i, 'and what to do about it');
    assert.match(prose, /Codex are not affected/i,
      'and the runtime this setting never reaches, which no reader could otherwise know');
    assert.match(prose, /~\/\.claude/, 'the excluded folder is named, not described vaguely');
    assert.match(prose, /credentials still ask/i, 'and the guarantee that survives whatever is named');
    assert.doesNotMatch(prose, /covered the same way this workspace/i,
      'no parity claim: the operating-system block breaks it in the default mode');
    assert.doesNotMatch(prose, /full access|complete access|trusted? with everything/i);
  });

  test('it nudges toward a parent, because naming one is the difference between configuring this once and forever', () => {
    const el = render(shell().w);
    const prose = [...el.querySelectorAll('.wf-prose, .wf-note')].map(n => n.textContent).join(' ');
    assert.match(prose, /parent folder/i);
    assert.match(prose, /including projects you start later/i,
      'the reason a parent is worth naming is stated, not just the instruction');
  });

  test('the workspace root is named as already included, and never appears as a row', () => {
    // What is in force must be legible where it is felt. The root is implicit
    // rather than a fixed first row, so the prose has to say so or a reader
    // cannot tell whether it counts.
    const { w } = shell([{ path: PROJECTS, missing: false }]);
    const el = render(w);
    assert.match(el.textContent, /workspace's own folder is already included/i);
    for (const row of rows(el)) {
      assert.doesNotMatch(row.textContent, /build-team/, 'the workspace itself is not listed');
    }
  });
});

describe('the list', () => {
  test('a folder is shown by name over its path, shortened to a tilde', () => {
    const el = render(shell([{ path: PROJECTS, missing: false }]).w);
    const row = rows(el)[0];
    assert.strictEqual(row.querySelector('.wf-name').textContent.trim(), 'Projects');
    assert.strictEqual(row.querySelector('.wf-path').textContent.trim(), '~/Projects',
      'the shared home prefix is the least interesting part of every row');
  });

  test('a folder that has gone is shown as missing, never silently dropped', () => {
    const el = render(shell([{ path: `${HOME}/goloka-trial-results`, missing: true }]).w);
    const row = rows(el)[0];
    assert.ok(row.querySelector('.wf-dot'), 'it carries the marker');
    assert.match(row.textContent, /Folder not found/i);
    assert.match(row.textContent, /starts covering again if it comes back/i,
      'and says what happens next, rather than only that something is wrong');
  });

  test('the empty state still renders the block, so the setting is discoverable before it is used', () => {
    // The mechanism shipped once already with no interface and was therefore
    // never used by anyone. A block that appears only once it has content
    // would repeat that.
    const el = render(shell([]).w);
    assert.ok(el.querySelector('#wf-input'), 'the way in is present with nothing named');
    assert.strictEqual(rows(el).length, 0);
  });
});

describe('adding, removing, and changing your mind', () => {
  test('adding sends the whole list with the new folder appended, and clears the field', () => {
    const { w, doc } = shell([{ path: PROJECTS, missing: false }]);
    render(w);
    doc.getElementById('wf-input').value = '~/Claude';
    press(doc, '.wf-add .settings-btn');
    assert.deepStrictEqual(sentOf(w, 'set_working_folders'),
      [{ type: 'set_working_folders', folders: [PROJECTS, '~/Claude'] }],
      'exactly one message per press, carrying what was typed for the server to normalise');
    assert.strictEqual(doc.getElementById('wf-input').value, '');
  });

  test('removing sends the list without that folder, with no confirmation to click through', () => {
    const { w, doc } = shell([{ path: PROJECTS, missing: false }, { path: CLAUDE_DIR, missing: false }]);
    render(w);
    press(doc, '.wf-row .wf-remove');
    assert.deepStrictEqual(sentOf(w, 'set_working_folders'),
      [{ type: 'set_working_folders', folders: [CLAUDE_DIR] }], 'one press, one message');
  });

  test('a path that would break a JavaScript string literal is still removable', () => {
    // THE PLATFORM THIS SHIPS ON. The remove control used to carry the path
    // inside a JS string literal in an onclick attribute, and HTML escaping does
    // not survive that second parse: `C:\\Users\\tom` gained a tab from \\t,
    // `C:\\Users\\xavier` was a syntax error that did nothing at all, and an
    // apostrophe ended the literal early. Every one of those rows was
    // unremovable, and every test used POSIX paths with no quotes.
    const nasty = [
      { path: 'C:\\Users\\tom\\Projects', missing: false },
      { path: 'C:\\Users\\xavier\\build', missing: false },
      { path: "/home/liam/Liam's Projects", missing: false },
    ];
    for (let i = 0; i < nasty.length; i += 1) {
      const { w, doc } = shell(nasty);
      render(w);
      const buttons = doc.querySelectorAll('.wf-row .wf-remove');
      buttons[i].dispatchEvent(new w.Event('click', { bubbles: true }));
      const sent = sentOf(w, 'set_working_folders');
      assert.strictEqual(sent.length, 1, `${nasty[i].path}: the click must reach the handler at all`);
      assert.deepStrictEqual(sent[0].folders, nasty.filter((_, j) => j !== i).map(f => f.path),
        `${nasty[i].path}: exactly that folder is dropped and the others survive verbatim`);
      // The block redraws when the server answers, so the reply is part of the
      // press: without it there is no undo strip to read, exactly as in the app.
      w.workingFoldersArrived({ folders: nasty.filter((_, j) => j !== i), home: HOME });
      const undo = w.document.querySelector('.wf-undo');
      assert.ok(undo, `${nasty[i].path}: a removal offers an undo`);
      // None of these sit under the fixture's home, so each is shown in full.
      assert.ok(undo.textContent.includes(nasty[i].path),
        `${nasty[i].path}: the undo strip shows the path exactly, got ${undo.textContent.trim()}`);
    }
  });

  test('a removal offers an undo, and taking it sends the folder back', () => {
    // Reversible beats confirmed: an undo strip costs one click to ignore,
    // where a confirmation costs one click every single time.
    const { w, doc } = shell([{ path: PROJECTS, missing: false }, { path: CLAUDE_DIR, missing: false }]);
    render(w);
    press(doc, '.wf-row .wf-remove');
    w.workingFoldersArrived({ folders: [{ path: CLAUDE_DIR, missing: false }], home: HOME });
    const after = w.document.getElementById('settings-content');
    assert.match(after.querySelector('.wf-undo').textContent, /Removed ~\/Projects/);
    press(after.ownerDocument, '.wf-undo-btn');
    assert.deepStrictEqual(w.sent.pop(), { type: 'set_working_folders', folders: [CLAUDE_DIR, PROJECTS] });
  });

  test('the undo strip goes away once something else is named, so it can never restore the wrong thing', () => {
    const { w, doc } = shell([{ path: PROJECTS, missing: false }]);
    render(w);
    press(doc, '.wf-row .wf-remove');
    w.workingFoldersArrived({ folders: [], home: HOME });
    doc.getElementById('wf-input').value = '~/Elsewhere';
    press(w.document, '.wf-add .settings-btn');
    w.workingFoldersArrived({ folders: [{ path: `${HOME}/Elsewhere`, missing: false }], home: HOME });
    assert.strictEqual(w.document.querySelector('.wf-undo'), null);
  });

  test('an empty field adds nothing at all', () => {
    const { w, doc } = shell([]);
    render(w);
    doc.getElementById('wf-input').value = '   ';
    press(doc, '.wf-add .settings-btn');
    assert.strictEqual(w.sent.filter(m => m.type === 'set_working_folders').length, 0);
  });
});

describe('the covered-by hint, which is where the parent nudge is actually taught', () => {
  test('typing a path beneath a named parent says so, as a hint rather than a refusal', () => {
    // Someone typing a covered path has not made an error, they have simply
    // not needed to. Saying so as they type is the one moment the lesson about
    // parents is useful, so it is a hint and the Add button still works.
    const { w, doc } = shell([{ path: PROJECTS, missing: false }]);
    render(w);
    const field = doc.getElementById('wf-input');
    field.value = '~/Projects/alchemist';
    field.dispatchEvent(new w.Event('input', { bubbles: true }));
    w.eval(field.getAttribute('oninput'));
    assert.match(doc.getElementById('wf-hint').textContent, /Already covered by ~\/Projects/);
    assert.doesNotMatch(doc.getElementById('wf-hint').textContent, /cannot|error|invalid/i);
  });

  test('a sibling whose name merely starts the same is not called covered', () => {
    const { w, doc } = shell([{ path: PROJECTS, missing: false }]);
    render(w);
    const field = doc.getElementById('wf-input');
    field.value = '~/Projects-old';
    w.eval(field.getAttribute('oninput'));
    assert.strictEqual(doc.getElementById('wf-hint').textContent, '',
      'Projects-old is not inside Projects, and saying otherwise would be wrong');
  });

  test('the hint clears once the path is no longer covered', () => {
    const { w, doc } = shell([{ path: PROJECTS, missing: false }]);
    render(w);
    const field = doc.getElementById('wf-input');
    field.value = '~/Projects/alchemist';
    w.eval(field.getAttribute('oninput'));
    assert.notStrictEqual(doc.getElementById('wf-hint').textContent, '');
    field.value = '~/Elsewhere';
    w.eval(field.getAttribute('oninput'));
    assert.strictEqual(doc.getElementById('wf-hint').textContent, '');
  });

  test('a path the server refused is named, with the reason, rather than quietly absent', () => {
    const { w } = shell([], { rejected: [] });
    render(w);
    w.workingFoldersArrived({ folders: [], home: HOME, rejected: ['/'] });
    assert.match(w.document.getElementById('wf-hint').textContent, /Could not add \//);
  });
});

describe('the wiring between the server and the screen', () => {
  test('opening the pane asks once, and an answer never asks again', () => {
    // THE LOOP THIS CODE ONCE HAD. The section render issues the request and the
    // reply used to re-enter the section render, so one open produced an endless
    // exchange at network speed, rebuilding the pane each time and wiping
    // whatever was being typed. Counted rather than eyeballed, because the
    // symptom is a number of messages and nothing else.
    const { w, doc } = shell([{ path: PROJECTS, missing: false }]);
    render(w);
    const asksAfterRender = sentOf(w, 'get_working_folders').length;
    assert.strictEqual(asksAfterRender, 1, 'one open of the pane asks exactly once');

    w.workingFoldersArrived({ folders: [{ path: PROJECTS, missing: false }], home: HOME });
    assert.strictEqual(sentOf(w, 'get_working_folders').length, 1,
      'and the answer to that question asks nothing further');

    // What is being typed survives the answer, which the whole-section redraw
    // destroyed on every cycle.
    doc.getElementById('wf-input').value = '~/half-typed';
    w.workingFoldersArrived({ folders: [{ path: PROJECTS, missing: false }], home: HOME });
    assert.strictEqual(w.document.getElementById('wf-input').value, '~/half-typed',
      'an arriving list does not wipe the field someone is typing into');
  });

  test('a working_folders message reaches the block through the app\'s own dispatch', () => {
    // NOT BY CALLING THE HANDLER. Every other test here calls workingFoldersArrived
    // directly, so the one line routing the message to it could be deleted and
    // all of them would still pass while the list never rendered from the server
    // at all. This drives the real dispatch statement cut out of app.js.
    const { w, doc } = shell([]);
    render(w);
    const dispatch = APP_SRC.match(/case 'working_folders':([^\n]*)/);
    assert.ok(dispatch, 'app.js still routes working_folders; if this fails the wiring was removed');
    w.eval(`(function(d){ ${dispatch[1].replace(/break;\s*$/, '')} })({ type: 'working_folders', folders: [{ path: ${JSON.stringify(PROJECTS)}, missing: false }], home: ${JSON.stringify(HOME)} })`);
    const shown = [...w.document.querySelectorAll('.wf-row')].filter(r => !r.classList.contains('wf-add'));
    assert.strictEqual(shown.length, 1, 'the row the message carried is on screen');
    assert.match(shown[0].textContent, /Projects/);
  });
});

describe('switching workspace', () => {
  test('the list is dropped, so another workspace never shows this one\'s folders', () => {
    const { w } = shell([{ path: PROJECTS, missing: false }]);
    render(w);
    assert.strictEqual(rows(w.document.getElementById('settings-content')).length, 1);
    w.workingFoldersWorkspaceChanged();
    assert.strictEqual(rows(render(w)).length, 0);
  });
});
