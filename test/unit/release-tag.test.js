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

const { bumpRelease, tagRelease, signoffRelease, extractChangelogEntry, SIGNOFF_FILE_NAME } = require('../../scripts/release.js');
const { GATE_FILE_NAME, LEGACY_GATE_FILE_NAME, runGate } = require('../../scripts/release-gate.js');
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

// What a green gate leaves behind, in git's common directory, where every
// worktree of the repository reads it. `file` puts it somewhere else.
function writeGateRecord(tree, { live = true, ci = { checks: { E2E: { run: 1 } } }, file = path.join(work, '.git', GATE_FILE_NAME) } = {}) {
  fs.writeFileSync(file, JSON.stringify({
    tree, sha: 'not-what-is-checked', live, ci, passedAt: '2026-08-26T09:00:00Z', wallClockSeconds: 300, steps: [],
  }));
}

// The real gate against a repository folder, with only its expensive steps,
// GitHub and the port probe stood in for: CI reports every required job green
// on `tree`.
function gateIn(root, tree) {
  const exec = (cmd, args) => (cmd === 'git' ? run('git', args, root) : '');
  const gh = (args) => {
    const url = args.find((a) => a.startsWith('repos/'));
    if (/workflows\/ci\.yml\/runs/.test(url)) {
      return JSON.stringify({ workflow_runs: [{ id: 5, event: 'push', head_sha: 'x', head_commit: { tree_id: tree }, pull_requests: [] }] });
    }
    return JSON.stringify({ jobs: REQUIRED_CI_CHECKS.map((name) => ({ name, status: 'completed', conclusion: 'success' })) });
  };
  return runGate({ root, exec, gh, busy: async () => false, log: () => {} });
}

// What `release -- signoff` leaves behind: the hands-on check from source,
// recorded for one tree in git's common directory. With nothing else given it
// is a record from before sign-offs said how they were given.
function writeSignoff(tree, how = {}) {
  fs.writeFileSync(path.join(work, '.git', SIGNOFF_FILE_NAME), JSON.stringify({ tree, version: '0.12.0', signedAt: '2026-08-26T10:00:00Z', ...how }));
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
  // The gate record's old location is ignored in the real repository, and has
  // to be here too: an untracked file makes the tree dirty, which the
  // preflight refuses. Its location now, git's common directory, needs no
  // ignoring, because nothing in it is ever part of the tree.
  fs.writeFileSync(path.join(work, '.gitignore'), `${LEGACY_GATE_FILE_NAME}\n`);
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

// The candidate: a release branch carrying the bump, gated on its tree.
function candidate(version = '0.12.0', { gate = true, signoff = true } = {}) {
  inWork(['checkout', '-b', `release/${version}`]);
  bumpRelease(version, { root: work, log: () => {} });
  inWork(['commit', '-am', `Release ${version}`]);
  if (gate) writeGateRecord(treeOf('HEAD'));
  if (signoff) writeSignoff(treeOf('HEAD'));
}

// What a merged pull request leaves behind: a new commit on main, pushed,
// with local main in step with it.
function merge(version = '0.12.0') {
  inWork(['checkout', 'main']);
  inWork(['merge', '--no-ff', '-m', `Release ${version} (#42)`, `release/${version}`]);
  inWork(['push', 'origin', 'main']);
}

// The commit the release merged as: what the tag must go on.
const mergedCommit = () => inOrigin(['rev-parse', 'main']);
// The commit the tag names here, or null when there is no tag here.
const localTag = (tag = 'v0.12.0') => (inWork(['tag', '-l', tag]) ? inWork(['rev-list', '-n', '1', tag]) : null);

// `tag` run as a person reads it: every line it prints, with its step. A
// bare line has no step.
function tagAndRead(version = '0.12.0', opts = {}) {
  const lines = [];
  const result = tagRelease(version, { root: work, log: (step, msg) => lines.push({ step, msg }), ...opts });
  return { result, lines };
}

// The push `tag` printed, as the arguments git takes: the one bare line it
// prints, which is a git command and nothing else.
function printedPush(lines) {
  const bare = lines.filter((l) => l.step === null);
  assert.strictEqual(bare.length, 1, `one bare line, the push: ${JSON.stringify(lines)}`);
  const words = bare[0].msg.split(' ');
  assert.strictEqual(words[0], 'git', bare[0].msg);
  return words.slice(1);
}

// From here on the remote refuses every push, the way a push without a
// credential fails; and then takes them again.
function remoteRefusesPushes() {
  const hooks = path.join(origin, 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(hooks, 'pre-receive'), '#!/bin/sh\necho "refused: no credential" >&2\nexit 1\n', { mode: 0o755 });
  inOrigin(['config', 'core.hooksPath', hooks]);
}
function remoteTakesPushes() {
  fs.rmSync(path.join(origin, 'hooks', 'pre-receive'), { force: true });
}

// A GitHub workflow filter, `*` for any run of characters, as a pattern.
function globToRegExp(glob) {
  const literal = (s) => s.replace(/[.+?^$(){}|[\]\\]/g, '\\$&');
  return new RegExp(`^${glob.split('*').map(literal).join('.*')}$`);
}

// Whether the release workflow starts on a push of this tag, read from the
// workflow's own trigger rather than restated here.
function releaseWorkflowBuilds(tag) {
  const lines = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'release.yml'), 'utf8').split('\n');
  const push = lines.findIndex((l) => l.trim() === 'push:');
  const tags = lines.findIndex((l, i) => i > push && l.trim() === 'tags:');
  const globs = [];
  for (const l of lines.slice(tags + 1)) {
    const t = l.trim();
    if (!t.startsWith('- ')) break;
    globs.push(t.slice(2).replace(/^['"]|['"]$/g, ''));
  }
  assert.ok(push > -1 && tags > push && globs.length > 0, 'the release workflow is started by pushed tags');
  return globs.some((g) => globToRegExp(g).test(tag));
}

describe('release:tag tags what actually merged, and only a gated tree', () => {
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

    const lines = [];
    const result = tagRelease('0.12.0', { root: work, log: (step, msg) => lines.push(msg) });

    // The sign-off here is a record from before sign-offs said how they were
    // given, which still counts, as one typed at the terminal.
    assert.ok(lines.some((l) => l.endsWith(`Tree ${treeOf(merged).slice(0, 12)} was signed off in the terminal`)), lines.join('\n'));
    assert.strictEqual(result.tag, 'v0.12.0');
    assert.strictEqual(inWork(['tag', '-l']), 'v0.11.8\nv0.12.0', 'exactly one new tag here');
    assert.strictEqual(localTag(), merged, 'the tag is on the merged commit');
    assert.strictEqual(JSON.parse(inWork(['show', 'v0.12.0:package.json'])).version, '0.12.0');
    assert.match(gitAt(work)(['show', 'v0.12.0:CHANGELOG.md']), /^## 0\.12\.0: Foundations \(/m);
  });

  test('the tag is made here and nothing is pushed: no push is tried, and nothing it prints claims one', () => {
    candidate();
    merge();
    const calls = [];
    const git = (args, opts) => { calls.push(args.join(' ')); return gitAt(work)(args, opts); };
    const { result, lines } = tagAndRead('0.12.0', { git });

    assert.ok(!calls.some((c) => c.startsWith('push')), `no push was tried: ${calls.filter((c) => c.startsWith('push')).join(', ')}`);
    assert.strictEqual(inOrigin(['tag', '-l']), '', 'the remote has no tag');
    assert.strictEqual(localTag(), mergedCommit(), 'the tag is here, on the merged commit');
    assert.strictEqual(result.created, true);
    assert.ok(lines.every((l) => !/\band pushed\b|\bpushed it\b|\bis now building\b/i.test(l.msg)), lines.map((l) => l.msg).join('\n'));
    assert.ok(lines.some((l) => l.step === 'tag' && /here only: nothing has been pushed$/.test(l.msg)), lines.map((l) => l.msg).join('\n'));
  });

  test('the push is printed on a line of its own, as the exact bare command, and running it is what puts the tag on the remote', () => {
    candidate();
    merge();
    const { result, lines } = tagAndRead();
    const bare = lines.filter((l) => l.step === null).map((l) => l.msg);
    assert.deepStrictEqual(bare, ['git push origin v0.12.0'], 'one bare line, and it is the push');
    assert.strictEqual(result.push, 'git push origin v0.12.0');
    assert.strictEqual(inOrigin(['tag', '-l']), '', 'not pushed until it is run');

    inWork(printedPush(lines));
    assert.strictEqual(inOrigin(['rev-list', '-n', '1', 'v0.12.0']), mergedCommit(), 'pushed, on the merged commit');
    assert.ok(releaseWorkflowBuilds('v0.12.0'), 'and the release workflow starts on a pushed tag of that name');
  });

  test('run again after the push was skipped, it checks everything again, creates nothing new and prints the same push', () => {
    candidate();
    merge();
    const first = tagAndRead();
    const calls = [];
    const git = (args, opts) => { calls.push(args.join(' ')); return gitAt(work)(args, opts); };
    const again = tagAndRead('0.12.0', { git });

    assert.strictEqual(again.result.created, false, 'nothing new was created');
    assert.ok(!calls.some((c) => c === 'tag v0.12.0' || c.startsWith('tag -d') || c.startsWith('push')), calls.join('\n'));
    assert.ok(calls.some((c) => c.startsWith('rev-parse') && c.includes('^{tree}')), 'the merged tree was read and judged again');
    assert.deepStrictEqual(printedPush(again.lines), printedPush(first.lines), 'the same push');
    assert.ok(again.lines.some((l) => l.step === 'tag' && /already tagged here on [0-9a-f]{9} by an earlier run, and is not on the remote/.test(l.msg)), again.lines.map((l) => l.msg).join('\n'));
    assert.strictEqual(localTag(), mergedCommit());
  });

  test('once the tag is on the remote, tag refuses and says it has been pushed, and its build started', () => {
    candidate();
    merge();
    inWork(printedPush(tagAndRead().lines));
    assert.throws(() => tagRelease('0.12.0', { root: work, log: () => {} }), (err) =>
      /already on the remote, on [0-9a-f]{9}, the commit being tagged: it has been pushed, and its build started/.test(err.message)
      && err.message.includes(mergedCommit().slice(0, 9)));
  });

  test('an annotated tag pushed by hand on the commit being tagged is read by its commit, as pushed', () => {
    candidate();
    merge();
    inWork(['tag', '-a', 'v0.12.0', '-m', 'Release 0.12.0', mergedCommit()]);
    inWork(['push', 'origin', 'v0.12.0']);
    inWork(['tag', '-d', 'v0.12.0']);
    assert.throws(() => tagRelease('0.12.0', { root: work, log: () => {} }), /the commit being tagged: it has been pushed/);
  });

  test('a tag on the remote on another commit is refused, naming both commits and the recut', () => {
    candidate();
    merge();
    const stale = inWork(['rev-parse', 'HEAD~1']);
    inWork(['push', 'origin', `${stale}:refs/tags/v0.12.0`]);
    assert.throws(() => tagRelease('0.12.0', { root: work, log: () => {} }), (err) =>
      err.message.includes(stale.slice(0, 9)) && err.message.includes(mergedCommit().slice(0, 9)) && /A recut/.test(err.message));
    assert.strictEqual(localTag(), null, 'nothing made here');
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

  test('no hands-on sign-off: refuses, naming the command that records it', () => {
    candidate('0.12.0', { signoff: false });
    merge();
    assert.throws(() => tagRelease('0.12.0', { root: work, log: () => {} }), /npm run release -- signoff 0\.12\.0 --confirm 0\.12\.0/);
    assert.strictEqual(inOrigin(['tag', '-l']), '', 'nothing tagged');
  });

  test('a sign-off for a different tree is refused, naming both trees', () => {
    candidate();
    const tried = treeOf('HEAD');
    fs.writeFileSync(path.join(work, 'README.md'), 'Rundock, fixed after the check\n');
    inWork(['commit', '-am', 'a fix after the hands-on check']);
    writeGateRecord(treeOf('HEAD'));
    merge();
    assert.throws(() => tagRelease('0.12.0', { root: work, log: () => {} }), new RegExp(`signed off on tree ${tried.slice(0, 12)}[\\s\\S]*${treeOf('HEAD').slice(0, 12)}`));
    assert.strictEqual(inOrigin(['tag', '-l']), '', 'nothing tagged');
  });

  test('after tagging, the next steps name publish with a placeholder for --confirm, never a working one', () => {
    candidate();
    merge();
    const lines = [];
    tagRelease('0.12.0', { root: work, log: (step, msg) => lines.push([step, msg]) });
    const done = lines.filter(([step]) => step === 'done').map(([, msg]) => msg);
    assert.ok(done.includes('Once you have decided v0.12.0 is ready for everyone: npm run release -- publish 0.12.0 --confirm <version>'), done.join('\n'));
    assert.ok(done.some((msg) => /Do not publish yet/.test(msg)), done.join('\n'));
    // Publishing cannot be started by copying the tag's own output.
    assert.ok(lines.every(([, msg]) => !/--confirm 0\.12\.0/.test(msg)), lines.map(([, msg]) => msg).join('\n'));
  });

  test('a sign-off typed at the terminal lets the tag through, and the tag says so', () => {
    candidate('0.12.0', { signoff: false });
    writeSignoff(treeOf('HEAD'), { given: 'terminal', note: 'tried the list' });
    merge();
    const lines = [];
    tagRelease('0.12.0', { root: work, log: (step, msg) => lines.push(msg) });
    assert.ok(lines.some((l) => /was signed off in the terminal$/.test(l)), lines.join('\n'));
    assert.ok(!lines.some((l) => /in chat/.test(l)), lines.join('\n'));
    assert.strictEqual(localTag(), mergedCommit());
  });

  test('a sign-off given in chat lets the tag through, the tag says so, and its words go nowhere the release goes', () => {
    // A word that appears nowhere else, so finding it anywhere is the leak.
    const words = 'sign off 0.12.0, the zebraquartz walk looked right';
    candidate('0.12.0', { signoff: false });
    writeSignoff(treeOf('HEAD'), { given: 'chat', instruction: words });
    merge();
    const lines = [];
    tagRelease('0.12.0', { root: work, log: (step, msg) => lines.push({ step, msg }) });
    // Pushed as the person pushes it, so what the remote holds can be read.
    inWork(printedPush(lines));

    assert.ok(lines.some((l) => /was signed off in chat on instruction$/.test(l.msg)), lines.map((l) => l.msg).join('\n'));
    assert.ok(lines.every((l) => !`${l.step} ${l.msg}`.includes('zebraquartz')), 'the tag never prints the words');
    const notes = extractChangelogEntry('0.12.0', gitAt(origin)(['show', 'v0.12.0:CHANGELOG.md']));
    assert.ok(notes && !`${notes.title}\n${notes.body}`.includes('zebraquartz'), 'the release notes do not carry them');
    // Nothing the remote holds carries them: no commit message, tag, tree or file.
    const objects = inOrigin(['rev-list', '--all', '--objects']).split('\n').filter(Boolean);
    assert.ok(objects.length > 0);
    for (const line of objects) {
      assert.ok(!gitAt(origin)(['cat-file', '-p', line.split(' ')[0]]).includes('zebraquartz'), `pushed object ${line}`);
    }
    assert.strictEqual(inWork(['status', '--porcelain']), '', 'nothing in the working tree to commit');
    assert.strictEqual(inOrigin(['tag', '-l']), 'v0.12.0');
  });

  test('end to end: a sign-off given in chat, recorded by the real command, lets the tag through and goes nowhere the release goes', () => {
    candidate('0.12.0', { signoff: false });
    const words = 'sign off 0.12.0: the quartzzebra list passed, `ship` it';
    const said = [];
    // As an agent records it: in an agent session, with no terminal, the
    // words on stdin.
    signoffRelease('0.12.0', {
      root: work,
      argv: ['node', 'release.js', 'signoff', '0.12.0', '--confirm', '0.12.0', '--on-instruction', '-'],
      env: { CLAUDECODE: '1' },
      ask: () => { throw Object.assign(new Error('Device not configured'), { code: 'ENXIO' }); },
      readStdin: () => `${words}\n`,
      stdinIsTerminal: () => false,
      notice: (line) => said.push(line),
      log: (step, msg) => said.push(msg),
    });
    merge();
    const tagged = [];
    tagRelease('0.12.0', { root: work, log: (step, msg) => { said.push(msg); tagged.push({ step, msg }); } });
    inWork(printedPush(tagged));

    assert.strictEqual(inOrigin(['tag', '-l']), 'v0.12.0');
    assert.ok(said.some((l) => /^Recorded a sign-off given in chat for 0\.12\.0 on tree /.test(l)), said.join('\n'));
    assert.ok(said.some((l) => /was signed off in chat on instruction$/.test(l)), said.join('\n'));
    assert.ok(said.every((l) => !l.includes('quartzzebra')), 'neither step prints the words');
    const notes = extractChangelogEntry('0.12.0', gitAt(origin)(['show', 'v0.12.0:CHANGELOG.md']));
    assert.ok(notes && !`${notes.title}\n${notes.body}`.includes('quartzzebra'), 'the release notes do not carry them');
    for (const line of inOrigin(['rev-list', '--all', '--objects']).split('\n').filter(Boolean)) {
      assert.ok(!gitAt(origin)(['cat-file', '-p', line.split(' ')[0]]).includes('quartzzebra'), `pushed object ${line}`);
    }
    assert.strictEqual(inWork(['status', '--porcelain']), '', 'nothing in the working tree to commit');
  });

  test('a sign-off given in chat for a different tree is refused, naming both trees', () => {
    candidate('0.12.0', { signoff: false });
    const tried = treeOf('HEAD');
    writeSignoff(tried, { given: 'chat', instruction: 'sign off 0.12.0' });
    fs.writeFileSync(path.join(work, 'README.md'), 'Rundock, fixed after the sign-off\n');
    inWork(['commit', '-am', 'a fix after the sign-off']);
    writeGateRecord(treeOf('HEAD'));
    merge();
    assert.throws(() => tagRelease('0.12.0', { root: work, log: () => {} }), new RegExp(`signed off on tree ${tried.slice(0, 12)}[\\s\\S]*${treeOf('HEAD').slice(0, 12)}`));
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

  test('a tag left here on another commit is refused, naming both commits and the command that deletes it', () => {
    candidate();
    merge();
    const stale = inWork(['rev-parse', 'HEAD~1']);
    inWork(['tag', 'v0.12.0', stale]);

    assert.throws(() => tagRelease('0.12.0', { root: work, log: () => {} }), (err) =>
      err.message.includes(stale.slice(0, 9)) && err.message.includes(mergedCommit().slice(0, 9))
      && err.message.includes('git tag -d v0.12.0'));
    assert.strictEqual(localTag(), stale, 'the tag is left where it was');
    assert.strictEqual(inOrigin(['tag', '-l']), '', 'nothing pushed');
  });

  test('a dirty tree: refuses', () => {
    candidate();
    merge();
    fs.writeFileSync(path.join(work, 'CHANGELOG.md'), `${CHANGELOG}\nstray edit\n`);

    assert.throws(() => tagRelease('0.12.0', { root: work, log: () => {} }), /clean/i);
    assert.strictEqual(inOrigin(['tag', '-l']), '', 'nothing tagged');
  });

  test('a push that failed leaves the tag here, and running tag again is not blocked by it', () => {
    candidate();
    merge();
    const first = tagAndRead();
    remoteRefusesPushes();
    assert.throws(() => inWork(printedPush(first.lines)), /refused: no credential/);
    assert.strictEqual(inOrigin(['tag', '-l']), '', 'no tag on the remote');
    assert.strictEqual(localTag(), mergedCommit(), 'the tag stays here');

    const again = tagAndRead();
    assert.strictEqual(again.result.created, false);
    remoteTakesPushes();
    inWork(printedPush(again.lines));
    assert.strictEqual(inOrigin(['rev-list', '-n', '1', 'v0.12.0']), mergedCommit(), 'the second push lands it');
  });
});

describe('a recut of an unpublished draft needs no hand-run step', () => {
  // 0.15.1's recut was run step by step by hand because the gate refused main
  // on two sequencing checks written for the old flow. Now: delete the draft
  // and the tag, merge the fix, run the gate on main, tag again. The real gate
  // runs here against the real repository; only its expensive steps, GitHub
  // and the port probe are stood in for.
  const gateHere = (tree) => gateIn(work, tree);

  test('gate, tag, push, delete the tag, fix, gate, tag, push: every step passes as written', async () => {
    inWork(['checkout', '-b', 'release/0.12.0']);
    bumpRelease('0.12.0', { root: work, log: () => {} });
    inWork(['commit', '-am', 'Release 0.12.0']);
    const first = await gateHere(treeOf('HEAD'));
    assert.strictEqual(first.ok, true, first.error);
    writeSignoff(treeOf('HEAD'));
    inWork(['checkout', 'main']);
    inWork(['merge', '--no-ff', '-m', 'Release 0.12.0 (#42)', 'release/0.12.0']);
    inWork(['push', 'origin', 'main']);
    inWork(printedPush(tagAndRead().lines));

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
    // The fix changed the tree, so the hands-on check is owed again.
    assert.throws(() => tagRelease('0.12.0', { root: work, log: () => {} }), /signed off on tree/);
    writeSignoff(treeOf('HEAD'));
    const { result, lines } = tagAndRead();
    inWork(printedPush(lines));
    assert.strictEqual(inOrigin(['rev-list', '-n', '1', 'v0.12.0']), inWork(['rev-parse', 'HEAD']), 'the new tag is on the fix');
    assert.strictEqual(result.tag, 'v0.12.0');
  });
});

describe('every refusal of the tag, through what a person does next', () => {
  // For each rule that refuses: the inverse (a tag made, then deleted by
  // hand), the undo (a recut after deleting it, as docs/RELEASING.md "A recut"
  // gives it), the retry (tag run again after the push failed) and the most
  // common next step (pushing the tag, which starts the build). Each rule says
  // how it is broken, how it is put right, and what its refusal says.
  const RULES = [
    {
      name: 'no gate pass for the tree',
      breakIt: () => fs.rmSync(path.join(work, '.git', GATE_FILE_NAME)),
      putRight: () => writeGateRecord(treeOf('HEAD')),
      refusal: /No release gate pass found[\s\S]*npm run release:gate/,
    },
    {
      name: 'no sign-off for the tree',
      breakIt: () => fs.rmSync(path.join(work, '.git', SIGNOFF_FILE_NAME)),
      putRight: () => writeSignoff(treeOf('HEAD')),
      refusal: /No sign-off found[\s\S]*npm run release -- signoff 0\.12\.0 --confirm 0\.12\.0/,
    },
  ];

  const tagIt = () => tagRelease('0.12.0', { root: work, log: () => {} });

  // The fix a recut merges, with its note under the release's heading.
  function fixOnMain() {
    fs.writeFileSync(path.join(work, 'CHANGELOG.md'),
      fs.readFileSync(path.join(work, 'CHANGELOG.md'), 'utf8').replace('- A user visible fix.', '- A user visible fix.\n- The bug the draft showed.'));
    inWork(['commit', '-am', 'Fix the bug the draft showed (#43)']);
    inWork(['push', 'origin', 'main']);
  }

  for (const rule of RULES) {
    describe(rule.name, () => {
      // Refused, with the tag here exactly as it was before, and none pushed.
      function refused(tagBefore) {
        assert.throws(tagIt, rule.refusal);
        assert.strictEqual(localTag(), tagBefore, 'the refusal changed no tag here');
        assert.strictEqual(inOrigin(['tag', '-l']), '', 'and pushed none');
      }

      test('the inverse: a tag made and then deleted by hand is refused again, and nothing is made; put right, it tags again', () => {
        candidate();
        merge();
        tagIt();
        inWork(['tag', '-d', 'v0.12.0']);
        rule.breakIt();
        refused(null);
        rule.putRight();
        tagIt();
        assert.strictEqual(localTag(), mergedCommit());
      });

      test('the undo: a recut after deleting the tag is refused until it is put right, then tags the fix', () => {
        candidate();
        merge();
        inWork(printedPush(tagAndRead().lines));
        inWork(['tag', '-d', 'v0.12.0']);
        inWork(['push', 'origin', ':refs/tags/v0.12.0']);
        fixOnMain();
        writeGateRecord(treeOf('HEAD'));
        writeSignoff(treeOf('HEAD'));
        rule.breakIt();
        refused(null);
        rule.putRight();
        const { lines } = tagAndRead();
        assert.strictEqual(localTag(), mergedCommit(), 'the new tag is on the fix');
        inWork(printedPush(lines));
        assert.strictEqual(inOrigin(['rev-list', '-n', '1', 'v0.12.0']), mergedCommit());
      });

      test('the retry: run again after the push failed, it is refused and leaves its tag alone; put right, it prints the push again', () => {
        candidate();
        merge();
        const first = tagAndRead();
        remoteRefusesPushes();
        assert.throws(() => inWork(printedPush(first.lines)), /refused: no credential/);
        rule.breakIt();
        refused(mergedCommit());
        rule.putRight();
        const again = tagAndRead();
        assert.strictEqual(again.result.created, false, 'nothing new is created');
        assert.deepStrictEqual(printedPush(again.lines), printedPush(first.lines), 'the same push is printed');
        remoteTakesPushes();
        inWork(printedPush(again.lines));
        assert.strictEqual(inOrigin(['rev-list', '-n', '1', 'v0.12.0']), mergedCommit());
      });

      test('the next step: refused, there is no tag to push, so no build can start; put right, the printed push starts it', () => {
        candidate();
        merge();
        rule.breakIt();
        refused(null);
        assert.throws(() => inWork(['push', 'origin', 'v0.12.0']), /src refspec v0\.12\.0 does not match any/);
        assert.strictEqual(inOrigin(['tag', '-l']), '', 'nothing reached the remote');
        rule.putRight();
        inWork(printedPush(tagAndRead().lines));
        assert.strictEqual(inOrigin(['rev-list', '-n', '1', 'v0.12.0']), mergedCommit(), 'the tag is on the remote, on the merged commit');
        assert.ok(releaseWorkflowBuilds('v0.12.0'), 'where the release workflow starts on it');
        assert.throws(tagIt, /already on the remote[\s\S]*it has been pushed/, 'and tag now says it has been pushed');
      });
    });
  }
});

describe('the gate record is read from any worktree of the repository', () => {
  // The gate runs in the release worktree and the tag runs on main, usually in
  // another checkout. The record used to be written into the folder the gate
  // ran in, where the checkout that tags could not see it, so it was copied
  // across by hand. It is kept in git's common directory now, beside the
  // sign-off.
  let wt;
  beforeEach(() => { wt = path.join(dir, 'release-worktree'); });
  const inWt = (args) => run('git', args, wt).trim();

  // The candidate, built and committed in a worktree of its own on the
  // release branch, as a release is cut.
  function candidateInWorktree(version = '0.12.0') {
    inWork(['worktree', 'add', '-b', `release/${version}`, wt]);
    bumpRelease(version, { root: wt, log: () => {} });
    inWt(['commit', '-am', `Release ${version}`]);
    return inWt(['rev-parse', 'HEAD^{tree}']);
  }
  function mergeIntoMain(version = '0.12.0') {
    inWork(['merge', '--no-ff', '-m', `Release ${version} (#42)`, `release/${version}`]);
    inWork(['push', 'origin', 'main']);
  }
  const nothingAt = (folder) => !fs.existsSync(path.join(folder, GATE_FILE_NAME)) && !fs.existsSync(path.join(folder, LEGACY_GATE_FILE_NAME));

  test('a gate run in a release worktree lets the checkout of main tag, with nothing copied', async () => {
    const tree = candidateInWorktree();
    const gated = await gateIn(wt, tree);
    assert.strictEqual(gated.ok, true, gated.error);
    assert.ok(nothingAt(wt), 'nothing is written in the worktree the gate ran in');
    assert.strictEqual(inWt(['status', '--porcelain']), '', 'so there is nothing there to commit');
    writeSignoff(tree);
    mergeIntoMain();
    assert.ok(nothingAt(work), 'and nothing has been copied into the checkout that tags');

    const result = tagRelease('0.12.0', { root: work, log: () => {} });
    assert.strictEqual(result.tag, 'v0.12.0');
    assert.strictEqual(inWork(['rev-list', '-n', '1', 'v0.12.0']), inWork(['rev-parse', 'HEAD']), 'the merged commit is tagged');
  });

  test('for one release, a record an older gate left in a release worktree still lets the tag through, and the tag says where it read it', () => {
    const tree = candidateInWorktree();
    writeGateRecord(tree, { file: path.join(wt, LEGACY_GATE_FILE_NAME) });
    writeSignoff(tree);
    mergeIntoMain();
    const lines = [];
    tagRelease('0.12.0', { root: work, log: (step, msg) => lines.push(msg) });
    assert.ok(lines.some((l) => l.includes(path.join(fs.realpathSync(wt), LEGACY_GATE_FILE_NAME))), lines.join('\n'));
    assert.strictEqual(inWork(['tag', '-l', 'v0.12.0']), 'v0.12.0');
  });

  test('for one release, a record an older gate left in the checkout that tags still counts', () => {
    inWork(['checkout', '-b', 'release/0.12.0']);
    bumpRelease('0.12.0', { root: work, log: () => {} });
    inWork(['commit', '-am', 'Release 0.12.0']);
    writeGateRecord(treeOf('HEAD'), { file: path.join(work, LEGACY_GATE_FILE_NAME) });
    writeSignoff(treeOf('HEAD'));
    inWork(['checkout', 'main']);
    mergeIntoMain();
    tagRelease('0.12.0', { root: work, log: () => {} });
    assert.strictEqual(inWork(['tag', '-l', 'v0.12.0']), 'v0.12.0');
  });

  test('a record at the old location for another tree is refused, naming the file and both trees', () => {
    const gated = candidateInWorktree();
    writeGateRecord(gated, { file: path.join(wt, LEGACY_GATE_FILE_NAME) });
    fs.writeFileSync(path.join(wt, 'README.md'), 'Rundock, changed after the gate\n');
    inWt(['commit', '-am', 'a change after the gate']);
    const changed = inWt(['rev-parse', 'HEAD^{tree}']);
    writeSignoff(changed);
    mergeIntoMain();
    assert.throws(() => tagRelease('0.12.0', { root: work, log: () => {} }), (err) =>
      err.message.includes(path.join(fs.realpathSync(wt), LEGACY_GATE_FILE_NAME))
      && err.message.includes(gated.slice(0, 12)) && err.message.includes(changed.slice(0, 12)));
    assert.strictEqual(inWork(['tag', '-l', 'v0.12.0']), '', 'nothing tagged');
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
    assert.match(out, /signoff <version> --confirm <version>/);
    assert.match(out, /signoff <version> --confirm <version> --on-instruction - <<'END_OF_SIGNOFF_WORDS'   record a sign-off given in chat/);
    assert.match(out, /publish <version>/);
  });

  test('publish without --confirm refuses, naming --confirm with a placeholder, never a working command', () => {
    const { code, out } = releaseCli(['publish', '0.12.0']);
    assert.strictEqual(code, 1);
    assert.match(out, /npm run release -- publish 0\.12\.0 --confirm <version>\n/);
    // Publishing cannot be started by copying its own refusal.
    assert.doesNotMatch(out, /--confirm 0\.12\.0/);
  });

  test('an unknown subcommand says which one it did not recognise', () => {
    const { code, out } = releaseCli(['frobnicate', '0.12.0']);
    assert.strictEqual(code, 1);
    assert.match(out, /frobnicate/);
  });

  test('each subcommand requires a semver version', () => {
    for (const subcommand of ['bump', 'signoff', 'tag', 'publish']) {
      const missing = releaseCli([subcommand]);
      assert.strictEqual(missing.code, 1, `${subcommand} with no version`);
      assert.match(missing.out, new RegExp(subcommand));

      const nonsense = releaseCli([subcommand, 'v0.12']);
      assert.strictEqual(nonsense.code, 1, `${subcommand} with a version that is not semver`);
    }
  });
});
