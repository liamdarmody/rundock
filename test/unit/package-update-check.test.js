'use strict';
// Checking a package for an update, at the wire. Git runs off the handler,
// one package at a time, and a result is reused for an hour; a package
// installed at a commit or from a local folder is answered without asking
// git at all. The tag lister itself is proved against a real repository.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const handlers = require('../../lib/protocol/handlers/packages.js');
const { listTagCommitsWithGit } = require('../../lib/packages/extension-source.js');
const { RECEIPTS_DIR } = require('../../lib/packages/extension-manage.js');
const config = require('../../lib/config.js');
const { makeTempDir } = require('../helpers/workspace.js');

const URL = 'https://github.com/someone/pack';
const C = (n) => String(n).repeat(40);

function captureWs() {
  return { readyState: 1, sent: [], send(raw) { this.sent.push(JSON.parse(raw)); } };
}

function installed(root, id, reference, commit) {
  const dir = path.join(root, ...RECEIPTS_DIR.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${Buffer.from(id).toString('hex')}.json`), JSON.stringify({
    schema: 'rundock.package-import-receipt/v1', source: { id, reference, ...(commit ? { commit } : {}) },
    appliedAt: '2026-09-01T09:00:00.000Z', items: [],
  }));
}

async function withChecks(lister, fn) {
  const root = makeTempDir('check-ws-');
  const previousWorkspace = config.getWorkspace();
  config.setWorkspace(root);
  const previous = handlers.wireExtensionDeps({ listTagCommits: lister });
  handlers.resetPackageCheckCache();
  try { await fn(root); } finally {
    handlers.wireExtensionDeps(previous);
    config.setWorkspace(previousWorkspace);
  }
}

describe('check_package_update', () => {
  test('answers with the newer tags, and a second check inside the hour asks git nothing', async () => {
    let calls = 0;
    await withChecks(async () => { calls += 1; return [{ name: 'v1.0.0', commit: C(1) }, { name: 'v1.1.0', commit: C(2) }]; }, async (root) => {
      installed(root, URL, 'v1.0.0', C(1));
      const sock = captureWs();
      await handlers.handleCheckPackageUpdate({}, sock, { type: 'check_package_update', source: URL });
      assert.deepStrictEqual(sock.sent[0], {
        type: 'package_update_status', operation: 'package-update-check', token: null,
        id: URL, outcome: 'newer-available', current: 'v1.0.0', newer: ['v1.1.0'], moved: null,
      });
      await handlers.handleCheckPackageUpdate({}, sock, { type: 'check_package_update', source: URL });
      assert.strictEqual(calls, 1, 'the cached listing answered the second check');
      assert.strictEqual(sock.sent[2].outcome, 'newer-available');
    });
  });

  test('after an hour the listing is asked for again', async () => {
    let calls = 0;
    let clock = 1000;
    await withChecks(async () => { calls += 1; return []; }, async (root) => {
      const previous = handlers.wireExtensionDeps({ now: () => clock });
      try {
        installed(root, URL, 'v1.0.0', C(1));
        const sock = captureWs();
        await handlers.handleCheckPackageUpdate({}, sock, { type: 'check_package_update', source: URL });
        clock += 59 * 60 * 1000;
        await handlers.handleCheckPackageUpdate({}, sock, { type: 'check_package_update', source: URL });
        assert.strictEqual(calls, 1);
        clock += 2 * 60 * 1000;
        await handlers.handleCheckPackageUpdate({}, sock, { type: 'check_package_update', source: URL });
        assert.strictEqual(calls, 2);
      } finally {
        handlers.wireExtensionDeps({ now: previous.now });
      }
    });
  });

  test('two windows checking at once still run git one call at a time', async () => {
    let running = 0;
    let most = 0;
    await withChecks(async () => {
      running += 1; most = Math.max(most, running);
      await new Promise((r) => setImmediate(r));
      running -= 1;
      return [];
    }, async (root) => {
      installed(root, URL, 'v1.0.0', C(1));
      installed(root, 'https://github.com/someone/other', 'v2.0.0', C(2));
      await Promise.all([
        handlers.handleCheckPackageUpdate({}, captureWs(), { type: 'check_package_update', source: URL }),
        handlers.handleCheckPackageUpdate({}, captureWs(), { type: 'check_package_update', source: 'https://github.com/someone/other' }),
      ]);
      assert.strictEqual(most, 1);
    });
  });

  test('the handler returns before git answers, and replies when it does', async () => {
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    await withChecks(() => pending, async (root) => {
      installed(root, URL, 'v1.0.0', C(1));
      const sock = captureWs();
      const done = handlers.handleCheckPackageUpdate({}, sock, { type: 'check_package_update', source: URL });
      assert.strictEqual(sock.sent.length, 0, 'nothing is sent while git is still running');
      release([{ name: 'v1.0.0', commit: C(1) }]);
      await done;
      assert.strictEqual(sock.sent[0].outcome, 'up-to-date');
    });
  });

  test('checks run one package at a time', async () => {
    let running = 0;
    let most = 0;
    await withChecks(async () => {
      running += 1; most = Math.max(most, running);
      await new Promise((r) => setImmediate(r));
      running -= 1;
      return [];
    }, async (root) => {
      installed(root, URL, 'v1.0.0', C(1));
      installed(root, 'https://github.com/someone/other', 'v2.0.0', C(2));
      const sock = captureWs();
      await handlers.handleCheckPackageUpdate({}, sock, { type: 'check_package_update' });
      assert.deepStrictEqual(sock.sent.map((m) => m.type), ['package_update_status', 'package_update_status', 'package_update_checked'],
        'with no source named, every installed package is checked, and the end of the check is said');
      assert.strictEqual(most, 1);
    });
  });

  test('a package installed at a commit, or from a folder, is answered without asking git', async () => {
    await withChecks(async () => { throw new Error('git must not run'); }, async (root) => {
      installed(root, URL, null, C(1));
      installed(root, '/Users/me/pack', null);
      const sock = captureWs();
      await handlers.handleCheckPackageUpdate({}, sock, { type: 'check_package_update' });
      assert.deepStrictEqual(sock.sent.filter((m) => m.outcome).map((m) => m.outcome).sort(), ['no-release', 'not-updatable']);
    });
  });

  test('an unknown package, and a git failure, are named refusals on the package that asked', async () => {
    await withChecks(async () => { throw Object.assign(new Error('could not reach the repository'), { code: 'acquire-failed' }); }, async (root) => {
      installed(root, URL, 'v1.0.0', C(1));
      const sock = captureWs();
      await handlers.handleCheckPackageUpdate({}, sock, { type: 'check_package_update', source: 'https://github.com/nobody/here' });
      await handlers.handleCheckPackageUpdate({}, sock, { type: 'check_package_update', source: URL });
      assert.deepStrictEqual(sock.sent.map((m) => [m.type, m.operation, m.id]), [
        ['package_install_error', 'package-update-check', 'https://github.com/nobody/here'],
        ['package_update_checked', 'package-update-check', 'https://github.com/nobody/here'],
        ['package_install_error', 'package-update-check', URL],
        ['package_update_checked', 'package-update-check', URL],
      ]);
      assert.match(sock.sent[2].message, /could not reach/);
    });
  });
});

describe('the end of a check is said, even when there was nothing to check', () => {
  test('a workspace with no packages is answered with the end marker alone', async () => {
    await withChecks(async () => { throw new Error('git must not run'); }, async () => {
      const sock = captureWs();
      await handlers.handleCheckPackageUpdate({}, sock, { type: 'check_package_update' });
      assert.deepStrictEqual(sock.sent, [{ type: 'package_update_checked', operation: 'package-update-check', token: null, id: null, count: 0 }]);
    });
  });
});

describe('listTagCommitsWithGit', () => {
  test('reports each tag with the commit it resolves to, annotated or not', async () => {
    const repo = makeTempDir('tags-repo-');
    const git = (...args) => execFileSync('git', args, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString().trim();
    git('init', '--quiet');
    fs.writeFileSync(path.join(repo, 'a.md'), 'a');
    git('add', '.');
    git('commit', '--quiet', '-m', 'one');
    const first = git('rev-parse', 'HEAD');
    git('tag', 'v1.0.0');
    git('tag', '-a', 'v1.1.0', '-m', 'annotated');
    const tags = await listTagCommitsWithGit(repo);
    assert.deepStrictEqual(tags.sort((a, b) => (a.name < b.name ? -1 : 1)), [
      { name: 'v1.0.0', commit: first },
      { name: 'v1.1.0', commit: first },
    ], 'the annotated tag reports its commit, never its tag object');
  });
});

// The check at the wire, with the real tag lister reading a real repository,
// so what is compared is exactly what git reports for an annotated tag.
function tagRepo() {
  const repo = makeTempDir('tags-repo-');
  const git = (...args) => execFileSync('git', args, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString().trim();
  git('init', '--quiet');
  fs.writeFileSync(path.join(repo, 'a.md'), 'a');
  git('add', '.');
  git('commit', '--quiet', '-m', 'one');
  return { repo, git };
}

describe('the check against a real repository', () => {
  test('an annotated tag is compared on its commit: unmoved it is up to date, and moved it is named with the commit it moved to', async () => {
    const { repo, git } = tagRepo();
    const first = git('rev-parse', 'HEAD');
    git('tag', '-a', 'v1.1.0', '-m', 'annotated');
    await withChecks(() => listTagCommitsWithGit(repo), async (root) => {
      installed(root, URL, 'v1.1.0', first);
      const sock = captureWs();
      await handlers.handleCheckPackageUpdate({}, sock, { type: 'check_package_update', source: URL });
      assert.strictEqual(sock.sent[0].outcome, 'up-to-date');
      assert.strictEqual(sock.sent[0].moved, null, 'an annotated tag still on the installed commit has not moved');
      fs.writeFileSync(path.join(repo, 'a.md'), 'b');
      git('commit', '--quiet', '-am', 'two');
      const second = git('rev-parse', 'HEAD');
      git('tag', '-f', '-a', 'v1.1.0', '-m', 'moved');
      handlers.resetPackageCheckCache();
      const again = captureWs();
      await handlers.handleCheckPackageUpdate({}, again, { type: 'check_package_update', source: URL });
      assert.deepStrictEqual(again.sent[0].moved, { tag: 'v1.1.0', was: first, now: second },
        'the moved tag is named with the commit it now resolves to, never its tag object');
    });
  });

  test('git runs off the handler: no reply is ready until the event loop turns and git answers', async () => {
    const { repo, git } = tagRepo();
    git('tag', 'v1.0.0');
    await withChecks(() => listTagCommitsWithGit(repo), async (root) => {
      installed(root, URL, 'v1.0.0', git('rev-parse', 'HEAD'));
      const sock = captureWs();
      const done = handlers.handleCheckPackageUpdate({}, sock, { type: 'check_package_update', source: URL });
      // Microtasks alone cannot deliver an answer from a child process; a
      // reply that appears here came from git run on the server's own thread.
      for (let i = 0; i < 100; i += 1) await Promise.resolve();
      assert.strictEqual(sock.sent.length, 0, 'git answered without the event loop turning, so it held the server');
      await done;
      assert.strictEqual(sock.sent[0].outcome, 'up-to-date');
    });
  });
});
