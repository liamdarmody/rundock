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
 *   node scripts/red-first.js --tests "npm test"
 *
 * WITH NO --base, which is the invocation to use. The base is worked out from
 * the refs that cannot have drifted behind this branch's fork point, because a
 * branch name can: a git worktree does not move the local ref another worktree
 * has checked out, and reverting against a stale one takes away work that had
 * already merged and reports its tests as proof of this change. See
 * resolveBase. Pass --base only to measure against something other than the
 * trunk, and expect a refusal if it reaches past the fork point.
 *
 * Exit 0 only when discrimination is proven. Every other outcome is non-zero
 * and names itself, because "it failed" cannot distinguish a weak test from a
 * broken suite, and treating those alike is how a check stops being read.
 *
 * WHAT IT LEAVES BEHIND
 *
 * Nothing, on any exit this process can see. The test command is spawned
 * detached and therefore heads its own process group, and only groups this run
 * started are ever signalled, so a suite or a mutation harness belonging to
 * somebody else is never touched however alike the command lines look. Which
 * path ends the group on which kind of exit is set out once, above the
 * listeners in redFirst, rather than summarised differently here.
 *
 * A run in progress is recorded outside the repository, and a start made while
 * one is still live is refused rather than allowed to add a second suite to the
 * machine. That refusal exists because retrying an inconclusive check used to
 * do exactly that, three suites deep, and the retries were the response to the
 * load the retries were creating.
 */

const { execFileSync, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
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

// How many named tests the record carries.
//
// SET HIGH ON PURPOSE. The first version capped at forty, and reverting a
// module that the test fixtures import fails a hundred and twenty tests in run
// order, so the forty recorded were forty unrelated integration tests and the
// proofs a reviewer came to check were the ones cut off. A capped list is a
// partial list offered with the shape of a complete one, which is the exact
// failure this branch exists to stop shipping.
//
// A cap still exists, because a record nobody can read is its own kind of
// useless, and `namesTruncated` says plainly when one has been applied.
const NAME_LIMIT = 200;

// The NAMES of the tests that failed, in the two shapes this project and its
// neighbours emit: the spec reporter's cross and TAP's `not ok`.
//
// WHY NAMES AND NOT ONLY A COUNT. A count says the suite noticed something. It
// cannot say the proofs a criterion names are among what it noticed, so a
// change whose real guards are untested still records a healthy number as long
// as anything at all went red. The names are what let a reader check the claim
// against the criteria rather than take it.
//
// Best effort by nature, like the counts: an unrecognised reporter yields an
// empty list, which is recorded as empty. Names invented from output nobody
// could read would be worse than none, because the record is the thing a
// reviewer is asked to trust.
const NAME_PATTERNS = [
  /^\s*\u2716\s+(.+?)\s+\(\d+(?:\.\d+)?ms\)\s*$/gm,
  /^not ok \d+ - (.+?)\s*$/gm,
];

function namesFrom(text) {
  const names = new Set();
  for (const re of NAME_PATTERNS) {
    for (const m of text.matchAll(re)) {
      // The spec reporter's summary heading ("failing tests:") carries no
      // duration, so the pattern above never reaches it and nothing here has
      // to exclude it by name.
      const name = m[1].trim();
      if (name) names.add(name);
    }
  }
  return [...names];
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

// The names a repository's trunk can go by, in the order it is asked about
// them.
const TRUNK_NAMES = ['main', 'master'];

// The commit a ref names, or null where this repository has no such ref.
function shaOf(repo, ref) {
  try {
    return execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
      { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch (e) {
    return null;
  }
}

function remotesOf(repo) {
  return git(repo, ['remote']).split('\n').map(s => s.trim()).filter(Boolean);
}

/**
 * The ref naming the trunk on one remote, or null if that remote has none.
 *
 * `<remote>/HEAD` is the remote's own answer to which branch is its trunk, so
 * it is asked first and the guessing below only runs where the repository has
 * never been told.
 */
function remoteTrunk(repo, remote) {
  let head = null;
  try {
    head = execFileSync('git', ['symbolic-ref', '--quiet', `refs/remotes/${remote}/HEAD`],
      { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (e) {
    head = null;
  }
  if (head) return head.replace(/^refs\/remotes\//, '');
  for (const name of TRUNK_NAMES) {
    if (shaOf(repo, `${remote}/${name}`)) return `${remote}/${name}`;
  }
  return null;
}

/**
 * Which ref this run reverts against, or a refusal saying why there is none.
 *
 * @returns {{ok: true, ref: string}|{ok: false, reason: string}}
 *
 * WHY THE DEFAULT IS NOT `main`. Branches here are built in git worktrees cut
 * from the published trunk, and a worktree does not move the local branch ref
 * that another worktree has checked out. The local `main` in one checkout
 * therefore sits wherever its owner last left it, which can be behind the
 * commit this branch was actually cut from. Reverting against it takes away
 * work that had already merged, that work's tests go red, and the run reports
 * PROVEN for a change that proved nothing. Measured, not imagined: a three-file
 * change with no test of its own reported PROVEN on two tests belonging to
 * somebody else's merge, and the verdict line, the exit code and the record
 * were indistinguishable from a genuine pass.
 *
 * A remote-tracking ref cannot drift that way. Nothing local moves it, and it
 * only ever changes when the repository is told what the remote holds.
 *
 * REFUSING RATHER THAN FALLING BACK. Where no ref can be shown not to have
 * drifted, this refuses and names the flag rather than guessing. Naming the
 * base costs one flag; a verdict measured against the wrong tree cannot be
 * recovered by reading the output, which is the whole of the defect above.
 *
 * A repository with no remote at all is the exception, and it is not a
 * loophole: there is nothing for its local trunk to drift against, and
 * refusing there would take the tool away from every checkout without a remote,
 * including the throwaway ones its own tests build.
 */
function resolveBase(repo, requested) {
  if (requested) return { ok: true, ref: requested };

  const remotes = remotesOf(repo);
  const trunks = [];
  for (const remote of remotes) {
    const trunk = remoteTrunk(repo, remote);
    if (trunk) trunks.push(trunk);
  }
  // origin first, because a repository that has one and something else is
  // naming its own default by having it; otherwise the only trunk there is.
  const chosen = trunks.find(t => t.startsWith('origin/'))
    || (trunks.length === 1 ? trunks[0] : null);
  if (chosen) return { ok: true, ref: chosen };

  if (remotes.length) {
    return { ok: false, reason: 'there is no single remote-tracking trunk to measure '
      + `against (remotes: ${remotes.join(', ')}; trunks found: ${trunks.join(', ') || 'none'}). `
      + 'Only a remote-tracking ref can be shown not to have drifted behind the point '
      + 'this branch was cut from, so name the one you mean with --base <remote>/<branch>.' };
  }

  const local = TRUNK_NAMES.filter(n => shaOf(repo, `refs/heads/${n}`));
  if (local.length === 1) return { ok: true, ref: local[0] };
  return { ok: false, reason: 'this repository has no remote, and no single local '
    + `${TRUNK_NAMES.join(' or ')} branch to fall back to (found: ${local.join(', ') || 'none'}). `
    + 'Name the base with --base.' };
}

// Is `older` reachable from `newer`? Exit status is the whole answer, so
// nothing is parsed.
function isAncestor(repo, older, newer) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', older, newer],
      { cwd: repo, stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * The narrowest point this branch could have been cut from, or null.
 *
 * @returns {{ref: string, sha: string}|null}
 *
 * WHY MORE THAN ONE REF IS ASKED. The base decides how far back the revert
 * reaches, and a base that reaches past the fork point takes away work that had
 * already merged along with the change under test. The fork point cannot be
 * read off one ref: it is the NEWEST of the merge bases the trunk refs offer,
 * because a ref that has fallen behind can only ever name an older one.
 *
 * A ref that already contains HEAD is left out. Its merge base IS HEAD, the
 * diff against it is empty, and taking that for the fork point would make every
 * file in the change look like a file the change does not touch. This branch's
 * own pushed ref is exactly such a ref, so only trunks are asked and the check
 * is made anyway.
 *
 * Where the candidates cannot be ordered against each other there is no single
 * answer and none is offered. The caller then measures against the base it was
 * given, which is what every run did before this existed.
 */
function forkPoint(repo, base) {
  const head = shaOf(repo, 'HEAD');
  const refs = new Set([base]);
  for (const remote of remotesOf(repo)) {
    const trunk = remoteTrunk(repo, remote);
    if (trunk) refs.add(trunk);
  }
  for (const name of TRUNK_NAMES) {
    if (shaOf(repo, `refs/heads/${name}`)) refs.add(name);
  }
  const points = [];
  for (const ref of refs) {
    let sha = null;
    try { sha = git(repo, ['merge-base', ref, 'HEAD']); } catch (e) { continue; }
    if (sha === head) continue;
    points.push({ ref, sha });
  }
  return points.find(p => points.every(q => q.sha === p.sha || isAncestor(repo, q.sha, p.sha)))
    || null;
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

// The process-group lifecycle lives in scripts/lib/process-group.js, because
// the pre-commit gate has the same subtree to end and got it wrong in the same
// three ways. `exists` and `groupRunning` are used below; `groupRunning` is
// re-exported because this tool's own orphan tests drive it directly.
const { exists, groupRunning, endGroup } = require('./lib/process-group.js');

/**
 * Where a run in progress is recorded, so the next start can see it.
 *
 * OUTSIDE the repository, unlike the gate record this file also writes. That
 * record describes a TREE and belongs beside the tree it describes; this one
 * describes PROCESSES on one machine, and means nothing in another checkout of
 * the same commit. Keeping it out of the working tree also keeps it clear of
 * the cleanliness check this tool makes of the repository it is pointed at: a
 * file written inside would have to be ignored by every repository the tool is
 * ever run against, including the throwaway ones its own tests build, and a
 * repository that had not been told to ignore it would find the tool refusing
 * its own record.
 *
 * Keyed by the resolved repository path, so two checkouts are two records.
 */
function runRecordPath(repo) {
  const key = crypto.createHash('sha256').update(path.resolve(repo)).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), `red-first-run-${key}.json`);
}

function readRunRecord(file) {
  try {
    const held = JSON.parse(fs.readFileSync(file, 'utf8'));
    return held && typeof held === 'object' ? held : null;
  } catch (e) { return null; }
}

/**
 * Is the run this record describes still going?
 *
 * Both halves are asked about, because between the two suites there are moments
 * when the tool is alive with nothing under it, and after an ending nothing can
 * catch there are moments when a suite is alive with no tool over it. Either
 * one means starting now would put a second suite on this machine, or a second
 * reverter on the same working tree.
 *
 * THE BOUND, since this is a judgement about numbers. A pid or a group id whose
 * owner has gone can in principle be reused by something unrelated, and this
 * would then report a live run that is not one. The consequence is a refusal
 * that should not have happened, which costs a developer one message naming a
 * file to delete; the consequence of the other error direction is another full
 * suite on a machine that already has one.
 */
function runIsLive(held) {
  const pid = Number(held.pid);
  if (Number.isInteger(pid) && pid > 0 && exists(pid)) return true;
  const group = Number(held.group);
  if (!Number.isInteger(group) || group <= 0) return false;
  return groupRunning(group) !== false;
}

/**
 * Take ownership of this repository for the length of this run, or report the
 * run that already holds it.
 *
 * CLAIMED BEFORE ANY OTHER WORK, and with an exclusive create rather than a
 * read followed by a write. The first version read the record at the top of the
 * run and did not write one until after three git commands had finished, so two
 * starts a few milliseconds apart both saw an empty machine, both proceeded,
 * and both reverted the same working tree, checking files out from under each
 * other. That is the case the refusal exists to prevent, and the check that was
 * meant to prevent it had a window in the middle of it.
 *
 * On EEXIST the holder is read and judged: a live run wins and this start is
 * refused, a record whose run has gone is stale and is replaced. A stale file
 * that refused every start until somebody deleted it would be its own outage.
 */
function claimRun(repo, tests) {
  const file = runRecordPath(repo);
  const record = {
    pid: process.pid, group: null, tests,
    repo: path.resolve(repo), startedAt: new Date().toISOString(),
  };
  const body = () => JSON.stringify(record, null, 2) + '\n';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(file, body(), { flag: 'wx' });
      return { ok: true, file, record };
    } catch (e) {
      if (e.code !== 'EEXIST') {
        // Loud, because the refusal is only as good as this write. A run that
        // cannot record itself still works; the next one just will not be
        // refused, and whoever retries should know that before they do.
        console.error('[red-first] could not record this run at '
          + `${file} (${e.message}); a concurrent start will not be refused`);
        return { ok: true, file, record, unrecorded: true };
      }
      const held = readRunRecord(file);
      if (held && runIsLive(held)) return { ok: false, file, live: { ...held, file } };
      try { fs.rmSync(file, { force: true }); } catch (e2) { /* someone else got there */ }
    }
  }
  return { ok: false, file, live: { ...(readRunRecord(file) || {}), file } };
}

/**
 * @returns {{outcome: 'proven'|'not-discriminating'|'inconclusive'|'not-provable'|'refused',
 *            reason: string, base: string|null, passedWithChange: boolean|null,
 *            failedWithoutChange: boolean|null, testsPassedWithChange: number|null,
 *            testsFailedWithoutChange: number|null, namesFailedWithoutChange: string[],
 *            source: string[], tests: string[], limitation: string}}
 *
 * `base` defaults to null rather than to a branch name, which means "work out
 * which ref cannot have drifted". See resolveBase for why a literal default was
 * the wrong one.
 */
async function redFirst({ repo, base = null, tests, log = () => {}, runner = null,
  groupEnder = endGroup }) {
  // The ref this run settled on, once it has. Held out here rather than passed
  // to each result, so no exit can report an outcome without saying what it was
  // measured against: that omission is how the incident stayed invisible.
  let baseRef = null;
  const result = (outcome, reason, extra = {}) => ({
    outcome, reason, base: baseRef, passedWithChange: null, failedWithoutChange: null,
    testsPassedWithChange: null, testsFailedWithoutChange: null, namesFailedWithoutChange: [],
    source: [], tests: [], limitation: LIMITATION, ...extra,
  });

  // Claimed before anything else, because the cost of getting this wrong is
  // paid by every process on the machine rather than by this one.
  //
  // A check that comes back inconclusive invites a retry, and a retry used to
  // mean another full suite on top of the one still running from the attempt
  // before. Three concurrent suites and a load average of 178 is what that
  // reached; the tool was manufacturing the condition it was retrying against.
  // Refusing costs the developer a message. Not refusing costs everyone.
  //
  // It also stops a second run reverting the same working tree underneath the
  // first, which no amount of restoring afterwards would put right. That is why
  // the claim sits ahead of the git commands rather than after them, and why it
  // is a create rather than a read: see claimRun.
  const claim = claimRun(repo, tests);
  if (!claim.ok) {
    const live = claim.live;
    const group = Number(live.group);
    const what = Number.isInteger(group) && group > 0
      ? `process group ${group} running ${live.tests}`
      : `red first pid ${live.pid} running ${live.tests}, with no suite under it yet`;
    return result('refused', 'a run of this tool is still live in this '
      + `repository: ${what}, started ${live.startedAt} by red first pid ${live.pid}. `
      + 'Starting now would add a second suite to this machine rather than '
      + `replace the first. End that run, or delete ${live.file} if it has `
      + 'already gone.');
  }

  const recordFile = claim.file;
  const claimed = claim.record;
  let recordWritten = !claim.unrecorded;

  // The process group this run started and has not yet watched end.
  //
  // A NUMBER rather than a child handle, because "what this run is responsible
  // for" is the question every exit path has to answer, and two of those paths
  // run where a handle is no use: the signal listeners, and the 'exit'
  // listener, which is reached after the event loop has stopped. A number can
  // be signalled from any of them.
  //
  // ONE of them, not a collection: the two suites are sequential and the ending
  // below clears this before the next spawn, so a second group never coexists
  // with the first. Nothing outside this number is ever signalled, which is the
  // whole of the scoping.
  let startedGroup = null;

  // Groups this run signalled and could not confirm gone.
  const survived = [];

  // What the reverted run would have to put back. Empty until the diff has been
  // read, which matters because the signal listener runs from the moment it is
  // registered, including during the git commands below.
  let sourceFiles = [];

  // The record the NEXT start reads, updated as the live group changes so that
  // what it names is what is actually running.
  const writeRunRecord = (group) => {
    if (claim.unrecorded) return;
    try {
      fs.writeFileSync(recordFile,
        JSON.stringify({ ...claimed, group: group || null }, null, 2) + '\n');
      recordWritten = true;
    } catch (e) {
      console.error('[red-first] could not update this run at '
        + `${recordFile} (${e.message}); a concurrent start will not be refused`);
    }
  };

  /**
   * Give the claim back, unless this run knows it left something behind.
   *
   * A GROUP THAT OUTLIVED SIGKILL IS THE ONE CASE WHERE THE RECORD MUST STAY.
   * That is the exact situation the refusal exists for, and removing the record
   * there would let the next start add a second suite on top of the one this
   * run has just failed to end. So the record is rewritten to name the survivor
   * and left in place; only a run that ended everything it started gives the
   * claim back.
   *
   * Only ever this run's own record. Reading it back before removing it costs
   * one syscall and means a record belonging to somebody else is left alone.
   */
  const releaseRun = () => {
    if (!recordWritten) return;
    const held = readRunRecord(recordFile);
    if (!held || Number(held.pid) !== process.pid) return;
    if (survived.length) {
      try {
        fs.writeFileSync(recordFile, JSON.stringify(
          { ...claimed, group: survived[0], survivedEnding: true }, null, 2) + '\n');
      } catch (e) { /* the next start reads whatever is there */ }
      return;
    }
    try { fs.rmSync(recordFile, { force: true }); } catch (e) { /* nothing left to clear */ }
    recordWritten = false;
  };

  const spawnRun = () => new Promise((resolve, reject) => {
    // NODE_TEST_CONTEXT must not reach the child. A nested `node --test` that
    // inherits it reports its failures and still exits 0, so a suite that
    // should be red comes back green: the one failure mode this tool cannot
    // afford, reachable whenever red-first is driven from inside a test.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;

    // detached puts the shell and everything it starts in their own process
    // group, so ending it means ending the group rather than one shell that
    // may have children of its own.
    const kid = spawn(tests, { cwd: repo, shell: true, env, detached: true,
      stdio: ['ignore', 'pipe', 'pipe'] });
    // The child heads its own group, so its pid IS the group id. Recorded here
    // rather than on any later event, because from this line on there is a
    // group on this machine that nothing else knows about, and every exit
    // between here and the next line has to be able to find it.
    if (kid.pid) {
      startedGroup = kid.pid;
      writeRunRecord(kid.pid);
    }
    let text = '';
    kid.stdout.on('data', (b) => { text += b.toString(); });
    kid.stderr.on('data', (b) => { text += b.toString(); });
    kid.on('error', (e) => { reject(e); });
    kid.on('close', (code) => {
      resolve({ ok: code === 0, pass: countFrom(text, 'pass'), fail: countFrom(text, 'fail'), names: namesFrom(text) });
    });
  });

  /**
   * End the group this run started, and forget it once it has gone.
   *
   * ONE definition of the ending, called after each run, from the signal
   * listeners and from the 'exit' listener, rather than three that can drift
   * apart. The previous version had the ending in the signal path only, which
   * is exactly why the other exits leaked.
   *
   * The ending itself is a parameter, because SIGKILL cannot be survived on
   * demand and this branch, which announces a survivor and holds on to the run
   * record because of it, has no other way to be reached by a test. What an
   * injected ending changes is whether the suite is really ended; what it
   * leaves alone is everything this function then does about it.
   *
   * THE ALARM FIRES ONLY ON A KNOWN SURVIVOR. 'unknown' means the group id
   * still answers and this machine would not say what is in it, which happens
   * where spawning `ps` is blocked. Warning then would fire on every ordinary
   * interrupt on Linux, where this process's own killed child stays listed
   * until this process exits, and an alarm that cries wolf on every Ctrl-C is
   * one nobody reads. The bound that buys: where no process table can be read,
   * a genuine survivor is not announced either.
   */
  const endStartedGroup = () => {
    if (startedGroup === null) return;
    const pgid = startedGroup;
    startedGroup = null;
    const outcome = groupEnder(pgid);
    if (outcome !== 'running') return;
    survived.push(pgid);
    // console.error rather than the injected log, which defaults to silence.
    // A group that outlived SIGKILL is the failure this whole file exists to
    // prevent, and it must not be able to happen quietly.
    console.error(`[red-first] WARNING: process group ${pgid} survived being `
      + 'ended and is still running; nothing further here can reach it, and '
      + 'the run record has been left in place naming it so the next start '
      + 'refuses rather than adding a second suite');
  };

  // The runner is injectable so a test can make the reverted run throw while
  // the first run passes, which is the only way to reach the restore by the
  // path a real failure would take. The first version of that test used a
  // command that always failed, so it never got past the first run and would
  // have passed with the restore deleted. An injected runner spawns nothing,
  // so it starts no group and there is nothing for the ending below to find.
  const run = runner
    ? async () => ({ ok: !!(await runner()), pass: null, fail: null, names: [] })
    : spawnRun;

  // Ended the moment a run is over rather than at the end of the tool.
  //
  // A run being over means the direct child has closed, which does NOT mean the
  // group is empty: a package runner starts children that outlive it, and those
  // are what was still on the machine after a check had printed its conclusion.
  // Ending the group here also means the reverted run does not share the
  // machine with whatever the first run left, which is half of what made the
  // measured load compound.
  const runAndEnd = async () => {
    try { return await run(); } finally { endStartedGroup(); }
  };

  // EVERY way this process can end, wired before any work at all.
  //
  // The signal listeners used to go on after the first run, once the reverted
  // run was about to begin. That left the first full suite, which is the
  // longest window the tool has, with no handler at all: Node's default
  // handling for a terminating signal ends the process without unwinding, so
  // the detached group created moments earlier was simply abandoned. Measured
  // rather than deduced. A signal sent during the first run left both the
  // runner and its child alive and reparented to init.
  //
  // WHICH PATH IS RESPONSIBLE FOR WHAT, stated once here and nowhere else. The
  // `finally` below ends the group on an ordinary return and on an error out of
  // the body. The signal listeners cover SIGINT, SIGTERM and SIGHUP. The 'exit'
  // listener covers only an exit that never unwinds the `await`, where
  // something else in the process stops while a suite is in flight and no
  // `finally` of this tool's ever runs; taking that listener away leaves `an
  // exit taken while a suite is running` red and every other test green, which
  // is the measurement that says what it is for. Listeners there may only do
  // synchronous work, which is why the ending blocks rather than awaits.
  //
  // WHAT NONE OF THIS COVERS, stated because the refusal above is built on it:
  // SIGKILL of this process, which the kernel delivers to nothing. A group
  // started by a run ended that way outlives it, and what stops the next start
  // piling a second suite on top is the refusal, not this.
  const onExit = () => { endStartedGroup(); releaseRun(); };
  const onSignal = () => {
    // End the suite FIRST. The restore is pointless while a test command is
    // still writing to the tree, and a child that ignores signals would
    // otherwise outlive this process and keep working against reverted source.
    endStartedGroup();
    try { restoreTo(repo, 'HEAD', sourceFiles); } catch (e) { /* exiting anyway */ }
    releaseRun();
    process.exit(130);
  };
  const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  process.on('exit', onExit);
  for (const signal of SIGNALS) process.on(signal, onSignal);

  try {
    // A dirty tree is refused, not tidied. This rewrites tracked files and puts
    // them back, so it must never run where it cannot tell its own edits from
    // someone else's.
    if (git(repo, ['status', '--porcelain'])) {
      return result('refused', 'the working tree has uncommitted changes, and this '
        + 'rewrites tracked files; commit or stash first');
    }

    const resolved = resolveBase(repo, base);
    if (!resolved.ok) return result('refused', resolved.reason);
    baseRef = resolved.ref;
    // Printed, not merely returned. The incident this guards against was
    // readable only from a file count inside the record, and a run whose base
    // is not on screen cannot be checked by the person reading the verdict.
    log(`measuring against ${baseRef}`);

    const mergeBase = git(repo, ['merge-base', baseRef, 'HEAD']);
    // --no-renames, and it is not a detail. With rename detection on, a renamed
    // file is reported once, under its NEW path. restoreTo then asks whether
    // that path exists at the base, finds it does not, and deletes it. The
    // reverted run fails with a module-not-found for an unrelated reason, and
    // the tool reports "proven" for tests that discriminate nothing: the one
    // error direction it must never take. Forced off here rather than trusted
    // to the developer's diff.renames config.
    const changed = git(repo, ['diff', '--no-renames', '--name-only', mergeBase, 'HEAD'])
      .split('\n').filter(Boolean);
    const testFiles = changed.filter(isTest);
    sourceFiles = changed.filter(f => !isTest(f));

    if (!changed.length) return result('not-provable', `nothing changed against ${baseRef}`);

    // A REVERT THAT REACHES PAST THE FORK POINT IS REFUSED, NOT ANNOTATED.
    //
    // Everything below this line reads a verdict off a suite that was run
    // against a reverted tree, and a tree reverted further back than this
    // branch starts is somebody else's tree as much as it is this one's. The
    // tests that then go red can be theirs, and no outcome computed from them
    // says anything about this change. That is not a caveat to attach to a
    // PROVEN; it is a reason there is nothing to report.
    //
    // Refused whether or not extra files are involved. The same files taken
    // back further than the fork point carry the earlier work's content too, so
    // a check made on the file list alone would let exactly that case through.
    // The list is still named, because the mismatch it describes was present in
    // the incident, as a file count, and unread.
    const fork = forkPoint(repo, baseRef);
    if (fork && fork.sha !== mergeBase) {
      const own = new Set(git(repo, ['diff', '--no-renames', '--name-only', fork.sha, 'HEAD'])
        .split('\n').filter(Boolean));
      const beyond = changed.filter(f => !own.has(f));
      const extra = git(repo, ['rev-list', '--count', `${mergeBase}..${fork.sha}`]);
      return result('refused', `${baseRef} sits ${extra} commits before the point this `
        + 'branch was cut from, so reverting against it takes away work that had already '
        + "merged and can report that work's tests as proof of this change. Reverted but "
        + `not part of this change (${beyond.length}): ${beyond.slice(0, 10).join(', ') || 'none'}. `
        + `Measure against ${fork.ref}, which is where this branch actually starts, or `
        + 'leave --base off and it is chosen for you.',
      { source: sourceFiles, tests: testFiles });
    }

    if (!testFiles.length) {
      return result('not-provable', 'the change adds no tests, so there is nothing '
        + 'to prove; that is its own finding', { source: sourceFiles, tests: [] });
    }
    if (!sourceFiles.length) {
      return result('not-provable', 'the change touches no source, so there is '
        + 'nothing to take away', { source: [], tests: testFiles });
    }

    // WITH the change first. A suite failing for its own reasons makes a
    // failure without the change meaningless, and reporting that as proof would
    // turn a broken suite into evidence.
    log('running the tests with the change');
    const withChange = await runAndEnd();
    const passedWithChange = withChange.ok;
    if (!passedWithChange) {
      return result('inconclusive', 'the tests do not pass with the change in '
        + 'place, so a failure without it proves nothing',
      { passedWithChange: false, source: sourceFiles, tests: testFiles });
    }

    log('restoring the source, keeping the tests');
    let failedWithoutChange = null;
    let withoutChange = { ok: null, pass: null, fail: null, names: [] };

    try {
      restoreTo(repo, mergeBase, sourceFiles);
      withoutChange = await runAndEnd();
      failedWithoutChange = !withoutChange.ok;
    } finally {
      // Unconditional. A tool that can leave a repository half-reverted is
      // worse than no tool, because the next person debugs a tree nobody put
      // there on purpose.
      restoreTo(repo, 'HEAD', sourceFiles);
    }

    const counts = {
      testsPassedWithChange: withChange.pass,
      testsFailedWithoutChange: withoutChange.fail,
      namesFailedWithoutChange: withoutChange.names || [],
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
  } finally {
    // Ending comes first here, so a throw from anything after it cannot leave a
    // suite behind. This runs on every return above and on any error out of
    // them, which is what makes the ordinary exits as covered as the signals.
    endStartedGroup();
    releaseRun();
    process.off('exit', onExit);
    for (const signal of SIGNALS) process.off(signal, onSignal);
  }
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
  const file = path.join(repo, '.precommit-gate.json');
  if (!fs.existsSync(file)) return false;
  let record;
  try { record = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return false; }
  const tree = git(repo, ['write-tree']);
  if (record.tree !== tree) return false;
  record.redFirst = {
    outcome: outcome.outcome,
    reason: outcome.reason,
    // What it was measured against. A verdict without its base cannot be
    // checked at all: the record that carried the false PROVEN named counts and
    // test names, and every one of them was true of a different branch's work.
    base: outcome.base,
    // AC-6 names test counts. File counts are a different quantity and were
    // written here first, which is the proxy-for-the-property fault this whole
    // check exists to catch, committed inside the check itself.
    testsPassedWithChange: outcome.testsPassedWithChange,
    testsFailedWithoutChange: outcome.testsFailedWithoutChange,
    // The names, capped, with the count above carrying the whole quantity.
    namesFailedWithoutChange: (outcome.namesFailedWithoutChange || []).slice(0, NAME_LIMIT),
    namesTruncated: (outcome.namesFailedWithoutChange || []).length > NAME_LIMIT,
    sourceFiles: outcome.source.length,
    testFiles: outcome.tests.length,
    limitation: outcome.limitation,
  };
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
  return true;
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? fallback : argv[i + 1];
  };
  const repo = path.resolve(arg('repo', process.cwd()));
  const outcome = await redFirst({
    repo,
    // No literal default. Left off, the base is worked out from the refs that
    // cannot have drifted behind this branch's fork point, which is what a
    // worktree needs and what a branch name cannot promise.
    base: arg('base', null),
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

if (require.main === module) {
  main().then((code) => process.exit(code), (err) => {
    console.error(`[red-first] ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  });
}

module.exports = { redFirst, recordOutcome, restoreTo, isTest, namesFrom, runRecordPath, groupRunning, TEST_DIRS, TEST_FILENAME_MARKERS, NAME_LIMIT, LIMITATION };
