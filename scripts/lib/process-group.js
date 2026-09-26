'use strict';
// Ending a subtree of processes this repository's tooling started, and knowing
// whether it really ended.
//
// WHY THIS IS SHARED RATHER THAN WRITTEN TWICE. Two development tools here
// spawn a command that starts children of its own: the reverting check runs a
// whole test suite, and the pre-commit gate runs a chain of mutation harnesses
// under one shell. Both have left that subtree running after they themselves
// were gone, and both leaks were the same three mistakes: signalling the direct
// child rather than the group, reading "the pid still answers" as "it is still
// running", and having only some of the exit paths end anything at all.
//
// The first of those was fixed in the reverting check and the fix's own comment
// named a mutation harness as the thing a careless remedy would reach. Copying
// that code into the gate would leave two versions of logic subtle enough to
// have been got wrong once already, so it lives here and both call it.
//
// WHAT THIS DELIBERATELY DOES NOT DO. It never searches the machine for
// processes that look like the ones a tool started. A group id names processes
// by where they came from; a command-line match names them by what they
// resemble, and would reach a suite in another checkout or a mutation harness
// partway through rewriting a file it restores in a `finally` a killed process
// never runs. Every function here takes a group id the caller created.

const { spawnSync } = require('node:child_process');

// How long a process group gets to end on its own before it is ended outright.
//
// Short by default. The politeness is worth something, since a test runner
// given the chance will close its reporters and flush its output, but nothing
// the reverting check spawns has a restore step to skip, and the cost of
// waiting longer is paid by a developer watching a tool refuse to exit.
//
// A CALLER WHOSE CHILD HOLDS SOURCE FILES MUTATED SHOULD ASK FOR MORE, and the
// pre-commit gate does. Its group is a mutation harness that has a real source
// file rewritten on disk and puts it back from a signal handler; escalating to
// SIGKILL before that handler has run turns the tidiest exit into the mess this
// whole area exists to prevent.
const END_GRACE_MS = 500;

// How often the cheap question below is asked, and how rarely the expensive one
// is. See psGroupMembers for why the second needs a rein on it.
const POLL_MS = 25;

/* How long a group gets to leave the process table AFTER it has been SIGKILLed,
   before the ending is called a survivor.

   Separate from END_GRACE_MS, which is the courtesy before the kill: that one
   is a process's chance to tidy up and end itself, and it is short because a
   step that wants longer should not be relying on it. This one is not a
   courtesy at all. The group has already been killed and the outcome is not in
   doubt; this is only the time the kernel needs to finish the job and drop the
   entries, which on a loaded machine is thousands of times longer than the poll
   interval that used to stand in for it.

   Generous on purpose. Being slow to warn about a genuinely stuck group costs
   seconds on the rarest path there is; warning wrongly costs a reader their
   trust in every warning the gate prints. */
const REAP_GRACE_MS = 10000;
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
  // ZERO IS NOT A TARGET, and is the one number this cannot answer honestly.
  // `process.kill(0, 0)` signals the CALLER'S OWN process group, so it always
  // succeeds and always answers yes, whoever asked and about whatever. Every
  // caller here means a specific process or a specific group, so a 0 arriving
  // is a bug upstream rather than a question.
  //
  // MEASURED, and this is why it is worth a line. `readMutationRun` seeds its
  // reduce with `{ pid: 0, files: [] }`, an empty records directory returns
  // that seed unchanged, and the gate then treated the phantom as a live
  // mutation run. Every clean `npm run precommit` therefore warned that a
  // mutation run was holding source files rewritten, which is the exact wording
  // that matters when it is true and which three cards in the backlog describe
  // genuinely happening.
  //
  // NEGATIVE NUMBERS ARE DELIBERATELY LEFT ALONE. They ask about a whole
  // process group, which is the documented contract above and what
  // `groupRunning` depends on. Widening this to reject every non-positive
  // target is the obvious next edit and it would stop the gate noticing real
  // survivors, silently. A test pins that.
  if (target === 0) return false;
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
 * has already answered "something is there", and, inside endGroup's loop, no
 * more often than TABLE_POLL_MS.
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
// The read is given room and one second chance, because the cost of not
// getting an answer is paid by somebody reading a wrong one.
//
// Listing the whole table is not free, and on a machine running a full
// mutation set beside a coverage run it did exceed a two second timeout. A
// timed-out read answers null, "this machine will not say", and every caller
// that forgets to handle null reads that as "the group is gone". On
// 2026-09-21 one such caller reported that a refusal had killed a live run,
// twice, and the resulting backlog card blamed timing and sent the next
// reader looking in the wrong place.
//
// So: a ceiling high enough to survive a loaded machine, and one retry,
// because the failure observed is transient contention rather than a missing
// `ps`. The ceiling still exists to stop an indefinite hang, which is its
// only job; it is not a performance budget. On a healthy machine this returns
// in milliseconds and neither number is reached.
const PS_TIMEOUT_MS = 15000;

function readPsTable() {
  return spawnSync('ps', ['-e', '-o', 'pgid=,pid=,stat='],
    { encoding: 'utf8', timeout: PS_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] });
}

function psGroupMembers(pgid) {
  let out = readPsTable();
  if (out.error || typeof out.stdout !== 'string') out = readPsTable();
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
 * THE DISTINCTION IS THE DEFECT. When a process signals its own direct child
 * and then waits, the child dies at once but stays in the table until that
 * process collects it, which it cannot do while the event loop is blocked in
 * the wait. That corpse is still a member of its process group, so asking the
 * kernel whether the group exists keeps answering yes for the entire grace, the
 * group is then SIGKILLed for no reason, the ending reports that it survived,
 * and an alarm meant for a genuine leak fires on every interrupt.
 *
 * MEASURED ON BOTH PLATFORMS, and the same on both: macOS and Linux each report
 * a group whose only member is an exited entry as existing. An earlier version
 * of this comment said macOS filtered such members out; it does not, and the
 * reverting check's evidence file records the measurement that corrected it.
 *
 * So the group is asked about by its members and their states, and a group
 * whose remaining members have all exited is gone.
 *
 * The reader is a parameter so the decision can be driven on any machine,
 * including one whose sandbox blocks spawning, rather than only where corpses
 * happen to appear.
 */
function groupRunning(pgid, readMembers = psGroupMembers, groupExists = exists) {
  // Cheap first, and it is the only question asked once the group is really
  // gone, which is the common case at the end of a run.
  if (!groupExists(-pgid)) return false;
  const members = readMembers(pgid);
  if (members === null) return null;
  return members.some(m => !String(m.state).startsWith(EXITED_STATE));
}

/**
 * End one process group, and say what became of it.
 *
 * @param {number} pgid
 * @param {{graceMs?: number, readMembers?: (pgid: number) => ({pid: number,
 *   state: string}[]|null)}} [opts] `graceMs` is how long the group gets to end
 *   on its own before SIGKILL; raise it where the group holds something that
 *   must run on the way out, such as a mutation harness restoring a source
 *   file. `readMembers` is the process-table reader, a parameter so that the
 *   answer this cannot get, and what it does when it cannot get one, are
 *   drivable by a test on a machine where `ps` works.
 * @returns {'gone'|'running'|'unknown'}
 *
 * A NEGATIVE pid signals the whole group, which is the point rather than a
 * detail. The command is spawned detached, so it heads its own group, and a
 * package runner starts children inside that group; ending the direct child
 * alone leaves those children running, which is how a check that had already
 * printed its conclusion kept a full suite on the machine, and how a gate that
 * had already printed FAILED kept a mutation harness rewriting source.
 *
 * Ending a group BY NUMBER is also what keeps the remedy from becoming the next
 * defect. The obvious way to clear leftovers is to match command lines across
 * the machine and kill what matches, and that reaches processes the caller
 * never started. A group id names processes by where they came from rather than
 * by what they look like, so nothing outside one run can be caught by it
 * however similar it looks.
 *
 * SIGTERM first and SIGKILL after the grace, because a child that ignores
 * SIGTERM is the only case where anything but the escalation keeps a subtree
 * from outliving its caller, and the criterion it answers to is unconditional.
 */
function endGroup(pgid, {
  graceMs = END_GRACE_MS,
  // Symmetric with graceMs, and for the same reason it is a parameter: the
  // window the production gate wants is ten seconds of mostly idle waiting,
  // which is right on the rarest path there is and wrong inside a suite that
  // would then idle for it twice on every run. The value that ships is pinned
  // by its own test rather than by these spending it.
  reapMs = REAP_GRACE_MS,
  readMembers = psGroupMembers,
  // The same argument that made readMembers a parameter, carried to the other
  // two things this function does to the world. Without them the verdicts here
  // cannot be driven at all: groupRunning answers `false` the moment the group
  // id stops existing, so a test using a made-up pgid never reaches the table
  // reader and passes while proving nothing, and one using a real child cannot
  // hold the group in existence long enough to exercise 'running' at all.
  //
  // sendSignal matters more than it looks. A test that needs a group id which
  // keeps existing has to use one it did not start, and signalling that would
  // reach a stranger's processes: exactly what the note above about ending
  // groups BY NUMBER exists to prevent. Stubbed, the test sends nothing.
  groupExists = exists,
  sendSignal = (target, signal) => process.kill(target, signal),
} = {}) {
  // THE TABLE READ IS REINED, THE DECISION IS NOT. What a group's members
  // mean is groupRunning's question and exists in this file exactly once;
  // this wrapper only decides how often the expensive table read is made,
  // reusing the last answer for TABLE_POLL_MS between reads. The exited
  // member rule has been got wrong twice already, which is precisely why a
  // second copy of it four lines from the first is not allowed to exist.
  let lastReadAt = -Infinity;
  let lastMembers;
  const reined = (asked) => {
    if (Date.now() - lastReadAt < TABLE_POLL_MS) return lastMembers;
    lastReadAt = Date.now();
    lastMembers = readMembers(asked);
    return lastMembers;
  };
  const state = () => groupRunning(pgid, reined, groupExists);

  if (state() === false) return 'gone';
  try { sendSignal(-pgid, 'SIGTERM'); } catch (e) { /* gone since the check */ }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (state() === false) return 'gone';
    pause(POLL_MS);
  }
  try { sendSignal(-pgid, 'SIGKILL'); } catch (e) { /* gone since the check */ }

  // DYING IS NOT INSTANT, AND THE VERDICT USED TO ASSUME IT WAS.
  //
  // This paused once for POLL_MS, read the table once, and called whatever it
  // saw the answer. SIGKILL cannot be caught, blocked or ignored, so a group
  // that has been sent one WILL go; the only question is when the scheduler
  // gets to it. Twenty-five milliseconds is long enough on an idle machine and
  // nowhere near it on a busy one, so the gate reported a survivor that was
  // already dying and told a reader to go and inspect `git diff` over nothing.
  // On a machine at load 32 it fired every time.
  //
  // So the group is given a bounded window to actually leave the table. The
  // verdict keeps its exact meaning and gets stricter rather than weaker:
  // 'running' now means still there after it was killed AND given a fair
  // chance to die, which is the only reading under which the warning is worth
  // printing. A group genuinely stuck, in uninterruptible sleep or beyond this
  // process's permission, still reaches the deadline and is still reported.
  const reaped = Date.now() + reapMs;
  for (;;) {
    // Never served from the cache: what is reported after the escalation has
    // to describe the table as it is now.
    lastReadAt = -Infinity;
    const after = state();
    if (after === false) return 'gone';
    if (Date.now() >= reaped) return after === null ? 'unknown' : 'running';
    pause(POLL_MS);
  }
}

module.exports = {
  pause, exists, psGroupMembers, groupRunning, endGroup,
  END_GRACE_MS, POLL_MS, TABLE_POLL_MS, REAP_GRACE_MS, EXITED_STATE,
};
