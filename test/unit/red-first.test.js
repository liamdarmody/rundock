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
const { execFileSync, spawn } = require('node:child_process');

const { redFirst, recordOutcome } = require('../../scripts/red-first.js');

// A throwaway repository with a base commit, then a branch carrying whatever
// source and test content the case needs.
function repo({ source, testFile, added = {}, baseSource = 'module.exports.a = () => 1;\n', baseTest = 'module.exports = () => {};\n' }) {
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
  // Files that exist only on the branch. There is no base version to check
  // out, which is the case every other fixture here happens to avoid.
  for (const [rel, content] of Object.entries(added)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  git('add', '-A');
  git('commit', '-q', '--allow-empty', '-m', 'the change');
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

describe('source added by the change, with no version at the base', () => {
  // Found by running this tool on its own branch, which adds two files and
  // modifies none. `git checkout <base> -- <path>` fails outright on a path
  // that does not exist at the base, so the run died on a pathspec error
  // instead of reporting an outcome. Every fixture above modifies a file that
  // already existed, so none of them could reach it: the same shape of gap
  // this tool exists to catch, in the tool itself.

  test('an added file is taken away by deleting it, and the tests go red', () => {
    const { dir } = repo({
      added: {
        'lib2.js': 'module.exports.b = () => 2;\n',
      },
      testFile: "const assert = require('assert');\n"
        + "module.exports = () => { assert.strictEqual(require('../lib2.js').b(), 2); };\n",
    });
    try {
      const r = redFirst({ repo: dir, base: 'main', tests: CMD });
      assert.strictEqual(r.outcome, 'proven', r.reason);
      assert.deepStrictEqual(r.source, ['lib2.js']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the added file comes back, so the branch is not left short a file', () => {
    // The restore path is the one that matters most here: a deleted file that
    // is not put back turns a diagnostic run into data loss on the branch.
    const { dir } = repo({
      added: { 'lib2.js': 'module.exports.b = () => 2;\n' },
      testFile: "const assert = require('assert');\n"
        + "module.exports = () => { assert.strictEqual(require('../lib2.js').b(), 2); };\n",
    });
    try {
      redFirst({ repo: dir, base: 'main', tests: CMD });
      assert.strictEqual(fs.existsSync(path.join(dir, 'lib2.js')), true, 'the added file is restored');
      assert.strictEqual(
        execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).trim(), '',
        'and the tree comes back clean',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a mix of added and modified source is handled in one run', () => {
    const { dir } = repo({
      source: 'module.exports.a = () => 1;\nmodule.exports.c = () => 3;\n',
      added: { 'lib2.js': 'module.exports.b = () => 2;\n' },
      testFile: "const assert = require('assert');\n"
        + "module.exports = () => {\n"
        + "  assert.strictEqual(require('../lib2.js').b(), 2);\n"
        + "  assert.strictEqual(require('../lib.js').c(), 3);\n"
        + "};\n",
    });
    try {
      const r = redFirst({ repo: dir, base: 'main', tests: CMD });
      assert.strictEqual(r.outcome, 'proven', r.reason);
      assert.deepStrictEqual(r.source.slice().sort(), ['lib.js', 'lib2.js']);
      assert.strictEqual(
        execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).trim(), '',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the restore runs whatever happens, which is the claim AC-4 makes', () => {
  // The first version of this test passed a command that always exited
  // non-zero. That made the FIRST run fail, so redFirst returned
  // 'inconclusive' and never entered the try/finally the test was named for.
  // It would have passed with the finally block deleted. An independent
  // reviewer found that; writing the test before the implementation did not,
  // because the test was written against an imagined ordering and the real
  // ordering silently invalidated its premise.
  //
  // The fix is a seam: the run function is injectable, so a test can make the
  // reverted run throw while the first run passes, which is the only way to
  // reach the restore by the path a real failure would take.

  test('a throw from the reverted run still puts the source back', () => {
    const { dir } = repo({
      added: { 'lib2.js': 'module.exports.b = () => 2;\n' },
      testFile: "const assert = require('assert');\nmodule.exports = () => { assert.ok(true); };\n",
    });
    try {
      let call = 0;
      const runner = () => {
        call += 1;
        if (call === 1) return true;          // green with the change
        throw new Error('the runner blew up mid-revert');
      };
      assert.throws(() => redFirst({ repo: dir, base: 'main', tests: CMD, runner }),
        /blew up mid-revert/);

      assert.strictEqual(call, 2, 'the reverted run was actually reached');
      assert.strictEqual(fs.existsSync(path.join(dir, 'lib2.js')), true,
        'the added file is back');
      assert.strictEqual(
        execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).trim(), '',
        'and the tree is clean',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an interrupt during the reverted run does not leave the tree reverted', () => {
    // try/finally does not survive a signal: Node's default handling
    // terminates without unwinding. So this spawns the real script and
    // interrupts it in the window where the source is taken away, which is the
    // only window where an abandoned tree does damage.
    const { dir } = repo({
      added: { 'lib2.js': 'module.exports.b = () => 2;\n' },
      testFile: "const assert = require('assert');\nmodule.exports = () => { assert.ok(true); };\n",
    });
    return new Promise((resolve, reject) => {
      const slow = `${JSON.stringify(process.execPath)} -e "setTimeout(()=>process.exit(0), 4000)"`;
      const kid = spawn(process.execPath,
        [path.join(__dirname, '..', '..', 'scripts', 'red-first.js'),
          '--repo', dir, '--base', 'main', '--tests', slow],
        { stdio: ['ignore', 'pipe', 'pipe'] });

      let out = '';
      let signalled = false;
      kid.stdout.on('data', (b) => {
        out += b.toString();
        // Interrupt once the source has actually been taken away.
        if (!signalled && out.includes('restoring the source')) {
          signalled = true;
          setTimeout(() => kid.kill('SIGINT'), 150);
        }
      });
      kid.on('error', reject);
      kid.on('exit', () => {
        try {
          assert.strictEqual(signalled, true, 'the run reached the revert step');
          assert.strictEqual(fs.existsSync(path.join(dir, 'lib2.js')), true,
            'the added file survived the interrupt');
          assert.strictEqual(
            execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).trim(), '',
            'the tree is clean after an interrupt',
          );
          resolve();
        } catch (e) {
          reject(e);
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      });
    });
  });
});

describe('the record carries test counts, not a count of files', () => {
  // AC-6 names how many tests failed without the change and how many passed
  // with it. The first implementation wrote sourceFiles and testFiles, which
  // are counts of FILES: a proxy substituted for the property the criterion
  // named, which is the pathology this whole card exists to stop, committed
  // inside the card itself.
  function countableRepo() {
    const { dir } = repo({
      added: { 'lib2.js': 'module.exports.b = () => 2;\n' },
      testFile: "const { test } = require('node:test');\n"
        + "const assert = require('node:assert');\n"
        + "test('b is two', () => { assert.strictEqual(require('../lib2.js').b(), 2); });\n"
        + "test('b is a function', () => { assert.strictEqual(typeof require('../lib2.js').b, 'function'); });\n",
    });
    return dir;
  }

  test('both counts reach the record', () => {
    const dir = countableRepo();
    try {
      // The fixture already ignores the record file, so there is nothing to
      // commit here and no reason to touch the tree before measuring it.
      const tree = execFileSync('git', ['write-tree'], { cwd: dir, encoding: 'utf8' }).trim();
      fs.writeFileSync(path.join(dir, '.precommit-gate.json'),
        JSON.stringify({ tree, branch: 'change', at: 'x', steps: ['test'] }));

      const outcome = redFirst({ repo: dir, base: 'main', tests: 'node --test test/check.js' });
      assert.strictEqual(outcome.outcome, 'proven', outcome.reason);
      recordOutcome(dir, outcome);

      const rec = JSON.parse(fs.readFileSync(path.join(dir, '.precommit-gate.json'), 'utf8'));
      assert.strictEqual(rec.redFirst.testsPassedWithChange, 2);
      assert.strictEqual(rec.redFirst.testsFailedWithoutChange, 2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an unparsable summary records null rather than a guess', () => {
    // A count invented from output nobody could read is worse than no count,
    // because the record is the thing the reviewer is asked to trust.
    const { dir } = repo({
      added: { 'lib2.js': 'module.exports.b = () => 2;\n' },
      testFile: "const assert = require('assert');\n"
        + "module.exports = () => { assert.strictEqual(require('../lib2.js').b(), 2); };\n",
    });
    try {
      const outcome = redFirst({ repo: dir, base: 'main', tests: CMD });
      assert.strictEqual(outcome.outcome, 'proven', outcome.reason);
      assert.strictEqual(outcome.testsPassedWithChange, null);
      assert.strictEqual(outcome.testsFailedWithoutChange, null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a branch with no diff at all', () => {
  test('is not-provable, by its own path rather than by resemblance', () => {
    const { dir } = repo({});
    try {
      const r = redFirst({ repo: dir, base: 'main', tests: CMD });
      assert.strictEqual(r.outcome, 'not-provable');
      assert.match(r.reason, /nothing changed/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the test command does not inherit this runner is own context', () => {
  test('NODE_TEST_CONTEXT is stripped, because it makes a nested runner exit 0', () => {
    // Found while writing the counts test. `node --test` that inherits
    // NODE_TEST_CONTEXT reports failures and still exits 0, so a suite that
    // should have gone red comes back green. For a tool whose only job is
    // detecting false green, being fooled into green is the worst available
    // failure, and it only shows up when red-first is driven from inside a
    // test, which is exactly how it is exercised here.
    assert.ok(process.env.NODE_TEST_CONTEXT,
      'this test is meaningless unless the parent really is a test child');

    const { dir } = repo({
      added: { 'lib2.js': 'module.exports.b = () => 2;\n' },
      testFile: "const assert = require('assert');\nmodule.exports = () => { assert.ok(true); };\n",
    });
    const probe = path.join(os.tmpdir(), `red-first-env-${process.pid}.txt`);
    try {
      const cmd = `${JSON.stringify(process.execPath)} -e `
        + JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(probe)}, String(process.env.NODE_TEST_CONTEXT))`);
      redFirst({ repo: dir, base: 'main', tests: cmd });
      assert.strictEqual(fs.readFileSync(probe, 'utf8'), 'undefined',
        'the child must not see the parent test runner is context');
    } finally {
      fs.rmSync(probe, { force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
