'use strict';
// The package update check, pure: a package installed at a version tag is
// offered only a tag strictly newer under the one semver order; one
// installed at a commit (its repository had no tags) is never offered
// anything; a tag the author moved after install is named and not offered.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { checkPackageUpdate } = require('../../lib/packages/package-check.js');

const C = (n) => String(n).repeat(40).slice(0, 40);
const pkg = (reference, commit = C(1), extra = {}) => ({ id: 'https://github.com/someone/pack', updatable: true, reference, commit, ...extra });
const tags = (...pairs) => pairs.map(([name, commit]) => ({ name, commit }));

describe('checkPackageUpdate', () => {
  test('newer tags only, oldest first, under the semver order rather than the listing order', () => {
    const out = checkPackageUpdate(pkg('v1.2.0'), tags(['v10.0.0', C(5)], ['v1.2.0', C(1)], ['v2.0.0', C(3)], ['v1.10.0', C(2)], ['v1.1.0', C(9)]));
    assert.strictEqual(out.outcome, 'newer-available');
    assert.deepStrictEqual(out.newer, ['v1.10.0', 'v2.0.0', 'v10.0.0']);
    assert.strictEqual(out.current, 'v1.2.0');
    assert.strictEqual(out.moved, null);
  });

  test('an equal or older tag is never offered, and a branch or a codename is not a release', () => {
    const out = checkPackageUpdate(pkg('v1.2.0'), tags(['v1.2.0', C(1)], ['1.2.0', C(1)], ['v1.0.0', C(7)], ['main', C(8)], ['nightly', C(9)]));
    assert.strictEqual(out.outcome, 'up-to-date');
    assert.deepStrictEqual(out.newer, []);
  });

  test('a package installed at a commit is never offered an update, whatever tags appear later', () => {
    for (const reference of [null, C(4), 'main']) {
      const out = checkPackageUpdate(pkg(reference), tags(['v9.0.0', C(5)]));
      assert.strictEqual(out.outcome, 'no-release', `installed at ${reference}`);
      assert.deepStrictEqual(out.newer, []);
    }
  });

  test('a tag that now resolves to different code is named as moved', () => {
    const out = checkPackageUpdate(pkg('v1.2.0', C(1)), tags(['v1.2.0', C(6)], ['v1.3.0', C(2)]));
    assert.deepStrictEqual(out.moved, { tag: 'v1.2.0', was: C(1), now: C(6) });
    assert.deepStrictEqual(out.newer, ['v1.3.0'], 'a newer tag is still offered');
    const only = checkPackageUpdate(pkg('v1.2.0', C(1)), tags(['v1.2.0', C(6)]));
    assert.strictEqual(only.outcome, 'up-to-date', 'the moved tag itself is never offered');
    assert.ok(only.moved);
  });

  test('without a recorded commit nothing is claimed to have moved', () => {
    assert.strictEqual(checkPackageUpdate(pkg('v1.2.0', null), tags(['v1.2.0', C(6)])).moved, null);
  });

  test('a package added from a local folder cannot be checked', () => {
    assert.strictEqual(checkPackageUpdate(pkg('v1.0.0', C(1), { updatable: false }), tags(['v2.0.0', C(2)])).outcome, 'not-updatable');
  });

  test('a listing that is not an array of named tags is refused', () => {
    assert.throws(() => checkPackageUpdate(pkg('v1.0.0'), 'v2.0.0'), TypeError);
  });
});
