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
 * wrapped git command is refused only when it talks to a remote. A command
 * whose tool input turns its sandbox off (`dangerouslyDisableSandbox: true`)
 * is never refused: it runs outside the sandbox whatever its shape.
 *
 * Text that is data is never matched against an exclusion: the body of a
 * here-document fed to anything but a shell, and a quoted argument with a
 * space in it. A quoted argument still counts as an argument, so
 * `gh pr comment 3 --body "x y" | cat` is refused under `gh *` as before. The
 * command word, a quoted word with no space, and a quoted path (starting /,
 * ~/, ./ or ../) with spaces in it, are matched as written. Text a shell runs is a command line, matched as one
 * wrapped in that shell: the string after `sh -c` (or bash, zsh, dash, ksh),
 * what `eval` is given, and what a shell reading stdin is fed, a here-document
 * or the here-document or quoted words of the command piped into it. A shell
 * is found past env, sudo, xargs, nohup, time, timeout, nice, exec and
 * command, and its options end at its first other word, so a script's own
 * `-c` is not the shell's, and a script is fed input, not commands. So is the body of
 * a `$( )` or backtick substitution, in the line, in a VAR=value, or in a
 * here-document body that expands (its marker unquoted).
 *
 * WHAT IT SUGGESTS: the command bare, on its own; after a `cd`, two calls, the
 * `cd` and then the command; for a VAR=value, a small script in the test tree
 * or the gitignored scratch folder that sets it for the child process it
 * starts; for a near miss, wrapped or not, the script with its values put
 * inside it, after the cd if there is one, since run bare with its arguments
 * it is a near miss again. Each command is printed as written, quotes and all, since run bare
 * with its quotes stripped it would be a different command.
 * scripts/exempt-run.js is named only when its own command matches an
 * exclusion: a runner not configured as an exclusion runs sandboxed like
 * anything else, so pointing to it would only move the failure.
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
const { matchingPattern, exclusionsFrom, settingsFilesFor, RUNNER, runnerExcluded } = require('./lib/sandbox.js');
const { stripHeredocs, substitutions } = require('./code-mode-parse.js');

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

// The command with each here-document's body cut out, the marker kept, and
// the bodies, as { body, expands }, in the order of their markers. A body is
// input to the command it is fed to; one that never reaches its delimiter runs
// to the end of the text. An unquoted marker's body expands: its
// substitutions run.
function heredocs(command) {
  const r = stripHeredocs(String(command));
  const done = r.ok ? r : r.unfinished;
  return done ? { text: done.text, bodies: done.bodies } : { text: String(command), bodies: [] };
}

// `quoted[k]` says whether part of `words[k]` was quoted (a substitution in it
// is read as a command of its own), `raw[k]` is the word as written, quotes and all,
// and `heredocs` numbers the here-documents a segment is fed, in the order of
// the line.
function parse(command) {
  const s = String(command);
  const fresh = () => ({ words: [], raw: [], quoted: [], redirects: [], heredocs: [] });
  const segments = [fresh()];
  const wrappers = new Set();
  let word = null;
  let start = 0;
  let quoted = false;
  let quote = null;
  let redirectNext = false;
  let heredocCount = 0;
  let i = 0;

  const cur = () => segments[segments.length - 1];
  const begin = () => { if (word === null) { word = ''; start = i; } };
  // Called with `i` on the character that ends the word.
  const endWord = () => {
    if (word === null) return;
    if (redirectNext) { cur().redirects.push(word); redirectNext = false; } else { cur().words.push(word); cur().raw.push(s.slice(start, i)); cur().quoted.push(quoted); }
    word = null;
    quoted = false;
  };
  const split = (kind) => {
    endWord();
    wrappers.add(kind);
    if (cur().words.length || cur().redirects.length) segments.push(fresh());
    cur().op = kind;
  };

  for (; i < s.length; i++) {
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
    if (c === '\\') { begin(); word += next ?? ''; i++; continue; }
    if (c === "'" || c === '"') { begin(); quote = c; quoted = true; continue; }
    if (c === ' ' || c === '\t') { endWord(); continue; }
    if (c === '`' || (c === '$' && next === '(')) { const end = substitutionEnd(s, i); wrappers.add('substitution'); begin(); word += s.slice(i, end); i = end - 1; continue; }
    if (c === '\n' || c === ';') { split('chain'); continue; }
    if (c === '(' || c === ')') { split('subshell'); continue; }
    if (c === '|') {
      if (next === '|') { split('chain'); i++; } else { split('pipe'); if (next === '&') i++; }
      continue;
    }
    if (c === '&') {
      if (next === '&') { split('chain'); i++; continue; }
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
      if (c === '<' && next === '<' && s[i + 2] !== '<') cur().heredocs.push(heredocCount++);
      while (s[i + 1] === '>' || s[i + 1] === '<' || s[i + 1] === '|') i++;
      redirectNext = true;
      continue;
    }
    begin();
    word += c;
  }
  endWord();

  for (const seg of segments) {
    seg.env = [];
    seg.envRaw = [];
    while (seg.words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(seg.words[0])) { seg.env.push(seg.words.shift()); seg.envRaw.push(seg.raw.shift()); seg.quoted.shift(); }
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

// The directory a segment runs in, where the line says: git's -C, or the
// nearest cd before it. `shown` is that cd's directory as written; git's -C
// needs no cd, so it has none.
function cwdOf(segments, i) {
  const git = gitDir(segments[i].words);
  if (git) return { cwd: git, shown: null };
  for (let j = i - 1; j >= 0; j--) {
    if (segments[j].words[0] === 'cd' && segments[j].words[1]) return { cwd: segments[j].words[1], shown: segments[j].raw[1] };
  }
  return null;
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);

// Words that run the command after them, each with those of its options that
// take a value. A shell behind one is still a shell.
const PREFIXES = {
  env: ['-u', '-C', '-S'], sudo: ['-u', '-g', '-C', '-D', '-h', '-p', '-R', '-T', '-U'],
  xargs: ['-I', '-L', '-n', '-P', '-s', '-E', '-d', '-a'], nohup: [], time: [],
  timeout: ['-s', '-k'], nice: ['-n'], exec: ['-a'], command: [],
};

// The index of the word that names the command, past any prefixes, their
// options, env's VAR=value words and timeout's duration.
function commandIndex(words) {
  let k = 0;
  while (k < words.length && Object.hasOwn(PREFIXES, path.basename(words[k]))) {
    const prefix = path.basename(words[k]);
    for (k++; k < words.length && (/^-./.test(words[k]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k])); k++) {
      if (PREFIXES[prefix].includes(words[k])) k++;
    }
    if (prefix === 'timeout') k++;
  }
  return k;
}

// The text a segment hands a shell to run as a command line: the string after
// a shell's -c, what eval is given, or what a shell reading its commands from
// stdin is fed: its here-document, or the here-document or quoted words of the
// segment piped into it (`before`). That text is commands, not data.
function shellRuns(seg, bodies, before) {
  const k = commandIndex(seg.words);
  const name = path.basename(seg.words[k] || '');
  if (name === 'eval') return [seg.words.slice(k + 1).join(' ')];
  if (!SHELLS.has(name)) return [];
  // Options end at the first word that is not one; -o and -O take a value.
  let j = k + 1;
  for (; j < seg.words.length && /^[-+]./.test(seg.words[j]); j++) {
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(seg.words[j])) return seg.words.slice(j + 1, j + 2);
    if (/^[-+][oO]$/.test(seg.words[j])) j++;
  }
  // A script runs from its file, and what it is fed is its input, unless -s.
  const stdin = seg.words.slice(k + 1, j).some((w) => /^-[A-Za-z]*s[A-Za-z]*$/.test(w));
  if (j < seg.words.length && seg.words[j] !== '-' && !stdin) return [];
  const fed = seg.heredocs.map((n) => bodies[n] && bodies[n].body);
  if (before && seg.op === 'pipe') {
    fed.push(...before.heredocs.map((n) => bodies[n] && bodies[n].body), ...before.words.filter((w, q) => before.quoted[q]));
  }
  return fed.filter((b) => b !== undefined);
}

// The commands a segment runs inside itself: the bodies of the $( ) and
// backtick substitutions in its text as written, its VAR=value prefixes
// included, and in a here-document it is fed whose body expands.
function substitutionRuns(seg, bodies) {
  const found = substitutions([...seg.envRaw, ...seg.raw].join(' ')).bodies;
  for (const n of seg.heredocs) {
    if (bodies[n] && bodies[n].expands) found.push(...substitutions(bodies[n].body, 'bash', { quoted: true }).bodies);
  }
  return found;
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

function exclusionFor(words, patterns) {
  const whole = matchingPattern(words.join(' '), patterns);
  if (whole) return { pattern: whole, near: false, length: words.length };
  for (let k = words.length - 1; k >= 1; k--) {
    const p = matchingPattern(words.slice(0, k).join(' '), patterns);
    if (p) return { pattern: p, near: true, length: k };
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
  shell: 'a shell ("sh -c", "eval" or a here-document fed to a shell)',
};

// A quoted argument with a space in it is data: a message, a body, a script
// for another interpreter. It stands in for any text but no pattern's literal
// part, so it is never what makes an exclusion match. The command word, a
// quoted word with no space, and a quoted path (starting /, ~/, ./ or ../),
// spaces and all, are matched as written.
const QUOTED = '\0';
const asMatched = (seg) => seg.words.map((w, k) => (k > 0 && seg.quoted[k] && /\s/.test(w) && !/^(~|\.{1,2})?\//.test(w) ? QUOTED : w));

// `outer` is set for text a shell or a substitution runs: it runs inside that
// one (`kind`), never as one bare command, and in the directory it was
// started in.
function classify(command, patterns, outer = null) {
  if (!patterns || !patterns.length) return { verdict: 'pass' };
  const { text, bodies } = heredocs(command);
  const raw = text.trim();
  if (!raw) return { verdict: 'pass' };
  const { segments, wrappers } = parse(raw);
  if (outer) wrappers.add(outer.kind);
  const bare = wrappers.size === 0 && segments.length === 1;

  if (bare && matchingPattern(raw, patterns)) return { verdict: 'pass' };

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const at = cwdOf(segments, i) || (outer && outer.at) || null;
    // Where its output goes, which is where the output of what it runs goes.
    const stdout = seg.redirects[0] || (outer && outer.stdout) || null;
    const piped = (wrappers.has('pipe') && i < segments.length - 1) || Boolean(outer && outer.piped);
    for (const [kind, runs] of [['shell', shellRuns(seg, bodies, segments[i - 1])], ['substitution', substitutionRuns(seg, bodies)]]) {
      for (const run of runs) {
        const inner = classify(run, patterns, { at, kind, stdout, piped });
        if (inner.verdict === 'refuse') return inner;
      }
    }
    const hit = exclusionFor(asMatched(seg), patterns);
    if (!hit) continue;
    if (bare && !hit.near) return { verdict: 'pass' };
    if (!bare && seg.words[0] === 'git' && !GIT_REMOTE.has(gitSubcommand(seg.words))) continue;
    const result = {
      verdict: 'refuse',
      kind: bare ? 'near-miss' : 'wrapped',
      pattern: hit.pattern,
      segment: seg.raw.join(' '),
      wrappers: [...wrappers],
      runner: runnerExcluded(patterns),
      fix: {
        cwd: at && at.cwd,
        cd: at && at.shown,
        argv: seg.words.slice(),
        named: seg.raw.slice(0, hit.length).join(' '),
        near: hit.near,
        shownEnv: seg.envRaw.join(' '),
        env: Object.fromEntries(seg.env.map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)])),
        stdout,
        piped,
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
      'arguments, so with them it runs inside the sandbox and fails late.',
      '',
      'Put the values inside the script and run it bare, as the exclusion names it:',
      `  ${r.fix.named}`);
  } else {
    const how = r.wrappers.map((w) => WRAPPER_NAMES[w]).join(', ');
    lines.push(`Refused before it ran: "${r.segment}" runs outside the sandbox only as one bare command (exclusion`,
      `"${r.pattern}"). Wrapped in ${how}, it runs inside the sandbox and fails late and misleadingly:`,
      'a browser that cannot start, a credential that reads as invalid.',
      '');
    const env = r.fix.shownEnv;
    if (env) {
      lines.push(`A bare command cannot carry ${env}. Write a small script in the repository's test tree or its`,
        `gitignored scratch folder (.rundock/scratch/) that starts the command as a child process${r.fix.cwd ? ` in ${r.fix.cd || r.fix.cwd}` : ''}`,
        'with that set, and run the script bare.');
    } else if (r.fix.near) {
      // Run bare with its arguments, a near miss is refused again.
      if (r.fix.cd) lines.push('Put the values inside the script and run it bare, after the cd as a call of its own:', `  1. cd ${r.fix.cd}`, `  2. ${r.fix.named}`);
      else lines.push('Put the values inside the script and run it bare:', `  ${r.fix.named}`);
    } else if (r.fix.cd) {
      lines.push('Run it as two calls, the cd alone and then the command alone:', `  1. cd ${r.fix.cd}`, `  2. ${r.segment}`);
    } else {
      lines.push('Run it bare, as one call with nothing before or after it:', `  ${r.segment}`);
    }
    if (r.fix.stdout || r.fix.piped) lines.push('Its output comes back as the result of the call: read it there, not through a pipe or a file.');
  }
  if (r.runner) {
    const spec = { cwd: r.fix.cwd || '<absolute working directory>', argv: r.fix.argv };
    if (Object.keys(r.fix.env).length) spec.env = r.fix.env;
    if (r.fix.stdout || r.fix.piped) spec.stdout = r.fix.stdout || '<absolute path for the output, beside the arguments file>';
    lines.push('', "Or, as the runner's own command is excluded too, put the arguments in a JSON file and run it bare:",
      `  node ${RUNNER} <args-file>.json`, 'with the file holding:', `  ${JSON.stringify(spec)}`);
  }
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
  // With its sandbox deliberately off, a command runs outside the sandbox
  // whatever its shape, so no shape of it can fail the way this guards.
  if (payload.tool_input.dangerouslyDisableSandbox === true) return { code: 0 };
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
