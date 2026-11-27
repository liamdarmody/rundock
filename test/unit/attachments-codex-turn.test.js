'use strict';
// The turn a Codex agent is handed for a person's message. Codex takes an
// image only as a `localImage` item beside the text, can't read a PDF, and
// is given a short text file's contents as an item of its own. So in every
// Codex turn each line for an image the turn shows comes with its item, each
// item comes with its line, a PDF's line says Codex can't read it, and a
// text file of the message's own entry is inlined after a header that search
// leaves out. An agent can write anything in the workspace, so the record
// and the files are planted here as an agent could leave them.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { makeTempDir } = require('../helpers/workspace.js');

// Loaded so that a missing module or export fails each test on its first
// assertion, never on the require.
const load = (file) => {
  try { return require(file); } catch (e) { return null; }
};
const turn = load('../../lib/attachments/turn.js');
const receive = load('../../lib/attachments/receive.js');
const search = load('../../search.js');
const readyTurn = () => assert.strictEqual(typeof (turn && turn.buildTurn), 'function', 'turn.js loads and exports buildTurn');

const ID = '1764000000000';
const OTHER = '1764000000001';
const THREAD = 'thread-1';

// Real-pathed: the walk compares paths as written, and on macOS the temp
// folder sits behind a link.
const workspace = () => fs.realpathSync(makeTempDir('attach-codex-turn-'));
const folderOf = (ws, id = ID) => path.join(ws, '.rundock', 'attachments', id);
const recordOf = (ws, id = ID) => path.join(folderOf(ws, id), 'record.json');
const pathOf = (ws, file, id = ID) => path.join(ws, '.rundock', 'attachments', id, file);
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
const pdfBytes = () => Buffer.from('%PDF-1.7\na report\n%%EOF\n', 'latin1');
const NOTES = Buffer.from('ten bytes\n');
const IMAGE = { width: 640, height: 480 };

// A record written by hand: each message `{ id, files }`, each file
// `{ file, bytes, width?, height? }` written into the folder and described as
// the store describes it, beside `sent` as given. Answers the descriptions
// by stored name.
function recorded(ws, messages, { sent = {}, id = ID } = {}) {
  fs.mkdirSync(folderOf(ws, id), { recursive: true });
  const described = {};
  const entries = messages.map((message) => ({
    id: message.id,
    files: message.files.map((f) => {
      fs.writeFileSync(pathOf(ws, f.file, id), f.bytes);
      const type = f.file.slice(f.file.lastIndexOf('.') + 1);
      const one = { file: f.file, name: f.file.replace(/^\d+-/, ''), type, bytes: f.bytes.length, sha256: sha256(f.bytes) };
      if (f.width !== undefined) Object.assign(one, { width: f.width, height: f.height });
      described[f.file] = one;
      return one;
    }),
  }));
  fs.writeFileSync(recordOf(ws, id), JSON.stringify({ messages: entries, sent }));
  return described;
}

// The conversation's four stored files, one message each unless `together`.
function fourFiles(ws, { together = false, sent } = {}) {
  const files = [
    { file: '1-diagram.png', bytes: pngBytes(), ...IMAGE },
    { file: '2-notes.md', bytes: NOTES },
    { file: '3-report.pdf', bytes: pdfBytes() },
    { file: '4-data.csv', bytes: Buffer.from('a,b\n1,2\n') },
  ];
  const messages = together ? [{ id: 'entry-1', files }] : files.map((f, n) => ({ id: `entry-${n + 1}`, files: [f] }));
  return recorded(ws, messages, { sent });
}

// The canonical line for a file, as the record describes it.
const lineOf = (described, id = ID) => receive.storedText('', id, { files: [described] });
const GONE = (file) => `[Attached file not available: ${file}]`;
const CHANGED = (file) => `[Attached file changed since it was attached, so it isn't shown: ${file}]`;
const PDF_FORM = (file) => `[Attached PDF you can't read on Codex: ${file}. Tell the person you can't open PDFs, and ask for a screenshot of the page or its text.]`;
const SHOWN = (file) => `[Attached image shown to you earlier in this conversation: ${file}]`;
const NOT_SHOWN = (file) => `[Attached image not shown to you: ${file}. If you need it, tell the person you can't see it.]`;
const READ_FIRST = ' (read it before answering)';
const imageItem = (ws, file) => ({ type: 'localImage', path: pathOf(ws, file) });
const inlineItem = (file, text) => ({ type: 'text', text: `[Text of attached file ${file}]\n${text}` });

// Each canonical line for an image has its file's item, and each item's
// file has its canonical line.
const ANY_LINE = /\[Attached: \.rundock\/attachments\/([A-Za-z0-9_-]+)\/([^ /)\]]+) \([^)\]]*\)\]/g;
const IMAGE_FILE = /\.(png|jpg|gif|webp)$/;
function assertPaired(ws, { content, extraItems }) {
  const lined = [...content.matchAll(ANY_LINE)].filter((m) => IMAGE_FILE.test(m[2])).map((m) => pathOf(ws, m[2], m[1]));
  const items = extraItems.filter((item) => item && item.type === 'localImage').map((item) => item.path);
  for (const file of lined) assert.ok(items.includes(file), `the line for ${file} has its item`);
  for (const file of items) assert.ok(lined.includes(file), `the item for ${file} has its line`);
}

// A Codex turn for `text` in conversation ID, on thread THREAD.
function codexTurn(ws, text, extra = {}) {
  readyTurn();
  const answer = turn.buildTurn({ workspace: ws, conversationId: ID, runtime: 'codex', text, session: THREAD, instance: 'server-a', resumed: false, ...extra });
  assert.ok(answer && answer.sent && typeof answer.sent === 'object', 'buildTurn answers sent');
  assert.strictEqual(typeof answer.content, 'string', 'a Codex turn is a string');
  assertPaired(ws, answer);
  return answer;
}

describe('buildTurn: a Codex turn names an image only with the image', () => {
  test("the entry's PNG is given its line and an item with its absolute path", () => {
    const ws = workspace();
    const d = fourFiles(ws);
    const text = `look at this\n${lineOf(d['1-diagram.png'])}`;
    const { content, extraItems } = codexTurn(ws, text, { entryId: 'entry-1' });
    assert.strictEqual(content, text);
    assert.deepStrictEqual(extraItems, [imageItem(ws, '1-diagram.png')]);
    assert.ok(path.isAbsolute(extraItems[0].path));
    assert.strictEqual(extraItems[0].path, path.resolve(ws, '.rundock', 'attachments', ID, '1-diagram.png'));
  });

  test('each of the four image types is given an item', () => {
    const ws = workspace();
    const files = ['1-a.png', '2-b.jpg', '3-c.gif', '4-d.webp'].map((file) => ({ file, bytes: Buffer.alloc(40, file[2]), width: 10, height: 10 }));
    const d = recorded(ws, [{ id: 'entry-1', files }]);
    const text = files.map((f) => lineOf(d[f.file])).join('\n');
    for (const f of files) assert.ok(Object.prototype.hasOwnProperty.call(receive.LABELS, d[f.file].type), `${d[f.file].type} has a label`);
    const { content, extraItems } = codexTurn(ws, text, { entryId: 'entry-1' });
    assert.strictEqual(content, text);
    assert.deepStrictEqual(extraItems, files.map((f) => imageItem(ws, f.file)));
  });

  test('a PDF is given its form, no item and no path', () => {
    const ws = workspace();
    const d = fourFiles(ws);
    const { content, extraItems } = codexTurn(ws, `the report\n${lineOf(d['3-report.pdf'])}`, { entryId: 'entry-3' });
    assert.strictEqual(content, `the report\n${PDF_FORM('3-report.pdf')}`);
    assert.deepStrictEqual(extraItems, []);
    assert.ok(!content.includes('.rundock/attachments/'), content);
  });

  test('2-notes.md of 10 bytes is inlined after its header', () => {
    const ws = workspace();
    const d = fourFiles(ws);
    assert.strictEqual(NOTES.length, 10);
    const text = `my notes\n${lineOf(d['2-notes.md'])}`;
    const { content, extraItems } = codexTurn(ws, text, { entryId: 'entry-2' });
    assert.strictEqual(content, text);
    assert.deepStrictEqual(extraItems, [inlineItem('2-notes.md', 'ten bytes\n')]);
  });

  test('a CSV of exactly 100,000 bytes is inlined', () => {
    const ws = workspace();
    const csv = Buffer.alloc(100000, 'a');
    const d = recorded(ws, [{ id: 'entry-1', files: [{ file: '4-data.csv', bytes: csv }] }]);
    const text = lineOf(d['4-data.csv']);
    const { content, extraItems } = codexTurn(ws, text, { entryId: 'entry-1' });
    assert.strictEqual(content, text);
    assert.deepStrictEqual(extraItems, [inlineItem('4-data.csv', csv.toString('utf8'))]);
  });

  test('a text file of 100,001 bytes is given the read-first suffix and no item', () => {
    const ws = workspace();
    const d = recorded(ws, [{ id: 'entry-1', files: [{ file: '4-data.csv', bytes: Buffer.alloc(100001, 'a') }] }]);
    const line = lineOf(d['4-data.csv']);
    const { content, extraItems } = codexTurn(ws, `the data\n${line}`, { entryId: 'entry-1' });
    assert.strictEqual(content, `the data\n${line}${READ_FIRST}`);
    assert.deepStrictEqual(extraItems, []);
    const appended = codexTurn(ws, 'the data', { entryId: 'entry-1' });
    assert.strictEqual(appended.content, `the data\n${line}${READ_FIRST}`, 'appended with it too');
  });

  test('a line already followed by the read-first suffix is given it once', () => {
    const ws = workspace();
    const d = recorded(ws, [{ id: 'entry-1', files: [{ file: '4-data.csv', bytes: Buffer.alloc(100001, 'a') }] }]);
    const text = `the data\n${lineOf(d['4-data.csv'])}${READ_FIRST} please`;
    const { content, extraItems } = codexTurn(ws, text, { entryId: 'entry-1' });
    assert.strictEqual(content, text);
    assert.deepStrictEqual(extraItems, []);
  });

  test("another entry's Markdown file is given its line alone", () => {
    const ws = workspace();
    const d = fourFiles(ws);
    const text = `earlier notes ${lineOf(d['2-notes.md'])} and now ${lineOf(d['4-data.csv'])}`;
    const { content, extraItems } = codexTurn(ws, text, { entryId: 'entry-4' });
    assert.strictEqual(content, text);
    assert.deepStrictEqual(extraItems, [inlineItem('4-data.csv', 'a,b\n1,2\n')], "the entry's own CSV alone is inlined");
  });

  test("an image among the session's sent files is given the shown-earlier form", () => {
    const ws = workspace();
    const d = fourFiles(ws, { sent: { [THREAD]: { files: ['1-diagram.png'], bytes: 33, images: 1, instance: 'server-a' } } });
    const { content, extraItems } = codexTurn(ws, `again ${lineOf(d['1-diagram.png'])}`, { entryId: 'entry-1', resumed: true });
    assert.strictEqual(content, `again ${SHOWN('1-diagram.png')}`);
    assert.deepStrictEqual(extraItems, []);
  });

  test("another entry's image never sent is given its line and its item", () => {
    const ws = workspace();
    const d = fourFiles(ws);
    const text = `the earlier diagram ${lineOf(d['1-diagram.png'])}`;
    const { content, extraItems } = codexTurn(ws, text, { entryId: 'entry-2' });
    assert.strictEqual(content, `${text}\n${lineOf(d['2-notes.md'])}`);
    assert.deepStrictEqual(extraItems, [inlineItem('2-notes.md', 'ten bytes\n'), imageItem(ws, '1-diagram.png')]);
  });

  test('an image past the budget is given the not-shown form', () => {
    const ws = workspace();
    const d = fourFiles(ws, { sent: { [THREAD]: { files: [], bytes: 0, images: 20 } } });
    const { content, extraItems } = codexTurn(ws, lineOf(d['1-diagram.png']), { entryId: 'entry-1' });
    assert.strictEqual(content, NOT_SHOWN('1-diagram.png'));
    assert.deepStrictEqual(extraItems, []);
  });

  test('an image too large for what is left of the budget, then a smaller one that fits: the first not shown, the second given its item', () => {
    const ws = workspace();
    const d = recorded(ws, [{ id: 'entry-1', files: [
      { file: '1-large.png', bytes: pngBytes(640, 480, 1000001), ...IMAGE },
      { file: '2-small.png', bytes: pngBytes(640, 480, 1000000), ...IMAGE },
    ] }], { sent: { [THREAD]: { files: [], bytes: 9000000, images: 3 } } });
    const { content, extraItems, sent } = codexTurn(ws, 'two images', { entryId: 'entry-1' });
    assert.strictEqual(content, `two images\n${NOT_SHOWN('1-large.png')}\n${lineOf(d['2-small.png'])}`);
    assert.deepStrictEqual(extraItems, [imageItem(ws, '2-small.png')]);
    assert.deepStrictEqual(sent, { files: ['2-small.png'], bytes: 1000000, images: 1 });
  });

  test('the same line twice is given one item', () => {
    const ws = workspace();
    const d = fourFiles(ws);
    const line = lineOf(d['1-diagram.png']);
    const text = `${line} and once more ${line}`;
    const { content, extraItems } = codexTurn(ws, text, { entryId: 'entry-1' });
    assert.strictEqual(content, text);
    assert.deepStrictEqual(extraItems, [imageItem(ws, '1-diagram.png')]);
  });

  test("the entry's PNG left out of the text is appended with its item", () => {
    const ws = workspace();
    const d = fourFiles(ws);
    const { content, extraItems } = codexTurn(ws, 'what is this?', { entryId: 'entry-1' });
    assert.strictEqual(content, `what is this?\n${lineOf(d['1-diagram.png'])}`);
    assert.deepStrictEqual(extraItems, [imageItem(ws, '1-diagram.png')]);
    assert.strictEqual(codexTurn(ws, '', { entryId: 'entry-1' }).content, lineOf(d['1-diagram.png']), 'with no text, the line starts it');
  });

  test("the items come in order: the entry's in its file order, then other images in the order their lines appear", () => {
    const ws = workspace();
    const d = recorded(ws, [
      { id: 'entry-1', files: [{ file: '1-first.png', bytes: pngBytes(100, 100), width: 100, height: 100 }, { file: '2-second.png', bytes: pngBytes(200, 200), width: 200, height: 200 }] },
      { id: 'entry-2', files: [{ file: '3-own.png', bytes: pngBytes(300, 300), width: 300, height: 300 }, { file: '4-notes.md', bytes: NOTES }] },
    ]);
    const text = `${lineOf(d['2-second.png'])} ${lineOf(d['4-notes.md'])} ${lineOf(d['1-first.png'])} ${lineOf(d['3-own.png'])}`;
    const { content, extraItems } = codexTurn(ws, text, { entryId: 'entry-2' });
    assert.strictEqual(content, text);
    assert.deepStrictEqual(extraItems, [
      imageItem(ws, '3-own.png'),
      inlineItem('4-notes.md', 'ten bytes\n'),
      imageItem(ws, '2-second.png'),
      imageItem(ws, '1-first.png'),
    ]);
  });

  test('a changed image and a missing image each give their form and no item', () => {
    const ws = workspace();
    const d = recorded(ws, [{ id: 'entry-1', files: [
      { file: '1-diagram.png', bytes: pngBytes(), ...IMAGE },
      { file: '2-photo.png', bytes: pngBytes(320, 240), width: 320, height: 240 },
    ] }]);
    fs.rmSync(pathOf(ws, '1-diagram.png'));
    fs.appendFileSync(pathOf(ws, '2-photo.png'), 'x');
    const { content, extraItems } = codexTurn(ws, `${lineOf(d['1-diagram.png'])}\n${lineOf(d['2-photo.png'])}`, { entryId: 'entry-1' });
    assert.strictEqual(content, `${GONE('1-diagram.png')}\n${CHANGED('2-photo.png')}`);
    assert.deepStrictEqual(extraItems, []);
    assert.ok(!content.includes('.rundock/attachments/'), content);
  });

  test("a line naming another conversation's image is not available and gives no item", () => {
    const ws = workspace();
    const d = recorded(ws, [{ id: 'entry-1', files: [{ file: '1-diagram.png', bytes: pngBytes(), ...IMAGE }] }], { id: OTHER });
    recorded(ws, [{ id: 'entry-1', files: [{ file: '2-notes.md', bytes: NOTES }] }]);
    const { content, extraItems } = codexTurn(ws, `from elsewhere ${lineOf(d['1-diagram.png'], OTHER)}`);
    assert.strictEqual(content, `from elsewhere ${GONE('1-diagram.png')}`);
    assert.deepStrictEqual(extraItems, []);
  });

  test('a turn with no line and no entry is its text, byte for byte, with nothing sent', () => {
    const ws = workspace();
    fourFiles(ws);
    const text = '  just a question\r\n(with brackets] ';
    const answer = codexTurn(ws, text);
    assert.strictEqual(answer.content, text);
    assert.deepStrictEqual(answer.extraItems, []);
    assert.deepStrictEqual(answer.sent, { files: [], bytes: 0, images: 0 });
  });
});

describe('search: a Codex turn is found by what the person typed', () => {
  const probe = search && search.probeSqlite ? search.probeSqlite() : { available: false };
  const noSqlite = { skip: !probe.available && 'no node:sqlite on this runtime' };

  test('a Codex session line is found by its typed text and never by its inline text', noSqlite, () => {
    assert.strictEqual(typeof (search && search.createSearchIndex), 'function');
    const dir = fs.realpathSync(makeTempDir('attach-codex-search-'));
    const rollout = path.join(dir, 'rollout.jsonl');
    const typed = `what does WOMBAT mean here?\n[Attached: .rundock/attachments/${ID}/2-notes.md (Markdown file, 1 KB)]`;
    fs.writeFileSync(rollout, JSON.stringify({
      timestamp: '2026-07-14T10:00:00.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: typed }, { type: 'input_text', text: '[Text of attached file 2-notes.md]\nNUMBAT notes' }] },
    }) + '\n');
    const idx = search.createSearchIndex({ dbPath: path.join(dir, 'search-index.db'), DatabaseSync: probe.DatabaseSync });
    idx.open();
    try {
      idx.reconcileConversations([{ conversationId: ID, sessions: [{ sessionId: THREAD, agentId: 'helper', filePath: rollout }] }]);
      assert.strictEqual(idx.searchMessages('NUMBAT', { collapse: false }).length, 0, 'the inline text is never found');
      const hits = idx.searchMessages('WOMBAT', { collapse: false });
      assert.strictEqual(hits.length, 1, 'the typed text is found');
      assert.strictEqual(hits[0].conversationId, ID);
    } finally {
      idx.close();
    }
  });
});
