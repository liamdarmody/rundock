#!/usr/bin/env node
'use strict';

/**
 * Run one sandbox-excluded command from a file of arguments, so the command
 * that has to stay bare never needs a quote, a pipe, a chain or a redirect.
 *
 *   node scripts/exempt-run.js <args-file>.json
 *
 * The file:
 *   {
 *     "cwd":    "/absolute/working/directory",       optional, default: here
 *     "argv":   ["npx", "playwright", "test", "e2e/a.spec.js"],
 *     "env":    { "E2E_PORT": "4100" },                optional
 *     "stdout": "/absolute/out.txt",                   optional, else inherited
 *     "stderr": "/absolute/err.txt"                    optional, else inherited
 *   }
 *
 * WHY. The sandbox leaves a command outside only when it is one bare command
 * its exclusions match (scripts/lib/sandbox.js). An agent whose working
 * directory resets between calls cannot `cd` first, and an agent that needs a
 * result in a file cannot redirect. This runner is the one bare command such
 * an agent types; the cwd, environment and output files ride in the file.
 *
 * WHAT IT WILL RUN. Only a command the sandbox exclusions already leave
 * outside: `argv` joined with spaces must match one of them, or, for an
 * exclusion with no trailing `*`, start with exactly what it names. The runner
 * widens how an exempt command can be invoked, never which commands are
 * exempt. The exclusions come from the user's Claude Code settings and from
 * the settings files named by `git config --get-all rundock.sandboxSettings`
 * (or RUNDOCK_SANDBOX_SETTINGS, path-delimited), never from the args file.
 *
 * Its own invocation must be excluded too, for example
 * "node /absolute/checkout/scripts/exempt-run.js *". Run inside the sandbox it
 * refuses at once, because everything it started would be sandboxed as well.
 *
 * Exit codes: the command's own, or 2 when the runner refuses.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { isSandboxed, matchingPattern, exclusionsFrom, settingsFilesFor } = require('./lib/sandbox.js');

// Variables that change what a program loads rather than what it does.
const LOADER_ENV = /^(NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*|BASH_ENV|ENV|PATH)$/;

class Refusal extends Error {}

function readSpec(file) {
  let spec;
  try {
    spec = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Refusal(`Could not read the arguments file ${file}: ${err.message}`);
  }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Refusal('The arguments file must hold one JSON object.');
  const known = new Set(['cwd', 'argv', 'env', 'stdout', 'stderr']);
  for (const key of Object.keys(spec)) if (!known.has(key)) throw new Refusal(`Unknown key "${key}" in the arguments file.`);
  if (!Array.isArray(spec.argv) || !spec.argv.length || !spec.argv.every((a) => typeof a === 'string' && a.length)) {
    throw new Refusal('"argv" must be a non-empty list of non-empty strings.');
  }
  return spec;
}

// The exclusions that decide what may run, from places the args file cannot
// reach.
function configuredExclusions({ env = process.env, root = process.cwd(), home = os.homedir() } = {}) {
  const files = settingsFilesFor(null, home);
  if (env.RUNDOCK_SANDBOX_SETTINGS) files.push(...env.RUNDOCK_SANDBOX_SETTINGS.split(path.delimiter).filter(Boolean));
  try {
    const out = execFileSync('git', ['config', '--get-all', 'rundock.sandboxSettings'],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    files.push(...out.split('\n').map((l) => l.trim()).filter(Boolean));
  } catch {
    // Not configured, or not a repository: the user's settings alone decide.
  }
  return exclusionsFrom(files);
}

function exemptPattern(argv, patterns) {
  const whole = matchingPattern(argv.join(' '), patterns);
  if (whole) return whole;
  for (let k = argv.length - 1; k >= 1; k--) {
    const p = matchingPattern(argv.slice(0, k).join(' '), patterns);
    if (p) return p;
  }
  return null;
}

// An output file lands in the working directory or beside the arguments file,
// so the runner cannot be pointed at a file elsewhere on the machine.
function outputPath(value, key, { cwd, specDir }) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Refusal(`"${key}" must be an absolute path.`);
  const resolved = path.resolve(value);
  const inside = (dir) => resolved.startsWith(path.resolve(dir) + path.sep);
  if (!inside(cwd) && !inside(specDir)) {
    throw new Refusal(`"${key}" must be inside the working directory or beside the arguments file: ${value}`);
  }
  try {
    if (fs.lstatSync(resolved).isSymbolicLink()) throw new Refusal(`"${key}" is a symbolic link: ${value}`);
  } catch (err) {
    if (err instanceof Refusal) throw err;
  }
  return resolved;
}

function plan(specFile, { env = process.env, patterns } = {}) {
  if (isSandboxed(env)) {
    throw new Refusal([
      'The runner is itself running inside the agent sandbox (SANDBOX_RUNTIME=1), so the command it starts would',
      'be too. Add its invocation to sandbox.excludedCommands, for example',
      `  "node ${__filename} *"`,
      'and run it as one bare command.',
    ].join('\n'));
  }
  const spec = readSpec(specFile);
  const specDir = path.dirname(path.resolve(specFile));
  const cwd = spec.cwd === undefined ? process.cwd() : spec.cwd;
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Refusal('"cwd" must be an absolute path.');
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Refusal(`"cwd" is not a directory: ${cwd}`);

  const childEnv = { ...process.env };
  if (spec.env !== undefined) {
    if (!spec.env || typeof spec.env !== 'object' || Array.isArray(spec.env)) throw new Refusal('"env" must be an object of strings.');
    for (const [key, value] of Object.entries(spec.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string') throw new Refusal(`"env.${key}" must be a name with a string value.`);
      if (LOADER_ENV.test(key)) throw new Refusal(`"env.${key}" changes what a program loads, so the runner will not set it.`);
      childEnv[key] = value;
    }
  }

  const list = patterns || configuredExclusions({ env, root: cwd });
  const pattern = exemptPattern(spec.argv, list);
  if (!pattern) {
    throw new Refusal(
      `"${spec.argv.join(' ')}" matches no sandbox exclusion, so the runner will not run it outside the sandbox. ` +
      'Run it as an ordinary command instead.' +
      (list.length ? '' : ' (No exclusions were found: set "git config rundock.sandboxSettings <settings file>".)'));
  }
  return {
    argv: spec.argv,
    cwd,
    env: childEnv,
    pattern,
    stdout: outputPath(spec.stdout, 'stdout', { cwd, specDir }),
    stderr: outputPath(spec.stderr, 'stderr', { cwd, specDir }),
  };
}

function execute(p) {
  const fds = [];
  const open = (file) => { const fd = fs.openSync(file, 'w'); fds.push(fd); return fd; };
  try {
    const result = spawnSync(p.argv[0], p.argv.slice(1), {
      cwd: p.cwd,
      env: p.env,
      stdio: ['ignore', p.stdout ? open(p.stdout) : 'inherit', p.stderr ? open(p.stderr) : 'inherit'],
    });
    if (result.error) throw new Refusal(`Could not start "${p.argv[0]}": ${result.error.message}`);
    if (result.signal) return 128 + (os.constants.signals[result.signal] || 0);
    return result.status;
  } finally {
    for (const fd of fds) fs.closeSync(fd);
  }
}

if (require.main === module) {
  const file = process.argv[2];
  if (!file || process.argv.length > 3) {
    process.stderr.write('Usage: node scripts/exempt-run.js <args-file>.json (one argument, the file; see the file header)\n');
    process.exit(2);
  }
  try {
    process.exit(execute(plan(file)));
  } catch (err) {
    if (!(err instanceof Refusal)) throw err;
    process.stderr.write(`exempt-run: ${err.message}\n`);
    process.exit(2);
  }
}

module.exports = { plan, execute, exemptPattern, configuredExclusions, Refusal, LOADER_ENV };
