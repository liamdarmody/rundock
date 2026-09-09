'use strict';
// The cheap half of the gate: what belongs in it, and that it reports
// everything at once.
//
// The value here is not that these checks pass, they already ran elsewhere. It
// is WHEN a person is told and HOW MANY things they are told at a time. One
// release cost about a dozen gate runs; three of its failures were bookkeeping
// that this phase decides in about two seconds, and they arrived one per run,
// three runs apart.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
// A CHILD THAT IS ITSELF A TEST RUN must not inherit this one's runner
// context: with NODE_TEST_CONTEXT set, a nested `node --test` reports to the
// parent rather than exiting on its own result, so a genuinely failing child
// hands back status 0 and a test asserting on that status silently proves
// nothing. Measured while writing the registry case below.
const cleanEnv = () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  return env;
};
const preflight = require('../../scripts/preflight.js');

describe('what the cheap phase covers', () => {
  test('every suite it names exists, or the phase silently checks less than it claims', () => {
    for (const suite of preflight.REGISTRY_SUITES) {
      assert.ok(fs.existsSync(path.join(ROOT, suite)), `${suite} is named but not present`);
    }
    assert.ok(preflight.REGISTRY_SUITES.length >= 5, 'sanity: the list was read');
  });

  test('it covers the three bookkeeping checks that cost a release a run each', () => {
    // Named individually rather than counted, because each one is a specific
    // failure that happened and cost a full gate run to discover.
    const named = preflight.REGISTRY_SUITES.join(' ');
    assert.match(named, /sdlc-gate-hardening/, 'the source-walking extraction registry');
    assert.match(named, /innerhtml-inventory/, 'the innerHTML classification and its counts');
    assert.match(named, /doc-claims/, 'documents that state the code\'s own numbers');
  });

  test('it runs the fast linters AND the typecheck, or a type error waits for the next run', () => {
    const names = preflight.CHECKS.map(c => c.name);
    assert.ok(names.includes('check:refs'));
    assert.ok(names.includes('lint:styles'));
    // Typecheck was a separate step after this phase, which meant a tree with a
    // registry problem and a type error reported one on this run and the other
    // on the next: the very pattern this phase exists to end, reproduced inside
    // the fix for it.
    assert.ok(names.includes('typecheck'),
      'a broken type is a cheap failure and must arrive with the other cheap failures');
  });

  test('the gate prints this phase WHOLE, because truncating it undoes the point of it', () => {
    // A component can be correct and still be defeated by the host it joins.
    // The gate keeps the last 25 lines of a failed step, which is right for a
    // suite whose tail carries the summary and wrong for a phase whose entire
    // contract is that every failure is on screen at once. With three failures
    // a reader would have seen the tail of the last one and nothing else.
    const { STEPS } = require('../../scripts/precommit-gate.js');
    const step = STEPS.find(s2 => s2.name === 'preflight');
    assert.ok(step, 'the phase is a step');
    assert.strictEqual(step.fullOutput, true,
      'preflight opts out of the tail rule, or its all-at-once report is cut to the last failure');
    // That the gate HONOURS the flag is proven by behaviour rather than by
    // matching a ternary in its source: precommit-gate.test.js runs the real
    // gate against a noisy failing first step and requires the earliest line to
    // survive, which is the line a tail would have eaten.
    assert.ok(STEPS.filter(s3 => s3.fullOutput).length === 1,
      'exactly one step opts out of the tail rule, so the exception stays deliberate');
  });
});

describe('membership is checkable, not hand-picked', () => {
  test('every pinned-count suite the repository inventories is in the cheap phase, or excluded with a reason', () => {
    // THE PATHOLOGY THIS CARD IS NAMED AFTER, applied to the fix for it. A hand
    // written list of cheap suites is exactly an unregistered check: it is
    // correct the day it is written and silently incomplete the first time
    // somebody adds a registry suite without thinking of this file. So the list
    // is bound to the repository's own inventory of source-walking and
    // pinned-count tests, and a new one has to join one list or the other.
    const registrySrc = fs.readFileSync(
      path.join(ROOT, 'test', 'unit', 'sdlc-gate-hardening.test.js'), 'utf8');
    const rows = [...registrySrc.matchAll(
      /\{\s*file:\s*'(test\/unit\/[^']+)'[^}]*?failLoudBy:\s*'(count|imports|mutation)'/g)];
    assert.ok(rows.length >= 20,
      `sanity: the inventory was read and has rows, found ${rows.length}`);

    const covered = new Set(preflight.REGISTRY_SUITES);
    const excused = preflight.NOT_CHEAP;
    const missing = [];
    for (const [, file, kind] of rows) {
      if (kind === 'mutation') continue; // proven by a harness, not by being cheap
      if (covered.has(file) || Object.prototype.hasOwnProperty.call(excused, file)) continue;
      missing.push(file);
    }
    assert.deepStrictEqual(missing, [],
      'these are inventoried as pinned counts or imports but are neither in the cheap phase nor '
      + 'excluded from it with a reason. Add each to REGISTRY_SUITES, or to NOT_CHEAP with a '
      + 'reason a reader can check');

    // An exclusion without a reason is not an exclusion, it is a hole.
    for (const [file, reason] of Object.entries(excused)) {
      assert.ok(typeof reason === 'string' && reason.length > 20,
        `${file} is excluded without a reason anyone could check`);
    }
  });
});

describe('captures of another program, checked before anything expensive', () => {
  test('every pinned capture exists and records the version it was taken from', () => {
    for (const pin of preflight.PINNED_RUNTIMES) {
      const file = path.join(ROOT, pin.capture);
      assert.ok(fs.existsSync(file), `${pin.name}: ${pin.capture} is named but not present`);
      const recorded = JSON.parse(fs.readFileSync(file, 'utf8')).runtimeVersion;
      assert.match(String(recorded), /^\d+\.\d+\.\d+$/,
        `${pin.name}: a capture without a version cannot be known to be stale`);
      assert.ok(pin.recapture.length > 10, `${pin.name}: says how to re-take it`);
    }
    assert.ok(preflight.PINNED_RUNTIMES.length >= 2, 'sanity: both captures are covered');
  });

  test('a stale capture is reported, and a matching one is not', () => {
    // THE FAILURE THIS PREVENTS, twice in two days: a CLI upgrade made a capture
    // stale, the release gate found it deep in a run, the release was blocked and
    // a full cycle spent; then the SECOND capture failed for the same reason on
    // the next attempt. Both are decidable by reading one field.
    const out = preflight.staleCaptures();
    if (out.skipped) return; // no runtime here; the release gate still checks
    assert.ok(Array.isArray(out.stale), 'it answers with a list rather than a verdict');
    for (const c of out.stale) {
      assert.notStrictEqual(c.recorded, c.installed, 'a capture is stale only when the versions differ');
      assert.ok(c.recapture.includes('--capture'), 'and it says how to re-take it');
    }
  });
});

describe('one pass, not several', () => {
  test('a run with more than one failure reports ALL of them, and starts nothing expensive', () => {
    // THE PROPERTY THIS PHASE EXISTS FOR. Stopping at the first failure would
    // trade one slow discovery for several fast ones, which is the same day
    // back in smaller pieces. Driven by pointing the phase at two checks that
    // both fail, and asserting both are named in one run.
    const script = path.join(ROOT, 'scripts', 'preflight.js');
    const src = fs.readFileSync(script, 'utf8');
    // Two failing checks, substituted for the real ones, so the harness proves
    // the reporting rather than the checks.
    const rigged = src
      .replace(/const CHECKS = \[[\s\S]*?\];/,
        "const CHECKS = [\n"
        + "  { name: 'first-check', args: ['-e', 'console.error(\"FIRST FAILURE TEXT\"); process.exit(1)'] },\n"
        + "  { name: 'second-check', args: ['-e', 'console.error(\"SECOND FAILURE TEXT\"); process.exit(1)'] },\n"
        + '];')
      .replace("for (const c of CHECKS) results.push(run(c.name, 'npm', c.args));",
        "for (const c of CHECKS) results.push(run(c.name, process.execPath, c.args));")
      .replace(/results\.push\(run\('registries'[\s\S]*?\)\);/, '');
    const tmp = path.join(ROOT, '.rundock', 'preflight-rigged.js');
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    fs.writeFileSync(tmp, rigged);
    try {
      const r = spawnSync(process.execPath, [tmp], { cwd: ROOT, encoding: 'utf8', env: cleanEnv() });
      assert.notStrictEqual(r.status, 0, 'a failing phase must fail the run');
      const out = `${r.stdout}${r.stderr}`;
      assert.match(out, /FIRST FAILURE TEXT/, 'the first failure is reported');
      assert.match(out, /SECOND FAILURE TEXT/,
        'and so is the second: stopping at the first is the whole thing this avoids');
      assert.match(out, /Nothing expensive was started/,
        'and the reader is told the slow steps did not run, so they know what a re-run costs');
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });
});

describe('the registry suites actually run, and a broken one is reported', () => {
  test('the phase really executes the suites it names, rather than naming them and running none', () => {
    // The earlier version of this file rigged a copy with the registries
    // invocation REMOVED, so deleting that line from the real script would have
    // left every test here green while the phase checked nothing at all. This
    // runs the real script and looks for a test name only those suites produce.
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'preflight.js')],
      { cwd: ROOT, encoding: 'utf8', env: cleanEnv() });
    assert.strictEqual(r.status, 0, `the real phase should pass on this tree:\n${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /registries\.\.\. ok/, 'the registries step ran');
  });

  test('it works when run from INSIDE a test run, which is how the gate runs it', () => {
    // THE BUG THIS PINS, found on a red trunk. The phase spawns `node --test`
    // for its registry suites. With NODE_TEST_CONTEXT set, a nested runner
    // reports to the parent instead of exiting on its own result, so the
    // registries' results were attributed to the OUTER report: one suite showed
    // as both passed and failed in the same run, and the phase's exit code
    // stopped meaning anything. It was fixed in this file's own helper first and
    // not in the tool, which is why continuous integration found it and the
    // local gate did not.
    // Proven on a RIGGED copy whose only check reports what it inherited, rather
    // than by running the real phase a second time: the real one runs 28 suites,
    // and a test that makes the gate run them twice is expensive and fails under
    // its own load, which is a worse problem than the one it checks.
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'preflight.js'), 'utf8');
    const rigged = path.join(ROOT, '.rundock', 'preflight-env-rigged.js');
    fs.mkdirSync(path.dirname(rigged), { recursive: true });
    fs.writeFileSync(rigged, src
      .replace(/const CHECKS = \[[\s\S]*?\];/,
        "const CHECKS = [{ name: 'inherited', args: ['-e', 'console.error(\"CTX=\" + (process.env.NODE_TEST_CONTEXT || \"none\")); process.exit(1)'] }];")
      .replace("for (const c of CHECKS) results.push(run(c.name, 'npm', c.args));",
        "for (const c of CHECKS) results.push(run(c.name, process.execPath, c.args));")
      .replace(/results\.push\(run\('registries'[\s\S]*?\)\);/, ''));
    try {
      const r = spawnSync(process.execPath, [rigged], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, NODE_TEST_CONTEXT: 'child' },
      });
      // The check exits non-zero so the phase prints its output: a passing
      // check's output is captured and never shown, which is right for the
      // tool and would leave nothing here to read.
      assert.match(`${r.stdout}${r.stderr}`, /CTX=none/,
        'the runner context must not reach a child that is itself a test run');
    } finally {
      fs.rmSync(rigged, { force: true });
    }
  });

  test('a failing registry suite is surfaced by the phase, and stops it', () => {
    // A registry failure, replayed. The rigged copy keeps the real registries
    // invocation and ADDS a failing suite to it, so what is proven is the path
    // the product uses rather than a substitute for it.
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'preflight.js'), 'utf8');
    const dir = path.join(ROOT, '.rundock');
    fs.mkdirSync(dir, { recursive: true });
    const brokenSuite = path.join(dir, 'broken-registry.test.js');
    fs.writeFileSync(brokenSuite,
      "const { test } = require('node:test');\n"
      + "const assert = require('node:assert');\n"
      + "test('a registry that was not updated', () => { assert.fail('REGISTRY VIOLATION MARKER'); });\n");
    const rigged = path.join(dir, 'preflight-registry-rigged.js');
    fs.writeFileSync(rigged, src.replace(
      /const REGISTRY_SUITES = \[[\s\S]*?\];/,
      `const REGISTRY_SUITES = ['.rundock/broken-registry.test.js'];`));
    try {
      const r = spawnSync(process.execPath, [rigged], { cwd: ROOT, encoding: 'utf8', env: cleanEnv() });
      assert.notStrictEqual(r.status, 0, 'a broken registry must fail the phase');
      const out = `${r.stdout}${r.stderr}`;
      assert.match(out, /REGISTRY VIOLATION MARKER/,
        'and the reason must be on screen, not just a count of failures');
      assert.match(out, /Nothing expensive was started/,
        'and the reader is told the slow steps never ran');
    } finally {
      fs.rmSync(rigged, { force: true });
      fs.rmSync(brokenSuite, { force: true });
    }
  });
});

describe('the gate runs it first', () => {
  test('preflight is the first step, ahead of every expensive one', () => {
    // The ordering is the point. A cheap phase that ran after the suite would
    // report the same things at the same cost as before.
    const { STEPS } = require('../../scripts/precommit-gate.js');
    const names = STEPS.map(s => s.name);
    assert.strictEqual(names[0], 'preflight', 'the cheap phase leads');
    for (const slow of ['test:coverage', 'mutate:guards']) {
      assert.ok(names.indexOf(slow) > 0, `${slow} is in the list`);
      assert.ok(names.indexOf(slow) > names.indexOf('preflight'),
        `${slow} must run after the cheap phase, or nothing was gained`);
    }
    // And the expensive pair are still last, in cost order.
    assert.ok(names.indexOf('mutate:guards') > names.indexOf('test:coverage'),
      'the slowest step runs last');
  });

  test('reordering removed no step: the whole set is pinned, not just the order', () => {
    // The ordering assertions above name three steps, so deleting any of the
    // others would have passed every one of them. What this change was allowed
    // to do is change WHEN checks run; removing one is a different act entirely
    // and it must not be possible to do it by accident here.
    const { STEPS } = require('../../scripts/precommit-gate.js');
    assert.deepStrictEqual(STEPS.map(s2 => s2.name), [
      'preflight', 'typecheck', 'lint:styles', 'check:refs',
      // Runs a real adopted mutation harness and requires its verdicts to be the
      // ones it reported before a baseline pass was added in front of every
      // harness. Placed with the cheap checks, at about three seconds, and
      // deliberately not in the suite: a harness rewrites source files on disk,
      // so it cannot run beside tests reading those same files.
      'verdicts:pin',
      'test:coverage', 'mutate:guards', 'check:fixture',
    ], 'every check that ran before still runs; changing this set is a deliberate edit');
  });

  test('the real loop times each step and hands those timings to the record', async () => {
    // MEASURED, NOT ECHOED. The earlier version handed buildRecord a hand-built
    // array, which proves an object survives a function: drop the argument at
    // the call site and it still passes while every real record carries none.
    // This drives the shipped loop with a stub runner and a stub step list.
    const { runSteps, buildRecord } = require('../../scripts/precommit-gate.js');
    const seen = [];
    const outcome = await runSteps({
      steps: [{ name: 'cheap' }, { name: 'dear' }],
      runOne: async (step) => { seen.push(step.name); return { ok: true, out: '' }; },
    });
    assert.deepStrictEqual(seen, ['cheap', 'dear'], 'the steps ran, in order');
    assert.deepStrictEqual(outcome.timings.map(t => t.step), ['cheap', 'dear']);
    for (const t of outcome.timings) {
      assert.strictEqual(typeof t.ms, 'number', `${t.step} carries a measured duration`);
    }
    const record = buildRecord({ tree: 'deadbeef', branch: 'x', at: 'now', timings: outcome.timings });
    assert.strictEqual(record.timings.length, 2, 'and they reach the record');
    assert.ok(record.totalMs >= 0, 'with a total, so two runs can be compared directly');
  });

  test('a step ended at its ceiling is reported as unfinished, not as failed', async () => {
    // The distinction the ceilings exist for. A step killed at its ceiling
    // reached no verdict; calling that a failure sends a reader looking for a
    // broken test that is not there, which is the hour this was written to stop
    // being lost. The merge that brought the ceilings in did not carry this
    // through, and a textual merge would not have noticed.
    const { runSteps, ceilingFor, DEFAULT_STEP_CEILING_MS } = require('../../scripts/precommit-gate.js');
    assert.strictEqual(typeof ceilingFor('typecheck'), 'number', 'every step has a ceiling');
    assert.strictEqual(ceilingFor('a step nobody declared'), DEFAULT_STEP_CEILING_MS,
      'and an undeclared one inherits the default rather than running unbounded');
    const outcome = await runSteps({
      steps: [{ name: 'hangs' }],
      runOne: async () => ({ ok: false, timedOut: true, out: '', code: null, signal: null }),
    });
    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(outcome.result.timedOut, true,
      'the outcome carries the distinction through, so the caller can report it');
  });

  test('a failing step stops the run and reports what had been spent', async () => {
    const { runSteps } = require('../../scripts/precommit-gate.js');
    const ran = [];
    const outcome = await runSteps({
      steps: [{ name: 'cheap' }, { name: 'broken' }, { name: 'dear' }],
      runOne: async (step) => {
        ran.push(step.name);
        return step.name === 'broken' ? { ok: false, out: 'nope' } : { ok: true, out: '' };
      },
    });
    assert.strictEqual(outcome.ok, false);
    assert.deepStrictEqual(ran, ['cheap', 'broken'], 'the expensive step after the failure never ran');
    assert.strictEqual(outcome.failed.name, 'broken');
    assert.deepStrictEqual(outcome.timings.map(t => t.step), ['cheap', 'broken'],
      'and the failing run still carries durations, which is the case this ordering is measured on');
  });

  test('the record carries how long each step took, so the next claim can be checked', () => {
    // The reordering was justified by counting what a release cost. A claim
    // that the gate is now cheaper deserves the same evidence rather than a
    // feeling, and where the time goes moves as the suite grows.
    const { buildRecord } = require('../../scripts/precommit-gate.js');
    const record = buildRecord({
      tree: 'deadbeef', branch: 'main', at: new Date().toISOString(),
      timings: [{ step: 'preflight', ms: 2400 }, { step: 'mutate:guards', ms: 1500000 }],
    });
    assert.deepStrictEqual(record.timings.map(t => t.step), ['preflight', 'mutate:guards']);
    assert.strictEqual(record.totalMs, 1502400, 'and the total, so two runs can be compared directly');
  });

  test('a record without timings is REFUSED, so the call site cannot quietly stop passing them', () => {
    // The hole this closes was in the previous version of this very test, which
    // pinned that a missing argument was tolerated and defaulted to none.
    // Tolerance there meant the one line that makes the measurement real could
    // be deleted with every test still green and every record carrying zero.
    // There is one caller and it always has them, so absence is a defect rather
    // than a case to accommodate.
    const { buildRecord } = require('../../scripts/precommit-gate.js');
    for (const bad of [undefined, [], null]) {
      assert.throws(() => buildRecord({ tree: 'deadbeef', branch: 'main', at: 'now', timings: bad }),
        /must carry the timings/, `${String(bad)} is refused`);
    }
  });
});
