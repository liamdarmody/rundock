'use strict';
// WHERE CLAUDE CODE KEEPS ITS OWN FILES, for the reads Rundock makes of them:
// session transcripts, the user settings file and the account state file.
//
// By default that is `<home>/.claude` and `<home>/.claude.json`. With
// CLAUDE_CONFIG_DIR set to an absolute path, Claude Code keeps all of them in
// that folder, the account state file included, and writes nothing in home
// (measured: scripts/runtime-home-truth/captured-runtime-homes.json).
//
// The variable is read in one place, relocatedRuntimeHomes in the permission
// hook, and asked again at each call, never at load, so a value set after
// start and a test's disposable home are both answered from where they are now.
// It is called through the hook's module object so a test can replace it.
//
// NOTHING HERE CATCHES. A throw reaches the caller, which treats it as nothing
// found, never as the variable being unset: reading home instead would describe
// a folder Claude Code is not using.
const path = require('path');
const hook = require('../../scripts/permission-hook.js');

/**
 * @param {string} home the home folder as the caller computes it
 * @returns {{ folder: string, accountState: string, relocated: boolean }}
 */
function claudeHome(home) {
  const moved = hook.relocatedRuntimeHomes(process.env).find((row) => row.runtime === 'claude');
  if (moved) return { folder: moved.value, accountState: path.join(moved.value, '.claude.json'), relocated: true };
  return { folder: path.join(home, '.claude'), accountState: path.join(home, '.claude.json'), relocated: false };
}

module.exports = { claudeHome };
