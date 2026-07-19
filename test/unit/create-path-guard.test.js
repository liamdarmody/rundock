'use strict';
// Server guard for the Files sidebar create path: dot-leading components are
// refused so a new file is never invisible (leading-dot basename) and never a
// traversal ('.'/'..'). Independent of the workspace boundary check.
const { test, describe } = require('node:test');
const assert = require('node:assert');

const { _internal: srv } = require('../../server.js');
const { isSafeCreatePath } = srv;

describe('isSafeCreatePath', () => {
  test('accepts ordinary notes, boards, and nested folders', () => {
    for (const rel of ['note.md', 'notes/Plan.md', 'a/b/Board.md', 'Archive', 'my.folder/note.md']) {
      assert.strictEqual(isSafeCreatePath(rel), true, rel);
    }
  });

  test('rejects a leading-dot basename (would be hidden by the tree)', () => {
    assert.strictEqual(isSafeCreatePath('.secret.md'), false);
    assert.strictEqual(isSafeCreatePath('notes/.env'), false);
  });

  test('rejects "." and ".." segments (traversal)', () => {
    assert.strictEqual(isSafeCreatePath('..'), false);
    assert.strictEqual(isSafeCreatePath('.'), false);
    assert.strictEqual(isSafeCreatePath('notes/../secret.md'), false);
    assert.strictEqual(isSafeCreatePath('a/./b.md'), false);
  });

  test('rejects an intermediate dot-folder', () => {
    assert.strictEqual(isSafeCreatePath('.hidden/note.md'), false);
  });

  test('rejects empty and non-string input', () => {
    assert.strictEqual(isSafeCreatePath(''), false);
    assert.strictEqual(isSafeCreatePath(null), false);
    assert.strictEqual(isSafeCreatePath('/'), false);
  });
});
