'use strict';
// The Keep agents inside this workspace row, rendered by the real view and
// pressed the way a person presses it. What is sent, and when, is the
// behaviour: nothing is written until the server is asked, turning off asks
// first, and a row Rundock cannot change offers nothing to press.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf-8');
const VIEW_SRC = read('public', 'views', 'settings.js');
const MODEL_SRC = read('public', 'sandbox-row-model.js');
const HOME = '/Users/someone';

const status = (extra) => ({ type: 'sandbox_status', platform: 'darwin', available: true, present: true, managed: true, on: true, blockOn: true, setBy: 'workspace', enabledElsewhere: [], stored: true, notice: null, ...extra });

function pane({ platform = 'darwin', st = status(), runtime = null } = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="settings-content"></div></body>', { runScripts: 'dangerously' });
  const w = dom.window;
  w.esc = (t) => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  w.escAttr = (t) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  w.eval(MODEL_SRC);
  w.eval(VIEW_SRC);
  w.sent = [];
  Object.assign(w, { serverPlatform: platform, workspaceMode: 'notes', currentView: 'settings', agents: [], skills: [],
    runtimeStatus: runtime, currentWorkspacePath: `${HOME}/team`, WebSocket: { OPEN: 1 },
    ws: { readyState: 1, send: (m) => w.sent.push(JSON.parse(m)) } });
  w.workingFoldersArrived({ folders: [], home: HOME, rejected: [] });
  w.renderSettingsSection('permissions');
  if (st) w.sandboxStatusArrived(st);
  w.sent.length = 0;
  const doc = w.document;
  const row = () => doc.getElementById('sandbox-row');
  const click = (sel) => { const el = doc.querySelector(sel); assert.ok(el, `nothing matches ${sel}`); el.click(); return el; };
  const key = (sel, k) => doc.querySelector(sel).dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  return { w, doc, row, click, key, sent: w.sent };
}

describe('Rundock\'s own block on macOS', () => {
  test('a named switch with On beside it, and the consequence written out', () => {
    const { row } = pane();
    const sw = row().querySelector('[role="switch"]');
    assert.strictEqual(sw.getAttribute('aria-label'), 'Keep agents inside this workspace');
    assert.strictEqual(sw.checked, true);
    assert.strictEqual(row().querySelector('#sandbox-state').textContent, 'On');
    assert.match(row().textContent, /Keeps agents inside a wall macOS enforces: they can change files in this workspace, the folders below, and the temporary folders they need\. Everything else is blocked\./);
    assert.match(row().textContent, /Uses macOS's built-in sandbox\./);
  });

  test('turning off asks first, and nothing is sent until it is answered', () => {
    const { row, click, sent, doc } = pane();
    click('#sandbox-switch');
    assert.deepStrictEqual(sent, [], 'the click alone sends nothing');
    assert.strictEqual(row().querySelector('#sandbox-switch').checked, true, 'and the switch has not moved');
    assert.match(row().textContent, /Turn off\? Agents will be able to change or delete files outside this workspace wherever your account allows\. Rundock will still ask before each change there, unless a folder is added below\./);
    assert.strictEqual(doc.activeElement.id, 'sandbox-keep-on', 'focus lands on the safe answer');
    click('#sandbox-keep-on');
    assert.deepStrictEqual(sent, [], 'Keep it on sends nothing');
    assert.strictEqual(row().querySelector('.wall-confirm'), null);
    assert.strictEqual(doc.activeElement.id, 'sandbox-switch', 'and focus returns to the switch');
  });

  test('Escape answers the question the way Keep it on does', () => {
    const { row, click, key, sent, doc } = pane();
    click('#sandbox-switch');
    key('.wall-confirm', 'Escape');
    assert.deepStrictEqual(sent, []);
    assert.strictEqual(row().querySelector('.wall-confirm'), null);
    assert.strictEqual(doc.activeElement.id, 'sandbox-switch');
  });

  test('Turn it off sends the one message, and the row shows the answer, not the request', () => {
    const { w, row, click, sent } = pane();
    click('#sandbox-switch');
    click('.wall-confirm .settings-btn-danger');
    assert.deepStrictEqual(sent, [{ type: 'set_workspace_sandbox', on: false }]);
    w.sandboxStatusArrived(status({ on: false, blockOn: false }));
    assert.strictEqual(row().querySelector('#sandbox-state').textContent, 'Off');
    assert.match(row().textContent, /Removes the wall macOS enforces: agents can then change or delete files outside this workspace wherever your account allows\. Rundock still asks before each change there, until you add a folder below\./);
  });

  test('turning on is immediate', () => {
    const { click, sent } = pane({ st: status({ on: false, blockOn: false }) });
    click('#sandbox-switch');
    assert.deepStrictEqual(sent, [{ type: 'set_workspace_sandbox', on: true }]);
  });

  test('a write that failed is said beside the switch, and the switch shows what the disk says', () => {
    const { w, row } = pane();
    w.sandboxStatusArrived(status({ on: true, error: 'Could not change this setting: EACCES' }));
    assert.strictEqual(row().querySelector('[role="alert"]').textContent, 'Could not change this setting: EACCES');
    assert.strictEqual(row().querySelector('#sandbox-switch').checked, true);
    assert.strictEqual(row().querySelector('#sandbox-state').textContent, 'On');
  });
});

describe('the one-time notice', () => {
  test('says what was carried over, and its dismiss control is named and sends the dismissal', () => {
    const { doc, sent } = pane({ st: status({ stored: false, notice: 'off', on: false, blockOn: false }) });
    const notice = doc.querySelector('#sandbox-notice-slot .migration-notice');
    assert.strictEqual(notice.querySelector('span').textContent, 'Keeping agents inside this workspace is now its own switch. Yours is still off. Switching between Notes and Code won\'t change it.');
    const dismiss = notice.querySelector('button');
    assert.strictEqual(dismiss.getAttribute('aria-label'), 'Dismiss notice');
    dismiss.click();
    assert.deepStrictEqual(sent, [{ type: 'dismiss_sandbox_notice' }]);
  });

  test('absent when the server offers none', () => {
    assert.strictEqual(pane().doc.querySelector('.migration-notice'), null);
  });
});

describe('a block a person wrote', () => {
  const hand = () => status({ managed: false });
  const review = { folders: [`${HOME}/Projects`, `${HOME}/Sites`], dropped: [{ rule: 'filesystem.denyWrite', value: '*.env' }], on: true, digest: 'abc' };

  test('a read-only status: no switch, nothing to toggle, a lock, and where it was set up', () => {
    const { row } = pane({ st: hand() });
    assert.strictEqual(row().querySelector('[role="switch"]'), null);
    assert.strictEqual(row().querySelector('input'), null);
    assert.ok(row().querySelector('svg.readonly-lock'));
    assert.strictEqual(row().querySelector('#sandbox-state').textContent, 'On');
    assert.strictEqual(row().querySelector('.ownership-note').textContent, 'Set up outside Rundock, in .claude/settings.local.json. Rundock cannot change this switch here.');
  });

  test('bringing the rules in is reviewed first, and Cancel sends nothing', () => {
    const { w, row, click, sent, doc } = pane({ st: hand() });
    click('#sandbox-bring-in');
    assert.deepStrictEqual(sent, [{ type: 'review_sandbox_import' }]);
    w.sandboxStatusArrived({ ...hand(), review });
    const panel = row().querySelector('.wall-review');
    assert.strictEqual(panel.querySelector('.wall-review-title').textContent, 'Bring your custom rules into Rundock?');
    assert.deepStrictEqual([...panel.querySelectorAll('.wall-review-list li')].map((li) => li.textContent), ['~/Projects', '~/Sites']);
    assert.strictEqual(panel.querySelector('.wall-review-warn').textContent, 'Rundock can\'t represent one rule in your file: a custom deny pattern on *.env. Bringing your rules in will drop it.');
    sent.length = 0;
    click('.wall-review .settings-btn');
    assert.deepStrictEqual(sent, [], 'Cancel writes nothing');
    assert.strictEqual(row().querySelector('.wall-review'), null);
    assert.strictEqual(doc.activeElement.id, 'sandbox-bring-in');
  });

  test('Bring in my rules sends the digest of what was reviewed', () => {
    const { w, click, sent } = pane({ st: hand() });
    click('#sandbox-bring-in');
    w.sandboxStatusArrived({ ...hand(), review });
    sent.length = 0;
    click('#sandbox-import-confirm');
    assert.deepStrictEqual(sent, [{ type: 'import_sandbox_rules', digest: 'abc' }]);
  });
});

describe('every platform and runtime is shown honestly', () => {
  test('Windows and Linux: Unavailable, and nothing to press or lock', () => {
    for (const [platform, line] of [['win32', 'Not available on Windows. Your approval settings still apply.'], ['linux', 'Not available on Linux yet. Your approval settings still apply.']]) {
      const { row } = pane({ platform, st: status({ platform, available: false, on: false, blockOn: false }) });
      assert.strictEqual(row().querySelector('#sandbox-state').textContent, 'Unavailable', platform);
      assert.strictEqual(row().querySelector('input, svg, button'), null, `${platform}: nothing switch-shaped`);
      assert.match(row().textContent, new RegExp(line.replace(/\./g, '\\.')));
    }
  });

  test('a Codex default: Status unknown, a lock, and whose it is', () => {
    const { row } = pane({ platform: 'win32', runtime: { defaultRuntime: 'codex', codex: { installed: true, windowsSandbox: false } } });
    assert.strictEqual(row().querySelector('#sandbox-state').textContent, 'Status unknown');
    assert.ok(row().querySelector('svg.readonly-lock'));
    assert.match(row().textContent, /Controlled by Codex, in your own config file\. Rundock can't confirm whether it is active\./);
  });

  test('opening the pane asks for what is in force, and the runtime that decides what the row describes', () => {
    const { w, sent } = pane();
    w.renderSettingsSection('permissions');
    assert.ok(sent.some((m) => m.type === 'get_sandbox_status'));
    assert.ok(sent.some((m) => m.type === 'get_runtime_status'));
  });
});

describe('the folders agents can also change', () => {
  const withFolder = (p) => { p.w.workingFoldersArrived({ folders: [{ path: `${HOME}/Projects`, missing: false }], home: HOME, rejected: [] }); p.sent.length = 0; return p; };

  test('render once, inside the switch card, and nowhere under the mode', () => {
    const { doc } = pane();
    assert.strictEqual(doc.querySelectorAll('#working-folders-block').length, 1);
    assert.strictEqual([...doc.querySelectorAll('.wf-section-head')].filter((h) => h.textContent === 'Folders agents can also change').length, 1);
    assert.ok(doc.querySelector('#sandbox-row').parentElement.contains(doc.querySelector('#working-folders-block')), 'in the same card as the switch');
  });

  test('with the switch on, the sentence says the folders are the exceptions and the rest is blocked', () => {
    const { doc } = pane();
    assert.strictEqual(doc.querySelector('.wf-section-sub').textContent, 'Agents can change files in these folders too. Anywhere else, changes are blocked unless you approve them.');
  });

  test('with it off the list is in force, never muted, says so per mode, and is still added to and removed from', () => {
    for (const [mode, sentence] of [
      ['notes', 'Agents can edit files in these folders without asking. Anywhere else, changes need your approval.'],
      ['code', 'Agents can change files in these folders without asking. Anywhere else, Rundock still asks before a file edit, and before a command it can see reaching outside.'],
    ]) {
      const p = pane({ st: null });
      p.w.workspaceMode = mode;
      p.w.sandboxStatusArrived(status({ on: false, blockOn: false }));
      withFolder(p);
      const block = p.doc.querySelector('#working-folders-block');
      assert.strictEqual(block.className, 'wf-section', `${mode}: not muted`);
      assert.strictEqual(block.querySelector('.wf-section-sub').textContent, sentence, mode);
      p.doc.getElementById('wf-input').value = `${HOME}/Sites`;
      p.click('.wf-add .settings-btn');
      p.click('.wf-remove');
      assert.deepStrictEqual(p.sent.map((m) => m.folders), [[`${HOME}/Projects`, `${HOME}/Sites`], []], mode);
    }
  });

  test('a block a person wrote says nothing about what the folders do, because Rundock cannot', () => {
    const { doc } = pane({ st: status({ managed: false }) });
    assert.strictEqual(doc.querySelector('.wf-section-sub'), null);
  });

  test('a block a person wrote: the folder list says Rundock does not add the folders to it', () => {
    const { doc } = pane({ st: status({ managed: false }) });
    const note = doc.querySelector('#working-folders-block .wf-own-sandbox');
    assert.ok(note, 'the note sits in the working folders section');
    assert.strictEqual(note.textContent, "Because this workspace's sandbox settings are your own, Rundock doesn't add working folders to them. Add each working folder to them yourself so agents can write there and a cd into it carries over.");
    for (const st of [status(), status({ on: false, blockOn: false }), status({ setBy: 'managed', blockOn: false })]) {
      const p = pane({ st });
      assert.strictEqual(p.doc.querySelector('.wf-own-sandbox'), null, 'not where the block is Rundock\'s, or set elsewhere');
    }
  });

  test('a workspace with Codex agents too gets a Codex row beneath the switch', () => {
    const p = pane({ st: null });
    p.w.agents = [{ runtime: 'claude' }, { runtime: 'codex' }];
    p.w.sandboxStatusArrived(status());
    const rows = p.row().querySelectorAll('.wall-row');
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[1].querySelector('.settings-label').textContent, 'Keep Codex agents inside this workspace');
    assert.strictEqual(rows[1].querySelector('[role="switch"]'), null);
    assert.ok(rows[0].querySelector('[role="switch"]'), 'and the Claude Code switch is still there');
  });

  test('turning the switch back on redraws the section and keeps what was being typed', () => {
    const p = pane({ st: status({ on: false, blockOn: false }) });
    p.doc.getElementById('wf-input').value = '~/half-typed';
    p.w.sandboxStatusArrived(status());
    assert.match(p.doc.querySelector('.wf-section-sub').textContent, /changes are blocked unless you approve them/);
    assert.strictEqual(p.doc.getElementById('wf-input').value, '~/half-typed');
  });
});
