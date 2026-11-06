'use strict';
// WHICH CLAUDE CODE RUNDOCK STARTS: the copy the person's login shell finds.
//
// The desktop app is started by the system, not from a terminal, so it never
// gets the PATH the person's shell builds from its startup files. It used to
// put four install folders ahead of whatever PATH it had and take the first
// `claude` along that, so an old copy in one of them beat the current copy
// the person's terminal starts (#401). Now the person's own shell is asked
// for its PATH, and the copies along it come first.
//
// ONE LOOKUP SERVES EVERY CALLER: every spawn and the Settings probe
// (resolveClaudeBin in lib/runtime/claude.js, and server.js) and the desktop
// app's "is Claude Code installed" check (findClaude in electron/main.js), so
// all of them name the same copy. Nothing else looks for `claude`, and
// nothing reads its version through a shell (test/unit/claude-lookup.test.js).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
const { versionIn, meetsFloor } = require('./claude-floor.js');
const codexRuntime = require('../../codex.js');

// The folders the desktop app adds to its PATH (ensurePath in
// electron/main.js), where Claude Code's own installers put it. On macOS and
// Linux they now come after the login shell's PATH, never ahead of it.
function defaultInstallFolders(platform, env = process.env, home = os.homedir()) {
  if (platform !== 'win32') {
    return [path.join(home, '.local', 'bin'), path.join(home, '.claude', 'bin'), '/usr/local/bin', '/opt/homebrew/bin'];
  }
  return [
    // Anthropic's PowerShell installer drops claude.exe here.
    path.join(home, '.local', 'bin'),
    // WinGet shim location.
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links') : null,
    // npm global bin (Claude installed via `npm install -g`).
    env.APPDATA ? path.join(env.APPDATA, 'npm') : null,
  ].filter(Boolean);
}

// The platform the lookup runs for, and the install folders it adds after
// the login shell's PATH. Nothing wires them: a test stands in another
// platform, or folders inside a temp folder, here.
const deps = {
  platform: () => process.platform,
  installFolders: () => defaultInstallFolders(deps.platform()),
};
function wireLookupDeps(next) {
  const prev = { ...deps };
  Object.assign(deps, next);
  return prev;
}
// The folders, for the desktop app's PATH and for the lookup alike.
function installFolders() { return deps.installFolders(); }

// What `claude --version` printed, or null when it failed, ran past the
// timeout, or could not be run. The binary is run itself, never through a
// shell, so nothing in the path it was found at (a quote, a `$(...)`) is read
// as part of a command. Stdin closed (PROBE_STDIO): on Windows a probe
// against an open piped stdin can hang for its full timeout.
//
// A Windows .cmd or .bat runs only through a shell (Node refuses to start one
// without it), so it is never run here. It is what an npm install puts on
// PATH, `%APPDATA%\npm\claude.cmd`, and npm installs the package it starts
// beside it, so its version is read from that package's package.json. With
// no such package, or one that does not parse or names no version, the
// version is unknown, and the spawn goes ahead as before, logged once
// (floorRefusal in lib/runtime/claude.js).
const VERSION_PROBE_TIMEOUT_MS = 5000;
const NPM_PACKAGE_JSON = ['node_modules', '@anthropic-ai', 'claude-code', 'package.json'];
function launcherPackageVersion(bin) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(bin), ...NPM_PACKAGE_JSON), 'utf-8'));
    return pkg && typeof pkg.version === 'string' ? pkg.version : null;
  } catch (e) { return null; }
}
function readClaudeVersion(bin, timeout = VERSION_PROBE_TIMEOUT_MS, platform = process.platform) {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) return launcherPackageVersion(bin);
  try {
    const { execFileSync } = require('child_process');
    return execFileSync(bin, ['--version'], { timeout, encoding: 'utf-8', stdio: codexRuntime.PROBE_STDIO });
  } catch (e) { return null; }
}

// THE LOGIN SHELL, ASKED ONCE PER LOOKUP. `$SHELL` is run as an interactive
// login shell, so it reads the startup files a terminal reads, with its
// arguments and never through another shell. The command is fixed: it prints
// the exported PATH between two markers, so whatever the startup files print
// around it is ignored, and `printenv` prints it colon-separated in zsh, bash
// and fish alike. Each marker is printed in two halves, so the command line
// itself never holds one.
//
// Bounded by the timeout, killed outright past it (an interactive shell
// ignores SIGTERM), with stdin closed, in a session of its own so it cannot
// take a terminal over, and with only the environment a shell needs to find
// its startup files. None of Rundock's own variables reach it.
const LOGIN_SHELL_TIMEOUT_MS = 5000;
const MARK = '_RUNDOCK_LOGIN_PATH';
const BEGIN = `${MARK}_BEGIN_`;
const END = `${MARK}_END_`;
const LOGIN_SHELL_COMMAND = `printf '%s%s\\n' ${MARK} _BEGIN_; printenv PATH; printf '%s%s\\n' ${MARK} _END_`;
const SHELL_ENV = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'PATH'];

function shellEnv(env) {
  const out = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && (SHELL_ENV.includes(name) || name.startsWith('LC_'))) out[name] = value;
  }
  return out;
}

// The PATH between the markers, or null when the output holds no complete
// answer: a first marker with no second, or nothing between them.
function markedPath(output) {
  const at = output.indexOf(BEGIN);
  const end = at === -1 ? -1 : output.indexOf(END, at + BEGIN.length);
  if (end === -1) return null;
  const value = output.slice(at + BEGIN.length, end).replace(/^\r?\n/, '').replace(/\r?\n$/, '');
  return value || null;
}

// The login shell's PATH as a list of folders, or { failed } saying why there
// is none.
function loginShellPath(env = process.env, timeout = LOGIN_SHELL_TIMEOUT_MS) {
  const shell = env.SHELL;
  if (!shell) return { failed: 'SHELL is not set' };
  if (!path.isAbsolute(shell)) return { failed: `SHELL is not an absolute path (${shell})` };
  try { fs.accessSync(shell, fs.constants.X_OK); if (!fs.statSync(shell).isFile()) throw new Error('not a file'); } catch (e) {
    return { failed: `${shell} is not an executable file` };
  }
  const run = spawnSync(shell, ['-l', '-i', '-c', LOGIN_SHELL_COMMAND], {
    env: shellEnv(env), cwd: env.HOME || os.homedir(), stdio: codexRuntime.PROBE_STDIO,
    timeout, killSignal: 'SIGKILL', detached: true, encoding: 'utf-8',
  });
  if (run.error && run.error.code === 'ETIMEDOUT') return { failed: `${shell} gave no answer within ${timeout}ms` };
  if (run.error) return { failed: `${shell} could not be started (${run.error.code || run.error.message})` };
  if (run.status !== 0) return { failed: `${shell} exited with ${run.status === null ? run.signal : run.status}` };
  const marked = markedPath(String(run.stdout || ''));
  if (marked === null) return { failed: `${shell} printed no complete PATH between the markers` };
  return { dirs: marked.split(':') };
}

// Every executable `claude` along the folders, in order. A relative folder is
// ignored (it would be read from wherever Rundock happens to be running), a
// `claude` that is not an executable file is skipped, and a copy reached
// twice, by a repeated folder or a link, is listed once, where it is first
// reached.
function executablesAlong(dirs) {
  const seen = new Set();
  const out = [];
  for (const dir of dirs) {
    if (!path.isAbsolute(dir)) continue;
    const bin = path.join(dir, 'claude');
    let real;
    try {
      if (!fs.statSync(bin).isFile()) continue;
      fs.accessSync(bin, fs.constants.X_OK);
      real = fs.realpathSync(bin);
    } catch (e) { continue; }
    if (seen.has(real)) continue;
    seen.add(real);
    out.push(bin);
  }
  return out;
}

// The first candidate not known to be below the version floor, read with the
// floor's own version read. The read stops at the first copy that passes or
// whose version is unknown, which fails open as the floor does. When every
// copy is known to be below the floor, the first is used, and the floor's
// refusal names it. What the chosen copy said is kept, so the floor does not
// ask it again.
function firstNotBelowFloor(candidates, platform) {
  let first = null;
  for (const bin of candidates) {
    const read = { bin, versionText: readClaudeVersion(bin, VERSION_PROBE_TIMEOUT_MS, platform) };
    if (!first) first = read;
    if (meetsFloor(versionIn(read.versionText)) !== false) return read;
  }
  return first || { bin: null };
}

// TODAY'S LOOKUP, unchanged: the first `claude` on the PATH Rundock was
// started with (in the desktop app, ensurePath's folders are already on it).
// Windows lists every match, and an .exe is preferred over an npm .cmd shim,
// then anything else, each in where.exe's order.
function pathLookup(isWindows) {
  try {
    const output = execSync(isWindows ? 'where.exe claude' : 'which claude', { timeout: 5000, encoding: 'utf-8', stdio: codexRuntime.PROBE_STDIO }).trim();
    if (!output || !isWindows) return output ? [output] : [];
    const rank = (c) => (/\.exe$/i.test(c) ? 0 : /\.cmd$/i.test(c) ? 1 : 2);
    return output.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      .map((c, i) => [c, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([c]) => c);
  } catch (e) { return []; }
}

function lookupNow(versionPlatform) {
  if (deps.platform() === 'win32') return firstNotBelowFloor(pathLookup(true), versionPlatform);
  const login = loginShellPath();
  if (login.failed) {
    // A shell that cannot answer never stops chat: today's lookup stands in,
    // and the floor and Claude Code's own parser still stand behind it.
    console.warn(`[claude-lookup] could not read the login shell's PATH: ${login.failed}; looking for claude on the PATH Rundock was started with`);
    return { bin: pathLookup(false)[0] || null };
  }
  const extra = deps.installFolders().filter((dir) => !login.dirs.includes(dir));
  const candidates = executablesAlong([...login.dirs, ...extra]);
  if (candidates.length) return firstNotBelowFloor(candidates, versionPlatform);
  return { bin: pathLookup(false)[0] || null };
}

// THE CHOSEN COPY, kept for the process. It is let go when the floor refuses
// it (forget, from floorRefusal) or when it is no longer there, so the next
// lookup asks the shell again, and it is never reused for a different PATH,
// SHELL or HOME than it was found with. `retryMissing` looks again when the
// kept answer is that there is no copy: an install check asks while the
// person installs.
let kept = null;
let looks = 0;
function lookupClaude({ versionPlatform = process.platform, retryMissing = false } = {}) {
  const key = JSON.stringify([deps.platform(), versionPlatform, process.env.SHELL, process.env.HOME, process.env.PATH]);
  const stillThere = (bin) => (bin ? fs.existsSync(bin) : !retryMissing);
  if (kept && kept.key === key && stillThere(kept.found.bin)) return kept.found;
  looks++;
  kept = { key, found: lookupNow(versionPlatform) };
  return kept.found;
}
function forget() { kept = null; }

// The desktop app's install check: the copy the lookup chose and what it says
// its version is, read with no shell, and read again on a later check. null
// when there is no copy, or when it gives no version, as a copy that could
// not be run always counted; a Windows launcher whose package names no
// version still counts as found, as it did when it was run through a shell.
function installedClaude(platform = process.platform) {
  const before = looks;
  const { bin, versionText } = lookupClaude({ versionPlatform: platform, retryMissing: true });
  if (!bin) return null;
  // A lookup that has just read the copy it chose is not asked again.
  const justRead = looks !== before && typeof versionText === 'string';
  const said = justRead ? versionText : readClaudeVersion(bin, VERSION_PROBE_TIMEOUT_MS, platform);
  if (said === null && !(platform === 'win32' && /\.(cmd|bat)$/i.test(bin))) return null;
  return { bin, version: said };
}

module.exports = {
  wireLookupDeps, installFolders, readClaudeVersion, VERSION_PROBE_TIMEOUT_MS,
  LOGIN_SHELL_TIMEOUT_MS, LOGIN_SHELL_COMMAND, SHELL_ENV, loginShellPath, markedPath, executablesAlong,
  lookupClaude, forget, installedClaude,
};
