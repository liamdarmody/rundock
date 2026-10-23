'use strict';
// RECONNECTING CLAUDE CODE WITHOUT A TERMINAL: the console a person reconnects
// in, opened for them running `claude`, and the check that says whether they
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

// What to start on this platform, or null where Rundock cannot open a console:
// a Linux session with no display or no terminal to hand, or another system.
function consoleCommand(bin, platform, env, found = onPath) {
  if (platform === 'win32') {
    // A new console window that stays open (/k). The doubled quotes around the
    // path tolerate spaces in the user profile path.
    return { command: `start "Sign in to Claude" cmd /k ""${bin}""`, args: [], options: { shell: true } };
  }
  if (platform === 'darwin') return { command: 'open', args: ['-a', 'Terminal', bin], options: {} };
  if (platform === 'linux' && env && (env.DISPLAY || env.WAYLAND_DISPLAY) && found('x-terminal-emulator', env)) {
    return { command: 'x-terminal-emulator', args: ['-e', bin], options: {} };
  }
  return null;
}

// Open it: { ok: true }, or { ok: false, reason: 'not-found' | 'unsupported' |
// 'failed' }. A bare `claude` is what a failed lookup leaves, so only a path
// counts as found. Never throws, and a start that fails later is answered
// rather than left as an unhandled error event.
function openClaudeConsole({ bin, platform = process.platform, env = process.env, spawn = require('node:child_process').spawn }) {
  if (!bin || !path.isAbsolute(bin)) return Promise.resolve({ ok: false, reason: 'not-found' });
  const c = consoleCommand(bin, platform, env);
  if (!c) return Promise.resolve({ ok: false, reason: 'unsupported' });
  return new Promise((resolve) => {
    let child;
    try { child = spawn(c.command, c.args, { ...c.options, detached: true, stdio: 'ignore' }); } catch (e) { resolve({ ok: false, reason: 'failed' }); return; }
    child.once('error', () => resolve({ ok: false, reason: 'failed' }));
    child.once('spawn', () => { child.unref(); resolve({ ok: true }); });
  });
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

module.exports = { consoleCommand, openClaudeConsole, checkConnection, CHECK_TIMEOUT_MS };
