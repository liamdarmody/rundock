'use strict';
// Creating a file only where nothing is: the create that the attachments store
// uses for every file it writes. It never replaces what is at the name (a
// file, a folder or a link, live or dangling), writes every byte even when
// one write call takes only a few, and leaves nothing behind when a write
// fails after the open.
//
// The short-write stand-in below is the one in short-write-saves.test.js:
// the system call is swapped for scripted ones that write a few bytes at a
// time (for real, where they were asked to) or report a full drive.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { writeFileExclusive } = require('../../lib/workspace/link-safe-write.js');
const { makeTempDir } = require('../helpers/workspace.js');

const realWriteSync = fs.writeSync;
const LINKS = { skip: process.platform === 'win32' && 'links need privileges on Windows' };

function systemError(code, words) {
  return Object.assign(new Error(`${code}: ${words}, write`), { code, syscall: 'write' });
}
const enospc = () => systemError('ENOSPC', 'no space left on device');

// The bytes one write call was handed, whichever of the two forms it was
// called in.
function handed(buffer, offset, length) {
  if (typeof buffer === 'string') return Buffer.from(buffer, typeof length === 'string' ? length : 'utf8');
  const start = offset || 0;
  return buffer.subarray(start, length == null ? buffer.length : start + length);
}

// A stand-in for fs.writeSync. Each step is the most bytes that call writes,
// an Error it throws, or a function it runs; the last step repeats.
function scripted(...steps) {
  const stub = function writeSync(fd, buffer, offset, length, position) {
    if (fd <= 2) return realWriteSync.apply(fs, arguments);
    const step = steps[Math.min(stub.calls, steps.length - 1)];
    stub.calls += 1;
    if (stub.calls > 1000) throw new Error('the write was tried over a thousand times');
    if (step instanceof Error) throw step;
    if (typeof step === 'function') return step();
    const bytes = handed(buffer, offset, length);
    const at = typeof buffer === 'string' ? offset : position;
    return realWriteSync(fd, bytes, 0, Math.min(step, bytes.length), at);
  };
  stub.calls = 0;
  return stub;
}

const workspace = () => fs.realpathSync(makeTempDir('exclusive-'));
const BYTES = Buffer.from('attached bytes, \u{1F600} and all,'.repeat(20));
const KEEP = Buffer.from('already here');

describe('writeFileExclusive', () => {
  test('creates a new file holding exactly the bytes', () => {
    assert.strictEqual(typeof writeFileExclusive, 'function');
    const target = path.join(workspace(), 'notes.txt');
    writeFileExclusive(target, BYTES);
    assert.deepStrictEqual(fs.readFileSync(target), BYTES);
  });

  // On its own, O_EXCL already refuses a link at the name on most systems, so
  // the flags themselves are checked: no-follow is the guard where the
  // exclusive create is weaker (it reads as 0 where the platform has none).
  test('opens write-only, creating, exclusive and without following a link', (t) => {
    assert.strictEqual(typeof writeFileExclusive, 'function');
    const target = path.join(workspace(), 'notes.txt');
    const realOpenSync = fs.openSync;
    const opened = [];
    t.mock.method(fs, 'openSync', function openSync(file, flags, mode) {
      if (file === target) opened.push(flags);
      return realOpenSync.call(fs, file, flags, mode);
    });
    writeFileExclusive(target, BYTES);
    t.mock.restoreAll();
    assert.strictEqual(opened.length, 1);
    const { O_WRONLY, O_CREAT, O_EXCL } = fs.constants;
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    assert.strictEqual(opened[0] & O_EXCL, O_EXCL, 'exclusive');
    assert.strictEqual(opened[0] & noFollow, noFollow, 'no follow');
    assert.strictEqual(opened[0] & (O_WRONLY | O_CREAT), O_WRONLY | O_CREAT, 'write-only, creating');
  });

  test('writes every byte when each write call takes only 7', (t) => {
    assert.strictEqual(typeof writeFileExclusive, 'function');
    const target = path.join(workspace(), 'notes.txt');
    const stub = scripted(7);
    t.mock.method(fs, 'writeSync', stub);
    writeFileExclusive(target, BYTES);
    t.mock.restoreAll();
    assert.ok(stub.calls >= Math.ceil(BYTES.length / 7), `took ${stub.calls} calls`);
    assert.deepStrictEqual(fs.readFileSync(target), BYTES);
  });

  test('a full drive part way through leaves nothing at the name and rethrows the original error', (t) => {
    assert.strictEqual(typeof writeFileExclusive, 'function');
    const target = path.join(workspace(), 'notes.txt');
    t.mock.method(fs, 'writeSync', scripted(7, enospc()));
    assert.throws(() => writeFileExclusive(target, BYTES), (e) => e.code === 'ENOSPC');
    t.mock.restoreAll();
    assert.strictEqual(fs.existsSync(target), false);
  });

  test('refuses an existing file and leaves it unchanged', () => {
    assert.strictEqual(typeof writeFileExclusive, 'function');
    const target = path.join(workspace(), 'notes.txt');
    fs.writeFileSync(target, KEEP);
    assert.throws(() => writeFileExclusive(target, BYTES), (e) => e.code === 'EEXIST');
    assert.deepStrictEqual(fs.readFileSync(target), KEEP);
  });

  test('refuses a folder at the name and leaves it as it was', () => {
    assert.strictEqual(typeof writeFileExclusive, 'function');
    const target = path.join(workspace(), 'notes.txt');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'inside.txt'), KEEP);
    assert.throws(() => writeFileExclusive(target, BYTES), (e) => typeof e.code === 'string');
    assert.ok(fs.lstatSync(target).isDirectory());
    assert.deepStrictEqual(fs.readdirSync(target), ['inside.txt']);
  });

  test('refuses a link to a file outside and leaves that file unchanged', LINKS, () => {
    assert.strictEqual(typeof writeFileExclusive, 'function');
    const outside = path.join(workspace(), 'secret.txt');
    fs.writeFileSync(outside, KEEP);
    const target = path.join(workspace(), 'notes.txt');
    fs.symlinkSync(outside, target);
    assert.throws(() => writeFileExclusive(target, BYTES), (e) => e.code === 'EEXIST' || e.code === 'ELOOP');
    assert.deepStrictEqual(fs.readFileSync(outside), KEEP);
    assert.ok(fs.lstatSync(target).isSymbolicLink(), 'the link itself is left where it was');
  });

  test('refuses a dangling link and never creates what it points to', LINKS, () => {
    assert.strictEqual(typeof writeFileExclusive, 'function');
    const outside = path.join(workspace(), 'would-be.txt');
    const target = path.join(workspace(), 'notes.txt');
    fs.symlinkSync(outside, target);
    assert.throws(() => writeFileExclusive(target, BYTES), (e) => e.code === 'EEXIST' || e.code === 'ELOOP');
    assert.strictEqual(fs.existsSync(outside), false);
    assert.ok(fs.lstatSync(target).isSymbolicLink(), 'the link itself is left where it was');
  });
});
