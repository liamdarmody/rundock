'use strict';
// The release gate: one command validates the candidate, and the tag refuses
// to move without it.
//
// Why this exists: 0.11.6 took SIX cuts because candidate testing happened
// after tagging; the draft build was the convenient test vehicle, so
// cut-test-recut became the loop. The gate inverts the train: the full
// gauntlet runs against HEAD, records the SHA it passed on, and
// scripts/release.js refuses to tag any other SHA. The publish subcommand
// additionally mechanises the 0.11.6 publish quirk: a draft can sit on an
// `untagged-*` tag_name after a recut, and flipping draft=false in that state
// binds the release to the junk tag forever. Publishing must bind tag_name
// FIRST, verify it stuck, and only then flip the draft flag.

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  runGate,
  readGateRecord,
  versionSanity,
  changelogReady,
  GATE_FILE_NAME,
} = require('../../scripts/release-gate.js');
const { requireGatePass, publishRelease } = require('../../scripts/release.js');

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-gate-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

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

const GOOD_CHANGELOG = `# Changelog

## Unreleased

**Name:** Foundations

### Changed

- Something user visible.

## 0.11.6: Team Integrity (2026-08-11)

- Older notes.
`;

function seedWorkspace({ version = '0.11.6', changelog = GOOD_CHANGELOG } = {}) {
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version }, null, 2));
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), changelog);
}

describe('release gate: preconditions', () => {
  test('version sanity: package.json must match the latest tag (no half-done bump)', () => {
    assert.doesNotThrow(() => versionSanity('0.11.6', 'v0.11.6'));
    assert.throws(() => versionSanity('0.11.7', 'v0.11.6'), /0\.11\.7[\s\S]*v0\.11\.6/);
    assert.throws(() => versionSanity('not-semver', 'v0.11.6'), /semver/i);
  });

  test('changelog readiness: an Unreleased section with a Name line and real content', () => {
    assert.doesNotThrow(() => changelogReady(GOOD_CHANGELOG));
    assert.throws(
      () => changelogReady('# Changelog\n\n## 0.11.6: Team Integrity (2026-08-11)\n\n- Old.\n'),
      /Unreleased/
    );
    assert.throws(
      () => changelogReady('# Changelog\n\n## Unreleased\n\n### Changed\n\n- A thing.\n\n## 0.11.6: X (2026-08-11)\n'),
      /Name/
    );
    assert.throws(
      () => changelogReady('# Changelog\n\n## Unreleased\n\n**Name:** Foundations\n\n## 0.11.6: X (2026-08-11)\n'),
      /empty|content/i
    );
  });
});

describe('release gate: the run', () => {
  test('a green run writes the record: SHA, wall clock, per-step timings, live flag', async () => {
    seedWorkspace();
    const exec = fakeExec({
      'rev-parse HEAD': 'abc123def\n',
      'describe --tags': 'v0.11.6\n',
    });
    const result = await runGate({ root, live: true, exec });
    assert.strictEqual(result.ok, true);

    const record = readGateRecord(root);
    assert.ok(record, 'gate record written');
    assert.strictEqual(record.sha, 'abc123def');
    assert.strictEqual(record.live, true);
    assert.strictEqual(typeof record.wallClockSeconds, 'number');
    assert.ok(Array.isArray(record.steps) && record.steps.length > 0, 'steps recorded');
    for (const step of record.steps) {
      assert.strictEqual(typeof step.name, 'string');
      assert.strictEqual(typeof step.seconds, 'number');
    }
    assert.ok(!Number.isNaN(Date.parse(record.passedAt)), 'passedAt is a real timestamp');
  });

  test('the gauntlet is complete: suite+coverage, e2e, smoke stub, smoke live, hygiene, packaging', async () => {
    seedWorkspace();
    const exec = fakeExec({
      'rev-parse HEAD': 'abc123def\n',
      'describe --tags': 'v0.11.6\n',
    });
    await runGate({ root, live: true, exec });
    const joined = exec.calls.join('\n');
    assert.match(joined, /test:coverage/, 'suite runs WITH coverage');
    assert.match(joined, /test:e2e/, 'e2e runs');
    assert.match(joined, /smoke/, 'stub smoke runs');
    assert.match(joined, /--live/, 'live smoke runs');
    assert.match(joined, /check:refs/, 'hygiene gate runs');
    assert.match(joined, /stream:truth/, 'stream-truth check runs (stub vs captured runtime)');
    assert.match(joined, /typecheck/, 'both tsc configs run');
    assert.match(joined, /smoke-packaged/, 'packaging runs (unsigned unpacked build + boot check)');
  });

  test('a dirty tree refuses to gate: the record must describe a reproducible SHA', async () => {
    seedWorkspace();
    const exec = fakeExec({
      'status --porcelain': ' M server.js\n',
      'rev-parse HEAD': 'abc123def\n',
      'describe --tags': 'v0.11.6\n',
    });
    const result = await runGate({ root, live: true, exec });
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /clean|dirty|uncommitted/i);
    assert.strictEqual(readGateRecord(root), null, 'no record for an ungateable state');
  });

  test('a failing step means no record', async () => {
    seedWorkspace();
    const exec = fakeExec({
      'rev-parse HEAD': 'abc123def\n',
      'describe --tags': 'v0.11.6\n',
      'test:coverage': new Error('suite failed'),
    });
    const result = await runGate({ root, live: true, exec });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(readGateRecord(root), null);
  });

  test('--no-live is recorded honestly so the release step can refuse it', async () => {
    seedWorkspace();
    const exec = fakeExec({
      'rev-parse HEAD': 'abc123def\n',
      'describe --tags': 'v0.11.6\n',
    });
    await runGate({ root, live: false, exec });
    const record = readGateRecord(root);
    assert.strictEqual(record.live, false);
    assert.ok(!exec.calls.join('\n').includes('--live'), 'live smoke not run');
  });
});

describe('release refuses to tag without a gate pass on HEAD', () => {
  test('no gate record: fails naming the command to run', () => {
    seedWorkspace();
    assert.throws(
      () => requireGatePass('abc123def', { root }),
      /release:gate/
    );
  });

  test('gate passed on a different SHA: fails naming both SHAs', () => {
    seedWorkspace();
    fs.writeFileSync(path.join(root, GATE_FILE_NAME), JSON.stringify({
      sha: 'oldsha111', live: true, passedAt: '2026-08-11T09:00:00Z', wallClockSeconds: 900, steps: [],
    }));
    assert.throws(
      () => requireGatePass('newsha222', { root }),
      /oldsha111[\s\S]*newsha222|newsha222[\s\S]*oldsha111/
    );
  });

  test('gate passed without live smoke: refused', () => {
    seedWorkspace();
    fs.writeFileSync(path.join(root, GATE_FILE_NAME), JSON.stringify({
      sha: 'abc123def', live: false, passedAt: '2026-08-11T09:00:00Z', wallClockSeconds: 900, steps: [],
    }));
    assert.throws(
      () => requireGatePass('abc123def', { root }),
      /live/i
    );
  });

  test('gate passed on HEAD with live smoke: proceeds', () => {
    seedWorkspace();
    fs.writeFileSync(path.join(root, GATE_FILE_NAME), JSON.stringify({
      sha: 'abc123def', live: true, passedAt: '2026-08-11T09:00:00Z', wallClockSeconds: 900, steps: [],
    }));
    assert.doesNotThrow(() => requireGatePass('abc123def', { root }));
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

  const DRAFT_ON_JUNK_TAG = {
    id: 42, draft: true, name: '0.11.7: Foundations', tag_name: 'untagged-9f2a',
  };
  const OLD_PUBLISHED = {
    id: 7, draft: false, name: '0.11.6: Team Integrity', tag_name: 'v0.11.6',
  };

  test('the 0.11.6 quirk, mechanised away: tag_name is patched and verified BEFORE draft=false', () => {
    const api = fakeApi({ releases: [OLD_PUBLISHED, DRAFT_ON_JUNK_TAG] });
    const result = publishRelease('0.11.7', { api });

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
    assert.throws(() => publishRelease('0.11.7', { api }), /tag/i);
    assert.ok(
      !api.calls.some(c => c.method === 'PATCH' && c.body && c.body.draft === false),
      'no draft flip after a failed tag bind'
    );
  });

  test('the right draft is found even when its tag_name is junk (matched by name)', () => {
    const api = fakeApi({ releases: [OLD_PUBLISHED, DRAFT_ON_JUNK_TAG] });
    publishRelease('0.11.7', { api });
    const tagPatch = api.calls.find(c => c.method === 'PATCH' && c.body && c.body.tag_name);
    assert.ok(tagPatch.path.includes('/releases/42'));
  });

  test('no matching draft is an error naming the version', () => {
    const api = fakeApi({ releases: [OLD_PUBLISHED] });
    assert.throws(() => publishRelease('0.11.7', { api }), /0\.11\.7/);
  });

  test('a draft already on the right tag still publishes (idempotent bind)', () => {
    const api = fakeApi({ releases: [{ id: 42, draft: true, name: '0.11.7: Foundations', tag_name: 'v0.11.7' }] });
    const result = publishRelease('0.11.7', { api });
    assert.strictEqual(result.tag, 'v0.11.7');
    assert.ok(api.calls.some(c => c.method === 'PATCH' && c.body && c.body.draft === false));
  });
});
