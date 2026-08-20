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

// Path fragments that mark a file as a test rather than the thing under test.
// Deliberately generous: misreading source as test makes the check WEAKER,
// since less is reverted, which surfaces as a false "not discriminating"
// rather than as a false proof. The failure leans towards complaining.
const TEST_MARKERS = ['test/', 'tests/', 'spec/', '__tests__/', '.test.', '.spec.'];

const LIMITATION =
  'Reverting proves the tests notice this change. It cannot prove they assert '
  + 'the right thing: a test can discriminate a fix and still measure a proxy.';

function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function isTest(file) {
  return TEST_MARKERS.some(m => file.includes(m));
}

/**
 * @returns {{outcome: 'proven'|'not-discriminating'|'inconclusive'|'not-provable'|'refused',
 *            reason: string, passedWithChange: boolean|null,
 *            failedWithoutChange: boolean|null, source: string[], tests: string[],
 *            limitation: string}}
 */
function redFirst({ repo, base = 'main', tests, log = () => {} }) {
  const result = (outcome, reason, extra = {}) => ({
    outcome, reason, passedWithChange: null, failedWithoutChange: null,
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

  const run = () => spawnSync(tests, { cwd: repo, shell: true, stdio: 'ignore' }).status === 0;

  // WITH the change first. A suite failing for its own reasons makes a failure
  // without the change meaningless, and reporting that as proof would turn a
  // broken suite into evidence.
  log('running the tests with the change');
  const passedWithChange = run();
  if (!passedWithChange) {
    return result('inconclusive', 'the tests do not pass with the change in '
      + 'place, so a failure without it proves nothing',
    { passedWithChange: false, source: sourceFiles, tests: testFiles });
  }

  log('restoring the source, keeping the tests');
  let failedWithoutChange = null;
  try {
    git(repo, ['checkout', mergeBase, '--', ...sourceFiles]);
    failedWithoutChange = !run();
  } finally {
    // Unconditional. A tool that can leave a repository half-reverted is worse
    // than no tool, because the next person debugs a tree nobody put there on
    // purpose.
    git(repo, ['checkout', 'HEAD', '--', ...sourceFiles]);
  }

  if (git(repo, ['status', '--porcelain'])) {
    return result('refused', 'the tree did not come back clean after restoring; '
      + 'inspect before trusting any result', { source: sourceFiles, tests: testFiles });
  }

  if (!failedWithoutChange) {
    return result('not-discriminating', 'the tests pass with the source '
      + 'reverted, so they do not discriminate this change and would have gone '
      + 'green against the defect they were written for',
    { passedWithChange: true, failedWithoutChange: false, source: sourceFiles, tests: testFiles });
  }

  return result('proven', 'the tests fail without the change and pass with it',
    { passedWithChange: true, failedWithoutChange: true, source: sourceFiles, tests: testFiles });
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

module.exports = { redFirst, recordOutcome, isTest, TEST_MARKERS, LIMITATION };
