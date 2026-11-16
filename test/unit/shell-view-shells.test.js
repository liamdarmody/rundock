'use strict';
// AGAINST THE REAL SHELLS: wherever bash or zsh runs the command a quote
// seemed to hide, the line is not a read, its risk is not low, and the real
// hook asks about it in both modes.
//
// Each line runs under bash, and zsh where installed, with `echo RDMARK7 >&3`
// in the hidden command's place: it writes to a pipe only this test holds, so
// a marker printed as text never counts. Only echoes, listings and
// here-documents run, in a scratch folder, HOME a scratch home, the
// environment PATH, HOME and the temp folders, no startup files, five seconds
// each, nothing on the network. Each line a shell ran the marker in is judged
// again with the real hidden command, a copy over that home's settings.
//
// A missing bash fails under CI and skips with a notice elsewhere; a missing
// zsh skips its half with a notice, under CI too, naming what ran. Windows
// skips with a notice: an agent's bash there is Git Bash, the GNU bash this
// runs on Linux, and this harness (a third pipe, POSIX paths) is POSIX only.
//
// A CODE IN A WORD THAT ZSH RUNS IS HIGH IN NOTES MODE. Each line in
// IN_A_WORD that zsh runs the marker in grades high, so no saved answer for
// its leading command covers it. They are judged by the grader alone: the
// hook's reading of a qualifier's code is not what this holds to.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const fx = require('../helpers/code-mode-fixture.js');
const S = require('../../public/read-only-shell.js');
const P = require('../../public/permissions.js');

const MARK = 'RDMARK7';
const MARKER = `echo ${MARK} >&3`;
const SLOT = '{H}';
const inCi = (v => typeof v === 'string' && v !== '' && v !== '0' && v.toLowerCase() !== 'false')(process.env.CI);

// zsh's glob qualifiers and =( ). The scratch folder holds one file, g1.
const QUALIFIERS = [
  ['a glob qualifier that runs code', "ls *(e:'{H}':)", 'some'],
  ['a glob qualifier with other delimiters', "ls *(e+'{H}'+)", 'some'],
  ['a glob qualifier in braces', "ls *(e{'{H}'})", 'some'],
  ['a glob qualifier that calls a function', 'RDF() { {H}; }; ls g1(+RDF)', 'some'],
  ['=( )', 'cat =({H})', 'some'],
  ['two =( )', 'diff =({H}) =(ls)', 'some'],
];
// SLOT is the hidden command. `every`: every bash runs it; the rest run in
// one shell or version, and are judged where one does.
const LINES = [
  // A quote in a comment.
  ['a quote in a comment', "ls # it's\n{H}\nls # '", 'every'],
  ['a quote in a comment after an echo', "echo A # it's\n{H}\necho B # '", 'every'],
  ['a quote in a comment with no blank after the #', "ls -la #don't\n{H}\nls #'", 'every'],
  ['a quote in a comment after an operator', "ls; # it's\n{H}\nls # '", 'every'],
  ['a double quote in a comment', 'ls # "\n{H}\nls # "', 'every'],
  ['a backtick in a comment', 'ls # `\n{H}\nls # `', 'every'],
  // An escaped quote inside $'…'.
  ['an escaped quote inside $\'…\'', "ls $'\\''; {H}", 'every'],
  ['an escaped quote inside $\'…\', on lines of their own', "ls $'\\''\n{H}\nls $'\\''", 'every'],
  ['an escaped quote inside a word in $\'…\'', "echo $'it\\'s'; {H}; echo $'\\''", 'every'],
  ['an escaped backslash and quote inside $\'…\'', "echo $'a\\\\\\'b'; {H}; echo $'\\''", 'every'],
  ['an escaped quote inside $\'…\' in a shell\'s -c', "bash -c \"ls $'\\\\''; {H}; ls $'\\\\''\"", 'every'],
  // A quote in a here-document's body.
  ['a quote in a here-document\'s body', "cat <<EOF\n'\nEOF\n{H}\necho \"'\"", 'every'],
  ['a quote in a quoted here-document\'s body', "cat <<'EOF'\nit's\nEOF\n{H}\necho \"'\"", 'every'],
  ['a quote in a here-document whose tabs are stripped', "cat <<-EOF\n\t'\n\tEOF\n{H}\necho \"'\"", 'every'],
  ['a double quote in a double-quoted here-document\'s body', "cat <<\"EOF\"\n\"\nEOF\n{H}\necho '\"'", 'every'],
  ['quotes in two here-documents on one line', "cat <<A <<B\n'\nA\n\"\nB\n{H}\necho \"'\"", 'every'],
  ['a substitution in a here-document\'s body', "cat <<EOF\nit's $({H})\nEOF", 'every'],
  // Quotes inside a substitution held in double quotes.
  ['quotes inside a substitution in double quotes', "echo \"$(echo \"'\")\"\n{H}\necho \"$(echo \"'\")\"", 'every'],
  ['quotes inside a backtick in double quotes', "echo \"`echo \"'\"`\"\n{H}\necho \"`echo \"'\"`\"", 'every'],
  ['the command inside a substitution in double quotes', 'echo "$({H})"', 'every'],
  ['an apostrophe inside a substitution in double quotes', "echo \"a $(echo \"it's\") b\"; {H}; echo \"$(echo \"'\")\"", 'every'],
  ['quotes inside nested substitutions in double quotes', "echo \"$(echo \"$(echo \"'\")\")\"\n{H}\necho \"'\"", 'every'],
  // A case pattern.
  ['a case pattern', 'case x in x) {H};; esac', 'every'],
  ['a case pattern with its opening (', 'case x in (x) {H};; esac', 'every'],
  ['a case pattern that is an escaped quote', "case \"'\" in \\') {H};; esac", 'every'],
  ['a case pattern that matches anything', 'case x in *) {H};; esac', 'every'],
  ['a case inside a substitution in double quotes', 'echo "$(case x in x) {H};; esac)"', 'some'],
  ...QUALIFIERS,
  // Here-documents inside a substitution, which bash 3.2 ends at a ) in the body.
  ['a quoted here-document in a substitution, a ) in its body', "echo \"$(cat <<'EOF'\n)$({H})\nEOF\n)\"", 'some'],
  ['a here-document in a substitution, a ) in its body', "echo \"$(cat <<EOF\n)$({H})\nEOF\n)\"", 'some'],
  // A single quote inside ${…} within double quotes: bash 3.2 takes it as a quote, zsh as text.
  ['a single quote inside ${…} within double quotes', "echo \"${x:-'}\"\n{H}\necho \"${x:-'}\"", 'some'],
];
// Code zsh runs from inside a word, however the word starts and wherever it
// is. `#q` is a qualifier only with extendedglob set, which a person's own
// zsh settings can set.
const IN_A_WORD = [
  ...QUALIFIERS,
  ['a qualifier word that starts with a quote', "ls 'g'*(e:'{H}':)"],
  ['a qualifier word that starts with a backslash', "ls \\g*(e:'{H}':)"],
  ['a qualifier word that starts with a quoted $', "ls \"$PWD\"/*(e:'{H}':)"],
  ['a qualifier word that starts with a $', "ls $PWD/*(e:'{H}':)"],
  ['a qualifier word that starts with $\'…\'', "ls $'g'*(e:'{H}':)"],
  ['a qualifier inside $( )', "echo $(ls *(e:'{H}':))"],
  ['a qualifier inside $( ) in double quotes', "echo \"$(ls *(e:'{H}':))\""],
  ['a qualifier inside backticks', "echo `ls *(e:'{H}':)`"],
  ['a qualifier inside <( )', "cat <(ls *(e:'{H}':))"],
  ['a qualifier in an array element', "a=(*(e:'{H}':))"],
  ['a qualifier in an array element after another', "a=(x *(e:'{H}':))"],
  ['a qualifier in an element added to an array', "a+=(*(e:'{H}':))"],
  ['a qualifier inside =( )', "cat =(ls *(e:'{H}':))"],
  ['a qualifier written as +name', 'RDF() { {H}; }; ls *(+RDF)'],
  ['a qualifier written as #q', "setopt extendedglob; ls *(#qe:'{H}':)"],
  ['a qualifier written as #q after a pattern', "setopt extendedglob; ls g*(#qe:'{H}':)"],
];
// A quote that does open: the hidden line is text, and keeps the marker honest.
const TEXT_ONLY = [
  ['a # inside a word starts no comment', "echo a#b it's\n{H}\necho '"],
  ['$# starts no comment', "echo $# it's\n{H}\necho '"],
  ['the hidden line inside single quotes', "echo '\n{H}\n'"],
];
const CONTROL = 'ls; {H}';

function onPath(name) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch (e) { /* not here */ }
  }
  return null;
}
const SHELLS = [
  { name: 'bash', bin: onPath('bash'), args: ['--norc', '--noprofile', '-c'], version: 'echo $BASH_VERSION' },
  { name: 'zsh', bin: onPath('zsh'), args: ['-f', '-c'], version: 'echo $ZSH_VERSION' },
];
const WINDOWS = process.platform === 'win32';
const bash = SHELLS[0];
if (!WINDOWS && !bash.bin && inCi) throw new Error('shell-view-shells: bash is not on PATH, and under CI this fails rather than skips');
const root = WINDOWS ? { skip: 'Windows' } : fx.outsideTempRoot();
const SKIP = WINDOWS ? 'on Windows the bash an agent runs is Git Bash, the GNU bash this file runs on Linux'
  : !bash.bin ? 'bash is not on PATH' : (root.skip || false);
if (SKIP) process.stderr.write(`shell-view-shells: skipped: ${SKIP}\n`);

let world, capture, deadPort, settings, scratch;
// Shell name -> the lines it ran the marker in.
const ran = new Map();

function run(shell, line) {
  const r = spawnSync(shell.bin, [...shell.args, line], {
    cwd: scratch,
    env: { PATH: '/usr/bin:/bin', HOME: world.home, TMPDIR: scratch, TMPPREFIX: path.join(scratch, 'zsh') },
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    timeout: 5000,
    killSignal: 'SIGKILL',
  });
  if (r.error && r.error.code === 'ETIMEDOUT') throw new Error(`${shell.name} ran past five seconds: ${JSON.stringify(line)}`);
  const fd3 = r.output && r.output[3] ? r.output[3].toString() : '';
  return fd3.split('\n').includes(MARK);
}
const fill = (tmpl, command) => tmpl.split(SLOT).join(command);

before(async () => {
  if (SKIP) return;
  world = fx.buildWorld(root.dir);
  settings = path.join(world.home, '.claude', 'settings.json');
  scratch = path.join(root.dir, 'shell-scratch');
  fs.mkdirSync(scratch, { recursive: true });
  fs.writeFileSync(path.join(scratch, 'g1'), '');
  capture = await fx.startCaptureServer();
  deadPort = await fx.closedPort();
  const told = [];
  for (const shell of SHELLS) {
    if (!shell.bin) { told.push(`${shell.name} not installed, its half skipped`); continue; }
    const v = spawnSync(shell.bin, [...shell.args, shell.version], { env: { PATH: '/usr/bin:/bin', HOME: world.home }, timeout: 5000 });
    const runs = new Set();
    for (const [, tmpl] of [['control', CONTROL], ...LINES, ...IN_A_WORD, ...TEXT_ONLY]) if (run(shell, fill(tmpl, MARKER))) runs.add(tmpl);
    ran.set(shell.name, runs);
    told.push(`${shell.name} ${String(v.stdout || '').trim() || 'of unknown version'} ran the marker in ${[...LINES].filter(([, t]) => runs.has(t)).length} of ${LINES.length} lines`);
  }
  process.stderr.write(`shell-view-shells: ${told.join('; ')}\n`);
});
after(async () => {
  if (capture) await capture.close();
  if (root.dir) fs.rmSync(root.dir, { recursive: true, force: true });
});

const ranAnywhere = (tmpl) => [...ran.values()].some((s) => s.has(tmpl));
const show = (s) => JSON.stringify(s);
const writesSettings = (r) => ((r.payload && r.payload.crossings) || [])
  .some((c) => c.persistenceSurface && c.write && c.path === fs.realpathSync(settings));

describe('against the real shells, a line that runs the hidden command is never a read', { skip: SKIP }, () => {
  test('the marker runs in every shell present on a plain line, and is never seen where the hidden line is text', () => {
    for (const [name, runs] of ran) {
      assert.ok(runs.has(CONTROL), `${name} did not run the marker on a plain line`);
      for (const [what, tmpl] of TEXT_ONLY) assert.ok(!runs.has(tmpl), `${name} ran a line that is text: ${what}`);
    }
  });

  test('bash runs the hidden command in each line every bash runs it in', () => {
    const runs = ran.get('bash');
    for (const [what, tmpl, every] of LINES) if (every === 'every') assert.ok(runs.has(tmpl), `bash did not run: ${what}`);
  });

  test('each line a shell runs the hidden command in is not a read, and its risk is not low', () => {
    let judged = 0;
    for (const [what, tmpl] of LINES) {
      if (!ranAnywhere(tmpl)) continue;
      judged++;
      const line = fill(tmpl, `cp x ${settings}`);
      assert.strictEqual(S.isReadOnlyShellCommand(line), false, `read as a read: ${what}: ${show(line)}`);
      assert.notStrictEqual(P.classifyRisk('Bash', { command: line }), 'low', `graded low: ${what}: ${show(line)}`);
    }
    assert.ok(judged > 0, 'no line was judged');
  });

  test('each line zsh runs code in from inside a word grades high in Notes mode, so a saved answer for it cards', { skip: !SHELLS[1].bin && 'zsh is not installed' }, () => {
    const runs = ran.get('zsh');
    const judged = IN_A_WORD.filter(([, tmpl]) => runs.has(tmpl));
    assert.ok(judged.length === IN_A_WORD.length, `zsh ran the marker in ${judged.length} of ${IN_A_WORD.length}: missing ${IN_A_WORD.filter(([, t]) => !runs.has(t)).map(([w]) => w).join(', ')}`);
    for (const [what, tmpl] of judged) {
      const line = fill(tmpl, `cp x ${settings}`);
      const risk = P.classifyRisk('Bash', { command: line });
      assert.strictEqual(risk, 'high', `${what}: ${show(line)}`);
      const key = P.toolAllowKey('Bash', { command: line });
      assert.deepStrictEqual(P.decidePermission(risk, key, new Set([key])), { action: 'card' }, `${what}: a saved ${key} covers it`);
      assert.strictEqual(P.offersAlwaysAllow(risk), false, `${what}: the card offers Always allow`);
    }
  });

  for (const [mode, codeMode, cls] of [['Notes mode', false, 'boundary'], ['Code mode', true, 'always-asks']]) {
    test(`${mode}: each line a shell runs the hidden copy in asks through the real hook, as a write over the settings`, async () => {
      const plain = await fx.judge(world, capture, deadPort, { tool: 'Bash', input: { command: `ls; cp x ${settings}` }, cwd: fx.cwdFor(world, 'app'), codeMode });
      assert.strictEqual(plain.cls, cls, `sanity: the plain line is ${plain.cls}`);
      for (const [what, tmpl] of LINES) {
        if (!ranAnywhere(tmpl)) continue;
        const line = fill(tmpl, `cp x ${settings}`);
        const r = await fx.judge(world, capture, deadPort, { tool: 'Bash', input: { command: line }, cwd: fx.cwdFor(world, 'app'), codeMode });
        assert.strictEqual(r.cls, cls, `${what}: ${r.cls}: ${show(line)}`);
        assert.ok(writesSettings(r), `${what}: the card does not name the settings as written: ${JSON.stringify(r.payload && r.payload.crossings)}`);
      }
    });
  }
});
