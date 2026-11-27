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

// A record written by hand, for what the store refuses to keep (a file over
// a limit, a sixth file) or a type made up here: each message `{ id, files }`,
// each file `{ file, bytes, width, height }`, written into the folder and
// described as the store describes it.
function handWritten(ws, messages, id = ID) {
  fs.mkdirSync(folderOf(ws, id), { recursive: true });
  const described = messages.map((message) => ({
    id: message.id,
    files: message.files.map((f) => {
      fs.writeFileSync(path.join(folderOf(ws, id), f.file), f.bytes);
      const type = f.file.slice(f.file.lastIndexOf('.') + 1);
      const one = { file: f.file, name: f.file, type, bytes: f.bytes.length, sha256: sha256(f.bytes) };
      if (f.width !== undefined) Object.assign(one, { width: f.width, height: f.height });
      return one;
    }),
  }));
  fs.writeFileSync(recordOf(ws, id), JSON.stringify({ messages: described, sent: {} }));
  return described;
}
const imageBlock = (mediaType, bytes) => ({ type: 'image', source: { type: 'base64', media_type: mediaType, data: bytes.toString('base64') } });
const pdfBlock = (bytes) => ({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: bytes.toString('base64') } });
const textItem = (text) => ({ type: 'text', text });
const BYTES = (label, size = 40) => Buffer.alloc(size, label);
const NOTES_LINE = lineOf('2-notes.txt', 'text file, 1 KB');
const ALL_THREE = `look at these\n${PNG_LINE}\n${NOTES_LINE}\n${PDF_LINE}`;

describe('buildTurn: a Claude Code turn carries its entry\'s images and PDFs', () => {
  test('a PNG gives an image block holding its bytes', async () => {
    readyTurn();
    const ws = workspace();
    const png = pngBytes();
    const entry = await store.writeMessageFiles(ws, ID, [{ name: 'screenshot.png', bytes: png }]);
    const text = `look at this\n${PNG_LINE}`;
    assert.deepStrictEqual(turnFor(ws, text, { entryId: entry.id }), { content: [textItem(text), imageBlock('image/png', png)], extraItems: [] });
  });

  test('a JPEG gives an image/jpeg block', () => {
    readyTurn();
    const ws = workspace();
    const jpg = BYTES('j');
    handWritten(ws, [{ id: 'entry-1', files: [{ file: '1-photo.jpg', bytes: jpg, width: 10, height: 10 }] }]);
    const text = lineOf('1-photo.jpg', 'JPEG image, 1 KB');
    assert.deepStrictEqual(turnFor(ws, text, { entryId: 'entry-1' }).content, [textItem(text), imageBlock('image/jpeg', jpg)]);
  });

  test('a GIF and a WebP give image/gif and image/webp blocks', () => {
    readyTurn();
    const ws = workspace();
    const gif = BYTES('g');
    const webp = BYTES('w');
    handWritten(ws, [{ id: 'entry-1', files: [{ file: '1-a.gif', bytes: gif, width: 10, height: 10 }, { file: '2-b.webp', bytes: webp, width: 10, height: 10 }] }]);
    const text = `${lineOf('1-a.gif', 'GIF image, 1 KB')}\n${lineOf('2-b.webp', 'WebP image, 1 KB')}`;
    assert.deepStrictEqual(turnFor(ws, text, { entryId: 'entry-1' }).content,
      [textItem(text), imageBlock('image/gif', gif), imageBlock('image/webp', webp)]);
  });

  test('a PDF gives a document block holding its bytes', async () => {
    readyTurn();
    const ws = workspace();
    const pdf = pdfBytes();
    const entry = await store.writeMessageFiles(ws, ID, [{ name: 'report.pdf', bytes: pdf }]);
    const text = `the report\n${lineOf('1-report.pdf', 'PDF document, 1 KB')}`;
    assert.deepStrictEqual(turnFor(ws, text, { entryId: entry.id }), { content: [textItem(text), pdfBlock(pdf)], extraItems: [] });
  });

  test('a txt, an md and a csv give their lines and no block', () => {
    readyTurn();
    const ws = workspace();
    handWritten(ws, [{ id: 'entry-1', files: [{ file: '1-a.txt', bytes: BYTES('t') }, { file: '2-b.md', bytes: BYTES('m') }, { file: '3-c.csv', bytes: BYTES('c') }] }]);
    const text = [lineOf('1-a.txt', 'text file, 1 KB'), lineOf('2-b.md', 'Markdown file, 1 KB'), lineOf('3-c.csv', 'CSV file, 1 KB')].join('\n');
    assert.deepStrictEqual(turnFor(ws, text, { entryId: 'entry-1' }), { content: text, extraItems: [] });
  });

  test('the text item comes first, then the blocks', async () => {
    readyTurn();
    const { ws, entry, png, pdf } = await stored();
    const { content } = turnFor(ws, ALL_THREE, { entryId: entry.id });
    assert.ok(Array.isArray(content), 'an array');
    assert.deepStrictEqual(content[0], textItem(ALL_THREE));
    assert.deepStrictEqual(content.slice(1), [imageBlock('image/png', fs.readFileSync(png)), pdfBlock(fs.readFileSync(pdf))]);
  });

  test('two images come in the entry\'s order, whatever the text\'s', async () => {
    readyTurn();
    const ws = workspace();
    const first = pngBytes(100, 100);
    const second = pngBytes(200, 200);
    const entry = await store.writeMessageFiles(ws, ID, [{ name: 'first.png', bytes: first }, { name: 'second.png', bytes: second }]);
    const text = `${lineOf('2-second.png', 'PNG image, 1 KB')} then ${lineOf('1-first.png', 'PNG image, 1 KB')}`;
    assert.deepStrictEqual(turnFor(ws, text, { entryId: entry.id }).content,
      [textItem(text), imageBlock('image/png', first), imageBlock('image/png', second)]);
  });

  test('an entry file the text does not name gets its line appended, and its block', async () => {
    readyTurn();
    const ws = workspace();
    const png = pngBytes();
    const pdf = pdfBytes();
    const entry = await store.writeMessageFiles(ws, ID, [{ name: 'screenshot.png', bytes: png }, { name: 'report.pdf', bytes: pdf }]);
    const pdfLine = lineOf('2-report.pdf', 'PDF document, 1 KB');
    assert.deepStrictEqual(turnFor(ws, `please read ${pdfLine}`, { entryId: entry.id }).content,
      [textItem(`please read ${pdfLine}\n${PNG_LINE}`), imageBlock('image/png', png), pdfBlock(pdf)]);
    assert.deepStrictEqual(turnFor(ws, '', { entryId: entry.id }).content,
      [textItem(`${PNG_LINE}\n${pdfLine}`), imageBlock('image/png', png), pdfBlock(pdf)], 'with no text, the first line starts it');
  });

  test('another entry\'s line keeps its line and gives no block', async () => {
    readyTurn();
    const ws = workspace();
    await store.writeMessageFiles(ws, ID, [{ name: 'screenshot.png', bytes: pngBytes() }]);
    const pdf = pdfBytes();
    const later = await store.writeMessageFiles(ws, ID, [{ name: 'report.pdf', bytes: pdf }]);
    const text = `earlier ${PNG_LINE} and now ${lineOf('2-report.pdf', 'PDF document, 1 KB')}`;
    assert.deepStrictEqual(turnFor(ws, text, { entryId: later.id }).content, [textItem(text), pdfBlock(pdf)]);
  });

  test('a changed file and a missing file each give their form and no block', async () => {
    readyTurn();
    const { ws, entry, png, pdf } = await stored();
    fs.rmSync(png);
    fs.appendFileSync(pdf, 'x');
    const { content } = turnFor(ws, `look at these\n${PNG_LINE}\n${PDF_LINE}`, { entryId: entry.id });
    assert.strictEqual(content, `look at these\n${GONE('1-screenshot.png')}\n${CHANGED('3-report.pdf')}\n${NOTES_LINE}`);
    namesNoPath(content.replace(NOTES_LINE, ''));
  });

  test('a PNG recorded at 3,500,001 bytes gives no block', () => {
    readyTurn();
    const ws = workspace();
    const pdf = pdfBytes();
    const [entry] = handWritten(ws, [{ id: 'entry-1', files: [{ file: '1-big.png', bytes: pngBytes(640, 480, 3500001), width: 640, height: 480 }, { file: '2-report.pdf', bytes: pdf }] }]);
    assert.strictEqual(entry.files[0].bytes, 3500001);
    const { content } = turnFor(ws, 'two files', { entryId: 'entry-1' });
    assert.deepStrictEqual(content, [textItem(`two files\n${lineOf('1-big.png', 'PNG image, 3.6 MB')}\n${lineOf('2-report.pdf', 'PDF document, 1 KB')}`), pdfBlock(pdf)],
      'the PDF beside it is still sent');
  });

  test('an image 8,001 pixels wide gives no block', () => {
    readyTurn();
    const ws = workspace();
    handWritten(ws, [{ id: 'entry-1', files: [{ file: '1-wide.png', bytes: pngBytes(8001, 10), width: 8001, height: 10 }] }]);
    const text = lineOf('1-wide.png', 'PNG image, 1 KB');
    assert.deepStrictEqual(turnFor(ws, text, { entryId: 'entry-1' }).content, text);
  });

  test('an entry of six files gives no block for any of them', () => {
    readyTurn();
    const ws = workspace();
    const files = [1, 2, 3, 4, 5, 6].map((n) => ({ file: `${n}-shot.png`, bytes: pngBytes(10 * n, 10), width: 10 * n, height: 10 }));
    handWritten(ws, [{ id: 'entry-1', files }]);
    const text = files.map((f) => lineOf(f.file, 'PNG image, 1 KB')).join('\n');
    assert.deepStrictEqual(turnFor(ws, text, { entryId: 'entry-1' }).content, text);
  });

  test('an entry totalling more than the message limit gives no block for any of its files', () => {
    readyTurn();
    const ws = workspace();
    const big = (label) => Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(10000000 - 9, label)]);
    handWritten(ws, [{ id: 'entry-1', files: [{ file: '1-a.pdf', bytes: big('a') }, { file: '2-b.pdf', bytes: big('b') }, { file: '3-c.png', bytes: pngBytes(), width: 640, height: 480 }] }]);
    const { content } = turnFor(ws, 'three files', { entryId: 'entry-1' });
    assert.strictEqual(typeof content, 'string', 'no block: the text alone');
    assert.strictEqual(content, ['three files', GONE('1-a.pdf'), GONE('2-b.pdf'), GONE('3-c.png')].join('\n'));
  });

  test('with no entryId, no block', async () => {
    readyTurn();
    const { ws } = await stored();
    assert.deepStrictEqual(turnFor(ws, ALL_THREE), { content: ALL_THREE, extraItems: [] });
  });

  test('with an entryId the record does not hold, no block', async () => {
    readyTurn();
    const { ws } = await stored();
    assert.deepStrictEqual(turnFor(ws, ALL_THREE, { entryId: 'no-such-entry' }), { content: ALL_THREE, extraItems: [] });
  });

  test('a Codex runtime is given the checked text, a string, whatever the entry holds', async () => {
    readyTurn();
    const { ws, entry, png } = await stored();
    fs.rmSync(png);
    const sent = turn.buildTurn({ workspace: ws, conversationId: ID, runtime: 'codex', text: `just this ${PNG_LINE}`, entryId: entry.id });
    assert.deepStrictEqual(sent, { content: `just this ${GONE('1-screenshot.png')}`, extraItems: [] });
  });
});

// A file of `size` zero bytes, which takes no room on disk where the file
// system allows it.
function sparse(file, size) {
  const fd = fs.openSync(file, 'w');
  try { fs.ftruncateSync(fd, size); } finally { fs.closeSync(fd); }
}

// A record of `messages`, each file `{ file, size, width?, height? }` written
// as `size` zero bytes, sparse, and described with its true fingerprint, so
// each file is present and matches.
const TEN_MB = 10000000;
const zeroSums = new Map();
const zeroSum = (size) => zeroSums.get(size) || zeroSums.set(size, sha256(Buffer.alloc(size))).get(size);
function sparseRecord(ws, messages, id = ID) {
  fs.mkdirSync(folderOf(ws, id), { recursive: true });
  const described = messages.map((message) => ({
    id: message.id,
    files: message.files.map((f) => {
      sparse(path.join(folderOf(ws, id), f.file), f.size);
      const one = { file: f.file, name: f.file, type: f.file.slice(f.file.lastIndexOf('.') + 1), bytes: f.size, sha256: zeroSum(f.size) };
      if (f.width !== undefined) Object.assign(one, { width: f.width, height: f.height });
      return one;
    }),
  }));
  fs.writeFileSync(recordOf(ws, id), JSON.stringify({ messages: described, sent: {} }));
  return described;
}

// The bytes read from each file while the test runs, by path, through a
// descriptor or by name, and every path opened.
function countReads(t) {
  const realOpen = fs.openSync;
  const realRead = fs.readSync;
  const realReadFile = fs.readFileSync;
  const at = new Map();
  const opened = [];
  const counts = new Map();
  const add = (file, n) => counts.set(String(file), (counts.get(String(file)) || 0) + n);
  t.mock.method(fs, 'openSync', function openSync(file, ...rest) {
    const fd = realOpen.call(fs, file, ...rest);
    at.set(fd, file);
    opened.push(String(file));
    return fd;
  });
  t.mock.method(fs, 'readSync', function readSync(fd, ...rest) {
    const n = realRead.call(fs, fd, ...rest);
    add(at.get(fd), n);
    return n;
  });
  t.mock.method(fs, 'readFileSync', function readFileSync(source, ...rest) {
    const bytes = realReadFile.call(fs, source, ...rest);
    add(typeof source === 'number' ? at.get(source) : source, bytes.length);
    return bytes;
  });
  return { opened: (file) => opened.includes(file), from: (file) => counts.get(file) || 0 };
}

// Each answer the store gave turn.js, through the store's export, as
// `[file, answer]`.
function storeAnswers(t) {
  const real = store.readRecordedFile;
  const answers = [];
  t.mock.method(store, 'readRecordedFile', function readRecordedFile(...args) {
    const read = real.apply(store, args);
    answers.push([args[2], read]);
    return read;
  });
  return answers;
}
const kept = (answers) => answers.map(([file, read]) => [file, read.state, 'bytes' in read]);

describe('buildTurn: what a turn reads is bounded', () => {
  // Far past the largest file the store keeps, a 10,000,000-byte PDF, and
  // under the 2 GiB one read can take, so a read of the whole file happens
  // if nothing stops it.
  const HUGE = 250000000;

  test('a file far larger than the store keeps, its record edited to match, is not available and none of it is read', async (t) => {
    readyTurn();
    ready('readRecordedFile');
    const { ws, pdf } = await stored();
    sparse(pdf, HUGE);
    const record = JSON.parse(fs.readFileSync(recordOf(ws), 'utf8'));
    record.messages[0].files[2].bytes = HUGE;
    fs.writeFileSync(recordOf(ws), JSON.stringify(record));
    const reads = countReads(t);
    const read = store.readRecordedFile(ws, ID, '3-report.pdf');
    assert.deepStrictEqual([read.state, 'bytes' in read], ['missing', false]);
    const { content } = turnFor(ws, `the brief\n${lineOf('3-report.pdf', 'PDF document, 250 MB')}`);
    assert.strictEqual(content, `the brief\n${GONE('3-report.pdf')}`);
    namesNoPath(content);
    assert.strictEqual(reads.from(pdf), 0, 'none of the file is read');
    assert.strictEqual(reads.opened(pdf), false, 'the file is never opened');
  });

  test('an entry of six files keeps none of their bytes', (t) => {
    readyTurn();
    const ws = workspace();
    const files = [1, 2, 3, 4, 5, 6].map((n) => ({ file: `${n}-shot.png`, bytes: pngBytes(10 * n, 10), width: 10 * n, height: 10 }));
    handWritten(ws, [{ id: 'entry-1', files }]);
    const answers = storeAnswers(t);
    const { content } = turnFor(ws, 'six files', { entryId: 'entry-1' });
    assert.strictEqual(content, ['six files', ...files.map((f) => GONE(f.file))].join('\n'));
    assert.deepStrictEqual(kept(answers), [], 'none of the files is read, so none keeps bytes');
  });

  test('an entry totalling more than the message limit keeps none of its files\' bytes', (t) => {
    readyTurn();
    const ws = workspace();
    const big = (label) => Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(10000000 - 9, label)]);
    handWritten(ws, [{ id: 'entry-1', files: [{ file: '1-a.pdf', bytes: big('a') }, { file: '2-b.pdf', bytes: big('b') }, { file: '3-c.png', bytes: pngBytes(), width: 640, height: 480 }] }]);
    const answers = storeAnswers(t);
    const { content } = turnFor(ws, 'three files', { entryId: 'entry-1' });
    assert.strictEqual(content, ['three files', GONE('1-a.pdf'), GONE('2-b.pdf'), GONE('3-c.png')].join('\n'));
    assert.deepStrictEqual(kept(answers), [], 'none of the files is read, so none keeps bytes');
  });

  // A turn for `entry`, whose text names none of its files: the content and
  // whether each file was opened, with the bytes read from each.
  function namingNone(t, ws, entry) {
    const reads = countReads(t);
    const { content } = turnFor(ws, 'these files', { entryId: entry.id });
    const touched = entry.files.map((f) => [f.file, reads.opened(path.join(folderOf(ws), f.file)), reads.from(path.join(folderOf(ws), f.file))]);
    return { content, touched };
  }

  test('an entry of six files, its text naming none, opens none of them and names each not available', (t) => {
    readyTurn();
    const ws = workspace();
    const [entry] = sparseRecord(ws, [{ id: 'entry-1', files: [1, 2, 3, 4, 5, 6].map((n) => ({ file: `${n}-shot.png`, size: 1000, width: 10, height: 10 })) }]);
    const { content, touched } = namingNone(t, ws, entry);
    assert.strictEqual(content, ['these files', ...entry.files.map((f) => GONE(f.file))].join('\n'), 'no block: the text alone');
    assert.deepStrictEqual(touched, entry.files.map((f) => [f.file, false, 0]), 'no file is opened');
  });

  test('an entry over the message total, its text naming none, opens none of its files and names each not available', (t) => {
    readyTurn();
    const ws = workspace();
    const [entry] = sparseRecord(ws, [{ id: 'entry-1', files: [{ file: '1-a.pdf', size: TEN_MB }, { file: '2-b.pdf', size: TEN_MB }, { file: '3-c.png', size: 3500000, width: 640, height: 480 }] }]);
    const { content, touched } = namingNone(t, ws, entry);
    assert.strictEqual(content, ['these files', GONE('1-a.pdf'), GONE('2-b.pdf'), GONE('3-c.png')].join('\n'), 'no block: the text alone');
    assert.deepStrictEqual(touched, entry.files.map((f) => [f.file, false, 0]), 'no file is opened');
  });

  test('ten matching 10 MB PDFs in the entry, its text naming none, are not read and each is named not available', (t) => {
    readyTurn();
    const ws = workspace();
    const [entry] = sparseRecord(ws, [{ id: 'entry-1', files: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({ file: `${n}-report.pdf`, size: TEN_MB })) }]);
    const { content, touched } = namingNone(t, ws, entry);
    assert.strictEqual(typeof content, 'string', 'no block: the text alone');
    assert.strictEqual(content, ['these files', ...entry.files.map((f) => GONE(f.file))].join('\n'));
    assert.deepStrictEqual(touched, entry.files.map((f) => [f.file, false, 0]), 'no byte of any file is read');
  });

  test('ten matching 10 MB PDFs in the entry, its text naming one, check that line alone and send no block', (t) => {
    readyTurn();
    const ws = workspace();
    const [entry] = sparseRecord(ws, [{ id: 'entry-1', files: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({ file: `${n}-report.pdf`, size: TEN_MB })) }]);
    const named = lineOf('4-report.pdf', 'PDF document, 10 MB');
    const reads = countReads(t);
    const { content } = turnFor(ws, `this one\n${named}`, { entryId: entry.id });
    assert.strictEqual(typeof content, 'string', 'no block: the text alone');
    assert.strictEqual(content, [`this one\n${named}`, ...entry.files.filter((f) => f.file !== '4-report.pdf').map((f) => GONE(f.file))].join('\n'),
      'the named line is the one the record writes');
    for (const f of entry.files) {
      const file = path.join(folderOf(ws), f.file);
      if (f.file === '4-report.pdf') assert.ok(reads.from(file) > 0 && reads.from(file) <= TEN_MB + 1, `the named file is read once: ${reads.from(file)} bytes`);
      else assert.deepStrictEqual([reads.opened(file), reads.from(file)], [false, 0], `${f.file} is not opened`);
    }
  });

  test('a text quoting eleven earlier 10 MB PDFs keeps every line, each file read no further than its recorded size', (t) => {
    readyTurn();
    const ws = workspace();
    const earlier = sparseRecord(ws, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((n) => ({ id: `entry-${n}`, files: [{ file: `${n}-report.pdf`, size: TEN_MB }] })));
    const text = ['the brief', ...earlier.map(({ files: [f] }) => lineOf(f.file, 'PDF document, 10 MB'))].join('\n');
    const reads = countReads(t);
    const { content } = turnFor(ws, text);
    assert.strictEqual(content, text, 'each present file keeps the line the record writes');
    for (const { files: [f] } of earlier) {
      const read = reads.from(path.join(folderOf(ws), f.file));
      assert.ok(read <= f.bytes + 1, `${f.file}: read ${read} bytes`);
    }
  });
});
