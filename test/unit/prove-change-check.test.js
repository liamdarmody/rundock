'use strict';
// The prove workflow's change check, which a red job runs once main is merged
// into the blocked head.
//
// The fix may change the blocker tests under test/ and the files the rows
// name, and nothing else. Every other path that differs between the merged
// blocked head and the fix head is named, and the job fails there. Renames are
// not detected, so a rename is both its paths: moving a row's file away
// changes a path that is no row's file.
//
// The check is cut out of the workflow itself, so these tests run the code the
// workflow runs, against a throwaway repository for the real diff.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { loadPiece } = require('../helpers/prove-workflow.js');
const { makeTempDir } = require('../helpers/workspace.js');

const { changedPaths, changeCheck } = loadPiece('change check', ['changedPaths', 'changeCheck']);
const { snapshot, treeChange } = loadPiece('tree', ['snapshot', 'treeChange']);

const ROWS = [{ i: 1, file: 'src/a.js', from: 'x', to: 'y', test: 1 }];

describe('which paths a fix may change', () => {
  test('a change only under test/ passes', () => {
    assert.strictEqual(changeCheck(['test/unit/a.test.js', 'test/fixtures/data.json'], ROWS), null);
  });

  test("a change to a row's file passes, with tests or alone", () => {
    assert.strictEqual(changeCheck(['src/a.js', 'test/unit/a.test.js'], ROWS), null);
    assert.strictEqual(changeCheck(['src/a.js'], ROWS), null);
  });

  test('any other path fails, and every one is named', () => {
    const why = changeCheck(['src/a.js', 'package.json', 'src/b.js', 'test/unit/a.test.js'], ROWS);
    assert.ok(why, 'the change is refused');
    assert.ok(why.includes('"package.json"') && why.includes('"src/b.js"'), why);
    assert.ok(!why.includes('"src/a.js"') && !why.includes('a.test.js'), `only the paths outside are named: ${why}`);
  });

  test('a path that only begins like test/ is outside it', () => {
    for (const p of ['tests/a.js', 'testdata/a.json', 'test']) {
      const why = changeCheck([p], ROWS);
      assert.ok(why && why.includes(JSON.stringify(p)), `${p}: ${why}`);
    }
  });

  test("a rename out of a row's file, given as both paths, fails on the new one", () => {
    const why = changeCheck(['src/a.js', 'src/renamed.js'], ROWS);
    assert.ok(why && why.includes('"src/renamed.js"'), why);
  });
});

describe('the paths the diff reports', () => {
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };

  function repo(t) {
    const dir = makeTempDir('prove-change-');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    // No configuration of the account running the test is read.
    const git = (args) => execFileSync('git', args, { cwd: dir, env: { ...env, XDG_CONFIG_HOME: dir } });
    const write = (rel, text) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    };
    const commit = () => {
      git(['add', '-A']);
      git(['commit', '-q', '-m', 'step']);
      return String(git(['rev-parse', 'HEAD'])).trim();
    };
    git(['init', '-q', '-b', 'main']);
    write('src/a.js', 'module.exports = 1;\n');
    write('test/a.test.js', "require('../src/a.js');\n");
    return { dir, git, write, commit, base: commit() };
  }

  test("a rename out of a row's file is reported as both paths, and refused", (t) => {
    const r = repo(t);
    r.git(['mv', 'src/a.js', 'src/renamed.js']);
    const paths = changedPaths(r.git, r.base, r.commit());
    assert.deepStrictEqual(paths.sort(), ['src/a.js', 'src/renamed.js']);
    const why = changeCheck(paths, ROWS);
    assert.ok(why && why.includes('"src/renamed.js"'), why);
  });

  test('a path with a space and a non-ASCII letter comes back exactly as stored', (t) => {
    const r = repo(t);
    r.write('src/café menu.js', '1;\n');
    r.write('test/a.test.js', "require('../src/a.js'); // changed\n");
    const paths = changedPaths(r.git, r.base, r.commit());
    assert.deepStrictEqual(paths.sort(), ['src/café menu.js', 'test/a.test.js']);
    assert.ok(changeCheck(paths, ROWS).includes(JSON.stringify('src/café menu.js')));
  });

  test("a fix of test files and a row's file passes", (t) => {
    const r = repo(t);
    r.write('src/a.js', 'module.exports = 2;\n');
    r.write('test/b.test.js', "require('../src/a.js');\n");
    const paths = changedPaths(r.git, r.base, r.commit());
    assert.deepStrictEqual(paths.sort(), ['src/a.js', 'test/b.test.js']);
    assert.strictEqual(changeCheck(paths, ROWS), null);
  });
});

// Once installed, the tree is snapshotted before the first run and after each
// one, and a run that changed anything outside test/ fails "check the tree".
describe('what a run may change', () => {
  function tree(t) {
    const dir = makeTempDir('prove-tree-');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const write = (rel, text) => {
      fs.mkdirSync(path.dirname(path.join(dir, ...rel.split('/'))), { recursive: true });
      fs.writeFileSync(path.join(dir, ...rel.split('/')), text);
    };
    for (const rel of ['package.json', 'src/a.js', 'src/test/inner.js', 'node_modules/dep/index.js',
      '.cache/ignored.txt', 'test/a.test.js', '.git/HEAD']) write(rel, `${rel}\n`);
    return { dir, write };
  }

  test('every file outside test/ and .git/ is in the snapshot, tracked or not, node_modules included', (t) => {
    const { dir } = tree(t);
    assert.deepStrictEqual([...snapshot(dir).keys()].sort(),
      ['.cache/ignored.txt', 'node_modules/dep/index.js', 'package.json', 'src/a.js', 'src/test/inner.js']);
  });

  test('a file added, removed or changed is named, and nothing changed gives no finding', (t) => {
    const { dir, write } = tree(t);
    const step = (change) => {
      const before = snapshot(dir);
      change();
      return treeChange(before, snapshot(dir));
    };
    assert.strictEqual(step(() => {}), null);
    assert.strictEqual(step(() => write('node_modules/dep/new.js', '1;\n')), '"node_modules/dep/new.js" was added');
    assert.strictEqual(step(() => fs.rmSync(path.join(dir, 'package.json'))), '"package.json" was removed');
    assert.strictEqual(step(() => write('src/a.js', 'changed\n')), '"src/a.js" was changed');
    assert.strictEqual(step(() => fs.chmodSync(path.join(dir, 'src', 'a.js'), 0o755)), '"src/a.js" was changed');
    fs.symlinkSync('a.js', path.join(dir, 'src', 'link.js'));
    assert.strictEqual(step(() => {
      fs.rmSync(path.join(dir, 'src', 'link.js'));
      fs.symlinkSync('test/inner.js', path.join(dir, 'src', 'link.js'));
    }), '"src/link.js" was changed');
  });

  test('of several changes the first in path order is named, and test/ and .git/ are not looked at', (t) => {
    const { dir, write } = tree(t);
    const before = snapshot(dir);
    write('test/a.test.js', 'changed\n');
    write('.git/HEAD', 'changed\n');
    assert.strictEqual(treeChange(before, snapshot(dir)), null);
    write('src/test/inner.js', 'changed\n');
    write('.cache/ignored.txt', 'changed\n');
    assert.strictEqual(treeChange(before, snapshot(dir)), '".cache/ignored.txt" was changed');
  });
});
