'use strict';
// Loaded with --require by record-read-only-on-main.js, in each test process
// and in every hook those tests start. It notes every text handed to the
// read-only definition's two line checks, isReadOnlyShellCommand and
// isDestructiveShellCommand, one JSON string per line, into a file of this
// process's own in the folder RUNDOCK_RECORD_SHELL_LINES names. It changes no
// answer. Without that variable it does nothing.
//
// It must load before anything else requires the module: the card grader and
// the hook each keep the functions they were handed at load time.
const dir = process.env.RUNDOCK_RECORD_SHELL_LINES;
if (dir) {
  const fs = require('node:fs');
  const path = require('node:path');
  const S = require('../../public/read-only-shell.js');
  const out = path.join(dir, `${process.pid}.jsonl`);
  const seen = new Set();
  for (const name of ['isReadOnlyShellCommand', 'isDestructiveShellCommand']) {
    const judge = S[name];
    S[name] = function (command) {
      if (typeof command === 'string' && !seen.has(command)) {
        seen.add(command);
        fs.appendFileSync(out, JSON.stringify(command) + '\n');
      }
      return judge.apply(this, arguments);
    };
  }
}
