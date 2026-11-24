'use strict';
// assertSafePath, driven directly. It walks from the workspace root to the
// path with lstat and calls `raise` for a path outside the workspace or for a
// link anywhere along the way; a missing tail is where a write would create,
// so the walk stops there. Its refusals also surface through writeAsUnit in
// atomic-write.test.js, which stays as it is.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { assertSafePath } = require('../../lib/workspace/atomic-write.js');
const { makeTempDir } = require('../helpers/workspace.js');

const LINKS = { skip: process.platform === 'win32' && 'links need privileges on Windows' };
const raise = (why) => { throw new Error(why); };
const workspace = () => fs.realpathSync(makeTempDir('safe-path-'));

describe('assertSafePath', () => {
  test('a path whose tail does not exist yet returns', () => {
    assert.strictEqual(typeof assertSafePath, 'function');
    const root = workspace();
    fs.mkdirSync(path.join(root, 'notes'));
    assertSafePath(root, path.join(root, 'notes', 'new', 'deeper', 'a.txt'), raise);
  });

  test('a path outside the workspace raises', () => {
    assert.strictEqual(typeof assertSafePath, 'function');
    const root = workspace();
    assert.throws(
      () => assertSafePath(root, path.resolve(root, '..', 'elsewhere.txt'), raise),
      { message: 'must stay inside the workspace' },
    );
  });

  test('a link at an intermediate folder raises', LINKS, () => {
    assert.strictEqual(typeof assertSafePath, 'function');
    const root = workspace();
    const outside = workspace();
    fs.symlinkSync(outside, path.join(root, 'notes'));
    assert.throws(
      () => assertSafePath(root, path.join(root, 'notes', 'a.txt'), raise),
      { message: 'passes through a symlink, which writes never follow' },
    );
  });

  test('a link at the final component raises', LINKS, () => {
    assert.strictEqual(typeof assertSafePath, 'function');
    const root = workspace();
    const outside = path.join(workspace(), 'secret.txt');
    fs.writeFileSync(outside, 'keep');
    fs.symlinkSync(outside, path.join(root, 'a.txt'));
    assert.throws(
      () => assertSafePath(root, path.join(root, 'a.txt'), raise),
      { message: 'passes through a symlink, which writes never follow' },
    );
  });
});
