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
 * detached and therefore heads its own process group; that group is ended when
 * its run finishes, when a terminating signal arrives, and again from an 'exit'
 * listener that catches the ordinary return and the uncaught throw alike. Only
 * groups this run started are ever signalled, so a suite or a mutation harness
 * belonging to somebody else is never touched however alike the command lines
 * look.
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

// A pause that blocks rather than yields.
//
// It has to block, because the last place the ending below runs is an 'exit'
// listener. By then the event loop has finished and a timer would never fire,
// so anything asynchronous there is the same as no wait at all.
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Is any process still in this group?
//
// Signal 0 asks the kernel whether the target exists without sending anything.
// EPERM is a yes: the group is there and this process may not signal it, which
// is a different answer from the group being gone.
//
// The reason this is safe to ask about a NUMBER rather than a live handle: a
// process group id is not reused while the group still has a member. A group
// this run created and has not yet watched empty is therefore still this run's
// group, not a stranger that inherited its number.
function groupAlive(pgid) {
  try { process.kill(-pgid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/**
 * End one process group, and say whether it is gone.
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
 * @returns {boolean} whether the group is gone afterwards
 */
function endGroup(pgid, graceMs = END_GRACE_MS) {
  if (!groupAlive(pgid)) return true;
  try { process.kill(-pgid, 'SIGTERM'); } catch (e) { /* gone since the check */ }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && groupAlive(pgid)) pause(25);
  if (!groupAlive(pgid)) return true;
  try { process.kill(-pgid, 'SIGKILL'); } catch (e) { /* gone since the check */ }
  pause(25);
  return !groupAlive(pgid);
}

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

/**
 * A run of this tool that is still going in this repository, or null.
 *
 * Both halves are asked about, because between the two suites there are moments
 * when the tool is alive with nothing under it. Either half being alive means
 * starting now would put a second suite on this machine, or a second reverter
 * on the same working tree.
 *
 * A record whose run has gone is stale and says nothing. That happens after a
 * reboot, or after an ending nothing can catch, and it is overwritten rather
 * than treated as a refusal: a stale file that refuses every start until
 * somebody deletes it is its own outage.
 *
 * THE BOUND, since this is a check made on numbers. A pid or a group id whose
 * owner has gone can in principle be reused by something unrelated, and this
 * would then report a live run that is not one. The consequence is a refusal
 * that should not have happened, which costs a developer one message naming a
 * file to delete; the consequence of the other error direction is another full
 * suite on a machine that already has one. The window is kept small by clearing
 * the record on every exit this process can see, so a record only survives an
 * ending that skipped all of them.
 */
function liveRun(repo) {
  const file = runRecordPath(repo);
  let record;
  try { record = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
  if (!record || typeof record !== 'object') return null;
  const group = Number(record.group);
  const pid = Number(record.pid);
  const groupLive = Number.isInteger(group) && group > 0 && groupAlive(group);
  const pidLive = Number.isInteger(pid) && pid > 0 && processAlive(pid);
  if (!groupLive && !pidLive) return null;
  return { ...record, file, groupLive, pidLive };
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/**
 * @returns {{outcome: 'proven'|'not-discriminating'|'inconclusive'|'not-provable'|'refused',
 *            reason: string, passedWithChange: boolean|null,
 *            failedWithoutChange: boolean|null, testsPassedWithChange: number|null,
 *            testsFailedWithoutChange: number|null, namesFailedWithoutChange: string[],
 *            source: string[], tests: string[], limitation: string}}
 */
async function redFirst({ repo, base = 'main', tests, log = () => {}, runner = null }) {
  const result = (outcome, reason, extra = {}) => ({
    outcome, reason, passedWithChange: null, failedWithoutChange: null,
    testsPassedWithChange: null, testsFailedWithoutChange: null, namesFailedWithoutChange: [],
    source: [], tests: [], limitation: LIMITATION, ...extra,
  });

  // Asked before anything else, because the cost of getting this wrong is paid
  // by every process on the machine rather than by this one.
  //
  // A check that comes back inconclusive invites a retry, and a retry used to
  // mean another full suite on top of the one still running from the attempt
  // before. Three concurrent suites and a load average of 178 is what that
  // reached; the tool was manufacturing the condition it was retrying against.
  // Refusing costs the developer a message. Not refusing costs everyone.
  //
  // It also stops a second run reverting the same working tree underneath the
  // first, which no amount of restoring afterwards would put right.
  const live = liveRun(repo);
  if (live) {
    const what = live.groupLive
      ? `process group ${live.group} running ${live.tests}`
      : `red first pid ${live.pid} running ${live.tests}, with no suite under it yet`;
    return result('refused', 'a run of this tool is still live in this '
      + `repository: ${what}, started ${live.startedAt} by red first pid ${live.pid}. `
      + 'Starting now would add a second suite to this machine rather than '
      + `replace the first. End that run, or delete ${live.file} if it has `
      + 'already gone.');
  }

  // A dirty tree is refused, not tidied. This rewrites tracked files and puts
  // them back, so it must never run where it cannot tell its own edits from
  // someone else's.
  if (git(repo, ['status', '--porcelain'])) {
    return result('refused', 'the working tree has uncommitted changes, and this '
      + 'rewrites tracked files; commit or stash first');
  }

  const mergeBase = git(repo, ['merge-base', base, 'HEAD']);
  // --no-renames, and it is not a detail. With rename detection on, a renamed
  // file is reported once, under its NEW path. restoreTo then asks whether that
  // path exists at the base, finds it does not, and deletes it. The reverted
  // run fails with a module-not-found for an unrelated reason, and the tool
  // reports "proven" for tests that discriminate nothing: the one error
  // direction it must never take. Forced off here rather than trusted to the
  // developer's diff.renames config.
  const changed = git(repo, ['diff', '--no-renames', '--name-only', mergeBase, 'HEAD'])
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

  // The process groups this run has started and not yet watched end.
  //
  // A SET of group ids rather than one child handle, because "what this run is
  // responsible for" is the question every exit path has to answer, and two of
  // those paths run where a handle is no use: the signal listeners, and the
  // 'exit' listener, which is reached after the event loop has stopped. A
  // number can be signalled from any of them.
  //
  // Nothing outside this set is ever signalled. That is the whole of the
  // scoping: a group id names processes by the run that created them.
  const startedGroups = new Set();

  const recordFile = runRecordPath(repo);
  const startedAt = new Date().toISOString();
  let recordWritten = false;

  // The record the NEXT start reads. Written when this run commits to spawning
  // and rewritten whenever the live group changes, so what it names is what is
  // actually running rather than what was running when the tool began.
  const writeRunRecord = (group) => {
    try {
      fs.writeFileSync(recordFile, JSON.stringify({
        pid: process.pid, group: group || null, tests, repo: path.resolve(repo), startedAt,
      }, null, 2) + '\n');
      recordWritten = true;
    } catch (e) {
      // Loud, because the refusal above is only as good as this write. A run
      // that cannot record itself still works; the next one just will not be
      // refused, and the developer should know that before they retry.
      console.error('[red-first] could not record this run at '
        + `${recordFile} (${e.message}); a concurrent start will not be refused`);
    }
  };

  const clearRunRecord = () => {
    if (!recordWritten) return;
    // Only ever this run's own record. Reading it back before removing it costs
    // one syscall and means a record written by somebody else, in the window
    // where two starts raced past the refusal, is left for its owner.
    try {
      const held = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
      if (Number(held && held.pid) !== process.pid) return;
    } catch (e) { return; }
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
      startedGroups.add(kid.pid);
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
   * End every group this run started, and forget each one once it has gone.
   *
   * ONE definition of the ending, called from after each run, from the signal
   * listeners and from the 'exit' listener, rather than three that can drift
   * apart. The previous version had the ending in the signal path only, which
   * is exactly why the other exits leaked.
   */
  const endStartedGroups = () => {
    const survived = [];
    for (const pgid of [...startedGroups]) {
      if (!endGroup(pgid)) survived.push(pgid);
      startedGroups.delete(pgid);
    }
    if (survived.length) {
      // console.error rather than the injected log, which defaults to silence.
      // A group that outlived SIGKILL is the failure this whole file exists to
      // prevent, and it must not be able to happen quietly.
      console.error('[red-first] WARNING: process group(s) '
        + `${survived.join(', ')} survived being ended and may still be running; `
        + 'nothing further here can reach them');
    }
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

  // Reaped the moment a run is over rather than at the end of the tool.
  //
  // A run being over means the direct child has closed, which does NOT mean the
  // group is empty: a package runner starts children that outlive it, and those
  // are what was still on the machine after a check had printed its conclusion.
  // Ending the group here also means the reverted run does not share the
  // machine with whatever the first run left, which is half of what made the
  // measured load compound.
  const runAndEnd = async () => {
    try { return await run(); } finally { endStartedGroups(); }
  };

  // EVERY way this process can end, wired before the first suite starts.
  //
  // The signal listeners used to go on after the first run, once the reverted
  // run was about to begin. That left the first full suite, which is the
  // longest window the tool has, with no handler at all: Node's default
  // handling for a terminating signal ends the process without unwinding, so
  // the detached group created moments earlier was simply abandoned. Measured
  // rather than deduced. A signal sent during the first run left both the
  // runner and its child alive and reparented to init.
  //
  // The ordinary return and the error out of this function are covered by the
  // `finally` at the bottom, which ends the groups before anything else it
  // does. Both used to leak because the ending lived in the signal path alone
  // and neither of them goes through it.
  //
  // 'exit' is the backstop behind that, and what it covers is narrower than it
  // looks: the exit that does not unwind at all, where something else in the
  // process stops while a suite is in flight and no `finally` of this tool's
  // ever runs. Taking this listener away leaves `an exit taken while a suite is
  // running` red and every other test green, which is the measurement that says
  // what it is for. Listeners here may only do synchronous work, which is why
  // the ending blocks rather than awaits.
  //
  // WHAT NONE OF THIS COVERS, stated because the refusal above is built on it:
  // SIGKILL of this process, which the kernel delivers to nothing. A group
  // started by a run ended that way outlives it, and what stops the next start
  // piling a second suite on top is the refusal, not this.
  const onExit = () => { endStartedGroups(); clearRunRecord(); };
  const onSignal = () => {
    // End the suite FIRST. The restore is pointless while a test command is
    // still writing to the tree, and a child that ignores signals would
    // otherwise outlive this process and keep working against reverted source.
    endStartedGroups();
    try { restoreTo(repo, 'HEAD', sourceFiles); } catch (e) { /* exiting anyway */ }
    clearRunRecord();
    process.exit(130);
  };
  const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  process.on('exit', onExit);
  for (const signal of SIGNALS) process.on(signal, onSignal);

  // Written before the first spawn as well as at it, so a start that races this
  // one is refused during the gap between the two rather than waved through.
  writeRunRecord(null);

  try {
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
    endStartedGroups();
    clearRunRecord();
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

module.exports = { redFirst, recordOutcome, restoreTo, isTest, namesFrom, runRecordPath, liveRun, endGroup, groupAlive, TEST_DIRS, TEST_FILENAME_MARKERS, NAME_LIMIT, END_GRACE_MS, LIMITATION };
