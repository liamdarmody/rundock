'use strict';
// NO TEST EVER WATCHES A STARTUP FILE OF THE ACCOUNT RUNNING IT.
//
// The answer-file guard watches the home folder's shell startup files in every
// turn, and puts back a change to one. A test that left HOME, ZDOTDIR or
// XDG_CONFIG_HOME pointing into the home folder of the account running it, or
// made a startup file that links there, would have the guard watch the
// person's real files and put back their own edit. This preload narrows the
// guard before any test runs: such a path is never watched, it is named in a
// warning, and the run fails, so the test is found and given a made-up home.
//
// The npm test scripts load it with --require, which `node --test` hands to
// every test file it runs. The helpers that give a test a made-up home
// (made-up-home.js, harness.js) load it too, so a test file run on its own
// with `node --test` has it as well.
//
// The account's home is read from the user database, which no environment
// variable moves. If it cannot be read, no startup file is watched.
const os = require('os');
const path = require('path');
const { canonicalize } = require('../../scripts/permission-hook.js');
const guard = require('../../lib/workspace/answer-file-guard.js');

const forms = p => [path.resolve(p), canonicalize(p)].map(f => (process.platform === 'linux' ? f : f.toLowerCase()));
function accountsOwn(p) {
  let account = null;
  try { account = forms(os.userInfo().homedir); } catch (e) { /* unknown: refused */ }
  const inside = !account || forms(p).some(c => account.some(a => c === a || c.startsWith(a + path.sep)));
  if (inside) {
    console.warn(`[Answer files] under test, not watching the account's own startup file: ${p}`);
    process.exitCode = 1;
  }
  return inside;
}
guard.refuseStartupFiles(accountsOwn);

module.exports = { accountsOwn };
