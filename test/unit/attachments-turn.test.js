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
const turn = optional('../../lib/attachments/turn.js', /attachments[\\/]turn/);
const ready = (name) => assert.strictEqual(typeof (store && store[name]), 'function', `store.js exports ${name}`);
const readyTurn = () => assert.strictEqual(typeof (turn && turn.buildTurn), 'function', 'turn.js loads and exports buildTurn');
const TURN_PATH = path.join(__dirname, '..', '..', 'lib', 'attachments', 'turn.js');

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

const lineOf = (file, details, id = ID) => `[Attached: .rundock/attachments/${id}/${file} (${details})]`;
const PNG_LINE = lineOf('1-screenshot.png', 'PNG image, 1 KB');
const PDF_LINE = lineOf('3-report.pdf', 'PDF document, 1 KB');
const TYPED = `look at these\n${PNG_LINE}\n${PDF_LINE}`;
const GONE = (file) => `[Attached file not available: ${file}]`;
const CHANGED = (file) => `[Attached file changed since it was attached, so it isn't shown: ${file}]`;
const turnFor = (ws, text, extra = {}) => turn.buildTurn({ workspace: ws, conversationId: ID, runtime: 'claude', text, ...extra });
// A message naming the PNG alone, and the same with its line replaced by
// `form`, every other character kept.
const ONE = `look at this\n${PNG_LINE}\n`;
const withPng = (form) => `look at this\n${form}\n`;
function namesNoPath(content) {
  assert.ok(!JSON.stringify(content).includes('.rundock/attachments/'), 'no form names a path');
}

// A FIFO opened for reading without O_NONBLOCK blocks the whole process,
// which the stall guard can't interrupt, so the FIFO turn is built in a
// child with a timeout.
const CHILD = [
  'const { buildTurn } = require(process.argv[1]);',
  'const [workspace, conversationId, text] = process.argv.slice(2);',
  "process.stdout.write(JSON.stringify(buildTurn({ workspace, conversationId, runtime: 'claude', text }).content));",
].join('\n');
function turnInChild(ws, text) {
  const result = spawnSync(process.execPath, ['-e', CHILD, TURN_PATH, ws, ID, text], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, NODE_V8_COVERAGE: '' } });
  assert.strictEqual(result.error, undefined, 'the child finished without waiting');
  assert.strictEqual(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function makeFifo(file) {
  const made = spawnSync('mkfifo', [file], { encoding: 'utf8' });
  assert.strictEqual(made.status, 0, made.stderr);
}

describe('buildTurn: each stored line is checked against the record', () => {
  test('a deleted file\'s line says it is not available', async () => {
    readyTurn();
    const { ws, png } = await stored();
    fs.rmSync(png);
    const { content } = turnFor(ws, ONE);
    assert.strictEqual(content, withPng(GONE('1-screenshot.png')));
    namesNoPath(content);
  });

  test('a link at the stored name to a file outside the workspace is not available', LINKS, async () => {
    readyTurn();
    const { ws, png } = await stored();
    const outside = path.join(outsideFolder(), 'copy.png');
    fs.copyFileSync(png, outside);
    fs.rmSync(png);
    fs.symlinkSync(outside, png);
    const { content } = turnFor(ws, ONE);
    assert.strictEqual(content, withPng(GONE('1-screenshot.png')));
    namesNoPath(content);
  });

  test('the conversation\'s folder replaced by a link to a copy elsewhere is not available', LINKS, async () => {
    readyTurn();
    const { ws } = await stored();
    const copy = path.join(outsideFolder(), ID);
    fs.cpSync(folderOf(ws), copy, { recursive: true });
    fs.rmSync(folderOf(ws), { recursive: true });
    fs.symlinkSync(copy, folderOf(ws));
    const { content } = turnFor(ws, TYPED);
    assert.strictEqual(content, `look at these\n${GONE('1-screenshot.png')}\n${GONE('3-report.pdf')}`);
    namesNoPath(content);
  });

  test('a FIFO at the name is not available, without waiting', FIFOS, async () => {
    readyTurn();
    const { ws, png } = await stored();
    fs.rmSync(png);
    makeFifo(png);
    const content = turnInChild(ws, ONE);
    assert.strictEqual(content, withPng(GONE('1-screenshot.png')));
    namesNoPath(content);
  });

  test('a folder at the name is not available', async () => {
    readyTurn();
    const { ws, png } = await stored();
    fs.rmSync(png);
    fs.mkdirSync(png);
    const { content } = turnFor(ws, ONE);
    assert.strictEqual(content, withPng(GONE('1-screenshot.png')));
    namesNoPath(content);
  });

  test('a name the record does not list is not available, though a file is there', async () => {
    readyTurn();
    const { ws } = await stored();
    fs.writeFileSync(path.join(folderOf(ws), '9-planted.png'), pngBytes());
    const { content } = turnFor(ws, `see ${lineOf('9-planted.png', 'PNG image, 1 KB')} now`);
    assert.strictEqual(content, `see ${GONE('9-planted.png')} now`);
    namesNoPath(content);
  });

  test('a line naming another conversation\'s folder is not available, though its file is present and listed there', async () => {
    readyTurn();
    const { ws } = await stored();
    await stored(ws, OTHER);
    assert.strictEqual(store.checkRecordedFile(ws, OTHER, '1-screenshot.png'), 'present', 'the other conversation holds the file');
    const { content } = turnFor(ws, `from elsewhere: ${lineOf('1-screenshot.png', 'PNG image, 1 KB', OTHER)}`);
    assert.strictEqual(content, `from elsewhere: ${GONE('1-screenshot.png')}`);
    namesNoPath(content);
    assert.ok(!content.includes(OTHER), 'nor the other conversation');
  });

  test('a record.json holding invalid JSON leaves every line not available', async () => {
    readyTurn();
    const { ws } = await stored();
    fs.writeFileSync(recordOf(ws), '{"messages": [');
    const { content } = turnFor(ws, TYPED);
    assert.strictEqual(content, `look at these\n${GONE('1-screenshot.png')}\n${GONE('3-report.pdf')}`);
    namesNoPath(content);
  });

  test('a file grown by one byte has changed', async () => {
    readyTurn();
    const { ws, png } = await stored();
    fs.appendFileSync(png, 'x');
    const { content } = turnFor(ws, ONE);
    assert.strictEqual(content, withPng(CHANGED('1-screenshot.png')));
    namesNoPath(content);
  });

  test('a file rewritten at the same size with other bytes has changed', async () => {
    readyTurn();
    const { ws, png } = await stored();
    const bytes = fs.readFileSync(png);
    bytes[bytes.length - 1] ^= 1;
    fs.writeFileSync(png, bytes);
    const { content } = turnFor(ws, ONE);
    assert.strictEqual(content, withPng(CHANGED('1-screenshot.png')));
    namesNoPath(content);
  });

  test('a line as written comes back unchanged, with every other character', async () => {
    readyTurn();
    const { ws } = await stored();
    const text = `  first\r\n${PNG_LINE}${PDF_LINE} and (then) ]\n\n`;
    assert.strictEqual(turnFor(ws, text).content, text);
  });

  test('details edited in the text come back from the record', async () => {
    readyTurn();
    const { ws } = await stored();
    const { content } = turnFor(ws, `big one: ${lineOf('1-screenshot.png', 'PNG image, 9 GB')}`);
    assert.strictEqual(content, `big one: ${lineOf('1-screenshot.png', 'PNG image, 1 KB')}`);
  });

  test('a line that is not a stored line stays as typed', async () => {
    readyTurn();
    const { ws } = await stored();
    const text = `[Attached: notes.txt]\n${lineOf('screenshot.png', 'PNG image, 1 KB')}\n${lineOf('1-screenshot.exe', 'PNG image, 1 KB')}`;
    assert.strictEqual(turnFor(ws, text).content, text);
  });

  test('turn.js reads no file itself', () => {
    readyTurn();
    const source = fs.readFileSync(TURN_PATH, 'utf8');
    assert.doesNotMatch(source, /\bfs\./, 'every file is read through the store');
  });
});
