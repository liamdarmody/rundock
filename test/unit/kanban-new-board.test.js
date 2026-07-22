'use strict';
// Rundock seeds a new Kanban board with three standard columns so "New board"
// opens ready to use instead of blank (Obsidian's new board is frontmatter-only,
// which in Rundock rendered as an empty, un-buildable board). The seed must be
// byte-exact canonical form so the very first save never reformats the file.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const Kanban = require('../../public/kanban.js');

describe('newBoardContent: seeded three-column board', () => {
  test('is detected as a board file', () => {
    assert.ok(Kanban.isBoardFile(Kanban.newBoardContent()));
  });

  test('parses to three empty standard columns', () => {
    const board = Kanban.parse(Kanban.newBoardContent());
    assert.deepEqual(board.lanes.map((l) => l.title), ['To Do', 'In Progress', 'Done']);
    assert.ok(board.lanes.every((l) => l.items.length === 0), 'every column starts empty');
  });

  test('is byte-exact canonical form (first save does not reformat it)', () => {
    const content = Kanban.newBoardContent();
    assert.equal(Kanban.serialize(Kanban.parse(content)), content);
  });
});
