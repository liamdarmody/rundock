'use strict';
// Files-sidebar creation menu model: creatable types and the path/label helpers.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const M = require('../../public/files-menu-model.js');

describe('files-menu-model', () => {
  test('the creatable types are note, board, folder, each with an icon', () => {
    assert.deepStrictEqual(M.CREATABLE_TYPES.map((t) => t.kind), ['note', 'board', 'folder']);
    assert.deepStrictEqual(M.CREATABLE_TYPES.map((t) => t.ext), ['.md', '.md', '']);
    for (const t of M.CREATABLE_TYPES) assert.ok(t.icon && t.icon.includes('<path') || t.icon.includes('<rect'), t.kind + ' has an icon');
  });

  test('creatablePath joins the folder, appends the extension, and sanitises the name', () => {
    assert.strictEqual(M.creatablePath('', 'Fresh idea', '.md'), 'Fresh idea.md');
    assert.strictEqual(M.creatablePath('notes', 'Plan', '.md'), 'notes/Plan.md');
    assert.strictEqual(M.creatablePath('a/b', 'Board', '.md'), 'a/b/Board.md');
    assert.strictEqual(M.creatablePath('', 'Archive', ''), 'Archive');
  });

  test('creatablePath never lets a name escape the folder', () => {
    assert.strictEqual(M.creatablePath('notes', '../secret', '.md'), 'notes/..-secret.md');
    assert.strictEqual(M.creatablePath('', 'a/b/c', '.md'), 'a-b-c.md');
    assert.strictEqual(M.creatablePath('notes/', 'x', '.md'), 'notes/x.md');
  });

  test('creatablePath returns empty for a blank name', () => {
    assert.strictEqual(M.creatablePath('notes', '   ', '.md'), '');
    assert.strictEqual(M.creatablePath('', '', '.md'), '');
  });

  test('parentFolder is the folder itself, or a file\'s containing folder', () => {
    assert.strictEqual(M.parentFolder('notes', true), 'notes');
    assert.strictEqual(M.parentFolder('notes/plan.md', false), 'notes');
    assert.strictEqual(M.parentFolder('plan.md', false), '');
    assert.strictEqual(M.parentFolder('a/b/c.md', false), 'a/b');
  });

  test('wikilinkFor uses the basename without a .md suffix', () => {
    assert.strictEqual(M.wikilinkFor('notes/Roadmap 2026.md'), '[[Roadmap 2026]]');
    assert.strictEqual(M.wikilinkFor('Board.md'), '[[Board]]');
    assert.strictEqual(M.wikilinkFor('image.png'), '[[image.png]]');
  });
});
