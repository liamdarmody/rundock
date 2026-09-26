'use strict';
// The pre-push leak scan (scripts/hooks/pre-push, scripts/leak-scan.js) run by
// git itself, in a throwaway repository pushing to a throwaway bare remote.
// The private term is invented.

const { test, describe, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const { addedLines } = require('../../scripts/leak-scan.js');

const ROOT = path.join(__dirname, '..', '..');
const TERM = 'Zorblat';
const NOREPLY = ['1+t', 'users.noreply.github.com'].join('@');

describe('addedLines', () => {
  test('reads added lines with their new line numbers, and never removed ones', () => {
    const diff = [
      'diff --git a/n.md b/n.md', '--- a/n.md', '+++ b/n.md',
      '@@ -3,0 +4,2 @@', '+four', '+five',
      '@@ -9 +10,0 @@', '-gone',
      'diff --git a/old.md b/old.md', '--- a/old.md', '+++ /dev/null', '@@ -1 +0,0 @@', '-bye',
    ].join('\n');
    assert.deepStrictEqual(addedLines(diff), [
      { file: 'n.md', line: 4, text: 'four' },
      { file: 'n.md', line: 5, text: 'five' },
    ]);
  });
});

describe('pre-push hook', () => {
  let dir; let work; let env;
  const git = (...args) => execFileSync('git', args, { cwd: work, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const push = () => spawnSync('git', ['push', 'origin', 'HEAD:refs/heads/topic'], { cwd: work, env, encoding: 'utf8' });
  const commitFile = (name, body, msg) => { fs.writeFileSync(path.join(work, name), body); git('add', name); git('commit', '-q', '-m', msg); };

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leak-push-'));
    work = path.join(dir, 'work');
    const list = path.join(dir, 'denylist.txt');
    fs.writeFileSync(list, `[person]\n${TERM}\n`);
    env = { ...process.env, RUNDOCK_PRIVATE_DENYLIST: list, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: NOREPLY, GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: NOREPLY };
    delete env.CI;
    execFileSync('git', ['init', '-q', '--bare', path.join(dir, 'remote.git')]);
    execFileSync('git', ['init', '-q', work]);
    for (const f of ['personal-data.js', 'private-denylist.js', 'leak-scan.js', 'hooks/pre-push']) {
      fs.mkdirSync(path.join(work, 'scripts', path.dirname(f)), { recursive: true });
      fs.copyFileSync(path.join(ROOT, 'scripts', f), path.join(work, 'scripts', f));
    }
    fs.chmodSync(path.join(work, 'scripts/hooks/pre-push'), 0o755);
    git('config', 'core.hooksPath', 'scripts/hooks');
    git('remote', 'add', 'origin', path.join(dir, 'remote.git'));
    git('add', '.');
    git('commit', '-q', '-m', 'Start');
  });

  test('a clean new branch pushes', () => {
    commitFile('a.md', 'plain text\n', 'Add a note');
    const r = push();
    assert.strictEqual(r.status, 0, r.stderr);
  });

  test('a private term in an added line blocks, naming commit, file and class, masked', () => {
    commitFile('b.md', `one\nmet ${TERM} today\n`, 'Add another note');
    const sha = git('rev-parse', '--short=7', 'HEAD').trim();
    const r = push();
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, new RegExp(`${sha} b\\.md:2 +\\[private person\\]`));
    assert.ok(!r.stderr.includes(TERM), r.stderr);
    assert.ok(!r.stdout.includes(TERM), r.stdout);
  });

  test('removing the line in a later commit does not unblock the earlier one', () => {
    commitFile('b.md', 'one\n', 'Remove it');
    assert.notStrictEqual(push().status, 0);
  });

  test('a signed-off place in the private list lets that file through, by repository and path', () => {
    fs.appendFileSync(env.RUNDOCK_PRIVATE_DENYLIST, `[client]\nQuennly  !^work/thanks\\.md$\n`);
    commitFile('thanks.md', 'Quennly said yes\n', 'Add thanks');
    commitFile('other.md', 'Quennly again\n', 'Add other');
    const r = push();
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /other\.md:1 +\[private client\]/);
    assert.doesNotMatch(r.stderr, /thanks\.md/);
    git('reset', '-q', '--hard', 'HEAD~2');
  });

  test('a private term in a commit message blocks', () => {
    git('reset', '-q', '--hard', 'HEAD~2');
    commitFile('c.md', 'fine\n', `Thanks to ${TERM}`);
    const r = push();
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /commit message:1 +\[private person\]/);
  });

  test('once the unpushed commits are clean, the push goes through', () => {
    git('commit', '-q', '--amend', '-m', 'Add a clean note');
    assert.strictEqual(push().status, 0);
  });

  test('an author or committer address other than a GitHub noreply blocks', () => {
    const personal = ['someone', 'example.com'].join('@');
    fs.writeFileSync(path.join(work, 'd.md'), 'fine\n');
    git('add', 'd.md');
    execFileSync('git', ['commit', '-q', '-m', 'Add d'], { cwd: work, env: { ...env, GIT_AUTHOR_EMAIL: personal } });
    const r = push();
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /commit author:-? +\[commit identity/);
    assert.doesNotMatch(r.stderr, /commit committer/);
    assert.ok(!r.stderr.includes(personal), r.stderr);
  });
});
