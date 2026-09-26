'use strict';
// The gate runs the harnesses a change can affect, and says which it did not.
//
// EVERY TEST HERE IS ABOUT THE FAIL-SAFE DIRECTION, because that is the only
// failure this tool can introduce. Running a harness that was not needed costs
// time. NOT running one that was needed produces a green gate that never
// looked, which is worse than the twenty minutes it saves and is exactly the
// class of failure the session that motivated this spent hours chasing.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  harnessTargets, selectHarnesses, harnessFiles, changedFiles, lastGatedTree,
  RUN_EVERYTHING_WHEN_TOUCHED,
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
    // A HARNESS FILE IS NO LONGER IN THIS LIST, deliberately. It used to be, on
    // the reasoning that it decides what that harness proves; it does, and that
    // is an argument for running THAT harness, which the case above now covers.
    // Running the other seventeen for it was the reason the selection almost
    // never applied to real work, because every card that adds a guard edits a
    // harness.
    for (const trigger of ['package.json', 'scripts/precommit-gate.js', 'test/tools/mutation-run.js',
      'test/helpers/harness.js', 'scripts/mutation-scope.js']) {
      const plan = selectHarnesses([trigger], HARNESSES);
      assert.deepStrictEqual(plan.run.sort(), HARNESSES.map(h => h.tool).sort(),
        `${trigger} must run every harness`);
      assert.deepStrictEqual(plan.skipped, [], `${trigger} must skip nothing`);
      assert.match(plan.reason, /can change what any harness proves/);
    }
  });

  test('touching ONE harness runs that harness, and says nothing about the others', () => {
    // The rule this replaced ran all eighteen whenever anything under
    // test/tools/ changed, on the reasoning that a harness file decides what
    // that harness proves. True, and it does not follow that it decides what
    // the other seventeen prove: editing the boundary harness cannot change
    // what the renderer harness asserts. Every card that adds a guard edits a
    // harness, so in practice the selection almost never applied to real work.
    const plan = selectHarnesses(['test/tools/mutate-a-guards.js'], HARNESSES);
    assert.ok(plan.run.includes('mutate-a-guards.js'), 'its own file is a reason to run it');
    assert.ok(plan.skipped.some(s => s.tool === 'mutate-b-guards.js'),
      'and an unrelated harness is still skipped, with its reason');
    // The unreadable one still runs, because that rule is untouched.
    assert.ok(plan.run.includes('mutate-unknown-guards.js'));
  });

  test('the shared machinery still runs everything, which is the half that must not move', () => {
    // The fail-safe direction. A harness file is narrow; the crash marker, the
    // selector, the gate and the helpers are not, because they can change what
    // ANY harness proves.
    for (const trigger of ['test/tools/mutation-run.js', 'scripts/mutation-scope.js',
      'scripts/precommit-gate.js', 'test/helpers/harness.js', 'package.json']) {
      const plan = selectHarnesses([trigger], HARNESSES);
      assert.deepStrictEqual(plan.run.sort(), HARNESSES.map(h => h.tool).sort(),
        `${trigger} must still run every harness`);
      assert.deepStrictEqual(plan.skipped, [], `${trigger} must skip nothing`);
    }
  });

  test('every shared module the real harnesses depend on is still a run-everything trigger', () => {
    // THE FALSE GREEN THIS CHANGE COULD HAVE CREATED, made checkable instead of
    // asserted. Removing the directory-wide trigger means a file under
    // test/tools/ that is neither a harness nor named in the machinery list now
    // selects NOTHING. That is correct only while no harness depends on such a
    // file, which is true today and is exactly the kind of thing that stops
    // being true when somebody adds a helper.
    //
    // So this reads the real harnesses rather than a fixture, and requires every
    // shared module they pull in to be covered. A new helper under test/tools/
    // fails here, on the day it is added, with a message saying what to do.
    // THE SUITES COUNT TOO, and missing them was the narrower claim this guard
    // used to make. A harness's verdict comes from the suite it drives, so a
    // helper required by that SUITE is a shared dependency of the harness just
    // as much as one required by the harness file, and the directory-wide
    // trigger used to cover both. Quotes of either kind, and an omitted
    // extension, because a require that does not match the pattern is a
    // dependency this guard silently stops seeing.
    const root = path.join(__dirname, '..', '..');
    const tools = path.join(root, 'test', 'tools');
    const readable = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return null; } };
    const sources = [];
    for (const tool of harnessFiles(tools)) {
      const src = readable(path.join(tools, tool));
      if (src) sources.push(src);
      for (const m of src.matchAll(/suite:\s*'([^']+)'/g)) {
        const suite = readable(path.join(root, m[1]));
        if (suite) sources.push(suite);
      }
    }
    const shared = new Set();
    // A HARNESS IS FULL OF SOURCE TEXT THAT IS NOT ITS OWN SOURCE. Every
    // mutation a harness applies is a string holding the code it substitutes
    // in, and those strings contain require() calls belonging to the file
    // under mutation. Scanning a harness for require() therefore finds
    // dependencies it does not have: mutate-host-wiring-guards.js names
    // `./extension-record.js` inside two replacement snippets, and the real
    // module is lib/packages/extension-record.js, which is not under
    // test/tools at all. Requiring the path to resolve to a file is what
    // separates a dependency from a quotation, and it costs nothing, because
    // a shared module that does not exist cannot be shared.
    const addIfReal = (rel) => {
      const file = rel.endsWith('.js') ? rel : `${rel}.js`;
      if (fs.existsSync(path.join(root, file))) shared.add(file);
    };
    for (const src of sources) {
      for (const m of src.matchAll(/require\(\s*['"]([^'"]*tools\/[^'"]+)['"]\s*\)/g)) {
        addIfReal(m[1].replace(/^.*?tools\//, 'test/tools/'));
      }
      for (const m of src.matchAll(/require\(\s*['"]\.\/([^'"]+)['"]\s*\)/g)) {
        addIfReal(`test/tools/${m[1]}`);
      }
    }
    assert.ok(sources.length > harnessFiles(tools).length,
      'sanity: the suites were read as well as the harnesses, or this checks half of what it says');
    assert.ok(shared.size >= 1, 'sanity: the harnesses were read and they do share something');
    for (const dep of shared) {
      const covered = RUN_EVERYTHING_WHEN_TOUCHED.some(t => (t.endsWith('/') ? dep.startsWith(t) : dep === t));
      assert.ok(covered,
        `${dep} is shared by a harness but changing it would select no harness at all. `
        + 'Add it to RUN_EVERYTHING_WHEN_TOUCHED, because a change to something every harness '
        + 'requires can change what any of them proves.');
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
    // In the small: the selection is checked against the real harnesses
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

describe('the comparison base is the last tree a passing gate certified', () => {
  // THE DEFECT THIS BLOCK PINS: the base used to be the merge base with
  // origin/main, which on a long branch means everything since the divergence,
  // forever, and that set contains package.json, a run-everything trigger.
  // Sixteen gate runs and 3.4 hours of mutation testing on one branch, almost
  // all of it re-proving what an earlier pass had already certified, because a
  // three-file slice was measured against the whole branch. A gate record
  // certifies a tree, so the changed set is measured against that tree when it
  // is in this branch's history, and against the merge base in every case
  // where the record cannot be trusted.
  //
  // A REAL REPOSITORY, NOT A STUB. The decision under test is "which git
  // question gets asked", and a stubbed git can only prove the code asked the
  // question the test expected, which is the defect restated. The fixture is a
  // branch several commits deep past its origin/main, touching package.json on
  // the way, which is exactly the shape the merge base got wrong.

  const roots = [];
  after(() => { for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true }); });

  function fixtureRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-scope-base-'));
    roots.push(dir);
    const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const write = (rel, content) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content);
    };
    git(['init', '--initial-branch=main']);
    git(['config', 'user.email', 'scope-test@example.com']);
    git(['config', 'user.name', 'Scope Test']);
    git(['config', 'commit.gpgsign', 'false']);
    // Ignored in the fixture as it is in the real repository: the record is a
    // local certificate, never content, and a base that counted it as a
    // changed file would invalidate itself by existing.
    write('.gitignore', '.precommit-gate.json\n.mutation-scope.json\n');
    write('package.json', '{ "name": "fixture" }\n');
    write('scripts/permission-hook.js', 'hook v0\n');
    write('lib/other.js', 'other v0\n');
    git(['add', '-A']);
    git(['commit', '-m', 'initial']);
    // The trunk this branch diverged from, pinned where merge-base looks for
    // it, so the fallback path is the real fallback path and not a git error.
    git(['update-ref', 'refs/remotes/origin/main', git(['rev-parse', 'HEAD'])]);
    git(['checkout', '-b', 'integration']);
    // Several commits deep, one of them touching package.json: the branch
    // shape on which the old base ran everything for every slice.
    for (let i = 1; i <= 4; i += 1) {
      write('lib/other.js', `other v${i}\n`);
      if (i === 2) write('package.json', `{ "name": "fixture", "v": ${i} }\n`);
      git(['add', '-A']);
      git(['commit', '-m', `integration work ${i}`]);
    }
    return { dir, git, write };
  }

  function realHarnesses() {
    const tools = path.join(__dirname, '..', 'tools');
    return harnessFiles(tools).map(tool => ({
      tool, targets: harnessTargets(fs.readFileSync(path.join(tools, tool), 'utf8')),
    }));
  }

  test('a slice on a deep branch runs its one harness, not all of them', () => {
    // The acceptance case, end to end against the REAL harnesses: the gate
    // passed four commits deep, then two more commits and a staged edit
    // touched only the file the boundary harness names. Against the merge
    // base this change would contain package.json and run all of them;
    // against the gated tree it contains one file and runs one.
    const { dir, git, write } = fixtureRepo();
    fs.writeFileSync(path.join(dir, '.precommit-gate.json'),
      `${JSON.stringify({ tree: git(['rev-parse', 'HEAD^{tree}']), branch: 'integration' }, null, 2)}\n`);
    for (let i = 1; i <= 2; i += 1) {
      write('scripts/permission-hook.js', `hook v${i}\n`);
      git(['add', '-A']);
      git(['commit', '-m', `hook work ${i}`]);
    }
    write('scripts/permission-hook.js', 'hook v3\n');
    git(['add', 'scripts/permission-hook.js']);

    const changed = changedFiles(dir);
    assert.deepStrictEqual(changed.files, ['scripts/permission-hook.js'],
      'only what moved since the gated tree is in the changed set');
    assert.match(changed.base, /last gated tree [0-9a-f]{12}/,
      'the base is named, so a reader can tell narrowing from a fallback');

    const harnesses = realHarnesses();
    const plan = selectHarnesses(changed.files, harnesses);
    assert.deepStrictEqual(plan.run, ['mutate-workspace-boundary-guards.js'],
      'the one harness that names the file runs, and no other');
    assert.strictEqual(plan.skipped.length, harnesses.length - 1,
      'every other harness is skipped, each with its reason, none dropped');
  });

  test('a change reverted since the gated tree is not a change', () => {
    // The base is a tree comparison, not a union of per-commit diffs: a file
    // edited and put back holds exactly the content the gate certified, so a
    // harness watching it has nothing new to prove.
    const { dir, git, write } = fixtureRepo();
    fs.writeFileSync(path.join(dir, '.precommit-gate.json'),
      `${JSON.stringify({ tree: git(['rev-parse', 'HEAD^{tree}']), branch: 'integration' }, null, 2)}\n`);
    write('lib/other.js', 'other edited\n');
    git(['add', '-A']);
    git(['commit', '-m', 'edit other']);
    write('lib/other.js', 'other v4\n');
    git(['add', '-A']);
    git(['commit', '-m', 'put other back']);
    const changed = changedFiles(dir);
    assert.deepStrictEqual(changed.files, [],
      'content identical to the certified tree is not in the changed set');
  });

  test('no record means the merge base, every harness, and the reason says so', () => {
    // The fallback half of the acceptance: the branch is deep and touched
    // package.json, so against the merge base everything runs, exactly as the
    // tool behaved before this base existed. What is new is that the output
    // now says WHICH base produced that verdict, because "package.json can
    // change what any harness proves" was honest and useless for sixteen runs
    // straight when nothing said what it was being compared to.
    const { dir } = fixtureRepo();
    const changed = changedFiles(dir);
    assert.match(changed.base, /merge base with origin\/main/);
    assert.match(changed.base, /no gate record has been written/);
    assert.ok(changed.files.includes('package.json'),
      'the whole branch is the changed set when there is no certificate');
    const harnesses = realHarnesses();
    const plan = selectHarnesses(changed.files, harnesses);
    assert.deepStrictEqual(plan.run.sort(), harnesses.map(h => h.tool).sort(),
      'with no record, every harness runs');
    assert.deepStrictEqual(plan.skipped, []);
    assert.match(plan.reason, /package\.json can change what any harness proves/);
  });

  test('a record whose tree is not in this branch\'s history falls back', () => {
    // A certificate for a tree HEAD never carried says nothing about what this
    // branch has changed: a record from another branch, or from a pass whose
    // tree was never committed, must not narrow anything here.
    const { dir, git, write } = fixtureRepo();
    git(['checkout', '-b', 'side', 'main']);
    write('lib/other.js', 'side work\n');
    git(['add', '-A']);
    git(['commit', '-m', 'side work']);
    const foreignTree = git(['rev-parse', 'HEAD^{tree}']);
    git(['checkout', 'integration']);
    fs.writeFileSync(path.join(dir, '.precommit-gate.json'),
      `${JSON.stringify({ tree: foreignTree, branch: 'side' }, null, 2)}\n`);
    assert.match(lastGatedTree(dir).fallback, /not an ancestor of HEAD/);
    const changed = changedFiles(dir);
    assert.match(changed.base, /merge base with origin\/main/);
    assert.ok(changed.files.includes('package.json'), 'the fallback set is the whole branch');
  });

  test('a record that cannot be parsed, names no tree, or names nothing resolvable falls back', () => {
    // Each corrupt shape separately, because each is a different way for the
    // certificate to be untrustworthy and each must land on the same side:
    // compare against the merge base and run everything, never guess.
    const { dir } = fixtureRepo();
    const record = path.join(dir, '.precommit-gate.json');

    fs.writeFileSync(record, 'not json at all\n');
    assert.match(lastGatedTree(dir).fallback, /could not be parsed/);

    fs.writeFileSync(record, `${JSON.stringify({ branch: 'integration' })}\n`);
    assert.match(lastGatedTree(dir).fallback, /names no tree/);

    fs.writeFileSync(record, `${JSON.stringify({ tree: '$(rm -rf /)' })}\n`);
    assert.match(lastGatedTree(dir).fallback, /names no tree/,
      'a string that is not a hash never reaches git');

    fs.writeFileSync(record, `${JSON.stringify({ tree: 'deadbeef'.repeat(5) })}\n`);
    assert.match(lastGatedTree(dir).fallback, /cannot be resolved/);

    const changed = changedFiles(dir);
    assert.match(changed.base, /merge base with origin\/main/,
      'a corrupt record narrows nothing');
  });
});
