'use strict';
// THE STORED MODE IS READ BOTH WAYS AND WRITTEN ONE WAY.
//
// The value was `knowledge` and becomes `notes`. Every reader goes through one
// normalizer, so both spellings, an absent value and garbage all read as the
// restrictive mode, and only `code` lifts it. Driven through the real readers:
// the tool restriction, the spawn environment, the agent's platform rule and
// the sandbox the workspace claims when no switch is stored.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');

const { _internal: srv } = require('../../server.js');
const { buildSystemPrompt } = require('../../lib/agents/prompt.js');
const { normalizeWorkspaceMode, WRITABLE_MODES } = require('../../lib/workspace/mode.js');
const { sandboxSwitchFor } = require('../../lib/workspace/scaffold.js');
const { makeWorkspace, cleanup } = require('../helpers/workspace.js');
const fs = require('node:fs');
const path = require('node:path');
const { buildDispatch } = require('../../lib/protocol/handlers/index.js');
const scaffold = require('../../lib/workspace/scaffold.js');

after(cleanup);

const RESTRICTIVE = ['knowledge', 'notes', undefined, 'KNOWLEDGE', 42, null, 'sideways'];

function readersFor(stored) {
  const dir = makeWorkspace({});
  srv.setWorkspace(dir);
  srv.writeState(stored === undefined ? {} : { workspaceMode: stored });
  const prompt = buildSystemPrompt({ name: 'Scout', displayName: 'Scout' });
  return {
    tools: srv.getDisallowedTools(),
    codeEnv: srv.getSpawnEnv('c').RUNDOCK_CODE_MODE,
    codeRule: /Rundock is running in Code mode/.test(prompt),
    sandboxOn: sandboxSwitchFor(dir).on,
  };
}

describe('every reader goes through one normalizer', () => {
  test('the normalizer: code is code, and everything else is notes', () => {
    assert.strictEqual(normalizeWorkspaceMode('code'), 'code');
    for (const v of RESTRICTIVE) assert.strictEqual(normalizeWorkspaceMode(v), 'notes', String(v));
  });

  for (const stored of RESTRICTIVE) {
    test(`stored ${JSON.stringify(stored)}: the restrictive list, no code-mode flag, the Notes rule, the sandbox claimed`, () => {
      assert.deepStrictEqual(readersFor(stored), { tools: srv.DISALLOWED_TOOLS_KNOWLEDGE, codeEnv: undefined, codeRule: false, sandboxOn: true });
    });
  }

  test('stored code: the opposite on every reader', () => {
    assert.deepStrictEqual(readersFor('code'), { tools: '', codeEnv: '1', codeRule: true, sandboxOn: false });
  });
});

describe('the downgrade contract', () => {
  // Every Rundock from v0.9.0 to v0.14.0 reads the stored mode as
  // `value === 'code'`. The values this build can write must be exactly the
  // two that rule classifies as intended, so an older build reading a folder
  // this one wrote does what the person chose.
  test('the writable values are exactly notes and code, and the shipped readers classify each as intended', () => {
    assert.deepStrictEqual([...WRITABLE_MODES].sort(), ['code', 'notes']);
    const shippedReaderSaysCode = (value) => value === 'code';
    assert.deepStrictEqual(WRITABLE_MODES.map((v) => [v, shippedReaderSaysCode(v)]).sort(), [['code', true], ['notes', false]]);
  });
});

describe('writes: notes only where Rundock already writes, never on open', () => {
  const statePath = (dir) => path.join(dir, '.rundock', 'state.json');
  function captureWs() {
    const sent = [];
    return { sent, send: (m) => sent.push(JSON.parse(m)), readyState: 1 };
  }

  test('the setter accepts notes and knowledge, stores notes, and says notes', () => {
    for (const asked of ['notes', 'knowledge']) {
      const dir = makeWorkspace({});
      srv.setWorkspace(dir);
      srv.writeState({ workspaceMode: 'code' });
      const ws = captureWs();
      buildDispatch().set_workspace_mode({}, ws, { mode: asked }, 'darwin');
      assert.deepStrictEqual(ws.sent, [{ type: 'workspace_mode_changed', mode: 'notes' }], asked);
      assert.strictEqual(JSON.parse(fs.readFileSync(statePath(dir), 'utf-8')).workspaceMode, 'notes', asked);
    }
  });

  test('a first open and a detection write notes for a folder with nothing code-shaped', () => {
    const dir = makeWorkspace({ files: { 'notes.md': '# hi' } });
    srv.setWorkspace(dir);
    assert.strictEqual(scaffold.recordFirstOpen(dir).workspaceMode, 'notes');
    assert.strictEqual(JSON.parse(fs.readFileSync(statePath(dir), 'utf-8')).workspaceMode, 'notes');
  });

  test('opening a workspace stored as knowledge leaves its state file byte for byte as it was', () => {
    const dir = makeWorkspace({ claudeMd: '# x' });
    srv.setWorkspace(dir);
    srv.writeState({ workspaceMode: 'knowledge', lastActiveConversationId: 'c1' });
    const before = fs.readFileSync(statePath(dir), 'utf-8');
    scaffold.recordFirstOpen(dir);
    srv.scaffoldWorkspace(dir, { platform: 'darwin' });
    assert.strictEqual(fs.readFileSync(statePath(dir), 'utf-8'), before);
  });
});
