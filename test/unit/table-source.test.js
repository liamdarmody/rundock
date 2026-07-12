// Unit tests for the DOM-free table source module (span parsing, escaping,
// and byte-preserving reconstruction). The editor-level behaviour is covered
// in editor-tables.test.js; these pin the primitive contracts.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitRow, parseTableSource, escapeCellPipes, canonicalRow, canonicalTable, rebuildTable,
} from '../../public/editor/markdown/table-source.js';

describe('splitRow', () => {
  test('splits a piped row into exact spans', () => {
    const { prefix, cells, suffix } = splitRow('| 1 | Nobody falls behind | **9** |');
    assert.equal(prefix, '|');
    assert.equal(suffix, '|');
    assert.deepEqual(cells.map((c) => c.raw), [' 1 ', ' Nobody falls behind ', ' **9** ']);
    assert.deepEqual(cells.map((c) => c.content), ['1', 'Nobody falls behind', '**9**']);
    assert.equal(cells[1].leading, ' ');
    assert.equal(cells[1].trailing, ' ');
  });

  test('escaped pipes do not split cells', () => {
    const { cells } = splitRow('| a \\| b | c |');
    assert.deepEqual(cells.map((c) => c.content), ['a \\| b', 'c']);
  });

  test('non-uniform padding is captured exactly', () => {
    const { cells } = splitRow('|  wide  | tight |x|');
    assert.deepEqual(cells.map((c) => c.raw), ['  wide  ', ' tight ', 'x']);
    assert.equal(cells[0].leading, '  ');
    assert.equal(cells[0].trailing, '  ');
    assert.equal(cells[2].leading, '');
    assert.equal(cells[2].trailing, '');
  });

  test('rows without edge pipes still split (GFM optional edges)', () => {
    const { prefix, cells, suffix } = splitRow('a | b');
    assert.equal(prefix, '');
    assert.equal(suffix, '');
    assert.deepEqual(cells.map((c) => c.content), ['a', 'b']);
  });
});

describe('parseTableSource', () => {
  const src = '| # | Hook | Score |\n|---|------|-------|\n| 1 | First | **9** |\n| 2 | Second | 8.5 |';

  test('rows are indexed by source row with the delimiter held separately', () => {
    const t = parseTableSource(src);
    assert.equal(t.cols, 3);
    assert.equal(t.delimiter, '|---|------|-------|');
    assert.equal(t.rows.length, 3);
    assert.equal(t.rows[0].line, '| # | Hook | Score |');
    assert.equal(t.rows[2].cells[1].content, 'Second');
  });

  test('returns null for non-table input', () => {
    assert.equal(parseTableSource(''), null);
    assert.equal(parseTableSource('just a line'), null);
  });
});

describe('escapeCellPipes', () => {
  test('escapes bare pipes and leaves escaped ones alone', () => {
    assert.equal(escapeCellPipes('a | b'), 'a \\| b');
    assert.equal(escapeCellPipes('a \\| b'), 'a \\| b');
    assert.equal(escapeCellPipes('a \\\\| b'), 'a \\\\\\| b');
  });
});

describe('rebuildTable', () => {
  const src = '| # | Hook | Score |\n|---|------|-------|\n| 1 | First  | **9** |\n| 2 | Second | 8.5 |';
  const cleanGrid = [
    { srcIdx: 0, cells: [{ changed: false }, { changed: false }, { changed: false }] },
    { srcIdx: 1, cells: [{ changed: false }, { changed: false }, { changed: false }] },
    { srcIdx: 2, cells: [{ changed: false }, { changed: false }, { changed: false }] },
  ];

  test('all-clean grid re-emits the source byte-for-byte', () => {
    assert.equal(rebuildTable(src, cleanGrid), src);
  });

  test('an edited cell changes only its own bytes, keeping its padding', () => {
    const grid = structuredClone(cleanGrid);
    grid[2].cells[1] = { changed: true, content: 'REWRITTEN' };
    assert.equal(
      rebuildTable(src, grid),
      '| # | Hook | Score |\n|---|------|-------|\n| 1 | First  | **9** |\n| 2 | REWRITTEN | 8.5 |'
    );
  });

  test('a deleted row disappears while surviving rows keep their bytes (identity by srcIdx, not index)', () => {
    const grid = [cleanGrid[0], cleanGrid[2]]; // row 1 deleted, row 2 survives
    assert.equal(
      rebuildTable(src, grid),
      '| # | Hook | Score |\n|---|------|-------|\n| 2 | Second | 8.5 |'
    );
  });

  test('an added row lands in canonical style below byte-exact originals', () => {
    const grid = [...cleanGrid, { srcIdx: null, cells: [
      { changed: true, content: '3' }, { changed: true, content: 'Third' }, { changed: true, content: '7' },
    ] }];
    assert.equal(
      rebuildTable(src, grid),
      src + '\n| 3 | Third | 7 |'
    );
  });

  test('column count change returns null (caller falls back to canonical)', () => {
    const grid = cleanGrid.map((r) => ({ ...r, cells: [...r.cells, { changed: true, content: 'new' }] }));
    assert.equal(rebuildTable(src, grid), null);
  });
});

describe('canonical rendering', () => {
  test('canonicalRow renders single-space style', () => {
    assert.equal(canonicalRow(['a', 'b', 'c']), '| a | b | c |');
  });

  test('canonicalTable renders alignment markers', () => {
    assert.equal(
      canonicalTable(['L', 'C', 'R'], [['1', '2', '3']], ['left', 'center', 'right']),
      '| L | C | R |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |'
    );
  });
});
