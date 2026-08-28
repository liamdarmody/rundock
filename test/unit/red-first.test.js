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
const { execFileSync, spawn, spawnSync } = require('node:child_process');

const { redFirst, recordOutcome, namesFrom, NAME_LIMIT } = require('../../scripts/red-first.js');
// The REAL record writer, not a local idea of one. scripts/precommit-gate.js
// says why in its own docstring: "a test that hand-builds the JSON proves the
// reader can read the test's idea of a record". These tests hand-built it
// anyway, and an independent reviewer caught it. If the gate renamed a field or
// computed its tree a different way, recordOutcome would silently stop matching
// in production while every test here stayed green, because the fixture and the
// implementation were built to agree with each other rather than with the gate.
const gate = require('../../scripts/precommit-gate.js');

/**
 * Signal a child once a condition holds, rather than once a guessed number of
 * milliseconds has passed.
 *
 * The two interrupt tests below have to land their signal inside a specific
 * window in the tool's run. Both used to reach that window by sleeping a fixed
 * time after a line appeared on stdout, which is a bet that the step in
 * between takes less than the author guessed. Under load it does not, and the
 * signal lands in the wrong place: early enough and the test proves nothing
 * while still passing, later and it arrives mid-checkout and fails for a
 * reason unrelated to the defect covered.
 *
 * Both windows have a filesystem fact that opens them, so each waits for its
 * own fact. Bounded, because a window that never opens has to fail as a
 * timeout rather than hang the suite.
 */
function killWhen(kid, ready, signal, { timeout = 15000, interval = 10 } = {}) {
  const deadline = Date.now() + timeout;
  const poll = () => {
    if (kid.exitCode !== null || kid.signalCode !== null) return;
    if (ready()) { kid.kill(signal); return; }
    if (Date.now() >= deadline) return; // the assertions below report it
    setTimeout(poll, interval);
  };
  poll();
}

// A throwaway repository with a base commit, then a branch carrying whatever
// source and test content the case needs.
function repo({ source, testFile, added = {}, baseSource = 'module.exports.a = () => 1;\n', baseTest = 'module.exports = () => {};\n' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'red-first-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  // Name the branch explicitly. `git init` takes its branch name from
  // init.defaultBranch, so a fixture that says nothing gets whatever the host
  // is configured for: main on a developer machine that set it, master on CI
  // where nothing did. Every test in this file passed locally and every one
  // failed in CI with "fatal: Not a valid object name main". A fixture must
  // not read the machine it runs on.
  git('symbolic-ref', 'HEAD', 'refs/heads/main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  // Likewise rename detection, which some developers enable globally and which
  // changes what `git diff --name-only` reports.
  git('config', 'diff.renames', 'false');
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
  test('a test that exercises the change is reported as proven', async () => {
    const { dir } = repo({
      source: 'module.exports.a = () => 1;\nmodule.exports.b = () => 2;\n',
      testFile: "const assert = require('assert');\n"
        + "module.exports = () => { assert.strictEqual(require('../lib.js').b(), 2); };\n",
    });
    try {
      const r = await redFirst({ repo: dir, base: 'main', tests: CMD });
      assert.strictEqual(r.outcome, 'proven');
      assert.strictEqual(r.passedWithChange, true);
      assert.strictEqual(r.failedWithoutChange, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a test that would pass with the change deleted is the finding', async () => {
    // The pathology: an assertion on something that was already true.
    const { dir } = repo({
      source: 'module.exports.a = () => 1;\nmodule.exports.b = () => 2;\n',
      testFile: "const assert = require('assert');\n"
        + "module.exports = () => { assert.strictEqual(typeof require('../lib.js').a, 'function'); };\n",
    });
    try {
      const r = await redFirst({ repo: dir, base: 'main', tests: CMD });
      assert.strictEqual(r.outcome, 'not-discriminating');
      assert.strictEqual(r.failedWithoutChange, false);
      assert.match(r.reason, /pass(es)? with the source reverted|do not discriminate/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a suite already failing with the change is inconclusive, not proof', async () => {
    // A failure without the change proves nothing if the suite fails with it.
    // Reporting that as success would turn a broken suite into evidence.
    const { dir } = repo({
      source: 'module.exports.a = () => 1;\nmodule.exports.b = () => 2;\n',
      testFile: "module.exports = () => { throw new Error('suite is broken'); };\n",
    });
    try {
      const r = await redFirst({ repo: dir, base: 'main', tests: CMD });
      assert.strictEqual(r.outcome, 'inconclusive');
      assert.strictEqual(r.passedWithChange, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a change with no tests is not provable, and is not a pass', async () => {
    const { dir } = repo({ source: 'module.exports.a = () => 1;\nmodule.exports.b = () => 2;\n' });
    try {
      const r = await redFirst({ repo: dir, base: 'main', tests: CMD });
      assert.strictEqual(r.outcome, 'not-provable');
      assert.match(r.reason, /no tests/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a change with no source is not provable either', async () => {
    // Nothing to take away, so nothing to prove by taking it away.
    const { dir } = repo({
      testFile: "const assert = require('assert');\nmodule.exports = () => { assert.ok(true); };\n",
    });
    try {
      const r = await redFirst({ repo: dir, base: 'main', tests: CMD });
      assert.strictEqual(r.outcome, 'not-provable');
      assert.match(r.reason, /no source/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a dirty tree is refused rather than rewritten', async () => {
    const { dir } = repo({
      source: 'module.exports.a = () => 1;\nmodule.exports.b = () => 2;\n',
      testFile: "const assert = require('assert');\n"
        + "module.exports = () => { assert.strictEqual(require('../lib.js').b(), 2); };\n",
    });
    try {
      fs.writeFileSync(path.join(dir, 'lib.js'), '// edited, not committed\n');
      const r = await redFirst({ repo: dir, base: 'main', tests: CMD });
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
    gate.writeRecord(
      gate.buildRecord({ tree, branch: 'change', at: '2026-08-20T00:00:00.000Z' }),
      path.join(dir, '.precommit-gate.json'),
    );
  }
  // The gate's own tree function, so a change to how it identifies a tree
  // breaks these tests rather than passing them by coincidence.
  const treeOf = (dir) => gate.currentTree(dir);

  test('a proven outcome is written against the tree it was measured on', async () => {
    const { dir } = repo({
      source: 'module.exports.a = () => 1;\nmodule.exports.b = () => 2;\n',
      testFile: "const assert = require('assert');\n"
        + "module.exports = () => { assert.strictEqual(require('../lib.js').b(), 2); };\n",
    });
    try {
      const tree = treeOf(dir);
      withRecord(dir, tree);
      const outcome = await redFirst({ repo: dir, base: 'main', tests: CMD });
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

  test('a failing outcome is recorded too, so absence and failure stay different', async () => {
    // A packet that cannot tell "never run" from "run and found wanting"
    // invites the reader to assume the kinder one.
    const { dir } = repo({
      source: 'module.exports.a = () => 1;\nmodule.exports.b = () => 2;\n',
      testFile: "const assert = require('assert');\n"
        + "module.exports = () => { assert.strictEqual(typeof require('../lib.js').a, 'function'); };\n",
    });
    try {
      withRecord(dir, treeOf(dir));
      const outcome = await redFirst({ repo: dir, base: 'main', tests: CMD });
      recordOutcome(dir, outcome);
      const rec = JSON.parse(fs.readFileSync(path.join(dir, '.precommit-gate.json'), 'utf8'));
      assert.strictEqual(rec.redFirst.outcome, 'not-discriminating');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a record for a different tree is refused rather than overwritten', async () => {
    // A result describes the tree it was measured on. Writing it onto another
    // tree's record would vouch for content nobody checked.
    const { dir } = repo({
      source: 'module.exports.a = () => 1;\nmodule.exports.b = () => 2;\n',
      testFile: "const assert = require('assert');\nmodule.exports = () => { assert.ok(true); };\n",
    });
    try {
      withRecord(dir, 'f'.repeat(40));
      const outcome = await redFirst({ repo: dir, base: 'main', tests: CMD });
      assert.strictEqual(recordOutcome(dir, outcome), false);
      const rec = JSON.parse(fs.readFileSync(path.join(dir, '.precommit-gate.json'), 'utf8'));
      assert.strictEqual(rec.redFirst, undefined, 'the stale record is left alone');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('with no record present there is nothing to fold into', async () => {
    const { dir } = repo({
      source: 'module.exports.a = () => 1;\nmodule.exports.b = () => 2;\n',
      testFile: "const assert = require('assert');\nmodule.exports = () => { assert.ok(true); };\n",
    });
    try {
      const outcome = await redFirst({ repo: dir, base: 'main', tests: CMD });
      assert.strictEqual(recordOutcome(dir, outcome), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the record file must not dirty the tree it describes', () => {
  test('a tracked gate record makes red-first refuse its own repository', async () => {
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

      const r = await redFirst({ repo: dir, base: 'main', tests: CMD });
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

  test('an added file is taken away by deleting it, and the tests go red', async () => {
    const { dir } = repo({
      added: {
        'lib2.js': 'module.exports.b = () => 2;\n',
      },
      testFile: "const assert = require('assert');\n"
        + "module.exports = () => { assert.strictEqual(require('../lib2.js').b(), 2); };\n",
    });
    try {
      const r = await redFirst({ repo: dir, base: 'main', tests: CMD });
      assert.strictEqual(r.outcome, 'proven', r.reason);
      assert.deepStrictEqual(r.source, ['lib2.js']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the added file comes back, so the branch is not left short a file', async () => {
    // The restore path is the one that matters most here: a deleted file that
    // is not put back turns a diagnostic run into data loss on the branch.
    const { dir } = repo({
      added: { 'lib2.js': 'module.exports.b = () => 2;\n' },
      testFile: "const assert = require('assert');\n"
        + "module.exports = () => { assert.strictEqual(require('../lib2.js').b(), 2); };\n",
    });
    try {
      await redFirst({ repo: dir, base: 'main', tests: CMD });
      assert.strictEqual(fs.existsSync(path.join(dir, 'lib2.js')), true, 'the added file is restored');
      assert.strictEqual(
        execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).trim(), '',
        'and the tree comes back clean',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a mix of added and modified source is handled in one run', async () => {
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
      const r = await redFirst({ repo: dir, base: 'main', tests: CMD });
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

  test('a throw from the reverted run still puts the source back', async () => {
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
      // assert.rejects, not assert.throws: the failure now arrives as a
      // rejected promise, and assert.throws would pass while catching nothing.
      await assert.rejects(() => redFirst({ repo: dir, base: 'main', tests: CMD, runner }),
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
      const added = path.join(dir, 'lib2.js');
      kid.stdout.on('data', (b) => {
        out += b.toString();
        // Interrupt once the source has actually been taken away. The log line
        // is printed BEFORE the checkout that removes it, so the line alone
        // does not mean the window is open: the fact that does is the added
        // file being gone from the tree.
        if (!signalled && out.includes('restoring the source')) {
          signalled = true;
          killWhen(kid, () => !fs.existsSync(added), 'SIGINT');
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

  test('both counts reach the record', async () => {
    const dir = countableRepo();
    try {
      // The fixture already ignores the record file, so there is nothing to
      // commit here and no reason to touch the tree before measuring it.
      const tree = gate.currentTree(dir);
      gate.writeRecord(gate.buildRecord({ tree, branch: 'change', at: 'x' }),
        path.join(dir, '.precommit-gate.json'));

      const outcome = await redFirst({ repo: dir, base: 'main', tests: 'node --test test/check.js' });
      assert.strictEqual(outcome.outcome, 'proven', outcome.reason);
      recordOutcome(dir, outcome);

      const rec = JSON.parse(fs.readFileSync(path.join(dir, '.precommit-gate.json'), 'utf8'));
      assert.strictEqual(rec.redFirst.testsPassedWithChange, 2);
      assert.strictEqual(rec.redFirst.testsFailedWithoutChange, 2);
      // THE NAMES, not only the count. A count says the suite noticed
      // something; it cannot say the proofs a criterion names are among what it
      // noticed, so a reviewer asked to check a claim against criteria has
      // nothing to check it with. These are the two tests the fixture wrote,
      // and they are named because they really went red without the change.
      assert.deepStrictEqual(rec.redFirst.namesFailedWithoutChange.sort(), ['b is a function', 'b is two'],
        'the record names which tests failed when the source was taken away');
      assert.strictEqual(rec.redFirst.namesTruncated, false, 'and says whether the list is the whole of it');
      assert.ok(rec.redFirst.namesFailedWithoutChange.length <= NAME_LIMIT,
        'the list is capped, and the cap is the thing namesTruncated reports on');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an unparsable summary records null rather than a guess', async () => {
    // A count invented from output nobody could read is worse than no count,
    // because the record is the thing the reviewer is asked to trust.
    const { dir } = repo({
      added: { 'lib2.js': 'module.exports.b = () => 2;\n' },
      testFile: "const assert = require('assert');\n"
        + "module.exports = () => { assert.strictEqual(require('../lib2.js').b(), 2); };\n",
    });
    try {
      const outcome = await redFirst({ repo: dir, base: 'main', tests: CMD });
      assert.strictEqual(outcome.outcome, 'proven', outcome.reason);
      assert.strictEqual(outcome.testsPassedWithChange, null);
      assert.strictEqual(outcome.testsFailedWithoutChange, null);
      assert.deepStrictEqual(outcome.namesFailedWithoutChange, [],
        'and no names either: a name invented from output nobody could read is worse than none');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('reading test names out of a run', () => {
  // Two reporters, because this project's suite and its neighbours do not
  // agree on one. Driven directly rather than through a repository, so a
  // shape this cannot read is a failure here rather than an empty list in a
  // record somebody trusts.
  test('the spec reporter\'s crosses and TAP\'s not-ok lines are both read', () => {
    const spec = '  \u2716 a write with no outcome yet (1.06ms)\n'
      + '\u2716 failing tests:\n'
      + '  \u2716 a write with no outcome yet (1.06ms)\n'
      + '  \u2714 something that passed (0.2ms)\n';
    assert.deepStrictEqual(namesFrom(spec), ['a write with no outcome yet'],
      'named once, with the summary heading and the passing test left out');
    assert.deepStrictEqual(namesFrom('not ok 3 - the guard was removed\nok 4 - fine\n'),
      ['the guard was removed']);
  });

  test('output in a shape this cannot read yields no names rather than invented ones', () => {
    assert.deepStrictEqual(namesFrom('everything went wrong, somehow\n'), []);
  });
});

describe('a branch with no diff at all', () => {
  test('is not-provable, by its own path rather than by resemblance', async () => {
    const { dir } = repo({});
    try {
      const r = await redFirst({ repo: dir, base: 'main', tests: CMD });
      assert.strictEqual(r.outcome, 'not-provable');
      assert.match(r.reason, /nothing changed/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the test command does not inherit this runner is own context', () => {
  test('NODE_TEST_CONTEXT is stripped, because it makes a nested runner exit 0', async () => {
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
      await redFirst({ repo: dir, base: 'main', tests: cmd });
      assert.strictEqual(fs.readFileSync(probe, 'utf8'), 'undefined',
        'the child must not see the parent test runner is context');
    } finally {
      fs.rmSync(probe, { force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('classifying a path as a test, by segment rather than by substring', () => {
  test('a source directory whose name ends in "test" is not a test directory', async () => {
    // `'src/latest/module.js'.includes('test/')` is true, because "latest/"
    // ends in "test/". So do contest/, attest/, protest/, fastest/. A source
    // file misclassified this way is never reverted, so the check runs against
    // less than it claims to.
    const { dir } = repo({
      added: {
        'src/latest/module.js': 'module.exports.b = () => 2;\n',
      },
      testFile: "const assert = require('assert');\n"
        + "module.exports = () => { assert.strictEqual(require('../src/latest/module.js').b(), 2); };\n",
    });
    try {
      const r = await redFirst({ repo: dir, base: 'main', tests: CMD });
      assert.deepStrictEqual(r.source, ['src/latest/module.js'],
        'a path containing "test/" inside a longer segment is source');
      assert.deepStrictEqual(r.tests, ['test/check.js']);
      assert.strictEqual(r.outcome, 'proven', r.reason);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a real test directory and a suffixed filename are still tests', async () => {
    const { dir } = repo({
      source: 'module.exports.a = () => 1;\nmodule.exports.c = () => 3;\n',
      added: {
        'src/thing.test.js': '// a test by filename\n',
        'spec/other.js': '// a test by directory\n',
      },
      testFile: "const assert = require('assert');\n"
        + "module.exports = () => { assert.strictEqual(require('../lib.js').c(), 3); };\n",
    });
    try {
      const r = await redFirst({ repo: dir, base: 'main', tests: CMD });
      assert.deepStrictEqual(r.source, ['lib.js']);
      assert.deepStrictEqual(r.tests.slice().sort(),
        ['spec/other.js', 'src/thing.test.js', 'test/check.js']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the command itself, not only the function inside it', () => {
  // Every other test here calls redFirst() directly, which leaves main()
  // unexercised: argv parsing, the exit-code contract the docstring promises,
  // and the printed outcome. An independent reviewer pointed out that this is
  // the same fault the file's own header lists among the seven it exists to
  // prevent, "a pure decision function rather than the wiring around it",
  // reproduced in the suite for the tool meant to catch it. If main() always
  // returned 0, nothing here would have failed.
  const script = path.join(__dirname, '..', '..', 'scripts', 'red-first.js');

  function cli(dir) {
    return spawnSync(process.execPath,
      [script, '--repo', dir, '--base', 'main', '--tests', CMD],
      { encoding: 'utf8' });
  }

  test('a discriminating change exits 0 and says so', () => {
    const { dir } = repo({
      added: { 'lib2.js': 'module.exports.b = () => 2;\n' },
      testFile: "const assert = require('assert');\n"
        + "module.exports = () => { assert.strictEqual(require('../lib2.js').b(), 2); };\n",
    });
    try {
      const r = cli(dir);
      assert.strictEqual(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /PROVEN/);
      assert.match(r.stdout, /cannot prove they assert the right thing/,
        'the limit is printed with the pass, not only carried in the object');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a non-discriminating change exits non-zero and names itself', () => {
    // "It failed" cannot distinguish a weak test from a broken suite, so the
    // exit code carries the refusal and the output carries which one.
    const { dir } = repo({
      source: 'module.exports.a = () => 1;\nmodule.exports.b = () => 2;\n',
      testFile: "const assert = require('assert');\n"
        + "module.exports = () => { assert.strictEqual(typeof require('../lib.js').a, 'function'); };\n",
    });
    try {
      const r = cli(dir);
      assert.notStrictEqual(r.status, 0, 'a non-discriminating result must not exit 0');
      assert.match(r.stdout, /NOT-DISCRIMINATING/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the record contract is the gate is, not this file is', () => {
  test('recordOutcome reads a record the real gate wrote', async () => {
    // The point of this test is the coupling, not the assertion. It imports
    // scripts/precommit-gate.js, so a renamed field or a different
    // tree-computation on that side fails here rather than failing silently in
    // production, where the outcome would simply never reach the record.
    const { dir } = repo({
      added: { 'lib2.js': 'module.exports.b = () => 2;\n' },
      testFile: "const assert = require('assert');\nmodule.exports = () => { assert.ok(true); };\n",
    });
    try {
      const record = gate.buildRecord({
        tree: gate.currentTree(dir), branch: 'change', at: '2026-08-21T00:00:00.000Z',
      });
      gate.writeRecord(record, path.join(dir, '.precommit-gate.json'));

      assert.ok(record.tree, 'the gate names a tree at all');
      assert.strictEqual(record.tree,
        execFileSync('git', ['write-tree'], { cwd: dir, encoding: 'utf8' }).trim(),
        'the gate identifies a tree by git write-tree, which is what recordOutcome assumes');

      const outcome = await redFirst({ repo: dir, base: 'main', tests: CMD });
      assert.strictEqual(recordOutcome(dir, outcome), true,
        'a record written by the real gate is accepted');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a renamed source file', () => {
  test('is restored to its old path, not deleted, so a false proven is impossible', async () => {
    // git diff reports a rename as one new path when rename detection is on.
    // restoreTo then asks whether that path exists at the base, finds it does
    // not, and DELETES it. The reverted run fails with a module-not-found for
    // an unrelated reason, and the tool reports "proven" for tests that
    // discriminate nothing. That is the one error direction this must never
    // take.
    const { dir, git } = repo({ added: { 'old-name.js': 'module.exports.b = () => 2;\n' } });
    try {
      // Put the file in the BASE, then rename it on the branch.
      git('checkout', '-q', 'main');
      fs.writeFileSync(path.join(dir, 'old-name.js'), 'module.exports.b = () => 2;\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'the file, under its first name');
      git('checkout', '-q', '-b', 'renamed');
      git('mv', 'old-name.js', 'new-name.js');
      fs.writeFileSync(path.join(dir, 'test', 'check.js'),
        "const assert = require('assert');\n"
        + "module.exports = () => { assert.strictEqual(require('../new-name.js').b(), 2); };\n");
      git('add', '-A');
      git('commit', '-q', '-m', 'renamed');
      // Rename detection on, which is what a developer's config may well do.
      git('config', 'diff.renames', 'true');

      const r = await redFirst({ repo: dir, base: 'main', tests: CMD });
      assert.deepStrictEqual(r.source.slice().sort(), ['new-name.js', 'old-name.js'],
        'both sides of the rename are treated as source');
      assert.strictEqual(
        execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).trim(), '',
        'and the tree comes back clean',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('AC-4 with an uncooperative child, which is where the claim was false', () => {
  test('a test command that traps SIGINT does not hold the tree hostage', async () => {
    // The case an independent reviewer named, twice, before it was fixed.
    // spawnSync blocks the event loop for the whole life of the child, so the
    // SIGINT handler could not run until the child chose to exit. A command
    // that traps or ignores the signal therefore left the source reverted for
    // as long as it kept running, while AC-4 claims restoration happens
    // whatever happens. Documenting that gap did not discharge the criterion,
    // and the reviewer was right to refuse it.
    const { dir } = repo({
      added: { 'lib2.js': 'module.exports.b = () => 2;\n' },
      testFile: "const assert = require('assert');\nmodule.exports = () => { assert.ok(true); };\n",
    });
    // Inside the repo's OWN .git directory: writable under the same sandbox
    // grant that covers the repo (a subpath of `dir`), but never reported by
    // `git status`, so neither this test's own clean-tree check nor
    // red-first's need to know the marker was ever there. A plain untracked
    // file inside the repo's working tree would also be inside that grant,
    // but shows up in `git status --porcelain`, which is what forced an
    // earlier version of this test to delete it early, by hand, before the
    // clean-tree assertion.
    //
    // A sandbox that denies os.tmpdir() as a write target, while still
    // permitting this test's own fixture creation (repo() calls
    // fs.mkdtempSync(os.tmpdir()), which needs write access to that same
    // parent directory), IS constructible: fs.mkdtempSync appends exactly
    // six alphanumeric characters, so a grant naming that shape (six
    // characters, then optionally more path) admits the fixture directory
    // and everything inside it while rejecting a marker named directly at
    // the temp root, such as the flat file this test used to write there.
    // Demonstrated directly, not reasoned about: see AC-4 in
    // docs/evidence/setup-race-flakes-evidence.md for the sandbox profile, and for
    // the origin/main version of this test failing under it (the marker
    // never appears) while this file passes under the identical grant.
    const markerRel = '.git/trap-marker';
    const markerTmpRel = '.git/trap-marker.tmp';
    const marker = path.join(dir, markerRel);
    // Behaves like a real suite on the first run: the source is present, so it
    // passes at once. On the REVERTED run the source is gone, and this is where
    // it turns uncooperative: it ignores SIGINT and SIGTERM and keeps running.
    // Written this way because the command is the same on both runs, and a
    // child that hangs on the first one never reaches the revert step at all.
    //
    // The pid is written to a TEMPORARY name and renamed into place, rather
    // than written directly to the marker path. writeFileSync creates a file
    // at open(), before a single byte of content lands, so a poll on mere
    // existence can observe the marker between those two steps and read an
    // empty file. Rename is atomic on the same filesystem: the marker either
    // does not exist yet, or exists complete, never partial.
    const trapping = `${JSON.stringify(process.execPath)} -e `
      + JSON.stringify(
        "if (require('fs').existsSync('lib2.js')) process.exit(0);"
        + "process.on('SIGINT', () => {}); process.on('SIGTERM', () => {});"
        + "const fs = require('fs');"
        + `fs.writeFileSync(${JSON.stringify(markerTmpRel)}, String(process.pid));`
        + `fs.renameSync(${JSON.stringify(markerTmpRel)}, ${JSON.stringify(markerRel)});`
        + 'setTimeout(() => process.exit(1), 30000);');

    try {
      await new Promise((resolve, reject) => {
        const kid = spawn(process.execPath,
          [path.join(__dirname, '..', '..', 'scripts', 'red-first.js'),
            '--repo', dir, '--base', 'main', '--tests', trapping],
          { stdio: ['ignore', 'pipe', 'pipe'] });

        let out = '';
        let signalled = false;
        const deadline = setTimeout(() => {
          kid.kill('SIGKILL');
          reject(new Error('red-first did not exit after the interrupt, or the '
            + "trapping child's marker never appeared; either is the defect "
            + 'this covers'));
        }, 20000);

        kid.stdout.on('data', (b) => {
          out += b.toString();
          // Interrupt once the trapping child is genuinely trapping. It writes
          // the marker only after installing both handlers, so the marker
          // existing is exactly the condition: signal before it and the child
          // takes the default handling, which is the opposite of the case
          // this covers.
          //
          // Waits for the child to actually exist and have its handlers
          // installed, rather than guessing how long that takes. Under load,
          // a fixed 300ms delay fired before the child had even started, so
          // the assertion that failed was "did the child start" rather than
          // the restore behaviour this test exists to check. killWhen polls
          // ready() and bails on its own once the child has already exited,
          // so nothing here needs to cancel it separately.
          if (!signalled && out.includes('restoring the source')) {
            signalled = true;
            killWhen(kid, () => fs.existsSync(marker), 'SIGINT');
          }
        });
        kid.on('error', reject);
        kid.on('exit', () => {
          clearTimeout(deadline);
          try {
            assert.strictEqual(signalled, true, 'the run reached the revert step');
            assert.strictEqual(fs.existsSync(marker), true,
              'the trapping child really did start and ignore the signal');

            // The rename above guarantees this content is complete, never a
            // torn write, so a value that still fails to parse as a positive
            // integer is a malformed marker rather than a live pid, and must
            // fail here with its own message rather than reach process.kill,
            // which treats pid 0 as this process's own group and always
            // succeeds, turning a broken precondition into a false report
            // that the child never died.
            const raw = fs.readFileSync(marker, 'utf8');
            const kidPid = Number(raw);
            assert.ok(Number.isInteger(kidPid) && kidPid > 0,
              `the trapping child's marker at ${marker} did not hold a valid pid (read ${JSON.stringify(raw)})`);

            // The assertion that discriminates the kill. Restoring the tree
            // while a child that ignores signals keeps running only holds until
            // that child writes again, so AC-4 needs the child ended, not
            // merely outlived. Checked by pid liveness rather than by ps, which
            // the local sandbox blocks.
            const alive = () => { try { process.kill(kidPid, 0); return true; } catch (e) { return false; } };
            const deadline2 = Date.now() + 3000;
            while (alive() && Date.now() < deadline2) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
            assert.strictEqual(alive(), false,
              `the trapping child (pid ${kidPid}) must be ended, not left running`);
            assert.strictEqual(fs.existsSync(path.join(dir, 'lib2.js')), true,
              'the source is back despite the child refusing to die');
            assert.strictEqual(
              execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).trim(),
              '', 'and the tree is clean');
            resolve();
          } catch (e) {
            reject(e);
          }
        });
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a tree that does not come back clean', () => {
  test('overrides an otherwise proven outcome with refused', async () => {
    // The post-restore check gates whether the central claim can be trusted at
    // all, and nothing exercised it: the only "refused" test was the
    // dirty-before-start case, which returns long before this branch. Here the
    // reverted run writes to a tracked file that is neither source nor test, so
    // restoreTo puts back what it knows about and the tree is still dirty.
    const { dir } = repo({
      added: { 'lib2.js': 'module.exports.b = () => 2;\n' },
      testFile: "const assert = require('assert');\nmodule.exports = () => { assert.ok(true); };\n",
    });
    try {
      let call = 0;
      const runner = () => {
        call += 1;
        if (call === 2) {
          // A side effect on a tracked file outside sourceFiles, which is
          // exactly what a real test suite doing something careless would do.
          fs.writeFileSync(path.join(dir, 'run.js'), '// scribbled on by the suite\n');
          return false;
        }
        return true;
      };
      const r = await redFirst({ repo: dir, base: 'main', tests: CMD, runner });
      assert.strictEqual(r.outcome, 'refused', r.reason);
      assert.match(r.reason, /did not come back clean/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the base a run is measured against, which must not be one that drifts', () => {
  // The incident these cover, in full, because this tool produced it. A change
  // of three files reported PROVEN on two tests belonging to work that had
  // already merged. Branches here are built in git worktrees cut from the
  // remote trunk, and a worktree does not move the local branch ref that
  // another worktree has checked out, so `main` in one checkout can sit behind
  // the commit the branch was actually cut from. The documented invocation was
  // `--base main`, so the revert took the already-merged work away as well, its
  // tests went red, and the verdict line, the exit code and the record were
  // indistinguishable from a genuine pass. The only tell was a file count
  // inside the record, which nobody reads when the verdict says PROVEN.
  //
  // So the default base is taken from a ref that cannot drift, and a revert
  // that reaches past the point this branch was cut from is refused with the
  // files it would have taken away named.

  /**
   * A repository whose local trunk has fallen behind the published one, with
   * work merged in between that has a discriminating test of its own.
   *
   * Not built on repo() above: that fixture commits its base, branches, and
   * commits the change, which leaves no point at which a third commit can be
   * published to a remote and then dropped from the local ref. The drift is
   * the whole subject here, so the ordering has to be explicit.
   */
  function driftedRepo(own) {
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'red-first-remote-'));
    execFileSync('git', ['init', '-q', '--bare', remote], { stdio: 'ignore' });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'red-first-drift-'));
    const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    git('init', '-q');
    // Named explicitly, and the configs pinned, for the reasons repo() gives.
    git('symbolic-ref', 'HEAD', 'refs/heads/main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    git('config', 'diff.renames', 'false');
    const write = (rel, body) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), body);
    };
    write('lib.js', 'module.exports.a = () => 1;\n');
    write('test/check.js', 'module.exports = () => {};\n');
    // Every test file in the directory, so a case that adds one does not have
    // to modify the runner for it to run. A runner that changed would itself be
    // reverted along with the source, and would then quietly stop calling the
    // very test the case is about.
    write('run.js', "const fs = require('fs');\n"
      + "for (const f of fs.readdirSync('test').sort()) require('./test/' + f)();\n");
    write('.gitignore', '.precommit-gate.json\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    const behind = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    git('remote', 'add', 'origin', remote);
    git('push', '-q', 'origin', 'main');

    // The work that merged first, carrying a test that really discriminates it.
    write('lib.js', 'module.exports.a = () => 1;\nmodule.exports.c = () => 3;\n');
    write('test/check.js', "const assert = require('assert');\n"
      + "module.exports = () => { assert.strictEqual(require('../lib.js').c(), 3); };\n");
    git('add', '-A');
    git('commit', '-q', '-m', 'work that merged before this branch was cut');
    git('push', '-q', 'origin', 'main');

    // The branch, cut from the published trunk exactly as a worktree cuts it.
    git('checkout', '-q', '-b', 'change');
    for (const [rel, body] of Object.entries(own)) write(rel, body);
    git('add', '-A');
    git('commit', '-q', '-m', 'the change');
    // And the local trunk stays where the checkout that owns it left it, which
    // is the whole of the drift.
    git('branch', '-f', 'main', behind);
    return { dir, remote, git };
  }

  // A version-only change: two manifest files, no test of its own. The shape
  // the incident had, and the shape that has nothing of its own to go red.
  const VERSION_ONLY = {
    'package.json': '{ "name": "x", "version": "0.12.0" }\n',
    'package-lock.json': '{ "name": "x", "version": "0.12.0" }\n',
  };

  const clean = (dir, remote) => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
  };

  test('a stale local trunk is refused, with the files it would have reverted named', async () => {
    // The incident itself, driven the way it was driven. Naming the base is
    // still allowed, so the drift has to be caught where the reach is measured
    // rather than only where the default is chosen.
    const { dir, remote } = driftedRepo(VERSION_ONLY);
    try {
      const r = await redFirst({ repo: dir, base: 'main', tests: CMD });
      assert.strictEqual(r.outcome, 'refused', r.reason);
      // The mismatch itself, said out loud. It was present in the incident as a
      // file count inside the record and nothing else.
      assert.match(r.reason, /lib\.js/, 'the file the change never touches is named');
      assert.match(r.reason, /origin\/main/, 'and the ref that does not drift is named');
    } finally {
      clean(dir, remote);
    }
  });

  test('the reach is refused even where the files it drags in are the change is own', async () => {
    // A revert that reaches past the fork point is wrong whether or not the
    // file lists happen to coincide: the same files are taken back further than
    // this branch starts, so the tests that go red can be the earlier work's.
    // Refusing on the file list alone would let exactly that case through.
    const { dir, remote } = driftedRepo({
      'lib.js': 'module.exports.a = () => 1;\nmodule.exports.c = () => 3;\n'
        + 'module.exports.d = () => 4;\n',
      'test/check.js': "const assert = require('assert');\n"
        + 'module.exports = () => {\n'
        + "  assert.strictEqual(require('../lib.js').c(), 3);\n"
        + "  assert.strictEqual(require('../lib.js').d(), 4);\n"
        + '};\n',
    });
    try {
      const r = await redFirst({ repo: dir, base: 'main', tests: CMD });
      assert.strictEqual(r.outcome, 'refused', r.reason);
      assert.match(r.reason, /none/, 'and it says plainly that no extra file is involved');
    } finally {
      clean(dir, remote);
    }
  });

  test('a version-only change is not-provable, not proven on another branch is tests', async () => {
    // The verdict the incident should have produced, from the invocation that
    // is now the default: nothing of this change's own can go red, and that is
    // its own finding rather than a pass borrowed from work already merged.
    const { dir, remote } = driftedRepo(VERSION_ONLY);
    try {
      const r = await redFirst({ repo: dir, tests: CMD });
      assert.strictEqual(r.outcome, 'not-provable', r.reason);
      assert.match(r.reason, /no tests/i);
      assert.deepStrictEqual(r.source.slice().sort(), ['package-lock.json', 'package.json'],
        'and the revert set is this change alone');
    } finally {
      clean(dir, remote);
    }
  });

  test('with no base given, the published trunk is used and not the local one', async () => {
    const { dir, remote } = driftedRepo(VERSION_ONLY);
    try {
      const r = await redFirst({ repo: dir, tests: CMD });
      assert.strictEqual(r.base, 'origin/main',
        'the default is a remote-tracking ref, which no worktree can leave behind');
    } finally {
      clean(dir, remote);
    }
  });

  test('a change carrying its own test is still proven when the base does not drift', async () => {
    // The guard against a fix that buys safety by refusing everything.
    const { dir, remote } = driftedRepo({
      'lib2.js': 'module.exports.b = () => 2;\n',
      'test/mine.js': "const assert = require('assert');\n"
        + "module.exports = () => { assert.strictEqual(require('../lib2.js').b(), 2); };\n",
    });
    try {
      const r = await redFirst({ repo: dir, tests: CMD });
      assert.strictEqual(r.outcome, 'proven', r.reason);
      assert.deepStrictEqual(r.source, ['lib2.js'],
        'and the already-merged work is not in the revert set');
      assert.deepStrictEqual(r.tests, ['test/mine.js']);
    } finally {
      clean(dir, remote);
    }
  });

  test('a repository with no remote falls back to its local trunk', async () => {
    // Nothing to drift against, so the local ref is the only answer there is,
    // and refusing here would take the tool away from every repository that has
    // no remote, including the throwaway ones these tests build.
    const { dir } = repo({
      added: { 'lib2.js': 'module.exports.b = () => 2;\n' },
      testFile: "const assert = require('assert');\n"
        + "module.exports = () => { assert.strictEqual(require('../lib2.js').b(), 2); };\n",
    });
    try {
      const r = await redFirst({ repo: dir, tests: CMD });
      assert.strictEqual(r.outcome, 'proven', r.reason);
      assert.strictEqual(r.base, 'main');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a remote that publishes no trunk is refused rather than guessed at', async () => {
    // Falling back to the local ref here would be the drift again, silently.
    // Naming the base is one flag; a verdict measured against the wrong tree is
    // not recoverable by reading the output.
    const { dir, git } = repo({
      added: { 'lib2.js': 'module.exports.b = () => 2;\n' },
      testFile: "const assert = require('assert');\nmodule.exports = () => { assert.ok(true); };\n",
    });
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'red-first-remote-'));
    try {
      execFileSync('git', ['init', '-q', '--bare', remote], { stdio: 'ignore' });
      git('remote', 'add', 'origin', remote);
      git('push', '-q', 'origin', 'main:trunk');

      const r = await redFirst({ repo: dir, tests: CMD });
      assert.strictEqual(r.outcome, 'refused', r.reason);
      assert.match(r.reason, /--base/, 'and it says how to answer the question it could not');
    } finally {
      clean(dir, remote);
    }
  });

  test('a remote not called origin still supplies the trunk when it is the only one', async () => {
    // Preferring origin must not become requiring it: a checkout whose single
    // remote goes by another name has exactly one answer, and refusing there
    // would send it back to the local ref that drifts.
    const { dir, git } = repo({
      added: { 'lib2.js': 'module.exports.b = () => 2;\n' },
      testFile: "const assert = require('assert');\n"
        + "module.exports = () => { assert.strictEqual(require('../lib2.js').b(), 2); };\n",
    });
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'red-first-remote-'));
    try {
      execFileSync('git', ['init', '-q', '--bare', remote], { stdio: 'ignore' });
      git('remote', 'add', 'upstream', remote);
      git('push', '-q', 'upstream', 'main');

      const r = await redFirst({ repo: dir, tests: CMD });
      assert.strictEqual(r.base, 'upstream/main');
      assert.strictEqual(r.outcome, 'proven', r.reason);
    } finally {
      clean(dir, remote);
    }
  });

  test('the command with no base of its own measures against the published trunk', () => {
    // The invocation the contributor guide documents, driven the way a
    // contributor drives it. Every other case here calls redFirst() directly,
    // which would leave a default that only exists inside the function passing
    // while the command still defaulted to the ref that drifts.
    const { dir, remote } = driftedRepo(VERSION_ONLY);
    try {
      const r = spawnSync(process.execPath,
        [path.join(__dirname, '..', '..', 'scripts', 'red-first.js'),
          '--repo', dir, '--tests', CMD],
        { encoding: 'utf8' });
      assert.match(r.stdout, /measuring against origin\/main/,
        'the base is printed, so a run cannot be read without knowing what it measured');
      assert.match(r.stdout, /NOT-PROVABLE/, r.stdout + r.stderr);
      assert.notStrictEqual(r.status, 0, 'and it is not a pass');
    } finally {
      clean(dir, remote);
    }
  });
});
