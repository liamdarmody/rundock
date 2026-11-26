'use strict';
// The turn a runtime is handed for a person's message. Every attached-file
// line in it is checked against the conversation's record when it is sent:
// an agent can write anything in the workspace, so each test here changes or
// plants what an agent could (a deleted file, a link, a FIFO, a junk record,
// a line naming another conversation's folder) and checks that the turn
// names only a file still as the person sent it. A Claude Code turn also
// carries the message's images and PDFs as content blocks, read from the
// same open that checked them.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { makeTempDir } = require('../helpers/workspace.js');

// Loaded so that a missing module or export fails each test on its first
// assertion, never on the require.
const optional = (file, pattern) => {
  try { return require(file); } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND' && pattern.test(String(e.message))) return null;
    throw e;
  }
};
const store = optional('../../lib/attachments/store.js', /attachments[\\/]store/);
const ready = (name) => assert.strictEqual(typeof (store && store[name]), 'function', `store.js exports ${name}`);

const ID = '1764000000000';
const OTHER = '1764000000001';
const BAD_IDS = ['../..', 'a/b', 'a.b', '', ['alpha'], null, 'a'.repeat(65)];
const LINKS = { skip: process.platform === 'win32' && 'links need privileges on Windows' };
const FIFOS = { skip: process.platform === 'win32' && 'FIFOs need a POSIX system' };
const READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);

// Real-pathed: the walk compares paths as written, and on macOS the temp
// folder sits behind a link.
const workspace = () => fs.realpathSync(makeTempDir('attach-turn-'));
const folderOf = (ws, id = ID) => path.join(ws, '.rundock', 'attachments', id);
const recordOf = (ws, id = ID) => path.join(folderOf(ws, id), 'record.json');
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function pngBytes(width = 640, height = 480, size = 33) {
  const b = Buffer.alloc(size);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}
const pdfBytes = (text = 'a report') => Buffer.from(`%PDF-1.7\n${text}\n%%EOF\n`, 'latin1');

// A folder outside the workspace, for links to point at.
const outsideFolder = () => fs.realpathSync(makeTempDir('outside-'));

// The conversation's first message as the store keeps it: 1-screenshot.png,
// 2-notes.txt and 3-report.pdf, under one record entry.
async function stored(ws = workspace(), id = ID) {
  const entry = await store.writeMessageFiles(ws, id, [
    { name: 'screenshot.png', bytes: pngBytes() },
    { name: 'notes.txt', bytes: Buffer.from('first line\nsecond line\n') },
    { name: 'report.pdf', bytes: pdfBytes() },
  ]);
  return { ws, entry, png: path.join(folderOf(ws, id), '1-screenshot.png'), pdf: path.join(folderOf(ws, id), '3-report.pdf') };
}

describe('readRecordedFile', () => {
  test('a present file answers its description and the bytes read by the one open that checked it', async (t) => {
    ready('readRecordedFile');
    const { ws, entry, png } = await stored();
    const onDisk = fs.readFileSync(png);
    const opened = [];
    const realOpenSync = fs.openSync;
    const open = t.mock.method(fs, 'openSync', function openSync(file, ...rest) { opened.push([String(file), rest[0]]); return realOpenSync.call(fs, file, ...rest); });
    const read = store.readRecordedFile(ws, ID, '1-screenshot.png');
    open.mock.restore();
    assert.strictEqual(read.state, 'present');
    assert.deepStrictEqual(read.described, entry.files[0]);
    assert.ok(Buffer.isBuffer(read.bytes) && read.bytes.equals(onDisk), 'the bytes are the stored file\'s');
    assert.deepStrictEqual(opened.filter(([file]) => file === png), [[png, READ_FLAGS]], 'one open, without following a link or waiting');
  });

  test('a changed file answers changed, its description and no bytes', async () => {
    ready('readRecordedFile');
    const { ws, entry, pdf } = await stored();
    const bytes = fs.readFileSync(pdf);
    bytes[bytes.length - 2] ^= 1;
    fs.writeFileSync(pdf, bytes);
    const read = store.readRecordedFile(ws, ID, '3-report.pdf');
    assert.deepStrictEqual([read.state, read.described, 'bytes' in read], ['changed', entry.files[2], false]);
  });

  test('a deleted file, an unlisted name, a name off the pattern and an unreadable record answer missing and no bytes', async () => {
    ready('readRecordedFile');
    const { ws, png } = await stored();
    fs.rmSync(png);
    fs.writeFileSync(path.join(folderOf(ws), '9-planted.png'), pngBytes());
    for (const name of ['1-screenshot.png', '9-planted.png', '../record.json', 'record.json', 42]) {
      const read = store.readRecordedFile(ws, ID, name);
      assert.deepStrictEqual([read.state, 'bytes' in read], ['missing', false], String(name));
    }
    fs.writeFileSync(recordOf(ws), '{"messages": [');
    const read = store.readRecordedFile(ws, ID, '3-report.pdf');
    assert.deepStrictEqual([read.state, 'bytes' in read], ['missing', false], 'an unreadable record');
  });

  test('every bad ID throws bad-id', () => {
    ready('readRecordedFile');
    const ws = workspace();
    for (const id of BAD_IDS) {
      assert.throws(() => store.readRecordedFile(ws, id, '1-a.png'), (e) => e && e.code === 'bad-id', JSON.stringify(id));
    }
  });
});
