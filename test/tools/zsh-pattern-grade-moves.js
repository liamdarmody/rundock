'use strict';
// Which shell lines change their Notes-mode grade between two commits, for the
// rule that grades a `(` inside a word, outside quotes, high.
//
//   node test/tools/zsh-pattern-grade-moves.js [--base <ref>] [--head <ref>] [--check]
//
// The base defaults to the merge base of HEAD and origin/main, the head to
// HEAD. The graders, public/read-only-shell.js and public/permissions.js, are
// read from git at each commit and run in a fresh context of their own, so the
// working tree is never read and nothing is written. The lines graded are every
// command the read-only tests judge, as test/fixtures/read-only-on-main.json
// records them, and the lines this change names: the ones meant to move and
// the ones meant to keep their grade.
//
// It prints how many lines go from each grade to each grade, every line that
// moves, grouped by the shape of its word, and each named line's grade at both
// commits. With --check it exits 1 unless every line that moves goes to high
// and is one the view at the head marks, every line meant to move does, and
// every line meant to keep its grade keeps it.
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { recordedLines } = require('../helpers/read-only-on-main.js');

const ROOT = path.join(__dirname, '..', '..');

// Meant to move to high: the shapes the rule is for, and a function
// definition, which puts a `(` inside a word too (Code mode already asks).
const MOVES = [
  "ls 'a'*(e:'cp x ~/.claude/settings.json':)",
  'cat =(cp x ~/.claude/settings.json)',
  "echo $(ls *(e:'cp x ~/.claude/settings.json':))",
  'ls x(+cleanup)',
  'f() { echo hi; }; f',
];
// Meant to keep their grade: a bracket that starts a word, or one in quotes.
const KEPT = [
  'arr=(a b c)', 'echo "$(date)"', 'x=$(git rev-parse HEAD)', 'grep -E "(a|b)" notes/a.md',
  'find . \\( -name a -o -name b \\)', '(cd src && ls)', 'node -e "f()"', 'echo $((1+2))',
  'diff <(ls a) <(ls b)', "git commit -m \"$(cat <<'EOF'\nRead the line (both readings)\n\nIt's quoted.\nEOF\n)\"",
  'ls *.md',
];

// The shape of the word that carries the mark, for the groups printed.
const SHAPES = [
  ['a function definition', /(^|[;&|{]\s*)[A-Za-z_][\w-]*\(\)/],
  ["zsh's =( )", /(^|[\s;&|(])=\(/],
  ['a glob qualifier', /\((e:|e\{|\+|#q)/],
];
const shapeOf = (line) => (SHAPES.find(([, re]) => re.test(line)) || ['another word pattern'])[0];

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
}
const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });

// The graders as they stand at a commit, loaded the way a page loads them.
function gradersAt(ref) {
  const page = { self: {} };
  vm.createContext(page);
  for (const f of ['read-only-shell.js', 'permissions.js']) {
    vm.runInContext(git(['show', `${ref}:public/${f}`]), page, { filename: `${ref}:public/${f}` });
  }
  return { grade: (command) => page.self.RundockPermissions.classifyRisk('Bash', { command }), view: page.self.RundockReadOnlyShell.shellView };
}

const head = arg('--head') || 'HEAD';
const base = arg('--base') || git(['merge-base', head, 'origin/main']).trim();
const baseSha = git(['rev-parse', '--short=8', base]).trim();
const headSha = git(['rev-parse', '--short=8', head]).trim();
const A = gradersAt(base);
const B = gradersAt(head);

const recorded = recordedLines().map(([command]) => command);
const lines = [...new Set([...recorded, ...MOVES, ...KEPT])];
const show = (line) => JSON.stringify(line.length > 100 ? `${line.slice(0, 100)}...` : line);

const counts = new Map();
const moved = [];
for (const line of lines) {
  const from = A.grade(line);
  const to = B.grade(line);
  const k = `${from} -> ${to}`;
  counts.set(k, (counts.get(k) || 0) + 1);
  if (from !== to) moved.push({ line, from, to });
}

const out = [];
out.push(`base ${baseSha}, head ${headSha}`);
out.push(`${lines.length} lines: ${recorded.length} recorded, ${MOVES.length + KEPT.length} named, ${recorded.length + MOVES.length + KEPT.length - lines.length} in both`);
out.push('');
for (const [k, n] of [...counts].sort()) out.push(`${k}: ${n}`);
out.push('');
const recordedSet = new Set(recorded);
out.push(`${moved.length} lines move, ${moved.filter((m) => recordedSet.has(m.line)).length} of them recorded:`);
const byShape = new Map();
for (const m of moved) {
  const s = shapeOf(m.line);
  if (!byShape.has(s)) byShape.set(s, []);
  byShape.get(s).push(m);
}
for (const [s, list] of [...byShape].sort((x, y) => y[1].length - x[1].length || x[0].localeCompare(y[0]))) {
  out.push(`  ${s}: ${list.length}`);
  for (const m of list) out.push(`    ${m.from} -> ${m.to}  ${show(m.line)}${recordedSet.has(m.line) ? '' : '  (named)'}`);
}
out.push('');
out.push('named lines, base -> head:');
for (const line of [...MOVES, ...KEPT]) out.push(`  ${A.grade(line)} -> ${B.grade(line)}  ${show(line)}${MOVES.includes(line) ? '  (meant to move)' : ''}`);
console.log(out.join('\n'));

if (process.argv.includes('--check')) {
  const wrong = [];
  for (const m of moved) {
    if (m.to !== 'high') wrong.push(`moves to ${m.to}, not high: ${show(m.line)}`);
    if (B.view(m.line).wordParen === false) wrong.push(`moves with no mark from the view: ${show(m.line)}`);
  }
  for (const line of MOVES) if (B.grade(line) !== 'high') wrong.push(`meant to move to high, is ${B.grade(line)}: ${show(line)}`);
  for (const line of KEPT) if (A.grade(line) !== B.grade(line)) wrong.push(`meant to keep its grade, ${A.grade(line)} -> ${B.grade(line)}: ${show(line)}`);
  if (wrong.length) {
    console.error(`\ncheck failed:\n  ${wrong.join('\n  ')}`);
    process.exit(1);
  }
  console.log('\ncheck: every line that moves goes to high and is marked by the view; every named line is where it is meant to be');
}
