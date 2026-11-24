'use strict';
// The attachments store: the files a person attaches to a conversation, kept
// under .rundock/attachments/<id>/ exactly as sent, with a record of each
// message's files. An agent can write anything in the workspace, so every
// test here plants what an agent could (a link, a file at the next name, a
// junk record) and checks that the store neither follows it nor trusts it.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { writeFileExclusive } = require('../../lib/workspace/link-safe-write.js');
const { makeTempDir } = require('../helpers/workspace.js');

// Loaded so that a missing module fails each test on its first assertion,
// never on the require.
const store = (() => {
  try { return require('../../lib/attachments/store.js'); } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND' && /attachments[\\/]store/.test(String(e.message))) return null;
    throw e;
  }
})();
const ready = (name) => assert.strictEqual(typeof (store && store[name]), 'function');

const BAD_IDS = ['../..', 'a/b', 'a.b', '', 'abc\n', ['alpha'], null, 'a'.repeat(65)];
const LONGEST_ID = 'a'.repeat(64);
const STORED_NAME = /^[1-9][0-9]{0,8}-[A-Za-z0-9_-]{1,60}\.(png|jpg|gif|webp|pdf|txt|md|csv)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LINKS = { skip: process.platform === 'win32' && 'links need privileges on Windows' };
const FIFOS = { skip: process.platform === 'win32' && 'FIFOs need a POSIX system' };
const STORE_PATH = path.join(__dirname, '..', '..', 'lib', 'attachments', 'store.js');

// Real-pathed: the walk compares paths as written, and on macOS the temp
// folder sits behind a link.
const workspace = () => fs.realpathSync(makeTempDir('attach-'));
const attachmentsOf = (ws) => path.join(ws, '.rundock', 'attachments');
const folderOf = (ws, id = 'alpha') => path.join(attachmentsOf(ws), id);
const recordOf = (ws, id = 'alpha') => path.join(folderOf(ws, id), 'record.json');
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function pngBytes(width = 10, height = 10) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}
const pdfBytes = (text = 'a report') => Buffer.from(`%PDF-1.7\n${text}\n%%EOF\n`, 'latin1');
const MESSAGE = () => [
  { name: 'Screen Shot.png', bytes: pngBytes(640, 480) },
  { name: 'Report.pdf', bytes: pdfBytes() },
  { name: 'notes.txt', bytes: Buffer.from('first line\nsecond line\n') },
];

// An assert.rejects (or assert.throws) check for a refusal: an Error with
// this code and fields.
function refused(code, fields = {}) {
  return (e) => {
    assert.ok(e instanceof Error, 'a refusal is an Error');
    assert.strictEqual(e.code, code);
    for (const [key, value] of Object.entries(fields)) assert.deepStrictEqual(e[key], value, key);
    return true;
  };
}

// Everything under `dir`, by lstat, so a link is recorded as itself: each
// path mapped to `dir`, `link -> <target>` or the file's fingerprint.
function snapshot(dir) {
  const seen = {};
  const visit = (current, rel) => {
    let stat;
    try { stat = fs.lstatSync(current); } catch (e) { return; }
    if (stat.isSymbolicLink()) { seen[rel] = `link -> ${fs.readlinkSync(current)}`; return; }
    if (!stat.isDirectory()) { seen[rel] = sha256(fs.readFileSync(current)); return; }
    seen[rel] = 'dir';
    for (const name of fs.readdirSync(current).sort()) visit(path.join(current, name), rel ? `${rel}/${name}` : name);
  };
  visit(dir, '');
  return seen;
}

// A folder outside the workspace holding one file, for links to point at.
function outsideFolder() {
  const dir = fs.realpathSync(makeTempDir('outside-'));
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'outside the workspace\n');
  return dir;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}

const realWriteSync = fs.writeSync;
function systemError(code, words, syscall = 'write') {
  return Object.assign(new Error(`${code}: ${words}, ${syscall}`), { code, syscall });
}
const enospc = (syscall) => systemError('ENOSPC', 'no space left on device', syscall);

// A stand-in for fs.writeSync for the stored files' bytes. Each step is the
// most bytes that call writes, or an Error it throws; the last step repeats.
// The standard streams and text writes pass through uncounted.
function scripted(...steps) {
  const stub = function writeSync(fd, buffer, offset, length, position) {
    if (fd <= 2 || typeof buffer === 'string') return realWriteSync.apply(fs, arguments);
    const step = steps[Math.min(stub.calls, steps.length - 1)];
    stub.calls += 1;
    if (stub.calls > 1000) throw new Error('the write was tried over a thousand times');
    if (step instanceof Error) throw step;
    const start = offset || 0;
    const bytes = buffer.subarray(start, length == null ? buffer.length : start + length);
    return realWriteSync(fd, bytes, 0, Math.min(step, bytes.length), position);
  };
  stub.calls = 0;
  return stub;
}

// A promise and the function that settles it, for holding a lock open.
// A test that holds a lock with one of these also settles it in t.after, so a
// failed assertion never leaves the lock held for the tests after it.
function deferred() {
  let settle;
  const promise = new Promise((resolve) => { settle = resolve; });
  return { promise, settle };
}
const turns = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

describe('ID_PATTERN', () => {
  test('accepts letters, digits, - and _ up to 64 characters', () => {
    assert.ok(store && store.ID_PATTERN instanceof RegExp, 'ID_PATTERN is a regular expression');
    for (const id of ['alpha', 'Beta_2', 'x-y', '0', LONGEST_ID]) assert.ok(store.ID_PATTERN.test(id), id);
  });

  test('refuses a 65-character ID and every string with anything else in it', () => {
    assert.ok(store && store.ID_PATTERN instanceof RegExp, 'ID_PATTERN is a regular expression');
    for (const id of BAD_IDS.filter((x) => typeof x === 'string')) assert.ok(!store.ID_PATTERN.test(id), JSON.stringify(id));
  });
});

describe('storedBase: the original name made safe for a stored name', () => {
  test('a composed and a decomposed name give the same base', () => {
    ready('storedBase');
    assert.strictEqual(store.storedBase('café.png'), 'caf_');
    assert.strictEqual(store.storedBase('café.png'), 'caf_');
  });

  test('spaces and inner dots become _, and only the last dot and after it go', () => {
    ready('storedBase');
    assert.strictEqual(store.storedBase('Screen Shot 2026-11-24 at 10.15.32.png'), 'Screen_Shot_2026-11-24_at_10_15_32');
    assert.strictEqual(store.storedBase('a.tar.gz'), 'a_tar');
  });

  test('a path in the name is flattened, its leading dots stripped and its separators collapsed', () => {
    ready('storedBase');
    assert.strictEqual(store.storedBase('../../etc/passwd.png'), '_etc_passwd');
    assert.strictEqual(store.storedBase('..\\..\\notes.txt'), '_notes');
    assert.strictEqual(store.storedBase('.hidden.md'), 'hidden');
  });

  test('a name with nothing left, or one that is not text, becomes file', () => {
    ready('storedBase');
    for (const name of ['..', '', 42, null, undefined, ['notes.txt']]) assert.strictEqual(store.storedBase(name), 'file', String(name));
  });

  test('a reserved device name, in any case, is prefixed with _', () => {
    ready('storedBase');
    assert.strictEqual(store.storedBase('CON.txt'), '_CON');
    assert.strictEqual(store.storedBase('lpt9.md'), '_lpt9');
    for (const name of ['prn', 'Aux', 'nul', 'COM1', 'com9', 'LPT1']) assert.strictEqual(store.storedBase(`${name}.pdf`), `_${name}`);
  });

  test('a name that only starts like a device name is left as it is', () => {
    ready('storedBase');
    assert.strictEqual(store.storedBase('COM10.txt'), 'COM10');
    assert.strictEqual(store.storedBase('LPT0.txt'), 'LPT0');
    assert.strictEqual(store.storedBase('CONSOLE.txt'), 'CONSOLE');
  });

  test('a stem of 60 characters is kept whole', () => {
    ready('storedBase');
    assert.strictEqual(store.storedBase(`${'a'.repeat(60)}.png`), 'a'.repeat(60));
  });

  test('a stem of 61 characters is cut to 60', () => {
    ready('storedBase');
    assert.strictEqual(store.storedBase(`${'a'.repeat(61)}.png`), 'a'.repeat(60));
  });
});

describe('withConversationLock', () => {
  test('runs the calls for one ID one at a time, in the order they were made', async (t) => {
    ready('withConversationLock');
    const seen = [];
    const first = deferred();
    t.after(() => first.settle());
    const a = store.withConversationLock('alpha', async () => { seen.push('a starts'); await first.promise; seen.push('a ends'); });
    const b = store.withConversationLock('alpha', () => { seen.push('b'); });
    const c = store.withConversationLock('alpha', async () => { seen.push('c'); });
    await turns();
    assert.deepStrictEqual(seen, ['a starts']);
    first.settle();
    await Promise.all([a, b, c]);
    assert.deepStrictEqual(seen, ['a starts', 'a ends', 'b', 'c']);
  });

  test('resolves to what the function returns or resolves to', async () => {
    ready('withConversationLock');
    assert.strictEqual(await store.withConversationLock('alpha', () => 7), 7);
    assert.deepStrictEqual(await store.withConversationLock('alpha', async () => ({ n: 8 })), { n: 8 });
  });

  test('releases when the function throws or rejects, and passes the error on', async () => {
    ready('withConversationLock');
    await assert.rejects(store.withConversationLock('alpha', () => { throw new Error('thrown'); }), /thrown/);
    await assert.rejects(store.withConversationLock('alpha', async () => { throw new Error('rejected'); }), /rejected/);
    assert.strictEqual(await store.withConversationLock('alpha', () => 'after'), 'after');
  });

  test('never makes one ID wait on another', async (t) => {
    ready('withConversationLock');
    const held = deferred();
    t.after(() => held.settle());
    const alpha = store.withConversationLock('alpha', () => held.promise);
    assert.strictEqual(await store.withConversationLock('beta', () => 'beta ran'), 'beta ran');
    held.settle('alpha ran');
    assert.strictEqual(await alpha, 'alpha ran');
  });
});

describe('writeMessageFiles: refusals before any disk access', () => {
  test('every bad ID is refused bad-id and touches nothing', async () => {
    ready('writeMessageFiles');
    const ws = workspace();
    for (const id of BAD_IDS) {
      await assert.rejects(store.writeMessageFiles(ws, id, MESSAGE()), refused('bad-id'), JSON.stringify(id));
    }
    assert.deepStrictEqual(fs.readdirSync(ws), []);
  });

  test('a 64-character ID is accepted', async () => {
    ready('writeMessageFiles');
    const ws = workspace();
    const entry = await store.writeMessageFiles(ws, LONGEST_ID, MESSAGE());
    assert.strictEqual(entry.files.length, 3);
    assert.ok(fs.existsSync(path.join(folderOf(ws, LONGEST_ID), entry.files[0].file)));
  });

  test('six files are refused too-many-files and leave no attachments folder', async () => {
    ready('writeMessageFiles');
    const ws = workspace();
    const six = Array.from({ length: 6 }, (_, i) => ({ name: `${i}.txt`, bytes: Buffer.from('x') }));
    await assert.rejects(store.writeMessageFiles(ws, 'alpha', six), refused('too-many-files', { count: 6, limit: 5 }));
    assert.strictEqual(fs.existsSync(attachmentsOf(ws)), false);
  });

  test('a HEIC photo is refused heic and leaves no attachments folder', async () => {
    ready('writeMessageFiles');
    const ws = workspace();
    const heic = Buffer.alloc(32);
    heic.write('ftypheic', 4, 'latin1');
    await assert.rejects(store.writeMessageFiles(ws, 'alpha', [{ name: 'IMG_0001.HEIC', bytes: heic }]), refused('heic', { name: 'IMG_0001.HEIC' }));
    assert.strictEqual(fs.existsSync(attachmentsOf(ws)), false);
  });

  test('bytes that are not a Buffer reject with a TypeError before any disk access', async () => {
    ready('writeMessageFiles');
    const ws = workspace();
    await assert.rejects(store.writeMessageFiles(ws, 'alpha', [{ name: 'notes.txt', bytes: 'first line' }]), TypeError);
    assert.strictEqual(fs.existsSync(attachmentsOf(ws)), false);
  });

  test('an empty list resolves null and writes nothing', async () => {
    ready('writeMessageFiles');
    const ws = workspace();
    assert.strictEqual(await store.writeMessageFiles(ws, 'alpha', []), null);
    assert.deepStrictEqual(fs.readdirSync(ws), []);
  });
});

describe('writeMessageFiles: the files and the record', () => {
  test('stores each file exactly as sent and resolves the new entry', async () => {
    ready('writeMessageFiles');
    const ws = workspace();
    const message = MESSAGE();
    const entry = await store.writeMessageFiles(ws, 'alpha', message);
    assert.ok(UUID.test(entry.id), entry.id);
    assert.deepStrictEqual(entry.files, [
      { file: '1-Screen_Shot.png', name: 'Screen Shot.png', type: 'png', bytes: 33, sha256: sha256(message[0].bytes), width: 640, height: 480 },
      { file: '2-Report.pdf', name: 'Report.pdf', type: 'pdf', bytes: message[1].bytes.length, sha256: sha256(message[1].bytes) },
      { file: '3-notes.txt', name: 'notes.txt', type: 'txt', bytes: message[2].bytes.length, sha256: sha256(message[2].bytes) },
    ]);
    for (const [i, described] of entry.files.entries()) {
      assert.ok(STORED_NAME.test(described.file), described.file);
      assert.deepStrictEqual(fs.readFileSync(path.join(folderOf(ws), described.file)), message[i].bytes);
    }
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(recordOf(ws), 'utf8')), { messages: [entry], sent: {} });
  });

  test('the record never holds file contents', async () => {
    ready('writeMessageFiles');
    const ws = workspace();
    await store.writeMessageFiles(ws, 'alpha', [{ name: 'notes.txt', bytes: Buffer.from('a line only the file holds') }]);
    assert.strictEqual(fs.readFileSync(recordOf(ws), 'utf8').includes('a line only the file holds'), false);
  });

  test('a name that is not text is recorded as an empty name and stored as file', async () => {
    ready('writeMessageFiles');
    const ws = workspace();
    const entry = await store.writeMessageFiles(ws, 'alpha', [{ name: 42, bytes: pngBytes() }]);
    assert.strictEqual(entry.files[0].name, '');
    assert.strictEqual(entry.files[0].file, '1-file.png');
  });

  test('a name holding separators, NUL and a reserved device name is stored under a safe name', async () => {
    ready('writeMessageFiles');
    const ws = workspace();
    const entry = await store.writeMessageFiles(ws, 'alpha', [
      { name: '../../etc/passwd.png', bytes: pngBytes() },
      { name: 'a\u0000b.txt', bytes: Buffer.from('x') },
      { name: 'CON.md', bytes: Buffer.from('x') },
    ]);
    assert.deepStrictEqual(entry.files.map((f) => f.file), ['1-_etc_passwd.png', '2-a_b.txt', '3-_CON.md']);
    assert.deepStrictEqual(fs.readdirSync(folderOf(ws)).sort(), ['1-_etc_passwd.png', '2-a_b.txt', '3-_CON.md', 'record.json']);
  });

  test('a record seeded with 1,000 entries holds 1,001 in order after one more write, sent kept', async () => {
    ready('writeMessageFiles');
    const ws = workspace();
    const seed = Array.from({ length: 1000 }, (_, i) => ({ id: `seed-${i}`, files: [{ file: `${i + 1}-old.txt`, name: 'old.txt', type: 'txt', bytes: 1, sha256: 'x' }] }));
    writeJson(recordOf(ws), { messages: seed, sent: { budget: 3 } });
    const entry = await store.writeMessageFiles(ws, 'alpha', [{ name: 'new.txt', bytes: Buffer.from('y') }]);
    const record = JSON.parse(fs.readFileSync(recordOf(ws), 'utf8'));
    assert.strictEqual(record.messages.length, 1001);
    assert.deepStrictEqual(record.messages.slice(0, 1000), seed);
    assert.deepStrictEqual(record.messages[1000], entry);
    assert.deepStrictEqual(record.sent, { budget: 3 });
    assert.strictEqual(entry.files[0].file, '1001-new.txt');
  });
});

describe('writeMessageFiles: numbering', () => {
  test('a message\'s files take consecutive numbers in order, and the next message continues them', async () => {
    ready('writeMessageFiles');
    const ws = workspace();
    const first = await store.writeMessageFiles(ws, 'alpha', MESSAGE());
    const second = await store.writeMessageFiles(ws, 'alpha', [{ name: 'later.md', bytes: Buffer.from('# later') }]);
    assert.deepStrictEqual(first.files.map((f) => f.file), ['1-Screen_Shot.png', '2-Report.pdf', '3-notes.txt']);
    assert.deepStrictEqual(second.files.map((f) => f.file), ['4-later.md']);
  });

  test('the next number is one more than the highest in the folder or the record', async () => {
    ready('writeMessageFiles');
    const ws = workspace();
    writeJson(recordOf(ws), { messages: [{ id: 'm', files: [{ file: '3-a.png' }] }], sent: {} });
    fs.writeFileSync(path.join(folderOf(ws), '7-x.png'), 'planted');
    const entry = await store.writeMessageFiles(ws, 'alpha', [{ name: 'a.png', bytes: pngBytes() }]);
    assert.strictEqual(entry.files[0].file, '8-a.png');
  });

  test('a record number counts even when no file is there', async () => {
    ready('writeMessageFiles');
    const ws = workspace();
    writeJson(recordOf(ws), { messages: [{ id: 'm', files: [{ file: '12-a.png' }] }, 'junk', { files: 'junk' }], sent: {} });
    const entry = await store.writeMessageFiles(ws, 'alpha', [{ name: 'a.png', bytes: pngBytes() }]);
    assert.strictEqual(entry.files[0].file, '13-a.png');
  });

  test('a planted 1000000000-a.png alone is ignored and the next file is 1', async () => {
    ready('writeMessageFiles');
    const ws = workspace();
    fs.mkdirSync(folderOf(ws), { recursive: true });
    fs.writeFileSync(path.join(folderOf(ws), '1000000000-a.png'), 'planted');
    const entry = await store.writeMessageFiles(ws, 'alpha', [{ name: 'a.png', bytes: pngBytes() }]);
    assert.strictEqual(entry.files[0].file, '1-a.png');
  });

  test('with 999999998-a.png present the next file is 999999999', async () => {
    ready('writeMessageFiles');
    const ws = workspace();
    fs.mkdirSync(folderOf(ws), { recursive: true });
    fs.writeFileSync(path.join(folderOf(ws), '999999998-a.png'), 'planted');
    const entry = await store.writeMessageFiles(ws, 'alpha', [{ name: 'a.png', bytes: pngBytes() }]);
    assert.strictEqual(entry.files[0].file, '999999999-a.png');
    assert.ok(STORED_NAME.test(entry.files[0].file));
  });

  test('with 999999999-a.png present the write is refused save-failed and writes nothing', async () => {
    ready('writeMessageFiles');
    const ws = workspace();
    fs.mkdirSync(folderOf(ws), { recursive: true });
    fs.writeFileSync(path.join(folderOf(ws), '999999999-a.png'), 'planted');
    const before = snapshot(ws);
    await assert.rejects(store.writeMessageFiles(ws, 'alpha', [{ name: 'a.png', bytes: pngBytes() }]), refused('save-failed'));
    assert.deepStrictEqual(snapshot(ws), before);
  });

  test('a file planted at the chosen name after the numbering takes the next number and is left as it was', async () => {
    ready('writeMessageFiles');
    const ws = workspace();
    const tried = [];
    const create = (target, bytes) => {
      tried.push(path.basename(target));
      if (tried.length === 1) fs.writeFileSync(target, 'planted after the numbering');
      return writeFileExclusive(target, bytes);
    };
    const entry = await store.writeMessageFiles(ws, 'alpha', [{ name: 'a.png', bytes: pngBytes() }], { create });
    assert.deepStrictEqual(tried, ['1-a.png', '2-a.png']);
    assert.strictEqual(entry.files[0].file, '2-a.png');
    assert.strictEqual(fs.readFileSync(path.join(folderOf(ws), '1-a.png'), 'utf8'), 'planted after the numbering');
  });

  test('a link planted at the chosen name after the numbering is never written through', LINKS, async () => {
    ready('writeMessageFiles');
    const ws = workspace();
    const outside = outsideFolder();
    const before = snapshot(outside);
    let planted = false;
    const create = (target, bytes) => {
      if (!planted) { planted = true; fs.symlinkSync(path.join(outside, 'keep.txt'), target); }
      return writeFileExclusive(target, bytes);
    };
    const entry = await store.writeMessageFiles(ws, 'alpha', [{ name: 'a.png', bytes: pngBytes() }], { create });
    assert.strictEqual(entry.files[0].file, '2-a.png');
    assert.ok(fs.lstatSync(path.join(folderOf(ws), '1-a.png')).isSymbolicLink());
    assert.deepStrictEqual(snapshot(outside), before);
  });

  test('a link already at a stored name is counted and never written through', LINKS, async () => {
    ready('writeMessageFiles');
    const ws = workspace();
    const outside = outsideFolder();
    const before = snapshot(outside);
    fs.mkdirSync(folderOf(ws), { recursive: true });
    fs.symlinkSync(path.join(outside, 'keep.txt'), path.join(folderOf(ws), '1-a.png'));
    const entry = await store.writeMessageFiles(ws, 'alpha', [{ name: 'a.png', bytes: pngBytes() }]);
    assert.strictEqual(entry.files[0].file, '2-a.png');
    assert.deepStrictEqual(snapshot(outside), before);
  });
});

describe('writeMessageFiles: all or nothing', () => {
  test('ENOSPC on the second of three files is disk-full naming it, and leaves the folder and record as they were', async (t) => {
    ready('writeMessageFiles');
    const ws = workspace();
    await store.writeMessageFiles(ws, 'alpha', [{ name: 'earlier.txt', bytes: Buffer.from('earlier') }]);
    const before = snapshot(ws);
    t.mock.method(fs, 'writeSync', scripted(Infinity, enospc(), Infinity));
    await assert.rejects(store.writeMessageFiles(ws, 'alpha', MESSAGE()), refused('disk-full', { name: 'Report.pdf' }));
    t.mock.restoreAll();
    assert.deepStrictEqual(snapshot(ws), before);
  });

  test('ENOSPC on the record is disk-full naming the first file, and removes every file the call created', async (t) => {
    ready('writeMessageFiles');
    const ws = workspace();
    await store.writeMessageFiles(ws, 'alpha', [{ name: 'earlier.txt', bytes: Buffer.from('earlier') }]);
    const before = snapshot(ws);
    const realRenameSync = fs.renameSync;
    t.mock.method(fs, 'renameSync', function renameSync(from, to) {
      if (to === recordOf(ws)) throw enospc('rename');
      return realRenameSync.call(fs, from, to);
    });
    await assert.rejects(store.writeMessageFiles(ws, 'alpha', MESSAGE()), refused('disk-full', { name: 'Screen Shot.png' }));
    t.mock.restoreAll();
    assert.deepStrictEqual(snapshot(ws), before);
  });

  test('any other failure, such as EIO, is save-failed and leaves nothing behind', async (t) => {
    ready('writeMessageFiles');
    const ws = workspace();
    await store.writeMessageFiles(ws, 'alpha', [{ name: 'earlier.txt', bytes: Buffer.from('earlier') }]);
    const before = snapshot(ws);
    t.mock.method(fs, 'writeSync', scripted(Infinity, systemError('EIO', 'i/o error'), Infinity));
    await assert.rejects(store.writeMessageFiles(ws, 'alpha', MESSAGE()), refused('save-failed'));
    t.mock.restoreAll();
    assert.deepStrictEqual(snapshot(ws), before);
  });

  test('the record is written only after every file: a failed third create leaves no record', async () => {
    ready('writeMessageFiles');
    const ws = workspace();
    let calls = 0;
    const create = (target, bytes) => {
      calls += 1;
      if (calls === 3) throw systemError('EIO', 'i/o error', 'open');
      return writeFileExclusive(target, bytes);
    };
    await assert.rejects(store.writeMessageFiles(ws, 'alpha', MESSAGE(), { create }), refused('save-failed'));
    assert.strictEqual(calls, 3);
    assert.deepStrictEqual(fs.readdirSync(folderOf(ws)), []);
  });
});

describe('writeMessageFiles: no link is followed', () => {
  // Each plants a link where the write is about to go, and checks the write
  // is refused with the link's target left exactly as it was.
  const PLANTS = [
    ['a link at .rundock to a folder outside', (ws, outside) => { fs.symlinkSync(outside, path.join(ws, '.rundock')); }],
    ['a link at .rundock/attachments to a folder outside', (ws, outside) => {
      fs.mkdirSync(path.join(ws, '.rundock'));
      fs.symlinkSync(outside, attachmentsOf(ws));
    }],
    ['a link at the conversation folder to a folder outside', (ws, outside) => {
      fs.mkdirSync(attachmentsOf(ws), { recursive: true });
      fs.symlinkSync(outside, folderOf(ws));
    }],
    ['a link at the conversation folder to a folder inside the workspace', (ws) => {
      fs.mkdirSync(path.join(ws, 'notes'));
      fs.writeFileSync(path.join(ws, 'notes', 'keep.txt'), 'inside the workspace\n');
      fs.mkdirSync(attachmentsOf(ws), { recursive: true });
      fs.symlinkSync(path.join(ws, 'notes'), folderOf(ws));
    }],
  ];
  for (const [label, plant] of PLANTS) {
    test(`${label} refuses the write save-failed`, LINKS, async () => {
      ready('writeMessageFiles');
      const ws = workspace();
      const outside = outsideFolder();
      plant(ws, outside);
      const before = { ws: snapshot(ws), outside: snapshot(outside) };
      await assert.rejects(store.writeMessageFiles(ws, 'alpha', MESSAGE()), refused('save-failed'));
      assert.deepStrictEqual({ ws: snapshot(ws), outside: snapshot(outside) }, before);
    });
  }

  test('a link at record.json refuses the write save-failed before any file is created', LINKS, async () => {
    ready('writeMessageFiles');
    const ws = workspace();
    const outside = outsideFolder();
    writeJson(path.join(outside, 'record.json'), { messages: [], sent: {} });
    fs.mkdirSync(folderOf(ws), { recursive: true });
    fs.symlinkSync(path.join(outside, 'record.json'), recordOf(ws));
    const before = { ws: snapshot(ws), outside: snapshot(outside) };
    let calls = 0;
    const create = (target, bytes) => { calls += 1; return writeFileExclusive(target, bytes); };
    await assert.rejects(store.writeMessageFiles(ws, 'alpha', MESSAGE(), { create }), refused('save-failed'));
    assert.strictEqual(calls, 0);
    assert.deepStrictEqual({ ws: snapshot(ws), outside: snapshot(outside) }, before);
  });

  // The folder swapped for a link to a folder inside the workspace after the
  // first file: only the walk before each create sees it (the landing check
  // passes), and the clean-up then finds the link and removes nothing.
  test('a link swapped in at the folder between two creates refuses the next one, and nothing is removed through it', LINKS, async () => {
    ready('writeMessageFiles');
    const ws = workspace();
    const moved = path.join(ws, 'moved');
    let calls = 0;
    const create = (target, bytes) => {
      calls += 1;
      writeFileExclusive(target, bytes);
      if (calls === 1) { fs.renameSync(folderOf(ws), moved); fs.symlinkSync(moved, folderOf(ws)); }
    };
    await assert.rejects(store.writeMessageFiles(ws, 'alpha', MESSAGE(), { create }), refused('save-failed'));
    assert.strictEqual(calls, 1);
    assert.deepStrictEqual(fs.readdirSync(moved), ['1-Screen_Shot.png']);
  });

  test('a link swapped in at the folder after the last create refuses the record write', LINKS, async () => {
    ready('writeMessageFiles');
    const ws = workspace();
    const moved = path.join(ws, 'moved');
    const create = (target, bytes) => {
      writeFileExclusive(target, bytes);
      fs.renameSync(folderOf(ws), moved);
      fs.symlinkSync(moved, folderOf(ws));
    };
    await assert.rejects(store.writeMessageFiles(ws, 'alpha', [{ name: 'a.png', bytes: pngBytes() }], { create }), refused('save-failed'));
    assert.deepStrictEqual(fs.readdirSync(moved), ['1-a.png']);
  });
});

describe('writeMessageFiles: an unreadable record or deleted list', () => {
  test('an unreadable record refuses the write save-failed before any file is created, and is left as it was', async () => {
    ready('writeMessageFiles');
    const ws = workspace();
    writeJson(recordOf(ws), '{"messages": [');
    const before = snapshot(ws);
    let calls = 0;
    const create = (target, bytes) => { calls += 1; return writeFileExclusive(target, bytes); };
    await assert.rejects(store.writeMessageFiles(ws, 'alpha', MESSAGE(), { create }), refused('save-failed'));
    assert.strictEqual(calls, 0);
    assert.deepStrictEqual(snapshot(ws), before);
  });

  // What an agent could leave at deleted.json. Every one makes every write
  // refuse, and the write creates nothing, its own folder included.
  const DELETED_JUNK = [
    ['a link', (file, outside) => { writeJson(path.join(outside, 'deleted.json'), []); fs.symlinkSync(path.join(outside, 'deleted.json'), file); }, LINKS],
    ['a folder', (file) => { fs.mkdirSync(file); }],
    ['text that is not JSON', (file) => { fs.writeFileSync(file, '["alpha"'); }],
    ['an object', (file) => { fs.writeFileSync(file, '{}'); }],
    ['an array holding a number', (file) => { fs.writeFileSync(file, '["alpha", 3]'); }],
    ['an array holding an ID off the pattern', (file) => { fs.writeFileSync(file, '["../.."]'); }],
  ];
  for (const [label, plant, options] of DELETED_JUNK) {
    test(`deleted.json holding ${label} refuses the write save-failed`, options || {}, async () => {
      ready('writeMessageFiles');
      const ws = workspace();
      const outside = outsideFolder();
      fs.mkdirSync(attachmentsOf(ws), { recursive: true });
      plant(path.join(attachmentsOf(ws), 'deleted.json'), outside);
      const before = { ws: snapshot(ws), outside: snapshot(outside) };
      await assert.rejects(store.writeMessageFiles(ws, 'beta', MESSAGE()), refused('save-failed'));
      assert.deepStrictEqual({ ws: snapshot(ws), outside: snapshot(outside) }, before);
    });
  }

  test('a write to an ID listed in deleted.json is refused deleted and creates nothing', async () => {
    ready('writeMessageFiles');
    const ws = workspace();
    writeJson(path.join(attachmentsOf(ws), 'deleted.json'), ['alpha']);
    await assert.rejects(store.writeMessageFiles(ws, 'alpha', MESSAGE()), refused('deleted'));
    assert.strictEqual(fs.existsSync(folderOf(ws)), false);
    const entry = await store.writeMessageFiles(ws, 'beta', MESSAGE());
    assert.strictEqual(entry.files.length, 3);
  });
});

describe('readRecord', () => {
  test('every bad ID throws bad-id and touches nothing', () => {
    ready('readRecord');
    const ws = workspace();
    for (const id of BAD_IDS) assert.throws(() => store.readRecord(ws, id), refused('bad-id'), JSON.stringify(id));
    assert.deepStrictEqual(fs.readdirSync(ws), []);
  });

  test('no record, or no folder at all, reads as no messages', () => {
    ready('readRecord');
    const ws = workspace();
    assert.deepStrictEqual(store.readRecord(ws, 'alpha'), { messages: [], sent: {} });
    fs.mkdirSync(folderOf(ws), { recursive: true });
    assert.deepStrictEqual(store.readRecord(ws, 'alpha'), { messages: [], sent: {} });
  });

  test('a record the store wrote reads back as written', async () => {
    ready('readRecord');
    const ws = workspace();
    const entry = await store.writeMessageFiles(ws, 'alpha', MESSAGE());
    assert.deepStrictEqual(store.readRecord(ws, 'alpha'), { messages: [entry], sent: {} });
  });

  const UNREADABLE = [
    ['a link at record.json', (ws, outside) => {
      writeJson(path.join(outside, 'record.json'), { messages: [], sent: {} });
      fs.mkdirSync(folderOf(ws), { recursive: true });
      fs.symlinkSync(path.join(outside, 'record.json'), recordOf(ws));
    }, LINKS],
    ['a link at the conversation folder', (ws, outside) => {
      writeJson(path.join(outside, 'record.json'), { messages: [], sent: {} });
      fs.mkdirSync(attachmentsOf(ws), { recursive: true });
      fs.symlinkSync(outside, folderOf(ws));
    }, LINKS],
    ['a link at .rundock', (ws, outside) => {
      writeJson(path.join(outside, 'attachments', 'alpha', 'record.json'), { messages: [], sent: {} });
      fs.symlinkSync(outside, path.join(ws, '.rundock'));
    }, LINKS],
    ['a folder at record.json', (ws) => { fs.mkdirSync(recordOf(ws), { recursive: true }); }],
    ['JSON that does not parse', (ws) => { writeJson(recordOf(ws), '{"messages": [], "sent": {}'); }],
    ['a top level that is an array', (ws) => { writeJson(recordOf(ws), []); }],
    ['a top level that is null', (ws) => { writeJson(recordOf(ws), 'null'); }],
    ['messages that is not an array', (ws) => { writeJson(recordOf(ws), { messages: {}, sent: {} }); }],
    ['no sent', (ws) => { writeJson(recordOf(ws), { messages: [] }); }],
    ['sent that is an array', (ws) => { writeJson(recordOf(ws), { messages: [], sent: [] }); }],
    ['sent that is null', (ws) => { writeJson(recordOf(ws), { messages: [], sent: null }); }],
  ];
  for (const [label, plant, options] of UNREADABLE) {
    test(`${label} throws record-unreadable`, options || {}, () => {
      ready('readRecord');
      const ws = workspace();
      plant(ws, outsideFolder());
      assert.throws(() => store.readRecord(ws, 'alpha'), refused('record-unreadable'));
    });
  }
});

describe('writeMessageFiles: the conversation lock', () => {
  test('while the lock is held, a write for that ID changes nothing on disk until it is released', async (t) => {
    ready('writeMessageFiles');
    const ws = workspace();
    const held = deferred();
    t.after(() => held.settle());
    const holding = store.withConversationLock('alpha', () => held.promise);
    const writing = store.writeMessageFiles(ws, 'alpha', MESSAGE());
    await turns();
    assert.deepStrictEqual(fs.readdirSync(ws), []);
    held.settle();
    await holding;
    const entry = await writing;
    assert.strictEqual(entry.files.length, 3);
    assert.ok(fs.existsSync(recordOf(ws)));
  });

  test('two writes started together for one ID get numbers 1 and 2', async () => {
    ready('writeMessageFiles');
    const ws = workspace();
    const [a, b] = await Promise.all([
      store.writeMessageFiles(ws, 'alpha', [{ name: 'a.png', bytes: pngBytes() }]),
      store.writeMessageFiles(ws, 'alpha', [{ name: 'b.png', bytes: pngBytes() }]),
    ]);
    assert.deepStrictEqual([a.files[0].file, b.files[0].file], ['1-a.png', '2-b.png']);
    assert.deepStrictEqual(store.readRecord(ws, 'alpha').messages, [a, b]);
  });
});

// A FIFO opened for reading without O_NONBLOCK blocks the whole process,
// which the stall guard can't interrupt, so each FIFO check runs in a child
// with a timeout.
const CHILD = [
  'const store = require(process.argv[1]);',
  'const [ws, kind, file] = process.argv.slice(2);',
  'let answer;',
  "if (kind === 'check') answer = store.checkRecordedFile(ws, 'alpha', file);",
  "else { try { store.readRecord(ws, 'alpha'); answer = 'read'; } catch (e) { answer = e.code; } }",
  'process.stdout.write(String(answer));',
].join('\n');
function inChild(...args) {
  const result = spawnSync(process.execPath, ['-e', CHILD, STORE_PATH, ...args], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, NODE_V8_COVERAGE: '' } });
  assert.strictEqual(result.error, undefined, 'the child finished without waiting');
  assert.strictEqual(result.status, 0, result.stderr);
  return result.stdout;
}
function makeFifo(file) {
  const made = spawnSync('mkfifo', [file], { encoding: 'utf8' });
  assert.strictEqual(made.status, 0, made.stderr);
}

describe('checkRecordedFile', () => {
  async function written() {
    const ws = workspace();
    const message = MESSAGE();
    const entry = await store.writeMessageFiles(ws, 'alpha', message);
    const stored = entry.files[0].file;
    return { ws, message, entry, stored, file: path.join(folderOf(ws), stored) };
  }

  test('every bad ID throws bad-id and touches nothing', () => {
    ready('checkRecordedFile');
    const ws = workspace();
    for (const id of BAD_IDS) assert.throws(() => store.checkRecordedFile(ws, id, '1-a.png'), refused('bad-id'), JSON.stringify(id));
    assert.deepStrictEqual(fs.readdirSync(ws), []);
  });

  test('a file the store wrote and nothing has touched is present', async () => {
    ready('checkRecordedFile');
    const { ws, entry } = await written();
    for (const described of entry.files) assert.strictEqual(store.checkRecordedFile(ws, 'alpha', described.file), 'present', described.file);
  });

  test('a file off the stored-name pattern answers missing and is never opened', (t) => {
    ready('checkRecordedFile');
    const ws = workspace();
    const planted = Buffer.from('{"planted": true}');
    writeJson(path.join(attachmentsOf(ws), 'record.json'), planted.toString());
    writeJson(recordOf(ws), { messages: [{ id: 'm', files: [{ file: '../record.json', name: 'x.txt', type: 'txt', bytes: planted.length, sha256: sha256(planted) }] }], sent: {} });
    const opened = [];
    const realOpenSync = fs.openSync;
    t.mock.method(fs, 'openSync', function openSync(file, ...rest) { opened.push(String(file)); return realOpenSync.call(fs, file, ...rest); });
    assert.strictEqual(store.checkRecordedFile(ws, 'alpha', '../record.json'), 'missing');
    assert.deepStrictEqual(opened.filter((file) => file === path.join(attachmentsOf(ws), 'record.json')), []);
  });

  test('every other name off the pattern answers missing', async () => {
    ready('checkRecordedFile');
    const { ws } = await written();
    for (const name of ['record.json', '0-a.png', '1-a.exe', '1-a.png/../2-b.png', `1-${'a'.repeat(61)}.png`, '1000000000-a.png', '1-a b.png', 42, null]) {
      assert.strictEqual(store.checkRecordedFile(ws, 'alpha', name), 'missing', String(name));
    }
  });

  test('a planted file the record does not list answers missing', async () => {
    ready('checkRecordedFile');
    const { ws } = await written();
    fs.writeFileSync(path.join(folderOf(ws), '9-planted.txt'), 'planted');
    assert.strictEqual(store.checkRecordedFile(ws, 'alpha', '9-planted.txt'), 'missing');
  });

  test('an unreadable record answers missing', async () => {
    ready('checkRecordedFile');
    const { ws, stored } = await written();
    fs.writeFileSync(recordOf(ws), '{"messages": [');
    assert.strictEqual(store.checkRecordedFile(ws, 'alpha', stored), 'missing');
  });

  test('an absent file answers missing', async () => {
    ready('checkRecordedFile');
    const { ws, stored, file } = await written();
    fs.rmSync(file);
    assert.strictEqual(store.checkRecordedFile(ws, 'alpha', stored), 'missing');
  });

  test('a folder at the name answers missing', async () => {
    ready('checkRecordedFile');
    const { ws, stored, file } = await written();
    fs.rmSync(file);
    fs.mkdirSync(file);
    assert.strictEqual(store.checkRecordedFile(ws, 'alpha', stored), 'missing');
  });

  test('a link at the name answers missing, even to an identical copy', LINKS, async () => {
    ready('checkRecordedFile');
    const { ws, stored, file } = await written();
    const copy = path.join(ws, 'copy.png');
    fs.copyFileSync(file, copy);
    fs.rmSync(file);
    fs.symlinkSync(copy, file);
    assert.strictEqual(store.checkRecordedFile(ws, 'alpha', stored), 'missing');
  });

  test('a path through a link at the conversation folder answers missing', LINKS, async () => {
    ready('checkRecordedFile');
    const { ws, stored } = await written();
    const moved = path.join(ws, 'moved');
    fs.renameSync(folderOf(ws), moved);
    fs.symlinkSync(moved, folderOf(ws));
    assert.strictEqual(store.checkRecordedFile(ws, 'alpha', stored), 'missing');
  });

  test('a path through a link at .rundock answers missing', LINKS, async () => {
    ready('checkRecordedFile');
    const { ws, stored } = await written();
    const outside = outsideFolder();
    fs.renameSync(path.join(ws, '.rundock'), path.join(outside, 'moved'));
    fs.symlinkSync(path.join(outside, 'moved'), path.join(ws, '.rundock'));
    assert.strictEqual(store.checkRecordedFile(ws, 'alpha', stored), 'missing');
  });

  test('a size that differs from the record answers changed before any hashing', async (t) => {
    ready('checkRecordedFile');
    const { ws, stored, file } = await written();
    fs.appendFileSync(file, 'x');
    const hash = t.mock.method(crypto, 'createHash');
    assert.strictEqual(store.checkRecordedFile(ws, 'alpha', stored), 'changed');
    assert.strictEqual(hash.mock.callCount(), 0);
  });

  test('a file of the same size one byte different answers changed', async () => {
    ready('checkRecordedFile');
    const { ws, stored, file } = await written();
    const bytes = fs.readFileSync(file);
    bytes[bytes.length - 1] ^= 1;
    fs.writeFileSync(file, bytes);
    assert.strictEqual(store.checkRecordedFile(ws, 'alpha', stored), 'changed');
  });

  test('a FIFO at the name answers missing without waiting', FIFOS, async () => {
    ready('checkRecordedFile');
    const { ws, stored, file } = await written();
    fs.rmSync(file);
    makeFifo(file);
    assert.strictEqual(inChild(ws, 'check', stored), 'missing');
  });

  test('a FIFO at record.json is unreadable without waiting', FIFOS, async () => {
    ready('readRecord');
    const { ws } = await written();
    fs.rmSync(recordOf(ws));
    makeFifo(recordOf(ws));
    assert.strictEqual(inChild(ws, 'read'), 'record-unreadable');
  });
});

describe('deleteAttachments', () => {
  test('every bad ID is refused bad-id and touches nothing', async () => {
    ready('deleteAttachments');
    const ws = workspace();
    for (const id of BAD_IDS) await assert.rejects(store.deleteAttachments(ws, id), refused('bad-id'), JSON.stringify(id));
    assert.deepStrictEqual(fs.readdirSync(ws), []);
  });

  test('removes the conversation folder and lists the ID in deleted.json', async () => {
    ready('deleteAttachments');
    const ws = workspace();
    await store.writeMessageFiles(ws, 'alpha', MESSAGE());
    await store.writeMessageFiles(ws, 'beta', MESSAGE());
    await store.deleteAttachments(ws, 'alpha');
    assert.strictEqual(fs.existsSync(folderOf(ws)), false);
    assert.strictEqual(fs.readdirSync(folderOf(ws, 'beta')).length, 4);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(attachmentsOf(ws), 'deleted.json'), 'utf8')), ['alpha']);
  });

  test('a link at .rundock is refused delete-refused, and nothing is written or removed through it', LINKS, async () => {
    ready('deleteAttachments');
    const ws = workspace();
    const outside = outsideFolder();
    writeJson(path.join(outside, 'attachments', 'alpha', 'record.json'), { messages: [], sent: {} });
    fs.symlinkSync(outside, path.join(ws, '.rundock'));
    const before = { ws: snapshot(ws), outside: snapshot(outside) };
    await assert.rejects(store.deleteAttachments(ws, 'alpha'), refused('delete-refused'));
    assert.deepStrictEqual({ ws: snapshot(ws), outside: snapshot(outside) }, before);
    assert.strictEqual(fs.existsSync(path.join(outside, 'attachments', 'deleted.json')), false);
  });

  test('a link at .rundock/attachments is refused delete-refused, and nothing is written or removed through it', LINKS, async () => {
    ready('deleteAttachments');
    const ws = workspace();
    const outside = outsideFolder();
    writeJson(path.join(outside, 'alpha', 'record.json'), { messages: [], sent: {} });
    fs.mkdirSync(path.join(ws, '.rundock'));
    fs.symlinkSync(outside, attachmentsOf(ws));
    const before = { ws: snapshot(ws), outside: snapshot(outside) };
    await assert.rejects(store.deleteAttachments(ws, 'alpha'), refused('delete-refused'));
    assert.deepStrictEqual({ ws: snapshot(ws), outside: snapshot(outside) }, before);
    assert.strictEqual(fs.existsSync(path.join(outside, 'deleted.json')), false);
  });

  // The attachments folder swapped for a link to a folder outside that holds a
  // folder of the conversation's name, once deleted.json is in place and
  // before the removal: the walks before that write saw no link, so only the
  // walk just before the removal stands between the delete and the outside
  // folder.
  test('a link swapped in at .rundock/attachments after deleted.json is written refuses the removal, and nothing is removed through it', LINKS, async (t) => {
    ready('deleteAttachments');
    const ws = workspace();
    const outside = outsideFolder();
    fs.mkdirSync(path.join(outside, 'alpha'));
    fs.writeFileSync(path.join(outside, 'alpha', 'notes.txt'), 'kept outside the workspace\n');
    fs.writeFileSync(path.join(outside, 'alpha', 'record.json'), JSON.stringify({ messages: [], sent: {} }));
    const entry = await store.writeMessageFiles(ws, 'alpha', MESSAGE());
    const before = snapshot(outside);
    const moved = path.join(ws, 'moved');
    const deletedFile = path.join(attachmentsOf(ws), 'deleted.json');
    let swapped = false;
    const realRenameSync = fs.renameSync;
    t.mock.method(fs, 'renameSync', function renameSync(from, to) {
      const result = realRenameSync.call(fs, from, to);
      if (to === deletedFile && !swapped) {
        swapped = true;
        realRenameSync.call(fs, attachmentsOf(ws), moved);
        fs.symlinkSync(outside, attachmentsOf(ws));
      }
      return result;
    });
    try {
      await assert.rejects(store.deleteAttachments(ws, 'alpha'), refused('delete-refused'));
    } finally {
      t.mock.restoreAll();
    }
    assert.ok(swapped, 'the swap ran once deleted.json was written');
    assert.deepStrictEqual(snapshot(outside), before);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(moved, 'deleted.json'), 'utf8')), ['alpha']);
    assert.deepStrictEqual(fs.readdirSync(path.join(moved, 'alpha')).sort(), [...entry.files.map((f) => f.file), 'record.json'].sort());
  });

  test('a link at the conversation folder to a folder outside removes only the link', LINKS, async () => {
    ready('deleteAttachments');
    const ws = workspace();
    const outside = outsideFolder();
    const before = snapshot(outside);
    fs.mkdirSync(attachmentsOf(ws), { recursive: true });
    fs.symlinkSync(outside, folderOf(ws));
    await store.deleteAttachments(ws, 'alpha');
    assert.throws(() => fs.lstatSync(folderOf(ws)), { code: 'ENOENT' });
    assert.deepStrictEqual(snapshot(outside), before);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(attachmentsOf(ws), 'deleted.json'), 'utf8')), ['alpha']);
  });

  test('a dangling link at the conversation folder is removed', LINKS, async () => {
    ready('deleteAttachments');
    const ws = workspace();
    fs.mkdirSync(attachmentsOf(ws), { recursive: true });
    fs.symlinkSync(path.join(ws, 'nowhere'), folderOf(ws));
    await store.deleteAttachments(ws, 'alpha');
    assert.throws(() => fs.lstatSync(folderOf(ws)), { code: 'ENOENT' });
    assert.strictEqual(fs.existsSync(path.join(ws, 'nowhere')), false);
  });

  test('a folder of read-only files is removed completely', async () => {
    ready('deleteAttachments');
    const ws = workspace();
    const entry = await store.writeMessageFiles(ws, 'alpha', MESSAGE());
    for (const described of entry.files) fs.chmodSync(path.join(folderOf(ws), described.file), 0o444);
    fs.chmodSync(folderOf(ws), 0o555);
    await store.deleteAttachments(ws, 'alpha');
    assert.strictEqual(fs.existsSync(folderOf(ws)), false);
  });

  test('an ID with no folder is listed and the delete succeeds, on a workspace with no .rundock at all', async () => {
    ready('deleteAttachments');
    const ws = workspace();
    await store.deleteAttachments(ws, 'alpha');
    assert.deepStrictEqual(fs.readdirSync(attachmentsOf(ws)), ['deleted.json']);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(attachmentsOf(ws), 'deleted.json'), 'utf8')), ['alpha']);
  });

  test('IDs already listed are kept, and an ID is listed once however often it is deleted', async () => {
    ready('deleteAttachments');
    const ws = workspace();
    writeJson(path.join(attachmentsOf(ws), 'deleted.json'), ['beta']);
    await store.deleteAttachments(ws, 'alpha');
    await store.deleteAttachments(ws, 'alpha');
    await store.deleteAttachments(ws, 'beta');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(attachmentsOf(ws), 'deleted.json'), 'utf8')), ['beta', 'alpha']);
  });

  test('a send to a deleted ID is refused deleted and writes nothing, its folder included', async () => {
    ready('deleteAttachments');
    const ws = workspace();
    await store.writeMessageFiles(ws, 'alpha', MESSAGE());
    await store.deleteAttachments(ws, 'alpha');
    const before = snapshot(ws);
    await assert.rejects(store.writeMessageFiles(ws, 'alpha', MESSAGE()), refused('deleted'));
    assert.deepStrictEqual(snapshot(ws), before);
    assert.strictEqual(fs.existsSync(folderOf(ws)), false);
  });

  const DELETED_JUNK = [
    ['a link', (file, outside) => { writeJson(path.join(outside, 'deleted.json'), []); fs.symlinkSync(path.join(outside, 'deleted.json'), file); }, LINKS],
    ['a folder', (file) => { fs.mkdirSync(file); }],
    ['text that is not JSON', (file) => { fs.writeFileSync(file, '["alpha"'); }],
    ['an object', (file) => { fs.writeFileSync(file, '{"alpha": true}'); }],
    ['an array holding a number', (file) => { fs.writeFileSync(file, '["beta", 3]'); }],
    ['an array holding an ID off the pattern', (file) => { fs.writeFileSync(file, '["../.."]'); }],
  ];
  for (const [label, plant, options] of DELETED_JUNK) {
    test(`deleted.json holding ${label} refuses the delete delete-refused, with nothing removed`, options || {}, async () => {
      ready('deleteAttachments');
      const ws = workspace();
      const outside = outsideFolder();
      await store.writeMessageFiles(ws, 'alpha', MESSAGE());
      plant(path.join(attachmentsOf(ws), 'deleted.json'), outside);
      const before = { ws: snapshot(ws), outside: snapshot(outside) };
      await assert.rejects(store.deleteAttachments(ws, 'alpha'), refused('delete-refused'));
      assert.deepStrictEqual({ ws: snapshot(ws), outside: snapshot(outside) }, before);
    });
  }

  test('any other failure is delete-refused, with nothing removed', async (t) => {
    ready('deleteAttachments');
    const ws = workspace();
    await store.writeMessageFiles(ws, 'alpha', MESSAGE());
    const before = snapshot(ws);
    const realRenameSync = fs.renameSync;
    t.mock.method(fs, 'renameSync', function renameSync(from, to) {
      if (to === path.join(attachmentsOf(ws), 'deleted.json')) throw systemError('EIO', 'i/o error', 'rename');
      return realRenameSync.call(fs, from, to);
    });
    await assert.rejects(store.deleteAttachments(ws, 'alpha'), refused('delete-refused'));
    t.mock.restoreAll();
    assert.deepStrictEqual(snapshot(ws), before);
  });

  test('while the lock is held, a delete for that ID changes nothing on disk until it is released', async (t) => {
    ready('deleteAttachments');
    const ws = workspace();
    await store.writeMessageFiles(ws, 'alpha', MESSAGE());
    const before = snapshot(ws);
    const held = deferred();
    t.after(() => held.settle());
    const holding = store.withConversationLock('alpha', () => held.promise);
    const deleting = store.deleteAttachments(ws, 'alpha');
    await turns();
    assert.deepStrictEqual(snapshot(ws), before);
    held.settle();
    await holding;
    await deleting;
    assert.strictEqual(fs.existsSync(folderOf(ws)), false);
  });

  test('a delete started while a send holds the lock finishes after it, and a send started after the delete is refused deleted', async (t) => {
    ready('deleteAttachments');
    const ws = workspace();
    const order = [];
    let deleting;
    let later;
    // What the folder held when the delete came to remove it.
    let atRemoval;
    const realRmSync = fs.rmSync;
    t.mock.method(fs, 'rmSync', function rmSync(target, options) {
      if (target === folderOf(ws) && !atRemoval) atRemoval = { files: Object.keys(snapshot(target)).sort(), record: store.readRecord(ws, 'alpha') };
      return realRmSync.call(fs, target, options);
    });
    const create = (target, bytes) => {
      if (!deleting) {
        deleting = store.deleteAttachments(ws, 'alpha').then(() => { order.push('delete'); });
        later = store.writeMessageFiles(ws, 'alpha', [{ name: 'later.txt', bytes: Buffer.from('later') }]).then(
          () => { order.push('later written'); },
          (e) => { order.push(`later ${e.code}`); },
        );
      }
      return writeFileExclusive(target, bytes);
    };
    const entry = await store.writeMessageFiles(ws, 'alpha', MESSAGE(), { create });
    await deleting;
    await later;
    assert.deepStrictEqual(entry.files.map((f) => f.file), ['1-Screen_Shot.png', '2-Report.pdf', '3-notes.txt']);
    assert.ok(atRemoval, 'the delete removed the folder');
    assert.deepStrictEqual(atRemoval.files, ['', '1-Screen_Shot.png', '2-Report.pdf', '3-notes.txt', 'record.json']);
    assert.deepStrictEqual(atRemoval.record.messages, [entry]);
    assert.deepStrictEqual(order, ['delete', 'later deleted']);
    assert.strictEqual(fs.existsSync(folderOf(ws)), false);
  });
});

describe('the five sequences', () => {
  test('the inverse: a write then a delete leaves no folder, the ID listed, no messages and a refused write', async () => {
    ready('deleteAttachments');
    const ws = workspace();
    const entry = await store.writeMessageFiles(ws, 'alpha', MESSAGE());
    await store.deleteAttachments(ws, 'alpha');
    assert.strictEqual(fs.existsSync(folderOf(ws)), false);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(attachmentsOf(ws), 'deleted.json'), 'utf8')), ['alpha']);
    assert.deepStrictEqual(store.readRecord(ws, 'alpha'), { messages: [], sent: {} });
    for (const described of entry.files) assert.strictEqual(store.checkRecordedFile(ws, 'alpha', described.file), 'missing');
    await assert.rejects(store.writeMessageFiles(ws, 'alpha', MESSAGE()), refused('deleted'));
    assert.strictEqual(fs.existsSync(folderOf(ws)), false);
  });

  test('the undo: a write that fails on its second file leaves the folder as it was, and the same message then takes the same numbers', async (t) => {
    ready('writeMessageFiles');
    const ws = workspace();
    await store.writeMessageFiles(ws, 'alpha', [{ name: 'earlier.txt', bytes: Buffer.from('earlier') }]);
    const before = snapshot(ws);
    const tried = [];
    const create = (target, bytes) => { tried.push(path.basename(target)); return writeFileExclusive(target, bytes); };
    t.mock.method(fs, 'writeSync', scripted(Infinity, enospc(), Infinity));
    await assert.rejects(store.writeMessageFiles(ws, 'alpha', MESSAGE(), { create }), refused('disk-full', { name: 'Report.pdf' }));
    t.mock.restoreAll();
    assert.deepStrictEqual(snapshot(ws), before);
    assert.strictEqual(store.readRecord(ws, 'alpha').messages.length, 1);
    const entry = await store.writeMessageFiles(ws, 'alpha', MESSAGE());
    assert.deepStrictEqual(entry.files.map((f) => f.file), ['2-Screen_Shot.png', '3-Report.pdf', '4-notes.txt']);
    assert.deepStrictEqual(tried, ['2-Screen_Shot.png', '3-Report.pdf']);
  });

  test('the retry: a message written twice is stored twice, a planted file is skipped, and a second delete lists the ID once', async () => {
    ready('deleteAttachments');
    const ws = workspace();
    const message = MESSAGE();
    const first = await store.writeMessageFiles(ws, 'alpha', message);
    const firstCopy = snapshot(folderOf(ws));
    const second = await store.writeMessageFiles(ws, 'alpha', message);
    assert.deepStrictEqual(second.files.map((f) => f.file), ['4-Screen_Shot.png', '5-Report.pdf', '6-notes.txt']);
    for (const described of first.files) assert.strictEqual(snapshot(folderOf(ws))[described.file], firstCopy[described.file]);
    assert.deepStrictEqual(store.readRecord(ws, 'alpha').messages, [first, second]);
    fs.writeFileSync(path.join(folderOf(ws), '7-planted.txt'), 'planted');
    const third = await store.writeMessageFiles(ws, 'alpha', [{ name: 'a.png', bytes: pngBytes() }]);
    assert.strictEqual(third.files[0].file, '8-a.png');
    await store.deleteAttachments(ws, 'alpha');
    await store.deleteAttachments(ws, 'alpha');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(attachmentsOf(ws), 'deleted.json'), 'utf8')), ['alpha']);
  });

  test('the most common next step: each stored file is present, and a second message continues the numbering', async () => {
    ready('checkRecordedFile');
    const ws = workspace();
    const first = await store.writeMessageFiles(ws, 'alpha', MESSAGE());
    for (const described of first.files) assert.strictEqual(store.checkRecordedFile(ws, 'alpha', described.file), 'present');
    const second = await store.writeMessageFiles(ws, 'alpha', [{ name: 'later.md', bytes: Buffer.from('# later') }]);
    assert.deepStrictEqual(second.files.map((f) => f.file), ['4-later.md']);
    assert.strictEqual(store.checkRecordedFile(ws, 'alpha', '4-later.md'), 'present');
  });

  describe('the control failing closed', () => {
    test('an unreadable record refuses the write with nothing left behind, and the check answers missing', async () => {
      ready('checkRecordedFile');
      const ws = workspace();
      const entry = await store.writeMessageFiles(ws, 'alpha', MESSAGE());
      fs.writeFileSync(recordOf(ws), '[]');
      const before = snapshot(ws);
      await assert.rejects(store.writeMessageFiles(ws, 'alpha', MESSAGE()), refused('save-failed'));
      assert.deepStrictEqual(snapshot(ws), before);
      assert.strictEqual(store.checkRecordedFile(ws, 'alpha', entry.files[0].file), 'missing');
    });

    test('an unreadable deleted.json refuses the write with nothing left behind and the delete with nothing removed', async () => {
      ready('deleteAttachments');
      const ws = workspace();
      const entry = await store.writeMessageFiles(ws, 'alpha', MESSAGE());
      fs.writeFileSync(path.join(attachmentsOf(ws), 'deleted.json'), 'not json');
      const before = snapshot(ws);
      await assert.rejects(store.writeMessageFiles(ws, 'alpha', MESSAGE()), refused('save-failed'));
      await assert.rejects(store.deleteAttachments(ws, 'alpha'), refused('delete-refused'));
      assert.deepStrictEqual(snapshot(ws), before);
      assert.strictEqual(store.checkRecordedFile(ws, 'alpha', entry.files[0].file), 'present');
    });

    test('a link on the path refuses the write and the delete, and the check answers missing', LINKS, async () => {
      ready('deleteAttachments');
      const ws = workspace();
      const outside = outsideFolder();
      const entry = await store.writeMessageFiles(ws, 'alpha', MESSAGE());
      fs.renameSync(path.join(ws, '.rundock'), path.join(outside, 'moved'));
      fs.symlinkSync(path.join(outside, 'moved'), path.join(ws, '.rundock'));
      const before = { ws: snapshot(ws), outside: snapshot(outside) };
      await assert.rejects(store.writeMessageFiles(ws, 'alpha', MESSAGE()), refused('save-failed'));
      await assert.rejects(store.deleteAttachments(ws, 'alpha'), refused('delete-refused'));
      assert.strictEqual(store.checkRecordedFile(ws, 'alpha', entry.files[0].file), 'missing');
      assert.deepStrictEqual({ ws: snapshot(ws), outside: snapshot(outside) }, before);
    });

    test('an unexpected error refuses the write with nothing left behind, the delete with nothing removed, and the check answers missing', async (t) => {
      ready('deleteAttachments');
      const ws = workspace();
      const entry = await store.writeMessageFiles(ws, 'alpha', MESSAGE());
      const before = snapshot(ws);
      const eio = () => { throw systemError('EIO', 'i/o error', 'fsync'); };
      t.mock.method(fs, 'fsyncSync', eio);
      await assert.rejects(store.writeMessageFiles(ws, 'alpha', MESSAGE()), refused('save-failed'));
      await assert.rejects(store.deleteAttachments(ws, 'alpha'), refused('delete-refused'));
      t.mock.method(fs, 'fstatSync', eio);
      assert.strictEqual(store.checkRecordedFile(ws, 'alpha', entry.files[0].file), 'missing');
      t.mock.restoreAll();
      assert.deepStrictEqual(snapshot(ws), before);
    });
  });
});
