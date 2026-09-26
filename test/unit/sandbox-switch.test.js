'use strict';
// KEEP AGENTS INSIDE THIS WORKSPACE IS ITS OWN SWITCH, stored beside the mode
// rather than derived from it.
//
// Until now the sandbox block's `enabled` was regenerated from the mode on
// every write, so choosing Code also turned the operating system's write block
// off. The switch is stored in `.rundock/state.json` as `sandboxSwitch`; where
// it is absent (every workspace that existed before this), the value is the one
// the mode always implied, so an existing workspace keeps exactly the block it
// has and nothing is rewritten until the person acts.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { _internal: srv } = require('../../server.js');
const { buildDispatch } = require('../../lib/protocol/handlers/index.js');
const scaffold = require('../../lib/workspace/scaffold.js');
const { makeWorkspace, cleanup } = require('../helpers/workspace.js');

after(cleanup);

const settingsPath = (dir) => path.join(dir, '.claude', 'settings.local.json');
const statePath = (dir) => path.join(dir, '.rundock', 'state.json');
const bytes = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null);
const block = (dir) => JSON.parse(fs.readFileSync(settingsPath(dir), 'utf-8')).sandbox;
const state = (dir) => JSON.parse(fs.readFileSync(statePath(dir), 'utf-8'));
function writeState(dir, value) {
  fs.mkdirSync(path.dirname(statePath(dir)), { recursive: true });
  fs.writeFileSync(statePath(dir), JSON.stringify(value, null, 2));
}
function captureWs() {
  const sent = [];
  return { sent, send: (m) => sent.push(JSON.parse(m)), readyState: 1 };
}
// A workspace as the previous release left it: its mode recorded, its block and
// hooks written by an open, and no switch stored.
function existingWorkspace(mode) {
  const dir = makeWorkspace({ claudeMd: '# x' });
  srv.setWorkspace(dir);
  writeState(dir, { workspaceMode: mode });
  srv.scaffoldWorkspace(dir, { platform: 'darwin' });
  return dir;
}

describe('where the switch is read from', () => {
  test('absent, it is what the mode always implied: Code off, anything else on', () => {
    const dir = makeWorkspace({});
    writeState(dir, { workspaceMode: 'code' });
    assert.deepStrictEqual(scaffold.sandboxSwitchFor(dir), { on: false, stored: false });
    writeState(dir, { workspaceMode: 'knowledge' });
    assert.deepStrictEqual(scaffold.sandboxSwitchFor(dir), { on: true, stored: false });
    writeState(dir, {});
    assert.deepStrictEqual(scaffold.sandboxSwitchFor(dir), { on: true, stored: false });
  });

  test('stored, it wins over the mode in both directions, and anything else is read as absent', () => {
    const dir = makeWorkspace({});
    writeState(dir, { workspaceMode: 'code', sandboxSwitch: 'on' });
    assert.deepStrictEqual(scaffold.sandboxSwitchFor(dir), { on: true, stored: true });
    writeState(dir, { workspaceMode: 'knowledge', sandboxSwitch: 'off' });
    assert.deepStrictEqual(scaffold.sandboxSwitchFor(dir), { on: false, stored: true });
    writeState(dir, { workspaceMode: 'code', sandboxSwitch: true });
    assert.deepStrictEqual(scaffold.sandboxSwitchFor(dir), { on: false, stored: false });
  });

  test('the open-path reconcile writes the stored switch, not the mode', () => {
    const dir = makeWorkspace({ claudeMd: '# x' });
    srv.setWorkspace(dir);
    writeState(dir, { workspaceMode: 'code', sandboxSwitch: 'on' });
    srv.scaffoldWorkspace(dir, { platform: 'darwin' });
    assert.strictEqual(block(dir).enabled, true, 'Code mode with the switch on keeps the sandbox on');
    writeState(dir, { workspaceMode: 'knowledge', sandboxSwitch: 'off' });
    srv.scaffoldWorkspace(dir, { platform: 'darwin' });
    assert.strictEqual(block(dir).enabled, false, 'Notes with the switch off keeps it off');
    assert.ok(scaffold.isRundockSandbox(block(dir)), 'and the off block is still recognised as Rundock\'s own');
  });
});

describe('an existing workspace is left exactly as it was', () => {
  for (const mode of ['knowledge', 'code']) {
    test(`${mode}: opening it again under this build changes neither file`, () => {
      const dir = existingWorkspace(mode);
      const before = [bytes(settingsPath(dir)), bytes(statePath(dir))];
      assert.strictEqual(block(dir).enabled, mode !== 'code', 'fixture sanity: the block the previous release wrote');
      srv.scaffoldWorkspace(dir, { platform: 'darwin' });
      assert.deepStrictEqual([bytes(settingsPath(dir)), bytes(statePath(dir))], before);
    });
  }
});

describe('changing mode never moves the switch', () => {
  for (const from of ['on', 'off']) {
    for (const [a, b] of [['notes', 'code'], ['code', 'notes']]) {
      test(`switch ${from}, ${a} to ${b}: the settings file is byte-identical and the switch unchanged`, () => {
        const dir = makeWorkspace({ claudeMd: '# x' });
        srv.setWorkspace(dir);
        writeState(dir, { workspaceMode: a, sandboxSwitch: from });
        srv.scaffoldWorkspace(dir, { platform: 'darwin' });
        const before = bytes(settingsPath(dir));
        const ws = captureWs();
        buildDispatch().set_workspace_mode({}, ws, { mode: b }, 'darwin');
        assert.deepStrictEqual(ws.sent, [{ type: 'workspace_mode_changed', mode: b }]);
        assert.strictEqual(bytes(settingsPath(dir)), before);
        assert.strictEqual(state(dir).sandboxSwitch, from);
        assert.strictEqual(state(dir).workspaceMode, b);
      });
    }
  }

  test('with no switch stored yet, the first mode change pins the value the old mode implied', () => {
    for (const [a, b, pinned] of [['knowledge', 'code', 'on'], ['code', 'knowledge', 'off']]) {
      const dir = existingWorkspace(a);
      const before = bytes(settingsPath(dir));
      buildDispatch().set_workspace_mode({}, captureWs(), { mode: b }, 'darwin');
      assert.strictEqual(state(dir).sandboxSwitch, pinned, `${a} to ${b}`);
      assert.strictEqual(bytes(settingsPath(dir)), before, `${a} to ${b}: the block is not rewritten`);
      srv.scaffoldWorkspace(dir, { platform: 'darwin' });
      assert.strictEqual(bytes(settingsPath(dir)), before, `${a} to ${b}: nor on the next open`);
    }
  });

  test('a settings file that cannot be read no longer stops a mode change, and is left alone', () => {
    const dir = makeWorkspace({});
    srv.setWorkspace(dir);
    fs.mkdirSync(path.dirname(settingsPath(dir)), { recursive: true });
    fs.writeFileSync(settingsPath(dir), '{ not json');
    const ws = captureWs();
    buildDispatch().set_workspace_mode({}, ws, { mode: 'code' }, 'darwin');
    assert.strictEqual(ws.sent[0].type, 'workspace_mode_changed');
    assert.strictEqual(bytes(settingsPath(dir)), '{ not json');
  });
});

describe('a workspace new to Rundock starts with the switch on', () => {
  test('the default is one named constant, and it is on', () => {
    assert.strictEqual(scaffold.NEW_WORKSPACE_SANDBOX_SWITCH, 'on');
  });

  test('a first open records the switch beside the detected mode, in either mode', () => {
    for (const files of [{ 'package.json': '{}' }, { 'notes.md': '# hi' }]) {
      const dir = makeWorkspace({ files });
      srv.setWorkspace(dir);
      scaffold.recordFirstOpen(dir);
      const st = state(dir);
      assert.strictEqual(st.sandboxSwitch, 'on', `${st.workspaceMode}: the switch is recorded on`);
      srv.scaffoldWorkspace(dir, { platform: 'darwin' });
      assert.strictEqual(block(dir).enabled, true, `${st.workspaceMode}: and the block the open writes is on`);
    }
  });

  test('a workspace already opened keeps what it has: recordFirstOpen writes nothing when a mode is recorded', () => {
    const dir = existingWorkspace('code');
    const before = bytes(statePath(dir));
    scaffold.recordFirstOpen(dir);
    assert.strictEqual(bytes(statePath(dir)), before);
  });
});
