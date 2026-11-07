'use strict';
// THE DESKTOP APP'S CLAUDE CODE CHECKS, with no Electron in them, so the
// functions electron/main.js registers and calls are the ones the tests run
// (test/unit/claude-lookup.test.js): is Claude Code installed (installedCopy,
// behind findClaude in main.js), is the person signed in
// (isClaudeAuthenticated), and the setup wizard's poll of both runtimes
// (wizardCheckRuntimes, registered as the 'wizard-check-runtimes' handler).
// The lookup is required when a check runs, as main.js always required it.
const path = require('path');
const { execSync, execFileSync } = require('child_process');

const lookup = () => require('../lib/runtime/claude-lookup.js');

// Electron packaged apps don't inherit the user's full shell PATH, so the
// folders Claude Code's installers use are put on it first (addInstallFolders
// in lib/runtime/claude-lookup.js, which keeps the PATH from before them for
// the login shell). Then: the copy every spawn and the Settings probe start,
// found the way the person's login shell finds it, and the version it says it
// is, read with no shell. null when there is no copy, or when it cannot be run
// for its version.
function installedCopy() {
  try {
    lookup().addInstallFolders();
    return lookup().installedClaude();
  } catch {
    return null;
  }
}

// Is the person signed in: the copy the lookup chose (the one installedCopy
// just found, and the one chats start) is started as chats start it
// (launchFor: a Windows npm launcher through its package's entry), with its
// arguments and never through a shell, so nothing in the path it was found
// at is read as a command. A copy that cannot be started without a shell is
// not started at all, so it is not signed in, and cannotStart says why.
function isClaudeAuthenticated() {
  const bin = lookup().lookupClaude().bin;
  if (!bin) return false;
  const launch = lookup().launchFor(bin);
  if (launch.refusal) return false;
  try {
    execFileSync(launch.command, [...launch.args, '--print', 'test', '--output-format', 'text'], { timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

// Why the copy the lookup chose cannot be started, in the words a chat shows
// (launchFor's refusal: a Windows npm install whose package entry, or a
// node.exe to run it with, cannot be found), or null when it can be, or when
// there is no copy.
function cannotStart() {
  const bin = lookup().lookupClaude().bin;
  const refusal = bin ? lookup().launchFor(bin).refusal : null;
  return refusal ? refusal.message : null;
}

// Anthropic's Windows installer drops claude.exe in ~/.local/bin but does NOT
// add that directory to the user's PATH, so `claude` is unrecognised in the
// terminal even though it's installed. Rundock detects claude regardless (see
// installedCopy), but the user still needs `claude` on PATH to run the
// one-time sign-in. Since we know where claude lives, persist its directory
// onto the user's PATH so a freshly opened terminal recognises `claude`.
// Idempotent, Windows-only, best-effort (never throws). Takes effect in new
// terminals.
function ensureClaudeOnUserPath(binDir) {
  if (process.platform !== 'win32' || !binDir) return;
  const d = binDir.replace(/'/g, "''"); // escape for PowerShell single-quoted string
  const psCmd = [
    `$d='${d}';`,
    `$p=[Environment]::GetEnvironmentVariable('Path','User'); if(-not $p){$p=''};`,
    `if(($p -split ';') -notcontains $d){`,
    `  if($p){$p=$p.TrimEnd(';')+';'+$d}else{$p=$d};`,
    `  [Environment]::SetEnvironmentVariable('Path',$p,'User')`,
    `}`,
  ].join(' ');
  try {
    execSync(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${psCmd}"`, { timeout: 8000 });
  } catch {
    // Best-effort: if PATH can't be written, the user can still sign in via the
    // full path; we never block first-run on this.
  }
}

// Codex detection for the wizard. Reuses the server-side detector in codex.js
// (packaged with the app) rather than porting it: binary resolution is
// .cmd-shim aware on Windows, auth detection is the PRESENCE of auth.json
// under $CODEX_HOME or ~/.codex, contents never read. Detection must never
// break the wizard's Claude path, so failures collapse to "not installed".
function detectCodexForWizard() {
  try {
    const { detectCodex } = require('../codex.js');
    const d = detectCodex();
    return { installed: !!d.installed, authenticated: !!d.authenticated };
  } catch {
    return { installed: false, authenticated: false };
  }
}

// The wizard polls for both runtimes. Codex detection rides alongside so the
// wizard can adapt honestly to what the user has (a Codex user is told why
// Claude Code is still needed, and can sign in to Codex as an optional final
// step). A copy that is installed but cannot be started is reported with why,
// which the wizard shows in place of the sign-in step; the refusal lets the
// lookup's answer go, so the next poll finds a copy installed meanwhile.
function wizardCheckRuntimes() {
  const claude = (() => {
    const found = installedCopy();
    if (!found) return { status: 'not-installed' };
    // Claude is installed: make sure its directory is on the user's PATH so
    // they can simply type `claude` in a new terminal to sign in.
    ensureClaudeOnUserPath(path.dirname(found.bin));
    const why = cannotStart();
    if (why) return { status: 'cannot-start', message: why };
    if (!isClaudeAuthenticated()) return { status: 'not-authenticated' };
    return { status: 'ready' };
  })();
  return { claude, codex: detectCodexForWizard() };
}

module.exports = { installedCopy, isClaudeAuthenticated, cannotStart, wizardCheckRuntimes };
