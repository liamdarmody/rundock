#!/usr/bin/env node
'use strict';

/**
 * Refuse a Bash command that wraps a sandbox-excluded command in a shape the
 * exclusion cannot match, before it runs, and print the form that works.
 *
 * WHY. The sandbox leaves a command outside only when the whole command is one
 * bare command matching an exclusion (see scripts/lib/sandbox.js for what was
 * measured). Wrapped in a chain, a pipe, a redirect, a substitution or an
 * environment prefix, the same command runs sandboxed and fails late and
 * misleadingly: a browser that "can't start", a token that reads as "invalid".
 * Knowing the rule has not stopped the shape recurring, so the rule is a hook.
 *
 * WHAT IT REFUSES, and nothing else:
 *   - a wrapped command: any segment of a compound command that an exclusion
 *     names, when the command is not one bare command;
 *   - a near miss: a bare command an exclusion names only without its
 *     arguments (a pattern with no trailing `*`).
 * Git is the one carve-out: `git *` is usually excluded for its network
 * commands, and a wrapped `git log | head` loses nothing in the sandbox, so a
 * wrapped git command is refused only when it talks to a remote.
 *
 * As a Claude Code PreToolUse hook (matcher "Bash"):
 *   node scripts/command-shape.js [--settings <file>]...
 * It reads the hook payload on stdin, reads `sandbox.excludedCommands` from the
 * project's and the user's settings (and any --settings file), and exits 2 with
 * the refusal on stderr, or 0 to let the command run. Anything it cannot read
 * lets the command run: it is a guard against a mistake, not a boundary.
 */

const fs = require('node:fs');
const path = require('node:path');
const { matchingPattern, exclusionsFrom, settingsFilesFor } = require('./lib/sandbox.js');

const RUNNER = path.join(__dirname, 'exempt-run.js');

// Git subcommands that need what the sandbox withholds: the network and the
// stored credential.
const GIT_REMOTE = new Set(['push', 'fetch', 'pull', 'ls-remote', 'clone']);

// ---------------------------------------------------------------------------
// Parsing: enough shell to find segments, operators and redirect targets.
// ---------------------------------------------------------------------------

// The index just past a substitution starting at i: "$(" to its matching ")",
// or a backtick to the next one. An unterminated one runs to the end.
function substitutionEnd(s, i) {
  if (s[i] === '`') {
    const close = s.indexOf('`', i + 1);
    return close === -1 ? s.length : close + 1;
  }
  let depth = 0;
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '(') depth++;
    else if (s[j] === ')' && --depth === 0) return j + 1;
  }
  return s.length;
}

function parse(command) {
  const s = String(command);
  const segments = [{ words: [], redirects: [] }];
  const wrappers = new Set();
  let word = null;
  let quote = null;
  let redirectNext = false;

  const cur = () => segments[segments.length - 1];
  const endWord = () => {
    if (word === null) return;
    if (redirectNext) { cur().redirects.push(word); redirectNext = false; } else cur().words.push(word);
    word = null;
  };
  const split = (kind) => {
    endWord();
    wrappers.add(kind);
    if (cur().words.length || cur().redirects.length) segments.push({ words: [], redirects: [] });
  };

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const next = s[i + 1];
    if (quote === "'") {
      if (c === "'") quote = null; else word += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') { quote = null; continue; }
      if (c === '\\' && next !== undefined && '"\\$`'.includes(next)) { word += next; i++; continue; }
      if (c === '`' || (c === '$' && next === '(')) { const end = substitutionEnd(s, i); wrappers.add('substitution'); word += s.slice(i, end); i = end - 1; continue; }
      word += c;
      continue;
    }
    if (c === '\\') { word = (word ?? '') + (next ?? ''); i++; continue; }
    if (c === "'" || c === '"') { quote = c; word = word ?? ''; continue; }
    if (c === ' ' || c === '\t') { endWord(); continue; }
    if (c === '`' || (c === '$' && next === '(')) { const end = substitutionEnd(s, i); wrappers.add('substitution'); word = (word ?? '') + s.slice(i, end); i = end - 1; continue; }
    if (c === '\n' || c === ';') { split('chain'); continue; }
    if (c === '(' || c === ')') { split('subshell'); continue; }
    if (c === '|') {
      if (next === '|') { i++; split('chain'); } else { if (next === '&') i++; split('pipe'); }
      continue;
    }
    if (c === '&') {
      if (next === '&') { i++; split('chain'); continue; }
      if (next === '>') { endWord(); wrappers.add('redirect'); i++; if (s[i + 1] === '>') i++; redirectNext = true; continue; }
      split('chain');
      continue;
    }
    if (c === '>' || c === '<') {
      // A word of digits right before the operator is the descriptor, not an
      // argument.
      if (word !== null && /^\d+$/.test(word)) word = null;
      endWord();
      // Descriptor duplication (2>&1, >&2) sends output nowhere new, and the
      // sandbox's matching ignores it.
      const dup = /^[<>]&(\d+|-)/.exec(s.slice(i));
      if (dup) { i += dup[0].length - 1; continue; }
      wrappers.add('redirect');
      while (s[i + 1] === '>' || s[i + 1] === '<' || s[i + 1] === '|') i++;
      redirectNext = true;
      continue;
    }
    word = (word ?? '') + c;
  }
  endWord();

  for (const seg of segments) {
    seg.env = [];
    while (seg.words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(seg.words[0])) seg.env.push(seg.words.shift());
    if (seg.env.length) wrappers.add('env');
  }
  return { segments: segments.filter((seg) => seg.words.length || seg.env.length), wrappers };
}

// The git subcommand, past its global options.
function gitSubcommand(words) {
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w === '-C' || w === '-c') { i++; continue; }
    if (w.startsWith('-')) continue;
    return w;
  }
  return null;
}

function gitDir(words) {
  const i = words.indexOf('-C');
  return words[0] === 'git' && i > 0 && words[i + 1] ? words[i + 1] : null;
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

function exclusionFor(words, patterns) {
  const whole = matchingPattern(words.join(' '), patterns);
  if (whole) return { pattern: whole, near: false };
  for (let k = words.length - 1; k >= 1; k--) {
    const p = matchingPattern(words.slice(0, k).join(' '), patterns);
    if (p) return { pattern: p, near: true };
  }
  return null;
}

const WRAPPER_NAMES = {
  chain: 'a chain ("&&", "||", ";" or a second line)',
  pipe: 'a pipe',
  redirect: 'a redirect to or from a file',
  substitution: 'a command substitution ("$(...)" or backticks)',
  env: 'a VAR=value prefix',
  subshell: 'a subshell',
};

function classify(command, patterns) {
  if (!patterns || !patterns.length) return { verdict: 'pass' };
  const raw = String(command).trim();
  if (!raw) return { verdict: 'pass' };
  const { segments, wrappers } = parse(raw);
  const bare = wrappers.size === 0 && segments.length === 1;

  if (bare && matchingPattern(raw, patterns)) return { verdict: 'pass' };

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const hit = exclusionFor(seg.words, patterns);
    if (!hit) continue;
    if (bare && !hit.near) return { verdict: 'pass' };
    if (!bare && seg.words[0] === 'git' && !GIT_REMOTE.has(gitSubcommand(seg.words))) continue;
    let cwd = gitDir(seg.words);
    for (let j = i - 1; j >= 0 && !cwd; j--) {
      if (segments[j].words[0] === 'cd' && segments[j].words[1]) cwd = segments[j].words[1];
    }
    const result = {
      verdict: 'refuse',
      kind: bare ? 'near-miss' : 'wrapped',
      pattern: hit.pattern,
      segment: seg.words.join(' '),
      wrappers: [...wrappers],
      fix: {
        cwd,
        argv: seg.words.slice(),
        env: Object.fromEntries(seg.env.map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)])),
        stdout: seg.redirects[0] || null,
        piped: wrappers.has('pipe') && i < segments.length - 1,
      },
    };
    result.message = refusalMessage(result);
    return result;
  }
  return { verdict: 'pass' };
}

function refusalMessage(r) {
  const lines = [];
  if (r.kind === 'near-miss') {
    lines.push(`Refused before it ran: the sandbox exclusion "${r.pattern}" matches this command only without its`,
      'arguments, so with them it runs inside the sandbox and fails late.');
  } else {
    const how = r.wrappers.map((w) => WRAPPER_NAMES[w]).join(', ');
    lines.push(`Refused before it ran: "${r.segment}" runs outside the sandbox only as one bare command (exclusion`,
      `"${r.pattern}"). Wrapped in ${how}, it runs inside the sandbox and fails late and misleadingly:`,
      'a browser that cannot start, a credential that reads as invalid.');
  }
  lines.push('');
  const twoCalls = r.kind === 'wrapped' && !r.fix.stdout && !r.fix.piped && !Object.keys(r.fix.env).length;
  if (twoCalls) {
    lines.push('Run it as two calls, where the working directory persists between calls:');
    if (r.fix.cwd) lines.push(`  1. cd ${r.fix.cwd}`, `  2. ${r.segment}`);
    else lines.push(`  ${r.segment}`, '  (alone, with nothing chained before or after it)');
    lines.push('');
  }
  const spec = { cwd: r.fix.cwd || '<absolute working directory>', argv: r.fix.argv };
  if (Object.keys(r.fix.env).length) spec.env = r.fix.env;
  if (r.fix.stdout || r.fix.piped) spec.stdout = r.fix.stdout || '<absolute path for the output, beside this file>';
  lines.push(twoCalls
    ? 'Or, where the working directory resets between calls, write its arguments to a JSON file and run the runner on it, bare:'
    : 'Write its arguments to a JSON file and run the runner on it, bare:',
    `  node ${RUNNER} <args-file>.json`,
    'with the file holding:',
    `  ${JSON.stringify(spec)}`);
  if (r.kind === 'near-miss') {
    lines.push('', `The runner accepts a command whose script "${r.pattern}" names. Or put the values inside the script.`);
  }
  if (r.fix.piped) lines.push('', 'Then read or filter that output file in a separate call.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

function settingsFiles(argv, env, payloadCwd) {
  const files = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--settings' && argv[i + 1]) files.push(argv[++i]);
  const projectDir = env.CLAUDE_PROJECT_DIR || payloadCwd;
  files.push(...settingsFilesFor(projectDir));
  return files;
}

function runHook({ input, argv = [], env = process.env }) {
  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    return { code: 0 };
  }
  if (!payload || payload.tool_name !== 'Bash') return { code: 0 };
  const command = payload.tool_input && payload.tool_input.command;
  if (typeof command !== 'string') return { code: 0 };
  const patterns = exclusionsFrom(settingsFiles(argv, env, payload.cwd));
  const result = classify(command, patterns);
  if (result.verdict !== 'refuse') return { code: 0 };
  return { code: 2, stderr: `${result.message}\n` };
}

if (require.main === module) {
  let input = '';
  try {
    input = fs.readFileSync(0, 'utf8');
  } catch {
    process.exit(0);
  }
  const { code, stderr } = runHook({ input, argv: process.argv.slice(2) });
  if (stderr) process.stderr.write(stderr);
  process.exit(code);
}

module.exports = { parse, classify, runHook, GIT_REMOTE };
