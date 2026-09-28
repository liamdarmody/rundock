'use strict';
// A mutation harness loads the source of every target its rows name before it
// breaks anything. When that list was kept by hand beside the rows, rows were
// added naming targets it did not load: the harness crashed at the first of
// them, and none of those rows had ever been run. The list is now derived from
// the rows, and a row naming anything that is not a loaded target is refused
// before a file is touched.
//
// Loading the boundary harness is safe: it runs only under `require.main`.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const harness = require('../tools/mutate-workspace-boundary-guards.js');
const ROOT = path.join(__dirname, '..', '..');

test('every row of the boundary harness names a loaded target with a source that exists', () => {
  const targets = harness.targetsFor(harness.MUTATIONS);
  assert.ok(targets.length > 0);
  for (const [target, label] of harness.MUTATIONS) {
    assert.ok(targets.includes(target), `${label}: its target is loaded`);
  }
});

test('a row whose target was never defined is refused, not skipped', () => {
  const real = { src: path.join(ROOT, 'scripts', 'permission-hook.js'), suite: 'test/unit/boundary.test.js' };
  assert.throws(() => harness.targetsFor([[undefined, 'a row added before its target', 'x', 'y']]), /names no target/);
  assert.throws(() => harness.targetsFor([[{ src: real.src }, 'a target with no suite', 'x', 'y']]), /names no target/);
  assert.throws(() => harness.targetsFor([[{ src: path.join(ROOT, 'no-such-file.js'), suite: real.suite }, 'a moved source', 'x', 'y']]), /does not exist/);
  assert.deepStrictEqual(harness.targetsFor([[real, 'a', 'x', 'y'], [real, 'b', 'x', 'y']]), [real], 'each target once');
});
