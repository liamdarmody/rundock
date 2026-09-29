'use strict';
// Two properties of the settings stylesheet the new panes rely on: every class
// they render has a rule behind it, in every state, and no rule draws a
// coloured border on one side only.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
// A style-drift fixture, from this run or a concurrent one, is not the app's.
const { isDriftFixture } = require('../helpers/drift-fixture.js');

const ROOT = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf-8');
const ALL_CSS = (() => {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.css') && !isDriftFixture(e.name)) out.push(fs.readFileSync(full, 'utf-8'));
    }
  };
  walk(path.join(ROOT, 'public', 'styles'));
  return out.join('\n');
})();
const hasRule = (c) => new RegExp('\\.' + c.replace(/[-]/g, '\\-') + '(?![\\w-])').test(ALL_CSS);

function window() {
  const dom = new JSDOM('<!doctype html><body><div id="settings-content"></div></body>', { runScripts: 'dangerously' });
  const w = dom.window;
  w.esc = (t) => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  w.escAttr = (t) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  for (const f of ['sandbox-row-model.js']) w.eval(read('public', f));
  w.eval(read('public', 'views', 'settings.js'));
  Object.assign(w, { workspaceMode: 'notes', currentView: 'settings', agents: [], skills: [], runtimeStatus: null,
    currentWorkspacePath: '/Users/someone/team', WebSocket: { OPEN: 1 }, ws: { readyState: 1, send() {} } });
  w.workingFoldersArrived({ folders: [{ path: '/Users/someone/Projects', missing: false }], home: '/Users/someone', rejected: [] });
  return w;
}
const base = { type: 'sandbox_status', platform: 'darwin', available: true, present: true, managed: true, on: true, blockOn: true, setBy: 'workspace', enabledElsewhere: [], stored: true, notice: null };
// Every state of the Permissions row, each driven the way a person reaches it.
const PERMISSION_STATES = {
  'on, confirming off': (w) => { w.sandboxStatusArrived(base); w.sandboxSwitchClicked(); },
  'off, with the notice': (w) => w.sandboxStatusArrived({ ...base, on: false, blockOn: false, stored: false, notice: 'off' }),
  'hand-authored, reviewing, with an error': (w) => w.sandboxStatusArrived({ ...base, managed: false, error: 'Could not bring your rules in: x',
    review: { folders: ['/Users/someone/Sites'], dropped: [{ rule: 'excludedCommands', value: 'x' }], digest: 'd' } }),
  'decided by managed settings': (w) => w.sandboxStatusArrived({ ...base, blockOn: false, setBy: 'managed' }),
  'turned on by another file': (w) => w.sandboxStatusArrived({ ...base, blockOn: false, setBy: 'elsewhere', enabledElsewhere: ['~/.claude/settings.json'] }),
  'both runtimes in use': (w) => { w.agents = [{ runtime: 'claude' }, { runtime: 'codex' }]; w.sandboxStatusArrived(base); },
  'Windows': (w) => { w.serverPlatform = 'win32'; w.sandboxStatusArrived({ ...base, platform: 'win32', available: false }); },
  'Codex': (w) => { w.runtimeStatus = { defaultRuntime: 'codex', codex: { windowsSandbox: false } }; w.sandboxStatusArrived(base); },
};

describe('every class the Permissions pane renders has a rule behind it', () => {
  for (const [name, drive] of Object.entries(PERMISSION_STATES)) {
    test(name, () => {
      const w = window();
      w.serverPlatform = 'darwin';
      w.renderSettingsSection('permissions');
      drive(w);
      const used = new Set();
      for (const node of w.document.getElementById('settings-content').querySelectorAll('*')) for (const c of node.classList) used.add(c);
      assert.ok(used.size > 5, 'the pane rendered something to check');
      assert.deepStrictEqual([...used].filter((c) => !hasRule(c)), []);
    });
  }
});

function extensionsWindow(msg) {
  const dom = new JSDOM(`<!doctype html><body><div class="settings-nav">${['packages', 'extensions'].map((x) => `<div class="settings-nav-item" data-settings="${x}"></div>`).join('')}</div><div id="settings-content"></div></body>`, { runScripts: 'dangerously' });
  const w = dom.window;
  w.esc = (t) => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  w.escAttr = (t) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  for (const f of ['packages-decide.js', 'packages-install-model.js', 'packages-manage-model.js', 'extensions-view-model.js']) w.eval(read('public', f));
  w.eval(read('public', 'views', 'settings.js'));
  Object.assign(w, { currentView: 'settings', currentWorkspacePath: '/Users/someone/team', WebSocket: { OPEN: 1 }, ws: { readyState: 1, send() {} } });
  w.showSettingsSection('extensions');
  w.packagesReplyArrived({ type: 'packages_page', receipts: [{ file: 'r.json', source: { id: 'https://github.com/o/a' }, appliedAt: '2026-09-01T00:00:00Z', items: [] }], ...msg });
  w.extensionsRenderIfVisible();
  return w;
}
const EXT = [
  { id: 'a', version: '1.0.0', installedAt: '2026-09-01T00:00:00Z', enabled: true, source: { url: 'https://github.com/o/a' }, refusals: [{ match: 'x', reason: 'r' }] },
  { id: 'b', enabled: false, renderers: [{ target: '.md', declares: 'board' }] },
  { id: 'c', broken: true },
];
const EXTENSION_STATES = {
  'running, with a row that couldn\'t load': () => {},
  'paused': () => {},
  'empty': () => {},
};

describe('every class the Extensions page renders has a rule behind it', () => {
  for (const [name, drive] of Object.entries(EXTENSION_STATES)) {
    test(name, () => {
      const w = extensionsWindow({ extensions: name === 'empty' ? [] : EXT, allOff: name === 'paused' });
      drive(w);
      const used = new Set();
      for (const node of w.document.getElementById('settings-content').querySelectorAll('*')) for (const c of node.classList) used.add(c);
      assert.ok(used.size > 3);
      assert.deepStrictEqual([...used].filter((c) => !hasRule(c)), []);
    });
  }
});

// A rounded card with a coloured stripe down one side is the pattern the
// design system rules out. A side border in the neutral divider is a row
// separator and is fine.
const SIDE = /border-(?:left|right|top|bottom|inline(?:-start|-end)?|block(?:-start|-end)?)\s*:\s*([^;}]+)/g;
function sideBorders(css) {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(SIDE)].map((m) => m[1].trim())
    .filter((v) => !/^(0|none)$/.test(v) && !/var\(--border\)/.test(v));
}

describe('no coloured border on one side only', () => {
  test('the scan catches the pattern it is looking for', () => {
    assert.deepStrictEqual(sideBorders('.x { border-left: 3px solid var(--accent); }'), ['3px solid var(--accent)']);
    assert.deepStrictEqual(sideBorders('.x { border-top: 1px solid var(--border); }'), []);
  });

  test('the settings stylesheet has none', () => {
    assert.deepStrictEqual(sideBorders(read('public', 'styles', 'views', 'settings.css')), []);
  });
});

module.exports = { window, hasRule };
