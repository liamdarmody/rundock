'use strict';
// Starting a runtime that npm installed on Windows, through Node and never a
// shell.
//
// npm puts a launcher on PATH on Windows, `%APPDATA%\npm\claude.cmd` or
// `codex.cmd`: a batch file that starts the package's entry point with Node.
// Node refuses to start a .cmd or .bat without a shell (EINVAL), and a shell
// would read `&`, `|`, `%` and `^` in the arguments, which carry prompts, as
// part of a command. So the launcher is never started. The entry point it
// would start is read from the package npm installed beside it, kept inside
// that package's folder, and started with the Node Rundock runs on, so the
// prompt only ever travels in the argument array.
//
// Anything else, a .exe on Windows and every binary on macOS and Linux, is
// started as it was found, with nothing read and nothing added.
//
// Nothing here is remembered between starts: a package fixed after a refusal
// is read again, and starts, on the next one.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough, Writable } = require('stream');

const CLAUDE_CODE = { command: 'claude', pkg: '@anthropic-ai/claude-code', label: 'Claude Code' };
const CODEX = { command: 'codex', pkg: '@openai/codex', label: 'Codex' };

// Where npm installs the package a launcher starts: beside it, in node_modules.
function packageFolder(bin, runtime) {
  return path.join(path.dirname(bin), 'node_modules', ...runtime.pkg.split('/'));
}

// The entry point the package names for the runtime's command, as a real path
// to a file inside the package's real folder. Throws on anything else.
function entryPoint(bin, runtime) {
  const folder = fs.realpathSync(packageFolder(bin, runtime));
  const pkg = JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf-8'));
  const bins = pkg && pkg.bin;
  const named = typeof bins === 'string' ? bins : (bins && typeof bins === 'object' && !Array.isArray(bins) ? bins[runtime.command] : null);
  if (typeof named !== 'string' || !named) throw new Error(`no bin entry for ${runtime.command}`);
  const entry = fs.realpathSync(path.resolve(folder, named));
  const inside = path.relative(folder, entry);
  if (!inside || inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) throw new Error(`${named} is outside the package`);
  if (!fs.statSync(entry).isFile()) throw new Error(`${named} is not a file`);
  return entry;
}

function packageUnreadable(bin, runtime, cause) {
  const { label, pkg } = runtime;
  const err = new Error(`Rundock found ${label} at ${bin}, but could not read the ${label} package installed beside it, `
    + `so it was not started. Reinstall ${label} with npm install -g ${pkg}, then try again.`);
  err.code = 'NPM_PACKAGE_UNREADABLE';
  err.path = bin;
  err.cause = cause;
  return err;
}

// What to start for the binary a lookup found: { program, args, env }, where
// args go before the caller's own and env, when not null, is added to the
// environment the start is given. Or { refusal }, an error to surface in
// place of a start. Inside the Electron app, `execPath` is the app itself,
// which acts as Node only with ELECTRON_RUN_AS_NODE set.
function launchPlan(bin, runtime, { platform = process.platform, execPath = process.execPath } = {}) {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(String(bin))) return { program: bin, args: [], env: null };
  let entry;
  try { entry = entryPoint(bin, runtime); } catch (e) { return { refusal: packageUnreadable(bin, runtime, e) }; }
  if (/\.exe$/i.test(entry)) return { program: entry, args: [], env: null };
  return { program: execPath, args: [entry], env: process.env.RUNDOCK_ELECTRON ? { ELECTRON_RUN_AS_NODE: '1' } : null };
}

// What a refused start hands back in place of a process: shaped like one that
// could not start, as a missing binary is. It errors and then closes once the
// caller has attached its listeners, so each path's own error surface says
// why, and its close handler sees a spawn that failed.
function unstarted(refusal) {
  const proc = Object.assign(new EventEmitter(), {
    pid: undefined,
    stdin: new Writable({ write: (chunk, encoding, done) => done() }),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => false,
  });
  process.nextTick(() => { proc.emit('error', refusal); proc.emit('close', null, null); });
  return proc;
}

module.exports = { CLAUDE_CODE, CODEX, packageFolder, launchPlan, unstarted };
