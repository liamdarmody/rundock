'use strict';
// A save that cannot be written whole puts back what the file held, where it
// can, and is answered as failed, never as saved.
//
// One write call may write fewer bytes than it is handed: a nearly full
// drive, or a limit on file size, stops it part way, and the only sign is the
// count it returns. Both functions that replace a file in place used to open
// it truncated and make one call, so a cut-short save left a cut file on disk
// behind a "Saved". Here the system call is swapped for scripted ones that
// take a few bytes at a time (writing them for real, where they were asked
// to), that write some and then report a full drive, or that write nothing;
// each save is then read back from disk and from what its handler sent.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const config = require('../../lib/config.js');
const { writeFileNoFollow } = require('../../lib/workspace/link-safe-write.js');
const { writeExtensionFile } = require('../../lib/workspace/extension-file.js');
const files = require('../../lib/protocol/handlers/files.js');
const sources = require('../../lib/protocol/handlers/sources.js');
const { makeTempDir } = require('../helpers/workspace.js');

const realWriteSync = fs.writeSync;

// The old content: under 512 bytes, and ending in a byte that is not UTF-8,
// so only a byte-for-byte restore puts it back. The new content: well over
// 512 bytes, with characters of two, three and four bytes, so a cut can land
// inside one.
const BEFORE = Buffer.concat([Buffer.from('original,'.repeat(40)), Buffer.from([0xe9, 0x0a])]);
const AFTER = 'new,é,€,\u{1F600}\n'.repeat(150);
const NOTE = '---\nportfolio-dashboard: true\nsources:\n  - notes/a.csv\n---\n# D\n';

let previousWorkspace;
before(() => { previousWorkspace = config.getWorkspace(); });
after(() => { config.setWorkspace(previousWorkspace); });

function workspace() {
  const dir = fs.realpathSync(makeTempDir('short-write-'));
  fs.mkdirSync(path.join(dir, 'notes'));
  fs.writeFileSync(path.join(dir, 'notes', 'a.csv'), BEFORE);
  fs.writeFileSync(path.join(dir, 'dash.md'), NOTE);
  config.setWorkspace(dir);
  return dir;
}

const onDisk = (dir) => fs.readFileSync(path.join(dir, 'notes', 'a.csv'));

function socket() {
  const sent = [];
  return { sent, readyState: 1, send: (m) => sent.push(JSON.parse(m)) };
}

const ctx = {
  workspace: {
    isInsideWorkspace: () => true, isWritableInWorkspace: () => true,
    invalidateFileListCache() {}, invalidateFileTreeCache() {},
  },
  store: { ensureSearchEngine: () => null },
};

function systemError(code, words) {
  return Object.assign(new Error(`${code}: ${words}, write`), { code, syscall: 'write' });
}
const enospc = () => systemError('ENOSPC', 'no space left on device');

// The bytes one call was handed, in either shape fs.writeSync takes: a string
// with its encoding, or a buffer with an offset and a length.
function handed(buffer, offset, length) {
  if (typeof buffer === 'string') return Buffer.from(buffer, typeof length === 'string' ? length : 'utf8');
  const start = offset || 0;
  return buffer.subarray(start, length == null ? buffer.length : start + length);
}

// fs.writeSync, following a script. Each step is the most bytes that call
// really writes, at the position it was asked for (Infinity for all of
// them, 0 for none), or an error it throws instead; the last step repeats.
// A runaway loop is stopped with an error of its own rather than left to
// hang the suite. The standard streams pass straight through.
function scripted(...steps) {
  const stub = function writeSync(fd, buffer, offset, length, position) {
    if (fd <= 2) return realWriteSync.apply(fs, arguments);
    const step = steps[Math.min(stub.calls, steps.length - 1)];
    stub.calls += 1;
    if (stub.calls > 1000) throw new Error('the write was tried over a thousand times');
    if (step instanceof Error) throw step;
    const bytes = handed(buffer, offset, length);
    const at = typeof buffer === 'string' ? offset : position;
    return realWriteSync(fd, bytes, 0, Math.min(step, bytes.length), at);
  };
  stub.calls = 0;
  return stub;
}

describe('a write the system takes a few bytes at a time', () => {
  test('the editor\'s save leaves every byte on disk', (t) => {
    const dir = workspace();
    t.mock.method(fs, 'writeSync', scripted(7));
    writeFileNoFollow(path.join(dir, 'notes', 'a.csv'), AFTER);
    t.mock.restoreAll();
    assert.strictEqual(onDisk(dir).toString('utf8'), AFTER);
  });

  test('an extension\'s save leaves every byte on disk', (t) => {
    const dir = workspace();
    t.mock.method(fs, 'writeSync', scripted(7));
    const refusal = writeExtensionFile(dir, 'notes/a.csv', AFTER);
    t.mock.restoreAll();
    assert.strictEqual(refusal, null);
    assert.strictEqual(onDisk(dir).toString('utf8'), AFTER);
  });

  test('the editor\'s save through its handler is answered as saved, with every byte on disk', (t) => {
    const dir = workspace();
    const ws = socket();
    t.mock.method(fs, 'writeSync', scripted(7));
    files.handleSaveFile(ctx, ws, { path: 'notes/a.csv', content: AFTER });
    t.mock.restoreAll();
    assert.deepStrictEqual(ws.sent.map((m) => m.type), ['file_saved']);
    assert.strictEqual(onDisk(dir).toString('utf8'), AFTER);
  });
});

describe('a save that succeeds keeps the file itself', () => {
  test('the editor\'s save leaves the same file, with its permissions and its other names', () => {
    const dir = workspace();
    const file = path.join(dir, 'notes', 'a.csv');
    fs.chmodSync(file, 0o600);
    fs.linkSync(file, path.join(dir, 'notes', 'second-name.csv'));
    const was = fs.statSync(file);
    writeFileNoFollow(file, AFTER);
    const now = fs.statSync(file);
    assert.strictEqual(now.ino, was.ino, 'the same file, not a new one in its place');
    assert.strictEqual(now.mode, was.mode);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'notes', 'second-name.csv'), 'utf8'), AFTER, 'its other name sees the save');
  });

  test('an extension\'s save leaves the same file, with its permissions', () => {
    const dir = workspace();
    const file = path.join(dir, 'notes', 'a.csv');
    fs.chmodSync(file, 0o600);
    const was = fs.statSync(file);
    assert.strictEqual(writeExtensionFile(dir, 'notes/a.csv', AFTER), null);
    const now = fs.statSync(file);
    assert.strictEqual(now.ino, was.ino, 'the same file, not a new one in its place');
    assert.strictEqual(now.mode, was.mode);
    assert.strictEqual(onDisk(dir).toString('utf8'), AFTER);
  });
});

describe('a save shorter than what the file held', () => {
  test('both saves leave exactly the new bytes, with nothing of the old after them', () => {
    const dir = workspace();
    writeFileNoFollow(path.join(dir, 'notes', 'a.csv'), 'short\n');
    assert.strictEqual(onDisk(dir).toString('utf8'), 'short\n');
    fs.writeFileSync(path.join(dir, 'notes', 'a.csv'), BEFORE);
    assert.strictEqual(writeExtensionFile(dir, 'notes/a.csv', 'short\n'), null);
    assert.strictEqual(onDisk(dir).toString('utf8'), 'short\n');
  });
});

// The editor's save passes the page's content on as it arrived. Anything but
// text is refused before the file is touched: a list of numbers, or the shape
// a buffer takes in JSON, would otherwise be written as raw bytes.
describe('content that is not text', () => {
  for (const [name, content] of [
    ['a list of byte values', [104, 105, 10]],
    ['a buffer as JSON writes it', { type: 'Buffer', data: [104, 105, 10] }],
  ]) {
    test(`an editor save of ${name} is answered as failed, and the file is untouched`, () => {
      const dir = workspace();
      const ws = socket();
      files.handleSaveFile(ctx, ws, { path: 'notes/a.csv', content });
      assert.deepStrictEqual(ws.sent.map((m) => m.type), ['file_save_failed']);
      assert.ok(onDisk(dir).equals(BEFORE), 'nothing was written and nothing was emptied');
    });
  }
});

describe('a write the drive cuts short and then refuses', () => {
  test('both saves throw the system\'s own error and leave the file as it was', (t) => {
    const dir = workspace();
    t.mock.method(fs, 'writeSync', scripted(512, enospc(), Infinity));
    assert.throws(() => writeFileNoFollow(path.join(dir, 'notes', 'a.csv'), AFTER), { code: 'ENOSPC' });
    assert.ok(onDisk(dir).equals(BEFORE), 'the editor\'s save left the old bytes');
    t.mock.restoreAll();
    t.mock.method(fs, 'writeSync', scripted(512, enospc(), Infinity));
    assert.throws(() => writeExtensionFile(dir, 'notes/a.csv', AFTER), { code: 'ENOSPC' });
    assert.ok(onDisk(dir).equals(BEFORE), 'the extension\'s save left the old bytes');
  });

  test('the editor\'s save is answered as failed, never as saved', (t) => {
    const dir = workspace();
    const ws = socket();
    t.mock.method(fs, 'writeSync', scripted(512, enospc(), Infinity));
    files.handleSaveFile(ctx, ws, { path: 'notes/a.csv', content: AFTER });
    t.mock.restoreAll();
    assert.deepStrictEqual(ws.sent.map((m) => m.type), ['file_save_failed']);
    assert.match(ws.sent[0].message, /^Rundock couldn't save this file because the drive is full\./);
    assert.match(ws.sent[0].detail, /^ENOSPC/);
    assert.ok(onDisk(dir).equals(BEFORE));
  });

  test('a save an extension caused is answered as failed, never as saved', (t) => {
    const dir = workspace();
    const ws = socket();
    t.mock.method(fs, 'writeSync', scripted(512, enospc(), Infinity));
    files.handleSaveFile(ctx, ws, { path: 'notes/a.csv', content: AFTER, origin: 'extension' });
    t.mock.restoreAll();
    assert.deepStrictEqual(ws.sent.map((m) => m.type), ['file_save_failed']);
    assert.match(ws.sent[0].message, /because the drive is full\./);
    assert.ok(onDisk(dir).equals(BEFORE));
  });

  test('a view\'s save to a named source is answered as refused, never as saved', (t) => {
    const dir = workspace();
    const ws = socket();
    t.mock.method(fs, 'writeSync', scripted(512, enospc(), Infinity));
    sources.handleSaveSource(ctx, ws, { path: 'dash.md', source: 'notes/a.csv', content: AFTER });
    t.mock.restoreAll();
    assert.deepStrictEqual(ws.sent.map((m) => m.type), ['source_save_refused']);
    assert.match(ws.sent[0].reason, /because the drive is full\./);
    assert.match(ws.sent[0].detail, /^ENOSPC/);
    assert.ok(onDisk(dir).equals(BEFORE));
  });
});

describe('a restore that fails too', () => {
  test('the error thrown is still the one that stopped the save, marked as not put back', (t) => {
    const dir = workspace();
    const ws = socket();
    t.mock.method(fs, 'writeSync', scripted(512, enospc(), systemError('EBUSY', 'resource busy or locked')));
    let thrown = null;
    try { writeFileNoFollow(path.join(dir, 'notes', 'a.csv'), AFTER); } catch (e) { thrown = e; }
    assert.ok(thrown, 'the save threw');
    assert.strictEqual(thrown.code, 'ENOSPC');
    assert.strictEqual(thrown.restoreFailed, true);
    t.mock.restoreAll();
    fs.writeFileSync(path.join(dir, 'notes', 'a.csv'), BEFORE);
    t.mock.method(fs, 'writeSync', scripted(512, enospc(), systemError('EBUSY', 'resource busy or locked')));
    files.handleSaveFile(ctx, ws, { path: 'notes/a.csv', content: AFTER, origin: 'extension' });
    t.mock.restoreAll();
    assert.deepStrictEqual(ws.sent.map((m) => m.type), ['file_save_failed']);
    assert.match(ws.sent[0].message, /because the drive is full\./, 'the reason is the write\'s, not the restore\'s');
  });
});

describe('a write that makes no progress', () => {
  test('both saves throw rather than try again, and leave the file as it was', (t) => {
    const dir = workspace();
    t.mock.method(fs, 'writeSync', scripted(0, Infinity));
    assert.throws(() => writeFileNoFollow(path.join(dir, 'notes', 'a.csv'), AFTER), { code: 'EIO' });
    assert.ok(onDisk(dir).equals(BEFORE));
    t.mock.restoreAll();
    t.mock.method(fs, 'writeSync', scripted(0, Infinity));
    assert.throws(() => writeExtensionFile(dir, 'notes/a.csv', AFTER), { code: 'EIO' });
    assert.ok(onDisk(dir).equals(BEFORE));
  });

  test('a system that never takes a byte ends the save, the restore included', (t) => {
    const dir = workspace();
    const stub = scripted(0);
    t.mock.method(fs, 'writeSync', stub);
    let thrown = null;
    try { writeFileNoFollow(path.join(dir, 'notes', 'a.csv'), AFTER); } catch (e) { thrown = e; }
    assert.ok(thrown && thrown.code === 'EIO', 'the save threw its own error');
    assert.strictEqual(thrown.restoreFailed, true);
    assert.strictEqual(stub.calls, 2, 'one call for the save and one for the restore, each tried once');
  });

  test('the editor\'s save is answered as failed, in plain words', (t) => {
    workspace();
    const ws = socket();
    t.mock.method(fs, 'writeSync', scripted(0, Infinity));
    files.handleSaveFile(ctx, ws, { path: 'notes/a.csv', content: AFTER });
    t.mock.restoreAll();
    assert.deepStrictEqual(ws.sent.map((m) => m.type), ['file_save_failed']);
    assert.match(ws.sent[0].message, /^Rundock couldn't save this file because something unexpected went wrong\./);
    assert.match(ws.sent[0].detail, /^EIO/);
  });

  test('an empty save asks nothing of the system and is not an error', (t) => {
    const dir = workspace();
    t.mock.method(fs, 'writeSync', scripted(0));
    writeFileNoFollow(path.join(dir, 'notes', 'a.csv'), '');
    t.mock.restoreAll();
    assert.strictEqual(onDisk(dir).length, 0);
  });
});

// The same cut, made by the operating system rather than a stub: a process
// whose file-size limit is one block (512 or 1,024 bytes, depending on the
// shell) saves 2,000. The child installs a SIGXFSZ handler so the write over
// the limit returns EFBIG instead of ending the process, and the old bytes,
// which fit under the limit, go back.
//
// The handler is gone by the time the process exits, so anything the child
// writes to a file at exit would be cut off and the child killed. Under
// --experimental-test-coverage, Node hands every child a NODE_V8_COVERAGE
// folder unless the key is already set, and the child writes its coverage
// there at exit; a cut-off coverage file then spoils the whole run's report.
// An empty value counts as unset, so the child writes none.
const CHILD = [
  "process.on('SIGXFSZ', () => {});",
  "const path = require('path');",
  'const [linkSafe, extensionFile, dir] = process.argv.slice(1);',
  "const content = 'new,'.repeat(500);",
  "const outcome = (fn) => { try { const r = fn(); return r == null ? 'saved' : 'refused: ' + r; } catch (e) { return 'threw ' + e.code; } };",
  'console.log(JSON.stringify({',
  "  editor: outcome(() => require(linkSafe).writeFileNoFollow(path.join(dir, 'notes', 'a.csv'), content)),",
  "  extension: outcome(() => require(extensionFile).writeExtensionFile(dir, 'notes/b.csv', content)),",
  '}));',
].join('\n');

describe('a real file-size limit', { skip: process.platform === 'win32' ? 'no ulimit on Windows' : false }, () => {
  test('a save past the limit is reported as failed by both save paths, and both files keep their bytes', () => {
    const dir = workspace();
    fs.writeFileSync(path.join(dir, 'notes', 'b.csv'), BEFORE);
    const run = spawnSync('/bin/sh', ['-c', 'ulimit -f 1 && exec "$0" "$@"', process.execPath, '-e', CHILD,
      path.join(__dirname, '..', '..', 'lib', 'workspace', 'link-safe-write.js'),
      path.join(__dirname, '..', '..', 'lib', 'workspace', 'extension-file.js'),
      dir], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, NODE_V8_COVERAGE: '' } });
    assert.strictEqual(run.status, 0, `the child ran to the end: ${run.stderr}`);
    assert.deepStrictEqual(JSON.parse(run.stdout), { editor: 'threw EFBIG', extension: 'threw EFBIG' });
    assert.ok(onDisk(dir).equals(BEFORE), 'the editor\'s file kept its bytes');
    assert.ok(fs.readFileSync(path.join(dir, 'notes', 'b.csv')).equals(BEFORE), 'the extension\'s file kept its bytes');
  });
});
