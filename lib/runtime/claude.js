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
const { getWorkspace, DEFAULT_MODEL } = require('../config.js');
const { rundockDir, readState } = require('../store/persistence.js');
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

// Default model for any agent that does not declare one in its frontmatter, and
// for the synthesised orchestrator and Doc. Sonnet is the balanced choice and is
// available on every paid plan; complex agents opt up to a stronger model via `model: opus`
// in their frontmatter, quick agents opt down to `model: haiku`. Always passing
// an explicit --model (see modelArgs + spawnClaude) keeps model selection
// predictable instead of inheriting whatever Claude Code resolves from the user's
// environment (e.g. a Pro subscription resolving the invalid model name "pro").
// The value itself lives in lib/config.js so lib/agents/discovery.js resolves
// the same default without reaching back into the root.
function modelArgs(agent) {
  return ['--model', (agent && agent.model) || DEFAULT_MODEL];
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
  // Load MCP server access from .mcp.json
  const mcpPath = path.join(getWorkspace(), '.mcp.json');
  if (fs.existsSync(mcpPath)) {
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

// Read a command line WITHOUT spawning anything. Linux only: /proc/<pid>/cmdline
// holds argv NUL-separated with a trailing NUL, so joining on a single space is
// what makes it comparable to `ps -o args=`, which prints the same argv joined
// that way. That equality is MEASURED rather than assumed, by the comparison
// test in test/unit/pid-file.test.js which prints both strings on every run.
//
// This is the path that survives a command sandbox, which blocks spawning `ps`
// and so leaves the guard unable to tell a recycled pid from one of ours.
function readProcCmdline(pid) {
  if (process.platform !== 'linux') return null; // no procfs: macOS, Windows
  let raw;
  try { raw = fs.readFileSync(`/proc/${Number(pid)}/cmdline`, 'utf-8'); }
  catch (e) { return null; } // not running, or procfs not mounted
  // Kernel threads have an empty cmdline, and so does a process whose argv the
  // kernel will not hand over. Empty is "no answer", not "the empty command
  // line": returning '' would match every record, which is the failure this
  // guard exists to prevent.
  const trimmed = raw.replace(/\0+$/, '');
  if (!trimmed) return null;
  return trimmed.split('\0').join(' ');
}

// Read a command line by spawning `ps`. The fallback for platforms with no
// non-spawning source, and the reason the check is unavailable under a sandbox
// that blocks process spawning.
function psCommand(pid) {
  if (process.platform === 'win32') return null; // no cheap equivalent; skip the check
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'args='], {
      encoding: 'utf-8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || null; // an empty answer tells us nothing; say so
  } catch (e) { return null; } // not running, or ps unavailable
}

/** A process's command line, read without spawning where the platform allows. */
function processCommand(pid) {
  const free = readProcCmdline(pid);
  if (free != null) return free;
  return psCommand(pid);
}

/**
 * Can this machine read a process's command line at all?
 *
 * Reported rather than inferred, so a caller (and the suite) can say which
 * source answered, and name what is missing when neither does instead of
 * treating an environment as a defect.
 *
 * @param {(pid: number) => string|null} [fromProc] the non-spawning reader
 * @param {(pid: number) => string|null} [fromPs] the spawning reader
 * @returns {{ ok: boolean, source: string|null, missing: string|null }}
 */
function commandLineCapability(fromProc = readProcCmdline, fromPs = psCommand) {
  if (fromProc(process.pid) != null) return { ok: true, source: '/proc/<pid>/cmdline', missing: null };
  if (fromPs(process.pid) != null) return { ok: true, source: 'ps -p <pid> -o args=', missing: null };
  return {
    ok: false,
    source: null,
    missing: `no readable process command line on ${process.platform}: `
      + '/proc/<pid>/cmdline is absent or unreadable, and `ps -p <pid> -o args=` '
      + 'could not be run (a command sandbox that blocks spawning produces exactly this)',
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
  // Safety net: never spawn Claude Code without an explicit --model. Call sites
  // pass the agent's model (see modelArgs); this guards any path that doesn't,
  // so the model can never silently fall back to the user's environment.
  if (!args.includes('--model')) args = ['--model', DEFAULT_MODEL, ...args];
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
  modelArgs, getBareArgs, getSpawnEnv,
  pidFilePath, loadPidFile, savePidFile, pidOf, pidRecordAlive,
  processCommand, readProcCmdline, psCommand, commandLineCapability,
  registerChildPid, unregisterChildPid,
  resolveClaudeBin, killProcessTree, spawnClaude,
  scratchDir, pruneScratch,
};
