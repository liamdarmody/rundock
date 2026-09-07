'use strict';
// The gate runs the harnesses a change can affect, and says which it did not.
//
// EVERY TEST HERE IS ABOUT THE FAIL-SAFE DIRECTION, because that is the only
// failure this tool can introduce. Running a harness that was not needed costs
// time. NOT running one that was needed produces a green gate that never
// looked, which is worse than the twenty minutes it saves and is exactly the
// class of failure the session that motivated this spent hours chasing.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  harnessTargets, selectHarnesses, harnessFiles, RUN_EVERYTHING_WHEN_TOUCHED,
} = require('../../scripts/mutation-scope.js');

const H = (tool, targets) => ({ tool, targets });

describe('what a harness touches, read without running it', () => {
  test('targets come out of the source text, and every real harness yields some', () => {
    // READ, NEVER REQUIRED. Loading a harness module executes at least one of
    // them: measured, when an attempt to introspect them by require ran a
    // mutation run. So this reads the file as text, and the whole tool depends
    // on that staying true.
    const tools = path.join(__dirname, '..', 'tools');
    const found = harnessFiles(tools);
    assert.ok(found.length >= 15, `expected the real harnesses, found ${found.length}`);
    for (const tool of found) {
      const targets = harnessTargets(fs.readFileSync(path.join(tools, tool), 'utf8'));
      assert.ok(targets && targets.length,
        `${tool}: no targets could be read, so it would be run every time rather than skipped in error`);
      for (const t of targets) {
        assert.doesNotMatch(t, /^\//, `${tool}: ${t} should be repository-relative`);
      }
    }
  });

  test('a source that names no target yields null, which is not an empty list', () => {
    // The distinction the whole tool rests on. An empty list would mean
    // "touches nothing, safe to skip"; null means "could not be determined,
    // so run it". Conflating them is how a needed harness gets skipped.
    assert.strictEqual(harnessTargets('const X = somethingElse();'), null);
    assert.strictEqual(harnessTargets(''), null);
    assert.strictEqual(harnessTargets(null), null);
    assert.deepStrictEqual(harnessTargets("const A = { src: path.join(ROOT, 'lib', 'a.js') };"), ['lib/a.js']);
  });
});

describe('selection is conservative in every direction that is not proven safe', () => {
  const HARNESSES = [
    H('mutate-a-guards.js', ['lib/a.js']),
    H('mutate-b-guards.js', ['lib/b.js', 'public/b.js']),
    H('mutate-unknown-guards.js', null),
  ];

  test('a harness runs when any file it names is touched', () => {
    const plan = selectHarnesses(['public/b.js'], HARNESSES);
    assert.ok(plan.run.includes('mutate-b-guards.js'), 'the harness that names the file runs');
    assert.ok(plan.skipped.some(s => s.tool === 'mutate-a-guards.js'), 'the one that does not is skipped');
  });

  test('a harness whose targets cannot be read ALWAYS runs', () => {
    // The single most important row here. A harness this tool cannot read is
    // one it knows nothing about, and the only safe thing to do with a harness
    // you know nothing about is run it.
    const plan = selectHarnesses(['docs/README.md'], HARNESSES);
    assert.ok(plan.run.includes('mutate-unknown-guards.js'),
      'unreadable targets mean run, never skip');
    assert.ok(!plan.skipped.some(s => s.tool === 'mutate-unknown-guards.js'));
  });

  test('no changed files means no basis for a decision, so everything runs', () => {
    const plan = selectHarnesses([], HARNESSES);
    assert.deepStrictEqual(plan.run.sort(), HARNESSES.map(h => h.tool).sort());
    assert.deepStrictEqual(plan.skipped, []);
    assert.match(plan.reason, /no changed files/);
  });

  test('touching the machinery runs everything, one case per trigger', () => {
    // Stated as its own case per trigger rather than one summary assertion,
    // because each is a different reason: the gate decides what runs, the
    // shared mutation module decides how a run recovers, a test helper decides
    // what a suite proves, package.json holds the full chain, and a harness
    // file decides what that harness proves at all.
    for (const trigger of ['package.json', 'scripts/precommit-gate.js', 'test/tools/mutation-run.js',
      'test/helpers/harness.js', 'test/tools/mutate-b-guards.js', 'scripts/mutation-scope.js']) {
      const plan = selectHarnesses([trigger], HARNESSES);
      assert.deepStrictEqual(plan.run.sort(), HARNESSES.map(h => h.tool).sort(),
        `${trigger} must run every harness`);
      assert.deepStrictEqual(plan.skipped, [], `${trigger} must skip nothing`);
      assert.match(plan.reason, /can change what any harness proves/);
    }
  });

  test('the machinery list is not empty, or every guard above passes vacuously', () => {
    assert.ok(RUN_EVERYTHING_WHEN_TOUCHED.length >= 5);
    assert.ok(RUN_EVERYTHING_WHEN_TOUCHED.includes('test/tools/mutation-run.js'),
      'the shared crash-marker module is the one whose change invalidates every restore');
  });

  test('a skip is always accompanied by the reason it was safe', () => {
    // A record that says a harness did not run, without saying why, asks a
    // reader to re-derive the decision. The point of writing it down is that
    // they do not have to.
    const plan = selectHarnesses(['lib/a.js'], HARNESSES);
    assert.ok(plan.skipped.length);
    for (const s of plan.skipped) {
      assert.match(s.reason, /touches none of: .+/, `${s.tool} names what it would have needed`);
    }
  });
});

describe('the scoped run and the full run agree', () => {
  test('a change touching a real harness target selects that harness and no other by accident', () => {
    // GS-4 in the small: the selection is checked against the real harnesses
    // rather than fixtures, so a harness whose targets move is caught here
    // rather than by a green gate that skipped it.
    const tools = path.join(__dirname, '..', 'tools');
    const harnesses = harnessFiles(tools).map(tool => ({
      tool, targets: harnessTargets(fs.readFileSync(path.join(tools, tool), 'utf8')),
    }));
    const boundary = harnesses.find(h => h.tool === 'mutate-workspace-boundary-guards.js');
    assert.ok(boundary && boundary.targets.includes('scripts/permission-hook.js'),
      'the boundary harness names the hook it mutates');

    const plan = selectHarnesses(['scripts/permission-hook.js'], harnesses);
    assert.ok(plan.run.includes('mutate-workspace-boundary-guards.js'));
    // And every harness that does NOT name that file is accounted for as a
    // skip: nothing may fall out of both lists.
    assert.strictEqual(plan.run.length + plan.skipped.length, harnesses.length,
      'every harness is either run or skipped with a reason, never silently dropped');
  });

  test('a documentation-only change runs nothing, which is the whole point', () => {
    const tools = path.join(__dirname, '..', 'tools');
    const harnesses = harnessFiles(tools).map(tool => ({
      tool, targets: harnessTargets(fs.readFileSync(path.join(tools, tool), 'utf8')),
    }));
    const plan = selectHarnesses(['CHANGELOG.md'], harnesses);
    assert.strictEqual(plan.run.length, 0, 'a changelog edit mutates no source');
    assert.strictEqual(plan.skipped.length, harnesses.length);
  });
});
