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
// Each step is logged to setup-check.log in the app's user-data folder, as a
// fixed word and a time: never a path, output or error text, so the file is
// safe to hand over unread.
//
// Pure of Electron: electron/main.js passes in what it knows. Every effect
// goes through `deps`, which tests replace in-process.

'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { launchPlan, CLAUDE_CODE } = require('../lib/runtime/npm-launcher.js');
const { ensureClaudeFolders } = require('../lib/runtime/claude-folders.js');
const { createSignInReason } = require('./sign-in-reason.js');

// What one child may print on each stream before it is stopped.
const OUTPUT_CAP_BYTES = 1024 * 1024;

// The sign-in check, as the desktop has always run it.
const SIGN_IN_ARGS = ['--print', 'test', '--output-format', 'text'];

const LOG_FILE = 'setup-check.log';
const LOG_LINES = 200;

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
  timeouts: { lookup: 5000, pathWrite: 15000, version: 30000, signIn: 15000 },
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

// The User PATH is read and written by two fixed PowerShell scripts. Each is
// one line with no double quote, so its one argument needs no escaping, and a
// value reaches it only through the child's environment: nothing a folder
// holds can become code. The read prints the value's kind and its raw text,
// unexpanded, as base64. The write reads the value again and writes nothing
// when it or its kind has changed since, sets it in one call, and tells every
// window the environment changed, so a new PowerShell window sees it.
const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];
const READ_RAW = "if ($k -and ($k.GetValueNames() -contains 'Path')) { $kind = [string]$k.GetValueKind('Path'); $v = [string]$k.GetValue('Path', '', 'DoNotExpandEnvironmentNames') }";
const READ_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')",
  "$kind = 'Missing'", "$v = ''", READ_RAW,
  "[Console]::Out.Write($kind + ':' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($v)))",
].join('; ');
const WRITE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')",
  "$kind = 'Missing'", "$v = ''", READ_RAW,
  "if ($kind -cne [string]$env:SETUP_CHECK_PATH_KIND -or $v -cne [string]$env:SETUP_CHECK_PATH_OLD) { [Console]::Out.Write('stale'); exit 0 }",
  "$k.SetValue('Path', [string]$env:SETUP_CHECK_PATH_NEW, [Microsoft.Win32.RegistryValueKind][string]$env:SETUP_CHECK_PATH_WRITE_KIND)",
  '$k.Close()',
  "Add-Type -Namespace SetupCheck -Name Native -MemberDefinition ('[DllImport(' + [char]34 + 'user32.dll' + [char]34 + ', CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);')",
  '$r = [UIntPtr]::Zero',
  "[void][SetupCheck.Native]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$r)",
  "[Console]::Out.Write('written')",
].join('; ');
// The kinds a PATH can be written back as. Any other is left alone.
const WRITABLE_KINDS = new Set(['Missing', 'String', 'ExpandString']);

// The outcome word a failed start of the found copy is logged as.
const startOutcome = (err) => {
  if (err.code === 'ETIMEDOUT') return 'timeout';
  return err.status === undefined && err.code !== 'ENOBUFS' ? 'not-started' : 'failed';
};
const SIGN_IN_OUTCOMES = { timeout: 'timeout', 'not-started': 'not-started' };

// `platform` and `env` are the app's own (process.platform, process.env): the
// install folders are added to `env`'s PATH before each lookup, and every
// child is given a copy of it at the moment it starts. `extendPath`, when
// given, adds them in place of that: main.js passes the ensurePath it has
// always run. `appData` is the folder the log is kept in; with none, nothing
// is logged. `shellConfigDir` routes the sign-in check (it may run it again
// with CLAUDE_CONFIG_DIR read from the login shell), and `signInReason` keeps
// why it last failed.
function createSetupCheck({
  platform = process.platform,
  env = process.env,
  appData = null,
  shellConfigDir = { checkAuthenticated: (run) => run() },
  signInReason = createSignInReason(),
  extendPath = null,
} = {}) {
  let found = { bin: null, version: null };
  // The check running for each kind of request, joined by the next like it.
  const running = new Map();
  // Folders found on the User PATH or written to it in this run of the app,
  // which are not read or written again. A write that failed is not here, so
  // the next check tries it again.
  const onUserPath = new Set();

  // The environment a start of the found copy is given. A plan whose program
  // is the app itself (a claude.cmd, run through its package's entry) runs as
  // Node only with ELECTRON_RUN_AS_NODE: without it the app would open a
  // second window. launchPlan adds that only once setup is over, so it is
  // added here, for this start only.
  function startEnv(plan) {
    const asNode = deps.inElectron() && plan.program === deps.execPath() ? { ELECTRON_RUN_AS_NODE: '1' } : {};
    return { ...env, ...(plan.env || {}), ...asNode };
  }

  // One line per step: an ISO time, the step, a fixed word and the elapsed
  // milliseconds. A log that cannot be written is let go: it never fails the
  // check, and nothing waits on it.
  function log(step, outcome, start) {
    const end = deps.now();
    if (!appData) return;
    try {
      const file = path.join(appData, LOG_FILE);
      let lines = [];
      try { lines = deps.fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { /* a new log */ }
      lines.push(`${new Date(end).toISOString()} ${step} ${outcome} ${Math.max(0, end - start)}ms`);
      deps.fs.writeFileSync(file, lines.slice(-LOG_LINES).join('\n') + '\n');
    } catch { /* the check goes on without its log */ }
  }

  async function lookup() {
    const start = deps.now();
    try {
      if (extendPath) extendPath(); else deps.extendPath(env, { platform });
    } catch { /* the lookup searches PATH as it is */ }
    try {
      const { stdout } = await runChild(platform === 'win32' ? 'where.exe' : 'which', ['claude'], { ...env }, deps.timeouts.lookup);
      const bin = chooseCandidate(stdout, platform);
      log('lookup', bin ? 'found' : 'none', start);
      return bin;
    } catch (err) {
      log('lookup', err.code === 'ETIMEDOUT' ? 'timeout' : err.status === undefined ? 'failed' : 'none', start);
      return null;
    }
  }

  // The sign-in check on the copy that was started, through the routing that
  // may run it again. Its reason, when it fails, is what the holder kept, as
  // main reads it: null when nothing was kept.
  async function signIn(plan) {
    const start = deps.now();
    const passed = await shellConfigDir.checkAuthenticated(async () => {
      try {
        await runChild(plan.program, [...plan.args, ...SIGN_IN_ARGS], startEnv(plan), deps.timeouts.signIn);
        signInReason.passed();
        return true;
      } catch (err) {
        signInReason.failed(err);
        return false;
      }
    });
    const reason = passed ? null : signInReason.last();
    log('sign-in', passed ? 'passed' : SIGN_IN_OUTCOMES[reason && reason.kind] || 'failed', start);
    return passed ? { status: 'ready' } : { status: 'not-authenticated', reason };
  }

  // Adds `folder` to the User PATH. Never throws: it says what it did, and a
  // failure leaves the check to go on.
  async function writeUserPath(folder) {
    const key = comparable(folder);
    if (onUserPath.has(key)) return 'present';
    const powershell = (script, extra, ms) => runChild('powershell.exe', [...POWERSHELL_ARGS, script], { ...env, ...extra }, ms);
    let kind;
    let raw;
    try {
      const { stdout } = await powershell(READ_SCRIPT, {}, deps.timeouts.pathWrite);
      const read = /^(\w+):([A-Za-z0-9+/]*={0,2})$/.exec(stdout.toString('utf8').trim());
      if (!read) return 'failed';
      [, kind] = read;
      raw = Buffer.from(read[2], 'base64').toString('utf8');
    } catch (err) {
      return err.code === 'ETIMEDOUT' ? 'timeout' : 'failed';
    }
    if (!WRITABLE_KINDS.has(kind)) return 'skipped';
    const next = mergeUserPath(kind === 'Missing' ? null : raw, folder, env);
    if (next === null) { onUserPath.add(key); return 'present'; }
    try {
      const { stdout } = await powershell(WRITE_SCRIPT, {
        SETUP_CHECK_PATH_KIND: kind,
        SETUP_CHECK_PATH_OLD: raw,
        SETUP_CHECK_PATH_NEW: next,
        SETUP_CHECK_PATH_WRITE_KIND: kind === 'String' ? 'String' : 'ExpandString',
      }, deps.timeouts.pathWrite);
      const said = stdout.toString('utf8').trim();
      if (said === 'written') { onUserPath.add(key); return 'written'; }
      return said === 'stale' ? 'stale' : 'failed';
    } catch (err) {
      return err.code === 'ETIMEDOUT' ? 'timeout' : 'failed';
    }
  }

  // `found` changes only as a check ends, so Sign in during a check has the
  // last one's copy and version: kept when this one started its copy, and
  // cleared when it found none or could not start it.
  async function run(withSignIn) {
    const bin = await lookup();
    if (!bin) { found = { bin: null, version: null }; return { status: 'not-installed' }; }
    // Before the first start, which on Windows can be slow.
    if (platform === 'win32') {
      const start = deps.now();
      log('path-write', await writeUserPath(path.win32.dirname(bin)), start);
    }
    const start = deps.now();
    const plan = deps.launchPlan(bin, CLAUDE_CODE, { platform, execPath: deps.execPath() });
    if (!plan || plan.refusal) { log('version', 'refused', start); found = { bin: null, version: null }; return { status: 'found-not-started' }; }
    let version;
    try {
      const { stdout } = await runChild(plan.program, [...plan.args, '--version'], startEnv(plan), deps.timeouts.version);
      version = stdout.toString('utf8');
    } catch (err) {
      found = { bin: null, version: null };
      log('version', startOutcome(err), start);
      return { status: 'found-not-started' };
    }
    log('version', 'started', start);
    const result = withSignIn ? await signIn(plan) : { status: 'started' };
    found = { bin, version };
    return result;
  }

  return {
    // { status }: not-installed, found-not-started, then started when asked
    // not to sign in, else ready or not-authenticated with its reason. A
    // request while a check of its kind runs joins it; one after it ends
    // starts afresh.
    check({ signIn: withSignIn = true } = {}) {
      const kind = withSignIn ? 'sign-in' : 'start';
      if (running.has(kind)) { log('request', 'joined', deps.now()); return running.get(kind); }
      const check = run(withSignIn).finally(() => { running.delete(kind); });
      running.set(kind, check);
      return check;
    },
    // The copy the last check started, and the version it gave, for Sign in.
    found: () => ({ ...found }),
  };
}

module.exports = { OUTPUT_CAP_BYTES, READ_SCRIPT, WRITE_SCRIPT, deps, runChild, chooseCandidate, mergeUserPath, createSetupCheck };
