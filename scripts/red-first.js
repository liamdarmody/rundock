#!/usr/bin/env node
'use strict';

/**
 * Prove a change's tests fail without the change.
 *
 * WHY
 *
 * Across five cards in one day an independent reviewer caught seven tests that
 * could not have failed. Every one asserted a proxy easier to reach than the
 * property its criterion named: an element box rather than the painted glyphs,
 * containment rather than identity, a pure decision function rather than the
 * wiring around it, a clock-derived guard that skipped its assertions near
 * midnight while still reporting green.
 *
 * The common cause was not carelessness, it was order. Every one of those tests
 * was written AFTER its fix, while looking at the finished code, and a test
 * written that way asserts what the fix obviously does. A test required to fail
 * first cannot. This runs that requirement mechanically, because the author had
 * written the matching failure-taxonomy entry that same morning and produced
 * five fresh instances that afternoon.
 *
 * WHAT IT PROVES, AND WHAT IT DOES NOT
 *
 * Reverting a change proves a test NOTICES that change. It cannot prove the
 * test asserts the right thing: a test can discriminate the fix and still
 * measure a proxy. This closes the cheaper half of the class, which is the half
 * that recurred. That limit travels with every result, in `limitation`, so a
 * green outcome cannot be read as more than it is.
 *
 * USAGE
 *
 *   node scripts/red-first.js --base main --tests "npm test"
 *
 * Exit 0 only when discrimination is proven. Every other outcome is non-zero
 * and names itself, because "it failed" cannot distinguish a weak test from a
 * broken suite, and treating those alike is how a check stops being read.
 */

const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');

// What marks a file as a test rather than the thing under test.
//
// Matched against whole path SEGMENTS, not as substrings. 'src/latest/x.js'
// contains 'test/', because "latest/" ends in it, and so do contest/, attest/,
// protest/ and fastest/. A source file misclassified that way is never
// reverted, so the check silently runs against less than it claims to. The
// error direction is a false complaint rather than a false proof, which is the
// safe direction and still not a reason to leave it wrong.
const TEST_DIRS = ['test', 'tests', 'spec', '__tests__'];
const TEST_FILENAME_MARKERS = ['.test.', '.spec.'];

const LIMITATION =
  'Reverting proves the tests notice this change. It cannot prove they assert '
  + 'the right thing: a test can discriminate a fix and still measure a proxy.';

// Test-count summaries, in the two shapes this project and its neighbours
// actually emit. Parsing is best effort by nature: an unrecognised reporter
// yields null, which is recorded as null. A count invented from output nobody
// could read is worse than no count, because the record is the thing a reviewer
// is asked to trust.
const COUNT_PATTERNS = {
  pass: [/(?:^|\s)(?:#|\u2139)\s*pass\s+(\d+)/m, /(\d+)\s+passing\b/],
  fail: [/(?:^|\s)(?:#|\u2139)\s*fail\s+(\d+)/m, /(\d+)\s+failing\b/],
};

function countFrom(text, kind) {
  for (const re of COUNT_PATTERNS[kind]) {
    const m = text.match(re);
    if (m) return Number(m[1]);
  }
  return null;
}

function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function isTest(file) {
  const parts = file.split('/');
  const name = parts.pop();
  if (parts.some(segment => TEST_DIRS.includes(segment))) return true;
  return TEST_FILENAME_MARKERS.some(m => name.includes(m));
}

function existsAt(repo, ref, file) {
  try {
    execFileSync('git', ['cat-file', '-e', `${ref}:${file}`], { cwd: repo, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Make `files` look exactly as they do in `ref`, in both the index and the
 * working tree.
 *
 * Checking a path out is only half of it. A file the change ADDED has no
 * version at the base, and `git checkout <base> -- <path>` fails outright on a
 * pathspec it cannot resolve, which is how the first run of this tool against
 * its own branch died: the branch adds two files and modifies none. Taking an
 * added file away means deleting it. Taking a deleted file away means putting
 * it back. Asking the target tree what it holds covers both, and renames, and
 * needs no status letters to be parsed correctly.
 *
 * The same function serves the restore, pointed at HEAD, so the way back
 * cannot drift from the way out.
 */
function restoreTo(repo, ref, files) {
  const present = files.filter(f => existsAt(repo, ref, f));
  const absent = files.filter(f => !existsAt(repo, ref, f));
  if (present.length) git(repo, ['checkout', ref, '--', ...present]);
  for (const f of absent) {
    // --ignore-unmatch so a second pass over an already-removed path is a
    // no-op rather than an error, which matters because the restore runs in a
    // finally block that must not throw over the top of a real failure.
    git(repo, ['rm', '--quiet', '-f', '--ignore-unmatch', '--', f]);
  }
}

/**
 * @returns {{outcome: 'proven'|'not-discriminating'|'inconclusive'|'not-provable'|'refused',
 *            reason: string, passedWithChange: boolean|null,
 *            failedWithoutChange: boolean|null, source: string[], tests: string[],
 *            limitation: string}}
 */
function redFirst({ repo, base = 'main', tests, log = () => {}, runner = null }) {
  const result = (outcome, reason, extra = {}) => ({
    outcome, reason, passedWithChange: null, failedWithoutChange: null,
    testsPassedWithChange: null, testsFailedWithoutChange: null,
    source: [], tests: [], limitation: LIMITATION, ...extra,
  });

  // A dirty tree is refused, not tidied. This rewrites tracked files and puts
  // them back, so it must never run where it cannot tell its own edits from
  // someone else's.
  if (git(repo, ['status', '--porcelain'])) {
    return result('refused', 'the working tree has uncommitted changes, and this '
      + 'rewrites tracked files; commit or stash first');
  }

  const mergeBase = git(repo, ['merge-base', base, 'HEAD']);
  const changed = git(repo, ['diff', '--name-only', mergeBase, 'HEAD'])
    .split('\n').filter(Boolean);
  const testFiles = changed.filter(isTest);
  const sourceFiles = changed.filter(f => !isTest(f));

  if (!changed.length) return result('not-provable', `nothing changed against ${base}`);
  if (!testFiles.length) {
    return result('not-provable', 'the change adds no tests, so there is nothing '
      + 'to prove; that is its own finding', { source: sourceFiles, tests: [] });
  }
  if (!sourceFiles.length) {
    return result('not-provable', 'the change touches no source, so there is '
      + 'nothing to take away', { source: [], tests: testFiles });
  }

  // The runner is injectable so a test can make the reverted run throw while
  // the first run passes, which is the only way to reach the restore by the
  // path a real failure would take. The first version of that test used a
  // command that always failed, so it never got past the first run and would
  // have passed with the restore deleted.
  const run = runner
    ? () => ({ ok: !!runner(), pass: null, fail: null })
    : () => {
      // NODE_TEST_CONTEXT must not reach the child. A nested `node --test`
      // that inherits it reports its failures and still exits 0, so a suite
      // that should be red comes back green: the one failure mode this tool
      // cannot afford, reachable whenever red-first is driven from inside a
      // test.
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      const r = spawnSync(tests, { cwd: repo, shell: true, encoding: 'utf8', env });
      const text = `${r.stdout || ''}${r.stderr || ''}`;
      return { ok: r.status === 0, pass: countFrom(text, 'pass'), fail: countFrom(text, 'fail') };
    };

  // WITH the change first. A suite failing for its own reasons makes a failure
  // without the change meaningless, and reporting that as proof would turn a
  // broken suite into evidence.
  log('running the tests with the change');
  const withChange = run();
  const passedWithChange = withChange.ok;
  if (!passedWithChange) {
    return result('inconclusive', 'the tests do not pass with the change in '
      + 'place, so a failure without it proves nothing',
    { passedWithChange: false, source: sourceFiles, tests: testFiles });
  }

  log('restoring the source, keeping the tests');
  let failedWithoutChange = null;
  let withoutChange = { ok: null, pass: null, fail: null };

  // try/finally does not survive a signal: Node's default handling terminates
  // without unwinding, which would abandon the tree mid-revert. Registering a
  // listener is what disables that default, and the listener restores before
  // exiting in case the finally is never reached. Both paths call the same
  // function, and restoring an already-restored tree is a no-op.
  const onSignal = () => {
    try { restoreTo(repo, 'HEAD', sourceFiles); } catch (e) { /* exiting anyway */ }
    process.exit(130);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    restoreTo(repo, mergeBase, sourceFiles);
    withoutChange = run();
    failedWithoutChange = !withoutChange.ok;
  } finally {
    // Unconditional. A tool that can leave a repository half-reverted is worse
    // than no tool, because the next person debugs a tree nobody put there on
    // purpose.
    restoreTo(repo, 'HEAD', sourceFiles);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }

  const counts = {
    testsPassedWithChange: withChange.pass,
    testsFailedWithoutChange: withoutChange.fail,
  };

  if (git(repo, ['status', '--porcelain'])) {
    return result('refused', 'the tree did not come back clean after restoring; '
      + 'inspect before trusting any result', { source: sourceFiles, tests: testFiles });
  }

  if (!failedWithoutChange) {
    return result('not-discriminating', 'the tests pass with the source '
      + 'reverted, so they do not discriminate this change and would have gone '
      + 'green against the defect they were written for',
    { passedWithChange: true, failedWithoutChange: false, source: sourceFiles, tests: testFiles, ...counts });
  }

  return result('proven', 'the tests fail without the change and pass with it',
    { passedWithChange: true, failedWithoutChange: true, source: sourceFiles, tests: testFiles, ...counts });
}

/**
 * Fold the outcome into the pre-commit gate's record, so there is ONE record a
 * reviewer packet can carry rather than two that can disagree.
 *
 * Keyed by tree: a result describes the tree it was measured on, and a record
 * for a different tree is stale by definition. Absence and failure stay
 * distinguishable, because a packet that cannot tell "never run" from "run and
 * found wanting" invites the reader to assume the kinder one.
 */
function recordOutcome(repo, outcome) {
  const fs = require('node:fs');
  const file = path.join(repo, '.precommit-gate.json');
  if (!fs.existsSync(file)) return false;
  let record;
  try { record = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return false; }
  const tree = git(repo, ['write-tree']);
  if (record.tree !== tree) return false;
  record.redFirst = {
    outcome: outcome.outcome,
    reason: outcome.reason,
    // AC-6 names test counts. File counts are a different quantity and were
    // written here first, which is the proxy-for-the-property fault this whole
    // check exists to catch, committed inside the check itself.
    testsPassedWithChange: outcome.testsPassedWithChange,
    testsFailedWithoutChange: outcome.testsFailedWithoutChange,
    sourceFiles: outcome.source.length,
    testFiles: outcome.tests.length,
    limitation: outcome.limitation,
  };
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
  return true;
}

function main() {
  const argv = process.argv.slice(2);
  const arg = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? fallback : argv[i + 1];
  };
  const repo = path.resolve(arg('repo', process.cwd()));
  const outcome = redFirst({
    repo,
    base: arg('base', 'main'),
    tests: arg('tests', 'npm test'),
    log: (m) => console.log(`[red-first] ${m}`),
  });

  console.log(`[red-first] ${outcome.outcome.toUpperCase()}: ${outcome.reason}`);
  if (recordOutcome(repo, outcome)) {
    console.log('[red-first] recorded against the current tree in .precommit-gate.json');
  }
  if (outcome.outcome === 'proven') {
    console.log(`[red-first] note: ${outcome.limitation}`);
    return 0;
  }
  return 1;
}

if (require.main === module) process.exit(main());

module.exports = { redFirst, recordOutcome, restoreTo, isTest, TEST_DIRS, TEST_FILENAME_MARKERS, LIMITATION };
