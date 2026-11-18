'use strict';
// AGAINST THE REAL SHELLS: a quoted parameter that names an array is one word.
//
// The shared definition (public/read-only-shell.js) takes a quoted plain
// parameter as one word, so `-name "$t"` is find's pattern however `t` is set.
// In zsh, `path`, `argv`, `pipestatus` and `funcstack` are arrays the shell
// sets itself, and a declared array or an associative array can hold `-o` or
// `-delete` as values; bash has its own arrays (`BASH_ARGV`, `FUNCNAME` and
// the rest). This runs the real zsh and the real bash and counts the words a
// function receives for each quoted form, under every option set and unset
// and, in zsh, each emulation: every count is one. zsh joins a quoted array
// into one word; bash, and zsh with KSH_ARRAYS, take its first element. In the
// same runs the arrays splatted, and zsh's `$path` unquoted, give more than
// one word, so a quoted form that split would be seen.
//
// Each script is written to this test's own temp folder and runs there, HOME
// that folder, the environment PATH, HOME and TMPDIR, no startup files. A
// missing bash fails under CI and skips with a notice elsewhere; a missing zsh
// skips its half with a notice. Windows skips with a notice: this harness is
// POSIX only.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const inCi = (v => typeof v === 'string' && v !== '' && v !== '0' && v.toLowerCase() !== 'false')(process.env.CI);
function onPath(name) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch (e) { /* not here */ }
  }
  return null;
}
const WINDOWS = process.platform === 'win32';
const BASH = WINDOWS ? null : onPath('bash');
const ZSH = WINDOWS ? null : onPath('zsh');
if (!WINDOWS && !BASH && inCi) throw new Error('quoted-parameter-one-word-shells: bash is not on PATH, and under CI this fails rather than skips');
const ON_WINDOWS = 'on Windows the bash an agent runs is Git Bash, and this harness is POSIX only';
const SKIP_BASH = WINDOWS ? ON_WINDOWS : (!BASH && 'bash is not on PATH');
const SKIP_ZSH = WINDOWS ? ON_WINDOWS : (!ZSH && 'zsh is not installed');
if (SKIP_BASH) process.stderr.write(`quoted-parameter-one-word-shells: bash half skipped: ${SKIP_BASH}\n`);
if (SKIP_ZSH) process.stderr.write(`quoted-parameter-one-word-shells: zsh half skipped: ${SKIP_ZSH}\n`);

// The quoted plain forms of a parameter, each counted with itself as its label.
// The pipeline status array is reset by every command, so it is counted in
// its plain form only, each count after a pipeline of two.
const PIPELINE = 'true | true; ';
const QUOTED = (name, pipeName) => (name === pipeName ? ['"$' + name + '"']
  : ['"$' + name + '"', '"${' + name + '}"', '"$' + name + '.md"', '"a${' + name + '}b"']);
const counted = (label, expr, afterPipeline) => '  ' + (afterPipeline ? PIPELINE : '') + "count '" + label + "' " + expr;
const formsOf = (arrays, pipeName) => arrays.flatMap((name) => [
  ...QUOTED(name, pipeName).map((f) => counted(f, f, name === pipeName)),
  counted('each:' + name, '"${' + name + '[@]}"', name === pipeName),
]);
const labelsOf = (arrays, pipeName) => arrays.flatMap((name) => [...QUOTED(name, pipeName), 'each:' + name]);

// zsh: each array and the words it splats to, in every run that counts.
const ZSH_ARRAYS = [['path', 3], ['list', 3], ['pairs', 2], ['argv', 3], ['pipestatus', 2], ['funcstack', 2]];
const ZSH_FOR_PATH = 'for-PATH:"$path"';
const ZSH_SCRIPT = [
  "count() { print -rn -- \"$1=\"; shift; print -rn -- \"$# \"; }",
  'probe() {',
  "  for PATH in 'x:-o:-delete'; do count '" + ZSH_FOR_PATH + "' \"$path\"; done",
  '  path=(x -o -delete)',
  '  typeset -a list; list=(a -o -delete)',
  '  typeset -A pairs; pairs=(k1 -o k2 -delete)',
  ...formsOf(ZSH_ARRAYS.map(([name]) => name), 'pipestatus'),
  "  count 'unquoted:$path' $path",
  "  if [[ -o ksharrays ]]; then print -rn -- 'ksharrays=1 '; else print -rn -- 'ksharrays=0 '; fi",
  '}',
  'outer() { probe x -o -delete; }',
  'for opt in ${(k)options}; do',
  '  print -r -- "setopt $opt: $( (setopt $opt; outer) 2>/dev/null )"',
  '  print -r -- "unsetopt $opt: $( (unsetopt $opt; outer) 2>/dev/null )"',
  'done',
  'for mode in sh ksh csh zsh; do',
  '  print -r -- "emulate $mode: $( (emulate $mode; outer) 2>/dev/null )"',
  'done',
  'print -r -- "default: $(outer 2>/dev/null)"',
  '',
].join('\n');
const ZSH_LABELS = [ZSH_FOR_PATH, ...labelsOf(ZSH_ARRAYS.map(([name]) => name), 'pipestatus'), 'unquoted:$path', 'ksharrays'].sort();
// The runs in which the shell runs nothing, so nothing is counted.
const ZSH_RUNS_NOTHING = new Map([
  ['setopt restricted', 'a restricted shell cannot set path'],
  ['unsetopt exec', 'with NO_EXEC no command runs'],
]);

// bash: a declared array and the shell's own arrays, each where it is set.
const BASH_ARRAYS = ['list', 'PIPESTATUS', 'BASH_ARGV', 'BASH_ARGC', 'BASH_SOURCE', 'BASH_LINENO', 'FUNCNAME', 'GROUPS', 'BASH_VERSINFO', 'DIRSTACK'];
const BASH_SCRIPT = [
  // BASH_ARGV and BASH_ARGC are set only with extdebug.
  'shopt -s extdebug',
  "count() { printf '%s=' \"$1\"; shift; printf '%s ' \"$#\"; }",
  'probe() {',
  '  local list; list=(a -o -delete)',
  ...formsOf(BASH_ARRAYS, 'PIPESTATUS'),
  "  count 'unquoted:${list[@]}' ${list[@]}",
  '}',
  'outer() { probe x -o -delete; }',
  'for opt in $(compgen -A shopt); do',
  '  printf \'%s\\n\' "shopt -s $opt: $( (shopt -s "$opt"; outer) 2>/dev/null )"',
  '  printf \'%s\\n\' "shopt -u $opt: $( (shopt -u "$opt"; outer) 2>/dev/null )"',
  'done',
  'for opt in $(compgen -A setopt); do',
  '  printf \'%s\\n\' "set -o $opt: $( (set -o "$opt"; outer) 2>/dev/null )"',
  '  printf \'%s\\n\' "set +o $opt: $( (set +o "$opt"; outer) 2>/dev/null )"',
  'done',
  'printf \'%s\\n\' "default: $(outer 2>/dev/null)"',
  '',
].join('\n');
const BASH_LABELS = [...labelsOf(BASH_ARRAYS, 'PIPESTATUS'), 'unquoted:${list[@]}'].sort();
const BASH_RUNS_NOTHING = new Map([['set -o noexec', 'with noexec no command runs']]);

let dir;
const env = () => ({ PATH: '/usr/bin:/bin', HOME: dir, TMPDIR: dir });
before(() => { if (BASH || ZSH) dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'quoted-word-'))); });
after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

function version(bin, args, expr) {
  const r = spawnSync(bin, [...args, '-c', expr], { env: env(), encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL' });
  return String(r.stdout || '').trim() || 'of unknown version';
}

// Runs a script written to the temp folder; each line of its output is
// `<run>: <label>=<count> ...`, read into a map of run to (label to count).
function runScript(bin, args, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  const r = spawnSync(bin, [...args, file], { cwd: dir, env: env(), encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL' });
  if (r.error) throw r.error;
  assert.strictEqual(r.status, 0, `${name} exited ${r.status}: ${r.stderr}`);
  const runs = new Map();
  for (const line of r.stdout.split('\n')) {
    if (!line) continue;
    const at = line.indexOf(': ');
    assert.ok(at > 0, `a line of output names its run: ${JSON.stringify(line)}`);
    const counts = new Map();
    for (const m of line.slice(at + 2).matchAll(/(\S+)=(\d+)/g)) counts.set(m[1], Number(m[2]));
    runs.set(line.slice(0, at), counts);
  }
  return runs;
}

// Every run counts every form, or is a run the shell runs nothing in; each
// quoted form is one word in every run that counts. Returns the runs counted.
function eachQuotedFormIsOneWord(runs, labels, runsNothing) {
  const checked = [];
  for (const [run, counts] of runs) {
    if (counts.size === 0 && runsNothing.has(run)) continue;
    assert.deepStrictEqual([...counts.keys()].sort(), labels, `${run}: every form was counted`);
    for (const [label, n] of counts) {
      if (label.startsWith('"') || label.startsWith('for-')) assert.strictEqual(n, 1, `${run}: ${label} is one word`);
    }
    checked.push(run);
  }
  return checked;
}

describe('in the real zsh, a quoted parameter naming an array is one word', { skip: SKIP_ZSH }, () => {
  test('each quoted form is one word under every option set and unset and each emulation, while the array splatted or unquoted is not', () => {
    const runs = runScript(ZSH, ['-f'], 'words.zsh', ZSH_SCRIPT);
    const options = [...runs.keys()].filter((r) => r.startsWith('setopt ')).map((r) => r.slice('setopt '.length));
    assert.ok(options.length > 100, `zsh listed its options: ${options.length}`);
    for (const o of options) assert.ok(runs.has(`unsetopt ${o}`), `ran with ${o} unset`);
    for (const mode of ['sh', 'ksh', 'csh', 'zsh']) assert.ok(runs.has(`emulate ${mode}`), `ran under emulate ${mode}`);
    assert.ok(runs.has('default'), 'ran with the options as they start');
    const checked = eachQuotedFormIsOneWord(runs, ZSH_LABELS, ZSH_RUNS_NOTHING);
    assert.strictEqual(checked.length, runs.size - [...ZSH_RUNS_NOTHING.keys()].filter((r) => runs.has(r) && runs.get(r).size === 0).length);
    const firstElementOnly = [];
    for (const run of checked) {
      const counts = runs.get(run);
      for (const [name, words] of ZSH_ARRAYS) {
        assert.strictEqual(counts.get('each:' + name), words, `${run}: ${name} splats to ${words} words, so the arrays were set`);
      }
      // The control: unquoted, $path is three words, unless KSH_ARRAYS makes
      // it the first element.
      if (counts.get('ksharrays') === 1) {
        firstElementOnly.push(run);
        assert.strictEqual(counts.get('unquoted:$path'), 1, `${run}: with KSH_ARRAYS, an unquoted $path is its first element`);
      } else {
        assert.strictEqual(counts.get('unquoted:$path'), 3, `${run}: an unquoted $path is three words, so a split would be seen`);
      }
    }
    assert.strictEqual(runs.get('default').get('unquoted:$path'), 3, 'the control: an unquoted $path is three words');
    for (const run of ['setopt ksharrays', 'emulate sh', 'emulate ksh']) assert.ok(firstElementOnly.includes(run), `${run} takes the first element`);
    process.stderr.write(`quoted-parameter-one-word-shells: zsh ${version(ZSH, ['-f'], 'print -r -- $ZSH_VERSION')} counted ${checked.length} runs over ${options.length} options and four emulations\n`);
  });

  // The same quoted `$path` as find's pattern, after a `for` that sets PATH:
  // find takes the one word as a pattern, and nothing is deleted.
  const LINE = "for PATH in 'x:-o:-delete'; do /usr/bin/find . -name \"$path\" -print; done";
  const SKIP_FIND = !fs.existsSync('/usr/bin/find') && '/usr/bin/find is not installed';
  const searchIn = (line) => {
    const where = fs.mkdtempSync(path.join(dir, 'search-'));
    fs.writeFileSync(path.join(where, 'alpha.md'), '');
    const r = spawnSync(ZSH, ['-f', '-c', line], { cwd: where, env: env(), encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL' });
    if (r.error) throw r.error;
    return { r, kept: fs.existsSync(path.join(where, 'alpha.md')) };
  };
  test('the search by a quoted $path after a for that sets PATH takes one pattern and deletes nothing', { skip: SKIP_FIND }, () => {
    const { r, kept } = searchIn(LINE);
    assert.strictEqual(r.status, 0, `find ran: ${r.stderr}`);
    assert.strictEqual(kept, true, 'the file is still there');
    assert.strictEqual(r.stdout, '', 'nothing is named the one pattern');
  });
  test('the same search with $path unquoted deletes the file, so a split would be seen', { skip: SKIP_FIND }, () => {
    const { kept } = searchIn(LINE.replace('"$path"', '$path'));
    assert.strictEqual(kept, false, 'unquoted, $path is three words and find deletes');
  });
});

describe('in the real bash, a quoted parameter naming an array is one word', { skip: SKIP_BASH }, () => {
  test('each quoted form is one word under every shopt and set -o option set and unset, while the array splatted is not', () => {
    const runs = runScript(BASH, ['--norc', '--noprofile'], 'words.bash', BASH_SCRIPT);
    const options = [...runs.keys()].filter((r) => /^(shopt -s|set -o) /.test(r));
    assert.ok(options.length > 40, `bash listed its options: ${options.length}`);
    for (const o of options) assert.ok(runs.has(o.replace(/^shopt -s/, 'shopt -u').replace(/^set -o/, 'set +o')), `ran with ${o} turned off`);
    assert.ok(runs.has('default'), 'ran with the options as they start');
    const checked = eachQuotedFormIsOneWord(runs, BASH_LABELS, BASH_RUNS_NOTHING);
    assert.strictEqual(checked.length, runs.size - [...BASH_RUNS_NOTHING.keys()].filter((r) => runs.has(r) && runs.get(r).size === 0).length);
    for (const run of checked) {
      const counts = runs.get(run);
      assert.strictEqual(counts.get('each:list'), 3, `${run}: the array splats to three words`);
      assert.strictEqual(counts.get('each:PIPESTATUS'), 2, `${run}: PIPESTATUS splats to two words`);
      assert.strictEqual(counts.get('unquoted:${list[@]}'), 3, `${run}: unquoted, the splat is three words`);
    }
    // With the options as they start, the shell's own arrays hold more than
    // one element, so their quoted forms were counted with something to split.
    const start = runs.get('default');
    for (const name of ['BASH_ARGV', 'BASH_ARGC', 'BASH_SOURCE', 'BASH_LINENO', 'FUNCNAME', 'BASH_VERSINFO']) {
      assert.ok(start.get('each:' + name) > 1, `${name} holds more than one element`);
    }
    process.stderr.write(`quoted-parameter-one-word-shells: bash ${version(BASH, ['--norc', '--noprofile'], 'echo $BASH_VERSION')} counted ${checked.length} runs over ${options.length} options\n`);
  });
});
