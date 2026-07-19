'use strict';
// fileKind classifies tree entries. Board detection reads only the frontmatter
// head, so it must not load a whole large note into memory on every refresh.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { _internal: srv } = require('../../server.js');
const { fileKind } = srv;

function tmpFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-filekind-'));
  const full = path.join(dir, name);
  fs.writeFileSync(full, content);
  return full;
}

describe('fileKind', () => {
  test('detects a board by its kanban-plugin frontmatter key', () => {
    const full = tmpFile('board.md', '---\nkanban-plugin: basic\n---\n\n## Lane\n');
    assert.strictEqual(fileKind(full, 'board.md'), 'board');
  });

  test('a plain note is a note', () => {
    const full = tmpFile('note.md', '---\ntitle: Hi\n---\n\nBody.\n');
    assert.strictEqual(fileKind(full, 'note.md'), 'note');
  });

  test('classifies other types by extension', () => {
    assert.strictEqual(fileKind('/x/a.html', 'a.html'), 'artifact');
    assert.strictEqual(fileKind('/x/a.svg', 'a.svg'), 'artifact');
    assert.strictEqual(fileKind('/x/a.pdf', 'a.pdf'), 'pdf');
    assert.strictEqual(fileKind('/x/a.png', 'a.png'), 'image');
    assert.strictEqual(fileKind('/x/a.txt', 'a.txt'), 'file');
  });

  test('board detection still works with a large trailing body, without a full read', () => {
    const big = '---\nkanban-plugin: basic\n---\n\n' + 'x'.repeat(5 * 1024 * 1024);
    const full = tmpFile('bigboard.md', big);
    // Prove the whole file is not slurped: make readFileSync throw for the
    // duration. The bounded openSync/readSync path must still classify it.
    const orig = fs.readFileSync;
    fs.readFileSync = () => { throw new Error('fileKind must not read the whole file'); };
    try {
      assert.strictEqual(fileKind(full, 'bigboard.md'), 'board');
    } finally {
      fs.readFileSync = orig;
    }
  });
});
