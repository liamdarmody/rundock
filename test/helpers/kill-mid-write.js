'use strict';
// Run one writeAsUnit in a real child process and SIGKILL it after the Nth
// completed step, so the tests can prove recovery against genuine process
// death rather than a thrown error the primitive gets to catch.
//
// As a module it exports only runChildKilledAfter; the test file enumerates
// the boundaries itself. As a script it is the child: argv carries a JSON
// plan { workspace, writes, replaceDirs, killAfter }, all content utf8
// strings. SIGKILL is delivered to the child's own pid the moment step
// `killAfter` completes, so nothing after that boundary ever runs, and the
// parent reads the wait status to confirm the child died of the signal and
// not of a bug.

const { spawnSync } = require('node:child_process');

function runChildKilledAfter(workspace, writes, replaceDirs, killAfter) {
  const plan = JSON.stringify({ workspace, writes, replaceDirs, killAfter });
  return spawnSync(process.execPath, [__filename, plan], { encoding: 'utf8' });
}

if (require.main === module) {
  const { writeAsUnit } = require('../../lib/workspace/atomic-write.js');
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

module.exports = { runChildKilledAfter };
