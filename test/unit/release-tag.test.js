'use strict';
// The release's own commands, exercised against a real repository.
//
// One pull request per release: the candidate carries its version bump and
// promoted changelog (`release -- bump` writes them for the candidate's
// commit), the gate passes on the candidate's tree, the pull request merges,
// and `release -- tag` tags the merged commit. The gate record names a TREE,
// so the merge commit, which is a new commit with the same content, is
// accepted, and any difference in content is refused.
//
// These tests build a throwaway repository with a real bare origin in a temp
// directory and run the real functions against it, so the assertions are about
// what git actually holds afterwards rather than about which commands were
// called. Nothing here reaches GitHub.

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { bumpRelease, tagRelease } = require('../../scripts/release.js');
const { GATE_FILE_NAME, runGate } = require('../../scripts/release-gate.js');
const { REQUIRED_CI_CHECKS } = require('../../scripts/release-ci.js');

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
const treeOf = (ref) => inWork(['rev-parse', `${ref}^{tree}`]);

function writeGateRecord(tree, { live = true, ci = { checks: { E2E: { run: 1 } } } } = {}) {
  fs.writeFileSync(path.join(work, GATE_FILE_NAME), JSON.stringify({
    tree, sha: 'not-what-is-checked', live, ci, passedAt: '2026-08-26T09:00:00Z', wallClockSeconds: 300, steps: [],
  }));
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
  git(['config', 'core.hooksPath', '/dev/null']);

  fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'rundock', version: '0.11.8' }, null, 2) + '\n');
  fs.writeFileSync(path.join(work, 'CHANGELOG.md'), CHANGELOG);
  fs.writeFileSync(path.join(work, 'README.md'), 'Rundock\n');
  // The gate record is ignored in the real repository, and has to be here too:
  // an untracked file makes the tree dirty, which the preflight refuses.
  fs.writeFileSync(path.join(work, '.gitignore'), `${GATE_FILE_NAME}\n`);
  git(['add', '-A']);
  git(['commit', '-m', 'initial']);
  git(['tag', 'v0.11.8']);
  git(['remote', 'add', 'origin', origin]);
  git(['push', '-u', 'origin', 'main']);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('release:bump writes the candidate\'s version and notes, and nothing else', () => {
  test('package.json and the promoted heading are written; nothing is committed', () => {
    const head = inWork(['rev-parse', 'HEAD']);
    const { heading } = bumpRelease('0.12.0', { root: work, log: () => {} });

    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(work, 'package.json'), 'utf8')).version, '0.12.0');
    const changelog = fs.readFileSync(path.join(work, 'CHANGELOG.md'), 'utf8');
    assert.match(changelog, /^## 0\.12\.0: Foundations \(\d{4}-\d{2}-\d{2}\)$/m, 'heading promoted and named');
    assert.match(heading, /^## 0\.12\.0: Foundations/);
    assert.ok(!/^## Unreleased\s*$/m.test(changelog), 'the Unreleased heading is gone');
    assert.ok(!/\*\*Name:\*\*/.test(changelog), 'the Name line is consumed by the heading');

    assert.strictEqual(inWork(['rev-parse', 'HEAD']), head, 'no commit');
    const touched = inWork(['diff', '--name-only']).split('\n').sort();
    assert.deepStrictEqual(touched, ['CHANGELOG.md', 'package.json'], 'only the two release files change');
  });

  test('no notes to promote: refuses, and leaves package.json as it was', () => {
    fs.writeFileSync(path.join(work, 'CHANGELOG.md'), '# Changelog\n\n## 0.11.8: Previous Release (2026-08-20)\n\n- Older notes.\n');
    assert.throws(() => bumpRelease('0.12.0', { root: work, log: () => {} }), /Unreleased/);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(work, 'package.json'), 'utf8')).version, '0.11.8');
  });

  test('a version that is not semver is refused', () => {
    assert.throws(() => bumpRelease('v0.12', { root: work, log: () => {} }), /semver/);
  });
});

describe('release:tag tags what actually merged, and only a gated tree', () => {
  // The candidate: a release branch carrying the bump, gated on its tree.
  function candidate(version = '0.12.0', { gate = true } = {}) {
    inWork(['checkout', '-b', `release/${version}`]);
    bumpRelease(version, { root: work, log: () => {} });
    inWork(['commit', '-am', `Release ${version}`]);
    if (gate) writeGateRecord(treeOf('HEAD'));
  }

  // What a merged pull request leaves behind: a new commit on main, pushed,
  // with local main in step with it.
  function merge(version = '0.12.0') {
    inWork(['checkout', 'main']);
    inWork(['merge', '--no-ff', '-m', `Release ${version} (#42)`, `release/${version}`]);
    inWork(['push', 'origin', 'main']);
  }

  test('the release pull request has not merged yet: refuses, naming both versions', () => {
    candidate();
    inWork(['checkout', 'main']);

    assert.throws(
      () => tagRelease('0.12.0', { root: work, log: () => {} }),
      /0\.11\.8[\s\S]*0\.12\.0|0\.12\.0[\s\S]*0\.11\.8/
    );
    assert.strictEqual(inOrigin(['tag', '-l']), '', 'nothing tagged');
  });

  test('the bump merged but the changelog promotion did not: refuses, naming the changelog', () => {
    // The version alone is not proof the release commit landed: a tag on this
    // tree would publish a release whose notes were never promoted.
    fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'rundock', version: '0.12.0' }, null, 2) + '\n');
    inWork(['commit', '-am', 'bump the version only']);
    inWork(['push', 'origin', 'main']);
    writeGateRecord(treeOf('HEAD'));

    assert.throws(() => tagRelease('0.12.0', { root: work, log: () => {} }), /CHANGELOG/);
    assert.strictEqual(inOrigin(['tag', '-l']), '', 'nothing tagged');
  });

  test('the same tree on a different commit is accepted: the merge needs no second gate', () => {
    candidate();
    const gatedCommit = inWork(['rev-parse', 'HEAD']);
    merge();
    const merged = inOrigin(['rev-parse', 'main']);
    assert.notStrictEqual(merged, gatedCommit, 'the merge made a new commit');
    assert.strictEqual(treeOf(merged), treeOf(gatedCommit), 'with the same tree');

    const result = tagRelease('0.12.0', { root: work, log: () => {} });

    assert.strictEqual(result.tag, 'v0.12.0');
    assert.strictEqual(inOrigin(['tag', '-l']), 'v0.12.0', 'exactly one tag on the remote');
    assert.strictEqual(inOrigin(['rev-list', '-n', '1', 'v0.12.0']), merged, 'the tag is on the merged commit');
    assert.strictEqual(JSON.parse(inOrigin(['show', 'v0.12.0:package.json'])).version, '0.12.0');
    assert.match(gitAt(origin)(['show', 'v0.12.0:CHANGELOG.md']), /^## 0\.12\.0: Foundations \(/m);
  });

  test('a one-byte difference from the gated tree is refused', () => {
    candidate();
    const gated = treeOf('HEAD');
    fs.writeFileSync(path.join(work, 'README.md'), 'Rundock!\n');
    inWork(['commit', '-am', 'one byte after the gate']);
    merge();
    assert.notStrictEqual(treeOf('HEAD'), gated);

    assert.throws(() => tagRelease('0.12.0', { root: work, log: () => {} }), new RegExp(`${gated.slice(0, 12)}[\\s\\S]*${treeOf('HEAD').slice(0, 12)}`));
    assert.strictEqual(inOrigin(['tag', '-l']), '', 'nothing tagged');
  });

  test('no gate record: refuses, naming the gate', () => {
    candidate('0.12.0', { gate: false });
    merge();
    assert.throws(() => tagRelease('0.12.0', { root: work, log: () => {} }), /release:gate/);
    assert.strictEqual(inOrigin(['tag', '-l']), '', 'nothing tagged');
  });

  test('a record gated without live smoke, or without CI, is refused', () => {
    candidate();
    merge();
    writeGateRecord(treeOf('HEAD'), { live: false });
    assert.throws(() => tagRelease('0.12.0', { root: work, log: () => {} }), /live/i);
    writeGateRecord(treeOf('HEAD'), { ci: { skipped: true } });
    assert.throws(() => tagRelease('0.12.0', { root: work, log: () => {} }), /CI/);
    assert.strictEqual(inOrigin(['tag', '-l']), '', 'nothing tagged');
  });

  test('local main carrying an unpushed commit: refuses rather than tagging it', () => {
    candidate();
    merge();
    fs.writeFileSync(path.join(work, 'CHANGELOG.md'), `${CHANGELOG}\n<!-- local edit -->\n`);
    inWork(['commit', '-am', 'a local commit nobody reviewed']);

    assert.throws(() => tagRelease('0.12.0', { root: work, log: () => {} }), /origin\/main/);
    assert.strictEqual(inOrigin(['tag', '-l']), '', 'nothing tagged');
  });

  test('the tag already exists: refuses', () => {
    candidate();
    merge();
    inWork(['tag', 'v0.12.0']);

    assert.throws(() => tagRelease('0.12.0', { root: work, log: () => {} }), /v0\.12\.0/);
    assert.strictEqual(inOrigin(['tag', '-l']), '', 'nothing pushed');
  });

  test('a dirty tree: refuses', () => {
    candidate();
    merge();
    fs.writeFileSync(path.join(work, 'CHANGELOG.md'), `${CHANGELOG}\nstray edit\n`);

    assert.throws(() => tagRelease('0.12.0', { root: work, log: () => {} }), /clean/i);
    assert.strictEqual(inOrigin(['tag', '-l']), '', 'nothing tagged');
  });

  test('a failed tag push leaves no tag behind, so running it again is not blocked', () => {
    candidate();
    merge();
    const git = (args) => {
      if (args[0] === 'push') throw new Error('the remote refused the tag');
      return gitAt(work)(args);
    };

    assert.throws(() => tagRelease('0.12.0', { root: work, git, log: () => {} }), /refused the tag/);

    assert.strictEqual(inOrigin(['tag', '-l']), '', 'no tag on the remote');
    assert.strictEqual(inWork(['tag', '-l', 'v0.12.0']), '', 'no local tag either, so a retry gets past the preflight');
  });
});

describe('a recut of an unpublished draft needs no hand-run step', () => {
  // 0.15.1's recut was run step by step by hand because the gate refused main
  // on two sequencing checks written for the old flow. Now: delete the draft
  // and the tag, merge the fix, run the gate on main, tag again. The real gate
  // runs here against the real repository; only its expensive steps, GitHub
  // and the port probe are stood in for.
  function gateHere(tree) {
    const exec = (cmd, args) => (cmd === 'git' ? run('git', args, work) : '');
    const gh = (args) => {
      const url = args.find((a) => a.startsWith('repos/'));
      if (/workflows\/ci\.yml\/runs/.test(url)) {
        return JSON.stringify({ workflow_runs: [{ id: 5, event: 'push', head_sha: 'x', head_commit: { tree_id: tree }, pull_requests: [] }] });
      }
      return JSON.stringify({ jobs: REQUIRED_CI_CHECKS.map((name) => ({ name, status: 'completed', conclusion: 'success' })) });
    };
    return runGate({ root: work, exec, gh, busy: async () => false, log: () => {} });
  }

  test('gate, tag, delete the tag, fix, gate, tag: every step passes as written', async () => {
    inWork(['checkout', '-b', 'release/0.12.0']);
    bumpRelease('0.12.0', { root: work, log: () => {} });
    inWork(['commit', '-am', 'Release 0.12.0']);
    const first = await gateHere(treeOf('HEAD'));
    assert.strictEqual(first.ok, true, first.error);
    inWork(['checkout', 'main']);
    inWork(['merge', '--no-ff', '-m', 'Release 0.12.0 (#42)', 'release/0.12.0']);
    inWork(['push', 'origin', 'main']);
    tagRelease('0.12.0', { root: work, log: () => {} });

    // A release-blocking bug is found in the draft: delete the draft (on
    // GitHub) and the tag, here and on the remote.
    inWork(['tag', '-d', 'v0.12.0']);
    inWork(['push', 'origin', ':refs/tags/v0.12.0']);

    // The fix merges on main, with its note under the release's heading.
    fs.writeFileSync(path.join(work, 'CHANGELOG.md'),
      fs.readFileSync(path.join(work, 'CHANGELOG.md'), 'utf8').replace('- A user visible fix.', '- A user visible fix.\n- The bug the draft showed.'));
    inWork(['commit', '-am', 'Fix the bug the draft showed (#43)']);
    inWork(['push', 'origin', 'main']);

    const second = await gateHere(treeOf('HEAD'));
    assert.strictEqual(second.ok, true, second.error);
    const result = tagRelease('0.12.0', { root: work, log: () => {} });
    assert.strictEqual(inOrigin(['rev-list', '-n', '1', 'v0.12.0']), inWork(['rev-parse', 'HEAD']), 'the new tag is on the fix');
    assert.strictEqual(result.tag, 'v0.12.0');
  });
});

describe('the command line', () => {
  // Every case here is refused before any git or gh call, which is why running
  // the real script against this checkout is safe.
  const RELEASE = path.join(__dirname, '..', '..', 'scripts', 'release.js');

  function releaseCli(args) {
    const res = require('node:child_process').spawnSync(process.execPath, [RELEASE, ...args], { encoding: 'utf8' });
    return { code: res.status, out: `${res.stdout}${res.stderr}` };
  }

  test('a bare version names the commands that replaced it', () => {
    const { code, out } = releaseCli(['0.12.0']);
    assert.strictEqual(code, 1);
    assert.match(out, /bump/);
    assert.match(out, /tag/);
  });

  test('prepare is retired, and says what replaced it', () => {
    const { code, out } = releaseCli(['prepare', '0.12.0']);
    assert.strictEqual(code, 1);
    assert.match(out, /retired/);
    assert.match(out, /bump <version>/);
  });

  test('no arguments at all prints the usage', () => {
    const { code, out } = releaseCli([]);
    assert.strictEqual(code, 1);
    assert.match(out, /bump <version>/);
    assert.match(out, /tag <version>/);
    assert.match(out, /publish <version>/);
  });

  test('an unknown subcommand says which one it did not recognise', () => {
    const { code, out } = releaseCli(['frobnicate', '0.12.0']);
    assert.strictEqual(code, 1);
    assert.match(out, /frobnicate/);
  });

  test('each subcommand requires a semver version', () => {
    for (const subcommand of ['bump', 'tag', 'publish']) {
      const missing = releaseCli([subcommand]);
      assert.strictEqual(missing.code, 1, `${subcommand} with no version`);
      assert.match(missing.out, new RegExp(subcommand));

      const nonsense = releaseCli([subcommand, 'v0.12']);
      assert.strictEqual(nonsense.code, 1, `${subcommand} with a version that is not semver`);
    }
  });
});
