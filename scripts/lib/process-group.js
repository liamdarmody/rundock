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
function psGroupMembers(pgid) {
  const out = spawnSync('ps', ['-e', '-o', 'pgid=,pid=,stat='],
    { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
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
function endGroup(pgid, { graceMs = END_GRACE_MS, readMembers = psGroupMembers } = {}) {
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
  const state = () => groupRunning(pgid, reined);

  if (state() === false) return 'gone';
  try { process.kill(-pgid, 'SIGTERM'); } catch (e) { /* gone since the check */ }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (state() === false) return 'gone';
    pause(POLL_MS);
  }
  try { process.kill(-pgid, 'SIGKILL'); } catch (e) { /* gone since the check */ }
  pause(POLL_MS);
  // The verdict read is never served from the cache: what is reported after
  // the escalation has to describe the table as it is now.
  lastReadAt = -Infinity;
  const after = state();
  if (after === false) return 'gone';
  return after === null ? 'unknown' : 'running';
}

module.exports = {
  pause, exists, psGroupMembers, groupRunning, endGroup,
  END_GRACE_MS, POLL_MS, TABLE_POLL_MS, EXITED_STATE,
};
