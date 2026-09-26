'use strict';
// WHAT THE PERMISSIONS ROW SAYS IS IN FORCE, and the switch's own writes.
//
// The row's first statement is the effective state, read from the files on
// disk, never from the stored switch: a preference that says on beside a block
// that says off is Off. And Rundock writes one settings layer of several, so a
// sandbox another readable layer enables is never reported Off.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildDispatch } = require('../../lib/protocol/handlers/index.js');
const config = require('../../lib/config.js');
const scaffold = require('../../lib/workspace/scaffold.js');
const { sandboxStatus } = require('../../lib/workspace/sandbox-status.js');

const made = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

function tempDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(d);
  return d;
}
// A workspace, and a home with no settings of its own unless a test adds some.
function fixture({ block, state } = {}) {
  const dir = tempDir('sb-status-');
  const home = tempDir('sb-home-');
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.rundock'), { recursive: true });
  if (block !== undefined) fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), JSON.stringify({ sandbox: block }, null, 2));
  if (state) fs.writeFileSync(path.join(dir, '.rundock', 'state.json'), JSON.stringify(state, null, 2));
  return { dir, home, opts: { home, managedPath: path.join(home, 'no-managed-settings.json') } };
}
const ours = (dir, shape) => scaffold.sandboxSettings(dir, 'darwin', os.homedir(), ['/tmp'], [], shape);
const bytes = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf-8') : null);
function captureWs() {
  const sent = [];
  return { sent, send: (m) => sent.push(JSON.parse(m)), readyState: 1 };
}
function withWorkspace(dir, fn) {
  const original = config.getWorkspace();
  config.setWorkspace(dir);
  try { return fn(); } finally { config.setWorkspace(original); }
}

describe('the effective state is read from disk', () => {
  test('a stored switch that says on beside a block that says off reads Off, and the reverse reads On', () => {
    let f = fixture({ state: { sandboxSwitch: 'on' } });
    fs.writeFileSync(path.join(f.dir, '.claude', 'settings.local.json'), JSON.stringify({ sandbox: ours(f.dir, 'off') }));
    assert.strictEqual(sandboxStatus(f.dir, 'darwin', f.opts).on, false);
    f = fixture({ state: { sandboxSwitch: 'off' } });
    fs.writeFileSync(path.join(f.dir, '.claude', 'settings.local.json'), JSON.stringify({ sandbox: ours(f.dir, 'on') }));
    assert.strictEqual(sandboxStatus(f.dir, 'darwin', f.opts).on, true);
  });

  test('no block at all reads Off, and a block a person wrote is read for what it says', () => {
    const none = fixture({});
    assert.deepStrictEqual(
      (({ present, managed, on }) => ({ present, managed, on }))(sandboxStatus(none.dir, 'darwin', none.opts)),
      { present: false, managed: true, on: false });
    const hand = fixture({ block: { enabled: true, filesystem: { allowWrite: ['/a'] } } });
    const st = sandboxStatus(hand.dir, 'darwin', hand.opts);
    assert.deepStrictEqual([st.present, st.managed, st.on], [true, false, true]);
    const handOff = fixture({ block: false });
    const off = sandboxStatus(handOff.dir, 'darwin', handOff.opts);
    assert.deepStrictEqual([off.present, off.managed, off.on], [true, false, false], 'a bare false is a person\'s decision, not Rundock\'s');
  });

  // AN OR, AS THE RUNTIME SHIPS IT. Claude Code 2.1.281 reads the enable as
  // [...layers, localSettings].some(e => e?.sandbox?.enabled === !0), so any
  // layer that turns it on keeps it on, whatever Rundock's own block says.
  const on = JSON.stringify({ sandbox: { enabled: true } });
  const off = JSON.stringify({ sandbox: { enabled: false } });
  function layers(f, { user, project, managed }) {
    if (user) { fs.mkdirSync(path.join(f.home, '.claude'), { recursive: true }); fs.writeFileSync(path.join(f.home, '.claude', 'settings.json'), user); }
    if (project) fs.writeFileSync(path.join(f.dir, '.claude', 'settings.json'), project);
    if (managed) fs.writeFileSync(f.opts.managedPath, managed);
  }
  const read = (f) => (({ on: o, setBy, enabledElsewhere }) => [o, setBy, enabledElsewhere])(sandboxStatus(f.dir, 'darwin', f.opts));

  test('an on in the user\'s or the project\'s own settings keeps it On beside Rundock\'s off, and the file is named', () => {
    for (const [where, label] of [['user', '~/.claude/settings.json'], ['project', '.claude/settings.json']]) {
      const f = fixture({ state: { sandboxSwitch: 'off' } });
      fs.writeFileSync(path.join(f.dir, '.claude', 'settings.local.json'), JSON.stringify({ sandbox: ours(f.dir, 'off') }));
      layers(f, { [where]: on });
      assert.deepStrictEqual(read(f), [true, 'elsewhere', [label]], where);
    }
  });

  test('an off elsewhere never turns off Rundock\'s on', () => {
    const f = fixture({});
    fs.writeFileSync(path.join(f.dir, '.claude', 'settings.local.json'), JSON.stringify({ sandbox: ours(f.dir, 'on') }));
    layers(f, { user: off, project: off, managed: off });
    assert.deepStrictEqual(read(f), [true, 'workspace', []]);
  });

  test('managed settings that turn it on show as the organisation\'s, over Rundock\'s off', () => {
    const f = fixture({});
    fs.writeFileSync(path.join(f.dir, '.claude', 'settings.local.json'), JSON.stringify({ sandbox: ours(f.dir, 'off') }));
    layers(f, { managed: on, user: on });
    assert.deepStrictEqual(read(f).slice(0, 2), [true, 'managed']);
  });

  test('nothing anywhere turning it on is Off', () => {
    const f = fixture({});
    fs.writeFileSync(path.join(f.dir, '.claude', 'settings.local.json'), JSON.stringify({ sandbox: ours(f.dir, 'off') }));
    layers(f, { user: off });
    assert.deepStrictEqual(read(f), [false, 'workspace', []]);
  });

  test('off macOS nothing is available, and nothing is claimed', () => {
    const f = fixture({});
    for (const platform of ['win32', 'linux']) {
      const st = sandboxStatus(f.dir, platform, f.opts);
      assert.strictEqual(st.available, false);
      assert.strictEqual(st.notice, null);
    }
  });
});

describe('the one-time notice', () => {
  test('shown to an existing workspace whose block is Rundock\'s, with its carried-over state', () => {
    for (const [mode, shape, word] of [['knowledge', 'on', 'on'], ['code', 'off', 'off']]) {
      const f = fixture({ state: { workspaceMode: mode } });
      fs.writeFileSync(path.join(f.dir, '.claude', 'settings.local.json'), JSON.stringify({ sandbox: ours(f.dir, shape) }));
      assert.strictEqual(sandboxStatus(f.dir, 'darwin', f.opts).notice, word, mode);
    }
  });

  test('never shown once the switch is stored, nor to a hand-authored block', () => {
    const stored = fixture({ state: { workspaceMode: 'knowledge', sandboxSwitch: 'on' } });
    fs.writeFileSync(path.join(stored.dir, '.claude', 'settings.local.json'), JSON.stringify({ sandbox: ours(stored.dir, 'on') }));
    assert.strictEqual(sandboxStatus(stored.dir, 'darwin', stored.opts).notice, null);
    const hand = fixture({ block: { enabled: true, filesystem: { allowWrite: ['/a'] } }, state: { workspaceMode: 'code' } });
    assert.strictEqual(sandboxStatus(hand.dir, 'darwin', hand.opts).notice, null);
  });

  test('dismissing it pins the state it described, and it does not come back', () => {
    const f = fixture({ state: { workspaceMode: 'code' } });
    fs.writeFileSync(path.join(f.dir, '.claude', 'settings.local.json'), JSON.stringify({ sandbox: ours(f.dir, 'off') }));
    const before = bytes(path.join(f.dir, '.claude', 'settings.local.json'));
    withWorkspace(f.dir, () => {
      const ws = captureWs();
      buildDispatch().dismiss_sandbox_notice({}, ws, {}, 'darwin');
      assert.strictEqual(ws.sent[0].type, 'sandbox_status');
      assert.strictEqual(ws.sent[0].notice, null);
    });
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(f.dir, '.rundock', 'state.json'), 'utf-8')).sandboxSwitch, 'off');
    assert.strictEqual(bytes(path.join(f.dir, '.claude', 'settings.local.json')), before, 'the block is untouched');
  });
});

describe('asking for the status', () => {
  test('the reply is the status read from disk, and with no workspace open nothing is claimed', () => {
    const f = fixture({ state: { workspaceMode: 'notes', sandboxSwitch: 'on' } });
    withWorkspace(f.dir, () => {
      const ws = captureWs();
      buildDispatch().get_sandbox_status({}, ws, {}, 'darwin');
      assert.strictEqual(ws.sent.length, 1);
      assert.deepStrictEqual(ws.sent[0], sandboxStatus(f.dir, 'darwin'));
      assert.strictEqual(ws.sent[0].error, undefined, 'a plain request carries no error');
    });
    withWorkspace(null, () => {
      const ws = captureWs();
      buildDispatch().get_sandbox_status({}, ws, {}, 'darwin');
      assert.strictEqual(ws.sent[0].type, 'sandbox_status');
      assert.strictEqual(ws.sent[0].available, false);
      assert.strictEqual(ws.sent[0].on, false);
    });
  });
});

describe('the switch writes through its own handler', () => {
  test('off then on: the stored switch and the block follow, and each block is Rundock\'s own', () => {
    const f = fixture({ state: { workspaceMode: 'code', sandboxSwitch: 'on' } });
    withWorkspace(f.dir, () => {
      for (const on of [false, true, false]) {
        const ws = captureWs();
        buildDispatch().set_workspace_sandbox({}, ws, { on }, 'darwin');
        assert.strictEqual(ws.sent[0].type, 'sandbox_status');
        assert.strictEqual(ws.sent[0].error, undefined);
        const block = JSON.parse(fs.readFileSync(path.join(f.dir, '.claude', 'settings.local.json'), 'utf-8')).sandbox;
        assert.strictEqual(block.enabled, on);
        assert.ok(scaffold.isRundockSandbox(block), 'recognised as Rundock\'s own');
        assert.strictEqual(JSON.parse(fs.readFileSync(path.join(f.dir, '.rundock', 'state.json'), 'utf-8')).sandboxSwitch, on ? 'on' : 'off');
        assert.strictEqual(JSON.parse(fs.readFileSync(path.join(f.dir, '.rundock', 'state.json'), 'utf-8')).workspaceMode, 'code', 'and the mode is left alone');
      }
    });
  });

  test('refused without writing: a hand-authored block, a platform with no sandbox, a value that is not a boolean', () => {
    const hand = fixture({ block: { enabled: true, filesystem: { allowWrite: ['/a'] } }, state: { sandboxSwitch: 'on' } });
    const cases = [[hand.dir, { on: false }, 'darwin'], [fixture({}).dir, { on: true }, 'linux'], [fixture({}).dir, { on: 'yes' }, 'darwin']];
    for (const [dir, msg, platform] of cases) {
      const files = [path.join(dir, '.claude', 'settings.local.json'), path.join(dir, '.rundock', 'state.json')];
      const before = files.map(bytes);
      withWorkspace(dir, () => {
        const ws = captureWs();
        buildDispatch().set_workspace_sandbox({}, ws, msg, platform);
        assert.strictEqual(ws.sent[0].type, 'sandbox_status');
        assert.ok(ws.sent[0].error, `${JSON.stringify(msg)} on ${platform}: the refusal is said`);
      });
      assert.deepStrictEqual(files.map(bytes), before, `${JSON.stringify(msg)} on ${platform}: nothing written`);
    }
  });

  test('a failed write restores both files and says so, and the status then describes the disk', () => {
    // settings.local.json read-only: the block write throws after the state
    // write has already happened, so the restore has real work to do.
    const f = fixture({ state: { workspaceMode: 'knowledge', sandboxSwitch: 'on' } });
    const settings = path.join(f.dir, '.claude', 'settings.local.json');
    fs.writeFileSync(settings, JSON.stringify({ sandbox: ours(f.dir, 'on') }, null, 2));
    const state = path.join(f.dir, '.rundock', 'state.json');
    const before = [bytes(settings), bytes(state)];
    fs.chmodSync(settings, 0o444);
    try {
      withWorkspace(f.dir, () => {
        const ws = captureWs();
        buildDispatch().set_workspace_sandbox({}, ws, { on: false }, 'darwin');
        assert.match(ws.sent[0].error, /Could not change this setting/);
        assert.strictEqual(ws.sent[0].on, true, 'the status reports the block still on, never the requested off');
      });
    } finally { fs.chmodSync(settings, 0o600); }
    assert.deepStrictEqual([bytes(settings), bytes(state)], before);
  });

  test('a state file that cannot be written is named, and the block is not touched', () => {
    const dir = tempDir('sb-badstate-');
    fs.mkdirSync(path.join(dir, '.claude'));
    fs.writeFileSync(path.join(dir, '.rundock'), 'not a directory');
    withWorkspace(dir, () => {
      const ws = captureWs();
      buildDispatch().set_workspace_sandbox({}, ws, { on: true }, 'darwin');
      assert.match(ws.sent[0].error, /Could not change this setting/);
    });
    assert.strictEqual(bytes(path.join(dir, '.claude', 'settings.local.json')), null, 'no block was created');
  });
});
