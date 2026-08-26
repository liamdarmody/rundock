'use strict';
// The two halves of a release cut, exercised against a real repository.
//
// Why the split exists: `main` requires status checks with admin enforcement,
// so a release step that pushes straight to `main` cannot complete. It bumped
// the version, promoted the changelog, committed, and died on the rejected
// push. The bump now travels through a pull request like any other change, and
// the tag is a second command run after that pull request has merged.
//
// These tests build a throwaway repository with a real bare origin in a temp
// directory and run the real functions against it, so the assertions are about
// what git actually holds afterwards rather than about which commands were
// called. The one thing stubbed is the pull request creation, which is the
// only step that would reach GitHub.

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { prepareRelease } = require('../../scripts/release.js');
const { GATE_FILE_NAME } = require('../../scripts/release-gate.js');

const CHANGELOG = `# Changelog

## Unreleased

**Name:** Foundations

### Fixed

- A user visible fix.

## 0.11.8: Previous Release (2026-08-20)

- Older notes.
`;

let dir;
let origin;
let work;

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// A git runner bound to one repository, matching the shape the release steps
// take as an option.
function gitAt(root) {
  return (args) => run('git', args, root);
}

const inWork = (args) => gitAt(work)(args).trim();
const inOrigin = (args) => gitAt(origin)(args).trim();

// Records every call and reports success, standing in for `gh pr create`.
function fakeGh(result = 'https://github.com/liamdarmody/rundock/pull/999\n') {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (result instanceof Error) throw result;
    return result;
  };
  gh.calls = calls;
  return gh;
}

function writeGateRecord(sha, { live = true } = {}) {
  fs.writeFileSync(path.join(work, GATE_FILE_NAME), JSON.stringify({
    sha, live, passedAt: '2026-08-26T09:00:00Z', wallClockSeconds: 900, steps: [],
  }));
}

function gateOnHead() {
  writeGateRecord(inWork(['rev-parse', 'HEAD']));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-flow-'));
  origin = path.join(dir, 'origin.git');
  work = path.join(dir, 'work');

  run('git', ['init', '--bare', '--initial-branch=main', origin], dir);
  run('git', ['init', '--initial-branch=main', work], dir);
  const git = gitAt(work);
  git(['config', 'user.email', 'release-test@example.com']);
  git(['config', 'user.name', 'Release Test']);
  git(['config', 'commit.gpgsign', 'false']);

  fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'rundock', version: '0.11.8' }, null, 2) + '\n');
  fs.writeFileSync(path.join(work, 'CHANGELOG.md'), CHANGELOG);
  // The gate record is ignored in the real repository, and has to be here too:
  // an untracked file makes the tree dirty, which the preflight refuses.
  fs.writeFileSync(path.join(work, '.gitignore'), `${GATE_FILE_NAME}\n`);
  git(['add', '-A']);
  git(['commit', '-m', 'initial']);
  git(['remote', 'add', 'origin', origin]);
  git(['push', '-u', 'origin', 'main']);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('release:prepare puts the version bump through a pull request', () => {
  test('no gate record: refuses before touching anything', () => {
    const gh = fakeGh();
    const mainBefore = inOrigin(['rev-parse', 'main']);

    assert.throws(() => prepareRelease('0.12.0', { root: work, gh, log: () => {} }), /release:gate/);

    assert.strictEqual(inOrigin(['rev-parse', 'main']), mainBefore, 'origin/main untouched');
    assert.strictEqual(inWork(['status', '--porcelain']), '', 'working tree untouched');
    assert.strictEqual(gh.calls.length, 0, 'no pull request attempted');
  });

  test('a gate record for another commit: refuses, naming both commits', () => {
    writeGateRecord('deadbeefcafe');
    assert.throws(
      () => prepareRelease('0.12.0', { root: work, gh: fakeGh(), log: () => {} }),
      /deadbeefcafe/
    );
  });

  test('a gate record without live smoke: refuses', () => {
    writeGateRecord(inWork(['rev-parse', 'HEAD']), { live: false });
    assert.throws(
      () => prepareRelease('0.12.0', { root: work, gh: fakeGh(), log: () => {} }),
      /live/i
    );
  });

  test('main receives no commit at all: the bump lands only on the release branch', () => {
    gateOnHead();
    const mainBefore = inOrigin(['rev-parse', 'main']);
    const localMainBefore = inWork(['rev-parse', 'main']);

    prepareRelease('0.12.0', { root: work, gh: fakeGh(), log: () => {} });

    assert.strictEqual(inOrigin(['rev-parse', 'main']), mainBefore, 'origin/main did not move');
    assert.strictEqual(inWork(['rev-parse', 'main']), localMainBefore, 'local main did not move');
    assert.strictEqual(
      inOrigin(['rev-parse', 'refs/heads/release/0.12.0']),
      inWork(['rev-parse', 'HEAD']),
      'the release branch is pushed and matches the local branch'
    );
  });

  test('nothing is tagged: tagging is the second command, after the merge', () => {
    gateOnHead();
    prepareRelease('0.12.0', { root: work, gh: fakeGh(), log: () => {} });

    assert.strictEqual(inWork(['tag', '-l']), '', 'no local tag');
    assert.strictEqual(inOrigin(['tag', '-l']), '', 'no tag on the remote');
  });

  test('the branch commit carries the bump and the promoted changelog heading', () => {
    gateOnHead();
    prepareRelease('0.12.0', { root: work, gh: fakeGh(), log: () => {} });

    const pkg = JSON.parse(inOrigin(['show', 'refs/heads/release/0.12.0:package.json']));
    assert.strictEqual(pkg.version, '0.12.0');

    const changelog = gitAt(origin)(['show', 'refs/heads/release/0.12.0:CHANGELOG.md']);
    assert.match(changelog, /^## 0\.12\.0: Foundations \(\d{4}-\d{2}-\d{2}\)$/m, 'heading promoted and named');
    assert.ok(!/^## Unreleased\s*$/m.test(changelog), 'the Unreleased heading is gone');
    assert.ok(!/\*\*Name:\*\*/.test(changelog), 'the Name line is consumed by the heading');

    const touched = inWork(['show', '--name-only', '--format=', 'HEAD']).split('\n').filter(Boolean).sort();
    assert.deepStrictEqual(touched, ['CHANGELOG.md', 'package.json'], 'the release commit touches nothing else');
  });

  test('the pull request targets main from the release branch', () => {
    gateOnHead();
    const gh = fakeGh();
    const result = prepareRelease('0.12.0', { root: work, gh, log: () => {} });

    assert.strictEqual(gh.calls.length, 1, 'exactly one pull request');
    const args = gh.calls[0];
    assert.deepStrictEqual(args.slice(0, 2), ['pr', 'create']);
    assert.strictEqual(args[args.indexOf('--base') + 1], 'main');
    assert.strictEqual(args[args.indexOf('--head') + 1], 'release/0.12.0');
    assert.match(result.pullRequest, /pull\/999/, 'the pull request URL is reported back');
  });

  test('the pull request text says the version, the gated commit, and what runs next', () => {
    gateOnHead();
    const gatedSha = inWork(['rev-parse', 'HEAD']);
    const gh = fakeGh();
    prepareRelease('0.12.0', { root: work, gh, log: () => {} });

    const args = gh.calls[0];
    const title = args[args.indexOf('--title') + 1];
    const body = args[args.indexOf('--body') + 1];
    assert.match(title, /0\.12\.0/);
    assert.match(body, /0\.12\.0/);
    assert.ok(body.includes(gatedSha.slice(0, 9)), 'the gated commit is named');
    assert.match(body, /npm run release -- tag 0\.12\.0/, 'the next command is spelled out');
    assert.match(body, /CHANGELOG\.md/, 'the promoted entry is linked');
  });

  test('the pull request text reads as public project writing', () => {
    // Whatever this script posts under the project name is held to the same
    // rules as anything committed: no em or en dashes, no session links, no
    // generator byline, and no text addressing the person who runs it as a
    // third party.
    gateOnHead();
    const gh = fakeGh();
    prepareRelease('0.12.0', { root: work, gh, log: () => {} });
    const args = gh.calls[0];
    const text = `${args[args.indexOf('--title') + 1]}\n${args[args.indexOf('--body') + 1]}`;

    // Written as escapes so the check that scans this repository for the same
    // characters does not match the assertion looking for them.
    assert.ok(!/[\u2014\u2013]/.test(text), 'no em or en dashes');
    assert.ok(!/claude\.ai|Claude-Session|Generated with/i.test(text), 'no session link or generator byline');
    assert.ok(!/\bLiam\b|\bthe owner\b|\bthe maintainer\b/i.test(text), 'nobody is addressed as a third party');
  });

  test('a release branch already on the remote is refused rather than pushed over', () => {
    gateOnHead();
    inWork(['branch', 'release/0.12.0']);
    inWork(['push', 'origin', 'release/0.12.0']);
    inWork(['branch', '-D', 'release/0.12.0']);

    const gh = fakeGh();
    assert.throws(
      () => prepareRelease('0.12.0', { root: work, gh, log: () => {} }),
      /release\/0\.12\.0/
    );
    assert.strictEqual(gh.calls.length, 0);
  });

  test('a failed branch push winds everything back and never reaches the pull request', () => {
    // The reachable half-done state, asserted rather than assumed. The push is
    // the boundary: before it, the repository is put back exactly as the
    // preflight found it, which the preflight itself makes safe by proving the
    // tree was clean.
    gateOnHead();
    const mainBefore = inOrigin(['rev-parse', 'main']);
    const headBefore = inWork(['rev-parse', 'HEAD']);
    const gh = fakeGh();
    const git = (args) => {
      if (args[0] === 'push') throw new Error('remote rejected the branch');
      return gitAt(work)(args);
    };

    assert.throws(
      () => prepareRelease('0.12.0', { root: work, git, gh, log: () => {} }),
      /remote rejected the branch/
    );

    assert.strictEqual(gh.calls.length, 0, 'no pull request after a failed push');
    assert.strictEqual(inWork(['tag', '-l']), '', 'no tag anywhere');
    assert.strictEqual(inOrigin(['tag', '-l']), '', 'no tag on the remote');
    assert.strictEqual(inOrigin(['rev-parse', 'main']), mainBefore, 'origin/main untouched');
    assert.strictEqual(inOrigin(['branch', '--list', 'release/0.12.0']), '', 'no branch on the remote');
    assert.strictEqual(inWork(['symbolic-ref', '--short', 'HEAD']), 'main', 'back on main');
    assert.strictEqual(inWork(['rev-parse', 'HEAD']), headBefore, 'no commit left behind');
    assert.strictEqual(inWork(['status', '--porcelain']), '', 'the bump is not left in the working tree');
    assert.strictEqual(inWork(['branch', '--list', 'release/0.12.0']), '', 'no local branch left behind');
  });

  test('a failed pull request creation keeps the pushed branch and says so', () => {
    // Past the push there is nothing safe to wind back: the branch is on the
    // remote and somebody else may already be looking at it. The failure has to
    // name that state instead of tidying it away.
    gateOnHead();
    const gh = fakeGh(new Error('gh: could not create pull request'));

    assert.throws(
      () => prepareRelease('0.12.0', { root: work, gh, log: () => {} }),
      /release\/0\.12\.0/
    );

    assert.strictEqual(
      inOrigin(['rev-parse', 'refs/heads/release/0.12.0']),
      inWork(['rev-parse', 'HEAD']),
      'the pushed branch is left alone'
    );
    assert.strictEqual(inOrigin(['tag', '-l']), '', 'still no tag');
    assert.strictEqual(inOrigin(['rev-parse', 'main']), inWork(['rev-parse', 'main']), 'main still untouched');
  });
});
