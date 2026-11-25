// The desktop's Claude Code setup check: is it installed, does it start, is
// it signed in.
//
// The setup screen polls this while the person installs Claude Code, so
// nothing here may hold the main process: every child is started
// asynchronously, without a shell, and overlapping requests share the check
// already running. On Windows the folder Claude Code was found in is added to
// the User PATH as soon as it is found, before Claude Code is first started,
// since that first start can be slow while Windows scans a newly downloaded
// program, and a new PowerShell window should recognise `claude` either way.
//
// Pure of Electron: electron/main.js passes in what it knows. Every effect
// goes through `deps`, which tests replace in-process.

'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const { launchPlan, CLAUDE_CODE } = require('../lib/runtime/npm-launcher.js');
const { ensureClaudeFolders } = require('../lib/runtime/claude-folders.js');

// What one child may print on each stream before it is stopped.
const OUTPUT_CAP_BYTES = 1024 * 1024;

const deps = {
  spawn: childProcess.spawn,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (timer) => clearTimeout(timer),
  now: () => Date.now(),
  fs,
  launchPlan,
  execPath: () => process.execPath,
  inElectron: () => Boolean(process.versions && process.versions.electron),
  extendPath: (env, { platform }) => ensureClaudeFolders(env, { platform }),
  timeouts: { lookup: 5000, version: 30000 },
};

// One child, started as a program and its arguments with no shell. Resolves
// { stdout, stderr } on exit 0. Rejects, with messages that never carry a path
// or output: { code: 'ETIMEDOUT' } when still running at `ms` (it is killed),
// { code: 'ENOBUFS' } when it prints past the cap (killed too), the error of a
// start that failed, or { status, signal } for any other exit; each with the
// output so far as stdout and stderr.
function runChild(program, args, env, ms) {
  return new Promise((resolve, reject) => {
    const out = { stdout: [], stderr: [] };
    const size = { stdout: 0, stderr: 0 };
    const output = () => ({ stdout: Buffer.concat(out.stdout), stderr: Buffer.concat(out.stderr) });
    let child = null;
    let timer = null;
    let done = false;
    const finish = (settle, value) => {
      if (done) return;
      done = true;
      deps.clearTimeout(timer);
      settle(value);
    };
    const stop = (code, message) => {
      try { child.kill(); } catch { /* already gone */ }
      finish(reject, Object.assign(new Error(message), { code }, output()));
    };
    try {
      child = deps.spawn(program, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      finish(reject, err);
      return;
    }
    timer = deps.setTimeout(() => stop('ETIMEDOUT', 'the child timed out'), ms);
    for (const name of ['stdout', 'stderr']) {
      child[name].on('data', (chunk) => {
        size[name] += chunk.length;
        if (size[name] > OUTPUT_CAP_BYTES) stop('ENOBUFS', 'the child printed past the cap');
        else out[name].push(chunk);
      });
    }
    child.once('error', (err) => finish(reject, err));
    child.once('close', (status, signal) => {
      if (status === 0) finish(resolve, output());
      else finish(reject, Object.assign(new Error('the child exited with a failure'), { status, signal }, output()));
    });
  });
}

// The copy a lookup's output names, chosen as the desktop always has: on
// Windows `where.exe` may list several, and a claude.exe from the PowerShell
// installer wins over an npm claude.cmd; elsewhere `which` names one.
function chooseCandidate(output, platform) {
  const text = String(output).trim();
  if (!text) return null;
  if (platform !== 'win32') return text;
  const candidates = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const exe = candidates.find((c) => c.toLowerCase().endsWith('.exe'));
  const cmd = candidates.find((c) => c.toLowerCase().endsWith('.cmd'));
  return exe || cmd || candidates[0] || null;
}

// One entry of the User PATH, or the folder, in the form two are compared in:
// Windows paths ignore case, and one trailing backslash names the same folder.
const comparable = (entry) => entry.toLowerCase().replace(/\\$/, '');

// %NAME% references expanded from `env`, with Windows' case-insensitive names.
// A name with no value is left as written, as Windows leaves it.
function expandNames(entry, env) {
  return entry.replace(/%([^%;]+)%/g, (whole, name) => {
    const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
    return key === undefined ? whole : String(env[key]);
  });
}

// The User PATH to write so that it holds `folder`, or null for no change.
// `raw` is the value as stored, unexpanded. Every existing entry is kept byte
// for byte and in order, empty ones and %NAME% references included, and the
// folder is appended only when no entry already names it.
function mergeUserPath(raw, folder, env) {
  const text = raw == null ? '' : String(raw);
  if (!text) return folder;
  const want = comparable(folder);
  if (text.split(';').some((entry) => comparable(expandNames(entry, env)) === want)) return null;
  const separator = text.endsWith(';') ? '' : ';';
  return text + separator + folder;
}

// `platform` and `env` are the app's own (process.platform, process.env): the
// install folders are added to `env`'s PATH before each lookup, and every
// child is given a copy of it at the moment it starts.
function createSetupCheck({ platform = process.platform, env = process.env } = {}) {
  let found = { bin: null, version: null };

  // The environment a start of the found copy is given. A plan whose program
  // is the app itself (a claude.cmd, run through its package's entry) runs as
  // Node only with ELECTRON_RUN_AS_NODE: without it the app would open a
  // second window. launchPlan adds that only once setup is over, so it is
  // added here, for this start only.
  function startEnv(plan) {
    const asNode = deps.inElectron() && plan.program === deps.execPath() ? { ELECTRON_RUN_AS_NODE: '1' } : {};
    return { ...env, ...(plan.env || {}), ...asNode };
  }

  async function lookup() {
    try { deps.extendPath(env, { platform }); } catch { /* the lookup searches PATH as it is */ }
    try {
      const { stdout } = await runChild(platform === 'win32' ? 'where.exe' : 'which', ['claude'], { ...env }, deps.timeouts.lookup);
      return chooseCandidate(stdout, platform);
    } catch {
      return null;
    }
  }

  async function run() {
    found = { bin: null, version: null };
    const bin = await lookup();
    if (!bin) return { status: 'not-installed' };
    const plan = deps.launchPlan(bin, CLAUDE_CODE, { platform, execPath: deps.execPath() });
    if (!plan || plan.refusal) return { status: 'found-not-started' };
    let version;
    try {
      const { stdout } = await runChild(plan.program, [...plan.args, '--version'], startEnv(plan), deps.timeouts.version);
      version = stdout.toString('utf8');
    } catch {
      return { status: 'found-not-started' };
    }
    found = { bin, version };
    return { status: 'started' };
  }

  return {
    check: () => run(),
    // The copy the last check started, and the version it gave, for Sign in.
    found: () => ({ ...found }),
  };
}

module.exports = { OUTPUT_CAP_BYTES, deps, runChild, chooseCandidate, mergeUserPath, createSetupCheck };
