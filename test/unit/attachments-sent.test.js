'use strict';
// What each session has been sent natively: the copies of a person's images
// and PDFs that went to an agent as copies of their own, not as lines. The
// record keeps them per session under `sent`, so a session is never sent the
// same file twice and never more than the budget. An agent can write the
// record, so every test here plants what an agent could (a link, a deleted
// conversation, an entry of the wrong shape, a session named `__proto__`)
// and checks that the store neither follows it nor trusts it.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { makeTempDir } = require('../helpers/workspace.js');

// Loaded so that a missing export fails each test on its first assertion,
// never on the require.
const load = (file) => {
  try { return require(file); } catch (e) { return null; }
};
const store = load('../../lib/attachments/store.js');
const detect = load('../../lib/attachments/detect.js');
const turn = load('../../lib/attachments/turn.js');
const receive = load('../../lib/attachments/receive.js');
const ready = (name) => assert.strictEqual(typeof (store && store[name]), 'function');
const budgetReady = () => assert.strictEqual(typeof (detect && detect.NATIVE_BUDGET), 'object');

const ID = '1764000000000';
const LINKS = { skip: process.platform === 'win32' && 'links need privileges on Windows' };

// Real-pathed: the walk compares paths as written, and on macOS the temp
// folder sits behind a link.
const workspace = () => fs.realpathSync(makeTempDir('attach-sent-'));
const attachmentsOf = (ws) => path.join(ws, '.rundock', 'attachments');
const folderOf = (ws, id = ID) => path.join(attachmentsOf(ws), id);
const recordOf = (ws, id = ID) => path.join(folderOf(ws, id), 'record.json');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
function pngBytes(size = 33) {
  const b = Buffer.alloc(size);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(10, 16);
  b.writeUInt32BE(10, 20);
  return b;
}
const describeFile = (file, bytes) => {
  const type = file.slice(file.lastIndexOf('.') + 1);
  const one = { file, name: file.replace(/^\d+-/, ''), type, bytes: bytes.length, sha256: sha256(bytes) };
  return type === 'png' ? { ...one, width: 10, height: 10 } : one;
};

// A record listing one message's files, and `sent` as given.
const DIAGRAM = pngBytes();
const MESSAGES = [{ id: 'entry-1', files: [describeFile('1-diagram.png', DIAGRAM)] }];
function withRecord(sent = {}) {
  const ws = workspace();
  writeJson(recordOf(ws), { messages: MESSAGES, sent });
  fs.writeFileSync(path.join(folderOf(ws), '1-diagram.png'), DIAGRAM);
  return ws;
}

// A record of one entry, `entry-1`, holding `files` (stored name to bytes),
// each written into the folder, beside `sent` as given.
function withFiles(files, sent = {}) {
  const ws = workspace();
  const described = Object.entries(files).map(([file, bytes]) => describeFile(file, bytes));
  writeJson(recordOf(ws), { messages: [{ id: 'entry-1', files: described }], sent });
  for (const [file, bytes] of Object.entries(files)) fs.writeFileSync(path.join(folderOf(ws), file), bytes);
  return ws;
}
const lineOf = (ws, file) => receive.storedText('', ID, { files: [store.readRecordedFile(ws, ID, file).described] });

// A turn for `text` in conversation ID on `runtime`, for session-1 unless
// another is given; it first asserts the turn answers what it sent.
function turnFor(ws, text, { runtime = 'claude', session = 'session-1', ...extra } = {}) {
  assert.strictEqual(typeof (turn && turn.buildTurn), 'function', 'turn.js loads and exports buildTurn');
  const answer = turn.buildTurn({ workspace: ws, conversationId: ID, runtime, text, entryId: 'entry-1', session, ...extra });
  assert.ok(answer && answer.sent && typeof answer.sent === 'object', 'buildTurn answers sent');
  return answer;
}
// The base64 blocks a Claude Code turn carries.
const blocksOf = ({ content }) => (Array.isArray(content) ? content.slice(1) : []);

describe('recordSent', () => {
  test('adds to a session entry, lists each file once and sets the instance it is given', () => {
    ready('recordSent');
    const ws = withRecord();
    assert.strictEqual(store.recordSent(ws, ID, 'thread-1', { files: ['1-diagram.png'], bytes: 33, images: 1 }), true);
    assert.deepStrictEqual(readJson(recordOf(ws)).sent, { 'thread-1': { files: ['1-diagram.png'], bytes: 33, images: 1 } });
    store.recordSent(ws, ID, 'thread-1', { files: ['1-diagram.png', '3-report.pdf'], bytes: 100, images: 0 }, { instance: 'server-a' });
    const record = readJson(recordOf(ws));
    assert.deepStrictEqual(record.sent, { 'thread-1': { files: ['1-diagram.png', '3-report.pdf'], bytes: 133, images: 1, instance: 'server-a' } });
    assert.deepStrictEqual(record.messages, MESSAGES);
  });

  test('replace sets the entry to what was sent and its instance alone', () => {
    ready('recordSent');
    const ws = withRecord({ 'thread-1': { files: ['1-diagram.png', '5-shot.png'], bytes: 900, images: 2, instance: 'server-a' }, other: { files: [], bytes: 0, images: 0 } });
    assert.strictEqual(store.recordSent(ws, ID, 'thread-1', { files: ['7-chart.png'], bytes: 40, images: 1 }, { instance: 'server-b', replace: true }), true);
    const record = readJson(recordOf(ws));
    assert.deepStrictEqual(record.sent, { 'thread-1': { files: ['7-chart.png'], bytes: 40, images: 1, instance: 'server-b' }, other: { files: [], bytes: 0, images: 0 } });
    assert.deepStrictEqual(record.messages, MESSAGES);
  });

  test('writes nothing for a conversation with no record, or a session that is not a non-empty string', () => {
    ready('recordSent');
    const ws = workspace();
    assert.strictEqual(store.recordSent(ws, ID, 'thread-1', { files: ['1-diagram.png'], bytes: 33, images: 1 }), false);
    assert.strictEqual(fs.existsSync(attachmentsOf(ws)), false);
    const recorded = withRecord();
    const before = fs.readFileSync(recordOf(recorded));
    for (const session of ['', null, undefined, 7, ['thread-1']]) {
      assert.strictEqual(store.recordSent(recorded, ID, session, { files: ['1-diagram.png'], bytes: 33, images: 1 }), false, String(session));
    }
    assert.deepStrictEqual(fs.readFileSync(recordOf(recorded)), before);
  });

  test('writes nothing for a deleted conversation', () => {
    ready('recordSent');
    const ws = withRecord();
    writeJson(path.join(attachmentsOf(ws), 'deleted.json'), [ID]);
    const before = fs.readFileSync(recordOf(ws));
    assert.strictEqual(store.recordSent(ws, ID, 'thread-1', { files: ['1-diagram.png'], bytes: 33, images: 1 }), false);
    assert.deepStrictEqual(fs.readFileSync(recordOf(ws)), before);
  });

  test('never writes through a link at the conversation folder', LINKS, () => {
    ready('recordSent');
    const ws = workspace();
    const outside = fs.realpathSync(makeTempDir('attach-sent-outside-'));
    writeJson(path.join(outside, 'record.json'), { messages: MESSAGES, sent: {} });
    const before = fs.readFileSync(path.join(outside, 'record.json'));
    fs.mkdirSync(attachmentsOf(ws), { recursive: true });
    fs.symlinkSync(outside, folderOf(ws));
    assert.strictEqual(store.recordSent(ws, ID, 'thread-1', { files: ['1-diagram.png'], bytes: 33, images: 1 }), false);
    assert.deepStrictEqual(fs.readFileSync(path.join(outside, 'record.json')), before);
  });

  test('a malformed entry is left as it was', () => {
    ready('recordSent');
    const malformed = [
      { files: [], bytes: -1, images: 0 },
      { files: [], bytes: 1.5, images: 0 },
      { files: [], bytes: 0, images: '2' },
      { files: '1-diagram.png', bytes: 0, images: 0 },
      { files: [7], bytes: 0, images: 0 },
      { files: [], images: 0 },
      null,
      [],
      'spent',
    ];
    for (const entry of malformed) {
      const ws = withRecord({ 'thread-1': entry });
      const before = fs.readFileSync(recordOf(ws));
      assert.strictEqual(store.recordSent(ws, ID, 'thread-1', { files: ['1-diagram.png'], bytes: 33, images: 1 }), false, JSON.stringify(entry));
      assert.strictEqual(store.recordSent(ws, ID, 'thread-1', { files: ['1-diagram.png'], bytes: 33, images: 1 }, { replace: true }), false, JSON.stringify(entry));
      assert.deepStrictEqual(fs.readFileSync(recordOf(ws)), before, JSON.stringify(entry));
      // Counted as spent, on either runtime and however the thread was opened.
      const line = lineOf(ws, '1-diagram.png');
      const claude = turnFor(ws, 'look', { session: 'thread-1' });
      assert.deepStrictEqual([claude.content, claude.sent], [`look\n${line}`, { files: [], bytes: 0, images: 0 }], JSON.stringify(entry));
      for (const resumed of [false, true]) {
        const codex = turnFor(ws, 'look', { runtime: 'codex', session: 'thread-1', instance: 'server-b', resumed });
        assert.deepStrictEqual([codex.content, codex.extraItems], ["look\n[Attached image not shown to you: 1-diagram.png. If you need it, tell the person you can't see it.]", []], JSON.stringify(entry));
      }
    }
  });

  test('a session named __proto__ is kept as an entry of its own and the prototype is untouched', () => {
    ready('recordSent');
    const ws = withRecord();
    assert.strictEqual(store.recordSent(ws, ID, '__proto__', { files: ['1-diagram.png'], bytes: 33, images: 1 }), true);
    assert.strictEqual(store.recordSent(ws, ID, '__proto__', { files: ['1-diagram.png'], bytes: 33, images: 1 }), true);
    const text = fs.readFileSync(recordOf(ws), 'utf8');
    assert.ok(text.includes('"__proto__":{"files":["1-diagram.png"],"bytes":66,"images":2}'), text);
    assert.strictEqual(Object.prototype.files, undefined);
    assert.strictEqual(({}).bytes, undefined);
  });
});

describe('NATIVE_BUDGET', () => {
  test('is 10,000,000 bytes and 20 images, frozen, beside limits left as they were', () => {
    budgetReady();
    assert.deepStrictEqual({ ...detect.NATIVE_BUDGET }, { bytes: 10000000, images: 20 });
    assert.ok(Object.isFrozen(detect.NATIVE_BUDGET));
    assert.deepStrictEqual({ ...detect.LIMITS }, { imageBytes: 3500000, imagePixels: 8000, pdfBytes: 10000000, textBytes: 1000000, files: 5, messageBytes: 20000000 });
  });
});

describe('buildTurn: what a session was sent bounds what it is sent again', () => {
  test('a Claude Code session sent a PNG and then handed the same entry again gets its line and no block', () => {
    const ws = withRecord();
    const first = turnFor(ws, 'look');
    assert.strictEqual(blocksOf(first).length, 1, 'the first turn carries the block');
    assert.deepStrictEqual(first.sent, { files: ['1-diagram.png'], bytes: 33, images: 1 });
    ready('recordSent');
    assert.strictEqual(store.recordSent(ws, ID, 'session-1', first.sent), true);
    const again = turnFor(ws, 'look again');
    assert.strictEqual(again.content, `look again\n${lineOf(ws, '1-diagram.png')}`);
    assert.deepStrictEqual(again.sent, { files: [], bytes: 0, images: 0 });
    const other = turnFor(ws, 'look', { session: 'session-2' });
    assert.strictEqual(blocksOf(other).length, 1, 'another session is sent it');
  });

  test("a Claude Code session at 20 images is given a 21st image's line alone", () => {
    const at = (images) => withRecord({ 'session-1': { files: [], bytes: 0, images } });
    const ws = at(20);
    const answer = turnFor(ws, 'one more');
    assert.strictEqual(answer.content, `one more\n${lineOf(ws, '1-diagram.png')}`);
    assert.deepStrictEqual(answer.sent, { files: [], bytes: 0, images: 0 });
    const twentieth = turnFor(at(19), 'the twentieth');
    assert.strictEqual(blocksOf(twentieth).length, 1, 'the 20th image is sent');
    assert.deepStrictEqual(twentieth.sent, { files: ['1-diagram.png'], bytes: 33, images: 1 });
  });

  test('a session at 9,000,000 bytes is given a block for a 1,000,000-byte image and not for a 1,000,001-byte one', () => {
    const sent = { 'session-1': { files: [], bytes: 9000000, images: 2 } };
    const fits = withFiles({ '1-shot.png': pngBytes(1000000) }, sent);
    assert.deepStrictEqual(turnFor(fits, 'a shot').sent, { files: ['1-shot.png'], bytes: 1000000, images: 1 });
    assert.strictEqual(blocksOf(turnFor(fits, 'a shot')).length, 1);
    const over = withFiles({ '1-shot.png': pngBytes(1000001) }, sent);
    const answer = turnFor(over, 'a shot');
    assert.strictEqual(answer.content, `a shot\n${lineOf(over, '1-shot.png')}`);
    assert.deepStrictEqual(answer.sent, { files: [], bytes: 0, images: 0 });
  });

  test('a file too large for what is left of the budget is given its line alone, and one after it that fits its block', () => {
    const ws = withFiles({ '1-large.png': pngBytes(1000001), '2-small.png': pngBytes(1000000) }, { 'session-1': { files: [], bytes: 9000000, images: 2 } });
    const answer = turnFor(ws, 'two shots');
    assert.strictEqual(answer.content[0].text, ['two shots', lineOf(ws, '1-large.png'), lineOf(ws, '2-small.png')].join('\n'));
    assert.strictEqual(blocksOf(answer).length, 1);
    assert.strictEqual(blocksOf(answer)[0].source.data, pngBytes(1000000).toString('base64'), "the second file's block");
    assert.deepStrictEqual(answer.sent, { files: ['2-small.png'], bytes: 1000000, images: 1 });
  });

  test('what a process was sent before its session was known counts too', () => {
    const ws = withRecord();
    const answer = turnFor(ws, 'look', { session: undefined, unrecorded: { files: ['1-diagram.png'], bytes: 33, images: 1 } });
    assert.strictEqual(answer.content, `look\n${lineOf(ws, '1-diagram.png')}`);
    const full = turnFor(withRecord(), 'look', { session: undefined, unrecorded: { files: [], bytes: 0, images: 20 } });
    assert.deepStrictEqual(full.sent, { files: [], bytes: 0, images: 0 });
  });

  test('an inline text file is recorded nowhere', () => {
    const ws = withFiles({ '1-diagram.png': DIAGRAM, '2-notes.md': Buffer.from('ten bytes\n') });
    const answer = turnFor(ws, 'both', { runtime: 'codex', session: 'thread-1', instance: 'server-a', resumed: false });
    assert.deepStrictEqual(answer.extraItems.map((item) => item.type), ['localImage', 'text']);
    assert.deepStrictEqual(answer.sent, { files: ['1-diagram.png'], bytes: 33, images: 1 });
    const notes = turnFor(withFiles({ '2-notes.md': Buffer.from('ten bytes\n') }), 'notes', { runtime: 'codex', session: 'thread-1' });
    assert.deepStrictEqual(notes.sent, { files: [], bytes: 0, images: 0 });
  });
});
