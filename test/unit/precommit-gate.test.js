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
const { refusal } = require('../../scripts/precommit-gate.js');

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
