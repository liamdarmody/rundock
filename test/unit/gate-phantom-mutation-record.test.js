'use strict';
// THE GATE MUST NOT WARN ABOUT A MUTATION RUN THAT DOES NOT EXIST.
//
// WHAT WAS MEASURED. Every `npm run precommit` printed this, including both
// runs that shipped 0.13.3:
//
//   [precommit] a mutation run (pid 0) is still there after its group was
//   ended, so its files have been left alone rather than written over. Read
//   `git diff` before committing.
//
// No mutation run was held in any of them. The chain, confirmed at each step
// rather than reasoned about end to end:
//
//   1. `readMutationRun` reduces the records in `.mutation-runs/` with a seed
//      of `{ pid: 0, files: [] }`. With no parseable records, which is the
//      ordinary case, the reduce returns that seed unchanged, and the type
//      check underneath accepts it because 0 is a number and [] is an array.
//   2. `endLiveGroup` asks `exists(held.pid)` to decide whether the record is
//      a live run worth acting on.
//   3. `process.kill(0, 0)` signals THE CALLER'S OWN PROCESS GROUP, so the
//      answer was always yes, and the phantom was treated as a live run.
//   4. `reclaim` asks the same question, gets the same answer, and warns.
//
// WHY THIS IS WORTH FIXING RATHER THAN IGNORING. The warning is harmless in
// effect: it returns early and there was never anything to restore. It is not
// harmless in meaning. Three separate cards in this project's backlog describe
// mutation runs GENUINELY leaving product files rewritten, one of which was
// nearly carried into a commit by `git add -A`, and this string is the real
// warning for that case. Printing it on every clean run is the argument
// `no-live-server-in-tests.test.js` already makes at length: a person taught to
// dismiss a stream of warnings they cannot account for is a person who will
// dismiss the one that matters.
//
// THE FIX IS AT STEP 3, NOT STEP 1, AND THAT WAS MEASURED TOO. Returning null
// from `readMutationRun` when it read no records is the more obvious fix and it
// is the one this change deliberately does NOT make. Tried, and it turned three
// tests in `red-first-orphans.test.js` red, reproducibly, against a clean
// baseline of zero: acting on the phantom made `reclaim` busy-wait its full
// one-second settle on every step ending, and the gate's own orphan cleanup had
// come to depend on that accidental pause. Removing the phantom at birth
// removes the pause and leaves processes behind. That is a real defect, it is
// carded with this evidence, and it is not this change: silencing a false alarm
// must not quietly change how long the gate waits for its children to die.
//
// So the phantom is still born, and is now inert. Nothing acts on it, because
// nothing can be alive at pid 0.
//
// THE NEGATIVE CASE IS PINNED ON PURPOSE. `exists` takes a negative number to
// ask about a whole process group, and `groupRunning` calls it that way. The
// obvious spelling of this fix, rejecting every non-positive pid, would break
// that caller silently and stop the gate noticing real survivors. The test
// below exists so the next person to tighten this function finds out from a red
// test rather than from a gate that has quietly stopped looking.

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const { exists } = require('../../scripts/lib/process-group.js');

test('pid 0 does not exist, because asking about it asks about ourselves', () => {
  // THE FIX. `process.kill(0, 0)` signals the caller's own process group and
  // always succeeds, so this is the one number the function cannot answer
  // honestly. Every caller here means a specific process or a specific group,
  // so a 0 arriving is a bug upstream rather than a question.
  assert.equal(exists(0), false);
});

test('a live single pid still exists', () => {
  assert.equal(exists(process.pid), true);
});

test('a target that never existed does not exist', () => {
  assert.equal(exists(999999), false);
});

test('a negative target still asks about a process group', async () => {
  // DO NOT "TIDY" THIS INTO A NON-POSITIVE REJECTION. See the header.
  //
  // A DETACHED CHILD IS ITS OWN GROUP LEADER, so its pid is also its pgid. It
  // is spawned rather than using our own pid because a process that does not
  // lead a group has no group under that number, which is a mistake this test
  // made on its first writing and which passed for the wrong reason.
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'],
    { detached: true, stdio: 'ignore' });
  try {
    await once(child, 'spawn');
    assert.equal(exists(-child.pid), true, 'a live process group must read as present');
  } finally {
    // The group, not the process. This file would be hypocritical to leak one:
    // see red-first-orphans.test.js for what that costs.
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    child.unref();
  }
});
