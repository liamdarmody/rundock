'use strict';
// A NEWER RUNTIME WARNS AND NEVER FAILS. The runtime ships most days, and the
// version check used to fail the release gate on the number alone: in one week
// it blocked several releases, and each re-capture came back with the same
// grammar and the same transcript. These run the real harnesses with a fake
// `claude` on the PATH that reports a version no capture was taken from, and
// require a pass that still names the mismatch.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const FAKE_VERSION = '0.0.1';

function withFakeRuntime(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'truth-version-'));
  try {
    const bin = path.join(dir, process.platform === 'win32' ? 'claude.cmd' : 'claude');
    fs.writeFileSync(bin, process.platform === 'win32'
      ? `@echo ${FAKE_VERSION} (Claude Code)\r\n`
      : `#!/bin/sh\necho "${FAKE_VERSION} (Claude Code)"\n`);
    fs.chmodSync(bin, 0o755);
    const env = { ...process.env, PATH: dir + path.delimiter + process.env.PATH };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_OPTIONS;
    return fn(env);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

for (const name of ['stream-truth', 'transcript-truth']) {
  test(`${name}: a runtime newer than the capture is a warning, and the check still passes`, () => {
    withFakeRuntime((env) => {
      const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', name, 'run.mjs')],
        { cwd: ROOT, env, encoding: 'utf8' });
      const out = `${r.stdout}\n${r.stderr}`;
      assert.strictEqual(r.status, 0, `a version mismatch alone must not fail:\n${out}`);
      assert.match(out, new RegExp(`WARNING: installed CLI is ${FAKE_VERSION.replace(/\./g, '\\.')} but the capture is from`));
      assert.match(out, /PASS/, 'the stub or reader is still held to the capture');
    });
  });
}

test('preflight: a stale capture is a warning, not a failed check', () => {
  withFakeRuntime((env) => {
    const preflight = path.join(ROOT, 'scripts', 'preflight.js');
    const src = fs.readFileSync(preflight, 'utf8');
    assert.match(src, /runtime captures\.\.\. warning/, 'the stale branch reports a warning');
    // Ask the module itself, under the fake runtime, what it finds.
    const r = spawnSync(process.execPath, ['-e',
      `const p = require(${JSON.stringify(preflight)}); process.stdout.write(JSON.stringify(p.staleCaptures()));`],
    { cwd: ROOT, env, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    const found = JSON.parse(r.stdout);
    assert.ok(Array.isArray(found.stale) && found.stale.length === 2, 'both captures are named as stale');
    const start = src.indexOf('} else if (captures.stale.length) {');
    assert.ok(start > 0, 'the stale branch is where this test expects it');
    const branch = src.slice(start, src.indexOf('} else {', start + 1));
    assert.doesNotMatch(branch, /ok: false/, 'and the stale branch records no failed result');
  });
});
