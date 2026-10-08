#!/usr/bin/env node
'use strict';
// Break each of the command-shape guards in turn and report which tests
// notice.
//
// These guards decide whether a sandbox-excluded command is refused before
// it runs, whether the runner will start a command at all, and whether a long
// step refuses inside the sandbox. Each one polices a shape that otherwise
// fails late and misleadingly, so each is broken here on purpose and a test
// must go red.
//
// A guard whose mutation turns nothing red is reported as a FAILURE rather
// than passed over. An experiment that changes nothing has not been run.
//
//   node test/tools/mutate-factory-shape-guards.js            # report
//   node test/tools/mutate-factory-shape-guards.js --markdown # the same, as a table
//
// The files are restored afterwards, including when a run throws. The
// harness is the same shape as mutate-sdlc-gate-guards.js and deliberately a
// separate copy, for the reason stated in mutate-routines-truth-guards.js.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const { preflight } = require('../helpers/temp-root.js');
const {
  beginMutationRun, targetsFromRows, rowsForShard, exitCodeFor, NO_VERDICT,
} = require('./mutation-run.js');

const ROOT = path.join(__dirname, '..', '..');

const SHAPE = { src: path.join(ROOT, 'scripts', 'command-shape.js'), suite: 'test/unit/command-shape.test.js' };
const SANDBOX = { src: path.join(ROOT, 'scripts', 'lib', 'sandbox.js'), suite: 'test/unit/command-shape.test.js' };
const RUNNER = { src: path.join(ROOT, 'scripts', 'exempt-run.js'), suite: 'test/unit/exempt-run.test.js' };

const MUTATIONS = [
  // ===== THE WRAPPERS AN EXCLUSION CANNOT MATCH =====
  [SHAPE, 'a chain splits the command, so the excluded part is found',
    "      if (next === '&') { i++; split('chain'); continue; }",
    "      if (next === '&') { i++; continue; }"],
  [SHAPE, 'a pipe is a wrapper',
    "if (next === '&') i++; split('pipe'); }",
    "if (next === '&') i++; endWord(); }"],
  [SHAPE, 'a redirect to a file is a wrapper',
    "      wrappers.add('redirect');\n      while",
    "      while"],
  [SHAPE, 'a VAR=value prefix is a wrapper',
    "    if (seg.env.length) wrappers.add('env');",
    "    if (seg.env.length) seg.words.unshift(...seg.env);"],
  [SHAPE, 'a substitution is a wrapper',
    "    if (c === '`' || (c === '$' && next === '(')) { const end = substitutionEnd(s, i); wrappers.add('substitution'); word = (word ?? '') + s.slice(i, end); i = end - 1; continue; }",
    "    if (c === '`' || (c === '$' && next === '(')) { const end = substitutionEnd(s, i); word = (word ?? '') + s.slice(i, end); i = end - 1; continue; }"],
  [SHAPE, 'operators inside quotes are text',
    "    if (c === \"'\" || c === '\"') { quote = c; word = word ?? ''; continue; }",
    "    if (c === \"'\" || c === '\"') { word = word ?? ''; continue; }"],
  // ===== THE NEAR MISS: AN EXCLUSION THAT NAMES THE SCRIPT ALONE =====
  [SHAPE, 'a bare command matched only without its arguments is refused',
    "    if (bare && !hit.near) return { verdict: 'pass' };",
    "    if (bare) return { verdict: 'pass' };"],
  // ===== GIT: ONLY THE REMOTE COMMANDS =====
  [SHAPE, 'a wrapped git command that talks to a remote is refused',
    "const GIT_REMOTE = new Set(['push', 'fetch', 'pull', 'ls-remote', 'clone']);",
    "const GIT_REMOTE = new Set([]);"],
  [SHAPE, 'a wrapped git command that stays local is let through',
    "    if (!bare && seg.words[0] === 'git' && !GIT_REMOTE.has(gitSubcommand(seg.words))) continue;\n",
    ""],
  // ===== THE FIX NAMES THE DIRECTORY =====
  [SHAPE, 'the fix takes the directory from the cd before the command',
    "      if (segments[j].words[0] === 'cd' && segments[j].words[1]) cwd = segments[j].words[1];",
    "      if (false) cwd = segments[j].words[1];"],

  // ===== THE MARKER =====
  [SANDBOX, 'only SANDBOX_RUNTIME=1 means sandboxed',
    "  return env.SANDBOX_RUNTIME === '1';",
    "  return false;"],
  [SANDBOX, 'a glob matches the whole command',
    "  return new RegExp(`^${body}$`, 's');",
    "  return new RegExp(body, 's');"],

  // ===== THE RUNNER RUNS ONLY WHAT IS ALREADY EXEMPT =====
  [RUNNER, 'a command no exclusion names is refused',
    "  if (!pattern) {\n    throw new Refusal(",
    "  if (false) {\n    throw new Refusal("],
  [RUNNER, 'the runner refuses inside the sandbox',
    "  if (isSandboxed(env)) {",
    "  if (false) {"],
  [RUNNER, 'a loader variable is refused',
    "      if (LOADER_ENV.test(key)) throw new Refusal(",
    "      if (false) throw new Refusal("],
  [RUNNER, 'an output file stays in the working directory or beside the arguments',
    "  if (!inside(cwd) && !inside(specDir)) {",
    "  if (false) {"],
  [RUNNER, 'an unknown key in the arguments file is refused',
    "  for (const key of Object.keys(spec)) if (!known.has(key)) throw new Refusal(",
    "  for (const key of Object.keys(spec)) if (false) throw new Refusal("],
];

const REPORTER = ['--test-reporter', 'spec'];

function redTests(suite) {
  let out = '';
  let failed = false;
  try {
    out = execFileSync('node', ['--test', ...REPORTER, suite],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    failed = true;
    out = (e.stdout || '') + (e.stderr || '');
  }
  const marker = out.indexOf('failing tests:');
  if (marker === -1) {
    if (!failed) return [];
    // A suite that failed with output this could not read has produced no
    // verdict: not red, not green, nothing. Refused as a named row rather
    // than thrown, so the report says which mutation was in flight instead
    // of a stack trace that names nothing. The spec reporter's format is
    // what this parses; if it changed, fix the parser rather than trusting
    // an empty result.
    return { unparsable: true };
  }
  const names = [];
  for (const line of out.slice(marker).split('\n')) {
    const m = /^✖ (.+?) \(\d/.exec(line.trim());
    if (m && !names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

function run() {
  // Derived from the rows, so a row naming a new target cannot crash the run
  // on a target nobody listed.
  const targets = targetsFromRows(MUTATIONS);
  const session = beginMutationRun({ files: [...new Set(targets.map((target) => target.src))] });
  const originals = new Map();
  for (const target of targets) originals.set(target, session.original(target.src));
  const results = [];
  try {
    for (const [target, label, guard, without] of rowsForShard(MUTATIONS)) {
      const original = originals.get(target);
      const matches = original.split(guard).length - 1;
      if (matches === 0) {
        results.push({ label, applied: false, red: [] });
        continue;
      }
      // A GUARD THAT MATCHES MORE THAN ONCE IS REFUSED RATHER THAN TAKING THE
      // FIRST: String.replace takes the first occurrence, so a search text
      // that also appears somewhere else quietly breaks the wrong code and
      // reports on whatever that turns red.
      if (matches > 1) {
        results.push({ label, applied: false, ambiguous: matches, red: [] });
        continue;
      }
      fs.writeFileSync(target.src, original.replace(guard, without));
      const red = redTests(target.suite);
      results.push(red && red.unparsable
        ? { label, applied: true, unparsable: true, red: [] }
        : { label, applied: true, red });
      fs.writeFileSync(target.src, original);
    }
  } finally {
    session.finish();
  }
  return results;
}

function report(results, markdown) {
  let failed = 0;
  const lines = [];
  for (const { label, applied, red, ambiguous, unparsable } of results) {
    if (unparsable) {
      failed++;
      const why = 'no verdict: the suite failed but its output could not be parsed, so nothing '
        + 'about this mutation is known; fix the reporter parsing rather than trusting a rerun';
      lines.push(markdown ? `| ${label} | **${why}** | |` : `${label}\n  ${why.toUpperCase()}`);
      continue;
    }
    if (ambiguous) {
      failed++;
      const why = `the guard text matches ${ambiguous} places, so it would break whichever came first`;
      lines.push(markdown ? `| ${label} | **${why}** | |` : `${label}\n  AMBIGUOUS: ${why}`);
      continue;
    }
    if (!applied) {
      failed++;
      lines.push(markdown
        ? `| ${label} | **the guard text was not found, so nothing was mutated** | |`
        : `${label}\n  THE GUARD TEXT WAS NOT FOUND, so nothing was mutated`);
      continue;
    }
    if (red.length === 0) {
      failed++;
      lines.push(markdown ? `| ${label} | **nothing turned red** | |` : `${label}\n  NOTHING TURNED RED`);
      continue;
    }
    lines.push(markdown
      ? `| ${label} | ${red.length} | ${red.map((n) => `\`${n}\``).join('<br>')} |`
      : `${label}\n  ${red.length} red\n${red.map((n) => `    - ${n}`).join('\n')}`);
  }
  if (markdown) {
    console.log('| Guard broken | Tests red | Which |');
    console.log('|---|---|---|');
    for (const line of lines) console.log(line);
  } else {
    for (const line of lines) console.log(`\n${line}`);
  }
  return failed;
}

// REFUSE TO START ON A MACHINE THAT WOULD MISREPORT. See
// mutate-routines-guards.js for the runs that taught this: a full temp root
// surfaces as tests going red, and red tests are exactly what this
// instrument reports as a guard nobody was watching.
function requireSaneTempRoot() {
  const verdict = preflight(os.tmpdir());
  if (verdict.ok) return;
  console.error(verdict.message);
  process.exit(NO_VERDICT);
}

if (require.main === module) {
  requireSaneTempRoot();
  if (process.argv.includes('--preflight-only')) process.exit(0);
  const results = run();
  const failed = report(results, process.argv.includes('--markdown'));
  if (failed) {
    console.error(`\n${failed} mutation(s) proved nothing. A guard no test notices is not guarded,`
      + ' and a mutation that could break more than one place proves nothing about either.');
    process.exit(exitCodeFor(failed, results));
  }
}

module.exports = { MUTATIONS, run };
