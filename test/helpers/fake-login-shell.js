'use strict';
// A fake login shell, for the tests of reading CLAUDE_CONFIG_DIR from the
// login shell (electron/shell-config-dir.js), so that no test ever runs the
// person's real shell or profile.
//
// A /bin/sh script that records how it was started, runs a fake profile, then
// the command after -c, as a login shell does. It clears CLAUDE_CONFIG_DIR
// first, so whatever the test run itself inherited never reaches the read.
// `after` replaces the hand-over with the command run and then a line of the
// test's choosing. POSIX only: the read never runs on Windows.
const fs = require('node:fs');
const path = require('node:path');
const { makeTempDir } = require('./workspace.js');

function fakeShell(profile, { after = null } = {}) {
  const dir = makeTempDir('shell-config-shell-');
  const profilePath = path.join(dir, 'profile.sh');
  const argsPath = path.join(dir, 'args');
  const shell = path.join(dir, 'fake-shell');
  fs.writeFileSync(profilePath, profile);
  const run = after ? ['    /bin/sh -c "$2"', `    ${after}`] : ['    exec /bin/sh -c "$2"'];
  fs.writeFileSync(shell, [
    '#!/bin/sh',
    `printf '%s\\n' "$@" > '${argsPath}'`,
    'unset CLAUDE_CONFIG_DIR',
    `. '${profilePath}'`,
    'while [ $# -gt 0 ]; do',
    '  if [ "$1" = "-c" ]; then',
    ...run,
    '  fi',
    '  shift',
    'done',
    'exit 97',
  ].join('\n') + '\n', { mode: 0o755 });
  return { dir, shell, args: () => fs.readFileSync(argsPath, 'utf8').split('\n').slice(0, -1) };
}

// The token a read's command carries, from which its markers are made. It
// refuses a command it finds none in, so a change to the command's shape fails
// here by name rather than handing back nothing.
function tokenOf(command) {
  const found = /const t="([0-9a-f]+)"/.exec(command);
  if (!found) throw new Error("the read's command carries no token: its shape has changed");
  return found[1];
}

module.exports = { fakeShell, tokenOf };
