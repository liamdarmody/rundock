'use strict';
// The hint that names the setting which would stop repeated permission cards.
//
// Driven through the real client: requests go in through chat.js's
// handlePermissionRequest exactly as the socket delivers them, cards and the
// hint are drawn by renderPermissionCard, and the hint's link opens the real
// Settings pane. What is asserted is what a person would see and what is sent:
// the hint appears on the third card a setting could fix within ten minutes,
// names the setting that fits the card that tripped it, never counts or
// follows a card for a command that can't be undone, comes back only at the
// sixth and twelfth, and its link changes nothing.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf-8');
const SCRIPTS = [
  ['public', 'read-only-shell.js'], ['public', 'permissions.js'], ['public', 'chat-markup.js'],
  ['public', 'repeat-hint-model.js'], ['public', 'sandbox-row-model.js'],
  ['public', 'views', 'settings.js'], ['public', 'views', 'chat.js'],
].map((p) => read(...p));
const Model = require('../../public/repeat-hint-model.js');

const HOME = '/Users/someone';
const FOLDER = `${HOME}/Projects/acme-invoicing`;
const MINUTE = 60 * 1000;
// Messages that would change a setting or answer a card. The link must send none.
const CHANGES = new Set(['set_working_folders', 'set_workspace_mode', 'set_workspace_sandbox', 'add_tool_allow',
  'remove_tool_allow', 'permission_response', 'import_sandbox_rules', 'dismiss_sandbox_notice']);

const command = (cmd) => ({ tool_name: 'Bash', input: { command: cmd } });
const folderWrite = (file) => ({
  tool_name: 'Write', input: { file_path: `${FOLDER}/${file}` },
  boundary: true, resolved_path: `${FOLDER}/${file}`, grant_dir: FOLDER, crossings: [{ path: `${FOLDER}/${file}` }],
});
const sandboxRetry = (cmd) => ({
  tool_name: 'Bash', input: { command: cmd, dangerouslyDisableSandbox: true },
  boundary: true, resolved_path: null, grant_dir: null, crossings: [],
});
const irreversible = () => command('rm -rf build');

function app({ mode = 'notes' } = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="view-settings"><div id="settings-content"></div></div><div id="messages"></div></body>', { runScripts: 'dangerously' });
  const w = dom.window;
  let now = Date.UTC(2026, 9, 7, 9, 0, 0);
  w.esc = (t) => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  w.escAttr = (t) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  w.sent = [];
  Object.assign(w, {
    WebSocket: { OPEN: 1 }, ws: { readyState: 1, send: (m) => w.sent.push(JSON.parse(m)) },
    workspaceMode: mode, serverPlatform: 'darwin', runtimeStatus: null, currentView: 'chat', skills: [],
    currentWorkspacePath: `${HOME}/team`, userScrolledUp: false,
    agents: [{ id: 'mira', displayName: 'Mira' }, { id: 'pike', displayName: 'Pike' }],
    conversations: [{ id: 'c1', agentId: 'mira' }, { id: 'c2', agentId: 'pike' }],
    activeConversation: { id: 'c1' },
    pendingPermissions: new Map(), pendingPermissionsByConvo: new Map(),
    unread: { markPermission() {}, resolvePermission() {} },
    updateUnreadBadge() {}, renderConvoList() {}, getConvoState: () => ({}),
    showView: (v) => { w.currentView = v; },
  });
  for (const src of SCRIPTS) w.eval(src);
  w.Date.now = () => now;
  w.workingFoldersArrived({ folders: [], home: HOME, rejected: [] });
  w.sent.length = 0;
  const doc = w.document;
  let n = 0;
  const ask = (request, convoId = 'c1', id = `r${++n}`) => { w.handlePermissionRequest({ request_id: id, request }, convoId); return id; };
  const hints = () => [...doc.querySelectorAll('.repeat-hint')];
  const hintUnder = (id) => {
    const next = doc.getElementById(`perm-${id}`)?.nextElementSibling;
    return next && next.classList.contains('repeat-hint') ? next : null;
  };
  return { w, doc, ask, hints, hintUnder, advance: (ms) => { now += ms; }, changes: () => w.sent.filter((m) => CHANGES.has(m.type)) };
}

describe('when the hint appears', () => {
  test('on the third card a setting could fix, under that card and outside it', () => {
    const { ask, hints, hintUnder, doc } = app();
    ask(command('npm install sharp'));
    ask(command('mkdir -p src/components'));
    assert.strictEqual(hints().length, 0, 'two cards are not enough');
    const third = ask(command('git checkout -b feature'));
    const hint = hintUnder(third);
    assert.ok(hint, 'the hint sits directly under the third card');
    assert.strictEqual(hints().length, 1);
    assert.strictEqual(doc.getElementById(`perm-${third}`).querySelector('.repeat-hint'), null, 'and never inside it');
  });

  test('only within a rolling ten minutes', () => {
    const { ask, hints, hintUnder, advance } = app();
    ask(command('npm install a'));
    advance(5 * MINUTE);
    ask(command('npm install b'));
    advance(5.5 * MINUTE);
    ask(command('npm install c'));
    assert.strictEqual(hints().length, 0, 'the first card has left the window, so this is the second');
    advance(30 * 1000);
    const id = ask(command('npm install d'));
    assert.ok(hintUnder(id), 'three inside ten minutes again');
  });

  test('a card re-sent on reconnect is not counted twice', () => {
    const { w, ask, hints } = app();
    const id = ask(command('npm install a'));
    w.document.getElementById(`perm-${id}`).remove();
    ask(command('npm install a'), 'c1', id);
    ask(command('npm install b'));
    assert.strictEqual(hints().length, 0);
  });

  test('cards in one conversation do not count toward another', () => {
    const { ask, hints } = app();
    ask(command('npm install a'), 'c2');
    ask(command('npm install b'), 'c2');
    ask(command('npm install c'));
    assert.strictEqual(hints().length, 0);
  });

  test('a card queued while its conversation was off screen gets its hint when the conversation opens', () => {
    const { w, ask, hintUnder } = app();
    ask(command('npm install a'), 'c2');
    ask(command('npm install b'), 'c2');
    const id = ask(command('npm install c'), 'c2');
    assert.strictEqual(w.document.getElementById(`perm-${id}`), null, 'queued, not drawn');
    w.activeConversation = { id: 'c2' };
    w.renderPendingPermissionCards('c2');
    assert.ok(hintUnder(id));
    assert.match(hintUnder(id).textContent, /Pike/);
  });
});

describe('a command that can\'t be undone', () => {
  test('never counts toward the hint', () => {
    const { ask, hints, hintUnder } = app();
    ask(command('npm install a'));
    ask(command('npm install b'));
    const rm = ask(irreversible());
    assert.strictEqual(hints().length, 0, 'it would have been the third');
    assert.strictEqual(hintUnder(rm), null);
    const id = ask(command('npm install c'));
    assert.ok(hintUnder(id), 'the third card a setting could fix still gets it');
  });

  test('never gets the hint, even past the threshold', () => {
    const { ask, hints } = app();
    for (let i = 0; i < 5; i++) ask(irreversible());
    ask(command('git push --force'));
    assert.strictEqual(hints().length, 0);
  });

  test('in Code mode an Always asks verdict never counts', () => {
    const { ask, hints } = app({ mode: 'code' });
    for (let i = 0; i < 4; i++) ask({ ...command('rm -r dist'), code_mode_verdict: { verdict: 'always-asks', reason: 'unsaved-work' } });
    assert.strictEqual(hints().length, 0);
  });
});

describe('which setting is named, read off the card that tripped it', () => {
  test('a folder: Working folder, naming the folder as the person reads it', () => {
    const { ask, hintUnder } = app();
    ask(folderWrite('src/invoice-pdf.js'));
    ask(folderWrite('src/templates/receipt.html'));
    const id = ask(folderWrite('package.json'));
    const hint = hintUnder(id);
    assert.strictEqual(hint.dataset.fix, 'folder');
    assert.strictEqual(hint.textContent.replace('×', '').trim(),
      'This is the third time Mira has asked about ~/Projects/acme-invoicing. Add it as a Working folder and this stops asking.');
    assert.strictEqual(hint.querySelector('b').textContent, '~/Projects/acme-invoicing');
    assert.strictEqual(hint.querySelector('.hint-link').textContent, 'Working folder');
  });

  test('ordinary commands in Notes mode: Code mode', () => {
    const { ask, hintUnder } = app();
    ask(command('npm install sharp'));
    ask(command('mkdir -p src'));
    const hint = hintUnder(ask(command('git checkout -b feature')));
    assert.strictEqual(hint.dataset.fix, 'code');
    assert.strictEqual(hint.textContent.replace('×', '').trim(),
      'This is the third command Mira has needed to ask about. You\'re in Notes mode: switch to Code mode and everyday commands like this run without asking.');
  });

  test('stopped outside with no folder to name: the switch, with its trade-off in the same sentence', () => {
    const { ask, hintUnder } = app();
    ask(sandboxRetry('make install'));
    ask(sandboxRetry('cp report.pdf /Volumes/Backup/'));
    const hint = hintUnder(ask(sandboxRetry('make clean')));
    assert.strictEqual(hint.dataset.fix, 'sandbox');
    assert.ok(hint.classList.contains('caution'));
    assert.strictEqual(hint.querySelector('.hint-link').textContent, 'Keep agents inside this workspace');
    assert.match(hint.textContent, /Turning off Keep agents inside this workspace would stop this, but agents could then change or delete files anywhere your account allows\./);
  });

  test('mixed cards: the latest card decides, and the lead claims only what is true', () => {
    const { ask, hintUnder } = app();
    ask(command('npm install a'));
    ask(command('npm install b'));
    const hint = hintUnder(ask(folderWrite('package.json')));
    assert.strictEqual(hint.dataset.fix, 'folder');
    assert.match(hint.textContent, /^This is the third time Mira has had to ask in the last few minutes\. This one is about ~\/Projects\/acme-invoicing\./);
  });

  test('places with no folder in common are not counted: no one setting would stop them', () => {
    const { ask, hints } = app();
    const scattered = {
      tool_name: 'Bash', input: { command: 'cp a ~/Downloads/a && cp b /Volumes/Backup/b' },
      boundary: true, resolved_path: `${HOME}/Downloads/a`, grant_dir: `${HOME}/Downloads`,
      crossings: [{ path: `${HOME}/Downloads/a` }, { path: '/Volumes/Backup/b' }],
    };
    for (let i = 0; i < 4; i++) ask(scattered);
    assert.strictEqual(hints().length, 0);
  });
});

describe('the Code mode hint is for Notes mode only', () => {
  test('in Code mode ordinary command cards are not counted', () => {
    const { ask, hints } = app({ mode: 'code' });
    for (let i = 0; i < 4; i++) ask(command(`npm install p${i}`));
    assert.strictEqual(hints().length, 0);
  });

  test('a workspace still storing Notes under its old name counts as Notes', () => {
    const { ask, hintUnder } = app({ mode: 'knowledge' });
    ask(command('npm install a'));
    ask(command('npm install b'));
    assert.strictEqual(hintUnder(ask(command('npm install c'))).dataset.fix, 'code');
  });
});

describe('shown once, dismissible, again only at 6 then 12', () => {
  test('dismissing removes it; it returns at the sixth and the twelfth, and never after', () => {
    const { ask, hints, hintUnder } = app();
    const shownAt = [];
    for (let i = 1; i <= 24; i++) {
      const id = ask(command(`npm install p${i}`));
      const hint = hintUnder(id);
      if (hint) {
        shownAt.push(i);
        hint.querySelector('.repeat-hint-x').click();
        assert.strictEqual(hints().length, 0, 'dismissed means gone');
      }
    }
    assert.deepStrictEqual(shownAt, [3, 6, 12]);
  });

  test('not dismissed, it stays put until the sixth, which replaces it', () => {
    const { ask, hints, hintUnder } = app();
    for (let i = 1; i <= 5; i++) ask(command(`npm install p${i}`));
    assert.strictEqual(hints().length, 1);
    const sixth = ask(command('npm install p6'));
    assert.strictEqual(hints().length, 1, 'one hint at a time');
    assert.match(hintUnder(sixth).textContent, /sixth command/);
  });
});

describe('the link opens Settings at the control and changes nothing', () => {
  function threeThenClick(make) {
    const a = app();
    for (let i = 0; i < 3; i++) a.ask(make(i));
    a.hints()[0].querySelector('.hint-link').click();
    return a;
  }

  test('Working folder: the list ringed, the path filled in, nothing added', () => {
    const { w, doc, changes } = threeThenClick((i) => folderWrite(`f${i}.js`));
    assert.strictEqual(w.currentView, 'settings');
    assert.ok(doc.getElementById('working-folders-block').classList.contains('settings-ring'));
    assert.strictEqual(doc.getElementById('wf-input').value, '~/Projects/acme-invoicing');
    assert.strictEqual(doc.activeElement.id, 'wf-input');
    assert.strictEqual(doc.querySelectorAll('.wf-row').length, 0, 'the folder is not in the list');
    assert.deepStrictEqual(changes(), [], 'nothing was sent that changes a setting');
    assert.strictEqual(doc.querySelectorAll('.settings-ring').length, 1, 'one control ringed');
  });

  test('Code mode: the mode control ringed, still in Notes', () => {
    const { w, doc, changes } = threeThenClick((i) => command(`npm install p${i}`));
    assert.ok(doc.querySelector('.mode-toggle').classList.contains('settings-ring'));
    assert.strictEqual(w.workspaceMode, 'notes');
    assert.strictEqual(doc.querySelector('.mode-toggle-btn.active').dataset.mode, 'notes');
    assert.deepStrictEqual(changes(), []);
  });

  test('Keep agents inside this workspace: the switch ringed, still on, no question asked yet', () => {
    const { w, doc, changes } = threeThenClick((i) => sandboxRetry(`make t${i}`));
    w.sandboxStatusArrived({ type: 'sandbox_status', platform: 'darwin', available: true, present: true, managed: true, on: true, setBy: 'workspace', enabledElsewhere: [] });
    const row = doc.getElementById('sandbox-row');
    assert.ok(row.classList.contains('settings-ring'), 'the ring survives the row being redrawn');
    assert.strictEqual(row.querySelector('#sandbox-switch').checked, true);
    assert.strictEqual(row.querySelector('.wall-confirm'), null);
    assert.deepStrictEqual(changes(), []);
  });
});

describe('the model', () => {
  test('cards no setting would stop are never counted', () => {
    const boundary = (c) => ({ tool_name: 'Write', input: { file_path: c.path }, boundary: true, resolved_path: c.path, grant_dir: `${HOME}/.ssh`, crossings: [c] });
    assert.strictEqual(Model.fixFor(boundary({ path: `${HOME}/.ssh/config`, hiddenHome: '.ssh' }), 'notes'), null);
    assert.strictEqual(Model.fixFor(boundary({ path: `${HOME}/.claude/x`, secret: true }), 'notes'), null);
    assert.strictEqual(Model.fixFor(boundary({ path: `${HOME}/.zshrc`, persistenceSurface: true }), 'notes'), null);
    assert.strictEqual(Model.fixFor({ tool_name: 'Write', input: {}, answer_file: true }, 'notes'), null);
    assert.strictEqual(Model.fixFor({ tool_name: 'Write', input: {}, boundary: true, resolved_path: '/x/y', grant_dir: null }, 'notes'), null);
    assert.strictEqual(Model.fixFor({ tool_name: 'mcp__example__create_page', input: {} }, 'notes'), null);
    assert.strictEqual(Model.fixFor({ ...command('git push origin main'), code_mode_verdict: { verdict: 'asks-once', rule: 'Bash:git-push:default-branch' } }, 'code'), null);
  });

  test('the thresholds and the window are the approved ones', () => {
    assert.deepStrictEqual(Model.THRESHOLDS, [3, 6, 12]);
    assert.strictEqual(Model.WINDOW_MS, 10 * MINUTE);
  });
});
