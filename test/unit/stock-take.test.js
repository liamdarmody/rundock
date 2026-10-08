'use strict';
// The stock-take names every branch config section whose branch is gone, and
// prints one command that removes exactly those; with none it prints nothing
// for that step. When its plan removes the last linked worktree it says so and
// the same command recreates .git/worktrees. It changes nothing itself.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { parseBranchSections, parseWorktrees, gather, plan, report } = require('../../scripts/stock-take.js');

const COMMON = '/work/repo/.git';
const facts = (over = {}) => ({
  commonDir: COMMON,
  base: 'origin/main',
  worktrees: [
    { path: '/work/repo', branch: 'main', head: 'a', main: true, dirty: 0, unpushed: 0 },
    { path: '/work/lanes/keep', branch: 'feat/keep', head: 'b', dirty: 2, unpushed: 0 },
  ],
  branches: [
    { name: 'main', merged: true, unpushed: 0 },
    { name: 'feat/keep', merged: false, unpushed: 3 },
  ],
  sections: ['main', 'feat/keep'],
  ...over,
});

describe('stale branch sections, from a fixture config', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-take-'));
  const config = path.join(dir, 'config');
  fs.writeFileSync(config, [
    '[core]', '\tbare = false',
    '[branch "main"]', '\tremote = origin', '\tmerge = refs/heads/main',
    '[branch "feat/gone.v2"]', '\tremote = origin', '\tmerge = refs/heads/feat/gone.v2',
    '[branch "fix/also-gone"]', '\tremote = origin',
    '[remote "origin"]', '\turl = https://example.com/repo.git',
    '',
  ].join('\n'));
  const listed = execFileSync('git', ['config', '--file', config, '--name-only', '--get-regexp', '^branch\\.'], { encoding: 'utf8' });

  test('the config is read section by section, a dotted branch name kept whole', () => {
    assert.deepStrictEqual(parseBranchSections(listed), ['main', 'feat/gone.v2', 'fix/also-gone']);
  });

  test('each stale section is named, and one command removes exactly those', () => {
    const f = facts({ sections: parseBranchSections(listed), branches: [{ name: 'main', merged: true, unpushed: 0 }, { name: 'feat/keep', merged: false, unpushed: 3 }] });
    const p = plan(f);
    assert.deepStrictEqual(p.staleSections.map((s) => s.name), ['feat/gone.v2', 'fix/also-gone']);
    assert.strictEqual(p.command,
      `git config --file ${COMMON}/config --remove-section branch.feat/gone.v2 && ` +
      `git config --file ${COMMON}/config --remove-section branch.fix/also-gone`);
    const text = report(f, p);
    assert.match(text, /\[branch "feat\/gone\.v2"\] {2}its branch no longer exists/);
    assert.ok(text.includes(`  ${p.command}`));
  });

  test('the command really removes those sections and nothing else', () => {
    const copy = path.join(dir, 'config-copy');
    fs.copyFileSync(config, copy);
    const p = plan(facts({ commonDir: dir, sections: parseBranchSections(listed) }));
    for (const part of p.command.split(' && ')) {
      const args = part.split(' ').slice(1).map((a) => (a === path.join(dir, 'config') ? copy : a));
      execFileSync('git', args);
    }
    const after = execFileSync('git', ['config', '--file', copy, '--list'], { encoding: 'utf8' });
    assert.match(after, /branch\.main\.remote=origin/);
    assert.match(after, /remote\.origin\.url=/);
    assert.match(after, /core\.bare=false/);
    assert.doesNotMatch(after, /gone/);
  });

  test('with no stale sections, nothing is printed for this step', () => {
    const f = facts();
    const p = plan(f);
    assert.deepStrictEqual(p.staleSections, []);
    assert.strictEqual(p.command, null);
    const text = report(f, p);
    assert.doesNotMatch(text, /config sections|For a person to run|remove-section|mkdir/);
  });
});

describe('the plan', () => {
  test('a worktree with uncommitted work or commits on no remote is kept, and so is its branch', () => {
    const p = plan(facts());
    assert.deepStrictEqual(p.removableWorktrees, []);
    assert.deepStrictEqual(p.removableBranches, []);
  });

  test('a branch checked out nowhere but with commits on no remote is kept', () => {
    const p = plan(facts({ branches: [{ name: 'main', merged: true, unpushed: 0 }, { name: 'feat/keep', merged: false, unpushed: 3 }, { name: 'feat/unsaved', merged: false, unpushed: 1 }] }));
    assert.deepStrictEqual(p.removableBranches, []);
  });

  test('a removable branch takes its config section with it', () => {
    const p = plan(facts({
      branches: [{ name: 'main', merged: true, unpushed: 0 }, { name: 'feat/keep', merged: false, unpushed: 3 }, { name: 'feat/done', merged: true, unpushed: 0 }],
      sections: ['main', 'feat/done'],
    }));
    assert.deepStrictEqual(p.removableBranches.map((b) => b.name), ['feat/done']);
    assert.deepStrictEqual(p.staleSections, [{ name: 'feat/done', why: 'its branch is removed by this plan' }]);
  });

  test('removing the last linked worktree is said, and the command recreates .git/worktrees', () => {
    const f = facts({
      worktrees: [
        { path: '/work/repo', branch: 'main', head: 'a', main: true, dirty: 0, unpushed: 0 },
        { path: '/work/lanes/done', branch: 'feat/done', head: 'c', dirty: 0, unpushed: 0 },
      ],
      branches: [{ name: 'main', merged: true, unpushed: 0 }, { name: 'feat/done', merged: true, unpushed: 0 }],
      sections: ['main'],
    });
    const p = plan(f);
    assert.strictEqual(p.removesLastWorktree, true);
    assert.strictEqual(p.command, `mkdir ${COMMON}/worktrees`);
    assert.match(report(f, p), /This plan removes the last linked worktree/);
  });

  test('keeping one linked worktree needs no mkdir', () => {
    assert.strictEqual(plan(facts()).removesLastWorktree, false);
  });

  test('a name with shell characters is quoted', () => {
    const p = plan(facts({ sections: ['main', "odd name's"] }));
    assert.ok(p.command.endsWith(`--remove-section 'branch.odd name'\\''s'`), p.command);
  });
});

test('on a real repository it lists, plans and changes nothing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-take-repo-'));
  const origin = path.join(root, 'origin.git');
  const repo = path.join(root, 'repo');
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(root, 'init', '--bare', '-q', '-b', 'main', origin);
  git(root, 'init', '-q', '-b', 'main', repo);
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['commit.gpgsign', 'false']]) git(repo, 'config', k, v);
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'base');
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'fetch', '-q', 'origin');
  git(repo, 'branch', 'feat/done');
  git(repo, 'branch', 'feat/local');
  git(repo, 'worktree', 'add', '-q', path.join(root, 'lane'), 'feat/local');
  git(path.join(root, 'lane'), 'commit', '-q', '--allow-empty', '-m', 'local only');
  git(repo, 'config', 'branch.feat/gone.remote', 'origin');
  const configBefore = fs.readFileSync(path.join(repo, '.git', 'config'), 'utf8');

  const f = gather(repo);
  const p = plan(f);
  assert.strictEqual(f.worktrees.length, 2);
  assert.strictEqual(f.worktrees[1].unpushed, 1);
  assert.deepStrictEqual(p.removableWorktrees, []);
  assert.deepStrictEqual(p.removableBranches.map((b) => b.name), ['feat/done']);
  assert.deepStrictEqual(p.staleSections.map((s) => s.name), ['feat/gone']);
  assert.strictEqual(p.removesLastWorktree, false);
  assert.strictEqual(fs.readFileSync(path.join(repo, '.git', 'config'), 'utf8'), configBefore, 'read-only');
  assert.deepStrictEqual(git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').trim().split('\n').sort(),
    ['feat/done', 'feat/local', 'main']);
});

test('worktree records parse, detached and prunable included', () => {
  const list = parseWorktrees('worktree /a\nHEAD 1\nbranch refs/heads/main\n\nworktree /b\nHEAD 2\ndetached\nprunable gitdir file points to non-existent location\n');
  assert.deepStrictEqual(list, [{ path: '/a', head: '1', branch: 'main' }, { path: '/b', head: '2', branch: null, prunable: true }]);
});
