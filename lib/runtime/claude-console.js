'use strict';
// RECONNECTING CLAUDE CODE WITHOUT A TERMINAL: the console a person reconnects
// in, opened for them running Claude Code, and the check that says whether they
// have. One definition of the console, used by the desktop app (its first-run
// wizard and the chat's reconnect card, electron/main.js) and by the server for
// a browser running Rundock from source (lib/http-router.js).
//
// Opening a window on someone's machine is a privileged act, so the server's
// route is one of the closed ones: only Rundock's own window reaches it, never
// an agent or the permission hook's token (lib/auth).
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CHECK_TIMEOUT_MS = 45000;

function onPath(name, env) {
  return String((env && env.PATH) || '').split(path.delimiter).filter(Boolean)
    .some((dir) => { try { fs.accessSync(path.join(dir, name), fs.constants.X_OK); return true; } catch (e) { return false; } });
}

// WHAT EACH CONSOLE IS, by what it was opened for: its title where the system
// shows one (Windows), and the words Claude Code is started with. Only these
// fixed words ever reach the command line. The first-run wizard's console runs
// `claude` bare, which offers to log in the first time it runs. The reconnect
// card's runs Claude Code's own login command, `claude auth login`, which goes
// straight to the browser: with a stored session that is refused, a bare
// `claude` can start ready to chat and only say "Please run /login" once a
// message is sent.
const CONSOLE_TITLES = { signin: 'Sign in to Claude', reconnect: 'Reconnect Claude' };
const CONSOLE_WORDS = { signin: [], reconnect: ['auth', 'login'] };

// ONLY WHERE CLAUDE CODE HAS IT. `claude auth login` arrived in Claude Code
// 2.1.41 (its changelog: "Added `claude auth login`, `claude auth status`,
// and `claude auth logout` CLI subcommands"), and Rundock declares no minimum
// Claude Code version. So the console's words are given only to a version
// known to be 2.1.41 or later: an older one, or one whose version is not
// known, runs `claude` bare, as before, rather than a command it does not
// have. `version` is what `claude --version` says, or the number read from it.
const AUTH_LOGIN_SINCE = [2, 1, 41];
function hasAuthLogin(version) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(version == null ? '' : version));
  if (!m) return false;
  for (let i = 0; i < 3; i++) {
    const n = Number(m[i + 1]);
    if (n !== AUTH_LOGIN_SINCE[i]) return n > AUTH_LOGIN_SINCE[i];
  }
  return true;
}

// macOS's Terminal runs a file it is opened on and takes no words after it,
// and driving it by AppleScript raises an Automation prompt. So where Claude
// Code needs words, Terminal is opened on a script whose whole content is
// fixed: the shell line and `exec '<path>' auth login`. It lives under the
// home folder, as the check runs there, in a folder only this account can
// use: never the temp folder, which a variable names and some systems share
// with every account. It is left in place, because Terminal reads it after
// `open` returns, and replaced on the next reconnect.
const CONSOLE_SCRIPT_DIR = '.rundock-console';
const CONSOLE_SCRIPT_NAME = 'Reconnect Claude.command';

// The script's two lines. In single quotes the shell takes every character as
// written but the quote itself, which is closed, escaped and opened again.
function consoleScript(bin, words) {
  return `#!/bin/sh\nexec '${String(bin).split("'").join("'\\''")}' ${words.join(' ')}\n`;
}

// What to start on this platform, or null where Rundock cannot open a console:
// a Linux session with no display or no terminal to hand, or another system.
// `purpose` is one of CONSOLE_TITLES' names; anything else is the wizard's.
// `version` is Claude Code's (hasAuthLogin). On macOS, a console that needs
// words also carries the script to write first (writeConsoleScript), under
// `home`. `found` says whether a program is on the PATH.
function consoleCommand(bin, platform, env, { found = onPath, purpose = 'signin', home, version } = {}) {
  const known = Object.prototype.hasOwnProperty.call(CONSOLE_TITLES, purpose) ? purpose : 'signin';
  const title = CONSOLE_TITLES[known];
  const words = hasAuthLogin(version) ? CONSOLE_WORDS[known] : [];
  if (platform === 'win32') {
    // A new console window that stays open (/k). cmd takes the first and last
    // quote off what follows /k, so the doubled quotes leave the path in its
    // own quotes, tolerating spaces in the user profile path, and the words
    // after it outside them.
    const line = [`"${bin}"`, ...words].join(' ');
    return { command: `start "${title}" cmd /k "${line}"`, args: [], options: { shell: true } };
  }
  if (platform === 'darwin') {
    if (!words.length) return { command: 'open', args: ['-a', 'Terminal', bin], options: {} };
    const file = path.join(home || os.homedir(), CONSOLE_SCRIPT_DIR, CONSOLE_SCRIPT_NAME);
    return { command: 'open', args: ['-a', 'Terminal', file], options: {}, script: { file, content: consoleScript(bin, words) } };
  }
  if (platform === 'linux' && env && (env.DISPLAY || env.WAYLAND_DISPLAY) && found('x-terminal-emulator', env)) {
    // Debian policy for x-terminal-emulator: the words after -e are the
    // program's own arguments, run as by execvp, never one string for a shell.
    return { command: 'x-terminal-emulator', args: ['-e', bin, ...words], options: {} };
  }
  return null;
}

// Write the macOS script, or throw. The folder is made 0700, and one already
// there must be a real folder (never a link) this account owns, closed to
// everyone else before anything is written into it. A leftover at the script's
// path is removed, never followed: unlinking takes away a link itself. The
// script is then made only by exclusive create, which fails on any path that
// exists, a link included, so nothing that appears there in between is ever
// written through. Its mode is set on the open file, whatever the umask.
function writeConsoleScript(file, content, { uid = process.getuid() } = {}) {
  const dir = path.dirname(file);
  try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.uid !== uid) throw new Error('The console script folder is not this account\'s own folder.');
  if ((st.mode & 0o777) !== 0o700) fs.chmodSync(dir, 0o700);
  try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o700);
  try {
    fs.fchmodSync(fd, 0o700);
    fs.writeSync(fd, content);
  } finally { fs.closeSync(fd); }
}

// ONE CONSOLE AT A TIME, AND NOT AGAIN STRAIGHT AWAY. Every press of the
// card's button, and every request to the route, would otherwise open a
// window of its own: ten at once opened ten. So the opener keeps a gate: while
// a console is opening, every ask gets that one's answer, and for a short
// pause after one has opened, an ask is answered by the window already open.
// One gate is shared by every caller, the server's route and the desktop's
// channel alike, because both open through this function and pass none.
const OPEN_COOLDOWN_MS = 3000;
function consoleGate() { return { opening: null, openedAt: null }; }
const SHARED_GATE = consoleGate();

// Open it: { ok: true }, or { ok: false, reason: 'not-found' | 'unsupported' |
// 'failed' }. A bare `claude` is what a failed lookup leaves, so only a path
// counts as found. Never throws, and a start that fails later is answered
// rather than left as an unhandled error event. `purpose` chooses the console
// (CONSOLE_TITLES, CONSOLE_WORDS); anything else is the wizard's. `home` is
// where the macOS script goes, the home folder unless a test names another.
//
// Claude Code is given as `bin`, or as `findBin`, a lookup run only once the
// gate has let an ask through: on the desktop that lookup runs a command on
// the main process, so an ask while a console opens, or during the pause,
// costs nothing. Its version is given as `version`, or as `findVersion`, asked
// only once Claude Code has been found; a lookup that throws leaves it unknown.
function openClaudeConsole({ bin, findBin, version, findVersion, platform = process.platform, env = process.env, spawn = require('node:child_process').spawn, purpose = 'signin', gate = SHARED_GATE, now = Date.now, home }) {
  if (gate.opening) return gate.opening;
  const t = now();
  if (gate.openedAt !== null && t >= gate.openedAt && t - gate.openedAt < OPEN_COOLDOWN_MS) return Promise.resolve({ ok: true });
  let found = bin;
  if (found === undefined && typeof findBin === 'function') {
    try { found = findBin(); } catch (e) { found = null; }
  }
  if (!found || !path.isAbsolute(found)) return Promise.resolve({ ok: false, reason: 'not-found' });
  // A line break or NUL in the path would end the line it is written into,
  // the script's or cmd's, and start another: refused, on every platform.
  if (/[\0\r\n]/.test(found)) return Promise.resolve({ ok: false, reason: 'failed' });
  let ver = version;
  if (ver === undefined && typeof findVersion === 'function') {
    try { ver = findVersion(); } catch (e) { ver = null; }
  }
  let c;
  try {
    c = consoleCommand(found, platform, env, { purpose, home, version: ver });
    if (c && c.script) writeConsoleScript(c.script.file, c.script.content);
  } catch (e) { return Promise.resolve({ ok: false, reason: 'failed' }); }
  if (!c) return Promise.resolve({ ok: false, reason: 'unsupported' });
  const p = new Promise((resolve) => {
    let child;
    try { child = spawn(c.command, c.args, { ...c.options, detached: true, stdio: 'ignore' }); } catch (e) { resolve({ ok: false, reason: 'failed' }); return; }
    child.once('error', () => resolve({ ok: false, reason: 'failed' }));
    child.once('spawn', () => { child.unref(); gate.openedAt = now(); resolve({ ok: true }); });
  });
  gate.opening = p;
  p.then(() => { if (gate.opening === p) gate.opening = null; });
  return p;
}

// Whether an IPC message came from the main window's own page: sent by its
// webContents and, within that, by its top frame, so neither another window
// nor a frame the page hosts can ask for a console.
function fromMainFrame(event, win) {
  const contents = win && win.webContents;
  return !!(contents && event && event.sender === contents && event.senderFrame && event.senderFrame === contents.mainFrame);
}

// WHETHER CLAUDE CODE IS CONNECTED, asked only when the person says they have
// reconnected. Nothing cheaper can tell: a stored credential can be present and
// refused. So this is the first-run wizard's own check, one short turn, and it
// is never run in the background. One at a time.
//
// `known` is false when the check could not run, ran too long, or failed for
// a reason that is not the sign-in: a dropped connection or a busy service
// says nothing about whether Claude Code is signed in, so only a failure whose
// words `isAuthFailure` recognises counts as signed out.
//
// IT RUNS FROM THE HOME FOLDER. `--print` skips the trust prompt, so any
// project settings and hooks in the folder a turn runs in would run unasked.
// The temp folder is no place for that: on Linux it is /tmp, which every
// account on the machine can write to. The home folder's settings are the
// person's own.
const CHECK_OUTPUT_MAX = 16 * 1024;
let inFlight = null;
function checkConnection({ bin, spawn = require('node:child_process').spawn, timeoutMs = CHECK_TIMEOUT_MS, isAuthFailure = () => false }) {
  if (inFlight) return inFlight;
  const p = new Promise((resolve) => {
    let child = null;
    let timer = null;
    let done = false;
    let said = '';
    const finish = (connected, known) => {
      if (done) return;
      done = true; clearTimeout(timer); resolve({ connected, known });
    };
    const hear = (chunk) => { if (said.length < CHECK_OUTPUT_MAX) said += String(chunk); };
    const signedOut = () => { try { return !!isAuthFailure(said); } catch (e) { return false; } };
    try {
      child = spawn(bin, ['--print', 'test', '--output-format', 'text'], { cwd: os.homedir(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) { finish(false, false); return; }
    if (child.stdout) child.stdout.on('data', hear);
    if (child.stderr) child.stderr.on('data', hear);
    timer = setTimeout(() => { try { child.kill(); } catch (e) { /* already gone */ } finish(false, false); }, timeoutMs);
    child.once('error', () => finish(false, false));
    child.once('close', (code) => (code === 0 ? finish(true, true) : finish(false, signedOut())));
  });
  // RELEASED ONLY ONCE IT HOLDS THIS CHECK. A start that throws settles the
  // promise before the constructor returns, so clearing inside `finish` ran
  // before the assignment below and left the settled check in place for good.
  inFlight = p;
  p.then(() => { if (inFlight === p) inFlight = null; });
  return p;
}

module.exports = {
  consoleCommand, openClaudeConsole, consoleGate, fromMainFrame, checkConnection, writeConsoleScript,
  CONSOLE_TITLES, CONSOLE_WORDS, AUTH_LOGIN_SINCE, OPEN_COOLDOWN_MS, CHECK_TIMEOUT_MS,
};
