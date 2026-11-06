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
// electron/main.js, through addInstallFolders below), where Claude Code's own
// installers put it. On macOS and Linux they now come after the login shell's
// PATH, never ahead of it.
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

// The platform the lookup runs for, the install folders it adds after the
// login shell's PATH, the PATH Rundock was started with (startPath:
// undefined until addInstallFolders records it, as when the server runs on
// its own; a PATH recorded empty is recorded as ''),
// and the clock the shell's kept answer is timed by. Nothing wires them: a
// test stands in another platform, folders inside a temp folder, a PATH or
// a clock of its own, here.
const deps = {
  platform: () => process.platform,
  installFolders: () => defaultInstallFolders(deps.platform()),
  startPath: undefined,
  now: () => Date.now(),
};
function wireLookupDeps(next) {
  const prev = { ...deps };
  Object.assign(deps, next);
  return prev;
}
// The folders, for the desktop app's PATH and for the lookup alike.
function installFolders() { return deps.installFolders(); }

// The desktop app's PATH (ensurePath in electron/main.js): the install folders
// not already on it go in front, as they always have, for everything the app
// starts. The PATH from before them is recorded the first time, as the PATH
// Rundock was started with, because that is the one the login shell is given.
// Given the PATH with them in front, a shell whose startup files add to PATH
// rather than build it would keep ~/.local/bin ahead of the person's own
// folders, which is #401 again.
function addInstallFolders(env = process.env) {
  const current = env.PATH || '';
  if (deps.startPath === undefined) deps.startPath = current;
  const segments = current.split(path.delimiter);
  const missing = deps.installFolders().filter((dir) => !segments.includes(dir));
  if (missing.length) env.PATH = missing.join(path.delimiter) + path.delimiter + current;
}

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
const NPM_PACKAGE = ['node_modules', '@anthropic-ai', 'claude-code'];
const NPM_PACKAGE_JSON = [...NPM_PACKAGE, 'package.json'];
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

// THE LOGIN SHELL, ASKED FOR ITS PATH. `$SHELL` is run as an interactive
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
// its startup files. None of Rundock's own variables reach it. Its PATH is
// the one Rundock was started with (addInstallFolders), or the system's own
// when that was never recorded, so its startup files build on what a
// terminal's would.
const LOGIN_SHELL_TIMEOUT_MS = 5000;
const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
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
function askLoginShell(env = process.env, timeout = LOGIN_SHELL_TIMEOUT_MS) {
  const shell = env.SHELL;
  if (!shell) return { failed: 'SHELL is not set' };
  if (!path.isAbsolute(shell)) return { failed: `SHELL is not an absolute path (${shell})` };
  try { fs.accessSync(shell, fs.constants.X_OK); if (!fs.statSync(shell).isFile()) throw new Error('not a file'); } catch (e) {
    return { failed: `${shell} is not an executable file` };
  }
  const run = spawnSync(shell, ['-l', '-i', '-c', LOGIN_SHELL_COMMAND], {
    env: { ...shellEnv(env), PATH: deps.startPath === undefined ? SYSTEM_PATH : deps.startPath }, cwd: env.HOME || os.homedir(), stdio: codexRuntime.PROBE_STDIO,
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

// TODAY'S LOOKUP on macOS and Linux, where the login shell cannot answer:
// the first executable `claude` along the PATH Rundock has (in the desktop
// app, ensurePath's folders are already on it). The shell and this share one
// budget, the shell's five seconds from the start of the lookup (`deadline`),
// so a shell that stalls and then this never take longer between them. The
// absolute folders are walked first, with no process, so a copy in one is
// found however little is left. Only when the walk finds nothing is `which`
// asked, for what the walk does not read, and only with what is left of the
// budget: nothing, after a shell that used it all.
function todaysLookup(deadline) {
  const walked = executablesAlong((process.env.PATH || '').split(path.delimiter))[0];
  if (walked) return walked;
  const left = deadline - Date.now();
  if (left <= 0) return null;
  try {
    return execSync('which claude', { timeout: left, encoding: 'utf-8', stdio: codexRuntime.PROBE_STDIO }).trim() || null;
  } catch (e) { return null; }
}

// THE WINDOWS LOOKUP, unchanged: where.exe lists every match, and an .exe is
// preferred over an npm .cmd shim, then anything else, each in where.exe's
// order. Windows has no login shell to ask.
function whereClaude() {
  try {
    const output = execSync('where.exe claude', { timeout: 5000, encoding: 'utf-8', stdio: codexRuntime.PROBE_STDIO }).trim();
    if (!output) return [];
    const rank = (c) => (/\.exe$/i.test(c) ? 0 : /\.cmd$/i.test(c) ? 1 : 2);
    return output.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      .map((c, i) => [c, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([c]) => c);
  } catch (e) { return []; }
}

// THE SHELL'S ANSWER, KEPT FOR A MINUTE WHILE NO COPY IS FOUND. The setup
// wizard looks every few seconds while the person installs, and each look
// searches the folders again, but the shell, which can take seconds, is asked
// at most once a minute for the same SHELL, HOME and PATH, whether it
// answered or not. The answer is let go once a copy is found, and with
// everything else on a floor refusal (forget), so the next lookup after
// either asks the shell again. `asked` says whether this call asked it.
const LOGIN_ANSWER_MS = 60 * 1000;
let answer = null;
function loginShellPath(env = process.env) {
  const key = JSON.stringify([env.SHELL, env.HOME, deps.startPath]);
  const now = deps.now();
  if (answer && answer.key === key && now >= answer.at && now - answer.at < LOGIN_ANSWER_MS) return { ...answer.login, asked: false };
  answer = { key, at: now, login: askLoginShell(env) };
  return { ...answer.login, asked: true };
}

function lookupNow(versionPlatform) {
  if (deps.platform() === 'win32') return firstNotBelowFloor(whereClaude(), versionPlatform);
  const deadline = Date.now() + LOGIN_SHELL_TIMEOUT_MS;
  const login = loginShellPath();
  if (login.failed) {
    // A shell that cannot answer never stops chat: today's lookup stands in,
    // and the floor and Claude Code's own parser still stand behind it. It is
    // logged when it was asked, not on each look its answer is kept for.
    if (login.asked) console.warn(`[claude-lookup] could not read the login shell's PATH: ${login.failed}; looking for claude on the PATH Rundock was started with`);
    return { bin: todaysLookup(deadline) };
  }
  // The shell answered, so its PATH and the install folders are the whole
  // search: an answer that names no copy is no copy, and today's lookup
  // stands in only for a shell that cannot answer.
  const extra = deps.installFolders().filter((dir) => !login.dirs.includes(dir));
  return firstNotBelowFloor(executablesAlong([...login.dirs, ...extra]), versionPlatform);
}

// THE CHOSEN COPY, kept for the process. It is let go when the floor refuses
// it (forget, from floorRefusal) or when it is no longer there, so the next
// lookup asks the shell again, and it is never reused for a different PATH,
// SHELL or HOME than it was found with. `retryMissing` looks again when the
// kept answer is that there is no copy: an install check asks while the
// person installs, and the shell's own answer is kept a minute meanwhile
// (loginShellPath).
let kept = null;
let looks = 0;
function lookupClaude({ versionPlatform = deps.platform(), retryMissing = false } = {}) {
  const key = JSON.stringify([deps.platform(), versionPlatform, process.env.SHELL, process.env.HOME, process.env.PATH, deps.startPath]);
  const stillThere = (bin) => (bin ? fs.existsSync(bin) : !retryMissing);
  if (kept && kept.key === key && stillThere(kept.found.bin)) return kept.found;
  looks++;
  kept = { key, found: lookupNow(versionPlatform) };
  if (kept.found.bin) answer = null;
  return kept.found;
}
function forget() { kept = null; answer = null; }

// The desktop app's install check: the copy the lookup chose and what it says
// its version is, read with no shell, and read again on a later check. null
// when there is no copy, or when it gives no version, as a copy that could
// not be run always counted; a Windows launcher whose package names no
// version still counts as found, as it did when it was run through a shell.
function installedClaude(platform = deps.platform()) {
  const before = looks;
  const { bin, versionText } = lookupClaude({ versionPlatform: platform, retryMissing: true });
  if (!bin) return null;
  // A lookup that has just read the copy it chose is not asked again.
  const justRead = looks !== before && typeof versionText === 'string';
  const said = justRead ? versionText : readClaudeVersion(bin, VERSION_PROBE_TIMEOUT_MS, platform);
  if (said === null && !(platform === 'win32' && /\.(cmd|bat)$/i.test(bin))) return null;
  return { bin, version: said };
}

// HOW A COPY IS STARTED, for every spawn and the desktop app's sign-in
// check: the command, and the arguments that go before the caller's own. A
// copy is started itself, with its arguments and never through a shell,
// except that a Windows .cmd or .bat cannot be: Node refuses to start one
// without cmd.exe (EINVAL), and cmd.exe would read the prompt in the
// arguments as part of a command. An npm install is such a launcher,
// `%APPDATA%\npm\claude.cmd`, and it starts the package npm installed beside
// it. So the package is started as the launcher would start it: its entry,
// named by `bin` in its package.json, run itself when it is an .exe, or by
// the node.exe beside the launcher when there is one, as npm's launcher
// prefers, otherwise by the first node.exe `where.exe` lists, by its full
// path. An entry that resolves outside the package folder, through `..` or a
// link, is refused. When any of that fails, the launcher itself is returned,
// as before, and that is logged once for its package.
const NODE_LOOKUP_TIMEOUT_MS = 5000;
const launchesLogged = new Set();
function launchFor(bin, platform = deps.platform()) {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(bin)) return { command: bin, args: [] };
  const pkgDir = path.join(path.dirname(bin), ...NPM_PACKAGE);
  try {
    const entry = packageEntry(pkgDir);
    if (/\.exe$/i.test(entry)) return { command: entry, args: [] };
    return { command: nodeFor(bin), args: [entry] };
  } catch (e) {
    if (!launchesLogged.has(pkgDir)) {
      launchesLogged.add(pkgDir);
      console.warn(`[claude-lookup] could not start Claude Code from its package at ${pkgDir}: ${e.message}; starting its launcher instead`);
    }
    return { command: bin, args: [] };
  }
}
const isFile = (file) => { try { return fs.statSync(file).isFile(); } catch (e) { return false; } };
// The package's own entry, by its real path, inside the package folder.
function packageEntry(pkgDir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf-8'));
  const named = pkg && (typeof pkg.bin === 'string' ? pkg.bin : pkg.bin && pkg.bin.claude);
  if (typeof named !== 'string' || !named) throw new Error('its package.json names no claude entry');
  const root = fs.realpathSync(pkgDir);
  const entry = fs.realpathSync(path.resolve(pkgDir, named));
  const inside = path.relative(root, entry);
  if (!inside || inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
    throw new Error(`its entry ${named} is outside the package`);
  }
  if (!isFile(entry)) throw new Error(`its entry ${named} is not a file`);
  return entry;
}
// The node.exe beside the launcher, or the first node.exe where.exe lists.
function nodeFor(bin) {
  const beside = path.join(path.dirname(bin), 'node.exe');
  if (isFile(beside)) return beside;
  const { execFileSync } = require('child_process');
  const listed = execFileSync('where.exe', ['node.exe'], { timeout: NODE_LOOKUP_TIMEOUT_MS, encoding: 'utf-8', stdio: codexRuntime.PROBE_STDIO });
  const found = listed.split(/\r?\n/).map((line) => line.trim()).find((line) => path.isAbsolute(line) && /node\.exe$/i.test(line) && isFile(line));
  if (!found) throw new Error('no node.exe was found to start it with');
  return found;
}

module.exports = {
  wireLookupDeps, installFolders, addInstallFolders, readClaudeVersion, VERSION_PROBE_TIMEOUT_MS,
  LOGIN_SHELL_TIMEOUT_MS, LOGIN_SHELL_COMMAND, SHELL_ENV, loginShellPath, markedPath, executablesAlong,
  lookupClaude, forget, installedClaude, launchFor,
};
