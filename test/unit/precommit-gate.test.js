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
  refusal, buildRecord, writeRecord, readRecord, currentTree,
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
