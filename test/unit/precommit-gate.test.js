'use strict';
// The pre-commit gate refuses for a NAMED reason.
//
// Three errors in the 0.11.7 run died at the same four steps: verify the
// branch, run the checks, read the result, commit. This turns those steps into
// a record and a refusal.
//
// Every test asserts the refusal CODE, not merely that something was refused.
// A guard that blocks for the wrong reason blocks for no reason eventually,
// and "it failed" cannot tell those apart. That distinction is the whole
// difference between a control and a tripwire nobody trusts.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  refusal, buildRecord, writeRecord, readRecord, currentTree, defaultBranch,
  isReleaseCommit, RELEASE_FOOTPRINT, stagedPaths,
} = require('../../scripts/precommit-gate.js');

const TREE = 'a'.repeat(40);
const OTHER_TREE = 'b'.repeat(40);
const BRANCH = 'fix/some-card';
const MAIN = 'main';

const ok = { tree: TREE, branch: BRANCH, at: '2026-08-20T00:00:00.000Z', steps: ['test'] };

describe('the pre-commit gate', () => {
  test('admits a commit when the record matches this tree on this branch', () => {
    const why = refusal({ record: ok, tree: TREE, branch: BRANCH, mainBranch: MAIN });
    assert.strictEqual(why, null);
  });

  test('refuses a commit made directly to the default branch', () => {
    // The first of the four steps. Checked before the record, because a valid
    // record on the wrong branch is still the mistake this catches.
    const why = refusal({ record: ok, tree: TREE, branch: MAIN, mainBranch: MAIN });
    assert.strictEqual(why.code, 'on-default-branch');
    assert.match(why.message, /Branch first/);
  });

  test('refuses when the checks have never been run', () => {
    const why = refusal({ record: null, tree: TREE, branch: BRANCH, mainBranch: MAIN });
    assert.strictEqual(why.code, 'no-record');
    assert.match(why.message, /npm run precommit/);
  });

  test('refuses a record left behind by a different branch', () => {
    const why = refusal({
      record: { ...ok, branch: 'fix/a-different-card' },
      tree: TREE, branch: BRANCH, mainBranch: MAIN,
    });
    assert.strictEqual(why.code, 'wrong-branch');
    assert.match(why.message, /a-different-card/);
  });

  test('refuses a record whose tree is not the tree being committed', () => {
    // The case a timestamp cannot catch: the checks passed, then something was
    // staged on top. The record is honest about a tree that is no longer the
    // one going in.
    const why = refusal({ record: ok, tree: OTHER_TREE, branch: BRANCH, mainBranch: MAIN });
    assert.strictEqual(why.code, 'stale-record');
    assert.match(why.message, /something changed after the checks ran/);
  });

  test('every refusal says what to do next', () => {
    const cases = [
      refusal({ record: null, tree: TREE, branch: BRANCH, mainBranch: MAIN }),
      refusal({ record: { ...ok, branch: 'other' }, tree: TREE, branch: BRANCH, mainBranch: MAIN }),
      refusal({ record: ok, tree: OTHER_TREE, branch: BRANCH, mainBranch: MAIN }),
    ];
    for (const why of cases) {
      assert.match(why.message, /npm run precommit/, `${why.code} names the command that fixes it`);
    }
  });
});

// ---------------------------------------------------------------------------
// The mechanism, against real git
// ---------------------------------------------------------------------------

// The tests above drive the pure decision with hand-built values, which proves
// the decision and nothing else. The claim this guard actually rests on lives
// in the parts that touch reality: that a record written by the gate is read
// back as the same record, and that the tree hash MOVES when something is
// staged on top of a checked tree. A field renamed on one side only, or a
// write-tree taken before the index refresh, would leave every test above green
// while the guard quietly matched nothing. So this exercises the real functions
// against a real repository.
function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'precommit-gate-'));
  const run = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  run('init', '-q');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'first\n');
  run('add', '-A');
  return { dir, run };
}

describe('the record and the tree hash, against a real repository', () => {
  test('a record written by the gate reads back as the same record', () => {
    const { dir } = tempRepo();
    const file = path.join(dir, '.precommit-gate.json');
    try {
      const written = buildRecord({ tree: currentTree(dir), branch: 'fix/card', at: '2026-08-20T00:00:00.000Z' });
      writeRecord(written, file);
      assert.deepStrictEqual(readRecord(file), written);
      // Named explicitly: these are the fields refusal() compares, and a
      // rename on one side is the failure this test exists for.
      assert.ok(readRecord(file).tree);
      assert.ok(readRecord(file).branch);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('staging a further edit changes the tree, so the record goes stale', () => {
    const { dir, run } = tempRepo();
    try {
      const before = currentTree(dir);
      const record = buildRecord({ tree: before, branch: 'fix/card', at: '2026-08-20T00:00:00.000Z' });
      // The same tree, unchanged: the gate admits it.
      assert.strictEqual(
        refusal({ record, tree: currentTree(dir), branch: 'fix/card', mainBranch: 'main' }),
        null,
      );

      fs.writeFileSync(path.join(dir, 'a.txt'), 'second\n');
      run('add', '-A');
      const after = currentTree(dir);

      assert.notStrictEqual(after, before, 'write-tree moves when content is staged on top');
      const why = refusal({ record, tree: after, branch: 'fix/card', mainBranch: 'main' });
      assert.strictEqual(why.code, 'stale-record');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a missing record file reads as no record, rather than throwing', () => {
    const { dir } = tempRepo();
    try {
      assert.strictEqual(readRecord(path.join(dir, 'nope.json')), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The entry points, spawned for real
// ---------------------------------------------------------------------------

// Everything above tests the decision and the git primitives. Neither is what
// npm and the git hook actually call. run() and verify() are the wiring, and
// wiring is where a swapped field or a record read from the wrong path lives:
// both would leave every test above green while the guard admitted anything.
// So these spawn the real script against a throwaway repository.
const GATE = path.join(__dirname, '..', '..', 'scripts', 'precommit-gate.js');

function spawnGate(args, root) {
  const res = require('node:child_process').spawnSync(
    process.execPath, [GATE, ...args],
    { env: { ...process.env, PRECOMMIT_GATE_ROOT: root }, encoding: 'utf8' },
  );
  return { code: res.status, out: `${res.stdout || ''}${res.stderr || ''}` };
}

function repoWithScripts(scripts) {
  const { dir, run } = tempRepo();
  run('checkout', '-q', '-b', 'fix/card');
  fs.writeFileSync(path.join(dir, 'package.json'),
    JSON.stringify({ name: 'tmp', version: '1.0.0', scripts }, null, 2));
  run('add', '-A');
  return { dir, run };
}

describe('the entry points, against a throwaway repository', () => {
  test('a failing step writes no record and exits non-zero', () => {
    // The branch that matters most: a check failed, so nothing may vouch for
    // this tree. If the loop stopped short-circuiting, the record would be
    // written anyway and the guard would wave through an unverified commit.
    const { dir } = repoWithScripts({
      test: 'node -e "process.exit(1)"',
      typecheck: 'node -e "0"', 'lint:styles': 'node -e "0"', 'check:refs': 'node -e "0"',
    });
    try {
      const { code } = spawnGate([], dir);
      assert.notStrictEqual(code, 0, 'a failing check fails the gate');
      assert.ok(!fs.existsSync(path.join(dir, '.precommit-gate.json')),
        'no record is written when a step failed');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('all steps passing writes a record for this tree and branch', () => {
    const { dir } = repoWithScripts({
      test: 'node -e "0"', typecheck: 'node -e "0"',
      'lint:styles': 'node -e "0"', 'check:refs': 'node -e "0"',
    });
    try {
      const { code } = spawnGate([], dir);
      assert.strictEqual(code, 0);
      const record = readRecord(path.join(dir, '.precommit-gate.json'));
      assert.ok(record, 'a record is written');
      assert.strictEqual(record.branch, 'fix/card');
      assert.strictEqual(record.tree, currentTree(dir), 'and it names the tree that was checked');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--verify admits a commit when the record matches', () => {
    const { dir } = repoWithScripts({
      test: 'node -e "0"', typecheck: 'node -e "0"',
      'lint:styles': 'node -e "0"', 'check:refs': 'node -e "0"',
    });
    try {
      assert.strictEqual(spawnGate([], dir).code, 0, 'gate passes first');
      assert.strictEqual(spawnGate(['--verify'], dir).code, 0, 'and the commit is admitted');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--verify refuses, and says why, when the tree moved after the checks', () => {
    const { dir, run } = repoWithScripts({
      test: 'node -e "0"', typecheck: 'node -e "0"',
      'lint:styles': 'node -e "0"', 'check:refs': 'node -e "0"',
    });
    try {
      assert.strictEqual(spawnGate([], dir).code, 0);
      fs.writeFileSync(path.join(dir, 'a.txt'), 'changed after the checks\n');
      run('add', '-A');
      const { code, out } = spawnGate(['--verify'], dir);
      assert.notStrictEqual(code, 0, 'a moved tree is refused');
      assert.match(out, /something changed after the checks ran/,
        'and the refusal names which of the three it was');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--verify refuses when the checks have never been run', () => {
    const { dir } = repoWithScripts({ test: 'node -e "0"' });
    try {
      const { code, out } = spawnGate(['--verify'], dir);
      assert.notStrictEqual(code, 0);
      assert.match(out, /have not been run/);
      assert.match(out, /npm run precommit/, 'and names the command that fixes it');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the tree that was checked is the tree that gets recorded', () => {
  const PASSING = {
    test: 'node -e "0"', typecheck: 'node -e "0"',
    'lint:styles': 'node -e "0"', 'check:refs': 'node -e "0"',
  };

  test('an unstaged edit is refused, because the checks would read a different tree', () => {
    // The gap this closes: STEPS run against the working directory while the
    // record hashes the index. Stage, edit again without staging, and the
    // checks validate content the record does not name. Committing then puts
    // the older staged version in, and verify() admits it because the index
    // never moved: a tree certified without ever being checked.
    const { dir } = repoWithScripts(PASSING);
    try {
      fs.writeFileSync(path.join(dir, 'a.txt'), 'edited after staging\n');
      const { code, out } = spawnGate([], dir);
      assert.notStrictEqual(code, 0, 'drift between working tree and index is refused');
      assert.match(out, /does not match what is staged/);
      assert.match(out, /a\.txt/, 'and it names the file');
      assert.ok(!fs.existsSync(path.join(dir, '.precommit-gate.json')), 'no record is written');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an untracked file is refused too: the checks would read it, the record would not name it', () => {
    const { dir } = repoWithScripts(PASSING);
    try {
      fs.writeFileSync(path.join(dir, 'new-test.js'), '// never staged\n');
      const { code, out } = spawnGate([], dir);
      assert.notStrictEqual(code, 0);
      assert.match(out, /new-test\.js/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the real entry point refuses to run on the default branch', () => {
    // run() carries its own branch check, separate from refusal()'s. Covering
    // only the shared decision left this copy untested.
    const { dir, run } = repoWithScripts(PASSING);
    try {
      run('commit', '-q', '-m', 'initial');
      run('checkout', '-q', '-B', 'main');
      const { code, out } = spawnGate([], dir);
      assert.notStrictEqual(code, 0, 'the gate refuses on the default branch');
      assert.match(out, /refusing to run on main/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a record written on one branch is refused after switching to another', () => {
    // The wrong-branch case, end to end rather than hand-built: a real record,
    // a real checkout, and the refusal the fixture only assumed.
    const { dir, run } = repoWithScripts(PASSING);
    try {
      assert.strictEqual(spawnGate([], dir).code, 0, 'record written on fix/card');
      run('commit', '-q', '-m', 'initial');
      run('checkout', '-q', '-b', 'fix/other-card');
      const { code, out } = spawnGate(['--verify'], dir);
      assert.notStrictEqual(code, 0);
      assert.match(out, /is for branch "fix\/card"/, 'the refusal names the branch the record belongs to');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the default branch is read from the remote, not assumed', () => {
  // Every other repository here is a bare `git init` with no origin, so only
  // the catch-fallback ran and the remote-reading line was dead to the suite:
  // replacing it with `return 'main'` would have left every test passing. A
  // project whose default branch is not called main would have been told to
  // "branch first" while already on a branch, or worse, allowed to commit
  // straight to its trunk.
  test('a remote HEAD pointing at trunk resolves to trunk, not main', () => {
    const { dir, run } = tempRepo();
    try {
      run('commit', '-q', '-m', 'initial');
      // A remote that exists locally is enough: the lookup reads the
      // remote-tracking ref, and never talks to a server.
      run('remote', 'add', 'origin', dir);
      run('update-ref', 'refs/remotes/origin/trunk', 'HEAD');
      run('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');

      assert.strictEqual(defaultBranch(dir), 'trunk',
        'the remote HEAD is read, and the origin/ prefix stripped');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('with no remote at all it falls back to main', () => {
    // The other half, kept explicit so the fallback is a stated behaviour
    // rather than the only one anything ever reached.
    const { dir } = tempRepo();
    try {
      assert.strictEqual(defaultBranch(dir), 'main');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the release commit is the one thing allowed on the default branch', () => {
  // scripts/release.js bumps the version, promotes the changelog and commits
  // straight to main. That is by design, and on the day this guard merged it
  // stopped `npm run release` dead: the version was bumped, the changelog
  // promoted, and the commit refused. A gate that blocks the release tool
  // shipping beside it is not protecting anything.
  const onMain = (staged) => refusal({
    record: null, tree: TREE, branch: MAIN, mainBranch: MAIN, staged,
  });

  test('the release footprint is admitted', () => {
    assert.strictEqual(onMain(['package.json', 'CHANGELOG.md']), null);
    // Either alone is still the release commit's shape.
    assert.strictEqual(onMain(['package.json']), null);
    assert.strictEqual(onMain(['CHANGELOG.md']), null);
  });

  test('anything else alongside it is still refused', () => {
    // The exception is the footprint, not the presence of a version bump. A
    // source file riding along is exactly what this guard exists to stop.
    assert.strictEqual(onMain(['package.json', 'server.js']).code, 'on-default-branch');
    assert.strictEqual(onMain(['CHANGELOG.md', 'lib/agents/prompt.js']).code, 'on-default-branch');
    assert.strictEqual(onMain(['server.js']).code, 'on-default-branch');
  });

  test('an empty staging area is not a release commit', () => {
    // Nothing staged means nothing to vouch for, and admitting it would let
    // an empty or amend-shaped commit through on the default branch.
    assert.strictEqual(onMain([]).code, 'on-default-branch');
    assert.strictEqual(isReleaseCommit([]), false);
  });

  test('on a feature branch the footprint still faces the normal checks', () => {
    // The exception is about the DEFAULT branch. Elsewhere a changelog edit is
    // an ordinary commit and needs a record like any other.
    const why = refusal({
      record: null, tree: TREE, branch: BRANCH, mainBranch: MAIN,
      staged: ['CHANGELOG.md'],
    });
    assert.strictEqual(why.code, 'no-record');
  });

  test('the footprint is exactly the two files release.js touches', () => {
    assert.deepStrictEqual([...RELEASE_FOOTPRINT].sort(), ['CHANGELOG.md', 'package.json']);
  });
});

describe('the release commit, through the real entry point on real git', () => {
  // Everything above hands refusal() a staged array built by hand, which is a
  // double for what stagedPaths() returns. That proves the decision and not the
  // wiring, and the wiring is the whole card: if stagedPaths() had wrong flags
  // or mishandled a path, every test above would stay green while npm run
  // release failed exactly as it did the night this was written.
  const PASSING = {
    test: 'node -e "0"', typecheck: 'node -e "0"',
    'lint:styles': 'node -e "0"', 'check:refs': 'node -e "0"',
  };

  function repoOnDefaultBranch() {
    const { dir, run } = repoWithScripts(PASSING);
    run('commit', '-q', '-m', 'initial');
    run('checkout', '-q', '-B', 'main');
    fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n\n## Unreleased\n');
    fs.writeFileSync(path.join(dir, 'server.js'), '// source\n');
    run('add', '-A');
    run('commit', '-q', '-m', 'add changelog and a source file');
    return { dir, run };
  }

  test('the real hook admits a release-shaped commit on the default branch', () => {
    const { dir, run } = repoOnDefaultBranch();
    try {
      // What release.js does: bump the version, promote the changelog, stage
      // exactly those two, commit on main.
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      pkg.version = '1.0.1';
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
      fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n\n## 1.0.1 (today)\n');
      run('add', 'package.json', 'CHANGELOG.md');

      const { code, out } = spawnGate(['--verify'], dir);
      assert.strictEqual(code, 0, `the release commit must be admitted, got: ${out}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the real hook refuses a source file riding along with it', () => {
    const { dir, run } = repoOnDefaultBranch();
    try {
      fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n\n## 1.0.1 (today)\n');
      fs.writeFileSync(path.join(dir, 'server.js'), '// snuck in\n');
      run('add', 'CHANGELOG.md', 'server.js');

      const { code, out } = spawnGate(['--verify'], dir);
      assert.notStrictEqual(code, 0, 'a source file on the default branch is refused');
      assert.match(out, /refusing to commit directly to main/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('stagedPaths reads the index, and reads it the way refusal expects', () => {
    // Named separately because a path normalisation bug here would be
    // invisible above: refusal() compares against bare names, so anything
    // returning a prefixed or quoted path would silently stop matching.
    const { dir, run } = repoOnDefaultBranch();
    try {
      fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# changed\n');
      run('add', 'CHANGELOG.md');
      assert.deepStrictEqual(stagedPaths(dir), ['CHANGELOG.md']);
      assert.strictEqual(isReleaseCommit(stagedPaths(dir)), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
