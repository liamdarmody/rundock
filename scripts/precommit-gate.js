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

const ROOT = path.resolve(__dirname, '..');
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

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

/** The default branch, read from the remote rather than assumed to be `main`. */
function defaultBranch() {
  try {
    return git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).replace(/^origin\//, '');
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
function currentTree() {
  try { execFileSync('git', ['update-index', '-q', '--refresh'], { cwd: ROOT, stdio: 'ignore' }); } catch { /* refresh is best effort */ }
  return git(['write-tree']);
}

function readRecord() {
  if (!fs.existsSync(RECORD)) return null;
  try { return JSON.parse(fs.readFileSync(RECORD, 'utf8')); } catch { return null; }
}

/**
 * Why a commit may not proceed, or null when it may.
 *
 * Returns a reason CODE alongside the message. The code is what tests assert
 * on: a guard that refuses for the wrong reason is a guard that will refuse
 * for no reason later, and "it failed" is not enough to tell those apart.
 */
function refusal({ record, tree, branch, mainBranch }) {
  const rerun = 'Run `npm run precommit`, then commit again.';
  if (branch === mainBranch) {
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
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const mainBranch = defaultBranch();
  if (branch === mainBranch) {
    console.error(`[precommit] refusing to run on ${mainBranch}: branch first, then run this again.`);
    process.exit(1);
  }

  for (const step of STEPS) {
    process.stdout.write(`[precommit] ${step.name}... `);
    try {
      execFileSync('npm', step.args, { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
      console.log('ok');
    } catch (err) {
      console.log('FAILED');
      const detail = err.stderr ? String(err.stderr).trim().split('\n').slice(-12).join('\n') : '';
      if (detail) console.error(detail);
      console.error(`[precommit] ${step.name} failed. No record written, so the commit stays blocked.`);
      process.exit(1);
    }
  }

  // Written only after every step passed, so the record's existence IS the
  // result being read. There is no separate "did you look at it" step to skip.
  const record = { tree: currentTree(), branch, at: new Date().toISOString(), steps: STEPS.map(s => s.name) };
  fs.writeFileSync(RECORD, JSON.stringify(record, null, 2) + '\n');
  console.log(`[precommit] PASS. Record written for tree ${record.tree.slice(0, 12)} on ${branch}.`);
}

function verify() {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const why = refusal({ record: readRecord(), tree: currentTree(), branch, mainBranch: defaultBranch() });
  if (why) {
    console.error(`[precommit] commit blocked: ${why.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  if (process.argv.includes('--verify')) verify();
  else run();
}

module.exports = { refusal, RECORD };
