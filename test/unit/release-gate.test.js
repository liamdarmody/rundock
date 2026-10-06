'use strict';
// The release gate: one command validates the candidate, and the tag refuses
// to move without it.
//
// Why this exists: 0.11.6 took SIX cuts because candidate testing happened
// after tagging; the draft build was the convenient test vehicle, so
// cut-test-recut became the loop. The gate inverts the train: it proves the
// candidate's tree, records that tree, and scripts/release.js refuses to tag
// any other. It runs only what CI cannot, and takes the suite, coverage and
// browser results from CI for the same tree (see release-ci.test.js). The
// publish subcommand additionally mechanises the 0.11.6 publish quirk: a draft
// can sit on an `untagged-*` tag_name after a recut, and flipping draft=false
// in that state binds the release to the junk tag forever. Publishing must
// bind tag_name FIRST, verify it stuck, and only then flip the draft flag.

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  runGate,
  readGateRecord,
  nextVersions,
  candidateVersion,
  smokePorts,
  requireSmokePortsFree,
  buildSteps,
  GATE_FILE_NAME,
} = require('../../scripts/release-gate.js');
const { REQUIRED_CI_CHECKS } = require('../../scripts/release-ci.js');
const { requireGatePass, publishRelease, ghApiArgs, hasPublishConfirmation, requireNotesMatchBuild } = require('../../scripts/release.js');

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-gate-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const TREE = 'e'.repeat(40);

// A fake exec that records every invocation and serves canned results.
// Commands are matched on their joined form; unmatched commands succeed
// with empty output so step lists can grow without breaking older tests.
function fakeExec(canned = {}) {
  const calls = [];
  const exec = (cmd, args = []) => {
    const key = [cmd, ...args].join(' ');
    calls.push(key);
    for (const [pattern, result] of Object.entries(canned)) {
      if (key.includes(pattern)) {
        if (result instanceof Error) throw result;
        return result;
      }
    }
    return '';
  };
  exec.calls = calls;
  return exec;
}

// GitHub as the gate sees it: one push run of TREE with every required job
// green, unless told otherwise. Never the network.
function fakeGh({ tree = TREE, conclusion = 'success' } = {}) {
  const gh = (args) => {
    const url = args.find((a) => a.startsWith('repos/'));
    if (/workflows\/ci\.yml\/runs/.test(url)) {
      return JSON.stringify({ workflow_runs: [{ id: 1, event: 'push', head_sha: 'f'.repeat(40), head_commit: { tree_id: tree }, pull_requests: [] }] });
    }
    return JSON.stringify({ jobs: REQUIRED_CI_CHECKS.map((name) => ({ name, status: 'completed', conclusion })) });
  };
  return gh;
}

const portsFree = async () => false;

// The canned git a clean candidate answers with.
const CANDIDATE = {
  'rev-parse HEAD^{tree}': `${TREE}\n`,
  'rev-parse HEAD': 'abc123def\n',
  'describe --tags': 'v0.11.6\n',
};

function gate(opts = {}) {
  return runGate({ root, live: true, gh: fakeGh(), busy: portsFree, exec: fakeExec(CANDIDATE), log: () => {}, ...opts });
}

const GOOD_CHANGELOG = `# Changelog

## 0.11.7: Foundations (2026-08-12)

### Changed

- Something user visible.

## 0.11.6: Team Integrity (2026-08-11)

- Older notes.
`;

function seedWorkspace({ version = '0.11.7', changelog = GOOD_CHANGELOG } = {}) {
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version }, null, 2));
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), changelog);
}

describe('release gate: the candidate carries its own version', () => {
  test('the next versions are the next patch, minor and major', () => {
    assert.deepStrictEqual(nextVersions('v0.15.3'), ['0.15.4', '0.16.0', '1.0.0']);
  });

  test('one step past the latest tag, named by the top heading, is accepted', () => {
    assert.doesNotThrow(() => candidateVersion('0.11.7', 'v0.11.6', GOOD_CHANGELOG));
    const minor = GOOD_CHANGELOG.replace('## 0.11.7:', '## 0.12.0:');
    assert.doesNotThrow(() => candidateVersion('0.12.0', 'v0.11.6', minor));
  });

  test('the version already tagged is refused, with the recut hint', () => {
    assert.throws(() => candidateVersion('0.11.6', 'v0.11.6', GOOD_CHANGELOG), /0\.11\.7[\s\S]*git tag -d v0\.11\.6/);
  });

  test('a version that skips a release is refused', () => {
    assert.throws(() => candidateVersion('0.11.8', 'v0.11.6', GOOD_CHANGELOG.replace('## 0.11.7:', '## 0.11.8:')), /0\.11\.8[\s\S]*v0\.11\.6/);
    assert.throws(() => candidateVersion('0.12.1', 'v0.11.6', GOOD_CHANGELOG.replace('## 0.11.7:', '## 0.12.1:')), /0\.12\.1/);
  });

  test('a version that is not semver is refused', () => {
    assert.throws(() => candidateVersion('not-semver', 'v0.11.6', GOOD_CHANGELOG), /semver/i);
  });

  test('a top heading naming another version, or still Unreleased, is refused', () => {
    assert.throws(() => candidateVersion('0.11.7', 'v0.11.6', '# Changelog\n\n## Unreleased\n\n- A thing.\n\n## 0.11.7: X (d)\n\n- y\n'), /top heading[\s\S]*Unreleased/);
    assert.throws(() => candidateVersion('0.11.7', 'v0.11.6', '# Changelog\n\n## 0.11.6: Team Integrity (2026-08-11)\n\n- Old.\n'), /top heading/);
  });

  test('an empty section under the heading is refused', () => {
    assert.throws(() => candidateVersion('0.11.7', 'v0.11.6', '# Changelog\n\n## 0.11.7: X (d)\n\n## 0.11.6: Y (d)\n\n- old\n'), /empty/i);
  });
});

describe('release gate: the smoke ports', () => {
  test('the ports are the smoke server and the three persona servers', () => {
    assert.deepStrictEqual(smokePorts({}), [3641, 3651, 3652, 3653]);
  });

  test('a held port refuses before any step, naming the process', async () => {
    const exec = fakeExec({ 'lsof -nP -iTCP:3651': 'p4242\ncnode\n' });
    await assert.rejects(
      requireSmokePortsFree({ ports: [3641, 3651], busy: async (p) => p === 3651, exec }),
      (err) => /3651 is held by pid 4242 \(node\)/.test(err.message) && !/3641/.test(err.message)
    );
  });

  test('a held port lsof cannot name still refuses', async () => {
    await assert.rejects(
      requireSmokePortsFree({ ports: [3641], busy: async () => true, exec: fakeExec({ lsof: new Error('exit 1') }) }),
      /3641 is held/
    );
  });

  test('the gate stops at a held port and runs no step', async () => {
    seedWorkspace();
    const exec = fakeExec(CANDIDATE);
    const result = await gate({ exec, busy: async () => true });
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /3641/);
    assert.ok(!exec.calls.some((c) => /smoke|electron/.test(c)), 'no step ran');
    assert.strictEqual(readGateRecord(root), null);
  });
});

describe('release gate: the run', () => {
  test('a green run writes the record: tree, SHA, version, CI, wall clock, per-step timings, live flag', async () => {
    seedWorkspace();
    const result = await gate();
    assert.strictEqual(result.ok, true, result.error);

    const record = readGateRecord(root);
    assert.ok(record, 'gate record written');
    assert.strictEqual(record.tree, TREE);
    assert.strictEqual(record.sha, 'abc123def');
    assert.strictEqual(record.version, '0.11.7');
    assert.strictEqual(record.live, true);
    assert.ok(record.ci && record.ci.checks && record.ci.checks.E2E, 'CI results recorded');
    assert.strictEqual(typeof record.wallClockSeconds, 'number');
    assert.ok(Array.isArray(record.steps) && record.steps.length > 0, 'steps recorded');
    for (const step of record.steps) {
      assert.strictEqual(typeof step.name, 'string');
      assert.strictEqual(typeof step.seconds, 'number');
    }
    assert.ok(!Number.isNaN(Date.parse(record.passedAt)), 'passedAt is a real timestamp');
  });

  test('the gate runs what CI cannot, and not what CI already ran', async () => {
    seedWorkspace();
    const exec = fakeExec(CANDIDATE);
    await gate({ exec });
    const joined = exec.calls.join('\n');
    assert.match(joined, /stream:truth/, 'stream-truth check runs (stub vs captured runtime)');
    assert.match(joined, /transcript:truth/);
    assert.match(joined, /electron/, 'the Electron steps run');
    assert.match(joined, /case-identity:disk/);
    assert.match(joined, /case-identity:volume/);
    assert.match(joined, /run smoke$/m, 'stub smoke runs');
    assert.match(joined, /smoke:personas/, 'persona journeys run');
    assert.match(joined, /--live/, 'live smoke runs');
    assert.match(joined, /smoke-packaged/, 'packaging runs (unsigned unpacked build + boot check)');
    for (const fromCi of ['test:coverage', 'test:e2e', 'typecheck', 'check:refs', 'lint:styles']) {
      assert.ok(!joined.includes(fromCi), `${fromCi} comes from CI and is not run again`);
    }
  });

  test('the desktop profile override is proven on the shipped entrypoint, beside the parity run', () => {
    const names = buildSteps(false).map((s) => s.cmd[1].join(' '));
    const parity = names.findIndex((n) => /test:settings:electron/.test(n));
    const override = names.findIndex((n) => /test:user-data:electron/.test(n));
    assert.ok(parity > -1, 'the parity run is a step');
    assert.strictEqual(override, parity + 1, 'the override run follows the parity run');
  });

  test('CI not green on this tree refuses before any step, naming the check', async () => {
    seedWorkspace();
    const exec = fakeExec(CANDIDATE);
    const result = await gate({ exec, gh: fakeGh({ conclusion: 'failure' }) });
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /"Test \(Node 22\)"/);
    assert.match(result.error, /"Coverage floors"/);
    assert.match(result.error, /"E2E"/);
    assert.ok(!exec.calls.some((c) => /smoke|electron|truth/.test(c)), 'no step ran');
    assert.strictEqual(readGateRecord(root), null);
  });

  test('CI green on a different tree refuses', async () => {
    seedWorkspace();
    const result = await gate({ gh: fakeGh({ tree: 'f'.repeat(40) }) });
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /no CI run tested this tree/);
  });

  test('a version that is not the next one refuses before CI is asked', async () => {
    seedWorkspace({ version: '0.11.6' });
    let asked = false;
    const result = await gate({ gh: () => { asked = true; return '{}'; } });
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /0\.11\.6/);
    assert.strictEqual(asked, false, 'GitHub is not asked about a candidate that cannot be released');
  });

  test('a dirty tree refuses to gate: the record must describe a reproducible tree', async () => {
    seedWorkspace();
    const result = await gate({ exec: fakeExec({ ...CANDIDATE, 'status --porcelain': ' M server.js\n' }) });
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /clean|dirty|uncommitted/i);
    assert.strictEqual(readGateRecord(root), null, 'no record for an ungateable state');
  });

  test('a failing step means no record', async () => {
    seedWorkspace();
    const result = await gate({ exec: fakeExec({ ...CANDIDATE, 'smoke:personas': new Error('persona failed') }) });
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /personas/);
    assert.strictEqual(readGateRecord(root), null);
  });

  test('--no-live is recorded honestly so the release step can refuse it', async () => {
    seedWorkspace();
    const exec = fakeExec(CANDIDATE);
    await gate({ exec, live: false });
    const record = readGateRecord(root);
    assert.strictEqual(record.live, false);
    assert.ok(!exec.calls.join('\n').includes('--live'), 'live smoke not run');
  });

  test('--no-ci is recorded honestly so the release step can refuse it', async () => {
    seedWorkspace();
    let asked = false;
    await gate({ ci: false, gh: () => { asked = true; return '{}'; } });
    const record = readGateRecord(root);
    assert.deepStrictEqual(record.ci, { skipped: true });
    assert.strictEqual(asked, false);
  });
});

describe('release refuses to tag without a gate pass on the tree being tagged', () => {
  const write = (record) => fs.writeFileSync(path.join(root, GATE_FILE_NAME), JSON.stringify({
    tree: TREE, sha: 'abc123def', live: true, ci: { checks: { E2E: { run: 1 } } }, passedAt: '2026-08-11T09:00:00Z', wallClockSeconds: 300, steps: [], ...record,
  }));

  test('no gate record: fails naming the command to run', () => {
    assert.throws(() => requireGatePass(TREE, { root }), /release:gate/);
  });

  test('gate passed on a different tree: fails naming both trees', () => {
    write({ tree: '1'.repeat(40) });
    assert.throws(() => requireGatePass(TREE, { root }), /111111111111[\s\S]*eeeeeeeeeeee|eeeeeeeeeeee[\s\S]*111111111111/);
  });

  test('a record from the older gate, naming only a commit, is refused', () => {
    write({ tree: undefined });
    assert.throws(() => requireGatePass(TREE, { root }), /tree/i);
  });

  test('gate passed without live smoke: refused', () => {
    write({ live: false });
    assert.throws(() => requireGatePass(TREE, { root }), /live/i);
  });

  test('gate passed without reading CI: refused', () => {
    write({ ci: { skipped: true } });
    assert.throws(() => requireGatePass(TREE, { root }), /CI/);
  });

  test('gate passed on this tree with live smoke and CI: proceeds', () => {
    write({});
    assert.doesNotThrow(() => requireGatePass(TREE, { root }));
  });
});

describe('publish binds the tag before flipping the draft flag', () => {
  // A fake GitHub API that records calls in order and serves canned pages.
  function fakeApi({ releases, patchTagResponds } = {}) {
    const calls = [];
    const api = (method, apiPath, body) => {
      calls.push({ method, path: apiPath, body });
      if (method === 'GET') return releases;
      if (method === 'PATCH' && body && body.tag_name) {
        return { id: 42, tag_name: patchTagResponds || body.tag_name };
      }
      if (method === 'PATCH' && body && body.draft === false) {
        return { id: 42, draft: false, html_url: 'https://github.com/liamdarmody/rundock/releases/tag/v0.11.7' };
      }
      return {};
    };
    api.calls = calls;
    return api;
  }

  // These tests drive the API sequencing: which call happens before which,
  // and which release is touched. The notes-match-build guard that now runs
  // first is a separate concern with its own tests below, and reaching for
  // real git here would make every one of them depend on a tag existing.
  const noNotesCheck = () => {};

  const DRAFT_ON_JUNK_TAG = {
    id: 42, draft: true, name: '0.11.7: Foundations', tag_name: 'untagged-9f2a',
  };
  const OLD_PUBLISHED = {
    id: 7, draft: false, name: '0.11.6: Team Integrity', tag_name: 'v0.11.6',
  };

  test('the 0.11.6 quirk, mechanised away: tag_name is patched and verified BEFORE draft=false', () => {
    const api = fakeApi({ releases: [OLD_PUBLISHED, DRAFT_ON_JUNK_TAG] });
    const result = publishRelease('0.11.7', { api, checkNotes: noNotesCheck });

    const tagPatch = api.calls.findIndex(c => c.method === 'PATCH' && c.body && c.body.tag_name === 'v0.11.7');
    const draftFlip = api.calls.findIndex(c => c.method === 'PATCH' && c.body && c.body.draft === false);
    assert.ok(tagPatch !== -1, 'tag_name was patched');
    assert.ok(draftFlip !== -1, 'draft was flipped');
    assert.ok(tagPatch < draftFlip, 'tag binding happens strictly before the draft flip');
    assert.ok(api.calls[draftFlip].path.includes('/releases/42'), 'the draft, not the old release');
    assert.strictEqual(result.tag, 'v0.11.7');
  });

  test('if the tag does not stick, the draft flag is never flipped', () => {
    const api = fakeApi({ releases: [DRAFT_ON_JUNK_TAG], patchTagResponds: 'untagged-9f2a' });
    assert.throws(() => publishRelease('0.11.7', { api, checkNotes: noNotesCheck }), /tag/i);
    assert.ok(
      !api.calls.some(c => c.method === 'PATCH' && c.body && c.body.draft === false),
      'no draft flip after a failed tag bind'
    );
  });

  test('the right draft is found even when its tag_name is junk (matched by name)', () => {
    const api = fakeApi({ releases: [OLD_PUBLISHED, DRAFT_ON_JUNK_TAG] });
    publishRelease('0.11.7', { api, checkNotes: noNotesCheck });
    const tagPatch = api.calls.find(c => c.method === 'PATCH' && c.body && c.body.tag_name);
    assert.ok(tagPatch.path.includes('/releases/42'));
  });

  test('no matching draft is an error naming the version', () => {
    const api = fakeApi({ releases: [OLD_PUBLISHED] });
    assert.throws(() => publishRelease('0.11.7', { api, checkNotes: noNotesCheck }), /0\.11\.7/);
  });

  test('a draft already on the right tag still publishes (idempotent bind)', () => {
    const api = fakeApi({ releases: [{ id: 42, draft: true, name: '0.11.7: Foundations', tag_name: 'v0.11.7' }] });
    const result = publishRelease('0.11.7', { api, checkNotes: noNotesCheck });
    assert.strictEqual(result.tag, 'v0.11.7');
    assert.ok(api.calls.some(c => c.method === 'PATCH' && c.body && c.body.draft === false));
  });
});

describe('publish refuses to run without a fresh, version-matched confirmation', () => {
  // Ratchet-Log "A split command is not a control", 2026-08-27: publish and
  // tag were already separate commands specifically so a human decides when
  // the last one runs, and nothing but that naming convention stopped it
  // running unprompted. This is not a security boundary, since anyone who can
  // run the script can also type the flag: it is a friction boundary. The
  // command `tag` prints for its own next step deliberately does not
  // include a working --confirm, so nothing can be run by copying the
  // previous step's own output, and the flag itself only satisfies for the
  // exact version it names.

  test('no --confirm flag at all: refused', () => {
    assert.strictEqual(hasPublishConfirmation(['publish', '0.12.0'], '0.12.0'), false);
  });

  test('--confirm present with no value following it: refused', () => {
    assert.strictEqual(hasPublishConfirmation(['publish', '0.12.0', '--confirm'], '0.12.0'), false);
  });

  test('--confirm for a different version: refused, even though the flag is present', () => {
    // Guards against a stale confirmation typed for an earlier release being
    // reused by copying an old command rather than deciding about this one.
    assert.strictEqual(hasPublishConfirmation(['publish', '0.12.0', '--confirm', '0.11.8'], '0.12.0'), false);
  });

  test('--confirm matching the version exactly: allowed', () => {
    assert.strictEqual(hasPublishConfirmation(['publish', '0.12.0', '--confirm', '0.12.0'], '0.12.0'), true);
  });

  test('a prefix match is not a match: "0.12.0" must not satisfy "0.12.00" or vice versa', () => {
    assert.strictEqual(hasPublishConfirmation(['publish', '0.12.00', '--confirm', '0.12.0'], '0.12.00'), false);
  });
});

describe('the gh transport encodes values by type', () => {
  // The publish tests inject a fake api, so nothing exercised the real
  // argument construction. That is exactly where the bug was: strings were
  // JSON.stringify'd and passed through -F, so tag_name arrived as "v0.11.7"
  // WITH quote marks and the release's tag binding became garbage. It was
  // caught while publishing 0.11.7, by the verification in publishRelease,
  // which is the only reason it did not ship that way.
  test('a string is sent raw through -f, not quoted through -F', () => {
    const args = ghApiArgs('PATCH', 'repos/o/r/releases/1', { tag_name: 'v0.11.7' });
    assert.ok(args.includes('-f'), 'strings go through -f');
    assert.ok(args.includes('tag_name=v0.11.7'), `expected a bare value, got: ${args.join(' ')}`);
    assert.ok(!args.some(a => a.includes('"')), `no argument should carry quote marks: ${args.join(' ')}`);
  });

  test('a boolean keeps its type through -F', () => {
    // draft=false has to arrive as a boolean, not as the word "false", or the
    // release never leaves draft.
    const args = ghApiArgs('PATCH', 'repos/o/r/releases/1', { draft: false });
    assert.ok(args.includes('-F'), 'non-strings go through -F');
    assert.ok(args.includes('draft=false'));
  });

  test('a mixed body encodes each value by its own type', () => {
    const args = ghApiArgs('PATCH', 'repos/o/r/releases/1', { tag_name: 'v1.2.3', draft: false });
    const joined = args.join(' ');
    assert.match(joined, /-f tag_name=v1\.2\.3/);
    assert.match(joined, /-F draft=false/);
  });
});

// THE NOTES AND THE BUILD MUST DESCRIBE THE SAME WORK.
//
// 0.13.3 was tagged, a desktop build was made from it, and then seven pull
// requests merged. The tag still existed, the draft still existed, main CI was
// green, the version was right and the changelog on main was accurate. Running
// publish at that point would have shipped a two-day-old binary under notes
// describing every fix it did not contain, which is worse than shipping nothing:
// the notes read as a lie rather than an oversight. It was caught by looking,
// not by any check, and nothing in publish would have stopped it.
describe('publish refuses when the notes and the build have drifted apart', () => {
  const NOTES_V1 = '# Changelog\n\n## 0.9.9: First Cut\n\n### Fixed\n\n- **One thing:** it was fixed.\n\n## 0.9.8: Before\n\n- old\n';
  const NOTES_V2 = '# Changelog\n\n## 0.9.9: First Cut\n\n### Fixed\n\n- **One thing:** it was fixed.\n- **Another thing:** fixed after the tag was cut.\n\n## 0.9.8: Before\n\n- old\n';

  function gitReturning({ atTag, atMain, tagSha = 'aaaaaaaaa', mainSha = 'bbbbbbbbb', ahead = '7' }) {
    return (args) => {
      const a = args.join(' ');
      if (a.startsWith('fetch')) return '';
      if (a === 'show v0.9.9:CHANGELOG.md') {
        if (atTag === null) { const e = new Error('unknown revision'); throw e; }
        return atTag;
      }
      if (a === 'show origin/main:CHANGELOG.md') return atMain;
      if (a.startsWith('rev-parse v0.9.9')) return tagSha + '\n';
      if (a === 'rev-parse origin/main') return mainSha + '\n';
      if (a.startsWith('rev-list --count')) return ahead + '\n';
      return '';
    };
  }

  test('identical notes pass, which is the healthy release', () => {
    let said = null;
    requireNotesMatchBuild('0.9.9', { git: gitReturning({ atTag: NOTES_V1, atMain: NOTES_V1 }), log: (s, m) => { said = m; } });
    assert.match(said, /match/i, 'it says so rather than passing in silence');
  });

  test('notes changed after the tag was cut is refused', () => {
    assert.throws(
      () => requireNotesMatchBuild('0.9.9', { git: gitReturning({ atTag: NOTES_V1, atMain: NOTES_V2 }), log: () => {} }),
      /differ/i,
      'this is the 0.13.3 shape: the build predates work the notes describe');
  });

  test('the refusal names both commits and how far apart they are', () => {
    // An error that says only "something is wrong" sends a person to read the
    // script. This one has to be actionable at 3pm on a release day.
    try {
      requireNotesMatchBuild('0.9.9', {
        git: gitReturning({ atTag: NOTES_V1, atMain: NOTES_V2, tagSha: 'de15cd4e0', mainSha: '4ab416fe5', ahead: '7' }),
        log: () => {},
      });
      assert.fail('should have refused');
    } catch (err) {
      assert.match(err.message, /de15cd4e0/, 'the commit the build came from');
      assert.match(err.message, /4ab416fe5/, 'and what main is at');
      assert.match(err.message, /7 commit/, 'and the distance between them');
      assert.match(err.message, /delete the tag/i, 'and how to recover, which is what someone will need next');
    }
  });

  test('a tag cut before the changelog was promoted is refused, with that reason', () => {
    const noSection = '# Changelog\n\n## Unreleased\n\n- something\n';
    assert.throws(
      () => requireNotesMatchBuild('0.9.9', { git: gitReturning({ atTag: noSection, atMain: NOTES_V1 }), log: () => {} }),
      /no "## 0\.9\.9:" section/,
      'the build carries no notes at all, which is a different fault and says so');
  });

  test('a tag that does not exist is refused, rather than read as a match', () => {
    assert.throws(
      () => requireNotesMatchBuild('0.9.9', { git: gitReturning({ atTag: null, atMain: NOTES_V1 }), log: () => {} }),
      /Does the tag exist/,
      'a missing tag must not fall through to a comparison of nothing with nothing');
  });

  test('NOTHING is published when the check refuses', () => {
    // The load-bearing one. A publish is not reversible, so the guard has to run
    // before the first API call, not merely before the draft flip.
    const calls = [];
    const api = (method, apiPath, body) => { calls.push({ method, apiPath, body }); return {}; };
    assert.throws(() => publishRelease('0.9.9', {
      api,
      log: () => {},
      checkNotes: () => { throw new Error('notes differ'); },
    }), /notes differ/);
    assert.deepStrictEqual(calls, [], 'not one API call was made: no release was read, bound, or flipped');
  });
});
