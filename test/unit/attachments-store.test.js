'use strict';
// The attachments store: the files a person attaches to a conversation, kept
// under .rundock/attachments/<id>/ exactly as sent, with a record of each
// message's files. An agent can write anything in the workspace, so every
// test here plants what an agent could (a link, a file at the next name, a
// junk record) and checks that the store neither follows it nor trusts it.

const { test, describe } = require('node:test');
const assert = require('node:assert');
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
  test('runs the calls for one ID one at a time, in the order they were made', async () => {
    ready('withConversationLock');
    const seen = [];
    const first = deferred();
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

  test('never makes one ID wait on another', async () => {
    ready('withConversationLock');
    const held = deferred();
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
  test('while the lock is held, a write for that ID changes nothing on disk until it is released', async () => {
    ready('writeMessageFiles');
    const ws = workspace();
    const held = deferred();
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
