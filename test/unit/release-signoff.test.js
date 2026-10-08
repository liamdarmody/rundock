'use strict';
// The hands-on check from source, recorded as a sign-off keyed by the tree.
//
// Before the cut, the candidate is started from source and tried by hand;
// `release -- signoff <version> --confirm <version>` records that for the
// tree that was tried, and `release -- tag` refuses any other tree. These
// tests run the real functions against a throwaway repository: what is
// asserted is the record git's common directory holds afterwards, or that
// nothing was written.

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
  assert.deepStrictEqual(record, { tree: treeOf(work), version: '0.12.0', signedAt: '2026-10-08T12:00:00.000Z', note: 'tried the list, all fine' });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(recordFile(), 'utf8')), record);
  assert.strictEqual(git(work)(['status', '--porcelain']).trim(), '', 'the record never shows up as a change');
  assert.doesNotThrow(() => requireSignoff(treeOf(work), '0.12.0', { root: work }));
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
    assert.throws(() => signoff('0.12.0', { argv }), /--confirm[\s\S]*signoff 0\.12\.0 --confirm 0\.12\.0/, argv.join(' '));
  }
  assert.ok(!fs.existsSync(recordFile()), 'nothing recorded');
});

test('inside an agent session it is refused, and nothing is recorded', () => {
  assert.throws(() => signoff('0.12.0', { env: { CLAUDECODE: '1' } }), /agent session/);
  assert.ok(!fs.existsSync(recordFile()));
});

test('with no terminal to type at, it is refused, and nothing is recorded', () => {
  const noTerminal = () => askAtTerminal('Note: ', { open: () => { throw Object.assign(new Error('Device not configured'), { code: 'ENXIO' }); } });
  assert.throws(() => signoff('0.12.0', { ask: noTerminal }), /typed at a terminal[\s\S]*ENXIO/);
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

test('the tag check: no record names the command; a record for another tree is refused', () => {
  assert.throws(() => requireSignoff(treeOf(work), '0.12.0', { root: work }), /No hands-on sign-off[\s\S]*npm run release -- signoff 0\.12\.0 --confirm 0\.12\.0/);
  signoff('0.12.0');
  const tried = treeOf(work);
  fs.writeFileSync(path.join(work, 'README.md'), 'a fix after the check\n');
  git(work)(['add', '-A']);
  git(work)(['commit', '-m', 'fix']);
  assert.throws(() => requireSignoff(treeOf(work), '0.12.0', { root: work }), new RegExp(`signed off on tree ${tried.slice(0, 12)}[\\s\\S]*${treeOf(work).slice(0, 12)}`));
});

test('the command line refuses a missing --confirm, and an agent session, before touching git', () => {
  const RELEASE = path.join(__dirname, '..', '..', 'scripts', 'release.js');
  const cli = (args, env) => {
    const res = spawnSync(process.execPath, [RELEASE, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
    return { code: res.status, out: `${res.stdout}${res.stderr}` };
  };
  const unconfirmed = cli(['signoff', '0.12.0'], {});
  assert.strictEqual(unconfirmed.code, 1);
  assert.match(unconfirmed.out, /--confirm/);
  const agent = cli(['signoff', '0.12.0', '--confirm', '0.12.0'], { CLAUDECODE: '1' });
  assert.strictEqual(agent.code, 1);
  assert.match(agent.out, /agent session/);
});
