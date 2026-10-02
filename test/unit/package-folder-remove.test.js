'use strict';
// A DOWNLOADED PACKAGE FOLDER IS REMOVED WHATEVER ITS FILES' PERMISSIONS, AND
// A CLEAN-UP THAT FAILS NEVER HIDES THE REAL ERROR.
//
// git marks the pack files it writes as read-only. On Windows, the desktop
// app's runtime refused to delete a read-only file, so removing the fetched
// package's `.git` failed with EPERM; the clean-up that followed failed the
// same way and threw over the readable error, and no package could be added
// on Windows at all. The folder is now made writable before it is removed,
// with a short retry for a file something else briefly holds, and the
// clean-up of a downloaded folder is best-effort: it says what it could not
// remove and carries on.
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { removeDownloadedFolder } = require('../../lib/packages/remove-folder.js');
const source = require('../../lib/packages/extension-source.js');

const made = [];
afterEach(() => {
  for (const d of made.splice(0)) {
    try { execFileSync('chmod', ['-R', 'u+w', d]); } catch (e) { /* not on this platform */ }
    fs.rmSync(d, { recursive: true, force: true });
  }
});
function temp(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.push(d); return d; }

// A tree shaped like a fetched repository: read-only files, as git leaves its
// pack files, inside a read-only folder.
function readOnlyTree() {
  const root = temp('remove-folder-');
  const pack = path.join(root, '.git', 'objects', 'pack');
  fs.mkdirSync(pack, { recursive: true });
  for (const name of ['pack-1.pack', 'pack-1.idx']) {
    fs.writeFileSync(path.join(pack, name), 'bytes');
    fs.chmodSync(path.join(pack, name), 0o444);
  }
  fs.writeFileSync(path.join(root, 'README.md'), 'hello');
  fs.chmodSync(path.join(root, 'README.md'), 0o444);
  fs.chmodSync(pack, 0o555);
  return root;
}

describe('removing a downloaded package folder', () => {
  test('a tree of read-only files in a read-only folder is removed completely', () => {
    const root = readOnlyTree();
    removeDownloadedFolder(root);
    assert.strictEqual(fs.existsSync(root), false);
  });

  test('which a plain recursive remove cannot do', { skip: process.platform === 'win32' && 'Windows reports this through the read-only attribute instead' }, () => {
    const root = readOnlyTree();
    assert.throws(() => fs.rmSync(root, { recursive: true, force: true }), /EACCES|EPERM|ENOTEMPTY/);
  });

  test('a link inside is removed, and what it points to is left alone', { skip: process.platform === 'win32' && 'links need privileges on Windows' }, () => {
    const root = readOnlyTree();
    const outside = temp('remove-folder-outside-');
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
    fs.chmodSync(path.join(outside, 'keep.txt'), 0o444);
    fs.chmodSync(path.join(root, '.git'), 0o755);
    fs.symlinkSync(outside, path.join(root, '.git', 'link'));
    removeDownloadedFolder(root);
    assert.strictEqual(fs.existsSync(root), false);
    assert.strictEqual(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
    assert.strictEqual(fs.statSync(path.join(outside, 'keep.txt')).mode & 0o777, 0o444, 'its permissions are not touched');
  });

  test('a file briefly held is retried, and a folder that is already gone is fine', () => {
    const root = temp('remove-folder-held-');
    let calls = 0;
    const rm = (p, o) => {
      calls++;
      if (calls < 3) { const e = new Error('EBUSY: resource busy or locked'); e.code = 'EBUSY'; throw e; }
      fs.rmSync(p, o);
    };
    removeDownloadedFolder(root, { rm, delayMs: 1 });
    assert.strictEqual(calls, 3);
    assert.strictEqual(fs.existsSync(root), false);
    removeDownloadedFolder(root);
  });

  test('a failure that is not a hold is not retried, and is thrown', () => {
    const root = temp('remove-folder-fail-');
    let calls = 0;
    const rm = () => { calls++; const e = new Error('EINVAL: nope'); e.code = 'EINVAL'; throw e; };
    assert.throws(() => removeDownloadedFolder(root, { rm, delayMs: 1 }), /EINVAL/);
    assert.strictEqual(calls, 1);
  });
});

describe('clean-up of a downloaded package never hides the real error', () => {
  const failing = () => { const e = new Error('EPERM, Permission denied: rundock-ext-TEST'); e.code = 'EPERM'; throw e; };

  test('discarding a snapshot that cannot be removed says so and carries on', () => {
    const dir = temp('rundock-ext-discard-');
    const warned = [];
    const warn = console.warn;
    const prev = source.wireAcquisitionRemoval(failing);
    console.warn = (...a) => warned.push(a.join(' '));
    try {
      assert.doesNotThrow(() => source.discardAcquisition(dir));
    } finally { console.warn = warn; source.wireAcquisitionRemoval(prev); }
    assert.ok(warned.some((w) => w.includes(dir) && /EPERM/.test(w)), JSON.stringify(warned));
  });

  test('discarding a snapshot with read-only files removes it completely', () => {
    const root = readOnlyTree();
    source.discardAcquisition(root);
    assert.strictEqual(fs.existsSync(root), false);
  });

  test('a failed fetch refuses with its own readable error, whatever the clean-up does', () => {
    const repo = temp('remove-folder-repo-');
    execFileSync('git', ['init', '--quiet'], { cwd: repo });
    const prev = source.wireAcquisitionRemoval(failing);
    const warn = console.warn;
    console.warn = () => {};
    let caught;
    try {
      source.acquireWithGit({ url: repo, reference: 'v0.0.0-does-not-exist' });
    } catch (e) { caught = e; } finally { console.warn = warn; source.wireAcquisitionRemoval(prev); }
    assert.ok(caught, 'refused');
    assert.strictEqual(caught.code, 'acquire-failed');
    assert.match(caught.message, /could not fetch .* at v0\.0\.0-does-not-exist/);
    assert.doesNotMatch(caught.message, /EPERM/, 'the clean-up failure does not replace it');
    for (const n of fs.readdirSync(os.tmpdir()).filter((x) => x.startsWith('rundock-ext-'))) made.push(path.join(os.tmpdir(), n));
  });

  test('removing the fetched .git goes through the same Windows-safe removal', () => {
    const removed = [];
    const prev = source.wireAcquisitionRemoval((p) => { removed.push(p); removeDownloadedFolder(p); });
    const repo = temp('remove-folder-repo2-');
    const git = (args) => execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
    git(['init', '--quiet']); git(['config', 'user.email', 'test@example.com']); git(['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a'); git(['add', '.']); git(['commit', '--quiet', '-m', 'one']); git(['tag', 'v1.0.0']);
    let snapshot;
    try { snapshot = source.acquireWithGit({ url: repo, reference: 'v1.0.0' }); } finally { source.wireAcquisitionRemoval(prev); }
    made.push(snapshot);
    assert.deepStrictEqual(removed, [path.join(snapshot, '.git')]);
    assert.strictEqual(fs.existsSync(path.join(snapshot, '.git')), false);
  });
});
