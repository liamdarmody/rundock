'use strict';
// The pieces the browser-and-desktop parity run is built from, proved without
// an engine: the snapshot reads what the row says, the comparison names a
// difference and passes a match, and each case puts a distinct effective
// state on disk. The run itself is test/electron/settings-parity.cjs.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const parity = require('../helpers/settings-parity.js');
const { sandboxStatus } = require('../../lib/workspace/sandbox-status.js');

const ROOT = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf-8');
const made = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

function pane(status) {
  const dom = new JSDOM(`<!doctype html><body><div class="nav-item" data-nav="settings"></div><div class="settings-nav"><div class="settings-nav-item" data-settings="permissions"></div></div><div id="settings-content"></div></body>`, { runScripts: 'dangerously' });
  const w = dom.window;
  w.esc = (t) => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  w.escAttr = (t) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  w.eval(read('public', 'sandbox-row-model.js'));
  w.eval(read('public', 'views', 'settings.js'));
  Object.assign(w, { serverPlatform: 'darwin', workspaceMode: 'notes', currentView: 'settings', agents: [], skills: [], runtimeStatus: null,
    WebSocket: { OPEN: 1 }, ws: { readyState: 1, send() {} } });
  w.workingFoldersArrived({ folders: [], home: '/Users/someone', rejected: [] });
  w.renderSettingsSection('permissions');
  if (status) w.sandboxStatusArrived(status);
  return w;
}
const status = (extra) => ({ type: 'sandbox_status', platform: 'darwin', available: true, present: true, managed: true, on: true, blockOn: true, setBy: 'workspace', enabledElsewhere: [], stored: false, notice: 'on', ...extra });

describe('the snapshot reads the row a person reads', () => {
  test('null until the status arrives, then every field', () => {
    assert.strictEqual(pane(null).eval(parity.SNAPSHOT), null, 'nothing is claimed before the server answers');
    const on = pane(status()).eval(parity.SNAPSHOT);
    assert.deepStrictEqual([on.state, on.control, on.rows], ['On', 'switch-on', 1]);
    assert.match(on.notice, /Yours is still on\./);
    assert.match(on.folders, /changes are blocked unless you approve them/);
    const locked = pane(status({ blockOn: false, setBy: 'elsewhere', enabledElsewhere: ['.claude/settings.json'] })).eval(parity.SNAPSHOT);
    assert.deepStrictEqual([locked.state, locked.control], ['On', 'lock']);
    assert.match(locked.ownership, /Rundock's switch can't turn this off while that file turns it on\./);
  });
});

describe('the comparison', () => {
  test('passes a match and names every field that differs', () => {
    const a = { state: 'On', control: 'switch-on', notice: null };
    assert.deepStrictEqual(parity.compare(a, { ...a }), []);
    assert.deepStrictEqual(parity.compare(a, { ...a, state: 'Off', control: 'switch-off' }), ['state: "On" vs "Off"', 'control: "switch-on" vs "switch-off"']);
    assert.strictEqual(parity.compare(a, null).length, 1, 'a missing snapshot is a difference, never a pass');
  });
});

describe('the cases put three distinct states on disk', () => {
  test('on, off, and on through the project file', () => {
    const fixture = parity.makeFixture();
    made.push(fixture.ws, fixture.home);
    const seen = parity.cases().map((c) => {
      c.apply(fixture);
      const st = sandboxStatus(fixture.ws, 'darwin', { home: fixture.home, managedPath: path.join(fixture.home, 'none.json') });
      return [st.on, st.setBy, st.enabledElsewhere];
    });
    assert.deepStrictEqual(seen, [[true, 'workspace', []], [false, 'workspace', []], [true, 'elsewhere', ['.claude/settings.json']]]);
  });
});

describe('the desktop run starts the real app on a profile and a home of its own', () => {
  test('the bridge check tells the desktop window from a page without the preload', () => {
    const { JSDOM: Dom } = require('jsdom');
    const page = (api) => { const w = new Dom('<!doctype html>', { runScripts: 'dangerously' }).window; if (api) w.electronAPI = api; return JSON.parse(JSON.stringify(w.eval(parity.BRIDGE))); };
    assert.deepStrictEqual(page(null), { bridge: false, storage: false }, 'no preload: no bridge');
    assert.deepStrictEqual(page({ storage: { snapshot: undefined } }), { bridge: true, storage: false }, 'a snapshot the main process never answered');
    assert.deepStrictEqual(page({ storage: { snapshot: { theme: 'dark' } } }), { bridge: true, storage: true });
  });

  test('the launch environment points the app at the fixture and nowhere real', () => {
    const fixture = parity.makeFixture();
    made.push(fixture.ws, fixture.home);
    const profile = parity.desktopProfile();
    made.push(profile);
    assert.ok(fs.existsSync(path.join(profile, '.claude-setup-verified')), 'setup already verified, so no first-run wizard');
    const env = parity.launchEnv(fixture, profile, { PATH: '/bin', RUNDOCK_ELECTRON: '1', ELECTRON_RUN_AS_NODE: '1', RUNDOCK_SMOKE_TEST: '1', WORKSPACE: '/real' });
    assert.deepStrictEqual([env.HOME, env.WORKSPACE, env.RUNDOCK_USER_DATA_DIR, env.RUNDOCK_DISABLE_SCHEDULER, env.PATH], [fixture.home, fixture.ws, profile, '1', '/bin']);
    for (const k of ['RUNDOCK_ELECTRON', 'ELECTRON_RUN_AS_NODE', 'RUNDOCK_SMOKE_TEST']) assert.ok(!(k in env), `${k} is the app's to set, never inherited`);
  });
});
