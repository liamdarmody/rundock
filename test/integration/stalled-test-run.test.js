'use strict';
// A STALLED TEST RUN ENDS, NON-ZERO, AND NAMES WHAT STALLED.
//
// Each fixture under test/fixtures/stalled-run/ is run through the command and
// options of `npm test`, read from package.json with only the glob swapped for
// the fixture, so what is proven is the run CI starts. A run that stalls must
// end in under five minutes, exit non-zero, and name the stall in its output.
//
// THESE TESTS TAKE REAL TIME. The run they start waits out the real per-test
// limit before it ends, so each has its own timeout above that limit plus the
// run's start-up, and asks the guard for the same. Each also has a watchdog
// that ends the run it started at five minutes and fails, so a run that never
// ends is reported here instead of holding this file open.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const guard = require('../helpers/stall-guard.js');

const ROOT = path.join(__dirname, '..', '..');
const FIXTURES = 'test/fixtures/stalled-run';
const GLOB = 'test/**/*.test.js';
const CEILING_MS = 5 * 60 * 1000;
const OWN_LIMIT_MS = CEILING_MS + 60 * 1000;
const scripts = require(path.join(ROOT, 'package.json')).scripts;

// The arguments an npm script hands `node`, up to any `&&` that follows it.
function nodeArgs(name) {
  const words = scripts[name].split(/\s+/).map((w) => w.replace(/^"|"$/g, ''));
  assert.strictEqual(words[0], 'node', `${name} no longer starts with node`);
  const end = words.indexOf('&&');
  return words.slice(1, end === -1 ? undefined : end);
}

// The arguments that name test files: neither a flag nor a flag's value.
const fileArgs = (args) => args.filter((a, i) => !a.startsWith('-') && args[i - 1] !== '--require');

function runFixture(file) {
  const args = nodeArgs('test');
  const files = fileArgs(args);
  assert.deepStrictEqual(files, [GLOB], 'npm test no longer runs one glob; revisit this check');
  args[args.indexOf(GLOB)] = `${FIXTURES}/${file}`;
  // A run of its own rather than a part of this one, and one that writes no
  // coverage: an empty value keeps a child out of coverage, where deleting the
  // key would not.
  const env = { ...process.env, NODE_V8_COVERAGE: '' };
  delete env.NODE_TEST_CONTEXT;
  const started = Date.now();
  return new Promise((resolve) => {
    // Its own process group, so the watchdog ends the runner and the file it
    // started together.
    const child = spawn(process.execPath, args, { cwd: ROOT, env, detached: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    let watchdogFired = false;
    const watchdog = setTimeout(() => {
      watchdogFired = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }, CEILING_MS);
    child.on('close', (code) => {
      clearTimeout(watchdog);
      resolve({ code, out, watchdogFired, ms: Date.now() - started });
    });
  });
}

// True when one line of the output carries every one of the given strings.
const oneLineNames = (out, ...parts) => out.split('\n').some((line) => parts.every((p) => line.includes(p)));

describe('a stalled run ends and names what stalled', { concurrency: true }, () => {
  test('a test that never settles ends the run non-zero within five minutes, naming its file and test',
    { timeout: OWN_LIMIT_MS }, async (t) => {
      guard.setLimit(t, OWN_LIMIT_MS);
      const r = await runFixture('never-settles.js');
      assert.ok(!r.watchdogFired, `the run was still going after five minutes:\n${r.out}`);
      assert.notStrictEqual(r.code, 0, `the stalled run exited zero:\n${r.out}`);
      assert.ok(oneLineNames(r.out, `${FIXTURES}/never-settles.js`, 'a promise nobody resolves'),
        `no line of the output names both the file and the test that stalled:\n${r.out}`);
    });

  test('a file whose tests all pass but which is left open ends the run non-zero within five minutes, naming the file',
    { timeout: OWN_LIMIT_MS }, async (t) => {
      guard.setLimit(t, OWN_LIMIT_MS);
      const r = await runFixture('open-handle.js');
      assert.ok(!r.watchdogFired, `the run was still going after five minutes:\n${r.out}`);
      assert.notStrictEqual(r.code, 0, `the run exited zero with the file still open:\n${r.out}`);
      assert.ok(oneLineNames(r.out, `${FIXTURES}/open-handle.js`, 'still open'),
        `no line of the output names the file and says it was still open:\n${r.out}`);
    });
});

test('the stall fixtures are never picked up by npm test\'s own glob', () => {
  const files = fs.readdirSync(path.join(ROOT, FIXTURES));
  const globs = fileArgs(nodeArgs('test'));
  assert.ok(files.length >= 1 && globs.length >= 1, 'nothing to check');
  for (const glob of globs) {
    for (const f of files) {
      assert.ok(!path.matchesGlob(`${FIXTURES}/${f}`, glob),
        `${FIXTURES}/${f} matches ${glob}, so npm test would run it and fail on it`);
    }
  }
});
