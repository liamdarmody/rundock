'use strict';
// NOTHING THAT ASKED ON MAIN STOPS ASKING. The options of find, rg, tree and
// file are judged on the words the shell hands the program, which made a
// quoted writing option ask; this holds that reading to tightening only.
//
// test/fixtures/read-only-on-main.json holds main's verdict, at the merge base
// it names, on every shell command the read-only tests judge: the lines they
// write out, the forms they generate from the module's own lists, and the
// lines their hooks are handed. It is recorded by
// test/tools/record-read-only-on-main.js and written by nothing else; each row
// is the command, whether main read it, and main's risk. A command longer
// than a kibibyte is stored in pieces, and test/helpers/read-only-on-main.js
// reads each one back to the command before it is graded here.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const S = require('../../public/read-only-shell.js');
const P = require('../../public/permissions.js');
const { decodeCommand, recordedLines, LONGEST_AS_WRITTEN } = require('../helpers/read-only-on-main.js');
const RECORDED = require('../fixtures/read-only-on-main.json');
const LINES = recordedLines(RECORDED);

const risk = (command) => P.classifyRisk('Bash', { command });
const show = (cmd) => JSON.stringify(cmd.length > 100 ? cmd.slice(0, 100) + '...' : cmd);

// THE ONLY LINES THAT GO FROM NOT READ TO READ, written out one per line: a
// quoted plain parameter as the operand of one of find's pattern primaries,
// which find takes as a pattern whatever the shell puts there. main reads no
// find line holding a `$`, so each is a change from main. A line that reads
// now and is not here fails below, by name, whether it is in the recording
// or among the lines generated from the module's own lists.
const NEWLY_READING = new Set([
  // A quoted variable as find's pattern.
  'find . -name "$t.md" -print',
  'find notes -iname "${t}*"',
  'find notes -name "$t*"',
  'find . -path ./.rundock -prune -o -name "$t.md" -print',
  'find . -path "./$d/*" -print',
  'find . -regex ".*/${t}[.]md"',
  'find . -lname "$t"',
  'find . -wholename "./$a/$b.md"',
  // A search over several names, alone and after a cd into the workspace.
  'for t in alpha beta; do echo "== $t"; find . -path ./.git -prune -o -path ./.rundock -prune -o -name "$t.md" -print; done',
  'cd /home/example/Workspace && for t in alpha beta; do echo "== $t"; find . -path ./.git -prune -o -path ./.rundock -prune -o -name "$t.md" -print; done',
  // Beside other text, other variables and other reading primaries; a zsh
  // array, which quoted is one word (setting PATH sets `path`); and the
  // segments the hook judges on their own.
  'find . -name "$t.md"',
  'find . \\( -name "$t" -o -iname "$u.md" \\) -print',
  'find . -name "$t""$u"',
  'find . -name "$t$u"',
  'find . -name "$t,$u"',
  'find . -name "$t-$u"',
  'find . -name "$t?"',
  'find . -name "$t".md -print',
  'find . -name "$t x"',
  'find . -name "$t\tx"',
  'find . -name "${t}[1]"',
  'find . -name "${t}:h"',
  'find . ! -name "$t"',
  'find . -not -path "./$d/*" -name "$t"',
  'find . -ipath "*/$d/$t-$u,x?"',
  'find . -name "$t" -o -name "$u" -print',
  'find . -type f -name "$t" -newer x',
  'find . -iregex ".*/${t}[.]md" -maxdepth 2',
  'find . -name "$_x$T_2"',
  "for PATH in 'x:-o:-delete'; do /usr/bin/find . -name \"$path\" -print; done",
  'find . -path ./.rundock -prune -o -name "$t" ~ -print',
  'find . -name "$t"',
  'find . -path ./.rundock -prune -o -name "$t"',
  'find . -path ./.git -prune -o -path ./.rundock -prune -o -name "$t.md" -print',
  // Each pattern primary, in each reading form, with each spelling.
  'find . -name "$t" -print',
  'find . -name "${t}.md" -print',
  'find . -name ".*/$t*" -print',
  'find . -path ./.rundock -prune -o -name "$t" -print',
  'find . -path ./.rundock -prune -o -name "${t}.md" -print',
  'find . -path ./.rundock -prune -o -name ".*/$t*" -print',
  'find . -iname "$t" -print',
  'find . -iname "$t.md" -print',
  'find . -iname "${t}.md" -print',
  'find . -iname ".*/$t*" -print',
  'find . -path ./.rundock -prune -o -iname "$t" -print',
  'find . -path ./.rundock -prune -o -iname "$t.md" -print',
  'find . -path ./.rundock -prune -o -iname "${t}.md" -print',
  'find . -path ./.rundock -prune -o -iname ".*/$t*" -print',
  'find . -path "$t" -print',
  'find . -path "$t.md" -print',
  'find . -path "${t}.md" -print',
  'find . -path ".*/$t*" -print',
  'find . -path ./.rundock -prune -o -path "$t" -print',
  'find . -path ./.rundock -prune -o -path "$t.md" -print',
  'find . -path ./.rundock -prune -o -path "${t}.md" -print',
  'find . -path ./.rundock -prune -o -path ".*/$t*" -print',
  'find . -ipath "$t" -print',
  'find . -ipath "$t.md" -print',
  'find . -ipath "${t}.md" -print',
  'find . -ipath ".*/$t*" -print',
  'find . -path ./.rundock -prune -o -ipath "$t" -print',
  'find . -path ./.rundock -prune -o -ipath "$t.md" -print',
  'find . -path ./.rundock -prune -o -ipath "${t}.md" -print',
  'find . -path ./.rundock -prune -o -ipath ".*/$t*" -print',
  'find . -wholename "$t" -print',
  'find . -wholename "$t.md" -print',
  'find . -wholename "${t}.md" -print',
  'find . -wholename ".*/$t*" -print',
  'find . -path ./.rundock -prune -o -wholename "$t" -print',
  'find . -path ./.rundock -prune -o -wholename "$t.md" -print',
  'find . -path ./.rundock -prune -o -wholename "${t}.md" -print',
  'find . -path ./.rundock -prune -o -wholename ".*/$t*" -print',
  'find . -iwholename "$t" -print',
  'find . -iwholename "$t.md" -print',
  'find . -iwholename "${t}.md" -print',
  'find . -iwholename ".*/$t*" -print',
  'find . -path ./.rundock -prune -o -iwholename "$t" -print',
  'find . -path ./.rundock -prune -o -iwholename "$t.md" -print',
  'find . -path ./.rundock -prune -o -iwholename "${t}.md" -print',
  'find . -path ./.rundock -prune -o -iwholename ".*/$t*" -print',
  'find . -lname "$t" -print',
  'find . -lname "$t.md" -print',
  'find . -lname "${t}.md" -print',
  'find . -lname ".*/$t*" -print',
  'find . -path ./.rundock -prune -o -lname "$t" -print',
  'find . -path ./.rundock -prune -o -lname "$t.md" -print',
  'find . -path ./.rundock -prune -o -lname "${t}.md" -print',
  'find . -path ./.rundock -prune -o -lname ".*/$t*" -print',
  'find . -ilname "$t" -print',
  'find . -ilname "$t.md" -print',
  'find . -ilname "${t}.md" -print',
  'find . -ilname ".*/$t*" -print',
  'find . -path ./.rundock -prune -o -ilname "$t" -print',
  'find . -path ./.rundock -prune -o -ilname "$t.md" -print',
  'find . -path ./.rundock -prune -o -ilname "${t}.md" -print',
  'find . -path ./.rundock -prune -o -ilname ".*/$t*" -print',
  'find . -regex "$t" -print',
  'find . -regex "$t.md" -print',
  'find . -regex "${t}.md" -print',
  'find . -regex ".*/$t*" -print',
  'find . -path ./.rundock -prune -o -regex "$t" -print',
  'find . -path ./.rundock -prune -o -regex "$t.md" -print',
  'find . -path ./.rundock -prune -o -regex "${t}.md" -print',
  'find . -path ./.rundock -prune -o -regex ".*/$t*" -print',
  'find . -iregex "$t" -print',
  'find . -iregex "$t.md" -print',
  'find . -iregex "${t}.md" -print',
  'find . -iregex ".*/$t*" -print',
  'find . -path ./.rundock -prune -o -iregex "$t" -print',
  'find . -path ./.rundock -prune -o -iregex "$t.md" -print',
  'find . -path ./.rundock -prune -o -iregex "${t}.md" -print',
  'find . -path ./.rundock -prune -o -iregex ".*/$t*" -print',
]);

test('the recording names its base and holds lines main reads and lines it does not', () => {
  assert.match(RECORDED.recordedFrom, /^[0-9a-f]{40}$/);
  assert.ok(LINES.length > 1000, `the recording holds ${LINES.length} lines`);
  RECORDED.lines.forEach(([stored], i) => {
    const cmd = LINES[i][0];
    assert.strictEqual(typeof cmd, 'string');
    if (typeof stored === 'string') assert.ok(cmd.length <= LONGEST_AS_WRITTEN, `a line this long is stored in pieces: ${show(cmd)}`);
    else assert.ok(cmd.length > LONGEST_AS_WRITTEN, `only a long line is stored in pieces: ${show(cmd)}`);
  });
  for (const [cmd, reads, r] of LINES) {
    assert.strictEqual(typeof reads, 'boolean');
    assert.ok(['low', 'medium', 'high'].includes(r), `a risk: ${show(cmd)}`);
  }
  assert.strictEqual(new Set(LINES.map(([cmd]) => cmd)).size, LINES.length, 'each line is recorded once');
  assert.ok(LINES.some(l => l[1]) && LINES.some(l => !l[1]), 'both kinds of line are recorded');
  assert.ok(LINES.some(([cmd]) => cmd.length > 64 * 1024), 'the longest tests of the length limit are recorded too');
});

test('a command stored in pieces reads back as each text repeated its times, in order', () => {
  assert.strictEqual(decodeCommand({ pieces: [['file notes.md ', 1], ['x', 5]] }), 'file notes.md xxxxx');
  assert.strictEqual(decodeCommand({ pieces: [['rg', 1], [' x', 3], [' .', 1]] }), 'rg x x x .');
  assert.strictEqual(decodeCommand('tree -L 2'), 'tree -L 2', 'a command stored as text is that text');
  for (const damaged of [{ pieces: [] }, { pieces: [['x', 0]] }, { pieces: [['x', 1.5]] }, { pieces: [['', 3]] }, { pieces: [['x']] }, { pieces: 'x' }, null, 7]) {
    assert.throws(() => decodeCommand(damaged), /neither a string nor pieces|not \[text, times\]/, `a damaged entry is refused: ${JSON.stringify(damaged)}`);
  }
});

test('every line main does not read is still not a read, and still asks, unless it is written out as newly reading', () => {
  const loosened = LINES.filter(([cmd, reads]) => !reads && !NEWLY_READING.has(cmd)
    && (S.isReadOnlyShellCommand(cmd) !== false || risk(cmd) === 'low'));
  assert.deepStrictEqual(loosened.map(([cmd]) => show(cmd)), [], 'no line main asks about reads now, unless it is written out');
});

test('every line main grades high is still high, so it never offers Always allow', () => {
  const lowered = LINES.filter(([cmd, , r]) => r === 'high' && risk(cmd) !== 'high');
  assert.deepStrictEqual(lowered.map(([cmd]) => show(cmd)), []);
});

test('the lines the shell\'s reading alone would read are in the recording, and main asks about each', () => {
  const recorded = new Map(LINES.map(([cmd, reads]) => [cmd, reads]));
  for (const cmd of ["find . -name 'a -delete'", 'rg "x --pre" .', "find . -na'me' x", 'grep "a\\"; rm x" f']) {
    assert.strictEqual(recorded.get(cmd), false, `recorded as not a read on main: ${show(cmd)}`);
  }
});

// THE RECORDING IS HELD TO THE BASE IT NAMES, wherever history holds that
// commit: main's two graders are read from git at `recordedFrom`, as the
// recorder reads them, and every recorded verdict and risk must be what they
// return, so a row edited by hand fails here. A shallow checkout does not hold
// the commit; there this says so in one line and skips.
const ROOT = path.join(__dirname, '..', '..');
function baseGraders(commit = RECORDED.recordedFrom) {
  const git = (args, opts = {}) => execFileSync('git', args, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024, ...opts });
  try { git(['cat-file', '-e', `${commit}^{commit}`], { stdio: 'ignore' }); } catch (e) { return null; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-only-base-'));
  for (const f of ['read-only-shell.js', 'permissions.js']) fs.writeFileSync(path.join(dir, f), git(['show', `${commit}:public/${f}`]));
  return { dir, S: require(path.join(dir, 'read-only-shell.js')), P: require(path.join(dir, 'permissions.js')) };
}
const BASE = baseGraders();
after(() => { if (BASE) fs.rmSync(BASE.dir, { recursive: true, force: true }); });
const ABSENT = `the recording's base ${RECORDED.recordedFrom.slice(0, 12)} is not in this checkout, so its rows are not checked against it`;
if (!BASE) process.stderr.write(`read-only-on-main: ${ABSENT}\n`);

test('every recorded verdict and risk is what the graders at the recording\'s base return', { skip: BASE ? false : ABSENT }, () => {
  const differ = LINES.filter(([cmd, reads, r]) => BASE.S.isReadOnlyShellCommand(cmd) !== reads || BASE.P.classifyRisk('Bash', { command: cmd }) !== r);
  assert.deepStrictEqual(differ.map(([cmd]) => show(cmd)), [], 'no row differs from the base it names');
});

// EVERY LINE THAT READS NOW IS ONE WRITTEN OUT, among lines that each hold a
// quoted variable: the lines the change is for (written out again here, apart
// from the list, so a line dropped from the list is still tried), the lines
// that must still ask, every pattern primary from the module's own list in each
// reading and each writing form, and each primary find writes or runs with,
// after a quoted pattern. Each listed line is tried too, so each must read.
const PRUNED = 'find . -path ./.rundock -prune -o';
const LOOP = 'for t in alpha beta; do echo "== $t"; find . -path ./.git -prune -o -path ./.rundock -prune -o -name "$t.md" -print; done';
const SHAPES = ['find . -name "$t.md" -print', 'find notes -iname "${t}*"', 'find notes -name "$t*"',
  `${PRUNED} -name "$t.md" -print`, 'find . -path "./$d/*" -print', 'find . -regex ".*/${t}[.]md"', 'find . -lname "$t"',
  'find . -wholename "./$a/$b.md"', LOOP, `cd /home/example/Workspace && ${LOOP}`,
  "for PATH in 'x:-o:-delete'; do /usr/bin/find . -name \"$path\" -print; done"];
const STILL_ASK = ['find . -printf -name "$t" -print', 'find . -name "$t"* -print', 'find . -name "$t"{a,b} -print',
  'find . -name "$t[1]"', 'find . -name "$t:h"', 'find . -name "$t" "$u"', 'declare -n t=x; find . -name "$t"',
  'rg "$t" notes', 'tree "$t"', 'file "$t"', 'sort "$t"', 'date "$t"'];
const SPELLINGS = ['"$t"', '"$t.md"', '"${t}.md"', '".*/$t*"'];
const FORMS = [(p) => `find . ${p} -print`, (p) => `${PRUNED} ${p} -print`, (p) => `find . ${p} -delete`,
  (p) => `find . ${p} -fprint .rundock/state.json`, (p) => `find . ${p} -exec cat {} \\;`];
const WRITERS = ['-delete', '-fprint .rundock/state.json', '-fprint0 .rundock/state.json', "-fprintf .rundock/state.json '%p\\n'",
  '-fls .rundock/state.json', '-exec cat {} \\;', '-exec cat {} +', '-execdir cat {} \\;', '-ok cat {} \\;', '-okdir cat {} \\;'];
function candidates() {
  const patterns = S.namedOptions().find.patterns;
  return [...new Set([...SHAPES, ...STILL_ASK,
    ...patterns.flatMap((primary) => FORMS.flatMap((form) => SPELLINGS.map((spelling) => form(`${primary} ${spelling}`)))),
    ...WRITERS.flatMap((writer) => [`find . -name "$t" ${writer}`, `${PRUNED} -name "$t" ${writer} -print`]),
    ...NEWLY_READING])];
}

test('a line holding a quoted variable reads exactly when it is written out as newly reading', () => {
  const lines = candidates();
  assert.ok(S.namedOptions().find.patterns.length > 0, 'the module names its patterns');
  assert.ok(lines.includes('find . -name "$t" -fprint0 .rundock/state.json'), 'writing the results to the state file is tried');
  const unlisted = lines.filter((cmd) => S.isReadOnlyShellCommand(cmd) === true && !NEWLY_READING.has(cmd));
  const listedAsks = lines.filter((cmd) => S.isReadOnlyShellCommand(cmd) !== true && NEWLY_READING.has(cmd));
  assert.deepStrictEqual(unlisted.map(show), [], 'every line that reads is written out');
  assert.deepStrictEqual(listedAsks.map(show), [], 'every line written out reads');
  for (const cmd of [...STILL_ASK, ...WRITERS.map((writer) => `find . -name "$t" ${writer}`)]) {
    assert.strictEqual(S.isReadOnlyShellCommand(cmd), false, `still not a read: ${show(cmd)}`);
  }
});

// The main this reading was built on, where any `$` in a find segment makes it
// not a read. A shallow checkout does not hold it; there that half skips.
const BUILT_ON = '93159839180d1bfff8d22233b66fd2e992267e16';
const MAIN = baseGraders(BUILT_ON);
after(() => { if (MAIN) fs.rmSync(MAIN.dir, { recursive: true, force: true }); });
const QUOTED_IN_FIND = /(^|[\s;&|/])find\s[^;&|]*"[^"]*\$[A-Za-z_{][^"]*"/;

test('each line written out as newly reading holds a quoted variable in a find segment', () => {
  assert.ok(NEWLY_READING.size > 0);
  const without = [...NEWLY_READING].filter((cmd) => !QUOTED_IN_FIND.test(cmd));
  assert.deepStrictEqual(without.map(show), [], 'each is a change from main, which reads no find line holding a $');
});

test('the main this reading was built on reads none of the lines written out as newly reading',
  { skip: MAIN ? false : `${BUILT_ON.slice(0, 12)} is not in this checkout` }, () => {
    const read = [...NEWLY_READING].filter((cmd) => MAIN.S.isReadOnlyShellCommand(cmd) !== false);
    assert.deepStrictEqual(read.map(show), [], 'main read none of them');
  });
