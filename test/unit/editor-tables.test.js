// Table rendering + strict byte-for-byte round-trip in the Tiptap editor.
//
// Policy: table serialization is source-preserving.
// - An unedited table re-emits its source bytes verbatim: padding, alignment
//   markers, and column spacing are never normalised.
// - Editing a cell changes ONLY that cell's content bytes; every other line
//   and every untouched cell span stays byte-exact.
// - Adding a row keeps all existing lines byte-exact and appends the new row
//   in canonical single-space style.
// Any other byte drift is a defect.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bootEditorEnv, roundTrip } from '../helpers/editor-harness.js';

const fixturePath = fileURLToPath(new URL('../fixtures/scoring-table.md', import.meta.url));
const fixtureSrc = readFileSync(fixturePath, 'utf8');

async function withEditor(rawMarkdown, fn) {
  const env = await bootEditorEnv();
  const element = env.window.document.createElement('div');
  env.window.document.body.appendChild(element);
  const { editor } = env.createEditor({ element, rawMarkdown });
  try {
    return await fn(editor, env);
  } finally {
    env.destroyEditor(editor);
    element.remove();
  }
}

function findCells(editor) {
  // Returns [{ pos, node }] for every tableCell/tableHeader in doc order.
  const cells = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') {
      cells.push({ pos, node });
    }
    return true;
  });
  return cells;
}

describe('tables: rendering', () => {
  test('a GFM table parses into a real table node, not dropped', async () => {
    const src = '| a | b |\n|---|---|\n| 1 | 2 |';
    await withEditor(src, (editor) => {
      let tables = 0;
      editor.state.doc.descendants((node) => { if (node.type.name === 'table') tables++; return true; });
      assert.equal(tables, 1, 'expected one table node in the document');
    });
  });

  test('the fixture scoring table renders with full structure', async () => {
    await withEditor(fixtureSrc, (editor) => {
      let tables = 0, rows = 0, headerCells = 0;
      editor.state.doc.descendants((node) => {
        if (node.type.name === 'table') tables++;
        if (node.type.name === 'tableRow') rows++;
        if (node.type.name === 'tableHeader') headerCells++;
        return true;
      });
      assert.equal(tables, 1, 'expected the scoring table to be present');
      assert.equal(headerCells, 7, 'expected 7 header cells: #, Option, Effort, Risk, Payoff, Fit, Score');
      assert.ok(rows >= 10, `expected >= 10 rows, got ${rows}`);
    });
  });
});

describe('tables: strict byte-for-byte round-trip (unedited)', () => {
  test('the scoring-table fixture round-trips byte-for-byte', async () => {
    assert.equal(await roundTrip(fixtureSrc), fixtureSrc);
  });

  test('non-uniform padding is preserved exactly', async () => {
    const src = '| # | Hook | Score |\n|---|------|-------|\n| 1 | Nobody falls behind | **9** |\n| 2 | Pretending  | 8.5 |';
    assert.equal(await roundTrip(src), src);
  });

  test('alignment markers are preserved exactly', async () => {
    const src = '| Left | Center | Right |\n|:-----|:------:|------:|\n| a | b | c |';
    assert.equal(await roundTrip(src), src);
  });

  test('escaped pipes inside cells are preserved exactly', async () => {
    const src = '| cmd | effect |\n|-----|--------|\n| a \\| b | pipes stay escaped |';
    assert.equal(await roundTrip(src), src);
  });

  test('table between prose blocks round-trips byte-for-byte', async () => {
    const src = 'Before the table.\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nAfter the table.';
    assert.equal(await roundTrip(src), src);
  });

  test('a ragged source row (fewer cells than the header) is preserved exactly', async () => {
    // markdown-it pads short rows with empty cells in the editor; the file
    // must keep the short row's original bytes on save.
    const src = '| a | b | c |\n|---|---|---|\n| only | two |';
    assert.equal(await roundTrip(src), src);
  });

  test('a blockquoted pipe-less table round-trips without gaining nesting', async () => {
    // Regression: the source capture included the '> ' prefix, and the
    // serializer re-applied the blockquote delimiter on top: one extra '>'
    // per save, doubling every cycle. Capture is now container-prefix-free.
    const src = '> a | b\n> --- | ---\n> 1 | 2';
    let out = src;
    for (let i = 0; i < 3; i++) out = await roundTrip(out);
    assert.equal(out, src);
  });

  test('a blockquoted piped table keeps delimiter, padding, and alignment bytes', async () => {
    const src = '> | aa  | b |\n> |:----|--:|\n> | 1   | 2 |';
    assert.equal(await roundTrip(src), src);
  });

  test('a list-nested table keeps its bytes', async () => {
    const src = '- item\n\n  | a | b |\n  |---|---|\n  | 1 | 2 |';
    assert.equal(await roundTrip(src), src);
  });

  test('undo restores byte-exact source even for non-canonical cell bytes', async () => {
    // Regression: the undo transaction itself re-marked the cell dirty, so
    // undo re-captured the cell (`_one_` -> `*one*`) instead of re-emitting
    // source bytes. History transactions no longer touch dirty flags.
    const src = '| a | b |\n|---|---|\n| _one_ | two |';
    await withEditor(src, async (editor, env) => {
      await new Promise((r) => setTimeout(r, 550));
      const cells = findCells(editor);
      const target = cells[2]; // the _one_ cell
      const from = target.pos + 2;
      editor.chain().insertContentAt({ from, to: from }, 'X').run();
      editor.commands.undo();
      assert.equal(env.getMarkdown(editor), src);
    });
  });

  test('a bold mark ending a cell does not corrupt neighbouring cells', async () => {
    // Regression: tiptap-markdown's expel-whitespace bookkeeping (state
    // .inlines) holds absolute offsets into the output buffer. A mark ending
    // exactly at a cell boundary left a stale entry that mangled the next
    // captured cell into asterisks. The capture now restores the stack.
    const src = '| # | Score |\n|---|-------|\n| 1 | **9** |\n| 2 | **8.5** |';
    const expected = '| # | Score |\n|---|-------|\n| 1 | **9** |\n| EDITED | **8.5** |';
    await withEditor(src, (editor, env) => {
      const cells = findCells(editor);
      const target = cells[4]; // the "2" cell
      assert.equal(target.node.textContent, '2');
      const from = target.pos + 2;
      const to = from + target.node.firstChild.content.size;
      editor.chain().insertContentAt({ from, to }, 'EDITED').run();
      assert.equal(env.getMarkdown(editor), expected);
    });
  });
});

describe('tables: strict byte-for-byte through edits', () => {
  test('editing one cell changes only that cell\'s bytes', async () => {
    const src = '| # | Hook | Score |\n|---|------|-------|\n| 1 | Nobody falls behind | **9** |\n| 2 | Pretending is worse | 8.5 |';
    const expected = '| # | Hook | Score |\n|---|------|-------|\n| 1 | Nobody falls behind | **9** |\n| 2 | REWRITTEN | 8.5 |';
    await withEditor(src, (editor, env) => {
      const cells = findCells(editor);
      // Cells in doc order: #, Hook, Score, 1, Nobody..., **9**, 2, Pretending..., 8.5
      const target = cells[7];
      assert.equal(target.node.textContent, 'Pretending is worse');
      const from = target.pos + 2; // into the cell's paragraph
      const to = from + target.node.firstChild.content.size;
      editor.chain().insertContentAt({ from, to }, 'REWRITTEN').run();
      assert.equal(env.getMarkdown(editor), expected);
    });
  });

  test('editing a padded cell keeps its original leading/trailing spacing', async () => {
    // The source pads cells with single spaces; the edited cell keeps them.
    const src = '| a | b |\n|---|---|\n| one | two |';
    const expected = '| a | b |\n|---|---|\n| one | CHANGED |';
    await withEditor(src, (editor, env) => {
      const cells = findCells(editor);
      const target = cells[3];
      assert.equal(target.node.textContent, 'two');
      const from = target.pos + 2;
      const to = from + target.node.firstChild.content.size;
      editor.chain().insertContentAt({ from, to }, 'CHANGED').run();
      assert.equal(env.getMarkdown(editor), expected);
    });
  });

  test('undoing a cell edit restores the byte-exact original', async () => {
    const src = '| a | b |\n|---|---|\n| one | two |';
    await withEditor(src, async (editor, env) => {
      // prosemirror-history groups changes landing within newGroupDelay
      // (500ms) into one undo event. In the app a user edit never shares a
      // group with the initial load; recreate that separation here.
      await new Promise((r) => setTimeout(r, 550));
      const cells = findCells(editor);
      const target = cells[3];
      const from = target.pos + 2;
      const to = from + target.node.firstChild.content.size;
      editor.chain().insertContentAt({ from, to }, 'CHANGED').run();
      editor.commands.undo();
      assert.equal(env.getMarkdown(editor), src);
    });
  });

  test('a table authored in the editor serializes in canonical style', async () => {
    await withEditor('Start here.', (editor, env) => {
      editor.chain().insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run();
      const out = env.getMarkdown(editor);
      assert.match(out, /\|( +[^|]*)+\|/, 'expected a pipe table in the output');
      assert.match(out, /\| --- \| --- \|/, 'expected a canonical delimiter row');
    });
  });
});
