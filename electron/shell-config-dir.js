// CLAUDE_CONFIG_DIR from the login shell, for the packaged app on macOS.
//
// An app opened from the Finder starts with launchd's environment, not the
// login shell's. Someone whose shell profile sets CLAUDE_CONFIG_DIR signs in to
// Claude Code in a terminal, where the variable changes where Claude Code keeps
// that sign-in, and the app's own checks, started without it, find none. So
// after a sign-in check fails, at most once per launch, this runs the login
// shell once to read that one variable, takes it only when it names the
// default folder (~/.claude), and runs the failed check again.
//
// Pure of Electron: electron/main.js passes in what it knows and routes its
// checks through here. Every effect goes through `deps`, which tests replace
// in-process.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const KEY = 'CLAUDE_CONFIG_DIR';

const deps = {
  fs,
  home: () => os.homedir(),
};

// Only the packaged app on macOS: a dev run, a smoke test and every other
// platform never run the shell, with a marker or without.
function mayRun({ isPackaged, platform, env } = {}) {
  return isPackaged === true && platform === 'darwin' && (env || {}).RUNDOCK_SMOKE_TEST !== '1';
}

// A value is taken only when it is absolute, names an existing directory and
// resolves to the same place as <home>/.claude, compared without case on
// macOS, whose disks usually ignore it. Anything else, or any error, is null.
// A taken value is kept as written: the form Claude Code sees in a terminal.
function gate(value, { home, platform }) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return null;
  const fold = (p) => (platform === 'darwin' ? p.toLowerCase() : p);
  try {
    if (!deps.fs.statSync(value).isDirectory()) return null;
    const real = fold(deps.fs.realpathSync(value));
    if (real !== fold(deps.fs.realpathSync(path.join(home, '.claude')))) return null;
    return value;
  } catch {
    return null;
  }
}

module.exports = { KEY, deps, mayRun, gate };
