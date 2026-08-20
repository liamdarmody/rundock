#!/usr/bin/env node
'use strict';

/**
 * Pre-commit gate: the four steps, as a command rather than a habit.
 *
 * Three errors in the 0.11.7 run died at the same four steps: verify the
 * branch, run the checks, read the result, commit. A fourth followed the same
 * week, a pull request pushed without the unit suite having been run, with CI
 * going red on a failure thirty seconds locally would have caught. Doing them
 * by hand worked for thirty-four merges and stopped working once the work had
 * no instruments of its own. A habit that holds only while the work is easy is
 * not a control.
 *
 * The shape is borrowed rather than invented. `scripts/release-gate.js` solves
 * this one level up: run the gauntlet, write a record stamped with the SHA it
 * passed on, and refuse to tag unless the record matches the exact current
 * HEAD. This is the same contract for the per-commit checks.
 *
 * WHAT IDENTIFIES THE TREE. The record names the hash `git write-tree`
 * produces for the current index, which is the exact content a commit would
 * capture. A working-directory timestamp would not do: it cannot tell a passing
 * tree from the same tree with one more edit staged on top, which is the case
 * the guard exists for.
 *
 * Usage, and the order matters:
 *   git add -A                 # stage first: the record names the STAGED tree
 *   npm run precommit          # run the checks, write the record
 *   git commit                 # the hook refuses unless the record matches
 *
 * Running the checks before staging records the tree as it was, which the hook
 * then correctly rejects as stale. That is the guard working rather than
 * misfiring: what was checked is not what would go in.
 *
 * This is a local convenience and not the enforcement. CI runs the same checks
 * on every pull request and is the line that actually holds; a developer who
 * has not installed the hooks is not bypassing anything that protects main.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// The repository this acts on. Overridable ONLY so the entry points can be
// exercised against a throwaway repository: without it, run() and verify()
// can only ever touch the real checkout, so the wiring around the decision
// function is untestable and a swapped field would pass every test.
const ROOT = process.env.PRECOMMIT_GATE_ROOT
  ? path.resolve(process.env.PRECOMMIT_GATE_ROOT)
  : path.resolve(__dirname, '..');
const RECORD = path.join(ROOT, '.precommit-gate.json');

// The checks that belong on a commit: fast, deterministic, and the ones whose
// absence has actually cost a red pipeline. The browser suite and the live
// smoke stay in the release gate, where their cost is affordable.
const STEPS = [
  { name: 'test', args: ['test'] },
  { name: 'typecheck', args: ['run', 'typecheck'] },
  { name: 'lint:styles', args: ['run', 'lint:styles'] },
  { name: 'check:refs', args: ['run', 'check:refs'] },
];

function git(args, root = ROOT) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

/** The default branch, read from the remote rather than assumed to be `main`. */
function defaultBranch(root = ROOT) {
  try {
    return git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], root).replace(/^origin\//, '');
  } catch {
    return 'main';
  }
}

/**
 * The hash of the tree a commit would capture right now.
 *
 * `write-tree` requires the index to be current, so refresh it first: without
 * that, a file touched but unchanged can report as modified and produce a
 * different hash for identical content.
 */
function currentTree(root = ROOT) {
  try { execFileSync('git', ['update-index', '-q', '--refresh'], { cwd: root, stdio: 'ignore' }); } catch { /* refresh is best effort */ }
  return git(['write-tree'], root);
}

/**
 * Content the checks would read but the record would not name.
 *
 * The checks run against the WORKING DIRECTORY; the record hashes the INDEX.
 * Those are the same tree only while nothing is unstaged. Stage a file, edit it
 * again without staging, and the checks validate the newer content while the
 * record names the older staged tree. `git commit` then commits the index, and
 * verify() admits it, because the index has not moved. The gate would have
 * certified a tree it never checked, which is the exact guarantee it exists to
 * provide.
 *
 * So refuse when they diverge rather than hashing one and testing the other.
 * Untracked files count: a new test file the checks would happily run is not in
 * the index and would not be in the record.
 *
 * Returns the offending paths, empty when the two agree.
 */
function workingTreeDrift(root = ROOT) {
  const lines = git(['status', '--porcelain'], root).split('\n').filter(Boolean);
  return lines
    // Column two is the working tree against the index; '??' is untracked.
    .filter(line => line.startsWith('??') || (line[1] && line[1] !== ' '))
    .map(line => line.slice(3));
}

function readRecord(file = RECORD) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * The record, written by the one path that writes it.
 *
 * Extracted so tests exercise the SAME writer the gate uses. A test that
 * hand-builds the JSON proves the reader can read the test's idea of a record,
 * which is not the claim: a field renamed on one side only would leave such a
 * test green while the guard silently stopped matching anything.
 */
function writeRecord(record, file = RECORD) {
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
}

/** The record `run()` would write for this tree and branch. */
function buildRecord({ tree, branch, at }) {
  return { tree, branch, at, steps: STEPS.map(s => s.name) };
}

// The release commit's footprint.
//
// scripts/release.js bumps the version, promotes the changelog, and commits
// directly to main. That is by design and the card plan states the constraint:
// it is the only thing allowed on top of a gated SHA, release.js checks the
// gate BEFORE creating it, and it touches these two files and nothing else.
//
// The exception is defined by WHAT IS STAGED rather than by an environment
// variable or the name of the calling process, because a guard any caller can
// announce its way past is not a guard.
//
// RESIDUAL RISK, stated rather than left implicit: this also lets a
// hand-edited changelog or a hand-edited version reach the default branch
// without a branch. That is judged acceptable, because neither is code, both
// are visible in the one place people read before a release, and the
// alternative is a gate that blocks the release tool it ships beside.
const RELEASE_FOOTPRINT = ['package.json', 'CHANGELOG.md'];

/** Paths staged for the next commit. */
function stagedPaths(root = ROOT) {
  const out = git(['diff', '--cached', '--name-only'], root);
  return out ? out.split('\n').filter(Boolean) : [];
}

function isReleaseCommit(staged) {
  return staged.length > 0 && staged.every(p => RELEASE_FOOTPRINT.includes(p));
}

/**
 * Why a commit may not proceed, or null when it may.
 *
 * Returns a reason CODE alongside the message. The code is what tests assert
 * on: a guard that refuses for the wrong reason is a guard that will refuse
 * for no reason later, and "it failed" is not enough to tell those apart.
 */
function refusal({ record, tree, branch, mainBranch, staged = [] }) {
  const rerun = 'Run `npm run precommit`, then commit again.';
  if (branch === mainBranch) {
    // The one commit that belongs here. Everything else branches first.
    if (isReleaseCommit(staged)) return null;
    return { code: 'on-default-branch', message: `refusing to commit directly to ${mainBranch}. Branch first.` };
  }
  if (!record) {
    return { code: 'no-record', message: `the checks have not been run against this tree. ${rerun}` };
  }
  if (record.branch !== branch) {
    return { code: 'wrong-branch', message: `the record is for branch "${record.branch}" but you are on "${branch}". ${rerun}` };
  }
  if (record.tree !== tree) {
    return { code: 'stale-record', message: `the record is for a different tree, so something changed after the checks ran. ${rerun}` };
  }
  return null;
}

function run() {
  const branch = git(['branch', '--show-current']);
  const mainBranch = defaultBranch();
  if (branch === mainBranch) {
    console.error(`[precommit] refusing to run on ${mainBranch}: branch first, then run this again.`);
    process.exit(1);
  }

  const drift = workingTreeDrift();
  if (drift.length) {
    console.error('[precommit] refusing: the working tree does not match what is staged, so the checks');
    console.error('           would read one tree and the record would name another. Stage or stash:');
    for (const file of drift.slice(0, 10)) console.error(`             ${file}`);
    if (drift.length > 10) console.error(`             ...and ${drift.length - 10} more`);
    process.exit(1);
  }

  for (const step of STEPS) {
    process.stdout.write(`[precommit] ${step.name}... `);
    try {
      execFileSync('npm', step.args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
      console.log('ok');
    } catch (err) {
      console.log('FAILED');
      // BOTH streams. The node test runner writes which test failed and why to
      // STDOUT, and tsc writes its diagnostics there too; stderr carries only
      // npm's "lifecycle script failed" boilerplate. Capturing stderr alone
      // left the developer with a bare "test failed" and nothing to act on,
      // which removes the read-the-result step on the one path where reading
      // the result is the entire point.
      const detail = [err.stdout, err.stderr]
        .map(stream => (stream ? String(stream).trim() : ''))
        .filter(Boolean)
        .join('\n');
      if (detail) console.error(detail.split('\n').slice(-25).join('\n'));
      console.error(`[precommit] ${step.name} failed. No record written, so the commit stays blocked.`);
      process.exit(1);
    }
  }

  // Written only after every step passed, so the record's existence IS the
  // result being read. There is no separate "did you look at it" step to skip.
  const record = buildRecord({ tree: currentTree(), branch, at: new Date().toISOString() });
  writeRecord(record);
  console.log(`[precommit] PASS. Record written for tree ${record.tree.slice(0, 12)} on ${branch}.`);
}

function verify() {
  const branch = git(['branch', '--show-current']);
  const why = refusal({
    record: readRecord(), tree: currentTree(), branch,
    mainBranch: defaultBranch(), staged: stagedPaths(),
  });
  if (why) {
    console.error(`[precommit] commit blocked: ${why.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  if (process.argv.includes('--verify')) verify();
  else run();
}

module.exports = { refusal, buildRecord, writeRecord, readRecord, currentTree, defaultBranch, workingTreeDrift, stagedPaths, isReleaseCommit, RELEASE_FOOTPRINT, RECORD, STEPS };
