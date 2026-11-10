'use strict';
// Records how main graded every shell command the read-only tests judge, so
// the reading of options can be held to asking wherever main asked.
//
//   node test/tools/record-read-only-on-main.js
//
// Run once and committed. Only this script writes the fixture,
// test/fixtures/read-only-on-main.json, which test/unit/read-only-on-main.test.js
// reads. Three steps:
//
//   1. Run every test file that judges shell commands (the files that name the
//      read-only definition or the card grader's risk), with a preload
//      (record-read-only-on-main-preload.js) that notes every text handed to
//      isReadOnlyShellCommand or isDestructiveShellCommand, in each test
//      process and in every hook those tests start. That is every command the
//      tests judge, the forms they generate from the module's own lists
//      included. Whether the tests pass does not matter here.
//   2. Put this machine's own folders back as placeholders, so the file is the
//      same on every machine and names nobody's home, and rename a fixture's
//      own folder called home or Users, so no path reads as a person's home.
//   3. Grade each line with public/read-only-shell.js and public/permissions.js
//      as they stood at BASE, read from git, and write each line with main's
//      verdict: whether it reads, and its risk. A line longer than a kibibyte
//      is a test of the reading's own length limit, a short text repeated
//      thousands of times (three are a megabyte each), so it is written in
//      pieces (test/helpers/read-only-on-main.js reads them): each piece is a
//      text and how many times it repeats. Every line written in pieces is
//      read back before anything is written, and one that does not read back
//      as exactly the line stops the recording. The repository's personal-data
//      check is then run over the file that would be written and over every
//      line as it reads back, and any finding stops the recording too.
//
// Needs a folder outside every temp folder and git working tree, as the tests
// do: set RUNDOCK_TEST_OUTSIDE_TEMP_ROOT if /var/tmp is not writable.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { scanPersonal, PLACEHOLDER_NAMES } = require('../../scripts/personal-data.js');
const { decodeCommand, LONGEST_AS_WRITTEN } = require('../helpers/read-only-on-main.js');

// The merge base the options reading was built on.
const BASE = '7a23656a22306859b540d5ff321d0ed9cb3805cc';
const REPO = path.join(__dirname, '..', '..');
const OUT = path.join(REPO, 'test', 'fixtures', 'read-only-on-main.json');
const PRELOAD = path.join(__dirname, 'record-read-only-on-main-preload.js');
const JUDGES_COMMANDS = /isReadOnlyShellCommand|read-only-shell\.js|classifyRisk\(/;
// A repeat is written as one piece when its text is at most LONGEST_UNIT
// characters and the repeats cover at least SHORTEST_RUN of them.
const LONGEST_UNIT = 256;
const SHORTEST_RUN = 64;

const git = (args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

function testFiles() {
  const dir = path.join(REPO, 'test', 'unit');
  return fs.readdirSync(dir).filter(f => f.endsWith('.test.js') && f !== 'read-only-on-main.test.js')
    .filter(f => JUDGES_COMMANDS.test(fs.readFileSync(path.join(dir, f), 'utf8')))
    .sort().map(f => path.join('test', 'unit', f));
}

function recordLines(files, linesDir) {
  const env = { ...process.env, RUNDOCK_RECORD_SHELL_LINES: linesDir,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require ${JSON.stringify(PRELOAD)}`].filter(Boolean).join(' ') };
  const run = spawnSync(process.execPath, ['--test', '--test-timeout=300000', '--require', './test/helpers/account-home-refused.js', ...files],
    { cwd: REPO, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const summary = String(run.stdout).split('\n').filter(l => /^ℹ (tests|pass|fail) /.test(l));
  console.log(`ran ${files.length} test files: ${summary.join(', ') || 'no summary'}`);
  const lines = new Set();
  for (const f of fs.readdirSync(linesDir)) {
    for (const row of fs.readFileSync(path.join(linesDir, f), 'utf8').split('\n')) if (row) lines.add(JSON.parse(row));
  }
  if (!lines.size) throw new Error('no command was recorded: did the preload load?');
  return lines;
}

// Each folder this machine names, longest first, and what it is written as.
function placeholders() {
  const outside = process.env.RUNDOCK_TEST_OUTSIDE_TEMP_ROOT || '/var/tmp';
  const pairs = [];
  const add = (p, name) => {
    if (!p) return;
    for (const v of new Set([p, (() => { try { return fs.realpathSync(p); } catch { return p; } })()])) {
      if (v.length > 1) pairs.push([v.replace(/\/+$/, ''), name]);
    }
  };
  add(REPO, '/repo');
  add(outside, '/outside');
  add(os.tmpdir(), '/temp');
  add(os.homedir(), '/home/user');
  return pairs.sort((a, b) => b[0].length - a[0].length);
}
// A folder made with mkdtemp ends in six random characters, and some name
// the process that made them; both are written the same way every time. Every
// folder the tests make sits under the temporary or the outside folder, so
// each name there ending in a dash and six letters or digits is taken for one,
// whatever case its letters happen to be.
function steady(line) {
  return line.replace(/(\/(?:outside|temp))((?:\/[^\s'"\\/;|&<>()`*?]+)+)/g, (all, root, rest) => root + rest
    .split('/').map(c => c.replace(/-p\d+-[A-Za-z0-9]{6}$/, '-p0-XXXXXX').replace(/-[A-Za-z0-9]{6}$/, '-XXXXXX')).join('/'));
}
function scrub(lines) {
  const pairs = placeholders();
  const out = new Set();
  for (const line of lines) {
    let s = line;
    for (const [real, name] of pairs) s = s.split(real).join(name);
    // A fixture world keeps its own folder called home, holding the fixture's
    // Projects and Workspace folders: no one's home, and written so.
    out.add(steady(s).replace(/\/(Users|home)\/([A-Za-z0-9._-]+)\//g, (m, top, name) => PLACEHOLDER_NAMES.has(name) ? m : `/${top}-dir/${name}/`));
  }
  const user = os.userInfo().username;
  const named = [...out].filter(l => pairs.some(([real]) => l.includes(real)) || (user.length > 2 && l.includes(user)));
  if (named.length) throw new Error(`${named.length} lines still name this machine, the first: ${JSON.stringify(named[0].slice(0, 200))}`);
  return [...out].sort();
}

// A line as pieces: from each point, the text that repeats over the most of
// what follows is one piece, with its count, and what repeats too little is
// gathered into a piece that appears once. Any split would read back, and
// the caller checks that this one does.
function inPieces(line) {
  const pieces = [];
  let once = '';
  let i = 0;
  while (i < line.length) {
    let best = null;
    for (let unit = 1; unit <= LONGEST_UNIT && i + 2 * unit <= line.length; unit++) {
      const text = line.slice(i, i + unit);
      let times = 1;
      while (line.startsWith(text, i + times * unit)) times++;
      if (times >= 2 && unit * times >= SHORTEST_RUN && (!best || unit * times > best.unit * best.times)) best = { unit, times, text };
      if (best && i + best.unit * best.times === line.length) break;
    }
    if (!best) { once += line[i]; i++; continue; }
    if (once) pieces.push([once, 1]);
    once = '';
    pieces.push([best.text, best.times]);
    i += best.unit * best.times;
  }
  if (once) pieces.push([once, 1]);
  return { pieces };
}
function asStored(line) {
  if (line.length <= LONGEST_AS_WRITTEN) return line;
  const stored = inPieces(line);
  if (decodeCommand(stored) !== line) throw new Error(`a line written in pieces does not read back as itself, so nothing was written: ${JSON.stringify(line.slice(0, 200))}`);
  return stored;
}

function mainGraders(dir) {
  for (const f of ['read-only-shell.js', 'permissions.js']) fs.writeFileSync(path.join(dir, f), git(['show', `${BASE}:public/${f}`]));
  return { S: require(path.join(dir, 'read-only-shell.js')), P: require(path.join(dir, 'permissions.js')) };
}

function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'read-only-on-main-'));
  try {
    const linesDir = path.join(work, 'lines');
    const mainDir = path.join(work, 'main');
    fs.mkdirSync(linesDir);
    fs.mkdirSync(mainDir);
    const corpus = scrub(recordLines(testFiles(), linesDir));
    const { S, P } = mainGraders(mainDir);
    const rows = corpus.map(cmd => [cmd, S.isReadOnlyShellCommand(cmd) === true, P.classifyRisk('Bash', { command: cmd })]);
    const stored = rows.map(([cmd, reads, risk]) => [asStored(cmd), reads, risk]);
    const body = stored.map(r => '    ' + JSON.stringify(r)).join(',\n');
    const text = `{\n  "recordedFrom": ${JSON.stringify(BASE)},\n  "row": ["command", "reads on main", "risk on main"],\n  "lines": [\n${body}\n  ]\n}\n`;
    const label = path.relative(REPO, OUT);
    const findings = [...scanPersonal(label, text), ...scanPersonal(label, corpus.join('\n'))];
    if (findings.length) throw new Error(`the recording would carry personal data (${findings.length} findings, the first: ${findings[0].label} on line ${findings[0].line}); nothing was written`);
    fs.writeFileSync(OUT, text);
    const asks = rows.filter(r => !r[1]).length;
    const inPiecesCount = stored.filter(r => typeof r[0] !== 'string').length;
    console.log(`recorded ${rows.length} lines, ${asks} of them not a read on main, ${inPiecesCount} written in pieces, ${text.length} characters, to ${path.relative(process.cwd(), OUT)}`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main();
