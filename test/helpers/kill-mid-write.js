'use strict';
// Run one writeAsUnit in a real child process and SIGKILL it after the Nth
// completed step, so the tests can prove recovery against genuine process
// death rather than a thrown error the primitive gets to catch.
//
// As a module it exports the step enumerator the tests use to decide how many
// children to spawn. As a script it is the child: argv carries a JSON plan
// { workspace, writes, replaceDirs, killAfter }, all content utf8 strings.
// SIGKILL is delivered to the child's own pid the moment step `killAfter`
// completes, so nothing after that boundary ever runs, and the parent reads
// the wait status to confirm the child died of the signal and not of a bug.

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { writeAsUnit } = require('../../lib/workspace/atomic-write.js');

// Every step a plan will pass through, observed with a throwaway copy of the
// workspace so enumeration cannot disturb the tree the real run writes to.
function enumerateSteps(workspace, writes, replaceDirs, scratch) {
  const fs = require('node:fs');
  fs.cpSync(workspace, scratch, { recursive: true });
  const rebase = (p) => path.join(scratch, path.relative(workspace, p));
  const steps = [];
  writeAsUnit(scratch, writes.map((w) => ({ ...w, path: rebase(w.path) })), {
    replaceDirs: replaceDirs.map((r) => ({ ...r, path: rebase(r.path) })),
    afterStep: (step) => steps.push(`${step.phase}:${step.action}`),
  });
  fs.rmSync(scratch, { recursive: true, force: true });
  return steps;
}

function runChildKilledAfter(workspace, writes, replaceDirs, killAfter) {
  const plan = JSON.stringify({ workspace, writes, replaceDirs, killAfter });
  return spawnSync(process.execPath, [__filename, plan], { encoding: 'utf8' });
}

if (require.main === module) {
  const { workspace, writes, replaceDirs, killAfter } = JSON.parse(process.argv[2]);
  let completed = 0;
  writeAsUnit(workspace, writes, {
    replaceDirs,
    afterStep: () => {
      completed += 1;
      if (completed === killAfter) process.kill(process.pid, 'SIGKILL');
    },
  });
  // Reaching here means the kill boundary was past the last step; say so.
  process.stdout.write('completed\n');
}

module.exports = { enumerateSteps, runChildKilledAfter };
