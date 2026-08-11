'use strict';
// Characterisation: spawn plumbing (resolveClaudeBin, spawnClaude,
// killProcessTree), pinned as it behaves today, before it moves out of
// server.js.
//
// resolveClaudeBin memoises its first answer for the life of the process, and
// the harness boot gate already forces that first call (asserting the stub
// resolved). Its unexercised branches therefore run in CHILD process probes:
// each probe requires server.js fresh, patches process.platform, points PATH
// at a fake windows shell, and prints what resolved. The Windows selection
// logic itself is pure string work, so the probes pin it on any platform.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../helpers/harness.js');
const { makeTempDir } = require('../helpers/workspace.js');

const SERVER_PATH = path.join(__dirname, '..', '..', 'server.js');

before(async () => {
  await h.boot();
  await h.connect();
});
after(async () => h.shutdown());

// Run resolveClaudeBin in a fresh node process: require server.js on the real
// platform first (so module init is undisturbed), then patch the platform,
// then resolve. `pathPrefix` is prepended to PATH; `breakPath` empties PATH
// before the call so the lookup itself fails.
function probeResolve({ pathPrefix, breakPath = false } = {}) {
  const script = [
    `const srv = require(${JSON.stringify(SERVER_PATH)});`,
    `Object.defineProperty(process, 'platform', { value: 'win32' });`,
    breakPath ? `process.env.PATH = ${JSON.stringify(path.join(path.sep, 'nonexistent-dir'))};` : '',
    `console.log('RESOLVED:' + srv._internal.resolveClaudeBin());`,
  ].join('\n');
  const env = { ...process.env };
  if (pathPrefix) env.PATH = pathPrefix + path.delimiter + env.PATH;
  const res = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf-8', timeout: 30000 });
  const line = String(res.stdout).split('\n').find(l => l.startsWith('RESOLVED:'));
  assert.ok(line, `probe printed a resolution (stderr: ${String(res.stderr).slice(0, 300)})`);
  return line.slice('RESOLVED:'.length);
}

// With the platform patched to win32, node shells the lookup through
// cmd.exe, so the fake that answers on this machine is a `cmd.exe` on PATH
// printing what `where.exe claude` would have.
function fakeWinShell(lines) {
  const dir = makeTempDir('rundock-test-winshell-');
  const file = path.join(dir, 'cmd.exe');
  fs.writeFileSync(file, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(lines.join('\n'))});\n`);
  fs.chmodSync(file, 0o755);
  return dir;
}

describe('resolveClaudeBin on Windows', () => {
  test('prefers the .exe among where.exe candidates', () => {
    const dir = fakeWinShell([
      'C:\\Users\\liam\\claude',
      'C:\\Users\\liam\\claude.cmd',
      'C:\\Users\\liam\\claude.exe',
    ]);
    assert.strictEqual(probeResolve({ pathPrefix: dir }), 'C:\\Users\\liam\\claude.exe');
  });

  test('falls back to the .cmd shim when no .exe is listed', () => {
    const dir = fakeWinShell(['C:\\Users\\liam\\claude', 'C:\\Users\\liam\\claude.cmd']);
    assert.strictEqual(probeResolve({ pathPrefix: dir }), 'C:\\Users\\liam\\claude.cmd');
  });

  test('empty lookup output resolves to the bare command', () => {
    const dir = fakeWinShell([]);
    assert.strictEqual(probeResolve({ pathPrefix: dir }), 'claude');
  });

  test('a failed lookup resolves to the bare command instead of throwing', () => {
    assert.strictEqual(probeResolve({ breakPath: true }), 'claude');
  });
});

describe('spawnClaude error handling', () => {
  test('a spawn failure reaches the caller\'s onError instead of tearing anything down', async () => {
    // A nonexistent cwd makes the spawn itself fail with an error EVENT.
    const seen = [];
    h.internal.spawnClaude(['--model', 'stub', '--print'], {
      cwd: path.join(h.workspaceDir, 'no-such-dir-anywhere'),
      stdio: 'ignore',
    }, (err) => seen.push(err));
    const surfaced = await h.waitUntil(() => seen.length === 1);
    assert.ok(surfaced, 'onError callback ran');
    assert.strictEqual(seen[0].code, 'ENOENT');
  });

  test('a throwing onError is contained by the wrapper', async () => {
    let ran = false;
    h.internal.spawnClaude(['--model', 'stub', '--print'], {
      cwd: path.join(h.workspaceDir, 'still-no-such-dir'),
      stdio: 'ignore',
    }, () => { ran = true; throw new Error('handler blew up'); });
    const surfaced = await h.waitUntil(() => ran);
    assert.ok(surfaced, 'throwing handler still ran, and nothing propagated');
  });
});

describe('killProcessTree on Windows', () => {
  test('when taskkill cannot run, the single-pid floor still signals the target', async () => {
    // Patch the platform for this call only: killProcessTree reads it at call
    // time. On this machine `taskkill` does not exist, so the spawned killer
    // fires its error event and the floor path must run.
    const signals = [];
    const fakeTarget = { pid: 999999901, kill: (sig) => signals.push(sig) };
    const realPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      h.internal.killProcessTree(fakeTarget, 'SIGTERM');
    } finally {
      Object.defineProperty(process, 'platform', { value: realPlatform });
    }
    const fellBack = await h.waitUntil(() => signals.length === 1);
    assert.ok(fellBack, 'floor kill ran after the taskkill error event');
    assert.deepStrictEqual(signals, ['SIGTERM']);
  });
});
