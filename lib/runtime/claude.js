'use strict';
// Spawn plumbing for the Claude runtime: per-spawn args and env (modelArgs,
// getBareArgs, getSpawnEnv), the child-pid registry (pid file + recycling
// guard), Claude binary resolution, process-tree kill, and spawnClaude
// itself. Extracted verbatim from server.js.
//
// The child-pid registry lives HERE, with spawnClaude, because spawnClaude
// is its writer (register on spawn, unregister on close). The root's cleanup
// machinery (killAllChildren, cleanOrphanedProcesses, the workspace-move
// clear) reads and prunes the same file by calling in: root -> lib.
//
// The workspace root is read at USE time via lib/config.js getWorkspace(),
// so a workspace switch redirects args, env, and the pid file location on
// the very next call. Only the listening port is wired in from the
// composition root: it exists only after server.listen() runs.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { getWorkspace, namesNoModel } = require('../config.js');
const { rundockDir, readState } = require('../store/persistence.js');
const { resolveMcpConfigPath } = require('../workspace/mcp-secrets.js');
const { workingFoldersEnv } = require('../workspace/working-folders.js');
const codexRuntime = require('../../codex.js');

// Root-owned dependencies, named and wired at boot. Unwired deps throw so a
// missed wiring fails loudly at first use, never silently.
const unwired = (name) => () => { throw new Error(`lib/runtime/claude: ${name} not wired (call wireClaudeRuntimeDeps at boot)`); };
const deps = {
  getActualPort: unwired('getActualPort'),
};
function wireClaudeRuntimeDeps(next) {
  const prev = { ...deps };
  Object.assign(deps, next);
  return prev;
}

// Rundock names no model unless the user did.
//
// It spawns a CLI; what that CLI talks to is the CLI's business. A gateway is
// ANTHROPIC_BASE_URL set on Claude Code outside Rundock, and a router, Bedrock
// or Vertex are the same shape, so there is nothing here to detect and nothing
// worth guessing. An agent that names a model gets it verbatim; an agent that
// names none gets no --model, and the runtime applies the only default that is
// guaranteed servable on that machine: its own.
//
// Rundock used to substitute `sonnet`, which silently overrode a user who had
// chosen a model with `/model`, and could not be served at all on a machine
// whose models arrive through a gateway.
//
// The model is never validated here, and must not be: `my-gateway/claude-model-id`
// is a real thing a user can configure their runtime to serve, and Rundock
// cannot know the naming convention behind someone else's gateway. Whatever the
// frontmatter says is what the runtime is asked for.
//
// `inherit` omits --model entirely, so the runtime applies whatever default it
// resolves for that machine. This is the only workable answer when Rundock
// cannot name a model at all: on a gateway-only machine there is no identifier
// we could guess. Codex agents have always worked this way (see
// lib/agents/discovery.js); this makes the Claude runtime match, and makes
// docs/AGENTS.md true, having listed `inherit` as valid since before anything
// implemented it.
//
// A previous version of this comment justified always passing --model by
// claiming a Pro subscription resolves the invalid model name "pro". Pro is a
// subscription plan rather than a model, and a plan resolving its own default
// model is the behaviour being asked for here, not a failure mode.

// Internal marker meaning "this agent inherits, deliberately". spawnClaude
// strips it before exec, so it never reaches the CLI. It exists because
// spawnClaude cannot otherwise tell a deliberate inherit from a call site that
// simply forgot to pass a model, and it defaults the latter to protect against
// exactly that. Returning a bare [] made `inherit` a silent no-op: the safety
// net put --model sonnet back, and every unit test on this function still
// passed because the substitution happens one layer down.
//
// It is an object rather than a string ON PURPOSE. A model name is untrusted
// input by design: this module passes any frontmatter value through verbatim,
// because a gateway's naming is not ours to police. A string marker would
// therefore be typeable, and an agent whose model happened to equal it would
// have its --model VALUE stripped, leaving the flag dangling and every
// following flag paired with the wrong value. Identity comparison against an
// object nothing can author in YAML removes that by construction rather than
// guarding against it. It never reaches spawn(): it is removed one line below.
const INHERIT_MARKER = Object.freeze({ rundock: 'inherit-model' });

function modelArgs(agent) {
  const model = agent && agent.model;
  // Naming nothing and naming `inherit` are the same statement, so they resolve
  // the same way. Codex has always worked like this; only the Claude runtime
  // made the two differ, which is why the docs needed a sentence warning that
  // two ways of saying nothing meant different things. The predicate is owned
  // in lib/config.js because the resolution layer asks the same question.
  if (namesNoModel(model)) return [INHERIT_MARKER];
  return ['--model', model];
}

// Which model a spawn actually asked for, for the chat log. Absence is an
// answer: with `inherit` there is no --model in argv, and reaching for
// `args[args.indexOf('--model') + 1]` would index args[-1 + 1] and report the
// FIRST argument as the model, which is both wrong and plausible-looking.
function modelForLog(args) {
  if (args.includes(INHERIT_MARKER)) return '(inherited)';
  const i = args.indexOf('--model');
  return i === -1 ? '(inherited)' : args[i + 1];
}

// The flag names from a spawn's args, for the chat log. Built here rather than
// inline at the call sites because args can carry INHERIT_MARKER, which is not
// a string: `a.startsWith('--')` would throw on it, and printing it would leak
// an internal token into a log a user may be reading to work out what ran.
function logFlags(args) {
  return args.filter(a => typeof a === 'string' && a.startsWith('--')).join(' ');
}

// Returns startup args that configure workspace context without using --bare.
// Previously used --bare for faster startup, but --bare skips keychain/OAuth reads
// which causes "Not logged in" errors for users who authenticate via `claude login`.
// We now pass context flags explicitly without --bare so auth works normally.
function getBareArgs() {
  if (!getWorkspace()) return [];
  const args = [];
  // Ensure CLAUDE.md discovery for the workspace
  args.push('--add-dir', getWorkspace());
  // Load hooks (permission system) from settings.local.json
  const settingsPath = path.join(getWorkspace(), '.claude', 'settings.local.json');
  if (fs.existsSync(settingsPath)) {
    args.push('--settings', settingsPath);
  }
  // Load MCP server access from the workspace's .mcp.json, with any per-user
  // credentials from .rundock/mcp-secrets.json merged in for this spawn.
  // Resolved per spawn rather than once, so editing either file takes effect on
  // the next turn. A workspace with no per-user credential gets the .mcp.json
  // path itself back and this argument is unchanged from what it always was;
  // lib/workspace/mcp-secrets.js has the reasoning.
  const mcpPath = resolveMcpConfigPath(getWorkspace());
  if (mcpPath) {
    args.push('--mcp-config', mcpPath);
  }
  return args;
}

// Where a spawned agent's scratch files go.
//
// Agents write working files (a rendered page, an intermediate export, a
// draft) and read them back a step later. Left to the platform those land in
// the operating system temp directory, which is outside the workspace, so
// reading one back raises an approval card for a file the agent created
// itself seconds earlier. The card is right; putting the file there was the
// mistake. Rundock's promise is that agents stay in the user's files, and a
// temp directory is not the user's files.
//
// Pointing the platform temp directory here holds that promise BY
// CONSTRUCTION. It covers tools and skills this project never wrote, because
// they ask the platform rather than reading any guidance, and it needs nobody
// to remember a convention.
//
// Returns null when no workspace is set. Redirecting to a path built from an
// empty workspace would be worse than not redirecting: it would scatter files
// somewhere unpredictable rather than contain them.
function scratchDir() {
  const ws = getWorkspace();
  if (!ws) return null;
  return path.join(rundockDir(), 'scratch');
}

// Clear scratch left by earlier runs. Called at startup, when nothing can be
// mid-use, and bounded by age rather than emptying the directory outright, so
// a second Rundock open on the same workspace cannot delete files the first
// one is still working with.
const SCRATCH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// The newest modification time anywhere in a tree.
//
// A directory's own timestamp moves when its immediate children change, and
// NOT when something deeper does. Judging a directory by its own timestamp
// alone would therefore delete a project folder stamped weeks ago because
// nothing was added at its top level, while a file inside it was being written
// minutes earlier. That is the data loss the age bound exists to prevent, so
// the age of a directory has to mean the age of the newest thing in it.
function newestMtimeMs(target) {
  let newest = 0;
  const visit = (p) => {
    let st;
    try { st = fs.statSync(p); } catch (e) { return; }
    if (st.mtimeMs > newest) newest = st.mtimeMs;
    if (st.isDirectory()) {
      let kids;
      try { kids = fs.readdirSync(p); } catch (e) { return; }
      for (const k of kids) visit(path.join(p, k));
    }
  };
  visit(target);
  return newest;
}

function pruneScratch() {
  const dir = scratchDir();
  if (!dir) return;
  let entries;
  try { entries = fs.readdirSync(dir); } catch (e) { return; } // nothing to prune
  const cutoff = Date.now() - SCRATCH_MAX_AGE_MS;
  for (const name of entries) {
    if (name === '.gitignore') continue; // the directory's own exclusion marker
    const full = path.join(dir, name);
    try {
      if (newestMtimeMs(full) < cutoff) fs.rmSync(full, { recursive: true, force: true });
    } catch (e) { /* raced with another process, or unreadable: leave it */ }
  }
}

// Returns spawn env with workspace mode flag for the permission hook.
function getSpawnEnv(convoId) {
  const env = { ...process.env, TERM: 'dumb', RUNDOCK: '1', RUNDOCK_PORT: String(deps.getActualPort()), RUNDOCK_WORKSPACE: getWorkspace() || '' };
  // The folders this workspace names as its own, read from the workspace at
  // SPAWN time rather than captured once at startup. That is what makes
  // adding or removing one take effect for the next agent without restarting
  // the app: the value an agent is born with is the value on disk at its
  // birth, and an agent already running keeps the boundary it was born with
  // rather than having it change underneath a command it is midway through.
  env.RUNDOCK_EXTRA_DIRS = workingFoldersEnv();
  if (convoId) env.RUNDOCK_CONVO_ID = convoId;
  // Keep scratch inside the workspace. All three names, because the platform
  // reads a different one per operating system: TMPDIR on macOS and Linux,
  // TEMP and TMP on Windows. Setting only the one this machine happens to use
  // would leave the other platforms writing outside the workspace with nothing
  // to catch it.
  const scratch = scratchDir();
  if (scratch) {
    try {
      fs.mkdirSync(scratch, { recursive: true });
      // Ignore itself, rather than trusting the workspace's own .gitignore to
      // cover it. The scaffold does add the parent directory, but only when it
      // runs: a workspace created before that, or one whose .gitignore has been
      // edited since, would start committing working files. A directory that
      // excludes itself needs no cooperation from anything else.
      const marker = path.join(scratch, '.gitignore');
      if (!fs.existsSync(marker)) fs.writeFileSync(marker, '*\n');
      env.TMPDIR = scratch; env.TEMP = scratch; env.TMP = scratch;
    } catch (e) { /* unwritable: leave the platform default rather than break the spawn */ }
  }
  // Never let spawned agent processes inherit the test runner's coverage
  // collection: a child killed mid-turn (e.g. a superseded Codex exec)
  // leaves truncated coverage JSON that corrupts the runner's merge and
  // intermittently fails npm run test:coverage.
  delete env.NODE_V8_COVERAGE;
  // In the packaged app there is no system `node`, so the PreToolUse permission
  // hook is run with Rundock's bundled runtime (process.execPath) behaving as
  // Node via ELECTRON_RUN_AS_NODE. The hook is a child of the spawned claude
  // process and inherits this env. Without it, on a machine with no Node the
  // hook can't run at all and the permission system silently does nothing.
  if (process.env.RUNDOCK_ELECTRON) env.ELECTRON_RUN_AS_NODE = '1';
  try {
    const state = readState();
    if (state.workspaceMode === 'code') env.RUNDOCK_CODE_MODE = '1';
  } catch (e) { /* default knowledge mode */ }
  return env;
}

// PID file: track all spawned Claude Code process PIDs so orphans can be cleaned up
// on restart if the parent crashes without running exit handlers.
function pidFilePath() {
  if (!getWorkspace()) return null;
  return path.join(rundockDir(), 'child-pids.json');
}

function loadPidFile() {
  const p = pidFilePath();
  if (!p) return [];
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (e) { return []; }
}

function savePidFile(pids) {
  const p = pidFilePath();
  if (!p) return;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(pids));
  } catch (e) {}
}

// Pid records carry the command they were spawned as, so a pid the OS has
// since recycled onto an unrelated process is not signalled. The file used to
// hold bare integers with no way to tell the difference; those are still read
// for one upgrade, and simply lack the recycling guard.
function pidOf(rec) { return typeof rec === 'number' ? rec : (rec && rec.pid); }

// What every reader below is after is the COMMAND LINE.
//
// Deliberately the command line and not `comm=` or a thread name. On Linux
// `comm` is the THREAD name from /proc, not the executable: Node 24 renames its
// main thread to "MainThread", so every record would have been judged foreign
// and discarded, defeating the tracking this guard exists to protect. Node 22
// on the same machine reports "node". The command line is stable across both,
// and across macOS, where `comm` gives a full path instead.

// /proc gives argv NUL-separated with a trailing NUL. `ps -o args=` prints the
// same argv joined by single spaces, so joining on ' ' is what makes the two
// strings comparable, and a wrong join here would show up as a guard that
// quietly stops matching. That is MEASURED rather than assumed, by the
// comparison test in test/unit/pid-file.test.js, which reads both sources for
// the same process and prints both strings on every run.
//
// THE TWO ARE IDENTICAL ONLY FOR ARGV THAT IS PRINTABLE, which is narrower than
// it sounds and was measured after being wrongly claimed here. `ps` RENDERS a
// command line for a human: on Linux it turns a newline into a space and a tab
// into `?`, on macOS into `\012` and `\011`, and the trim below removes
// trailing whitespace either way. /proc returns the bytes as spawned. A spawn
// from this codebase carries an agent's system prompt in argv and that contains
// newlines, so the real command lines here are exactly the case where the two
// disagree, and the value below is the faithful one.
//
// It does not reach the guard, and that is a separate statement from the one
// above rather than a reason not to make it. commandsMatch asks only whether
// the recorded basename appears somewhere in the command line, and a basename
// sits in argv[0] ahead of anything a prompt could contain. Pinned by
// `a child spawned with control characters in argv is still recognised`.
//
// Separated from the read so the parsing is covered on machines that have no
// procfs to read, which is where a mistake in it would otherwise go unseen.
function parseProcCmdline(raw) {
  const trimmed = String(raw).replace(/\0+$/, '');
  // A kernel thread has an empty cmdline, and so does a process whose argv the
  // kernel will not hand over. That is "no answer", not "the empty command
  // line": returning '' would match EVERY record through the deliberately loose
  // comparison below, which is the failure this guard exists to prevent.
  if (!trimmed) return null;
  return trimmed.split('\0').join(' ');
}

// Read a command line WITHOUT spawning anything: the path that survives a
// command sandbox, which blocks spawning `ps` and so leaves the guard unable to
// tell a recycled pid from one of ours.
//
// Whether this machine has a procfs is established by READING it rather than by
// naming platforms. A platform that grows one then needs no change here, a
// Linux without one mounted is not wrongly assumed to have one, and the path is
// exercised everywhere rather than only on the platform that answers. Being
// wrong costs one failed open, on a check made at startup cleanup and workspace
// switch rather than in any loop. Number(pid) keeps a crafted record from
// reaching a path of its own choosing.
function readProcCmdline(pid) {
  let raw;
  try { raw = fs.readFileSync(`/proc/${Number(pid)}/cmdline`, 'utf-8'); }
  catch (e) { return null; } // no procfs (macOS, Windows), or not running
  return parseProcCmdline(raw);
}

// Read a command line by spawning `ps`. The fallback for platforms with no
// non-spawning source, and the reason the check is unavailable under a sandbox
// that blocks process spawning.
function psCommand(pid) {
  if (process.platform === 'win32') return null; // no cheap equivalent; skip the check
  try {
    const { execFileSync } = require('child_process');
    return execFileSync('ps', ['-p', String(pid), '-o', 'args='], {
      encoding: 'utf-8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (e) { return null; } // not running, or ps unavailable
}

/**
 * A process's command line, read WITHOUT SPAWNING where the platform allows.
 *
 * The order is the whole point of this function and it cannot be seen in the
 * result: where both sources answer they answer identically, which is measured
 * rather than assumed. What separates them is that one spawns a process and the
 * other does not, so the test pins the order by observing that the spawning
 * reader is never reached, and the readers are parameters so it can.
 *
 * @param {number} pid
 * @param {(pid: number) => string|null} [fromProc] the non-spawning reader
 * @param {(pid: number) => string|null} [fromPs] the spawning reader
 */
function processCommand(pid, fromProc = readProcCmdline, fromPs = psCommand) {
  const free = fromProc(pid);
  if (free != null) return free;
  return fromPs(pid);
}

// The two places a command line can come from, named once so that nothing else
// has to spell them out. A test that assembles its own version of these names
// drifts from them the first time one is renamed.
const COMMAND_LINE_SOURCES = Object.freeze({
  free: '/proc/<pid>/cmdline',
  spawning: 'ps -p <pid> -o args=',
});

/**
 * Can this machine read a process's command line, and which source answers?
 *
 * Reported rather than inferred, so a caller can say which source answered and
 * name the ones that did not instead of treating an environment as a defect.
 * Every source is probed, including the spawning one when the free one already
 * answered, because the point of the report is to describe the machine. It is a
 * diagnostic and is not on the path the guard takes per check.
 *
 * @param {(pid: number) => string|null} [fromProc] the non-spawning reader
 * @param {(pid: number) => string|null} [fromPs] the spawning reader
 * @returns {{ ok: boolean, source: string|null, missing: string|null,
 *            sources: { name: string, spawns: boolean, available: boolean }[] }}
 */
function commandLineCapability(fromProc = readProcCmdline, fromPs = psCommand) {
  const sources = [
    { name: COMMAND_LINE_SOURCES.free, spawns: false, available: fromProc(process.pid) != null },
    { name: COMMAND_LINE_SOURCES.spawning, spawns: true, available: fromPs(process.pid) != null },
  ];
  const answered = sources.find(source => source.available);
  return {
    ok: Boolean(answered),
    source: answered ? answered.name : null,
    sources,
    missing: answered ? null
      : `no readable process command line on ${process.platform}: `
        + `${sources.map(source => source.name).join(' and ')} are both unavailable `
        + '(a command sandbox that blocks spawning produces exactly this)',
  };
}

/**
 * Running AND still the process we spawned, rather than a recycled pid.
 *
 * WHAT HAPPENS WHEN THE COMMAND LINE CANNOT BE READ, which is the case on
 * Windows and under any sandbox that blocks spawning `ps`: the record is
 * ASSUMED OURS. The guard is genuinely weaker there, and a pid the OS has
 * recycled onto an unrelated process can be signalled. That direction is
 * chosen: an untracked child leaks forever, where a redundant signal costs one
 * SIGTERM to a process that is probably ours. Anything relying on this guard
 * for containment should read commandLineCapability() first.
 *
 * @param {any} rec
 * @param {(pid: number) => string|null} [readCommand] the command-line reader;
 *   the seam that lets the matching and the degraded behaviour be tested on a
 *   machine that has no lookup of its own.
 */
function pidRecordAlive(rec, readCommand = processCommand) {
  const pid = pidOf(rec);
  if (!pid) return false;
  try { process.kill(pid, 0); } catch (e) { return false; }
  const expected = typeof rec === 'object' && rec ? rec.cmd : null;
  if (!expected) return true; // legacy record, or a platform without the check
  const actual = readCommand(pid);
  if (actual == null) return true; // cannot tell; assume ours rather than leak it
  return commandsMatch(actual, expected);
}

// Does this command line still look like the thing we spawned?
//
// Deliberately loose: the guard only has to tell "the process we started" from
// "something unrelated that inherited this id". Command-line formatting varies
// by platform and by runtime version, and a strict comparison has already
// broken once that way. Being too permissive means a redundant signal to a
// process that is probably ours; being too strict means untracked processes
// leaking forever, which is the failure this whole area exists to prevent.
function commandsMatch(actual, expected) {
  const e = path.basename(String(expected || '').trim());
  const a = String(actual || '').trim();
  if (!e || !a) return true;
  return a.includes(e);
}

function registerChildPid(pid, cmd) {
  const records = loadPidFile();
  if (records.some(r => pidOf(r) === pid)) return;
  records.push({ pid, at: Date.now(), cmd: cmd ? path.basename(cmd) : null });
  savePidFile(records);
}

function unregisterChildPid(pid) {
  savePidFile(loadPidFile().filter(r => pidOf(r) !== pid));
}

// Resolve the Claude binary path lazily and cache it. Independent of
// Electron's findClaude so Path B users (running `node server.js` directly
// without Electron) get correct .cmd resolution on Windows too. On lookup
// failure, returns the literal 'claude' so spawn's 'error' event surfaces the
// real ENOENT rather than masking it. The absolute path lets Node execute
// .cmd files on Windows without `shell: true`, which would expose args
// (containing user and system prompts) to command-injection risk.
let _resolvedClaudeBin = null;
function resolveClaudeBin() {
  if (_resolvedClaudeBin) return _resolvedClaudeBin;
  const isWindows = process.platform === 'win32';
  try {
    const { execSync } = require('child_process');
    const lookupCmd = isWindows ? 'where.exe claude' : 'which claude';
    // PROBE_STDIO closes stdin: on Windows a version/which probe against an
    // open piped stdin can hang for its full timeout (verified live for
    // codex, Findings 4/5); the claude probes take the same precaution.
    const output = execSync(lookupCmd, { timeout: 5000, encoding: 'utf-8', stdio: codexRuntime.PROBE_STDIO }).trim();
    if (!output) return (_resolvedClaudeBin = 'claude');
    if (isWindows) {
      const candidates = output.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      const exe = candidates.find(c => c.toLowerCase().endsWith('.exe'));
      const cmd = candidates.find(c => c.toLowerCase().endsWith('.cmd'));
      _resolvedClaudeBin = exe || cmd || candidates[0] || 'claude';
    } else {
      _resolvedClaudeBin = output;
    }
    return _resolvedClaudeBin;
  } catch {
    return (_resolvedClaudeBin = 'claude');
  }
}

// Spawn a Claude Code process with PID tracking for crash cleanup.
// Drop-in replacement for spawn('claude', ...) that registers/unregisters PIDs.
// Signal a spawned process AND everything it started.
//
// An agent CLI spawns its own children: an MCP server per configured entry,
// plus tool subprocesses. Those are grandchildren we hold no handle on and
// never record, so signalling one pid leaves them running and reparented,
// holding memory until the machine restarts.
//
// On POSIX the children are spawned detached, which puts each in its own
// process group whose id equals the leader's pid, so a negative pid signals
// the whole group. Windows has no process groups; taskkill /T walks the tree
// instead. Windows also has no real signal semantics (Node maps kill() onto
// TerminateProcess), so the graceful and forceful paths are the same there.
function killProcessTree(target, signal = 'SIGTERM') {
  const pid = typeof target === 'number' ? target : (target && target.pid);
  if (!pid) return;
  // Floor: kill at least the process itself, so no path here can end up doing
  // less than the single-pid kill this replaced.
  const killJustThis = () => {
    try {
      if (typeof target === 'number') process.kill(pid, signal);
      else target.kill(signal);
    } catch (e) { /* already dead */ }
  };

  if (process.platform === 'win32') {
    // Windows has no process groups; taskkill walks the tree instead. It is
    // spawned rather than awaited, so a missing binary arrives as an error
    // EVENT and never reaches a try/catch: without the listener below a
    // failure would kill nothing at all, which is worse than what this
    // replaced. Order matters, since killing the parent first would orphan
    // the children out of taskkill's reach.
    let killer = null;
    try {
      killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      killer.on('error', killJustThis);
    } catch (e) {
      killJustThis();
    }
    return;
  }

  // Negative pid = the whole process group. Fails with ESRCH if the group is
  // already gone, or EPERM if the child was never detached; fall back to the
  // single process so this is never worse than the old behaviour.
  try { process.kill(-pid, signal); return; } catch (e) {}
  killJustThis();
}

function spawnClaude(args, options, onError) {
  // The marker is internal and never reaches the CLI.
  //
  // There is no longer a net injecting a default beneath this. There is nothing
  // left for it to protect: passing no --model is now the correct, ordinary
  // outcome for any agent that names no model, so a net could not tell a
  // forgetful call site from a correct one, and its only possible effect would
  // be to substitute a model the user never named. That substitution is the
  // defect this card removes, and it is what silently turned an earlier
  // implementation of `inherit` into a no-op.
  if (args.includes(INHERIT_MARKER)) args = args.filter(a => a !== INHERIT_MARKER);
  // detached puts the child at the head of its own process group so its whole
  // subtree can be signalled together. Safe for terminal users: the server
  // installs its own SIGINT and SIGTERM handlers and kills children explicitly,
  // so Ctrl-C never depended on the terminal reaching them by group.
  const proc = spawn(resolveClaudeBin(), args, { ...options, detached: process.platform !== 'win32' });
  if (proc.pid) {
    registerChildPid(proc.pid, resolveClaudeBin());
    proc.on('close', () => unregisterChildPid(proc.pid));
  }
  // Always attach a baseline 'error' listener so an unhandled error event
  // cannot propagate out of the WebSocket message handler and tear down the
  // connection. Caller-provided onError does the user-facing surfacing; this
  // wrapper guarantees the listener exists and that the callback runs inside
  // try/catch.
  proc.on('error', (err) => {
    try {
      console.error(`[spawnClaude] spawn error code=${err.code || ''} msg=${err.message}`);
      if (typeof onError === 'function') onError(err);
    } catch (e) {
      console.error('[spawnClaude] onError handler threw:', e);
    }
  });
  return proc;
}

module.exports = {
  wireClaudeRuntimeDeps,
  modelArgs, modelForLog, logFlags, INHERIT_MARKER, getBareArgs, getSpawnEnv,
  pidFilePath, loadPidFile, savePidFile, pidOf, pidRecordAlive,
  processCommand, readProcCmdline, parseProcCmdline, psCommand,
  commandLineCapability, COMMAND_LINE_SOURCES,
  registerChildPid, unregisterChildPid,
  resolveClaudeBin, killProcessTree, spawnClaude,
  scratchDir, pruneScratch,
};
