'use strict';
// The hands-on check from source, recorded as a sign-off keyed by the tree.
//
// Before the cut, the candidate is started from source and tried by hand;
// `release -- signoff <version> --confirm <version>` records that for the
// tree that was tried, and `release -- tag` refuses any other tree. A
// sign-off given in chat is recorded by the agent it was given to, with
// `--on-instruction` carrying the words verbatim: on stdin with `-`, the
// printed form, or inline. These tests run the real functions against a
// throwaway repository: what is asserted is the record git's common directory
// holds afterwards, or that nothing was written.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const {
  signoffRelease, requireSignoff, readSignoff, askAtTerminal, SIGNOFF_FILE_NAME,
} = require('../../scripts/release.js');

let dir;
let work;

const git = (cwd) => (args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const treeOf = (cwd) => git(cwd)(['rev-parse', 'HEAD^{tree}']).trim();
const recordFile = () => path.join(work, '.git', SIGNOFF_FILE_NAME);

// Everything a person at a terminal supplies, with each piece overridable.
function signoff(version, overrides = {}) {
  return signoffRelease(version, {
    root: work,
    argv: ['node', 'release.js', 'signoff', version, '--confirm', version],
    env: {},
    ask: () => 'tried the list, all fine',
    now: () => new Date('2026-10-08T12:00:00Z'),
    log: () => {},
    readStdin: () => { throw new Error('stdin is read only for --on-instruction -'); },
    stdinIsTerminal: () => false,
    notice: () => {},
    ...overrides,
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-signoff-'));
  work = path.join(dir, 'work');
  fs.mkdirSync(work);
  const g = git(work);
  g(['init', '--initial-branch=main']);
  g(['config', 'user.email', 'release-test@example.com']);
  g(['config', 'user.name', 'Release Test']);
  g(['config', 'commit.gpgsign', 'false']);
  g(['config', 'core.hooksPath', '/dev/null']);
  fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'rundock', version: '0.12.0' }, null, 2) + '\n');
  g(['add', '-A']);
  g(['commit', '-m', 'Release 0.12.0']);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test('records the tree, the version, the time and the note, outside the working tree', () => {
  let asked = 0;
  const record = signoff('0.12.0', { ask: () => { asked += 1; return 'tried the list, all fine'; } });

  assert.strictEqual(asked, 1, 'it asks one thing: the optional note');
  assert.deepStrictEqual(record, { given: 'terminal', tree: treeOf(work), version: '0.12.0', signedAt: '2026-10-08T12:00:00.000Z', note: 'tried the list, all fine' });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(recordFile(), 'utf8')), record);
  assert.strictEqual(git(work)(['status', '--porcelain']).trim(), '', 'the record never shows up as a change');
  assert.strictEqual(requireSignoff(treeOf(work), '0.12.0', { root: work }), 'terminal');
});

// What an agent's shell looks like: inside an agent session, with no
// controlling terminal to type at.
const AGENT = { CLAUDECODE: '1' };
const noTerminal = () => askAtTerminal('Note: ', { open: () => { throw Object.assign(new Error('Device not configured'), { code: 'ENXIO' }); } });
const onInstruction = (version, words) => ['node', 'release.js', 'signoff', version, '--confirm', version, '--on-instruction', words];
// The form every refusal prints: the words on stdin, through a here-document
// whose quoted delimiter keeps the shell from expanding anything in them.
const PRINTED = /--on-instruction - <<'END_OF_SIGNOFF_WORDS'\n<their words>\nEND_OF_SIGNOFF_WORDS/;
// Words a shell would mangle in double quotes: substitution, expansion,
// quotes of both kinds, a backslash, a tab and more than one line, one of
// them a plausible here-document delimiter typed on its own.
const AWKWARD = [
  'sign off 0.12.0: `date` and $(whoami) and $HOME and ${PATH} stay as typed',
  '"double" and \'single\' quotes, a back\\slash, a tab\there,',
  'WORDS',
  '-- a line starting with dashes, café included ',
].join('\n');

test('given in chat: from an agent session with no terminal, --on-instruction records the tree and the words verbatim', () => {
  const words = 'sign off 0.12.0\nthe "pins" fix looked right, café included ';
  let asked = 0;
  const said = [];
  const record = signoff('0.12.0', {
    env: AGENT, argv: onInstruction('0.12.0', words), ask: () => { asked += 1; return noTerminal(); }, log: (step, msg) => said.push(msg),
  });

  assert.strictEqual(asked, 0, 'nothing is asked: there is no one at a terminal to ask');
  assert.deepStrictEqual(record, { given: 'chat', instruction: words, tree: treeOf(work), version: '0.12.0', signedAt: '2026-10-08T12:00:00.000Z' });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(recordFile(), 'utf8')), record);
  assert.strictEqual(git(work)(['status', '--porcelain']).trim(), '', 'the words stay in the local record and never show up as a change');
  assert.strictEqual(requireSignoff(treeOf(work), '0.12.0', { root: work }), 'chat');
  // What it prints says what was recorded, claims no hands-on check, and
  // never repeats the words.
  assert.deepStrictEqual(said, [`Recorded a sign-off given in chat for 0.12.0 on tree ${treeOf(work).slice(0, 12)}`]);
  for (const piece of ['sign off 0.12.0', 'pins', 'café']) assert.ok(said.every((l) => !l.includes(piece)), piece);
});

test('given in chat on stdin: `--on-instruction -` reads all of it, less the newline a here-document ends with', () => {
  for (const [stdin, words] of [[`${AWKWARD}\n`, AWKWARD], [AWKWARD, AWKWARD], ['--looks like a flag, and is fine here\n', '--looks like a flag, and is fine here']]) {
    fs.rmSync(recordFile(), { force: true });
    const said = [];
    const record = signoff('0.12.0', { env: AGENT, ask: noTerminal, argv: onInstruction('0.12.0', '-'), readStdin: () => stdin, log: (step, msg) => said.push(msg) });
    assert.strictEqual(record.instruction, words);
    assert.strictEqual(readSignoff({ root: work }).instruction, words);
    assert.ok(said.every((l) => !l.includes('date') && !l.includes('flag')), 'the words are never printed');
  }
});

test('with a terminal on stdin, `--on-instruction -` is refused rather than waited on, naming the here-document', () => {
  // A terminal would hold the read open until Ctrl-D, with nothing on screen
  // to say so. The seam stands in for a real terminal, which a test cannot
  // count on having.
  let reads = 0;
  const said = [];
  assert.throws(() => signoff('0.12.0', {
    env: AGENT, ask: noTerminal, argv: onInstruction('0.12.0', '-'),
    stdinIsTerminal: () => true, readStdin: () => { reads += 1; return 'sign off 0.12.0\n'; }, notice: (line) => said.push(line),
  }), (err) => /reads the words until the input ends, and stdin here is a terminal/.test(err.message) && PRINTED.test(err.message));
  assert.strictEqual(reads, 0, 'nothing was read');
  assert.deepStrictEqual(said, [], 'and no read was announced');
  assert.ok(!fs.existsSync(recordFile()), 'nothing recorded');
});

test('a read from stdin is announced on its own line before it starts', () => {
  const events = [];
  signoff('0.12.0', {
    env: AGENT, ask: noTerminal, argv: onInstruction('0.12.0', '-'),
    notice: (line) => events.push(`notice: ${line}`), readStdin: () => { events.push('read'); return 'sign off 0.12.0\n'; },
  });
  assert.deepStrictEqual(events, ['notice: Reading the sign-off words from stdin until the input ends', 'read']);
});

test('given in chat, --on-instruction with no visible words is refused, and nothing is recorded', () => {
  const invisible = ' \t\u200B\u200C\u200D\u2060\uFEFF\u00A0';
  for (const tail of [['--on-instruction'], ['--on-instruction', ''], ['--on-instruction', '   '], ['--on-instruction', invisible]]) {
    const argv = ['node', 'release.js', 'signoff', '0.12.0', '--confirm', '0.12.0', ...tail];
    assert.throws(() => signoff('0.12.0', { env: AGENT, ask: noTerminal, argv }), /--on-instruction needs[\s\S]*verbatim[\s\S]*--on-instruction - <<'END_OF_SIGNOFF_WORDS'/, JSON.stringify(argv));
  }
  for (const stdin of ['', '\n', `${invisible}\n`]) {
    assert.throws(() => signoff('0.12.0', { env: AGENT, ask: noTerminal, argv: onInstruction('0.12.0', '-'), readStdin: () => stdin }), /--on-instruction needs/, JSON.stringify(stdin));
  }
  assert.ok(!fs.existsSync(recordFile()), 'nothing recorded');
});

test('given in chat, the forms that would record something other than the words given are refused, naming the form to use', () => {
  const cases = [
    // Inline words that begin with "--" read as the next flag.
    [['--on-instruction', '--confirm', '0.12.0'], /cannot begin with "--"[\s\S]*stdin/],
    [['--on-instruction', '--sign off'], /cannot begin with "--"[\s\S]*stdin/],
    // An "=" form the shell would have split, quoted or not.
    [['--on-instruction=sign off 0.12.0'], /never after "="/],
    // Two instructions, of which the record could hold only one.
    [['--on-instruction', 'sign off', '--on-instruction', 'no, wait'], /given 2 times/],
  ];
  for (const [tail, why] of cases) {
    const argv = ['node', 'release.js', 'signoff', '0.12.0', '--confirm', '0.12.0', ...tail];
    assert.throws(() => signoff('0.12.0', { env: AGENT, ask: noTerminal, argv }), (err) => why.test(err.message) && PRINTED.test(err.message), JSON.stringify(tail));
  }
  assert.ok(!fs.existsSync(recordFile()), 'nothing recorded');
});

test('through a real shell, the words survive verbatim on stdin and single-quoted inline', () => {
  // The real function in a real process, reading the real argv and stdin,
  // started by /bin/sh exactly as the documented commands are written.
  const RELEASE = path.join(__dirname, '..', '..', 'scripts', 'release.js');
  const driver = path.join(dir, 'signoff-driver.js');
  fs.writeFileSync(driver, [
    `const { signoffRelease } = require(${JSON.stringify(RELEASE)});`,
    'const record = signoffRelease(process.argv[2], {',
    '  root: process.env.SIGNOFF_ROOT, env: { CLAUDECODE: "1" }, log: () => {},',
    '  ask: () => { throw Object.assign(new Error("no terminal"), { code: "ENXIO" }); },',
    '});',
    'process.stdout.write(JSON.stringify(record));',
  ].join('\n'));
  // Single quotes, with a ' inside written '\'' : the rule the docs give.
  const q = (text) => `'${text.replace(/'/g, "'\\''")}'`;
  const sh = (script) => spawnSync('/bin/sh', ['-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH, SIGNOFF_ROOT: work, SIGNOFF_PROBE: 'expanded' } });
  const command = `${q(process.execPath)} ${q(driver)} 0.12.0 --confirm 0.12.0 --on-instruction`;

  // The here-document exactly as a refusal prints it, with the words put in
  // its placeholder: a line of the words that matched the delimiter would
  // end it early, cut the record short and run the rest as commands.
  let printed = '';
  try { signoff('0.12.0', { env: AGENT }); } catch (err) { printed = err.message.slice(err.message.indexOf('npm run release -- signoff')); }
  assert.match(printed, /<<'([A-Z_]+)'\n<their words>\n\1$/, 'a here-document with a quoted delimiter');
  const script = printed
    .replace('npm run release -- signoff 0.12.0 --confirm 0.12.0 --on-instruction', () => command)
    .replace('<their words>', () => AWKWARD);
  const viaStdin = sh(`${script}\n`);
  assert.strictEqual(viaStdin.status, 0, viaStdin.stderr);
  assert.strictEqual(JSON.parse(viaStdin.stdout).instruction, AWKWARD);
  assert.strictEqual(readSignoff({ root: work }).instruction, AWKWARD);

  fs.rmSync(recordFile());
  const inline = sh(`${command} ${q(AWKWARD)}`);
  assert.strictEqual(inline.status, 0, inline.stderr);
  assert.strictEqual(JSON.parse(inline.stdout).instruction, AWKWARD);
  assert.strictEqual(readSignoff({ root: work }).instruction, AWKWARD);

  // Why the docs never show double quotes: the shell rewrites the words first.
  const doubled = sh(`${command} "sign off, $SIGNOFF_PROBE"`);
  assert.strictEqual(doubled.status, 0, doubled.stderr);
  assert.strictEqual(JSON.parse(doubled.stdout).instruction, 'sign off, expanded');
});

test('given in chat, --confirm must still name the version, and the tree and version checks still apply', () => {
  const words = 'sign off 0.12.0';
  for (const argv of [
    ['node', 'release.js', 'signoff', '0.12.0', '--on-instruction', words],
    ['node', 'release.js', 'signoff', '0.12.0', '--confirm', '0.11.9', '--on-instruction', words],
  ]) {
    assert.throws(() => signoff('0.12.0', { env: AGENT, ask: noTerminal, argv }), /--confirm[\s\S]*signoff 0\.12\.0 --confirm 0\.12\.0/, argv.join(' '));
  }
  fs.writeFileSync(path.join(work, 'README.md'), 'uncommitted\n');
  assert.throws(() => signoff('0.12.0', { env: AGENT, ask: noTerminal, argv: onInstruction('0.12.0', words) }), /not clean/);
  fs.rmSync(path.join(work, 'README.md'));
  assert.throws(() => signoff('0.12.1', { env: AGENT, ask: noTerminal, argv: onInstruction('0.12.1', words) }), /0\.12\.0, not 0\.12\.1/);
  assert.ok(!fs.existsSync(recordFile()), 'nothing recorded');
});

test('the tag check accepts either kind for exactly its tree, and neither for another', () => {
  signoff('0.12.0', { env: AGENT, ask: noTerminal, argv: onInstruction('0.12.0', 'sign off 0.12.0') });
  const tried = treeOf(work);
  assert.strictEqual(requireSignoff(tried, '0.12.0', { root: work }), 'chat');
  fs.writeFileSync(path.join(work, 'README.md'), 'a fix after the sign-off\n');
  git(work)(['add', '-A']);
  git(work)(['commit', '-m', 'fix']);
  assert.throws(() => requireSignoff(treeOf(work), '0.12.0', { root: work }), new RegExp(`signed off on tree ${tried.slice(0, 12)}[\\s\\S]*${treeOf(work).slice(0, 12)}`));
});

test('a record written before sign-offs said how they were given reads as one typed at the terminal', () => {
  fs.writeFileSync(recordFile(), JSON.stringify({ tree: treeOf(work), version: '0.12.0', signedAt: '2026-10-01T09:00:00Z', note: 'fine' }));
  assert.strictEqual(requireSignoff(treeOf(work), '0.12.0', { root: work }), 'terminal');
});

test('a record of a kind this command never writes is refused, naming the command', () => {
  for (const odd of [{ given: 'email' }, { given: 'chat' }, { given: 'chat', instruction: '  ' }, { given: 'chat', instruction: '\u200B\uFEFF\n' }]) {
    fs.writeFileSync(recordFile(), JSON.stringify({ tree: treeOf(work), version: '0.12.0', signedAt: '2026-10-01T09:00:00Z', ...odd }));
    assert.throws(() => requireSignoff(treeOf(work), '0.12.0', { root: work }), /not one this command writes[\s\S]*signoff 0\.12\.0 --confirm 0\.12\.0/, JSON.stringify(odd));
  }
});

test('an empty note is no note, and the sign-off still records', () => {
  const record = signoff('0.12.0', { ask: () => '' });
  assert.ok(!('note' in record));
  assert.strictEqual(readSignoff({ root: work }).tree, treeOf(work));
});

test('a sign-off made in a worktree on the release branch is seen by the checkout that tags', () => {
  const wt = path.join(dir, 'release-wt');
  git(work)(['worktree', 'add', '-b', 'release/0.12.0', wt]);
  signoff('0.12.0', { root: wt });
  assert.strictEqual(readSignoff({ root: work }).tree, treeOf(wt));
  assert.doesNotThrow(() => requireSignoff(treeOf(work), '0.12.0', { root: work }));
});

test('--confirm is required, and must name the version being signed off', () => {
  for (const argv of [
    ['node', 'release.js', 'signoff', '0.12.0'],
    ['node', 'release.js', 'signoff', '0.12.0', '--confirm'],
    ['node', 'release.js', 'signoff', '0.12.0', '--confirm', '0.11.9'],
  ]) {
    assert.throws(() => signoff('0.12.0', { argv }), /--confirm naming the version being signed off:[\s\S]*signoff 0\.12\.0 --confirm 0\.12\.0/, argv.join(' '));
  }
  assert.ok(!fs.existsSync(recordFile()), 'nothing recorded');
});

test('a sign-off typed at the terminal says what it recorded, and claims nothing more', () => {
  const said = [];
  signoff('0.12.0', { log: (step, msg) => said.push(msg) });
  assert.deepStrictEqual(said, [`Recorded a sign-off typed at the terminal for 0.12.0 on tree ${treeOf(work).slice(0, 12)}`]);
});

test('inside an agent session, without --on-instruction, it is refused, printing the stdin form, and nothing is recorded', () => {
  assert.throws(() => signoff('0.12.0', { env: AGENT }), (err) => /agent session[\s\S]*yourself, at a terminal\.\nIf it was given to you in chat/.test(err.message) && PRINTED.test(err.message));
  assert.ok(!fs.existsSync(recordFile()));
});

test('with no terminal to type at, without --on-instruction, it is refused, printing the stdin form, and nothing is recorded', () => {
  assert.throws(() => signoff('0.12.0', { ask: noTerminal }), (err) => /typed at a terminal[\s\S]*ENXIO[\s\S]*yourself, at a terminal\.\nIf it was given to you in chat/.test(err.message) && PRINTED.test(err.message));
  assert.ok(!fs.existsSync(recordFile()));
});

test('the note is one line read from the terminal it was asked at', () => {
  const tty = path.join(dir, 'tty');
  // A file stands in for the terminal: the question overwrites the blank
  // space it starts with, and the answer is read from where the question
  // ended, the way a terminal echoes and then reads.
  fs.writeFileSync(tty, `${' '.repeat('Note: '.length)}looked right, café included\nnot this line\n`);
  const note = askAtTerminal('Note: ', { open: () => fs.openSync(tty, 'r+') });
  assert.strictEqual(note, 'looked right, café included');
  assert.match(fs.readFileSync(tty, 'utf8'), /^Note: looked/, 'the question went to the terminal');
});

test('a dirty tree, or a checkout at another version, is refused', () => {
  fs.writeFileSync(path.join(work, 'README.md'), 'uncommitted\n');
  assert.throws(() => signoff('0.12.0'), /not clean/);
  fs.rmSync(path.join(work, 'README.md'));
  assert.throws(() => signoff('0.12.1', { argv: ['node', 'release.js', 'signoff', '0.12.1', '--confirm', '0.12.1'] }), /0\.12\.0, not 0\.12\.1/);
  assert.ok(!fs.existsSync(recordFile()));
});

test('the tag check: no record, or one for another tree, is refused, naming both kinds and what a sign-off records', () => {
  // Both refusals say in words that a sign-off given in chat is recorded with
  // --on-instruction, and neither prints a ready command for it: that is
  // recorded only when a sign-off was actually given.
  const noReadyChatCommand = (message) => !/<<'|<their words>/.test(message);
  assert.throws(() => requireSignoff(treeOf(work), '0.12.0', { root: work }), (err) =>
    /^No sign-off found for tree [0-9a-f]{12}\. A sign-off records the hands-on check/.test(err.message)
    && /release summary calls for one/.test(err.message)
    && /at a terminal: npm run release -- signoff 0\.12\.0 --confirm 0\.12\.0\n/.test(err.message)
    && /given in chat is recorded by the agent it was given to, with --on-instruction and the words verbatim, and only when it was actually given/.test(err.message)
    && noReadyChatCommand(err.message));
  signoff('0.12.0');
  const tried = treeOf(work);
  fs.writeFileSync(path.join(work, 'README.md'), 'a fix after the check\n');
  git(work)(['add', '-A']);
  git(work)(['commit', '-m', 'fix']);
  assert.throws(() => requireSignoff(treeOf(work), '0.12.0', { root: work }), (err) =>
    new RegExp(`signed off on tree ${tried.slice(0, 12)}[\\s\\S]*${treeOf(work).slice(0, 12)}`).test(err.message)
    && /at a terminal \(npm run release -- signoff 0\.12\.0 --confirm 0\.12\.0\)/.test(err.message)
    && /given in chat, with --on-instruction/.test(err.message)
    && /hands-on check again where the release summary calls for one/.test(err.message)
    && noReadyChatCommand(err.message));
});

test('the command line refuses a missing --confirm, an agent session, and an empty instruction, before touching git', () => {
  const RELEASE = path.join(__dirname, '..', '..', 'scripts', 'release.js');
  const cli = (args, env, input = '') => {
    const res = spawnSync(process.execPath, [RELEASE, ...args], { encoding: 'utf8', input, env: { PATH: process.env.PATH, ...env } });
    return { code: res.status, out: `${res.stdout}${res.stderr}` };
  };
  const unconfirmed = cli(['signoff', '0.12.0'], {});
  assert.strictEqual(unconfirmed.code, 1);
  assert.match(unconfirmed.out, /--confirm/);
  const agent = cli(['signoff', '0.12.0', '--confirm', '0.12.0'], { CLAUDECODE: '1' });
  assert.strictEqual(agent.code, 1);
  assert.match(agent.out, /agent session/);
  // Printed from column 0, so the here-document's closing line still closes it.
  assert.match(agent.out, /\nnpm run release -- signoff 0\.12\.0 --confirm 0\.12\.0 --on-instruction - <<'END_OF_SIGNOFF_WORDS'\n<their words>\nEND_OF_SIGNOFF_WORDS\n/);
  const empty = cli(['signoff', '0.12.0', '--confirm', '0.12.0', '--on-instruction', ''], { CLAUDECODE: '1' });
  assert.strictEqual(empty.code, 1);
  assert.match(empty.out, /--on-instruction needs/);
  const emptyStdin = cli(['signoff', '0.12.0', '--confirm', '0.12.0', '--on-instruction', '-'], { CLAUDECODE: '1' }, '\n');
  assert.strictEqual(emptyStdin.code, 1);
  assert.match(emptyStdin.out, /\[release:signoff\] Reading the sign-off words from stdin until the input ends\n/);
  assert.match(emptyStdin.out, /--on-instruction needs/);
  const equals = cli(['signoff', '0.12.0', '--confirm', '0.12.0', '--on-instruction=sign off'], { CLAUDECODE: '1' });
  assert.strictEqual(equals.code, 1);
  assert.match(equals.out, /never after "="/);
});
