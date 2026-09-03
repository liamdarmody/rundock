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

const { execFileSync, spawn, spawnSync } = require('node:child_process');
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

// How long a process group started here gets to end on its own before it is
// ended outright. Short on purpose. The politeness is worth something, since a
// test runner given the chance will close its reporters and flush its output,
// but the group being waited on is only ever one this run started, and nothing
// this tool spawns has a restore step to skip. The cost of waiting longer is
// paid by a developer watching the tool refuse to exit.
const END_GRACE_MS = 500;

// How often the cheap question below is asked, and how rarely the expensive one
// is. See psGroupMembers for why the second needs a rein on it.
const POLL_MS = 25;
const TABLE_POLL_MS = 150;

// A pause that blocks rather than yields.
//
// It has to block, because the last place the ending below runs is an 'exit'
// listener. By then the event loop has finished and a timer would never fire,
// so anything asynchronous there is the same as no wait at all.
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Does this target still exist?
 *
 * A NEGATIVE number asks about a whole process group, a positive one about a
 * single process; the rule is the same for both, which is why there is one
 * function. Signal 0 asks the kernel without sending anything, and EPERM is a
 * yes: the target is there and this process may not signal it, which is a
 * different answer from the target being gone.
 *
 * EXISTING IS NOT THE SAME AS RUNNING, and the difference is the whole of the
 * defect below this line. See groupRunning.
 */
function exists(target) {
  try { process.kill(target, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// The process state that means "already exited, still listed". A process whose
// parent has not collected it keeps its entry in the table, and its process
// group with it. Every other state is a process that is still on the machine.
const EXITED_STATE = 'Z';

/**
 * The members of a process group, as {pid, state}, or null if this machine will
 * not say.
 *
 * Spawning is allowed here even from a signal or 'exit' listener because it is
 * synchronous, which is also why it is asked only when the cheap question above
 * has already answered "something is there", and then no more often than
 * TABLE_POLL_MS.
 *
 * THE WHOLE TABLE IS LISTED AND FILTERED HERE, which is the expensive way to do
 * it, and it is chosen because the cheap way is not portable: the flag that
 * selects a process group is `-g` on BSD and means a session or group NAME on
 * Linux's procps, so the same invocation silently selects by something else
 * depending on the machine. Selecting by the wrong thing would answer the wrong
 * question, and this question decides whether a suite is killed. The cost is
 * held down by the two rules above rather than by a flag that cannot be trusted
 * across platforms: on an ordinary ending this runs once, and never more than
 * four times, against a grace of half a second.
 */
function psGroupMembers(pgid) {
  const out = spawnSync('ps', ['-e', '-o', 'pgid=,pid=,stat='],
    { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] });
  if (out.error || typeof out.stdout !== 'string') return null;
  if (out.status !== 0 && !out.stdout.trim()) return null;
  const members = [];
  for (const line of out.stdout.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    if (Number(parts[0]) !== pgid) continue;
    members.push({ pid: Number(parts[1]), state: parts[2] });
  }
  return members;
}

/**
 * Is anything in this process group still RUNNING, as opposed to merely listed?
 *
 * @returns {boolean|null} true running, false gone, null this machine will not say
 *
 * THE DISTINCTION IS THE DEFECT. When this process signals its own direct child
 * and then waits, the child dies at once but stays in the table until this
 * process collects it, which it cannot do while the event loop is blocked in
 * the wait. That corpse is still a member of its process group, so asking the
 * kernel whether the group exists keeps answering yes for the entire grace, the
 * group is then SIGKILLed for no reason, the ending reports that it survived,
 * and an alarm meant for a genuine leak fires on every interrupt.
 *
 * MEASURED ON BOTH PLATFORMS, and the same on both: macOS and Linux each report
 * a group whose only member is an exited entry as existing. An earlier version
 * of this file said macOS filtered such members out; it does not, and the
 * evidence file records the measurement that corrected it.
 *
 * So the group is asked about by its members and their states, and a group
 * whose remaining members have all exited is gone.
 *
 * The reader is a parameter so the decision can be driven on any machine,
 * including one whose sandbox blocks spawning, rather than only where corpses
 * happen to appear.
 */
function groupRunning(pgid, readMembers = psGroupMembers) {
  // Cheap first, and it is the only question asked once the group is really
  // gone, which is the common case at the end of a run.
  if (!exists(-pgid)) return false;
  const members = readMembers(pgid);
  if (members === null) return null;
  return members.some(m => !String(m.state).startsWith(EXITED_STATE));
}

/**
 * End one process group, and say what became of it.
 *
 * @returns {'gone'|'running'|'unknown'}
 *
 * A NEGATIVE pid signals the whole group, which is the point rather than a
 * detail. The test command is spawned detached, so it heads its own group, and
 * a package runner starts children inside that group; ending the direct child
 * alone leaves those children running, which is how a check that had already
 * printed its conclusion kept a full suite on the machine.
 *
 * Ending a group BY NUMBER is also what keeps the remedy from becoming the next
 * defect. The obvious way to clear leftovers is to match command lines across
 * the machine and kill what matches, and that reaches processes this tool never
 * started: a suite in another checkout, or a mutation harness partway through
 * rewriting a file it restores in a `finally` that a killed process never runs.
 * A group id names processes by where they came from rather than by what they
 * look like, so nothing outside this run can be caught by it however similar it
 * looks.
 *
 * SIGTERM first and SIGKILL after the grace, because a child that ignores
 * SIGTERM is the only case where anything but the escalation keeps a suite from
 * outliving this process, and the criterion it answers to is unconditional.
 *
 * The reader is a parameter so that the answer this cannot get, and what it
 * does when it cannot get one, are drivable by a test on a machine where `ps`
 * works.
 */
function endGroup(pgid, readMembers = psGroupMembers) {
  // Throttled so the expensive read cannot be made on every turn of the loop.
  let nextTable = 0;
  const state = () => {
    if (!exists(-pgid)) return false;
    if (Date.now() < nextTable) return true;
    nextTable = Date.now() + TABLE_POLL_MS;
    const members = readMembers(pgid);
    if (members === null) return null;
    return members.some(m => !String(m.state).startsWith(EXITED_STATE));
  };

  if (state() === false) return 'gone';
  try { process.kill(-pgid, 'SIGTERM'); } catch (e) { /* gone since the check */ }
  const deadline = Date.now() + END_GRACE_MS;
  while (Date.now() < deadline) {
    if (state() === false) return 'gone';
    pause(POLL_MS);
  }
  try { process.kill(-pgid, 'SIGKILL'); } catch (e) { /* gone since the check */ }
  pause(POLL_MS);
  nextTable = 0;
  const after = state();
  if (after === false) return 'gone';
  return after === null ? 'unknown' : 'running';
}

/**
 * Where a run in progress is recorded, so the next start can see it.
 *
 * OUTSIDE the repository, unlike the gate record this file also writes. That
 * record describes a TREE and belongs beside the tree it describes; this one
 * describes PROCESSES on one machine, and means nothing in another checkout of
 * the same commit. Keeping it out of the working tree also keeps it clear of
 * the cleanliness check this tool makes of the repository it is pointed at.
 *
 * Keyed by the repository's CANONICAL path. path.resolve alone does not follow
 * symbolic links, and on macOS the same checkout reached through /tmp and
 * through /private/tmp resolves to two different strings, so two runs against
 * one working tree would hold two records, neither refusing the other, and both
 * would revert it. realpath is what makes the two spellings one identity.
 */
function canonicalRepo(repo) {
  const resolved = path.resolve(repo);
  try { return fs.realpathSync(resolved); } catch (e) { return resolved; }
}

function runRecordPath(repo) {
  const key = crypto.createHash('sha256').update(canonicalRepo(repo)).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), `red-first-run-${key}.json`);
}

// ONE definition of what a record looks like on disk, used by every writer, so
// the shape cannot drift between the claim, the updates and the survivor
// rewrite.
function serialiseRecord(record) {
  return JSON.stringify(record, null, 2) + '\n';
}

/**
 * Put a complete record at `file`, atomically.
 *
 * WRITTEN ASIDE AND THEN MOVED INTO PLACE, because an exclusive create is
 * atomic but the write that follows it is not: a contender whose own create
 * fails EEXIST in that gap reads an empty file, judges the record unreadable,
 * and is one step from deciding it is stale. Both runs then revert the same
 * tree, which is the direction the refusal exists to prevent.
 *
 * `link` publishes a claim: it fails EEXIST if anyone already holds the name,
 * and the contents are whole before the name exists. `rename` publishes an
 * update over a name this run already owns.
 *
 * @returns {boolean} false only when the exclusive claim was already held
 */
function publishRecord(file, record, { exclusive = false } = {}) {
  const scratch = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
  fs.writeFileSync(scratch, serialiseRecord(record));
  try {
    if (exclusive) fs.linkSync(scratch, file);
    else fs.renameSync(scratch, file);
    return true;
  } catch (e) {
    if (exclusive && e.code === 'EEXIST') return false;
    throw e;
  } finally {
    if (exclusive) { try { fs.unlinkSync(scratch); } catch (e2) { /* already moved */ } }
  }
}

function readRunRecord(file) {
  try {
    const held = JSON.parse(fs.readFileSync(file, 'utf8'));
    return held && typeof held === 'object' ? held : null;
  } catch (e) { return null; }
}

/**
 * Which part of the run this record describes is still going, if any?
 *
 * BOTH HALVES ARE ASKED ABOUT, and the group is the one the criterion is
 * actually worded around. Between the two suites there are moments when the
 * tool is alive with nothing under it; after an ending nothing can catch there
 * are moments when a suite is alive with no tool over it, and that second case
 * is a suite from a PREVIOUS run, which is exactly what a start now must not
 * add to.
 *
 * A group whose members have all exited is not a live run: see groupRunning. A
 * group this machine will not describe is treated as live, which is the safe
 * direction, since refusing costs a message and proceeding costs a second
 * suite.
 *
 * WHICH HALF ANSWERED IS RETURNED, not just whether one did, because the
 * refusal has to describe what is running. Wording it from whether the record
 * carries a group id instead told a reader that a process group was running in
 * the gap after that group had ended, next to advice to delete the record if it
 * had already gone.
 *
 * @returns {'pid'|'group'|null}
 *
 * THE BOUND, since this is a judgement about numbers. A pid or a group id whose
 * owner has gone can in principle be reused by something unrelated, and this
 * would then report a live run that is not one. The consequence is a refusal
 * that should not have happened, which costs a developer one message naming a
 * file to delete; the consequence of the other error direction is another full
 * suite on a machine that already has one.
 */
function liveRunKind(held) {
  // The GROUP is asked about first, because it is the more specific answer and
  // the one worth telling a reader. Asking about the pid first reported "no
  // suite under it yet" for a run that had a suite under it, since a live tool
  // always answers before its live group gets a chance to.
  const group = Number(held.group);
  if (Number.isInteger(group) && group > 0 && groupRunning(group) !== false) return 'group';
  const pid = Number(held.pid);
  if (Number.isInteger(pid) && pid > 0 && exists(pid)) return 'pid';
  return null;
}

// How long an unreadable record is given to become readable before this run
// gives up on it. A record is written aside and moved into place, so an
// unreadable one is a damaged file rather than a half-written one; this is the
// margin for a file system that reports otherwise.
const RECORD_SETTLE_MS = 200;

/**
 * Take ownership of this repository for the length of this run, or report the
 * run that already holds it.
 *
 * CLAIMED BEFORE ANY OTHER WORK, and by publishing a whole record under a name
 * nobody else holds, rather than by reading and then writing. The first version
 * read the record at the top of the run and did not write one until after three
 * git commands had finished, so two starts a few milliseconds apart both saw an
 * empty machine, both proceeded, and both reverted the same working tree,
 * checking files out from under each other. That is the case the refusal exists
 * to prevent, and the check meant to prevent it had a window in the middle.
 *
 * On EEXIST the holder is read and judged. A live run wins and this start is
 * refused. A record whose run has gone is stale: it is renamed aside rather
 * than deleted, so that only one of several contenders retires it, and the
 * claim is tried again. A stale file that refused every start until somebody
 * deleted it by hand would be its own outage, which is the thing this branch
 * exists to prevent and the reason it is worth having a test.
 *
 * A record that cannot be read is NOT treated as stale. It is re-read for a
 * short window, and if it stays unreadable this start is refused and the file
 * is named, because deleting a record this run cannot understand is how it
 * would end up running beside whoever wrote it.
 */
function claimRun(repo, tests) {
  const file = runRecordPath(repo);
  const record = {
    pid: process.pid, group: null, tests,
    repo: canonicalRepo(repo), startedAt: new Date().toISOString(),
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let published;
    try {
      published = publishRecord(file, record, { exclusive: true });
    } catch (e) {
      // Loud, because the refusal is only as good as this write. A run that
      // cannot record itself still works; the next one just will not be
      // refused, and whoever retries should know that before they do.
      console.error('[red-first] could not record this run at '
        + `${file} (${e.message}); a concurrent start will not be refused`);
      return { ok: true, file, record, unrecorded: true };
    }
    if (published) return { ok: true, file, record };

    const deadline = Date.now() + RECORD_SETTLE_MS;
    let held = readRunRecord(file);
    while (held === null && Date.now() < deadline) {
      if (!fs.existsSync(file)) break; // retired by whoever held it; try again
      pause(POLL_MS);
      held = readRunRecord(file);
    }
    if (held === null) {
      if (!fs.existsSync(file)) continue;
      return { ok: false, file, unclaimable: true };
    }
    const liveBy = liveRunKind(held);
    if (liveBy) return { ok: false, file, live: { ...held, file, liveBy } };
    // Stale. Renamed aside rather than unlinked, so that two contenders who
    // both judged it stale do not both clear the way for a third.
    try { fs.renameSync(file, `${file}.stale.${process.pid}`); } catch (e) { /* someone got there first */ }
    try { fs.unlinkSync(`${file}.stale.${process.pid}`); } catch (e) { /* already gone */ }
  }
  return { ok: false, file, unclaimable: true };
}

/**
 * @returns {{outcome: 'proven'|'not-discriminating'|'inconclusive'|'not-provable'|'refused',
 *            reason: string, passedWithChange: boolean|null,
 *            failedWithoutChange: boolean|null, testsPassedWithChange: number|null,
 *            testsFailedWithoutChange: number|null, namesFailedWithoutChange: string[],
 *            source: string[], tests: string[], limitation: string}}
 */
async function redFirst({ repo, base = 'main', tests, log = () => {}, runner = null,
  groupEnder = endGroup }) {
  const result = (outcome, reason, extra = {}) => ({
    outcome, reason, passedWithChange: null, failedWithoutChange: null,
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
    if (claim.unclaimable) {
      return result('refused', 'could not take the run record for this '
        + `repository at ${claim.file}: it could not be read, or another start `
        + 'held it each time this one tried. It is left where it is rather than '
        + 'deleted, because a record this run cannot understand may belong to a '
        + 'run that is still going. Inspect it, and remove it if nothing is '
        + 'running.');
    }
    const live = claim.live;
    // Worded from what was found LIVE, not from what the record happens to
    // carry: a record can name a group that has since ended while its tool is
    // still going, and saying that group is running sends the reader looking
    // for a process that is not there.
    const what = live.liveBy === 'group'
      ? `process group ${live.group} running ${live.tests}`
      : `red first pid ${live.pid} running ${live.tests}, with no suite under it yet`;
    return result('refused', 'a run of this tool is still live in this '
      + `repository: ${what}, started ${live.startedAt} by red first pid ${live.pid}. `
      + 'Starting now would add a second suite to this machine rather than '
      + `replace the first. End that run, or delete ${live.file} if it has `
      + 'already gone.');
  }

  const recordFile = claim.file;
  const claimed = claim.record;
  // ONE flag for "this run holds a record on disk". A run that could not write
  // one holds nothing and releases nothing.
  let holdsRecord = !claim.unrecorded;

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

  /**
   * Put the record back on disk naming `group`, or nothing if no suite is under
   * this run just now.
   *
   * WRITTEN AT THE SPAWN, and not again when the group ends. A record may
   * therefore name a group that has since finished, and that is harmless
   * because the refusal describes what liveRunKind found alive rather than what
   * the record carries: a finished group is reported as the live tool with no
   * suite under it. Writing the record back on every ending would be a change
   * no reader and no test could observe.
   */
  const writeRunRecord = (group) => {
    if (!holdsRecord) return;
    try {
      publishRecord(recordFile, { ...claimed, group: group || null,
        ...(survived.length ? { survivedEnding: true, group: survived[0] } : {}) });
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
   * run has just failed to end. So the record is left in place naming the
   * survivor; only a run that ended everything it started gives the claim back.
   *
   * Only ever this run's own record. Reading it back before removing it costs
   * one syscall and means a record belonging to somebody else is left alone.
   */
  const releaseRun = () => {
    if (!holdsRecord) return;
    const held = readRunRecord(recordFile);
    if (!held || Number(held.pid) !== process.pid) return;
    if (survived.length) { writeRunRecord(survived[0]); return; }
    try { fs.rmSync(recordFile, { force: true }); } catch (e) { /* nothing left to clear */ }
    holdsRecord = false;
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
    const outcome = groupEnder(pgid);
    startedGroup = null;
    if (outcome !== 'running') return;
    survived.push(pgid);
    writeRunRecord(pgid);
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

    const mergeBase = git(repo, ['merge-base', base, 'HEAD']);
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

    if (!changed.length) return result('not-provable', `nothing changed against ${base}`);
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

    // A SURVIVOR ENDS THIS RUN HERE. Restoring the source and spawning the
    // reverted suite now would put a second suite on the machine on top of the
    // one this run has just failed to end, which is the compounding load the
    // whole change exists to prevent, produced by the tool itself.
    if (survived.length) {
      return result('inconclusive', 'the first suite could not be confirmed '
        + `ended (process group ${survived[0]} is still running), so this run `
        + 'stops rather than starting a second suite beside it; the run record '
        + 'is left naming that group',
      { passedWithChange: true, source: sourceFiles, tests: testFiles });
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
    // The ending is NOT repeated here. runAndEnd ends the group in a `finally`
    // of its own, which runs on every return out of the body and on every throw
    // through it, so by this point there is never a group left to find; a call
    // here would be a branch no test could reach, and removing it would redden
    // nothing. What does belong here is giving the claim back, which every exit
    // that unwinds must do.
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

if (require.main === module) {
  main().then((code) => process.exit(code), (err) => {
    console.error(`[red-first] ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  });
}

module.exports = { redFirst, recordOutcome, restoreTo, isTest, namesFrom, runRecordPath, groupRunning, endGroup, TEST_DIRS, TEST_FILENAME_MARKERS, NAME_LIMIT, LIMITATION };
