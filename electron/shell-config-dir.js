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

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const KEY = 'CLAUDE_CONFIG_DIR';
const OUTPUT_CAP_BYTES = 1024 * 1024;
const MARKER_FILE = '.claude-config-dir-from-shell';
const FAILED = Object.freeze({ completed: false });

function accountShell() {
  try { return os.userInfo().shell; } catch { return null; }
}

const deps = {
  spawn: childProcess.spawn,
  shell: () => process.env.SHELL || accountShell() || '/bin/zsh',
  execPath: () => process.execPath,
  timeoutMs: 5000,
  fs,
  home: () => os.homedir(),
  log: (line) => console.log(`[Electron] ${line}`),
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
//
// The value stays in the environment for the rest of the launch, so it must
// also be one that cannot be repointed later unless <home>/.claude itself is:
// <home>/.claude letter for letter, but for one trailing separator and, on
// macOS, the case of the last name, which must then be the same entry on
// disk as <home>/.claude rather than an entry of its own. A link elsewhere
// that leads there, a path through a linked folder, and a path with . or ..
// in it, which the system resolves through links, are each dropped.
function gate(value, { home, platform }) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return null;
  const fold = (p) => (platform === 'darwin' ? p.toLowerCase() : p);
  const name = '.claude';
  const bare = value.endsWith(path.sep) ? value.slice(0, -1) : value;
  try {
    const own = path.join(home, name);
    if (bare.slice(0, -name.length) !== own.slice(0, -name.length) || fold(bare.slice(-name.length)) !== name) return null;
    if (!deps.fs.statSync(value).isDirectory()) return null;
    const entry = deps.fs.lstatSync(bare, { bigint: true });
    const ownEntry = deps.fs.lstatSync(own, { bigint: true });
    if (entry.dev !== ownEntry.dev || entry.ino !== ownEntry.ino) return null;
    const real = fold(deps.fs.realpathSync(value));
    if (real !== fold(deps.fs.realpathSync(path.join(home, '.claude')))) return null;
    return value;
  } catch {
    return null;
  }
}

const quote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

// The JSON between this read's markers, or FAILED when there is none.
function parse(text, token) {
  const open = `<${token}>`;
  const start = text.indexOf(open);
  const end = start === -1 ? -1 : text.indexOf(`</${token}>`, start + open.length);
  if (end === -1) return FAILED;
  try {
    return { completed: true, value: JSON.parse(text.slice(start + open.length, end)) };
  } catch {
    return FAILED;
  }
}

// Runs the login shell once, as a terminal does, with a command that has the
// app's own binary, as Node, print CLAUDE_CONFIG_DIR alone as JSON between two
// markers made for this read. The setting that makes it Node is written into
// the command, after the profile has run, so the profile cannot undo it. The
// opening marker never appears whole in the command, so a shell that echoes
// its command prints no block. Resolves { completed: true, value } when the
// shell exits cleanly having printed this read's block (value null when the
// variable is unset), and FAILED otherwise; a shell that runs too long or
// prints too much has its whole process group killed.
function readShellConfigDir() {
  const token = crypto.randomBytes(16).toString('hex');
  const script = `const t="${token}";process.stdout.write("\\n<"+t+">"+JSON.stringify(process.env.${KEY}??null)+"</"+t+">\\n")`;
  const command = `ELECTRON_RUN_AS_NODE=1 ${quote(deps.execPath())} -e ${quote(script)}`;
  const shell = deps.shell();
  const child = deps.spawn(shell, ['-i', '-l', '-c', command], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  return new Promise((resolve) => {
    const chunks = [];
    let bytes = 0;
    let done = false;
    let timer = null;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (child.stdout) child.stdout.destroy();
      resolve(result);
    };
    const stop = () => {
      if (child.pid > 0) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      }
      finish(FAILED);
    };
    timer = setTimeout(stop, deps.timeoutMs);
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > OUTPUT_CAP_BYTES) return stop();
      chunks.push(chunk);
    });
    child.on('error', () => finish(FAILED));
    child.on('close', (code, signal) => {
      finish(code === 0 && !signal ? parse(Buffer.concat(chunks).toString('utf8'), token) : FAILED);
    });
  });
}

// One per launch. Routes the app's sign-in checks: the first that fails, and
// only the first, reads the shell, and a taken value is followed by that check
// once more. A taken value whose check then passes leaves a marker in the
// app-data folder, so the next launch reads at start-up (atLaunch), before
// anything starts Claude Code. The marker holds a timestamp; it only brings
// the read forward. A read that completes and takes nothing removes it, and
// one that does not finish leaves it as it was.
function createShellConfigDir({ isPackaged, platform, env, appData }) {
  const allowed = mayRun({ isPackaged, platform, env });
  const marker = path.join(appData, MARKER_FILE);
  let used = false;
  let taken = false;
  let remembered = false;

  const remember = () => {
    if (remembered) return;
    remembered = true;
    try { deps.fs.writeFileSync(marker, new Date().toISOString()); } catch { /* read again after a failure */ }
  };
  const forget = () => {
    try { deps.fs.rmSync(marker, { force: true }); } catch { /* removed by the next read */ }
  };

  async function read() {
    used = true;
    if (env[KEY]) return false;
    let result = FAILED;
    try { result = await readShellConfigDir(); } catch { /* as a read that did not finish */ }
    if (!result.completed) {
      deps.log(`Read ${KEY} from the login shell: it did not finish, so nothing was taken`);
      return false;
    }
    const value = gate(result.value, { home: deps.home(), platform });
    if (!value) {
      forget();
      deps.log(`Read ${KEY} from the login shell: nothing was taken`);
      return false;
    }
    env[KEY] = value;
    taken = true;
    deps.log(`Read ${KEY} from the login shell: a value was taken`);
    return true;
  }

  async function check(run, failed, passed) {
    const answer = await run();
    if (!failed(answer)) {
      if (taken && passed(answer)) remember();
      return answer;
    }
    if (!allowed || used) return answer;
    if (!(await read())) return answer;
    const again = await run();
    if (passed(again)) remember();
    return again;
  }

  return {
    async atLaunch() {
      if (!allowed || used) return false;
      let present = false;
      try { present = deps.fs.existsSync(marker); } catch { /* as absent */ }
      return present ? read() : false;
    },
    checkAuthenticated: (run) => check(run, (ok) => ok === false, (ok) => ok === true),
    checkConnection: (run) => check(run, (r) => !!(r && r.known && !r.connected), (r) => !!(r && r.connected)),
  };
}

module.exports = { KEY, OUTPUT_CAP_BYTES, MARKER_FILE, deps, mayRun, gate, readShellConfigDir, createShellConfigDir };
