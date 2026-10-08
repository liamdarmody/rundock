'use strict';
// THE CODE-MODE VERDICT: whether a shell command runs, asks once, or always
// asks.
//
// The line, in one sentence: a command runs when what it changes can be got
// back with tools already to hand (git, a rebuild, a restart, an uninstall);
// it asks every time when it cannot; and four acts that are recoverable but
// seen by other people or the whole machine first ask once and can be
// remembered, each under a rule key of its own.
//
// The context read, and no more: where the command runs, whether each target
// is inside a git working tree, whether git holds unsaved work under the
// targets (only for bulk deletes and discards), and which branch a push lands
// on. It does not read file contents, scripts, or what an `npm run` target
// does: Rundock checks the commands agents type, not the inside of a
// project's own scripts.
//
// Every command in a line is judged and the strictest wins. Wrappers are
// removed before the verb is read; commands carried inside another command are
// judged as commands; anything whose meaning is only known when it runs asks.
const path = require('path');
const os = require('os');
const { lexSegments, lexWords, substitutions, stripHeredocs } = require('./code-mode-parse.js');
const gitContext = require('./code-mode-git.js');
const devPaths = require('./dev-paths.js');

// Asks-once rule keys. A standing allow is stored under exactly one of these
// and answers only that rule; the old binary keys (`Bash:git`) answer none.
const RULES = {
  defaultBranch: 'Bash:git-push:default-branch',
  tags: 'Bash:git-push:tags',
  deleteRemoteRef: 'Bash:git-push:delete-remote-ref',
  executionPolicy: 'PowerShell:execution-policy:change',
};

const RANK = { runs: 0, 'asks-once': 1, 'always-asks': 2 };
const RUNS = Object.freeze({ verdict: 'runs' });
const once = (rule, extra) => ({ verdict: 'asks-once', rule, ...(extra || {}) });
const always = (reason, extra) => ({ verdict: 'always-asks', reason, ...(extra || {}) });
const stricter = (a, b) => (RANK[b.verdict] > RANK[a.verdict] ? b : a);

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
const FETCHERS = new Set(['curl', 'wget', 'irm', 'iwr', 'invoke-restmethod', 'invoke-webrequest']);
const ELEVATION = new Set(['sudo', 'doas', 'gsudo', 'runas', 'pkexec']);
const BASH_WRAPPERS = new Set(['command', 'builtin', 'exec', 'nohup', 'time', 'nice', 'timeout', 'env']);
const PS_REMOVE = new Set(['remove-item', 'ri', 'rm', 'del', 'erase', 'rd', 'rmdir']);
const PS_LIST = new Set(['get-childitem', 'gci', 'ls', 'dir']);
const CD = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl']);

// ── Entry point ─────────────────────────────────────────────────────────────

function codeModeVerdict(opts) {
  const platform = opts.platform || process.platform;
  const pmod = platform === 'win32' ? path.win32 : path.posix;
  const ctxSeam = opts.context || gitContext.defaultContext();
  const foreign = pmod === path.win32 && process.platform !== 'win32';
  const canonical = ctxSeam.canonical && !foreign ? ctxSeam.canonical : (p => pmod.resolve(p));
  const home = opts.home || os.homedir();
  const ctx = {
    dialect: opts.toolName === 'PowerShell' ? 'ps' : 'bash',
    platform, pmod,
    fold: platform === 'darwin' || platform === 'win32',
    home: canonical(home),
    env: opts.env || process.env,
    workspaceRoot: canonical(opts.workspaceRoot),
    extraDirs: (opts.extraDirs || []).map(canonical),
    base: opts.cwd ? canonical(opts.cwd) : null,
    seam: {
      exists: ctxSeam.exists || (() => false),
      gitTop: ctxSeam.gitTop || (() => null),
      gitStatus: ctxSeam.gitStatus || (() => ({ ok: false })),
      currentBranch: ctxSeam.currentBranch || (() => null),
      defaultBranches: ctxSeam.defaultBranches || (() => ['main', 'master']),
      isTag: ctxSeam.isTag || (() => false),
    },
    canonical,
    tmpdir: opts.tmpdir,
  };
  try {
    return judgeLine(String(opts.command || ''), ctx);
  } catch (e) {
    // A line this reader could not follow is a line nobody checked.
    return always('unreadable-command');
  }
}

// ── A line: its commands, strictest wins ────────────────────────────────────

// How deep substitutions inside substitutions are followed before the line is
// taken as unreadable.
const MAX_DEPTH = 8;

function judgeLine(text, ctx, depth = 0) {
  if (depth > MAX_DEPTH) return always('unreadable-command');
  // Pointing git at another repository by environment moves the context the
  // verdict reads; see judgeGit.
  if (gitEnvironmentIn(text, ctx)) ctx = { ...ctx, gitRedirected: true };
  // Here-document bodies are data, not commands, unless a shell reads them.
  const h = stripHeredocs(text, ctx.dialect);
  if (!h.ok) return always('unreadable-command');
  let result = RUNS;
  for (const b of h.bodies) if (b.expands) result = stricter(result, judgeSubstitutions(b.body, ctx, depth, true));
  const segments = lexSegments(h.text, ctx.dialect);
  let cds = 0;
  let prev = null;
  let shellReadsHeredoc = false;
  for (const seg of segments) {
    // A substitution runs a command of its own wherever it sits, even inside
    // an assignment, and that command is judged like any other.
    result = stricter(result, judgeSubstitutions(seg.text, ctx, depth, false));
    if (/<\(\s*(curl|wget)\b/i.test(seg.text)) { result = stricter(result, always('fetched-code')); prev = null; continue; }
    // The shell's own grammar around the command: keywords, subshells,
    // groups. Only the shapes modelled here are read through.
    const shape = ctx.dialect === 'bash' ? shapeOf(seg.text) : { kind: 'command', text: seg.text, keyword: false };
    if (shape.kind === 'unreadable') { result = stricter(result, always('unreadable-command')); prev = null; continue; }
    if (shape.kind === 'skip') { prev = null; continue; }
    if (shape.kind === 'subshell' || shape.kind === 'group') {
      result = stricter(result, judgeLine(shape.inner, ctx, depth + 1));
      // A cd inside a group changes where the rest of the line runs, and is
      // not followed here; one inside a subshell ends with it.
      if (shape.kind === 'group') { ctx = { ...ctx, base: null }; cds++; }
      prev = null;
      continue;
    }
    const words = lexWords(shape.text, ctx.dialect);
    const u = unwrap(words, ctx);
    if (!u) { prev = null; continue; }
    if (u.unreadable) { result = stricter(result, always('unreadable-command')); prev = null; continue; }
    if (u.elevated) { result = stricter(result, always('elevation')); prev = u; continue; }
    if (/(^|[^<])<<(?!<)/.test(seg.text) && SHELLS.has(u.verb)) shellReadsHeredoc = true;
    // A here-string (`<<< word`) is data for the command, not an argument,
    // except to a shell, which runs it.
    const hs = u.args.findIndex(w => w.text === '<<<' && !w.quoted);
    if (hs >= 0) {
      if (ctx.dialect === 'bash' && SHELLS.has(u.verb)) result = stricter(result, inner(u.args[hs + 1], ctx, 'bash'));
      u.args.splice(hs, 2);
    }
    const piped = seg.op === '|';
    if (piped && prev && FETCHERS.has(prev.verb) && (SHELLS.has(u.verb) || u.verb === 'iex' || u.verb === 'invoke-expression')) {
      result = stricter(result, always('fetched-code'));
      prev = u;
      continue;
    }
    if (CD.has(u.verb) || (ctx.dialect === 'cmd' && u.verb === 'cd')) {
      // A leading literal cd says where the rest runs. A second one, one whose
      // target is only known when it runs, or one that may not happen (behind
      // a keyword: a branch, a loop), makes relative paths unknown.
      const target = u.args.find(a => !/^\/d$/i.test(a.text) && !/^-/.test(a.text));
      const resolved = cds === 0 && target && !shape.keyword ? expandPath(target, ctx) : null;
      ctx = { ...ctx, base: resolved };
      cds++;
      prev = u;
      continue;
    }
    result = stricter(result, judgeCommand(u, ctx, { piped, prev }));
    prev = u;
  }
  // A shell reading a here-document runs its body as commands.
  if (shellReadsHeredoc) for (const b of h.bodies) result = stricter(result, judgeLine(b.body, ctx, depth + 1));
  return result;
}

// THE SHELL GRAMMAR AROUND ONE COMMAND, bash only. The shapes read through:
//   keywords  if, then, elif, else, while, until, do, ! : stripped, and the
//             command after them judged (a cd behind one is not followed)
//   closers   fi, done, and a lone } or ) : nothing runs
//   headers   for NAME in WORDS : nothing runs (its body is its own segment)
//   ((...))   arithmetic : nothing runs beyond its substitutions
//   (...)     a subshell, and { ...; } a group : their contents judged
// Anything else the grammar allows (function definitions, case, select,
// coproc) is not modelled, so it asks.
const KEYWORD = /^(if|then|elif|else|while|until|do|!)(?=\s|$)\s*/;
function shapeOf(text) {
  let t = text.trim();
  let keyword = false;
  for (let m = KEYWORD.exec(t); m; m = KEYWORD.exec(t)) { t = t.slice(m[0].length).trim(); keyword = true; }
  if (!t) return { kind: 'skip' };
  if (/^(function\s|case\s|select\s|coproc(\s|$))/.test(t)) return { kind: 'unreadable' };
  if (/^[^\s"'=(){}<>|&;]+\s*\(\s*\)/.test(t)) return { kind: 'unreadable' }; // name () { ... }
  if (/^(fi|done|esac|\}|\))(?=\s|$)/.test(t)) {
    const rest = t.replace(/^(fi|done|esac|\}|\))/, '');
    return lexWords(rest, 'bash').length ? { kind: 'unreadable' } : { kind: 'skip' };
  }
  if (/^for\s+[A-Za-z_][A-Za-z0-9_]*(\s+in(\s|$)|\s*$)/.test(t) || /^for\s*\(\(/.test(t)) return { kind: 'skip' };
  if (t.startsWith('((')) return /\)\)$/.test(t) ? { kind: 'skip' } : { kind: 'unreadable' };
  if (t.startsWith('(')) {
    const j = closeParenAt(t, 0);
    if (j < 0 || lexWords(t.slice(j + 1), 'bash').length) return { kind: 'unreadable' };
    return { kind: 'subshell', inner: t.slice(1, j) };
  }
  if (/^\{(\s|$)/.test(t)) {
    const j = t.lastIndexOf('}');
    if (j < 0 || !/[;\n&]\s*$/.test(t.slice(0, j)) || lexWords(t.slice(j + 1), 'bash').length) return { kind: 'unreadable' };
    return { kind: 'group', inner: t.slice(1, j) };
  }
  return { kind: 'command', text: t, keyword };
}
function closeParenAt(t, i) {
  let depth = 0;
  let quote = null;
  for (let k = i; k < t.length; k++) {
    const ch = t[k];
    if (quote) { if (ch === '\\' && quote === '"') { k++; continue; } if (ch === quote) quote = null; continue; }
    if (ch === '\\') { k++; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return k;
  }
  return -1;
}

// WHETHER THE LINE SETS A GIT_ ENVIRONMENT VARIABLE, read by name after quote
// removal, so `G"IT"_DIR=...` is the GIT_DIR it is to the shell. An assignment
// whose name holds a quote, an escape or an expansion at all counts too: its
// name is only known when the line runs.
function gitEnvironmentIn(text, ctx) {
  if (ctx.dialect !== 'bash') return /GIT_/i.test(String(text).replace(/["'`^]/g, ''));
  for (const seg of lexSegments(text, 'bash')) {
    const words = lexWords(seg.text, 'bash');
    let i = 0;
    const assigning = (w) => {
      const eq = w.raw.indexOf('=');
      if (eq <= 0) return false;
      const rawName = w.raw.slice(0, eq);
      const name = w.text.slice(0, w.text.indexOf('='));
      return /^GIT_/.test(name) || /["'\\$`{}]/.test(rawName);
    };
    // Leading assignments, and everything after a word that exports or sets
    // variables (env, export, declare, typeset, readonly, local).
    while (i < words.length && /=/.test(words[i].raw) && /^[^=\s]*=/.test(words[i].raw)) { if (assigning(words[i])) return true; i++; }
    const setter = words[i] && /^(env|export|declare|typeset|readonly|local)$/.test(words[i].text);
    if (setter) for (const w of words.slice(i + 1)) if (/^GIT_/.test(w.text) || assigning(w)) return true;
  }
  return false;
}

// The commands run by the substitutions in `text`, judged in turn.
function judgeSubstitutions(text, ctx, depth, quoted) {
  const subs = substitutions(text, ctx.dialect, { quoted });
  if (!subs.ok) return always('unreadable-command');
  let result = RUNS;
  for (const body of subs.bodies) result = stricter(result, judgeLine(body, ctx, depth + 1));
  return result;
}

// Remove assignments and wrappers, fold case where the filesystem does, and
// report elevation. Returns { verb, args, words, elevated } or null.
function unwrap(words, ctx) {
  let ws = words.slice();
  let elevated = false;
  let settled = false;
  for (let guard = 0; guard < 20 && ws.length; guard++) {
    // An assignment: its name written plainly, whatever its value.
    if (ctx.dialect === 'bash' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(ws[0].raw)) { ws.shift(); continue; }
    if (!verbUnderstood(ws[0], ctx)) return UNREADABLE;
    const verb = verbOf(ws[0].text, ctx);
    if (ELEVATION.has(verb)) { elevated = true; break; }
    if (verb === 'start-process' || verb === 'saps' || (verb === 'start' && ctx.dialect === 'ps')) {
      const i = ws.findIndex(w => /^-verb$/i.test(w.text));
      if (i >= 0 && ws[i + 1] && /^runas$/i.test(ws[i + 1].text)) { elevated = true; break; }
    }
    if (ctx.dialect === 'bash' && BASH_WRAPPERS.has(verb)) {
      ws.shift();
      const rest = unwrapOptions(verb, ws);
      if (rest === null) return UNREADABLE;
      if (rest === 'lookup') return null; // `command -v x` names a program, runs none
      ws = rest;
      continue;
    }
    // Commands that run another command in ways not modelled here.
    if (ctx.dialect === 'bash' && UNMODELLED_WRAPPERS.has(verb) && ws.length > 1) return UNREADABLE;
    settled = true;
    break;
  }
  if (elevated) return { verb: 'sudo', args: [], words: ws, elevated: true };
  if (!ws.length) return null;
  if (!settled) return UNREADABLE; // wrappers nested past the limit
  return { verb: verbOf(ws[0].text, ctx), args: ws.slice(1), words: ws, elevated: false };
}
const UNREADABLE = Object.freeze({ verb: null, args: [], words: [], elevated: false, unreadable: true });

// THE WRAPPERS' OWN OPTIONS, as far as they are modelled: the words left once
// the wrapper and its options are removed, 'lookup' for a command that only
// names a program, or null for an option not modelled here.
function unwrapOptions(verb, ws) {
  const w = ws.slice();
  const t = () => (w[0] ? w[0].text : undefined);
  if (verb === 'env') {
    while (w.length) {
      const f = t();
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0].raw)) { w.shift(); continue; }
      if (['-i', '-', '--ignore-environment', '-0', '--null'].includes(f)) { w.shift(); continue; }
      if (f === '-u' || f === '--unset') { w.shift(); if (!w.length) return null; w.shift(); continue; }
      if (/^--unset=./.test(f) || /^-u./.test(f)) { w.shift(); continue; }
      if (f === '--') { w.shift(); break; }
      if (/^-/.test(f)) return null; // -S, --split-string, -C, -P and anything else
      break;
    }
    return w;
  }
  if (verb === 'nice') {
    while (w.length && /^-/.test(t())) {
      const f = w.shift().text;
      if (f === '-n' || f === '--adjustment') { if (!w.length || !/^-?\d+$/.test(t())) return null; w.shift(); continue; }
      if (/^-n-?\d+$/.test(f) || /^--adjustment=-?\d+$/.test(f) || /^-\d+$/.test(f)) continue;
      return null;
    }
    return w;
  }
  if (verb === 'timeout') {
    while (w.length && /^-/.test(t())) {
      const f = w.shift().text;
      if (f === '-s' || f === '-k' || f === '--signal' || f === '--kill-after') { if (!w.length) return null; w.shift(); continue; }
      if (/^(--signal|--kill-after)=./.test(f) || /^-[sk]./.test(f)) continue;
      if (['--preserve-status', '--foreground', '-v', '--verbose', '-f', '-p'].includes(f)) continue;
      return null;
    }
    if (!w.length || !/^\d+(\.\d+)?[smhd]?$/.test(t())) return null; // the duration
    w.shift();
    return w;
  }
  if (verb === 'command') {
    while (w.length && /^-/.test(t())) {
      const f = w.shift().text;
      if (f === '-v' || f === '-V') return 'lookup';
      if (f !== '-p' && f !== '--') return null;
    }
    return w;
  }
  if (verb === 'exec') {
    while (w.length && /^-/.test(t())) {
      const f = w.shift().text;
      if (f === '-a') { if (!w.length) return null; w.shift(); continue; }
      if (f !== '-c' && f !== '-l' && f !== '-cl' && f !== '-lc' && f !== '--') return null;
    }
    return w;
  }
  if (verb === 'time') {
    while (w.length && /^-/.test(t())) { const f = w.shift().text; if (f !== '-p' && f !== '--') return null; }
    return w;
  }
  // nohup and builtin take no options of their own.
  if (w.length && /^-/.test(t()) && t() !== '--') return null;
  if (t() === '--') w.shift();
  return w;
}

// Programs that run the command they are given in a way not modelled here.
const UNMODELLED_WRAPPERS = new Set([
  'stdbuf', 'ionice', 'chrt', 'taskset', 'caffeinate', 'setsid', 'flock', 'watch', 'parallel', 'unbuffer', 'strace', 'ltrace',
  'su', 'runuser', 'chroot', 'script', 'arch', 'sg', 'newgrp', 'systemd-run', 'nsenter', 'unshare', 'firejail', 'proxychains',
  'proxychains4', 'torsocks', 'xvfb-run', 'dbus-launch', 'ssh-agent', 'sshpass', 'rlwrap', 'entr', 'expect', 'busybox', 'toybox',
  'fakeroot', 'catchsegv', 'valgrind', 'gdb', 'lldb', 'chpst', 'gosu', 'su-exec', 'tini', 'dumb-init', 'cross-env', 'dotenv',
]);

// WHETHER A WORD WHERE THE PROGRAM NAME GOES IS A NAME THIS READS COMPLETELY:
// a plain name, or a path to one. Its folder may use plain variables
// ($HOME, ${TOOLS}); the name itself holds no expansion, substitution, glob
// or brace, since the shell would turn any of those into something else.
const PLAIN_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.+@-]*$/;
function verbUnderstood(word, ctx) {
  const t = word.text;
  if (ctx.dialect === 'bash' && (t === '[' || t === '[[' || t === ':' || t === '.')) return true;
  if (word.glob) return false;
  if (ctx.dialect !== 'cmd' && (/\$\(/.test(t) || (ctx.dialect === 'bash' && t.includes('`')))) return false;
  const cut = ctx.dialect === 'bash' ? t.lastIndexOf('/') : Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\'));
  const name = t.slice(cut + 1);
  const dir = cut >= 0 ? t.slice(0, cut + 1) : '';
  if (!PLAIN_NAME.test(name)) return false;
  const plainDir = ctx.dialect === 'cmd'
    ? dir.replace(/%[A-Za-z_][A-Za-z0-9_]*%/g, '')
    : dir.replace(/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|\$env:[A-Za-z_][A-Za-z0-9_]*/gi, '');
  return ctx.dialect === 'bash' ? /^[A-Za-z0-9_.+@~ \/-]*$/.test(plainDir) : /^[A-Za-z0-9_.+@~ ():\\\/-]*$/.test(plainDir);
}

// A word only known when the line runs. In cmd, the few variables Rundock
// reads itself are known.
function expands(word, ctx) {
  return !!word.expands && !(ctx.dialect === 'cmd' && knownCmdVars(word.text));
}

function verbOf(word, ctx) {
  let v = String(word).replace(/^\\/, '');
  v = v.slice(Math.max(v.lastIndexOf('/'), ctx.dialect === 'bash' ? -1 : v.lastIndexOf('\\')) + 1);
  if (ctx.dialect !== 'bash' || ctx.fold) v = v.toLowerCase();
  if ((ctx.dialect !== 'bash' || ctx.platform === 'win32') && v.toLowerCase().endsWith('.exe')) v = v.slice(0, -4);
  return v;
}

// ── One command ─────────────────────────────────────────────────────────────

function judgeCommand(u, ctx, { piped, prev } = {}) {
  const v = u.verb;
  const a = u.args;
  const texts = a.map(w => w.text);

  // An argument only known when the line runs, where the verdict reads it.
  if (argsUnknown(v, a, ctx)) return always('unreadable-command');

  // Commands carried inside another command.
  if (ctx.dialect === 'bash' && SHELLS.has(v)) {
    const i = texts.findIndex(t => /^-[a-z]*c[a-z]*$/.test(t));
    if (i >= 0) return inner(a[i + 1], ctx, 'bash');
    return RUNS;
  }
  if (v === 'pwsh' || v === 'powershell') {
    if (texts.some(t => /^-e(nc(odedcommand)?)?$/i.test(t))) return always('unreadable-command');
    const i = texts.findIndex(t => /^-c(ommand)?$/i.test(t));
    if (i >= 0) return inner(a.slice(i + 1), ctx, 'ps');
    return RUNS;
  }
  if (v === 'cmd') {
    const i = texts.findIndex(t => /^\/[ck]$/i.test(t));
    if (i >= 0) return inner(a.slice(i + 1), ctx, 'cmd');
    return RUNS;
  }
  if (v === 'eval' || v === 'iex' || v === 'invoke-expression') return always('unreadable-command');
  // A trap's command runs later, on a signal or at exit, where nothing reads
  // it. Clearing (`trap - SIG`, `trap '' SIG`) and listing (-l, -p) run.
  if (ctx.dialect === 'bash' && v === 'trap') {
    if (!a.length || texts[0] === '-l' || texts[0] === '-p' || texts[0] === '-') return RUNS;
    if (a[0].text === '' && a[0].quoted && !a[0].expands) return RUNS;
    return always('unreadable-command');
  }
  if (v === 'xargs') return judgeXargs(a, ctx);
  if (ctx.dialect === 'bash' && v === 'find') return judgeFind(a, ctx);

  // Disks, the machine, publishing, containers, git.
  if (v === 'dd' || /^mkfs(\.|$)/.test(v)) return always('disk');
  if (v === 'diskutil' && texts.some(t => /^(erase|zero|secureerase|reformat|partitiondisk)/i.test(t))) return always('disk');
  if (v === 'diskpart' || v === 'format-volume' || v === 'clear-disk') return always('disk');
  if (v === 'format' && ctx.dialect !== 'bash' && texts.some(t => /^[a-z]:$/i.test(t))) return always('disk');
  if (v === 'wsl' && texts.some(t => /^--unregister$/i.test(t))) return always('wsl-unregister');
  if (['shutdown', 'reboot', 'halt', 'poweroff', 'restart-computer', 'stop-computer'].includes(v)) return always('every-process');
  if (v === 'kill' && ctx.dialect === 'bash' && texts.length && texts[texts.length - 1] === '-1') return always('every-process');
  if (v === 'taskkill' && /\/fi\b/i.test(texts.join(' ')) && /username/i.test(texts.join(' '))) return always('every-process');
  if (['npm', 'yarn', 'pnpm'].includes(v) && texts[0] === 'publish') return always('publish');
  if (v === 'docker' || v === 'docker-compose') return judgeDocker(v, texts);
  if (v === 'set-executionpolicy') return once(RULES.executionPolicy);
  if (v === 'gh' && texts[0] === 'pr' && texts[1] === 'merge') return once(RULES.defaultBranch);
  if (v === 'git') return judgeGit(a, ctx);

  // Deletes.
  if (ctx.dialect === 'bash' && v === 'rm') return judgeRm(a, ctx, piped);
  if (ctx.dialect === 'bash' && v === 'unlink') return judgeDelete(a.map(w => target(w, ctx)), { bulk: false, piped }, ctx);
  if (ctx.dialect === 'ps' && PS_REMOVE.has(v)) return judgePsRemove(a, ctx, piped, prev);
  if (ctx.dialect === 'cmd' && (v === 'rd' || v === 'rmdir')) return judgeCmdRd(a, ctx);
  if (ctx.dialect === 'cmd' && (v === 'del' || v === 'erase')) return judgeCmdDel(a, ctx);

  return RUNS;
}

// Whether an expanding argument sits where this command's verdict is decided:
// its subcommand (npm, docker, a shell's own flags), or any argument of a
// command whose every argument can change the verdict. Git and find decide
// this for themselves.
function argsUnknown(v, a, ctx) {
  const exp = w => expands(w, ctx);
  const lead = () => {
    for (const w of a) { if (exp(w)) return true; if (!/^-/.test(w.text)) return false; }
    return false;
  };
  if (['npm', 'yarn', 'pnpm', 'pwsh', 'powershell', 'cmd'].includes(v)) return lead();
  if (ctx.dialect === 'bash' && SHELLS.has(v)) return lead();
  if (v === 'docker' || v === 'docker-compose') {
    if (lead()) return true;
    const t0 = a[0] && a[0].text;
    return (v === 'docker-compose' || ['compose', 'volume', 'system'].includes(t0)) && a.some(exp);
  }
  if (v === 'gh') return a.slice(0, 2).some(exp);
  // Freeing a port (`kill -9 $(lsof -ti :3000)`) is everyday work: a process
  // id looked up by a command that can only print process ids is known well
  // enough. Anything else could say `-1`, which is every process.
  if (['kill', 'taskkill'].includes(v)) return a.some(w => exp(w) && !pidLookup(w, ctx));
  if (['wsl', 'format', 'diskutil'].includes(v)) return a.some(exp);
  return false;
}

// THE PROCESS-ID LOOKUPS KILL ACCEPTS: `lsof -t` on a port, and `pidof` a
// program name. Both print the ids of real, running processes and nothing
// else. Anything that could print a value it was handed or found in a file
// (cat, echo, a filter) could print -1, which is every process, so it asks.
const LSOF_PORT = /^(tcp|udp|TCP|UDP)?:\d{1,5}(-\d{1,5})?$/;
function pidLookup(word, ctx) {
  if (ctx.dialect !== 'bash') return false;
  const subs = substitutions(word.text, 'bash');
  if (!subs.ok || subs.bodies.length !== 1) return false;
  const body = subs.bodies[0];
  if (word.text !== `$(${body})` && word.text !== `\`${body}\``) return false;
  const segments = lexSegments(body, 'bash');
  if (segments.length !== 1) return false;
  const words = lexWords(segments[0].text, 'bash');
  if (!words.length || words.some(w => w.expands || w.glob)) return false;
  const verb = words[0].text;
  const args = words.slice(1).map(w => w.text);
  if (verb === 'pidof') return args.length > 0 && args.every(x => PLAIN_NAME.test(x));
  if (verb !== 'lsof') return false;
  let terse = false;
  let port = false;
  for (let i = 0; i < args.length; i++) {
    const x = args[i];
    let m = /^-([nPlt]*)i([nPlt]*)$/.exec(x);
    if (m) { if (!LSOF_PORT.test(args[i + 1] || '')) return false; port = true; if (/t/.test(m[1] + m[2])) terse = true; i++; continue; }
    m = /^-([nPlt]*)i(.+)$/.exec(x);
    if (m) { if (!LSOF_PORT.test(m[2])) return false; port = true; if (/t/.test(m[1])) terse = true; continue; }
    if (/^-[nPlt]+$/.test(x)) { if (x.includes('t')) terse = true; continue; }
    if (x === '-s' && /^(TCP|UDP):[A-Z]+$/.test(args[i + 1] || '')) { i++; continue; }
    if (/^-s(TCP|UDP):[A-Z]+$/.test(x)) continue;
    return false;
  }
  return terse && port;
}

function inner(arg, ctx, dialect) {
  const words = Array.isArray(arg) ? arg : (arg ? [arg] : []);
  if (!words.length) return RUNS;
  if (words.some(w => w.expands && !(dialect === 'cmd' && knownCmdVars(w.text)))) return always('unreadable-command');
  return judgeLine(words.map(w => w.text).join(' '), { ...ctx, dialect });
}
function knownCmdVars(text) {
  return String(text).replace(/%(USERPROFILE|TEMP|TMP|LOCALAPPDATA|APPDATA)%/gi, '').indexOf('%') === -1;
}

function judgeDocker(v, t) {
  const compose = v === 'docker-compose' ? t : (t[0] === 'compose' ? t.slice(1) : null);
  if (compose && compose.includes('down') && compose.some(x => x === '-v' || x === '--volumes')) return always('volumes');
  if (t[0] === 'volume' && (t[1] === 'rm' || t[1] === 'prune')) return always('volumes');
  if (t[0] === 'system' && t[1] === 'prune' && t.includes('--volumes')) return always('volumes');
  return RUNS;
}

// ── Paths ───────────────────────────────────────────────────────────────────

// The absolute path a word names, or null when it is only known at run time.
function expandPath(word, ctx) {
  let t = word.text;
  const pmod = ctx.pmod;
  if (ctx.dialect === 'bash') {
    if (!word.quoted && /^~(?=[\\/]|$)/.test(t)) t = ctx.home + t.slice(1);
    t = t.replace(/^(\$HOME|\$\{HOME\})(?=[\\/]|$)/, ctx.home);
    if (/[$`]/.test(t)) return null;
  } else if (ctx.dialect === 'ps') {
    if (/^~(?=[\\/]|$)/.test(t)) t = ctx.home + t.slice(1);
    t = t.replace(/^\$HOME(?=[\\/]|$)/i, ctx.home);
    const m = /^\$\{?env:([A-Za-z_][A-Za-z0-9_]*)\}?/i.exec(t);
    if (m) {
      const val = /^userprofile$/i.test(m[1]) ? (devPaths.envValue(ctx.env, 'USERPROFILE') || ctx.home) : devPaths.envValue(ctx.env, m[1]);
      if (!val) return null;
      t = val + t.slice(m[0].length);
    }
    if (/[$`]/.test(t)) return null;
  } else {
    t = t.replace(/^%([A-Za-z_]+)%/, (all, name) => {
      const val = /^userprofile$/i.test(name) ? (devPaths.envValue(ctx.env, 'USERPROFILE') || ctx.home) : devPaths.envValue(ctx.env, name);
      return val || all;
    });
    if (/%[A-Za-z_]+%/.test(t)) return null;
  }
  if (ctx.dialect !== 'bash' && pmod !== path.win32) t = t.replace(/\\/g, '/');
  if (!t) return null;
  if (pmod.isAbsolute(t)) return ctx.canonical(pmod.resolve(t));
  if (!ctx.base) return null;
  return ctx.canonical(pmod.resolve(ctx.base, t));
}

function target(word, ctx) {
  return { path: expandPath(word, ctx), glob: !!word.glob && !word.quoted };
}

function under(p, root, ctx) {
  return devPaths.isUnderIn(p, root, ctx.pmod, ctx.fold);
}
function insideDotGit(p, ctx) {
  return p.split(/[\\/]+/).some(s => (ctx.fold ? s.toLowerCase() : s) === '.git');
}
// Deleting the .git folder itself loses the repository's history; changing a
// file inside it changes git's own files. Two reasons, two sentences.
function dotGitReason(p, ctx) {
  const base = ctx.pmod.basename(p);
  return (ctx.fold ? base.toLowerCase() : base) === '.git' ? 'repository' : 'git-internals';
}
function isWorkspaceOrWorkingFolder(p, ctx) {
  return under(p, ctx.workspaceRoot, ctx) || ctx.extraDirs.some(d => under(p, d, ctx));
}
function isDisposable(p, ctx) {
  const scratch = ctx.pmod.join(ctx.workspaceRoot, '.rundock', 'scratch');
  if (under(p, scratch, ctx)) return true;
  if (ctx.pmod !== path.win32 && (under(p, '/tmp/claude', ctx) || under(p, '/private/tmp/claude', ctx))) return true;
  // The temp and cache rule never reaches the workspace or a working folder.
  if (isWorkspaceOrWorkingFolder(p, ctx)) return false;
  return devPaths.isDevPath(p, { platform: ctx.platform, env: ctx.env, home: ctx.home, canonical: ctx.canonical, ...(ctx.tmpdir ? { tmpdir: ctx.tmpdir } : {}) });
}

// ── Deletes and discards ────────────────────────────────────────────────────

// targets: [{ path | null, glob }]. `bulk`: recursive, globbed, a find, or fed
// by a pipe. `kind`: 'delete' or 'find'.
function judgeDelete(targets, { bulk, piped, kind = 'delete' }, ctx) {
  if (piped) return always('unknown-targets');
  if (!targets.length) return RUNS;
  if (targets.some(t => !t.path)) return always('unknown-targets');
  if (targets.some(t => t.glob)) bulk = true;
  if (!bulk) {
    // One named file (or several): the same act as the agent overwriting it.
    return targets.some(t => insideDotGit(t.path, ctx)) ? always(dotGitReason(targets.find(t => insideDotGit(t.path, ctx)).path, ctx)) : RUNS;
  }
  const byTop = new Map();
  for (const t of targets) {
    const scope = t.glob ? globScope(t.path, ctx) : t.path;
    if (!ctx.seam.exists(scope)) continue; // deletes nothing
    if (insideDotGit(t.path, ctx)) return always(dotGitReason(t.path, ctx));
    if (isDisposable(scope, ctx)) continue;
    const top = ctx.seam.gitTop(scope);
    if (!top) return always('outside-repository');
    const topC = ctx.canonical(top);
    // From the top, a find can reach git's own files as well as the person's.
    if (kind === 'find' && scope === topC) return always('find-from-top');
    const bareAtTop = t.glob && ctx.pmod.dirname(t.path) === topC && /^[*?]+$/.test(ctx.pmod.basename(t.path));
    if ((!t.glob && (scope === topC || under(topC, scope, ctx))) || bareAtTop) return always('repository');
    const rel = ctx.pmod.relative(topC, t.glob ? t.path : scope).split(ctx.pmod.sep).join('/');
    if (!byTop.has(topC)) byTop.set(topC, []);
    byTop.get(topC).push(rel);
  }
  for (const [top, specs] of byTop) {
    const st = ctx.seam.gitStatus(top, specs, { env: true });
    if (!st || !st.ok) return always('git-unchecked');
    const lost = [...(st.tracked || []), ...(st.untracked || []), ...(st.ignoredEnv || [])];
    if (lost.length) return unsaved('unsaved-work', lost);
  }
  return RUNS;
}

function unsaved(reason, files) {
  const uniq = [...new Set(files)];
  return always(reason, { files: uniq.slice(0, 3), more: Math.max(0, uniq.length - 3) });
}

// The folder a globbed target can reach: its path up to the first glob.
function globScope(p, ctx) {
  const parts = p.split(ctx.pmod.sep);
  const i = parts.findIndex(s => /[*?[]/.test(s));
  const kept = i < 0 ? parts : parts.slice(0, i);
  return kept.join(ctx.pmod.sep) || ctx.pmod.sep;
}

function judgeRm(args, ctx, piped) {
  let recursive = false;
  const targets = [];
  let flags = true;
  for (const w of args) {
    if (flags && w.text === '--') { flags = false; continue; }
    if (flags && /^--/.test(w.text)) { if (w.text === '--recursive') recursive = true; continue; }
    if (flags && /^-[a-zA-Z]+$/.test(w.text)) { if (/[rR]/.test(w.text)) recursive = true; continue; }
    targets.push(target(w, ctx));
  }
  return judgeDelete(targets, { bulk: recursive, piped }, ctx);
}

// The find primaries that take a value: an expanding word there is a value,
// never an action like -delete.
const FIND_VALUE = /^-(i?name|i?path|i?wholename|i?l?name|i?regex|regextype|x?type|newer[a-zA-Z]*|[amcB](time|min|newer)|size|user|group|uid|gid|perm|maxdepth|mindepth|links|inum|samefile|fstype|context|used|printf|fprintf?|fprint0|fls)$/;

function judgeFind(args, ctx) {
  const starts = [];
  let i = 0;
  while (i < args.length && /^-[HLP]$/.test(args[i].text)) i++;
  while (i < args.length && !/^[-(!]/.test(args[i].text)) starts.push(args[i++]);
  const rest = args.slice(i);
  for (let k = 0; k < rest.length; k++) {
    if (/^-(exec|execdir|ok|okdir)$/.test(rest[k].text)) { while (k + 1 < rest.length && rest[k + 1].text !== ';' && rest[k + 1].text !== '+') k++; continue; }
    if (expands(rest[k], ctx) && !(k > 0 && FIND_VALUE.test(rest[k - 1].text))) return always('unreadable-command');
  }
  const startTargets = (starts.length ? starts : [{ text: '.', quoted: false, glob: false, expands: false }]).map(w => ({ path: expandPath(w, ctx), glob: false }));
  if (rest.some(w => w.text === '-delete')) return judgeDelete(startTargets, { bulk: true, kind: 'find' }, ctx);
  let result = RUNS;
  for (let j = 0; j < rest.length; j++) {
    if (!/^-(exec|execdir|ok|okdir)$/.test(rest[j].text)) continue;
    const cmd = [];
    for (j++; j < rest.length && rest[j].text !== ';' && rest[j].text !== '+'; j++) cmd.push(rest[j]);
    const u = unwrap(cmd, ctx);
    if (!u) continue;
    if (u.unreadable) return always('unreadable-command');
    if (u.elevated) return always('elevation');
    if (['rm', 'unlink', 'rmdir', 'shred'].includes(u.verb)) {
      result = stricter(result, judgeDelete(startTargets, { bulk: true, kind: 'find' }, ctx));
    } else {
      result = stricter(result, judgeCommand(u, ctx, {}));
    }
  }
  return result;
}

// xargs options as far as they are modelled; any other option asks, since it
// may take a value that would otherwise be read as the command.
const XARGS_FLAG = /^(-[0rtpxo]+|--null|--no-run-if-empty|--verbose|--interactive|--exit|--open-tty|--(max-args|replace|max-procs|max-lines|delimiter|eof|max-chars|arg-file|process-slot-var)=.*|-[nPLs]\d+|-[IiJdEa].+)$/;
const XARGS_VALUE = /^-[nIPLdEsaJR]$/;
function judgeXargs(args, ctx) {
  const ws = args.slice();
  while (ws.length && /^-/.test(ws[0].text)) {
    const f = ws.shift().text;
    if (f === '--') break;
    if (XARGS_VALUE.test(f)) { if (!ws.length) return always('unreadable-command'); ws.shift(); continue; }
    if (!XARGS_FLAG.test(f)) return always('unreadable-command');
  }
  const u = unwrap(ws, ctx);
  if (!u) return RUNS;
  if (u.unreadable) return always('unreadable-command');
  if (u.elevated) return always('elevation');
  return judgeCommand(u, ctx, { piped: true });
}

function judgePsRemove(args, ctx, piped, prev) {
  let recurse = false;
  let whatIf = false;
  const words = [];
  for (let i = 0; i < args.length; i++) {
    const t = args[i].text;
    if (/^-r(e(c(u(r(s(e)?)?)?)?)?)?$/i.test(t)) { recurse = true; continue; }
    if (/^-whatif$/i.test(t)) { whatIf = true; continue; }
    if (/^-(path|literalpath|lp|p)$/i.test(t)) { if (args[i + 1]) words.push(args[++i]); continue; }
    if (/^-(filter|include|exclude)$/i.test(t)) { i++; continue; }
    if (/^-/.test(t)) continue;
    for (const part of t.split(',').filter(Boolean)) words.push({ ...args[i], text: part });
  }
  if (whatIf) return RUNS;
  if (piped) {
    // `Get-ChildItem <start> -Recurse | Remove-Item` can only reach <start>.
    if (prev && PS_LIST.has(prev.verb) && prev.args.some(w => /^-r(e(c(u(r(s(e)?)?)?)?)?)?$/i.test(w.text))) {
      const s = prev.args.find(w => !/^-/.test(w.text)) || { text: '.', quoted: false, glob: false, expands: false };
      return judgeDelete([{ path: expandPath(s, ctx), glob: false }], { bulk: true, kind: 'find' }, ctx);
    }
    return always('unknown-targets');
  }
  return judgeDelete(words.map(w => target(w, ctx)), { bulk: recurse }, ctx);
}

function judgeCmdRd(args, ctx) {
  const recursive = args.some(w => /^\/s$/i.test(w.text));
  if (!recursive) return RUNS; // only an empty folder
  const targets = args.filter(w => !/^\//.test(w.text)).map(w => target(w, ctx));
  return judgeDelete(targets, { bulk: true }, ctx);
}

function judgeCmdDel(args, ctx) {
  const sub = args.some(w => /^\/s$/i.test(w.text));
  const targets = args.filter(w => !/^\//.test(w.text)).map(w => target(w, ctx));
  return judgeDelete(targets, { bulk: sub }, ctx);
}

// ── Git ─────────────────────────────────────────────────────────────────────

// The subcommands whose verdict reads the repository or their own arguments.
const GIT_GRADED = new Set(['push', 'reset', 'checkout', 'restore', 'clean', 'stash', 'reflog', 'gc', 'filter-branch', 'filter-repo', 'worktree']);

function judgeGit(args, ctx) {
  let i = 0;
  let dir = ctx.base;
  // Another repository named by --git-dir, --work-tree or --namespace (or
  // their environment variables) is not the one the context is read from.
  let elsewhere = !!ctx.gitRedirected;
  let unknown = false;
  while (i < args.length && /^-/.test(args[i].text)) {
    const t = args[i].text;
    if (expands(args[i], ctx)) unknown = true;
    if (t === '-C') { dir = args[i + 1] ? expandPathFrom(args[i + 1], ctx, dir) : null; i += 2; continue; }
    if (t === '--git-dir' || t === '--work-tree' || t === '--namespace') { elsewhere = true; i += 2; continue; }
    if (/^--(git-dir|work-tree|namespace)=/.test(t)) { elsewhere = true; i++; continue; }
    if (t === '-c') {
      // An alias set here can stand for any command, a shell one included.
      const val = args[i + 1];
      if (!val || expands(val, ctx) || /^alias\./i.test(val.text)) return always('unreadable-command');
      i += 2;
      continue;
    }
    i++;
  }
  if (args[i] && expands(args[i], ctx)) return always('unreadable-command');
  const sub = args[i] ? args[i].text : '';
  const rest = args.slice(i + 1);
  if (GIT_GRADED.has(sub) && (elsewhere || unknown || rest.some(w => expands(w, ctx)))) return always('unreadable-command');
  const t = rest.map(w => w.text);
  const top = dir ? ctx.seam.gitTop(dir) : null;
  const gctx = { ...ctx, base: dir };
  switch (sub) {
    case 'push': return judgePush(rest, gctx, top);
    case 'reset':
      if (!t.includes('--hard')) return RUNS;
      return discard(top, ['.'], { tracked: true }, 'unsaved-discard', ctx);
    case 'checkout': case 'restore': return judgeCheckout(sub, rest, gctx, top);
    case 'clean': return judgeClean(rest, gctx, top);
    case 'stash': return (t[0] === 'drop' || t[0] === 'clear') ? always('stash-or-reflog') : RUNS;
    case 'reflog': return (t[0] === 'expire' || t[0] === 'delete') ? always('stash-or-reflog') : RUNS;
    case 'gc': return t.some((x, k) => /^--prune=(now|all)$/.test(x) || (x === '--prune' && /^(now|all)$/.test(t[k + 1] || ''))) ? always('stash-or-reflog') : RUNS;
    case 'filter-branch': case 'filter-repo': return always('history-rewrite');
    case 'worktree': return (t[0] === 'remove' && t.some(x => x === '--force' || x === '-f')) ? always('worktree-force') : RUNS;
    default: return RUNS;
  }
}

function expandPathFrom(word, ctx, base) {
  return expandPath(word, { ...ctx, base });
}

// A discard of tracked changes, untracked files, or both, under `specs`
// relative to the working tree's top.
function discard(top, specs, want, reason, ctx) {
  if (!top) return always('git-unchecked');
  const st = ctx.seam.gitStatus(ctx.canonical(top), specs, { env: !!want.env });
  if (!st || !st.ok) return always('git-unchecked');
  const lost = [
    ...(want.tracked ? st.tracked || [] : []),
    ...(want.untracked ? st.untracked || [] : []),
    ...(want.env ? st.ignoredEnv || [] : []),
  ];
  return lost.length ? unsaved(reason, lost) : RUNS;
}

function relSpec(p, top, ctx) {
  const r = ctx.pmod.relative(ctx.canonical(top), p).split(ctx.pmod.sep).join('/');
  return r || '.';
}

function judgeCheckout(sub, rest, ctx, top) {
  const t = rest.map(w => w.text);
  if (sub === 'restore' && (t.includes('--staged') || t.includes('-S')) && !(t.includes('--worktree') || t.includes('-W'))) return RUNS;
  const dd = t.indexOf('--');
  let candidates;
  if (dd >= 0) candidates = rest.slice(dd + 1);
  else {
    if (sub === 'checkout' && t.some(x => ['-b', '-B', '--orphan', '-c', '--detach'].includes(x))) return RUNS;
    candidates = rest.filter(w => !/^-/.test(w.text)).filter(w => {
      if (w.text === '.' || w.glob) return true;
      const p = expandPath(w, ctx);
      return !!p && ctx.seam.exists(p);
    });
    if (sub === 'restore') candidates = rest.filter(w => !/^-/.test(w.text));
  }
  if (!candidates.length) return RUNS;
  const scopes = [];
  for (const w of candidates) {
    const p = expandPath(w, ctx);
    if (!p) return always('unknown-targets');
    if (insideDotGit(p, ctx)) return always(dotGitReason(p, ctx));
    // A named file is checked like a folder: a discard throws away its
    // unsaved changes for good, and whose they are (the agent's or the
    // person's) cannot be told from here, so any unsaved change asks.
    scopes.push(p);
  }
  if (!top) return always('git-unchecked');
  return discard(top, scopes.map(p => relSpec(p, top, ctx)), { tracked: true }, 'unsaved-discard', ctx);
}

function judgeClean(rest, ctx, top) {
  const t = rest.map(w => w.text);
  const shorts = t.filter(x => /^-[a-zA-Z]+$/.test(x)).join('');
  if (t.includes('--dry-run') || /n/.test(shorts)) return RUNS;
  const onlyIgnored = /X/.test(shorts);
  const alsoIgnored = /x/.test(shorts);
  const specs = [];
  let skipNext = false;
  for (const w of rest) {
    if (skipNext) { skipNext = false; continue; }
    if (w.text === '-e' || w.text === '--exclude') { skipNext = true; continue; }
    if (/^-/.test(w.text)) continue;
    specs.push(w);
  }
  let scopes;
  if (specs.length) {
    scopes = specs.map(w => expandPath(w, ctx));
    if (scopes.some(p => !p)) return always('unknown-targets');
  } else {
    if (!ctx.base) return always('unknown-targets');
    scopes = [ctx.base];
  }
  if (!top) return always('git-unchecked');
  // Ignored files rebuild, except .env files, which nobody can recreate.
  return discard(top, scopes.map(p => relSpec(p, top, ctx)),
    { untracked: !onlyIgnored, env: onlyIgnored || alsoIgnored }, 'unsaved-work', ctx);
}

function judgePush(rest, ctx, top) {
  const t = rest.map(w => w.text);
  let force = false, lease = false, del = false, tags = false, all = false, dry = false;
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const x = t[i];
    if (x === '--force' || x === '-f') { force = true; continue; }
    if (/^--force-with-lease(=|$)/.test(x) || x === '--force-if-includes') { lease = true; continue; }
    if (x === '--mirror' || x === '--prune') return always('remote-refs');
    if (x === '--delete' || x === '-d') { del = true; continue; }
    if (x === '--tags' || x === '--follow-tags') { tags = x === '--tags' || tags; continue; }
    if (x === '--all' || x === '--branches') { all = true; continue; }
    if (x === '--dry-run' || x === '-n') { dry = true; continue; }
    if (x === '-o' || x === '--push-option' || x === '--receive-pack' || x === '--exec' || x === '--repo') { i++; continue; }
    if (/^-[a-zA-Z]+$/.test(x)) { if (x.includes('f')) force = true; if (x.includes('d')) del = true; continue; }
    if (/^-/.test(x)) continue;
    positional.push(rest[i]);
  }
  if (dry) return RUNS;
  const remote = positional[0] ? positional[0].text : 'origin';
  const defaults = top ? ctx.seam.defaultBranches(ctx.canonical(top), remote) : ['main', 'master'];
  const current = top ? ctx.seam.currentBranch(ctx.canonical(top)) : null;
  const isDefault = b => !b || defaults.includes(b);
  const refs = positional.slice(1).map(w => {
    if (w.expands) return { dest: null, plus: false, deletion: del, tag: false };
    let s = w.text;
    const plus = s.startsWith('+');
    if (plus) s = s.slice(1);
    if (s.startsWith(':')) return { dest: strip(s.slice(1)), plus, deletion: true, tag: /^refs\/tags\//.test(s.slice(1)) };
    const [src, dst] = s.split(':');
    let dest = strip(dst !== undefined ? dst : src);
    if (dest === 'HEAD') dest = current;
    const tag = /^refs\/tags\//.test(dst !== undefined ? dst : src) || (!!top && !!dest && ctx.seam.isTag(ctx.canonical(top), dest));
    return { dest, plus, deletion: del, tag };
  });
  const firstDefault = defaults[0];

  const deletions = refs.filter(r => r.deletion);
  if (deletions.length) {
    if (deletions.some(r => isDefault(r.dest))) return always('delete-default', { branch: firstDefault });
    const d = deletions[0];
    return once(RULES.deleteRemoteRef, { ref: d.dest, remote });
  }
  const dests = refs.length ? refs : (tags || all ? [] : [{ dest: current, plus: false, tag: false }]);
  if (force || dests.some(r => r.plus)) {
    const hit = dests.find(r => isDefault(r.dest));
    if (hit || (!dests.length && all)) return always('force-push-default', { branch: (hit && hit.dest) || firstDefault });
    return always('force-push', { remoteBranch: `${remote}/${dests[0] ? dests[0].dest : current}` });
  }
  if (lease && dests.some(r => !r.tag && isDefault(r.dest))) return always('force-push-default', { branch: firstDefault });
  if (tags || dests.some(r => r.tag)) return once(RULES.tags);
  if (all) return once(RULES.defaultBranch, { branch: firstDefault });
  const hit = dests.find(r => isDefault(r.dest));
  if (hit) return once(RULES.defaultBranch, { branch: hit.dest || firstDefault });
  return RUNS;
}

function strip(ref) {
  if (!ref) return ref || null;
  return ref.replace(/^refs\/heads\//, '').replace(/^refs\/tags\//, '');
}

module.exports = { codeModeVerdict, RULES };
