'use strict';
// Where a fixture process says it is running, so a test can check afterwards
// that the process is gone. One empty file per process, named for its role and
// pid, in the folder MUTATION_FIXTURE_PIDS names. Nothing is written when the
// variable is unset.
const fs = require('node:fs');
const path = require('node:path');

function record(role, pid = process.pid) {
  const dir = process.env.MUTATION_FIXTURE_PIDS;
  if (dir) fs.writeFileSync(path.join(dir, `${role}.${pid}`), '');
}

module.exports = { record };
