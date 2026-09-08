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
    const gate = fs.readFileSync(path.join(ROOT, 'scripts', 'precommit-gate.js'), 'utf8');
    assert.match(gate, /step\.fullOutput \? detail :/,
      'and the gate honours the flag rather than declaring it and truncating anyway');
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
      const r = spawnSync(process.execPath, [tmp], { cwd: ROOT, encoding: 'utf8' });
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

  test('a record built without timings still carries the fields, rather than throwing', () => {
    // Old records exist and the reverting check reads them. A shape that
    // depended on a field added today would fail on every tree gated before it.
    const { buildRecord } = require('../../scripts/precommit-gate.js');
    const record = buildRecord({ tree: 'deadbeef', branch: 'main', at: new Date().toISOString() });
    assert.deepStrictEqual(record.timings, []);
    assert.strictEqual(record.totalMs, 0);
  });
});
