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
//
// OUTSIDE NPM TEST ON PURPOSE. This file is named so that npm test's glob never
// matches it: the suite runs, passes and skips the same tests with or without
// it, and does not wait minutes for these. `npm run test:stall-guard` runs it,
// and CI's test job runs that as its own step after the suite.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const guard = require('../../helpers/stall-guard.js');
const { readWorkflow } = require('../../helpers/workflow-text.js');

const ROOT = path.join(__dirname, '..', '..', '..');
const SELF = path.relative(ROOT, __filename).split(path.sep).join('/');
const FIXTURES = 'test/fixtures/stalled-run';
const GLOB = 'test/**/*.test.js';
const CEILING_MS = 5 * 60 * 1000;
const OWN_LIMIT_MS = CEILING_MS + 60 * 1000;
const scripts = require(path.join(ROOT, 'package.json')).scripts;

// The arguments an npm script hands `node`, up to any `&&` that follows it.
function nodeArgs(name) {
  assert.ok(scripts[name], `package.json has no ${name} script`);
  const words = scripts[name].split(/\s+/).map((w) => w.replace(/^"|"$/g, ''));
  assert.strictEqual(words[0], 'node', `${name} no longer starts with node`);
  const end = words.indexOf('&&');
  return words.slice(1, end === -1 ? undefined : end);
}

// The arguments that name test files: neither a flag nor a flag's value.
const fileArgs = (args) => args.filter((a, i) => !a.startsWith('-') && args[i - 1] !== '--require');

// The files an npm script loads into every test file it runs.
const requiresOf = (name) => nodeArgs(name).filter((a, i, args) => args[i - 1] === '--require');

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

  test('a file left open after passing tests that took a minute and a half ends the run non-zero within five minutes of its start, naming the file',
    { timeout: OWN_LIMIT_MS }, async (t) => {
      guard.setLimit(t, OWN_LIMIT_MS);
      const r = await runFixture('open-after-slow-tests.js');
      assert.ok(!r.watchdogFired, `the run was still going five minutes after it started:\n${r.out}`);
      assert.notStrictEqual(r.code, 0, `the run exited zero with the file still open:\n${r.out}`);
      assert.ok(oneLineNames(r.out, `${FIXTURES}/open-after-slow-tests.js`, 'still open'),
        `no line of the output names the file and says it was still open:\n${r.out}`);
    });

  test('a file that closes on its own two minutes after its tests pass is not stopped',
    { timeout: OWN_LIMIT_MS }, async (t) => {
      guard.setLimit(t, OWN_LIMIT_MS);
      const r = await runFixture('closes-late.js');
      assert.ok(!r.watchdogFired, `the run was still going after five minutes:\n${r.out}`);
      assert.ok(!r.out.includes('[stalled test]'), `the run stopped a file that was about to close:\n${r.out}`);
      assert.strictEqual(r.code, 0, `the run failed a file whose tests all passed:\n${r.out}`);
    });
});

test('a file\'s wait to close is cut short at its deadline, and a file whose tests ran up to or past it still has time to close on its own', () => {
  const { exitGraceMs, EXIT_GRACE_MS, FILE_DEADLINE_MS, MIN_EXIT_GRACE_MS } = guard;
  assert.ok(FILE_DEADLINE_MS < CEILING_MS, 'a file left open may still be running five minutes after it started');
  assert.strictEqual(exitGraceMs(0), EXIT_GRACE_MS, 'a file whose tests end at once no longer has the full wait to close');
  for (const done of [30, 90, 150, 200, 240].map((s) => s * 1000)) {
    assert.ok(done + exitGraceMs(done) <= FILE_DEADLINE_MS,
      `a file whose tests finished after ${done / 1000} seconds may stay open past its deadline`);
  }
  for (const done of [FILE_DEADLINE_MS - 10 * 1000, FILE_DEADLINE_MS, 20 * 60 * 1000]) {
    assert.strictEqual(exitGraceMs(done), MIN_EXIT_GRACE_MS,
      `a file whose tests finished after ${done / 1000} seconds is not given the shortest wait to close`);
  }
  assert.ok(MIN_EXIT_GRACE_MS > 0, 'a file whose tests ran long is stopped the moment they finish');
});

test('npm test, the coverage run and CI\'s test job take the limit from the one guard and set none of their own, and the test job runs these proofs after the suite', () => {
  assert.ok(requiresOf('test').includes('./test/helpers/stall-guard.js'), 'npm test no longer loads the stall guard');
  assert.deepStrictEqual(requiresOf('test:coverage'), requiresOf('test'),
    'the coverage run does not load what npm test loads, so it runs without the same limit');
  const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const job = readWorkflow('ci.yml').jobs.test;
  assert.ok(job, 'ci.yml has no test job');
  const runs = job.steps.map((s) => s.run);
  const suite = runs.indexOf('npm test');
  assert.ok(suite !== -1, 'CI\'s test job no longer runs npm test, so it may not load the guard');
  const proofs = runs.indexOf('npm run test:stall-guard');
  assert.ok(proofs > suite,
    'CI\'s test job does not run npm run test:stall-guard after npm test, so no CI run shows that a stalled run still ends and names what stalled');
  assert.strictEqual(job.steps[proofs].continueOnError, undefined,
    'the step that runs these proofs may fail without failing the job');
  for (const [where, text] of [['npm test', scripts.test], ['test:coverage', scripts['test:coverage']], ['ci.yml', ci]]) {
    assert.ok(!text.includes('--test-timeout'), `${where} sets a limit of its own with --test-timeout`);
  }
  const source = fs.readFileSync(require.resolve('../../helpers/stall-guard.js'), 'utf8');
  assert.ok(!source.includes('process.env'), 'the guard reads the environment, so its limit can be set from outside it');
});

test('these proofs and their fixtures are never picked up by npm test\'s own glob, and a script of their own runs this file', () => {
  const files = new Set([SELF, ...fs.readdirSync(path.join(ROOT, FIXTURES)).map((f) => `${FIXTURES}/${f}`)]);
  const globs = fileArgs(nodeArgs('test'));
  assert.ok(files.size >= 2 && globs.length >= 1, 'nothing to check');
  for (const glob of globs) {
    for (const f of files) {
      assert.ok(!path.matchesGlob(f, glob),
        `${f} matches ${glob}, so npm test would run it, adding to the suite's count or failing on it`);
    }
  }
  assert.deepStrictEqual(fileArgs(nodeArgs('test:stall-guard')), [SELF],
    'npm run test:stall-guard does not run this file, and only this file');
  assert.ok(requiresOf('test:stall-guard').includes('./test/helpers/account-home-refused.js'),
    'npm run test:stall-guard does not load what keeps a test out of the account home, as npm test does');
});
