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
 *   npm run red-first          # fold the discrimination result into the record
 *   git commit                 # the hook refuses unless the record matches
 *
 * Running the checks before staging records the tree as it was, which the hook
 * then correctly rejects as stale. That is the guard working rather than
 * misfiring: what was checked is not what would go in.
 *
 * This is a local convenience and not the enforcement. CI runs the same checks
 * on every pull request and is the line that actually holds; a developer who
 * has not installed the hooks is not bypassing anything that protects main.
 *
 * WHAT IT LEAVES BEHIND
 *
 * Nothing, on any exit this process can see. A step is spawned detached and
 * therefore heads its own process group, and that group is ended before the
 * gate reports anything: after the step, on a step that failed, from the signal
 * listeners, and from an 'exit' listener behind both. Only the group this run
 * started is ever signalled, so a suite or a mutation harness belonging to
 * somebody else is never touched however alike the command lines look.
 *
 * WHAT IT NO LONGER RUNS. Mutation testing, the type check, the style and
 * reference linters, the fixture check and the suite are CI's, and each is
 * named in the record with the CI job that owns it (`ownedByCi`). The local
 * gate keeps the fast checks that decide in seconds whether a tree is worth
 * pushing at all: preflight, and red-first beside it.
 */

const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { endGroup } = require('./lib/process-group.js');

// The repository this acts on. Overridable ONLY so the entry points can be
// exercised against a throwaway repository: without it, run() and verify()
// can only ever touch the real checkout, so the wiring around the decision
// function is untestable and a swapped field would pass every test.
const ROOT = process.env.PRECOMMIT_GATE_ROOT
  ? path.resolve(process.env.PRECOMMIT_GATE_ROOT)
  : path.resolve(__dirname, '..');
const RECORD = path.join(ROOT, '.precommit-gate.json');
// ONE RECORD PER TREE, KEPT. The record above names the last tree the gate
// passed, and the next run overwrites it, so a review of an earlier tree could
// not be given the record for that tree. Every pass also writes the same
// record under the tree's own name here, gitignored and never committed, and
// the oldest beyond TREE_RECORDS_KEPT are removed. `.precommit-gate.json` is
// unchanged: the hook and the review harness read it.
const TREE_RECORDS = path.join(ROOT, '.precommit-gate');
const TREE_RECORDS_KEPT = 50;

// The checks that belong on a commit: the ones that decide in seconds whether
// a tree is worth pushing at all.
//
// `preflight` is the registry, count and document bindings plus the two fast
// linters, all of them run even when one fails, so a person fixes everything
// in one pass. PRINTED WHOLE WHEN IT FAILS: its entire contract is that every
// failure is on the screen at once, and tailing it would deliver exactly the
// one-per-run experience it was built to remove.
//
// EVERYTHING ELSE MOVED TO CI, and the record says where (OWNED_BY_CI below).
// The type check, the linters, the fixture check and the mutation harnesses
// each have a CI job on a clean machine, and CI is the only copy that can
// block a merge. Running them here as well bought a slower answer to a
// question CI already answers better, and the mutation step in particular
// rewrote source files in a developer's working tree for up to ninety
// minutes per commit.
const STEPS = [
  { name: 'preflight', args: ['run', 'preflight'], fullOutput: true },
];

// WHO OWNS EACH CHECK THIS GATE DOES NOT RUN, by the exact CI job name. Folded
// into every record, so a pass here never reads as a claim that the tree was
// type-checked or mutation-tested. A test reads .github/workflows/ci.yml and
// fails when a job named here does not exist, so a renamed job cannot leave
// a check owned by nothing.
const OWNED_BY_CI = [
  { check: 'typecheck', jobs: ['Typecheck (JSDoc + checkJs)'] },
  { check: 'lint:styles', jobs: ['Hygiene (internal references, style drift)'] },
  { check: 'check:refs', jobs: ['Hygiene (internal references, style drift)'] },
  { check: 'test', jobs: ['Test (Node 22)', 'Test (Node 24)'] },
  { check: 'test:coverage', jobs: ['Coverage floors'] },
  { check: 'test:e2e', jobs: ['E2E'] },
  { check: 'mutate:guards', jobs: ['Mutation guards and fixture provenance'] },
  { check: 'check:fixture', jobs: ['Mutation guards and fixture provenance'] },
];

// How long a step's process group gets to end on its own before it is ended
// outright.
//
// LONGER THAN THE REVERTING CHECK ASKS FOR. A suite under a step removes its
// fixtures from SIGTERM handlers, and escalating to SIGKILL before those have
// run leaves the temp root holding directories the next run has to sweep.
//
// Paid in full only in two cases, neither of them the ordinary one: a group
// that ignores SIGTERM, and a machine whose process table cannot be read, where
// "has the group gone" has no answer until the kernel stops recognising the
// group id at all. Where `ps` runs, an interrupt costs about a second end to
// end and this number is never reached.
const STEP_END_GRACE_MS = 5000;

// HOW LONG A STEP GETS BEFORE IT IS ENDED, matching the ceilings CI already
// applies to the same work.
//
// On 2026-08-28 `test:coverage` ran for ninety-five minutes with no output: one
// worker waited on a port the launching shell's sandbox would not let it bind,
// CI caps that job at twenty minutes, and the local gate had no ceiling at all,
// so nothing ended it and nothing said it was stuck. On 2026-09-07 the same
// step hung again, for a different reason, and cost an hour before anybody
// noticed. A gate is a control only while it can finish.
//
// The number is per step rather than for the run, because the run's length is
// not the signal: a suite that normally takes four minutes and is still going
// at twenty is stuck whatever the other steps have done.
//
const STEP_CEILING_MS = {};
const DEFAULT_STEP_CEILING_MS = 10 * 60 * 1000;
const ceilingFor = (name) => STEP_CEILING_MS[name] || DEFAULT_STEP_CEILING_MS;

// How long a step gets to finish flushing its output after it has exited.
//
// The wait below is on 'exit' and not on 'close', because 'close' also waits
// for the pipes and anything the step left behind is holding those open.
// Waiting for them would turn a leak into a hang. This is the other half of
// that trade: a step's last few lines are usually still in flight when it
// exits, and they are the lines a developer reads on a failure.
const DRAIN_MS = 250;

// How much of a step's output is kept for the failure report.
//
// A TAIL RATHER THAN A CAP THAT KILLS, which is the defect this replaces.
// execFileSync stops capturing at one megabyte and, on overflow, SIGTERMs the
// DIRECT child and raises ENOBUFS. The direct child is `npm`; the shell chain
// beneath it and whatever that shell is currently running are not, so a step
// that had done nothing worse than talk a lot was reported as FAILED while its
// subtree carried on. Keeping a tail bounds memory without ever killing
// anything, and the tail is the end of the output, which is the part the
// failure report prints.
const OUTPUT_TAIL_BYTES = 1024 * 1024;

function git(args, root = ROOT) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

// The process group of the step now running, and the ONLY thing this gate ever
// signals.
//
// A NUMBER rather than a child handle, because "what this run is responsible
// for" is a question two exit paths have to answer where a handle is no use:
// the signal listeners, and the 'exit' listener, which is reached after the
// event loop has stopped. A number can be signalled from either.
//
// ONE of them, not a collection: the steps are sequential and the ending below
// clears this before the next spawn, so a second group never coexists with the
// first.
let liveGroup = null;

/**
 * End the group the current step is running in, and forget it once it has gone.
 *
 * ONE definition of the ending, called after each step, from the signal
 * listeners and from the 'exit' listener, rather than three that can drift
 * apart.
 *
 * THE ALARM FIRES ONLY ON A KNOWN SURVIVOR. 'unknown' means the group id still
 * answers and this machine would not say what is in it, which happens where
 * spawning `ps` is blocked. Warning then would fire on every ordinary interrupt
 * on Linux, where a killed child stays listed until it is collected, and an
 * alarm that cries wolf on every Ctrl-C is one nobody reads.
 */
function endLiveGroup() {
  if (liveGroup === null) return;
  const pgid = liveGroup;
  liveGroup = null;
  const outcome = endGroup(pgid, { graceMs: STEP_END_GRACE_MS });
  if (outcome !== 'running') return;
  console.error(`[precommit] WARNING: process group ${pgid} survived being ended and is `
    + 'still running. Nothing further here can reach it; check for stray processes.');
}

/**
 * Run one step, and hand back what it said.
 *
 * DETACHED, so the step heads its own process group. `npm` starts a shell and
 * the shell starts a chain of harnesses, and ending the direct child alone
 * leaves those running: that is how a gate that had already printed its verdict
 * kept rewriting `public/`. A group can be ended whole.
 *
 * The group id is recorded on the line the child is created rather than on any
 * later event, because from that line on there is a subtree on this machine
 * that nothing else knows about, and every exit between there and the next line
 * has to be able to find it.
 *
 * THE WAIT IS ON 'exit' AND NOT ON 'close'. 'close' also waits for the pipes,
 * and anything the step left behind is holding those open, so waiting for it
 * would turn a leak into a hang. A short drain follows so the lines a step
 * wrote just before exiting are still read, and whichever of the two arrives
 * first settles the step.
 */
function runStep(step, root = ROOT) {
  return new Promise((resolve, reject) => {
    const kid = spawn('npm', step.args,
      { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    // The child heads its own group, so its pid IS the group id.
    if (kid.pid) liveGroup = kid.pid;

    let out = '';
    const take = (buf) => {
      out += buf.toString();
      if (out.length > OUTPUT_TAIL_BYTES * 2) out = out.slice(-OUTPUT_TAIL_BYTES);
    };
    kid.stdout.on('data', take);
    kid.stderr.on('data', take);

    let ended = null;
    let settled = false;
    let timer = null;
    // ENDED THE WAY AN INTERRUPT ALREADY ENDS IT, through the process group,
    // because the step's own children are what hang and killing only the
    // parent leaves them running. Reported as a timeout rather than a failure:
    // a step that never finished proved nothing, and calling that a failure
    // would say the check ran and disagreed, which it did not.
    const ceiling = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const mins = Math.round(ceilingFor(step.name) / 60000);
      if (kid.pid) endGroup(kid.pid, { graceMs: STEP_END_GRACE_MS });
      resolve({
        ok: false, timedOut: true, code: null, signal: null,
        out: `${out}\n[precommit] ${step.name} passed ${mins} minutes without finishing and was ended. `
          + 'Nothing it was checking is known: this is a step that never ran to a verdict, not a check that failed.',
      });
    }, ceilingFor(step.name));
    const settle = () => {
      if (settled || !ended) return;
      settled = true;
      if (timer) clearTimeout(timer);
      clearTimeout(ceiling);
      resolve({ ok: ended.code === 0, code: ended.code, signal: ended.signal, out });
    };
    kid.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      clearTimeout(ceiling);
      reject(err);
    });
    kid.on('exit', (code, signal) => {
      ended = { code, signal };
      timer = setTimeout(settle, DRAIN_MS);
    });
    kid.on('close', settle);
  });
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

/**
 * The same record, kept under its tree's name, and the oldest beyond `keep`
 * removed. Only files named for a tree are ever touched, so nothing else a
 * person puts in the folder is pruned.
 */
const TREE_RECORD_NAME = /^[0-9a-f]{40}\.json$/;
function writeTreeRecord(record, dir = TREE_RECORDS, keep = TREE_RECORDS_KEPT) {
  if (!record || !/^[0-9a-f]{40}$/.test(String(record.tree))) {
    throw new Error('writeTreeRecord: a record is kept only under a full tree hash');
  }
  fs.mkdirSync(dir, { recursive: true });
  writeRecord(record, path.join(dir, `${record.tree}.json`));
  const kept = fs.readdirSync(dir)
    .filter((name) => TREE_RECORD_NAME.test(name))
    .map((name) => ({ name, at: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  for (const old of kept.slice(keep)) fs.rmSync(path.join(dir, old.name), { force: true });
}

/** The record `run()` would write for this tree and branch. */
function buildRecord({ tree, branch, at, timings }) {
  // REFUSED WITHOUT MEASUREMENTS, rather than defaulted to none. A tolerant
  // default here is what made the single line that matters untestable: drop
  // `timings` from the call site and every test still passed while every real
  // record carried an empty array and a zero total, which is precisely the
  // silent hole the measurement exists to close. There is one caller, it always
  // has them, and a record without them is not a record of a run.
  if (!Array.isArray(timings) || !timings.length) {
    throw new Error('buildRecord: a record must carry the timings of the run it describes. '
      + 'Pass the timings runSteps returned; a record without them cannot be compared to another.');
  }
  const totalMs = timings.reduce((sum, t) => sum + t.ms, 0);
  return { tree, branch, at, steps: STEPS.map(s => s.name), ownedByCi: OWNED_BY_CI, timings, totalMs };
}

// The release commit's footprint.
//
// scripts/release.js bumps the version and promotes the changelog. It is the
// only thing allowed on top of a gated SHA: release.js checks the gate BEFORE
// creating it, and it touches these two files and nothing else.
//
// The exception is defined by WHAT IS STAGED rather than by an environment
// variable or the name of the calling process, because a guard any caller can
// announce its way past is not a guard.
//
// RESIDUAL RISK, stated rather than left implicit: this also lets a
// hand-edited changelog or a hand-edited version through without the checks.
// That is judged acceptable, because neither is code, both are visible in the
// one place people read before a release, and the alternative is a gate that
// blocks the release tool it ships beside.
const RELEASE_FOOTPRINT = ['package.json', 'CHANGELOG.md'];

// Where that commit is made. It used to be the default branch, and the
// protection on main now refuses a direct push, so release.js commits the bump
// on `release/<version>` and puts it through a pull request instead. The
// exception follows the commit to the branch it is made on.
//
// Exact rather than a prefix: this is the name prepare builds, and a rule that
// admitted anything beginning with the word would be a name anybody could
// adopt to skip the checks. The default branch keeps the exception too, for the
// hand-edited version or changelog the residual risk above describes.
const RELEASE_BRANCH_RE = /^release\/\d+\.\d+\.\d+$/;

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
  // The release commit, on the branch release:prepare makes it on.
  if (RELEASE_BRANCH_RE.test(branch) && isReleaseCommit(staged)) return null;
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

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * Run the steps in order, timing each, stopping at the first failure.
 *
 * SEPARATED SO THE LOOP ITSELF CAN BE DRIVEN, which is the difference between
 * measuring and claiming to. Handing buildRecord a hand-written timings array
 * proves only that an object survives a function; drop the argument at the call
 * site and that test still passes while every real record carries none. `steps`
 * and `runOne` are defaulted seams, the same shape this repository uses
 * everywhere else; production passes neither.
 */
async function runSteps({ steps = STEPS, runOne = runStep, onGroupEnd = () => {} } = {}) {
  const timings = [];
  for (const step of steps) {
    process.stdout.write(`[precommit] ${step.name}... `);
    let result;
    const stepStarted = Date.now();
    try {
      result = await runOne(step);
    } finally {
      onGroupEnd();
    }
    const stepMs = Date.now() - stepStarted;
    timings.push({ step: step.name, ms: stepMs });
    if (result.ok) {
      console.log(`ok (${(stepMs / 1000).toFixed(1)}s)`);
      continue;
    }
    console.log('FAILED');
    return { ok: false, timings, failed: step, result, stepMs };
  }
  return { ok: true, timings };
}

async function run() {
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

  // EVERY way this process can end, wired before the first step is spawned.
  //
  // WHICH PATH IS RESPONSIBLE FOR WHAT, stated once here. The `finally` inside
  // the loop ends the group when a step is over, so the next step never shares
  // the machine with what the last one left. The outer `finally` covers an
  // error out of the body. The signal listeners cover SIGINT, SIGTERM and
  // SIGHUP, which is the case that cost four attempts to land a two-line
  // change: with no listener at all, Node's default handling ends this process
  // without unwinding, and the harness mid-mutation was simply abandoned. The
  // 'exit' listener covers the failure path, which leaves by `process.exit` and
  // therefore runs no `finally` of ours at all. Listeners there may only do
  // synchronous work, which is why the ending blocks rather than awaits.
  const onExit = () => endLiveGroup();
  const onSignal = () => { endLiveGroup(); process.exit(130); };
  process.on('exit', onExit);
  for (const signal of SIGNALS) process.on(signal, onSignal);

  // MEASURED, SO THE NEXT CLAIM ABOUT THIS GATE CAN BE CHECKED. The reordering
  // this list carries was justified by counting what one release cost; a claim
  // that it is now cheaper deserves the same evidence rather than a feeling, and
  // where the time actually goes moves as the suite grows.
  let outcome;
  try {
    outcome = await runSteps({ onGroupEnd: endLiveGroup });
    if (!outcome.ok) {
      const { failed, result, stepMs, timings: spentSoFar } = outcome;
      const detail = result.out.trim();
      if (detail) console.error(failed.fullOutput ? detail : detail.split('\n').slice(-25).join('\n'));
      // A STEP THAT NEVER FINISHED IS NOT A STEP THAT FAILED, and the ceiling
      // exists to tell them apart. Reported as a plain failure, a step ended at
      // its ceiling sends a developer looking for a broken test that isn't
      // there, which is the hour the ceiling was written to stop being lost.
      const how = result.timedOut
        ? ` (ended at its ${(ceilingFor(failed.name) / 60000).toFixed(0)} minute ceiling, so it reached no verdict)`
        : (result.signal ? ` (ended by ${result.signal})` : '');
      // WITH THE ELAPSED TIME, because the runs this ordering is measured on are
      // the FAILING ones: a cheap failure surfaced in seconds rather than after
      // the suite is the whole saving, and a failing run used to leave no
      // duration behind at all. No record is written on this path, correctly, so
      // the numbers go where a person and a log can both see them.
      const spent = spentSoFar.map(t => `${t.step} ${(t.ms / 1000).toFixed(1)}s`).join(', ');
      console.error(`[precommit] ${failed.name} failed${how} after ${(stepMs / 1000).toFixed(1)}s. `
        + `Spent so far: ${spent} (${(spentSoFar.reduce((a2, t) => a2 + t.ms, 0) / 1000).toFixed(1)}s total). `
        + 'No record written, so the commit stays blocked.');
      process.exit(1);
    }
    const timings = outcome.timings;
    // Written only after every step passed, so the record's existence IS the
    // result being read. There is no separate "did you look at it" step to skip.
    const record = buildRecord({ tree: currentTree(), branch, at: new Date().toISOString(), timings });
    writeRecord(record);
    // Kept under its tree's name as well. A failure here cannot unmake the
    // pass the record above states, so it is reported rather than thrown.
    try {
      writeTreeRecord(record);
    } catch (e) {
      console.error(`[precommit] the record could not also be kept under its tree's name: ${e.message}`);
    }
    console.log(`[precommit] PASS. Record written for tree ${record.tree.slice(0, 12)} on ${branch}.`);
  } finally {
    endLiveGroup();
    process.off('exit', onExit);
    for (const signal of SIGNALS) process.off(signal, onSignal);
  }
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
  else {
    // An unhandled rejection would print a stack and exit non-zero, which is
    // the right code for the wrong reason and reads as a failed check. The
    // 'exit' listener still ends the group either way.
    run().catch((err) => {
      console.error(`[precommit] the gate could not run: ${(err && err.message) || err}`);
      process.exit(1);
    });
  }
}

module.exports = { refusal, runSteps, buildRecord, writeRecord, writeTreeRecord, TREE_RECORDS, TREE_RECORDS_KEPT, readRecord, currentTree, defaultBranch, workingTreeDrift, stagedPaths, isReleaseCommit, RELEASE_FOOTPRINT, RECORD, STEPS, OWNED_BY_CI, STEP_END_GRACE_MS, STEP_CEILING_MS, DEFAULT_STEP_CEILING_MS, ceilingFor };
