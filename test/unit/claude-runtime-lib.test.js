'use strict';
// Seam tests for lib/runtime/claude.js. The plumbing's behaviour is pinned by
// the characterisation suite (spawn-plumbing.test.js, text-helpers.test.js,
// workspace-modes.test.js, pid-file.test.js) driving the moved code through
// server.js's identity re-exports; these tests pin the SEAMS themselves:
// the unwired port accessor refuses loudly, the wiring is restorable, and
// args/env/pid-file paths resolve the workspace at USE time so a switch
// redirects the very next call.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LIB_KEY = require.resolve('../../lib/runtime/claude.js');

// A private copy per test: wiring one test's fakes must never leak into
// another test (or into the shared instance other requires would see).
function freshClaudeRuntime() {
  const cached = require.cache[LIB_KEY];
  delete require.cache[LIB_KEY];
  const mod = require(LIB_KEY);
  delete require.cache[LIB_KEY];
  if (cached) require.cache[LIB_KEY] = cached;
  return mod;
}

function withTwoWorkspaces(fn) {
  const config = require('../../lib/config.js');
  const original = config.getWorkspace();
  const wsA = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-rt-a-'));
  const wsB = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-rt-b-'));
  try {
    fn(config, wsA, wsB);
  } finally {
    config.setWorkspace(original);
    fs.rmSync(wsA, { recursive: true, force: true });
    fs.rmSync(wsB, { recursive: true, force: true });
  }
}

test('unwired getActualPort throws the named wiring error at first use', () => {
  const rt = freshClaudeRuntime();
  assert.throws(
    () => rt.getSpawnEnv('convo-1'),
    /lib\/runtime\/claude: getActualPort not wired \(call wireClaudeRuntimeDeps at boot\)/,
  );
});

test('wireClaudeRuntimeDeps returns the previous set, restorable by identity', () => {
  const rt = freshClaudeRuntime();
  const prev = rt.wireClaudeRuntimeDeps({ getActualPort: () => 4444 });
  assert.strictEqual(rt.getSpawnEnv(null).RUNDOCK_PORT, '4444');
  rt.wireClaudeRuntimeDeps(prev);
  assert.throws(() => rt.getSpawnEnv(null), /getActualPort not wired/);
});

test('getBareArgs resolves the workspace at USE time: a switch redirects the next call', () => {
  const rt = freshClaudeRuntime();
  withTwoWorkspaces((config, wsA, wsB) => {
    config.setWorkspace(wsA);
    assert.deepStrictEqual(rt.getBareArgs(), ['--add-dir', wsA]);
    // Workspace B carries a settings file; the switch must pick BOTH the new
    // root and the new file up with no re-wiring.
    fs.mkdirSync(path.join(wsB, '.claude'), { recursive: true });
    const settings = path.join(wsB, '.claude', 'settings.local.json');
    fs.writeFileSync(settings, '{}');
    config.setWorkspace(wsB);
    assert.deepStrictEqual(rt.getBareArgs(), ['--add-dir', wsB, '--settings', settings],
      'the args followed the switch with no re-wiring');
  });
});

test('the pid file follows the workspace: register lands in the CURRENT .rundock', () => {
  const rt = freshClaudeRuntime();
  withTwoWorkspaces((config, wsA, wsB) => {
    config.setWorkspace(wsA);
    rt.registerChildPid(999901, 'claude');
    config.setWorkspace(wsB);
    rt.registerChildPid(999902, 'claude');
    const readPids = (ws) => JSON.parse(
      fs.readFileSync(path.join(ws, '.rundock', 'child-pids.json'), 'utf-8')).map(r => r.pid);
    assert.deepStrictEqual(readPids(wsA), [999901], 'workspace A holds only its own pid');
    assert.deepStrictEqual(readPids(wsB), [999902], 'workspace B holds only its own pid');
    // Unregister also resolves at use time: it prunes the CURRENT file only.
    rt.unregisterChildPid(999902);
    assert.deepStrictEqual(readPids(wsB), [], 'pruned from the current workspace');
    assert.deepStrictEqual(readPids(wsA), [999901], 'the other workspace file is untouched');
  });
});

test('getSpawnEnv carries the use-time workspace and the wired port together', () => {
  const rt = freshClaudeRuntime();
  rt.wireClaudeRuntimeDeps({ getActualPort: () => 5151 });
  withTwoWorkspaces((config, wsA, wsB) => {
    config.setWorkspace(wsA);
    const envA = rt.getSpawnEnv('convo-7');
    assert.strictEqual(envA.RUNDOCK_WORKSPACE, wsA);
    assert.strictEqual(envA.RUNDOCK_PORT, '5151');
    assert.strictEqual(envA.RUNDOCK_CONVO_ID, 'convo-7');
    config.setWorkspace(wsB);
    assert.strictEqual(rt.getSpawnEnv(null).RUNDOCK_WORKSPACE, wsB,
      'the env followed the switch with no re-wiring');
  });
});
