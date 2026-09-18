'use strict';
// The Permissions section as a person meets it in Settings.
//
// WHY THIS FILE EXISTS. The tools-allowed block shipped with FOUR classes that
// had no rule anywhere in settings.css: .settings-card-title, .settings-card-hint,
// .settings-empty and .settings-row-remove. They were bare elements, so they
// inherited the container's font size and carried no padding, margin or colour,
// and the result reached a release. A full test suite, a pre-commit gate and
// five rounds of independent review all passed over it, because nothing in this
// repository rendered a view against its real stylesheet and asked whether the
// classes it uses exist.
//
// The sibling working-folders test already had the pattern: load the real
// tokens and the real settings.css into jsdom, render the real view, and press
// what the page draws. It was written for one block and never made a rule. So
// the first test below is a rule rather than a case: EVERY class this view
// renders must have a rule behind it, and it fails on any future class that
// does not, not merely on the four that started this.
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
const INDEX_SRC = read('public', 'index.html');
const APP_SRC = read('public', 'app.js');
// Just the nav items, without their onclick attributes running in jsdom.
const NAV_SRC = [...INDEX_SRC.matchAll(/<div class="settings-nav-item[^>]*data-settings="([a-z]+)"[^>]*>/g)]
  .map(m => `<div class="settings-nav-item" data-settings="${m[1]}"></div>`).join('');

// Every stylesheet a settings pane is actually rendered under, so a rule living
// in a shared file counts and only a genuinely unstyled class fails.
const ALL_CSS = (() => {
  const dir = path.join(ROOT, 'public', 'styles');
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      // COMMENTS STRIPPED FIRST. The check below asks whether `.name` appears in
      // this text, and these stylesheets write prose that mentions class names:
      // the .tool-allow-key comment names .settings-value to explain why it
      // diverges from it. Left in, a class mentioned only in a comment counts as
      // styled, and the guard passes over the exact thing it exists to catch.
      else if (e.name.endsWith('.css')) {
        files.push(fs.readFileSync(full, 'utf-8').replace(/\/\*[\s\S]*?\*\//g, ''));
      }
    }
  };
  walk(dir);
  return files.join('\n');
})();

const HOME = '/Users/someone';

function shell(allows = [], opts = {}) {
  const dom = new JSDOM(
    // THE REAL SIDEBAR, lifted out of index.html rather than written here, so a
    // section that is renamed or reordered in the product is renamed here too.
    // showSettingsSection marks the active item, and what redraws after a mode
    // change is read back off it.
    `<!doctype html><html><head><style>${TOKENS_CSS}${SETTINGS_CSS}</style></head>`
    + `<body><div class="settings-nav">${NAV_SRC}</div>`
    + '<div id="settings-content"></div></body></html>',
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
  w.runtimeStatus = null;
  w.currentWorkspacePath = `${HOME}/Workspaces/build-team`;
  w.workingFoldersArrived({ folders: opts.folders || [], home: HOME, rejected: [] });
  w.toolAllowsArrived({ tools: allows });
  return { w, doc: w.document };
}

function render(w) {
  w.renderSettingsSection('permissions');
  return w.document.getElementById('settings-content');
}

function press(doc, selector) {
  const el = doc.querySelector(selector);
  assert.ok(el, `nothing on the page matches ${selector}`);
  el.dispatchEvent(new doc.defaultView.Event('click', { bubbles: true }));
  return el;
}

describe('every class this view renders has a rule behind it', () => {
  test('no element is left to inherit, in either state', () => {
    // THE RULE THAT WOULD HAVE CAUGHT THE ORIGINAL DEFECT. Both states, because
    // only the empty one had ever rendered: nobody had granted a standing allow,
    // so the populated branch and its revoke button were unseen and unstyled.
    for (const allows of [[], ['Bash(git:*)', 'WebFetch(domain:github.com)']]) {
      const { w } = shell(allows);
      const el = render(w);
      const used = new Set();
      for (const node of el.querySelectorAll('*')) {
        for (const c of node.classList) used.add(c);
      }
      assert.ok(used.size > 5, 'the pane rendered something to check');
      const orphans = [...used].filter(c => !new RegExp('\\.' + c.replace(/[-]/g, '\\-') + '(?![\\w-])').test(ALL_CSS));
      assert.deepStrictEqual(orphans, [],
        'a class with no rule is an element left to inherit, which is how four of them reached a release');
    }
  });
});

describe('the Permissions section holds what it should, and only there', () => {
  test('the sidebar offers it between Workspace and Connectors', () => {
    const order = [...INDEX_SRC.matchAll(/data-settings="([a-z]+)"/g)].map(m => m[1]);
    const i = order.indexOf('permissions');
    assert.ok(i > 0, 'the section is in the sidebar');
    assert.ok(order.indexOf('workspace') < i, 'after Workspace');
    assert.ok(i < order.indexOf('connectors'), 'and before Connectors');
  });

  test('mode, working folders and tool allows render here', () => {
    const { w, doc } = shell(['Bash(git:*)'], { folders: [{ path: `${HOME}/Projects`, exists: true }] });
    const el = render(w);
    assert.ok(el.querySelector('.mode-toggle'), 'mode is here');
    assert.ok(el.querySelector('#working-folders-block'), 'working folders are here');
    assert.ok(el.querySelector('#tool-allows-block'), 'tool allows are here');
    void doc;
  });

  test('and no longer on Workspace, so there is only one place to set them', () => {
    // Two ways to set the same thing is worse than either.
    const { w } = shell(['Bash(git:*)']);
    w.renderSettingsSection('workspace');
    const ws = w.document.getElementById('settings-content');
    assert.strictEqual(ws.querySelector('.mode-toggle'), null, 'mode left Workspace');
    assert.strictEqual(ws.querySelector('#working-folders-block'), null, 'folders left Workspace');
    assert.strictEqual(ws.querySelector('#tool-allows-block'), null, 'tool allows left Workspace');
    assert.ok(ws.querySelector('.settings-value'), 'and Workspace still renders what it kept');
  });

  test('it says where a folder approved on a card ends up, now that it ends up somewhere', () => {
    // A permissions view that silently omits a kind of permission is worse than
    // a panel that never claimed to be one. This used to read "not listed here
    // yet", which was true and is not any more: approving a folder on a path
    // card now names it as a working folder, so it appears in the list above.
    // The disclaimer became the omission it was written to prevent.
    const { w } = shell([]);
    const text = render(w).textContent;
    assert.match(text, /approve on a path card is named in the list above/i,
      'the reader is told where the folder they approved went');
    assert.doesNotMatch(text, /not listed here yet/i,
      'and is not still told it went nowhere');
  });
});

describe('the tools-allowed block in both of its states', () => {
  test('empty: it explains the mechanism once, not twice', () => {
    // The old block said it in a hint and again in the empty state, in
    // different words, so an empty list explained itself to the reader twice.
    // ONCE, AND IN BOTH STATES. The first draft put the explanation inside the
    // empty branch, so a populated list explained nothing at all: what these
    // are and how to remove one vanished the moment somebody granted one.
    // Counted on the sentence that belongs to THIS block, not on the phrase
    // "Always allow", which the folder-grants disclaimer also uses for a
    // different thing. A count over the whole view would have failed for a
    // reason that has nothing to do with saying something twice.
    for (const allows of [[], ['Bash(git:*)']]) {
      const { w } = shell(allows);
      const el = render(w);
      const says = (el.textContent.match(/adds one here/g) || []).length;
      assert.strictEqual(says, 1, `the mechanism is stated exactly once (${allows.length} grants)`);
      assert.match(el.textContent, /Removing it means the card asks again/,
        'and it says how to undo a grant in both states, not only when the list is empty');
    }
    const { w } = shell([]);
    const block = render(w).querySelector('#tool-allows-block');
    assert.match(block.textContent, /Nothing yet/);
    assert.strictEqual(block.querySelectorAll('.tool-allow-row').length, 0, 'and no rows');
  });

  test('populated: a key per row, split into tool and scope', () => {
    const { w } = shell(['Bash(git:*)', 'WebFetch(domain:github.com)']);
    const block = render(w).querySelector('#tool-allows-block');
    const rows = block.querySelectorAll('.tool-allow-row');
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].querySelector('.tool-allow-name').textContent, 'Bash');
    assert.strictEqual(rows[0].querySelector('.tool-allow-scope').textContent, '(git:*)');
    assert.strictEqual(rows[0].querySelector('.tool-allow-key').textContent, 'Bash(git:*)',
      'and the whole key is present, in order');
  });

  test('a key with no scope still renders as itself', () => {
    const { w } = shell(['Bash']);
    const key = render(w).querySelector('.tool-allow-key');
    assert.strictEqual(key.textContent, 'Bash');
  });

  test('the key wraps rather than truncating, which is the point of its own class', () => {
    // .settings-value clips to one line with an ellipsis. A permission key
    // cannot: the hidden half is the part that might make a grant dangerous,
    // and this is the string someone reads before deciding to revoke it.
    const { w, doc } = shell(['WebFetch(domain:a-very-long-hostname-that-would-be-clipped.example.com)']);
    const key = render(w).querySelector('.tool-allow-key');
    const style = doc.defaultView.getComputedStyle(key);
    assert.notStrictEqual(style.textOverflow, 'ellipsis', 'it does not clip');
    assert.strictEqual(style.whiteSpace, 'normal', 'it wraps');
  });

  test('revoking sends the key the row is showing, chosen by index', () => {
    const { w, doc } = shell(['Bash(git:*)', 'WebFetch(domain:github.com)']);
    render(w);
    const before = w.sent.length;
    const buttons = doc.querySelectorAll('.tool-allow-row .settings-row-remove');
    assert.strictEqual(buttons.length, 2, 'every row can be revoked');
    buttons[1].dispatchEvent(new doc.defaultView.Event('click', { bubbles: true }));
    const sent = w.sent.slice(before);
    assert.strictEqual(sent.length, 1, 'one press is one message');
    assert.strictEqual(sent[0].key, 'WebFetch(domain:github.com)', 'and it is the row that was pressed');
  });
});

describe('changing the mode leaves you where you were', () => {
  test('the open section is redrawn, not whichever one the handler was written for', () => {
    // FOUND IN A BROWSER, not by a test, and the test that should have caught it
    // asserted only that pressing the toggle SENDS set_workspace_mode. It does.
    // What it never checked is what happens when the answer comes back: the
    // handler named 'workspace' because that is where the mode control used to
    // live, so changing mode from Permissions threw the reader onto a pane they
    // had not asked for. Sending the right message and landing in the right
    // place are two claims, and only one of them was being made.
    //
    // Driven through the real dispatch arm cut out of app.js, so a handler that
    // is renamed or rewritten fails here rather than leaving this untested.
    const arm = APP_SRC.match(/case 'workspace_mode_changed':([\s\S]*?)break;/);
    assert.ok(arm, 'the dispatch arm is still there to drive');

    const { w, doc } = shell([], { mode: 'knowledge' });
    w.showSettingsSection('permissions');
    assert.strictEqual(doc.querySelector('.settings-nav-item.active')?.getAttribute('data-settings'),
      'permissions', 'the reader is on Permissions');

    w.currentView = 'settings';
    w.eval(`(function(){ const d = { mode: 'code' }; ${arm[1]} })();`);

    assert.strictEqual(doc.querySelector('.settings-nav-item.active')?.getAttribute('data-settings'),
      'permissions', 'and is still on Permissions afterwards');
    const el = doc.getElementById('settings-content');
    assert.ok(el.querySelector('.mode-toggle'), 'the pane redrawn is the one with the mode control');
    assert.strictEqual(el.querySelector('.mode-toggle-btn.active').dataset.mode, 'code',
      'showing the mode that was just chosen');
  });
});

describe('mode still does what it did', () => {
  test('each mode renders as selected and describes itself', () => {
    for (const [mode, other] of [['knowledge', 'code'], ['code', 'knowledge']]) {
      const { w, doc } = shell([], { mode });
      render(w);
      const active = doc.querySelector('.mode-toggle-btn.active');
      assert.strictEqual(active.dataset.mode, mode, `${mode} reads as selected`);
      assert.ok(doc.getElementById('mode-description').textContent.trim().length > 20,
        'and says what it means');
      void other;
    }
  });

  test('pressing the other mode asks the server to change it', () => {
    const { w, doc } = shell([], { mode: 'knowledge' });
    render(w);
    const before = w.sent.length;
    press(doc, '.mode-toggle-btn[data-mode="code"]');
    const sent = w.sent.slice(before);
    assert.strictEqual(sent.length, 1, 'one press is one message');
    assert.strictEqual(sent[0].mode, 'code');
  });
});
