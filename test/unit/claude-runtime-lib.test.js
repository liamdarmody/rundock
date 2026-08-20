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

// ── Scratch stays inside the workspace ─────────────────────────────────────
//
// An agent that writes a scratch file to the operating system temp directory
// and reads it back trips the outside-the-workspace approval card, for a file
// it created itself seconds earlier. The card is correct; putting the file
// there was the mistake. Pointing the platform temp directory at a path inside
// the workspace fixes the whole class by construction, including for tools and
// skills this project did not write, because they ask the platform rather than
// reading any guidance.

test('a spawned agent resolves the platform temp directory inside the workspace', () => {
  const rt = freshClaudeRuntime();
  rt.wireClaudeRuntimeDeps({ getActualPort: () => 4444 });
  withTwoWorkspaces((config, wsA) => {
    config.setWorkspace(wsA);
    const env = rt.getSpawnEnv('convo-1');
    // All three, because the platform reads a different one per operating
    // system: TMPDIR on macOS and Linux, TEMP and TMP on Windows. Setting only
    // the one this machine happens to use would leave the other platforms
    // writing outside the workspace with nothing to catch it.
    for (const key of ['TMPDIR', 'TEMP', 'TMP']) {
      assert.ok(env[key], `${key} must be set`);
      assert.ok(env[key].startsWith(wsA + path.sep),
        `${key} must resolve inside the workspace, got ${env[key]}`);
    }
    assert.ok(fs.existsSync(env.TMPDIR), 'the directory exists before a child needs it');
  });
});

test('the scratch directory follows a workspace switch', () => {
  const rt = freshClaudeRuntime();
  rt.wireClaudeRuntimeDeps({ getActualPort: () => 4444 });
  withTwoWorkspaces((config, wsA, wsB) => {
    config.setWorkspace(wsA);
    assert.ok(rt.getSpawnEnv(null).TMPDIR.startsWith(wsA + path.sep));
    config.setWorkspace(wsB);
    assert.ok(rt.getSpawnEnv(null).TMPDIR.startsWith(wsB + path.sep),
      'resolved at use time, not captured at wiring');
  });
});

test('with no workspace the real temp directory is left alone', () => {
  const rt = freshClaudeRuntime();
  rt.wireClaudeRuntimeDeps({ getActualPort: () => 4444 });
  const env = rt.getSpawnEnv(null);
  // Redirecting to a path built from an empty workspace would be worse than
  // not redirecting: it would write to an unpredictable place rather than a
  // contained one. Better to leave the platform default standing.
  assert.strictEqual(env.TMPDIR, process.env.TMPDIR);
});

test('pruning clears stale scratch and leaves recent scratch alone', () => {
  const rt = freshClaudeRuntime();
  rt.wireClaudeRuntimeDeps({ getActualPort: () => 4444 });
  withTwoWorkspaces((config, wsA) => {
    config.setWorkspace(wsA);
    const dir = rt.getSpawnEnv(null).TMPDIR;
    const stale = path.join(dir, 'stale.html');
    const fresh = path.join(dir, 'fresh.html');
    fs.writeFileSync(stale, 'x');
    fs.writeFileSync(fresh, 'x');
    const longAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    fs.utimesSync(stale, longAgo / 1000, longAgo / 1000);

    rt.pruneScratch();

    assert.strictEqual(fs.existsSync(stale), false, 'a month-old file is cleared');
    assert.strictEqual(fs.existsSync(fresh), true, 'a file from this session survives');
  });
});

test('a stale-looking folder holding recent work is not deleted', () => {
  // The case the age bound exists for, and the one it originally got wrong.
  // A directory's own timestamp moves when its immediate children change and
  // not when something deeper does, so a project folder untouched at its top
  // level for weeks can still hold a file written minutes ago. Judging the
  // folder by its own timestamp deleted exactly the work in progress the
  // bound was meant to protect.
  const rt = freshClaudeRuntime();
  rt.wireClaudeRuntimeDeps({ getActualPort: () => 4444 });
  withTwoWorkspaces((config, wsA) => {
    config.setWorkspace(wsA);
    const dir = rt.getSpawnEnv(null).TMPDIR;

    const busy = path.join(dir, 'busy-project');
    fs.mkdirSync(busy, { recursive: true });
    const inUse = path.join(busy, 'render.html');
    fs.writeFileSync(inUse, 'work in progress');

    const abandoned = path.join(dir, 'abandoned-project');
    fs.mkdirSync(abandoned, { recursive: true });
    const old = path.join(abandoned, 'render.html');
    fs.writeFileSync(old, 'finished long ago');

    // Both FOLDERS look ancient. They differ only in what is inside them.
    const longAgo = (Date.now() - (30 * 24 * 60 * 60 * 1000)) / 1000;
    fs.utimesSync(old, longAgo, longAgo);
    fs.utimesSync(abandoned, longAgo, longAgo);
    fs.utimesSync(busy, longAgo, longAgo);

    rt.pruneScratch();

    assert.strictEqual(fs.existsSync(inUse), true,
      'a folder holding recent work survives, however old the folder looks');
    assert.strictEqual(fs.readFileSync(inUse, 'utf-8'), 'work in progress');
    assert.strictEqual(fs.existsSync(abandoned), false,
      'a folder whose contents are all stale is still cleared');
  });
});

test('pruning a workspace that has no scratch directory is a quiet no-op', () => {
  const rt = freshClaudeRuntime();
  rt.wireClaudeRuntimeDeps({ getActualPort: () => 4444 });
  withTwoWorkspaces((config, wsA) => {
    config.setWorkspace(wsA);
    assert.doesNotThrow(() => rt.pruneScratch());
  });
});
