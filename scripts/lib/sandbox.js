'use strict';

/**
 * What the agent sandbox leaves outside, and whether this process is inside it.
 *
 * Claude Code's sandbox runs every Bash command inside an OS sandbox except the
 * ones its `sandbox.excludedCommands` setting names. Two facts about that
 * setting decide everything the factory tools here do, and both were measured
 * rather than read:
 *
 *   - A pattern is a glob over the WHOLE command, and only a single, bare
 *     command can match it. `cd <dir> && <cmd>`, `<cmd> | head`,
 *     `<cmd> > file`, `$(...)` and a `VAR=value` prefix all run sandboxed even
 *     under a pattern that starts with `*`. Quoted arguments and `2>&1` do not
 *     change the outcome.
 *   - A pattern with no trailing `*` matches the command with no arguments
 *     only. `node <script> anything` runs sandboxed under `node <script>`.
 *
 * Inside the sandbox the process sees SANDBOX_RUNTIME=1; a command the sandbox
 * leaves outside does not. That marker is how a long gate refuses in its first
 * second instead of failing an hour later as a browser that "can't start" or a
 * credential that reads as "invalid".
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function isSandboxed(env = process.env) {
  return env.SANDBOX_RUNTIME === '1';
}

// A pattern is a glob: `*` is any run of characters, everything else literal,
// anchored at both ends.
function globToRegExp(pattern) {
  const body = String(pattern).split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${body}$`, 's');
}

function matchingPattern(command, patterns) {
  const text = String(command).trim();
  for (const pattern of patterns) {
    if (globToRegExp(pattern).test(text)) return pattern;
  }
  return null;
}

// The excluded commands named by these settings files. A file that is
// missing, unreadable or not JSON contributes nothing: this is a convenience
// guard and must never stop a command because a settings file moved.
function exclusionsFrom(files) {
  const out = [];
  for (const file of files) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const list = parsed && parsed.sandbox && parsed.sandbox.excludedCommands;
    if (Array.isArray(list)) {
      for (const p of list) if (typeof p === 'string' && p.trim() && !out.includes(p)) out.push(p);
    }
  }
  return out;
}

// The settings files Claude Code reads for a project directory, in no
// particular order (the lists are merged, so order does not matter here).
function settingsFilesFor(projectDir, home = os.homedir()) {
  const files = [];
  if (projectDir) {
    files.push(path.join(projectDir, '.claude', 'settings.json'));
    files.push(path.join(projectDir, '.claude', 'settings.local.json'));
  }
  if (home) files.push(path.join(home, '.claude', 'settings.json'));
  return files;
}

// The exclusions configured where this process runs: the project's settings
// (CLAUDE_PROJECT_DIR, else the working directory) and the user's.
function exclusionsHere(env = process.env) {
  return exclusionsFrom(settingsFilesFor(env.CLAUDE_PROJECT_DIR || process.cwd()));
}

const RUNNER = path.join(__dirname, '..', 'exempt-run.js');

// Whether scripts/exempt-run.js is itself configured as an exclusion. Only
// then does it, and what it starts, run outside the sandbox; otherwise it is
// sandboxed like anything else, so a message names it only when it is.
function runnerExcluded(patterns) {
  return Boolean(matchingPattern(`node ${RUNNER} args.json`, patterns));
}

// The refusal a long step prints when it finds itself sandboxed. It names the
// cause and the fix, so nobody spends the run finding out.
function sandboxRefusal(what, bareCommand, patterns = []) {
  const lines = [
    `${what} refused to start: it is running inside the agent sandbox (SANDBOX_RUNTIME=1), where it would fail late`,
    'and misleadingly: a browser that cannot start, a credential that reads as invalid, a port it cannot bind.',
    '',
    'Run it as one bare command, which the sandbox leaves outside when its exclusions name it:',
    `  ${bareCommand}`,
    'No "cd <dir> &&" in front, no pipe, no "> file", no "$(...)" and no VAR=value prefix. Run a cd as a call of',
    'its own first, and read the output from the result of the call. For a VAR=value, write a small script in the',
    "repository's test tree or its gitignored scratch folder (.rundock/scratch/) that starts the command as a child",
    'process with it set, and run the script bare.',
  ];
  if (runnerExcluded(patterns)) {
    lines.push('Or, as scripts/exempt-run.js is itself excluded, put the arguments in a file and run it on that file (see that file).');
  }
  return lines.join('\n');
}

// Exits with the refusal when sandboxed; returns otherwise. The exclusions
// default to the ones configured where this runs.
function refuseIfSandboxed(what, bareCommand, { env = process.env, exit = process.exit, write = (s) => process.stderr.write(s), patterns } = {}) {
  if (!isSandboxed(env)) return false;
  const list = patterns || exclusionsHere(env);
  write(`${sandboxRefusal(what, bareCommand, list)}\n`);
  exit(2);
  return true;
}

module.exports = {
  isSandboxed, globToRegExp, matchingPattern, exclusionsFrom, settingsFilesFor, exclusionsHere, RUNNER, runnerExcluded,
  sandboxRefusal, refuseIfSandboxed,
};
