'use strict';
// Prove a change's tests fail without the change.
//
// Written BEFORE the implementation, which is the point rather than a detail.
// Across five cards in one day an independent reviewer caught seven tests that
// could not have failed, every one written after its fix while looking at the
// finished code. A test written that way asserts what the fix obviously does:
// the box shrank, focus is somewhere inside the editor, the decision function
// returns the right code. A test required to fail first cannot.
//
// So these tests exist before red-first.js does, and each one names the case it
// covers rather than exercising the happy path four ways.
//
// The limit, stated here because it must travel with every result: reverting a
// change proves a test NOTICES that change. It cannot prove the test asserts
// the right thing. A test can discriminate the fix and still measure a proxy.
// This closes the cheaper half of the class, which is the half that recurred.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { redFirst, recordOutcome } = require('../../scripts/red-first.js');

// A throwaway repository with a base commit, then a branch carrying whatever
// source and test content the case needs.
function repo({ source, testFile, baseSource = 'module.exports.a = () => 1;\n', baseTest = 'module.exports = () => {};\n' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'red-first-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'lib.js'), baseSource);
  fs.writeFileSync(path.join(dir, 'test', 'check.js'), baseTest);
  fs.writeFileSync(path.join(dir, 'run.js'), "require('./test/check.js')();\n");
  // The gate record must be ignored, exactly as it is in the real repository.
  // If it were tracked, writing it would dirty the tree and red-first would
  // refuse to run against its own record, which is a real constraint rather
  // than a fixture detail.
  fs.writeFileSync(path.join(dir, '.gitignore'), '.precommit-gate.json\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'change');
  if (source !== undefined) fs.writeFileSync(path.join(dir, 'lib.js'), source);
  if (testFile !== undefined) fs.writeFileSync(path.join(dir, 'test', 'check.js'), testFile);
  git('add', '-A');
  git('commit', '-q', '-m', 'the change');
  return { dir, git };
}

const CMD = 'node run.js';

describe('red-first', () => {
  test('a test that exercises the change is reported as proven', () => {
    const { dir } = repo({
      source: 'module.exports.a = () => 1;\nmodule.exports.b = () => 2;\n',
      testFile: "const assert = require('assert');\n"
        + "module.exports = () => { assert.strictEqual(require('../lib.js').b(), 2); };\n",
    });
    try {
      const r = redFirst({ repo: dir, base: 'main', tests: CMD });
      assert.strictEqual(r.outcome, 'proven');
      assert.strictEqual(r.passedWithChange, true);
      assert.strictEqual(r.failedWithoutChange, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a test that would pass with the change deleted is the finding', () => {
    // The pathology: an assertion on something that was already true.
    const { dir } = repo({
      source: 'module.exports.a = () => 1;\nmodule.exports.b = () => 2;\n',
      testFile: "const assert = require('assert');\n"
        + "module.exports = () => { assert.strictEqual(typeof require('../lib.js').a, 'function'); };\n",
    });
    try {
      const r = redFirst({ repo: dir, base: 'main', tests: CMD });
      assert.strictEqual(r.outcome, 'not-discriminating');
      assert.strictEqual(r.failedWithoutChange, false);
      assert.match(r.reason, /pass(es)? with the source reverted|do not discriminate/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a suite already failing with the change is inconclusive, not proof', () => {
    // A failure without the change proves nothing if the suite fails with it.
    // Reporting that as success would turn a broken suite into evidence.
    const { dir } = repo({
      source: 'module.exports.a = () => 1;\nmodule.exports.b = () => 2;\n',
      testFile: "module.exports = () => { throw new Error('suite is broken'); };\n",
    });
    try {
      const r = redFirst({ repo: dir, base: 'main', tests: CMD });
      assert.strictEqual(r.outcome, 'inconclusive');
      assert.strictEqual(r.passedWithChange, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a change with no tests is not provable, and is not a pass', () => {
    const { dir } = repo({ source: 'module.exports.a = () => 1;\nmodule.exports.b = () => 2;\n' });
    try {
      const r = redFirst({ repo: dir, base: 'main', tests: CMD });
      assert.strictEqual(r.outcome, 'not-provable');
      assert.match(r.reason, /no tests/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a change with no source is not provable either', () => {
    // Nothing to take away, so nothing to prove by taking it away.
    const { dir } = repo({
      testFile: "const assert = require('assert');\nmodule.exports = () => { assert.ok(true); };\n",
    });
    try {
      const r = redFirst({ repo: dir, base: 'main', tests: CMD });
      assert.strictEqual(r.outcome, 'not-provable');
      assert.match(r.reason, /no source/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a dirty tree is refused rather than rewritten', () => {
    const { dir } = repo({
      source: 'module.exports.a = () => 1;\nmodule.exports.b = () => 2;\n',
      testFile: "const assert = require('assert');\n"
        + "module.exports = () => { assert.strictEqual(require('../lib.js').b(), 2); };\n",
    });
    try {
      fs.writeFileSync(path.join(dir, 'lib.js'), '// edited, not committed\n');
      const r = redFirst({ repo: dir, base: 'main', tests: CMD });
      assert.strictEqual(r.outcome, 'refused');
      assert.match(r.reason, /dirty|uncommitted/i);
      // And it did not touch the edit.
      assert.match(fs.readFileSync(path.join(dir, 'lib.js'), 'utf8'), /edited, not committed/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the tree is restored even when the reverted run throws', () => {
    // The restore must be unconditional. A tool that can leave a repository
    // half-reverted is worse than no tool, because the next person debugs a
    // tree nobody put there on purpose.
    const { dir, git } = repo({
      source: 'module.exports.a = () => 1;\nmodule.exports.b = () => 2;\n',
      testFile: "const assert = require('assert');\n"
        + "module.exports = () => { assert.strictEqual(require('../lib.js').b(), 2); };\n",
    });
    try {
      const before = execFileSync('git', ['rev-parse', 'HEAD:lib.js'], { cwd: dir, encoding: 'utf8' }).trim();
      redFirst({ repo: dir, base: 'main', tests: 'node -e "process.exit(3)"' });
      const after = execFileSync('git', ['rev-parse', 'HEAD:lib.js'], { cwd: dir, encoding: 'utf8' }).trim();
      assert.strictEqual(after, before, 'the committed source is unchanged');
      assert.strictEqual(
        execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).trim(), '',
        'the working tree comes back clean',
      );
      git('status');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the outcome reaches the record a reviewer packet can carry', () => {
  // Three escalations in one release were the reviewer saying, correctly, that
  // it had not been shown the tests failing without the fix, while that
  // evidence sat in a terminal it cannot see. The packet carries the record, so
  // the record has to carry the proof.
  function withRecord(dir, tree) {
    fs.writeFileSync(path.join(dir, '.precommit-gate.json'),
      JSON.stringify({ tree, branch: 'change', at: '2026-08-20T00:00:00.000Z', steps: ['test'] }, null, 2));
  }
  const treeOf = (dir) => execFileSync('git', ['write-tree'], { cwd: dir, encoding: 'utf8' }).trim();

  test('a proven outcome is written against the tree it was measured on', () => {
    const { dir } = repo({
      source: 'module.exports.a = () => 1;\nmodule.exports.b = () => 2;\n',
      testFile: "const assert = require('assert');\n"
        + "module.exports = () => { assert.strictEqual(require('../lib.js').b(), 2); };\n",
    });
    try {
      const tree = treeOf(dir);
      withRecord(dir, tree);
      const outcome = redFirst({ repo: dir, base: 'main', tests: CMD });
      assert.strictEqual(recordOutcome(dir, outcome), true);

      const rec = JSON.parse(fs.readFileSync(path.join(dir, '.precommit-gate.json'), 'utf8'));
      assert.strictEqual(rec.redFirst.outcome, 'proven');
      assert.strictEqual(rec.redFirst.testFiles, 1);
      // The limit travels with the result, so a green outcome cannot be read
      // as more than it is.
      assert.match(rec.redFirst.limitation, /cannot prove they assert the right thing/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a failing outcome is recorded too, so absence and failure stay different', () => {
    // A packet that cannot tell "never run" from "run and found wanting"
    // invites the reader to assume the kinder one.
    const { dir } = repo({
      source: 'module.exports.a = () => 1;\nmodule.exports.b = () => 2;\n',
      testFile: "const assert = require('assert');\n"
        + "module.exports = () => { assert.strictEqual(typeof require('../lib.js').a, 'function'); };\n",
    });
    try {
      withRecord(dir, treeOf(dir));
      const outcome = redFirst({ repo: dir, base: 'main', tests: CMD });
      recordOutcome(dir, outcome);
      const rec = JSON.parse(fs.readFileSync(path.join(dir, '.precommit-gate.json'), 'utf8'));
      assert.strictEqual(rec.redFirst.outcome, 'not-discriminating');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a record for a different tree is refused rather than overwritten', () => {
    // A result describes the tree it was measured on. Writing it onto another
    // tree's record would vouch for content nobody checked.
    const { dir } = repo({
      source: 'module.exports.a = () => 1;\nmodule.exports.b = () => 2;\n',
      testFile: "const assert = require('assert');\nmodule.exports = () => { assert.ok(true); };\n",
    });
    try {
      withRecord(dir, 'f'.repeat(40));
      const outcome = redFirst({ repo: dir, base: 'main', tests: CMD });
      assert.strictEqual(recordOutcome(dir, outcome), false);
      const rec = JSON.parse(fs.readFileSync(path.join(dir, '.precommit-gate.json'), 'utf8'));
      assert.strictEqual(rec.redFirst, undefined, 'the stale record is left alone');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('with no record present there is nothing to fold into', () => {
    const { dir } = repo({
      source: 'module.exports.a = () => 1;\nmodule.exports.b = () => 2;\n',
      testFile: "const assert = require('assert');\nmodule.exports = () => { assert.ok(true); };\n",
    });
    try {
      const outcome = redFirst({ repo: dir, base: 'main', tests: CMD });
      assert.strictEqual(recordOutcome(dir, outcome), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the record file must not dirty the tree it describes', () => {
  test('a tracked gate record makes red-first refuse its own repository', () => {
    // Learned by writing the fixture without a .gitignore: the record landed
    // as an untracked file, the tree was dirty, and red-first correctly
    // refused. Worth pinning, because the failure looks like a broken tool
    // rather than a mis-configured repository.
    const { dir, git } = repo({
      source: 'module.exports.a = () => 1;\nmodule.exports.b = () => 2;\n',
      testFile: "const assert = require('assert');\nmodule.exports = () => { assert.ok(true); };\n",
    });
    try {
      fs.rmSync(path.join(dir, '.gitignore'));
      git('add', '-A');
      git('commit', '-q', '-m', 'stop ignoring the record');
      fs.writeFileSync(path.join(dir, '.precommit-gate.json'), '{}');

      const r = redFirst({ repo: dir, base: 'main', tests: CMD });
      assert.strictEqual(r.outcome, 'refused');
      assert.match(r.reason, /uncommitted/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
