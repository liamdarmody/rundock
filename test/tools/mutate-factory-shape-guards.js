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
// The release gate's own refusal. Broken, the gate starts for real, and stops
// at its first check because the mutation itself leaves the tree dirty.
const GATE = { src: path.join(ROOT, 'scripts', 'release-gate.js'), suite: 'test/unit/sandbox-refusal.test.js' };
const STOCK = { src: path.join(ROOT, 'scripts', 'stock-take.js'), suite: 'test/unit/stock-take.test.js' };
const CAPABILITY = { src: path.join(ROOT, 'scripts', 'capability-preflight.js'), suite: 'test/unit/sandbox-refusal.test.js' };

const MUTATIONS = [
  // ===== THE WRAPPERS AN EXCLUSION CANNOT MATCH =====
  [SHAPE, 'a chain splits the command, so the excluded part is found',
    "      if (next === '&') { split('chain'); i++; continue; }",
    "      if (next === '&') { i++; continue; }"],
  [SHAPE, 'a pipe is a wrapper',
    "{ split('pipe'); if (next === '&') i++; }",
    "{ endWord(); if (next === '&') i++; }"],
  [SHAPE, 'a redirect to a file is a wrapper',
    "      wrappers.add('redirect');\n      if (c === '<'",
    "      if (c === '<'"],
  [SHAPE, 'a VAR=value prefix is a wrapper',
    "    if (seg.env.length) wrappers.add('env');",
    "    if (seg.env.length) seg.words.unshift(...seg.env);"],
  [SHAPE, 'a substitution is a wrapper',
    "wrappers.add('substitution'); begin();",
    "begin();"],
  [SHAPE, 'operators inside quotes are text',
    "    if (c === \"'\" || c === '\"') { begin(); quote = c; quoted = true; continue; }",
    "    if (c === \"'\" || c === '\"') { begin(); quoted = true; continue; }"],
  // ===== TEXT THAT IS DATA IS NEVER MATCHED AS A COMMAND =====
  [SHAPE, 'a here-document body is data, never matched as a command',
    "  const raw = text.trim();",
    "  const raw = String(command).trim();"],
  [SHAPE, 'a here-document that never reaches its delimiter is data to the end',
    "  const done = r.ok ? r : r.unfinished;",
    "  const done = r.ok ? r : null;"],
  [SHAPE, 'the text inside a quoted argument never makes an exclusion match',
    "seg.words.map((w, k) => (k > 0 && seg.quoted[k] && /\\s/.test(w) && !/^(~|\\.{1,2})?\\//.test(w) ? QUOTED : w))",
    "seg.words"],
  [SHAPE, 'a quoted word with no space, such as a script path, is matched as written',
    "seg.quoted[k] && /\\s/.test(w) &&",
    "seg.quoted[k] &&"],
  [SHAPE, 'a quoted command word is matched as written',
    "(k > 0 && seg.quoted[k]",
    "(seg.quoted[k]"],
  [SHAPE, 'a quoted path, spaces and all, is matched as written',
    " && !/^(~|\\.{1,2})?\\//.test(w)",
    ""],
  [SHAPE, 'a path may start with ~/, ./ or ../',
    "/^(~|\\.{1,2})?\\//",
    "/^\\//"],
  // ===== TEXT A SHELL RUNS IS A COMMAND =====
  [SHAPE, "a shell's -c string is matched as a command",
    "    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(seg.words[j])) return seg.words.slice(j + 1, j + 2);",
    "    if (false) return seg.words.slice(j + 1, j + 2);"],
  [SHAPE, "eval's arguments are matched as a command",
    "  if (name === 'eval') return [seg.words.slice(k + 1).join(' ')];",
    "  if (name === 'eval') return [];"],
  [SHAPE, 'a here-document fed to a shell is matched as commands',
    "  const fed = seg.heredocs.map((n) => bodies[n] && bodies[n].body);",
    "  const fed = [];"],
  // ===== A SHELL PAST A PREFIX, OR FED BY A PIPE =====
  [SHAPE, 'a shell behind a prefix is still a shell',
    "  while (k < words.length && Object.hasOwn(PREFIXES, path.basename(words[k]))) {",
    "  while (false) {"],
  [SHAPE, "a prefix's options are skipped",
    "(/^-./.test(words[k]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k]))",
    "(false || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k]))"],
  [SHAPE, "env's VAR=value words are skipped",
    "(/^-./.test(words[k]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k]))",
    "(/^-./.test(words[k]))"],
  [SHAPE, "a prefix's option value is skipped",
    "      if (PREFIXES[prefix].includes(words[k])) k++;",
    "      if (false) k++;"],
  [SHAPE, "timeout's duration is skipped",
    "    if (prefix === 'timeout') k++;",
    "    if (false) k++;"],
  [SHAPE, 'a shell piped into reads what the segment before it gives',
    "  if (before && seg.op === 'pipe') {",
    "  if (false) {"],
  [SHAPE, 'only a pipe feeds a shell',
    "  if (before && seg.op === 'pipe') {",
    "  if (before && seg.op) {"],
  [SHAPE, 'a segment remembers the operator before it',
    "    cur().op = kind;\n",
    ""],
  [SHAPE, 'a shell is fed the quoted words piped into it',
    ", ...before.words.filter((w, q) => before.quoted[q])",
    ""],
  [SHAPE, "a shell's options end at the first word that is not one",
    "  for (; j < seg.words.length && /^[-+]./.test(seg.words[j]); j++) {",
    "  for (; j < seg.words.length; j++) {"],
  [SHAPE, '-o and -O take a value',
    "    if (/^[-+][oO]$/.test(seg.words[j])) j++;",
    "    if (false) j++;"],
  [SHAPE, 'a shell running a script is fed input, not commands',
    "  if (j < seg.words.length && seg.words[j] !== '-' && !stdin) return [];",
    "  if (false) return [];"],
  [SHAPE, '-s reads commands from stdin',
    ".some((w) => /^-[A-Za-z]*s[A-Za-z]*$/.test(w))",
    ".some(() => false)"],
  [SHAPE, "a pipe after a shell is the pipe of what it runs",
    " || Boolean(outer && outer.piped)",
    ""],
  [SHAPE, "a redirect after a shell is the redirect of what it runs",
    "seg.redirects[0] || (outer && outer.stdout) || null",
    "seg.redirects[0] || null"],
  // ===== WHAT A SUBSTITUTION RUNS IS A COMMAND =====
  [SHAPE, "a substitution's command is matched as a command",
    "  return found;",
    "  return [];"],
  [SHAPE, 'a here-document whose body expands has its substitutions read',
    "    if (bodies[n] && bodies[n].expands) found.push(",
    "    if (false) found.push("],
  [SHAPE, 'a substitution in a quoted here-document body is text',
    "if (bodies[n] && bodies[n].expands) found.push(",
    "if (bodies[n]) found.push("],
  [SHAPE, 'a here-document keeps whether its body expands',
    "{ text: done.text, bodies: done.bodies }",
    "{ text: done.text, bodies: done.bodies.map((b) => ({ body: b.body })) }"],
  [SHAPE, "a VAR=value prefix's substitution is read",
    "substitutions([...seg.envRaw, ...seg.raw].join(' '))",
    "substitutions(seg.raw.join(' '))"],
  [SHAPE, 'substitutions are found in the text as written, so single quotes hide them',
    "substitutions([...seg.envRaw, ...seg.raw].join(' '))",
    "substitutions([...seg.env, ...seg.words].join(' '))"],
  [SHAPE, 'what a substitution runs is named as a substitution',
    "['substitution', substitutionRuns(seg, bodies)]",
    "['shell', substitutionRuns(seg, bodies)]"],
  [SHAPE, 'a here-document is numbered to the segment it is fed to',
    "      if (c === '<' && next === '<' && s[i + 2] !== '<') cur().heredocs.push(heredocCount++);\n",
    ""],
  [SHAPE, 'every shell is recognised',
    "const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);",
    "const SHELLS = new Set(['bash']);"],
  [SHAPE, 'a shell is recognised by the last part of its path',
    "  const name = path.basename(seg.words[k] || '');",
    "  const name = seg.words[k] || '';"],
  [SHAPE, '-c counts inside a cluster of options',
    "/^-[A-Za-z]*c[A-Za-z]*$/",
    "/^-c$/"],
  [SHAPE, 'what a shell runs is wrapped in it, even when the shell is bare',
    "  if (outer) wrappers.add(outer.kind);\n",
    ""],
  [SHAPE, 'what a shell runs starts in the directory the shell was started in',
    "    const at = cwdOf(segments, i) || (outer && outer.at) || null;",
    "    const at = cwdOf(segments, i) || null;"],
  [SHAPE, 'opening a quote marks the word as quoted',
    "    if (c === \"'\" || c === '\"') { begin(); quote = c; quoted = true; continue; }",
    "    if (c === \"'\" || c === '\"') { begin(); quote = c; continue; }"],
  [SHAPE, 'the quoted mark ends with its word',
    "    word = null;\n    quoted = false;",
    "    word = null;"],
  [SHAPE, 'a VAR=value prefix takes its quoted mark with it',
    "seg.envRaw.push(seg.raw.shift()); seg.quoted.shift(); }",
    "seg.envRaw.push(seg.raw.shift()); }"],
  // ===== A SUGGESTED COMMAND IS PRINTED AS WRITTEN =====
  [SHAPE, 'the suggested command is the text as written, quotes and all',
    "      segment: seg.raw.join(' '),",
    "      segment: seg.words.join(' '),"],
  [SHAPE, "a word's text starts where the word does",
    "{ if (word === null) { word = ''; start = i; } }",
    "{ if (word === null) { word = ''; } }"],
  [SHAPE, "&& is not part of the word before it",
    "{ split('chain'); i++; continue; }",
    "{ i++; split('chain'); continue; }"],
  [SHAPE, '|| is not part of the word before it',
    "if (next === '|') { split('chain'); i++; }",
    "if (next === '|') { i++; split('chain'); }"],
  [SHAPE, 'a VAR=value takes its written text with it',
    "seg.envRaw.push(seg.raw.shift());",
    "seg.envRaw.push(seg.raw[0]);"],
  [SHAPE, 'a VAR=value is shown as written',
    "shownEnv: seg.envRaw.join(' '),",
    "shownEnv: seg.env.join(' '),"],
  [SHAPE, "a cd's directory is shown as written",
    "shown: segments[j].raw[1]",
    "shown: segments[j].words[1]"],
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
  // ===== A COMMAND WITH ITS SANDBOX OFF RUNS OUTSIDE IT IN ANY SHAPE =====
  [SHAPE, 'a command whose sandbox is deliberately off is let through',
    "  if (payload.tool_input.dangerouslyDisableSandbox === true) return { code: 0 };\n",
    ""],
  [SHAPE, 'only the boolean true turns the sandbox off',
    "  if (payload.tool_input.dangerouslyDisableSandbox === true) return { code: 0 };",
    "  if (payload.tool_input.dangerouslyDisableSandbox) return { code: 0 };"],
  // ===== THE REFUSAL NAMES FORMS THAT WORK =====
  [SHAPE, 'the runner is named only when its own command is excluded',
    "  if (r.runner) {",
    "  if (true) {"],
  [SANDBOX, 'the runner is offered when its own command is excluded',
    "  return Boolean(matchingPattern(`node ${RUNNER} args.json`, patterns));",
    "  return false;"],
  [SHAPE, 'a command after a cd is given as two calls',
    "    } else if (r.fix.cd) {",
    "    } else if (false) {"],
  [SHAPE, 'a git command with -C carries its own directory, so it is given bare',
    "  if (git) return { cwd: git, shown: null };",
    "  if (git) return { cwd: git, shown: git };"],
  [SHAPE, 'a VAR=value moves into a small script that sets it',
    "    if (env) {",
    "    if (false) {"],
  [SHAPE, 'piped or redirected output is read from the result of the call',
    "    if (r.fix.stdout || r.fix.piped) lines.push(",
    "    if (false) lines.push("],
  [SHAPE, 'a near miss is given as the command the exclusion names',
    "        named: seg.raw.slice(0, hit.length).join(' '),",
    "        named: seg.raw.join(' '),"],
  [SHAPE, 'a wrapped near miss is given as the command the exclusion names',
    "    } else if (r.fix.near) {",
    "    } else if (false) {"],
  [SHAPE, 'a wrapped near miss keeps the cd before it',
    "      if (r.fix.cd) lines.push('Put the values inside the script",
    "      if (false) lines.push('Put the values inside the script"],
  // ===== THE FIX NAMES THE DIRECTORY =====
  [SHAPE, 'the fix takes the directory from the cd before the command',
    "    if (segments[j].words[0] === 'cd' && segments[j].words[1]) return",
    "    if (false) return"],

  // ===== THE MARKER =====
  [SANDBOX, 'only SANDBOX_RUNTIME=1 means sandboxed',
    "  return env.SANDBOX_RUNTIME === '1';",
    "  return false;"],
  [SANDBOX, 'a sandboxed step names the runner only when its own command is excluded',
    "  if (runnerExcluded(patterns)) {",
    "  if (true) {"],
  [SANDBOX, 'with no exclusions given, a sandboxed step reads the configured ones',
    "  const list = patterns || exclusionsHere(env);",
    "  const list = patterns || [];"],
  [SANDBOX, "the configured exclusions are the project's",
    "env.CLAUDE_PROJECT_DIR || process.cwd()",
    "process.cwd()"],
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
  // ===== THE STOCK-TAKE'S COMMAND FOR A PERSON =====
  [STOCK, 'a section whose branch no longer exists is listed for removal',
    "    .filter((name) => !existing.has(name) || removing.has(name))",
    "    .filter((name) => removing.has(name))"],
  [STOCK, 'a section whose branch still stays is never removed',
    "    .filter((name) => !existing.has(name) || removing.has(name))",
    "    .filter((name) => true)"],
  [STOCK, 'a dotted branch name is kept whole',
    "    const name = key.slice('branch.'.length, key.lastIndexOf('.'));",
    "    const name = key.slice('branch.'.length, key.indexOf('.', 'branch.'.length));"],
  [STOCK, 'removing the last linked worktree recreates .git/worktrees',
    "  if (removesLastWorktree) parts.push(",
    "  if (false) parts.push("],
  [STOCK, 'a worktree with uncommitted work is never removable',
    "(w.missing || (w.dirty === 0 && w.unpushed === 0))",
    "(w.missing || w.unpushed === 0)"],
  [STOCK, 'a branch with commits on no remote is never removable',
    "  const removableBranches = branches.filter((b) => b.unpushed === 0 && ",
    "  const removableBranches = branches.filter((b) => true && "],
  [STOCK, 'a name typed into a terminal is quoted',
    "  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(s) ? s :",
    "  return true ? s :"],
  // ===== A LONG STEP REFUSES AT ONCE INSIDE THE SANDBOX =====
  [GATE, 'the release gate refuses in its first second when sandboxed',
    "  require('./lib/sandbox.js').refuseIfSandboxed('The release gate', 'npm run release:gate');\n",
    ""],
  [CAPABILITY, 'the capability preflight tries nothing inside the sandbox',
    "  if (isSandboxed(env)) {\n    const lines = [",
    "  if (false) {\n    const lines = ["],
  [CAPABILITY, 'the preflight names the runner only when its own command is excluded',
    "    if (runnerExcluded(patterns || exclusionsHere(env))) lines.push(",
    "    if (true) lines.push("],
  [CAPABILITY, 'the preflight reads the configured exclusions when none are given',
    "runnerExcluded(patterns || exclusionsHere(env))",
    "runnerExcluded(patterns || [])"],
  [CAPABILITY, 'the push check is a dry run',
    "['push', '--dry-run', '--porcelain', 'origin',",
    "['push', '--porcelain', 'origin',"],
  [CAPABILITY, 'a push that cannot authenticate is named as such',
    "      return { ok: false, cause: 'git could not authenticate to origin.', fix: 'gh auth setup-git (after gh auth login, at a terminal)' };",
    "      return { ok: false, cause: 'push failed', fix: 'retry' };"],
  [CAPABILITY, 'a missing browser is named, with its install command',
    "      return { ok: false, cause: 'Playwright has no Chromium installed for this checkout.', fix: 'npx playwright install chromium' };",
    "      return { ok: false, cause: 'Chromium failed', fix: 'retry' };"],
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
