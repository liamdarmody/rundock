'use strict';
// Which shell commands change their crossing answer between the base commit
// and the hook in the working tree, for three readings of an inline script: a
// piece joined by `+` onto a name given one plain string, a word starting with
// two backslashes in Bash on macOS and Linux, and Python's `%` formatting.
//
//   node test/tools/inline-script-answer-moves.js [--base <ref>] [--tests] [--check]
//
// The base defaults to the merge base of HEAD and origin/main. Its hook is read
// from git and compiled at the hook's own path, so the modules it requires are
// the working tree's, which these readings do not change. Every command up to
// a kibibyte long that test/fixtures/read-only-on-main.json records, and the
// lines named below, are classified by both hooks with classifyShellAccess in
// Notes mode and in Code mode, and the answers compared. The made-up workspace
// sits outside every temp folder, as the Code-mode suites' does, because Code
// mode lets a command write in a temp folder: set RUNDOCK_TEST_OUTSIDE_TEMP_ROOT
// if /var/tmp is not writable. With --tests, every existing test file that
// calls classifyShellAccess is run as well, with each call it makes answered
// by both hooks (inline-script-answer-moves-preload.js); calls made inside a
// hook a test starts as its own process are not counted.
//
// It prints how many answers move and every command whose answer moves,
// grouped by the shape it holds. With --check it exits 1 unless:
//   - every answer that moves holds one of the three shapes;
//   - no answer gains a crossing: each place the head names, the base named;
//   - every named line meant to move does, and runs with no crossing;
//   - every named line that must still ask is, at both commits, a write
//     outside to the place the whole line writes (or, for a shell startup
//     file, that file's own card), with nothing to grant;
//   - no recorded line left unclassified holds what a reading looks at.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const HOOK = path.join(ROOT, 'scripts', 'permission-hook.js');
const PRELOAD = path.join(__dirname, 'inline-script-answer-moves-preload.js');

// The hook as a source text, compiled at its own path.
function hookFromSource(src) {
  const m = new Module(HOOK, null);
  m.filename = HOOK;
  // @ts-ignore: a private, stable helper of the module loader
  m.paths = Module._nodeModulePaths(path.dirname(HOOK));
  // @ts-ignore
  m._compile(src, HOOK);
  return m.exports;
}

// The shapes these readings are for, and what every other move is.
const SHAPES = [
  ['a piece joined by +', /["'`]\s*\+|\+\s*["'`]/],
  ['a word starting with two backslashes', /\\\\/],
  ["Python's % formatting", /%\s*\(/],
];
const shapeOf = (command) => (SHAPES.find(([, re]) => re.test(command)) || ['another shape'])[0];

// The places an answer names, from its JSON, or null for an answer that is
// not a crossing check's (a throw).
const placesOf = (json) => {
  if (json.startsWith('threw')) return null;
  const r = JSON.parse(json);
  return r ? r.crossings.map(c => c.path) : [];
};
const gains = (was, now) => {
  const before = placesOf(was);
  const after = placesOf(now);
  if (!before || !after) return was !== now;
  return after.some(p => !before.includes(p));
};

function main() {
  const fx = require('../helpers/code-mode-fixture.js');
  const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
  const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const base = arg('--base') || git(['merge-base', 'HEAD', 'origin/main']).trim();
  const baseSha = git(['rev-parse', '--short=8', base]).trim();
  const headSha = git(['rev-parse', '--short=8', 'HEAD']).trim();
  const changed = spawnSync('git', ['diff', '--quiet', 'HEAD', '--', 'scripts/permission-hook.js'], { cwd: ROOT }).status !== 0;
  const baseSrc = git(['show', `${base}:scripts/permission-hook.js`]);
  const A = hookFromSource(baseSrc);
  const B = require(HOOK);

  const outside = fx.outsideTempRoot({ quiet: true });
  if (!outside.dir) {
    console.error(`No folder outside every temp folder and git tree: ${outside.skip}`);
    process.exit(2);
  }
  const tmp = outside.dir;
  const home = path.join(tmp, 'home');
  const ws = path.join(home, 'Workspace');
  fs.mkdirSync(path.join(ws, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'notes', 'a.md'), 'one\n\ntwo\n');
  const real = (p) => B.canonicalize(p);
  const py = (...l) => `python3 - <<'EOF'\n${l.join('\n')}\nEOF`;
  const MOVES = [
    py('import sys', `V = "${ws}"`, 'sys.path.insert(0, V + "/etc/tools/lib")', 'print(open(V + "/notes/a.md").read())'),
    py('t = open("notes/a.md").read()', "parts = t.split('\\\\n\\\\n')", 'print(len(parts))'),
    py('t = open("notes/a.md").read()', 'a, b = 0, len(t)', 'print("%d" % (100*(b-a)/len(t)))'),
  ];
  // Each with the place the whole line writes.
  const KEPT = [
    [py(`H = "${home}"`, 'open(H + "/.ssh/config", "a").write("x")'), path.join(home, '.ssh', 'config')],
    [py(`H = "${home}"`, 'open(H + "/Library/LaunchAgents/x.plist", "w").write("x")'), path.join(home, 'Library', 'LaunchAgents', 'x.plist')],
    [py(`V = "${ws}"`, 'V = "/"', 'open(V + "/etc/x", "w").write("x")'), real('/etc/x')],
    [`python3 - "${ws}" <<'EOF'\nimport sys\nV = sys.argv[1]\nopen(V + "/etc/x", "w").write("x")\nEOF`, real('/etc/x')],
    [py('import os', 'V = os.environ["X"]', 'open(V + "/etc/x", "w").write("x")'), real('/etc/x')],
    [py('V = input()', 'open(V + "/etc/x", "w").write("x")'), real('/etc/x')],
    [py('def save():', `    V = "${ws}"`, '    open(V + "/etc/x", "w").write("x")', 'save()'), real('/etc/x')],
    [py(`V = "${ws}"`, 'V += "/../.."', 'open(V + "/etc/x", "w").write("x")'), real('/etc/x')],
    [py(`V = "${ws}"`, 'open(V + "/../../etc/x", "w").write("x")'), real(path.resolve(ws, '../../etc/x'))],
    [py('t = "x"', 'print("%d" % (1/len(t)))', 'open("/etc/x", "w").write("x")'), real('/etc/x')],
    ['echo x >> ~/.zshrc', path.join(home, '.zshrc')],
  ];
  const { recordedLines } = require('../helpers/read-only-on-main.js');
  const all = recordedLines().map(([command]) => command);
  // A recorded line longer than a kibibyte is a test of the read-only
  // reading's own length limit, a short text repeated thousands of times, and
  // the crossing check takes seconds to minutes on each at both commits. Such
  // a line is not classified, and is held instead to having none of the text
  // any of the three readings looks at: a `+`, a backslash, a `%`, or a `q`
  // quote word before a bracket. Without them neither answer can move.
  const LONGEST = 1024;
  const TRIGGERS = /[+\\%]|\bq[qxw]?\s*[([{<]/;
  const long = all.filter(c => c.length > LONGEST);
  const recorded = all.filter(c => c.length <= LONGEST);
  const lines = [...new Set([...recorded, ...MOVES, ...KEPT.map(([c]) => c)])];
  const answer = (h, command, codeMode) => {
    try { return JSON.stringify(h.classifyShellAccess('Bash', { command }, ws, [], home, false, { codeMode })); } catch (e) { return `threw: ${e && e.message}`; }
  };

  const moved = [];
  const answers = new Map();
  let compared = 0;
  for (const command of lines) {
    for (const codeMode of [false, true]) {
      compared++;
      const was = answer(A, command, codeMode);
      const now = answer(B, command, codeMode);
      answers.set(`${codeMode}:${command}`, [was, now]);
      if (was !== now) moved.push({ command, mode: codeMode ? 'Code' : 'Notes', was, now, from: 'lines' });
    }
  }

  let testCalls = 0;
  let testFiles = 0;
  let testSummary = '';
  if (process.argv.includes('--tests')) {
    const files = git(['grep', '-l', 'classifyShellAccess', '--', 'test/unit']).split('\n').filter(f => f && f !== 'test/unit/inline-script-readings.test.js');
    testFiles = files.length;
    const dir = fs.mkdtempSync(path.join(tmp, 'calls-'));
    const baseFile = path.join(tmp, 'hook-at-base.js');
    fs.writeFileSync(baseFile, baseSrc);
    const run = countedRun(spawnSync(process.execPath, ['--test', '--require', './test/helpers/account-home-refused.js', '--require', PRELOAD, ...files], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, RUNDOCK_INLINE_MOVES: dir, RUNDOCK_INLINE_MOVES_BASE: baseFile },
    }));
    testSummary = String(run.stdout).split('\n').filter(l => /^ℹ (tests|pass|fail) /.test(l)).map(l => l.slice(2)).join(', ');
    for (const f of fs.readdirSync(dir)) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      if (f.endsWith('.calls')) { testCalls += Number(text); continue; }
      for (const row of text.split('\n')) if (row) { const r = JSON.parse(row); moved.push({ command: r.command, mode: '', was: r.base, now: r.head, from: 'tests' }); }
    }
    if (!testCalls) throw new Error('no call was counted: did the preload load?');
  }
  fs.rmSync(tmp, { recursive: true, force: true });

  // This machine's folders are written as placeholders, so the output names
  // nobody's home: the made-up workspace, its home and its root, and the temp
  // folder the tests make their own under.
  const temps = [...new Set([fs.realpathSync(os.tmpdir()), os.tmpdir()])].sort((a, b) => b.length - a.length);
  const scrub = (text) => temps.reduce((t, d) => t.split(d).join('<tmp>'), text.split(ws).join('<ws>').split(home).join('<home>').split(tmp).join('<root>'));
  const show = (text) => { const line = scrub(text); return JSON.stringify(line.length > 120 ? `${line.slice(0, 120)}...` : line); };
  const out = [`base ${baseSha}, head ${headSha}${changed ? ' with the hook changed in the working tree' : ''}`];
  out.push(`${compared} answers from ${lines.length} lines (${recorded.length} recorded, ${MOVES.length + KEPT.length} named), each in Notes and Code mode: ${moved.filter(m => m.from === 'lines').length} move`);
  const triggered = long.filter(c => TRIGGERS.test(c));
  out.push(`${long.length} recorded lines longer than ${LONGEST} characters not classified: ${triggered.length} of them hold a +, a backslash, a % or a q quote word`);
  const recordedSet = new Set(recorded);
  out.push(`recorded lines that move: ${new Set(moved.filter(m => m.from === 'lines' && recordedSet.has(m.command)).map(m => m.command)).size}`);
  if (process.argv.includes('--tests')) out.push(`${testCalls} calls from ${testFiles} existing test files (${testSummary || 'no summary'}): ${moved.filter(m => m.from === 'tests').length} move`);
  const gained = moved.filter(m => gains(m.was, m.now));
  out.push(`answers that gain a crossing: ${gained.length}`);
  const byShape = new Map();
  for (const m of moved) {
    const s = shapeOf(m.command);
    if (!byShape.has(s)) byShape.set(s, []);
    byShape.get(s).push(m);
  }
  for (const [s, list] of byShape) {
    out.push(`  ${s}: ${list.length}`);
    for (const m of list) {
      const was = placesOf(m.was);
      const now = placesOf(m.now);
      const lost = was && now ? was.filter(p => !now.includes(p)) : [];
      out.push(`    ${m.from}${m.mode ? ` (${m.mode})` : ''}  ${show(m.command)}`);
      out.push(`      loses ${show(lost.join(', ') || '(nothing)')}${now && now.length ? `, keeps ${show(now.join(', '))}` : ', no crossing left'}`);
    }
  }

  const wrong = [];
  for (const m of moved) if (shapeOf(m.command) === 'another shape') wrong.push(`moves, and holds none of the shapes: ${show(m.command)}`);
  for (const m of gained) wrong.push(`gains a crossing: ${show(m.command)}`);
  for (const line of triggered) wrong.push(`not classified, and holds what a reading looks at: ${show(line)}`);
  out.push('named lines meant to move, at the head:');
  for (const line of MOVES) {
    for (const codeMode of [false, true]) {
      const [was, now] = answers.get(`${codeMode}:${line}`);
      out.push(`  ${codeMode ? 'Code ' : 'Notes'}  ${show(line)}: ${now === 'null' ? 'no crossing' : now}`);
      if (was === now || now !== 'null') wrong.push(`meant to move to no crossing, does not (${codeMode ? 'Code' : 'Notes'} mode): ${show(line)}`);
    }
  }
  out.push('named lines that must still ask, at both commits:');
  for (const [line, want] of KEPT) {
    for (const codeMode of [false, true]) {
      const pair = answers.get(`${codeMode}:${line}`);
      const ok = pair.every(json => {
        const r = json.startsWith('threw') ? null : JSON.parse(json);
        return r && r.where === 'outside' && r.grantable === false && r.crossings.some(c => c.path === want && (c.write === true || c.answerFile === true));
      });
      out.push(`  ${codeMode ? 'Code ' : 'Notes'}  ${ok ? 'a write outside to the place it writes' : 'NOT a write outside to the place it writes'}${pair[0] === pair[1] ? '' : ' (its answer moves)'}  ${show(line)}`);
      if (!ok) wrong.push(`must still ask, and does not (${codeMode ? 'Code' : 'Notes'} mode): ${show(line)}`);
    }
  }
  console.log(out.join('\n'));

  if (process.argv.includes('--check')) {
    if (wrong.length) {
      console.error(`\ncheck failed:\n  ${wrong.join('\n  ')}`);
      process.exit(1);
    }
    console.log('\ncheck: every answer that moves holds one of the three shapes and gains no crossing; every named line is where it is meant to be');
  }
}

// A run of the tests whose calls are counted: one that failed, was stopped or
// never started may have made only some of them, so its count is not taken.
function countedRun(run) {
  if (run.error || run.signal || run.status !== 0) {
    const tail = String(run.stdout || '').split('\n').filter(l => /^ℹ (tests|pass|fail) /.test(l)).join(', ');
    throw new Error(`the test run did not finish cleanly (${run.error ? run.error.message : run.signal || `exit ${run.status}`}${tail ? `; ${tail}` : ''})`);
  }
  return run;
}

module.exports = { hookFromSource, countedRun };
if (require.main === module) main();
