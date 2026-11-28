'use strict';
// The attached-file lines in a message's text, found by one function that
// the page and the server share. A line is found only when the whole line is
// one of the three forms the server writes; anything a person or an agent
// typed that is near one of them stays text. The drift test builds every
// line the server writes, with the server's own code, so a change to either
// side that the other doesn't follow turns it red.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { makeTempDir } = require('../helpers/workspace.js');

// Loaded so that a missing module fails each test on its first assertion,
// never on the require.
const optional = (file, pattern) => {
  try { return require(file); } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND' && pattern.test(String(e.message))) return null;
    throw e;
  }
};
const lines = optional('../../public/attachment-lines.js', /attachment-lines/);
const store = require('../../lib/attachments/store.js');
const { storedText, LABELS } = require('../../lib/attachments/receive.js');
const { buildTurn } = require('../../lib/attachments/turn.js');

function split(text) {
  assert.strictEqual(typeof (lines && lines.splitAttachmentLines), 'function',
    'public/attachment-lines.js loads and exports splitAttachmentLines');
  return lines.splitAttachmentLines(text);
}

const ID = '1764000000000';
const ENTRY = {
  files: [
    { file: '1-diagram.png', name: 'diagram.png', type: 'png', bytes: 1900000, width: 2576, height: 1610 },
    { file: '2-report.pdf', name: 'report.pdf', type: 'pdf', bytes: 52000 },
    { file: '3-notes.csv', name: 'notes.csv', type: 'csv', bytes: 120 },
  ],
};
const attached = (file) => ({ kind: 'attached', id: ID, file });
const ENTRY_FILES = ENTRY.files.map((f) => attached(f.file));

// The present CSV's own line, and lines near it that are not the form.
const CSV_LINE = `[Attached: .rundock/attachments/${ID}/3-notes.csv (CSV file, 1 KB)]`;
const NEAR_MISSES = {
  'inside a sentence': `See ${CSV_LINE} for the numbers`,
  'with text after it': `${CSV_LINE} and more`,
  'with an id of 65 characters': CSV_LINE.replace(ID, 'a'.repeat(65)),
  'with a name off the stored pattern': CSV_LINE.replace('3-notes.csv', '0-notes.csv'),
  'with details holding a closing parenthesis': CSV_LINE.replace('CSV file', 'CSV file)'),
  'with details holding a closing bracket': CSV_LINE.replace('CSV file', 'CSV ] file'),
  'with details holding a line break': CSV_LINE.replace('CSV file, ', 'CSV file,\n'),
  'with details holding a carriage return': CSV_LINE.replace('CSV file, ', 'CSV file,\r'),
  'with details holding a line separator': CSV_LINE.replace('CSV file, ', 'CSV file,\u2028'),
  'with details holding a paragraph separator': CSV_LINE.replace('CSV file, ', 'CSV file,\u2029'),
};

function leftAsText(text) {
  const answer = split(text);
  assert.deepStrictEqual(answer, { text, files: [] });
}

const pngBytes = () => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(640, 16);
  b.writeUInt32BE(480, 20);
  return b;
};
const pdfBytes = (text) => Buffer.from(`%PDF-1.7\n${text}\n%%EOF\n`, 'latin1');

describe('the attached-file lines in a message', () => {
  test('a message of files only gives back no text and each file in order', () => {
    assert.deepStrictEqual(split(storedText('', ID, ENTRY)), { text: '', files: ENTRY_FILES });
  });

  test('a message ending in a line break gives back that text and each file in order', () => {
    assert.deepStrictEqual(split(storedText('a\n', ID, ENTRY)), { text: 'a\n', files: ENTRY_FILES });
  });

  test('a message of three lines gives back the three lines and each file, a repeated one twice', () => {
    const content = 'First line\nsecond line\n  third, indented';
    const entry = { files: [...ENTRY.files, ENTRY.files[0]] };
    assert.deepStrictEqual(split(storedText(content, ID, entry)),
      { text: content, files: [...ENTRY_FILES, attached('1-diagram.png')] });
  });

  test('a line between two others goes with the break before it, and every other character stays', () => {
    assert.deepStrictEqual(split(`top\n${CSV_LINE}\nbottom`), { text: 'top\nbottom', files: [attached('3-notes.csv')] });
    assert.deepStrictEqual(split(`${CSV_LINE}\n\nafter`), { text: '\nafter', files: [attached('3-notes.csv')] });
  });

  test('a canonical line inside a sentence is left as text', () => leftAsText(NEAR_MISSES['inside a sentence']));
  test('a canonical line with text after it on the same line is left as text', () => leftAsText(NEAR_MISSES['with text after it']));
  test('a line whose id has 65 characters is left as text', () => leftAsText(NEAR_MISSES['with an id of 65 characters']));
  test('a line whose name is off the stored pattern is left as text', () => leftAsText(NEAR_MISSES['with a name off the stored pattern']));
  test('a line whose details hold a closing parenthesis is left as text', () => leftAsText(NEAR_MISSES['with details holding a closing parenthesis']));
  test('a line whose details hold a closing bracket is left as text', () => leftAsText(NEAR_MISSES['with details holding a closing bracket']));
  test('a line whose details hold a line break is left as text', () => leftAsText(NEAR_MISSES['with details holding a line break']));
  test('a line whose details hold a carriage return is left as text', () => leftAsText(NEAR_MISSES['with details holding a carriage return']));
  test('a line whose details hold a line separator is left as text', () => leftAsText(NEAR_MISSES['with details holding a line separator']));
  test('a line whose details hold a paragraph separator is left as text', () => leftAsText(NEAR_MISSES['with details holding a paragraph separator']));

  test('the form for a file that is not available is found with its kind and no id', () => {
    assert.deepStrictEqual(split('Look at this\n[Attached file not available: 1-diagram.png]'),
      { text: 'Look at this', files: [{ kind: 'not-available', file: '1-diagram.png' }] });
  });

  test('the form for a file changed since it was attached is found with its kind and no id', () => {
    assert.deepStrictEqual(split('[Attached file changed since it was attached, so it isn\'t shown: 2-report.pdf]\nLook at this'),
      { text: 'Look at this', files: [{ kind: 'changed', file: '2-report.pdf' }] });
  });

  test('a value that is not text comes back as it is, with no files', () => {
    split('');
    assert.deepStrictEqual(lines.splitAttachmentLines(undefined), { text: undefined, files: [] });
  });

  test('the id and stored-name patterns are the store\'s own', () => {
    split('');
    assert.strictEqual(lines.ID_PATTERN.source, store.ID_PATTERN.source);
    assert.strictEqual(lines.STORED_NAME.source, store.STORED_NAME.source);
  });

  // The history says which files a reply names, and the page draws them, so
  // the two read the lines with the same function. A pattern of its own in
  // the history would have to spell a form, and every form opens with
  // "[Attached".
  test('the server\'s history finds the lines with this function and spells no form of its own', () => {
    const history = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'protocol', 'handlers', 'history.js'), 'utf8');
    assert.ok(history.includes("require('../../../public/attachment-lines.js')"), 'history.js requires public/attachment-lines.js');
    assert.ok(history.includes('splitAttachmentLines('), 'history.js calls splitAttachmentLines');
    assert.ok(!history.toLowerCase().includes('[attached'), 'history.js spells no form of an attached-file line itself');
  });

  test('every line the server writes is found, and the server leaves each near miss as typed', async () => {
    split('');
    for (const type of Object.keys(LABELS)) {
      const file = `7-file.${type}`;
      assert.deepStrictEqual(split(storedText('', ID, { files: [{ file, type, bytes: 4096 }] })),
        { text: '', files: [attached(file)] }, `the ${type} line`);
    }

    const workspace = fs.realpathSync(makeTempDir('attach-lines-'));
    const entry = await store.writeMessageFiles(workspace, ID, [
      { name: 'diagram.png', bytes: pngBytes() },
      { name: 'report.pdf', bytes: pdfBytes('a report') },
      { name: 'notes.csv', bytes: Buffer.from('a,b\n1,2\n') },
    ]);
    assert.deepStrictEqual(entry.files.map((f) => f.file), ['1-diagram.png', '2-report.pdf', '3-notes.csv']);
    assert.strictEqual(storedText('', ID, { files: [entry.files[2]] }), CSV_LINE);
    const folder = path.join(workspace, '.rundock', 'attachments', ID);
    fs.unlinkSync(path.join(folder, '1-diagram.png'));
    fs.writeFileSync(path.join(folder, '2-report.pdf'), pdfBytes('another report'));

    const sent = buildTurn({ workspace, conversationId: ID, text: storedText('Here', ID, entry) });
    assert.deepStrictEqual(split(sent.content), {
      text: 'Here',
      files: [{ kind: 'not-available', file: '1-diagram.png' }, { kind: 'changed', file: '2-report.pdf' }, attached('3-notes.csv')],
    });

    for (const [label, text] of Object.entries(NEAR_MISSES)) {
      assert.strictEqual(buildTurn({ workspace, conversationId: ID, text }).content, text, `a line ${label}`);
    }
  });
});
