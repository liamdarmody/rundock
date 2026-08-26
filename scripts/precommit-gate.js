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
 * It matters here more than it would in most tools because of what one step is.
 * `mutate:guards` breaks a real source file on purpose, runs a suite, and puts
 * the file back. The gate used to send it nothing and wait for nothing, so the
 * gate died and `npm`, its shell and the harness inside carried on rewriting
 * `public/` with nobody watching. A mutated source file is an ordinary
 * working-tree modification, `git add -A` stages it without comment, and
 * staging everything before running this is exactly what the usage above asks
 * for.
 *
 * ENDING THE GROUP IS NOT ENOUGH ON ITS OWN, and this was measured rather than
 * assumed. Each harness registers a SIGTERM handler that puts its files back,
 * and that handler is correct, but it can never run while the harness is
 * working: the harness's whole body is a synchronous loop of `execFileSync`
 * calls, and Node dispatches a JavaScript signal handler from the event loop,
 * which does not turn until that body has finished. A real harness sent SIGTERM
 * directly absorbed it for thirty seconds without restoring anything and then
 * died to SIGKILL with the file still mutated.
 *
 * So the gate puts the files back itself when the harness could not. It reads
 * the record the run writes while it holds files rewritten, and restores those
 * paths FROM THE INDEX. That is safe for the one reason that makes it possible
 * at all: a mutation run refuses to start when a file it is about to rewrite
 * has unstaged changes, so at the moment the harness read its originals the
 * working tree and the index agreed on those paths. Restoring from the index
 * therefore puts back exactly the bytes the harness read, and there is nothing
 * unstaged on those paths for it to discard.
 *
 * The one way out that is not covered is SIGKILL of the gate itself, which the
 * kernel delivers to nothing. What catches a harness abandoned that way is the
 * record it writes while it holds files mutated: see test/tools/mutation-run.js.
 */

const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { endGroup, exists, pause, POLL_MS } = require('./lib/process-group.js');

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
//
// COVERAGE RUNS HERE RATHER THAN BESIDE THE GATE, and it replaces the plain
// test run rather than joining it. `test:coverage` drives the same suite over
// the same glob and then enforces the committed floors, so the suite is still
// run once. What changes is where the number comes from: a floor measured by
// hand and quoted in a report is a claim about a tree nobody can identify,
// and it fails on the next run. Measured inside the gate, the floors are
// enforced against the exact tree this record names.
const STEPS = [
  { name: 'test:coverage', args: ['run', 'test:coverage'] },
  { name: 'typecheck', args: ['run', 'typecheck'] },
  { name: 'lint:styles', args: ['run', 'lint:styles'] },
  { name: 'check:refs', args: ['run', 'check:refs'] },
  // Removes each of the renderer's escaping guards in turn and requires a test
  // to go red for it. Slower than the rest because it runs a suite per guard,
  // and worth it here: two of these guards were removable with nothing going
  // red when the check was first written, which no other step in this list
  // would ever have reported.
  { name: 'mutate:guards', args: ['run', 'mutate:guards'] },
  // Reproduces the frozen "before" fixture from the pre-change renderer read
  // out of git history. Needs history, so it lives here and in CI rather than
  // in the unit suite, which runs against a depth-1 checkout.
  { name: 'check:fixture', args: ['run', 'check:fixture'] },
];

// How long a step's process group gets to end on its own before it is ended
// outright.
//
// LONGER THAN THE REVERTING CHECK ASKS FOR, and the difference is the point.
// That tool spawns a test command, and nothing it spawns has a restore step to
// skip, so it can afford half a second of politeness. This one spawns a
// mutation harness that has a real source file rewritten on disk and puts it
// back from its SIGTERM handler, and that handler cannot run until the suite
// the harness is blocked on has itself gone. Escalating to SIGKILL before it
// has finished would turn the tidiest available exit into the exact mess this
// whole area exists to prevent: a mutated file left in the working tree,
// indistinguishable from an edit.
//
// Paid in full only in two cases, neither of them the ordinary one: a group
// that ignores SIGTERM, and a machine whose process table cannot be read, where
// "has the group gone" has no answer until the kernel stops recognising the
// group id at all. Where `ps` runs, an interrupt costs about a second end to
// end and this number is never reached.
const STEP_END_GRACE_MS = 5000;

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
  // Read BEFORE the ending, and act afterwards only on this same record. A
  // record whose pid is ALREADY dead here belongs to some earlier run that was
  // abandoned, and it is doing its job by being there: the next mutation run
  // reads it, refuses, and names the files a person should look at. Repairing
  // that quietly would remove the one trace of a run nobody watched end.
  const held = readMutationRun();
  const ours = held && exists(held.pid) ? held : null;

  const outcome = endGroup(pgid, { graceMs: STEP_END_GRACE_MS });
  if (ours) reclaim(ours);
  if (outcome !== 'running') return;
  console.error(`[precommit] WARNING: process group ${pgid} survived being ended and is `
    + 'still running. Nothing further here can reach it, and a mutation harness inside it '
    + 'may still be holding a source file rewritten; read `git diff` before committing.');
}

// The record a mutation run writes while it holds files rewritten. The name is
// fixed by test/tools/mutation-run.js, which owns the format.
const MUTATION_MARKER = '.mutation-run.json';

// How long a pid from an ended group gets to leave the process table before the
// recovery below gives up on it and says so.
const SETTLE_MS = 1000;

function readMutationRun(root = ROOT) {
  try {
    const held = JSON.parse(fs.readFileSync(path.join(root, MUTATION_MARKER), 'utf8'));
    return held && typeof held.pid === 'number' && Array.isArray(held.files) ? held : null;
  } catch { return null; }
}

/**
 * Put back what a mutation run was holding when this gate ended it.
 *
 * Called only with a record that named a LIVE pid a moment ago, so the run it
 * describes is one this gate has just ended rather than somebody else's.
 *
 * RESTORED FROM THE INDEX, and the distinction is the whole safety argument. A
 * mutation run refuses to start when a file it is about to rewrite has unstaged
 * changes, so on those paths the working tree and the index agreed when the
 * originals were read: the index holds exactly the bytes the harness would have
 * written back. Restoring from HEAD instead would reach past staged work and
 * throw it away, which is the failure this repository has already paid for
 * elsewhere.
 *
 * Every path is named on the way out. A tool that silently rewrites files in
 * the working tree, even correctly, is one nobody can check afterwards.
 */
function reclaim(held, root = ROOT, settleMs = SETTLE_MS) {
  // The group has been ended, so this pid should be gone. A brief window where
  // it is still listed is ordinary rather than a survivor: a process is cleared
  // from the table by whoever adopts it, not the instant it dies. Waiting for
  // it matters because the alternative is returning quietly and leaving the
  // file mutated, which is the outcome this whole function exists to prevent.
  const deadline = Date.now() + settleMs;
  while (exists(held.pid) && Date.now() < deadline) pause(POLL_MS);
  if (exists(held.pid)) {
    console.error(`[precommit] a mutation run (pid ${held.pid}) is still there after its group `
      + 'was ended, so its files have been left alone rather than written over. Read '
      + '`git diff` before committing.');
    return;
  }
  const current = readMutationRun(root);
  // Gone means the harness got to run its own restore after all, which is the
  // better outcome and leaves nothing to do. A different record means another
  // run started in the meantime and this is no longer anybody's business here.
  if (!current || current.pid !== held.pid) return;

  const restored = [];
  for (const file of held.files) {
    try {
      // Only a path that really differs from the index, so the recovery never
      // runs a checkout it had no reason to run.
      if (!git(['diff', '--name-only', '--', file], root)) continue;
      execFileSync('git', ['checkout', '--', file], { cwd: root, stdio: 'ignore' });
      restored.push(file);
    } catch (err) {
      console.error(`[precommit] could not put ${file} back: ${(err && err.message) || err}`);
    }
  }
  try { fs.rmSync(path.join(root, MUTATION_MARKER), { force: true }); } catch { /* leaving anyway */ }
  if (!restored.length) return;
  console.error(`[precommit] a mutation harness was ended mid-run holding ${restored.length} `
    + 'file(s) rewritten, and its own restore could not run. Put back from the index:');
  for (const file of restored) console.error(`             ${file}`);
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
    const settle = () => {
      if (settled || !ended) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ ok: ended.code === 0, code: ended.code, signal: ended.signal, out });
    };
    kid.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
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

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

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

  try {
    for (const step of STEPS) {
      process.stdout.write(`[precommit] ${step.name}... `);
      let result;
      try {
        result = await runStep(step);
      } finally {
        // A step being over means its DIRECT child has closed, which does not
        // mean its group is empty: a package runner starts children that
        // outlive it, and those were what the gate used to report PASS over.
        endLiveGroup();
      }
      if (result.ok) {
        console.log('ok');
        continue;
      }
      console.log('FAILED');
      // BOTH streams, interleaved as the step wrote them. The node test runner
      // writes which test failed and why to STDOUT, and tsc writes its
      // diagnostics there too; stderr carries only npm's "lifecycle script
      // failed" boilerplate. Capturing stderr alone left the developer with a
      // bare "test failed" and nothing to act on, which removes the
      // read-the-result step on the one path where reading the result is the
      // entire point.
      const detail = result.out.trim();
      if (detail) console.error(detail.split('\n').slice(-25).join('\n'));
      // Said out loud when a step was ENDED rather than having failed. Reported
      // as a bare failure, a step killed by a signal reads as a broken test and
      // sends the developer looking for one.
      const how = result.signal ? ` (ended by ${result.signal})` : '';
      console.error(`[precommit] ${step.name} failed${how}. No record written, so the commit stays blocked.`);
      process.exit(1);
    }

    // Written only after every step passed, so the record's existence IS the
    // result being read. There is no separate "did you look at it" step to skip.
    const record = buildRecord({ tree: currentTree(), branch, at: new Date().toISOString() });
    writeRecord(record);
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

module.exports = { refusal, buildRecord, writeRecord, readRecord, currentTree, defaultBranch, workingTreeDrift, stagedPaths, isReleaseCommit, RELEASE_FOOTPRINT, RECORD, STEPS, STEP_END_GRACE_MS };
