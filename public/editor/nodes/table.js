// Tables: Obsidian-parity GFM tables in the Tiptap editor with STRICT
// byte-for-byte, source-preserving serialization (policy: silently
// normalising a table on save is a defect).
//
// How the round-trip holds:
//
//  parse    markdown-it already parses GFM tables; a core rule here stamps
//           each table_open with its raw source slice (data-src) and each
//           tr_open with its source row index (data-src-idx). Those land as
//           node attrs via parseHTML.
//  track    a ProseMirror plugin marks a cell dirty the moment a change
//           touches its range. The plugin is armed by the factory AFTER the
//           initial setContent so the load itself marks nothing.
//  emit     the serializer rebuilds the table from the source spans
//           (markdown/table-source.js): clean rows re-emit their source line
//           verbatim (identity by srcIdx, so deleting a row never shifts
//           another row's bytes); a dirty cell is spliced into its row with
//           its original leading/trailing whitespace; rows added in the
//           editor append in canonical single-space style. If the column
//           count changed (or the table never had a source), the whole table
//           serializes in canonical style.
//
// Cells are single-line in GFM: only textblock children serialize, joined
// with a literal <br> (Obsidian's own multi-line-cell convention). Cells
// carrying colspan/rowspan cannot be expressed in GFM; such tables fall back
// to canonical style with spans flattened.

import { Table, TableRow, TableHeader, TableCell, Plugin, PluginKey } from '../../vendor/tiptap-bundle.mjs';
import { parseTableSource, rebuildTable, canonicalTable, escapeCellPipes } from '../markdown/table-source.js';

export const tableDirtyKey = new PluginKey('rundockTableDirty');

// ---------------------------------------------------------------------------
// markdown-it: stamp source slices onto the token stream
// ---------------------------------------------------------------------------

function stampTableSource(state) {
  const tokens = state.tokens;
  if (!tokens.some((t) => t.type === 'table_open')) return;
  const lines = state.src.split('\n');
  let rowIdx = 0;
  for (const tok of tokens) {
    if (tok.type === 'table_open') {
      rowIdx = 0;
      if (tok.map) {
        const raw = lines.slice(tok.map[0], tok.map[1]).join('\n');
        tok.attrSet('data-src', encodeURIComponent(raw));
      }
    } else if (tok.type === 'tr_open') {
      // Source row index counts the header row as 0 and skips the delimiter
      // line, matching parseTableSource's rows array.
      tok.attrSet('data-src-idx', String(rowIdx));
      rowIdx += 1;
    }
  }
}

export function registerTableMarkdownIt(md) {
  md.core.ruler.push('rundock_table_src', stampTableSource);
}

// ---------------------------------------------------------------------------
// dirty tracking
// ---------------------------------------------------------------------------

function collectChangedRanges(transactions) {
  // All step maps across the batch, in order, so each step's range can be
  // mapped forward into final-doc coordinates.
  const maps = [];
  for (const tr of transactions) for (const step of tr.steps) maps.push(step.getMap());
  const ranges = [];
  let idx = 0;
  for (const tr of transactions) {
    for (const step of tr.steps) {
      maps[idx].forEach((fromA, toA, fromB, toB) => {
        let from = fromB;
        let to = toB;
        for (let j = idx + 1; j < maps.length; j++) {
          from = maps[j].map(from, -1);
          to = maps[j].map(to, 1);
        }
        ranges.push([from, to]);
      });
      idx += 1;
    }
  }
  return ranges;
}

function createDirtyTrackingPlugin() {
  return new Plugin({
    key: tableDirtyKey,
    state: {
      init: () => ({ armed: false }),
      apply: (tr, value) => (tr.getMeta(tableDirtyKey) === 'arm' ? { armed: true } : value),
    },
    appendTransaction(transactions, oldState, newState) {
      if (!tableDirtyKey.getState(newState).armed) return null;
      if (!transactions.some((tr) => tr.docChanged)) return null;
      const ranges = collectChangedRanges(transactions);
      if (!ranges.length) return null;
      let tr = null;
      newState.doc.descendants((node, pos) => {
        const name = node.type.name;
        if (name !== 'tableCell' && name !== 'tableHeader') return true;
        if (node.attrs.dirty) return false;
        const start = pos;
        const end = pos + node.nodeSize;
        // Strict interior overlap: zero-width changes inside the cell count,
        // changes that merely abut the cell's boundary do not.
        if (ranges.some(([f, t]) => t > start && f < end)) {
          tr = tr || newState.tr;
          tr.setNodeMarkup(pos, null, { ...node.attrs, dirty: true });
        }
        return false;
      });
      return tr;
    },
  });
}

// ---------------------------------------------------------------------------
// serialization
// ---------------------------------------------------------------------------

// Serializes a cell's inline content out of band: renders into the state's
// buffer, slices the result off, and restores the buffer. state.closed is
// neutralised by the caller so no block-close newlines leak into the capture.
function captureCellContent(state, cell) {
  const start = state.out.length;
  const prevInTable = state.inTable;
  // tiptap-markdown's MarkdownSerializerState tracks expel-whitespace marks
  // in state.inlines with ABSOLUTE offsets into state.out. A mark that ends
  // exactly at the end of a cell leaves its entry on the stack; after the
  // capture truncates state.out those offsets are stale and the next render
  // would trim the wrong bytes. Snapshot the stack depth and restore it.
  const inlinesDepth = Array.isArray(state.inlines) ? state.inlines.length : null;
  state.inTable = true;
  let first = true;
  cell.forEach((block) => {
    if (!block.isTextblock) return; // GFM cells cannot carry nested blocks
    if (!first) state.out += '<br>';
    state.renderInline(block, false);
    first = false;
  });
  const text = state.out.slice(start);
  state.out = state.out.slice(0, start);
  state.inTable = prevInTable;
  if (inlinesDepth !== null) state.inlines.length = inlinesDepth;
  return escapeCellPipes(text);
}

function cellHasSpan(cell) {
  return (cell.attrs.colspan || 1) > 1 || (cell.attrs.rowspan || 1) > 1;
}

function serializeTableNode(state, node) {
  // Capture phase: state.closed must not flush into the captures.
  const prevClosed = state.closed;
  state.closed = null;

  let anySpan = false;
  const grid = [];
  node.forEach((row) => {
    const cells = [];
    row.forEach((cell) => {
      if (cellHasSpan(cell)) anySpan = true;
      cells.push({ node: cell, changed: !!cell.attrs.dirty, align: cell.attrs.textAlign || null });
    });
    grid.push({ srcIdx: row.attrs.srcIdx, cells });
  });

  const src = !anySpan && node.attrs.src ? node.attrs.src : null;
  const parsed = src ? parseTableSource(src) : null;

  let text = null;
  if (parsed) {
    const rebuildGrid = grid.map((row) => ({
      srcIdx: row.srcIdx,
      cells: row.cells.map((c) => {
        const needsContent = c.changed || row.srcIdx == null;
        return { changed: c.changed, content: needsContent ? captureCellContent(state, c.node) : null };
      }),
    }));
    text = rebuildTable(parsed, rebuildGrid);
  }
  if (text == null && grid.length) {
    // Canonical fallback: new table, column-structure change, or spans.
    const header = grid[0];
    const alignments = header.cells.map((c) => c.align);
    const headerContents = header.cells.map((c) => captureCellContent(state, c.node));
    const bodyRows = grid.slice(1).map((row) => row.cells.map((c) => captureCellContent(state, c.node)));
    text = canonicalTable(headerContents, bodyRows, alignments);
  }

  state.closed = prevClosed;
  if (text == null) return;
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    state.write(line);
    // No newline after the last line: closeBlock owns the separation from
    // the next block, and a table at end-of-document must not grow a
    // trailing newline (byte-for-byte).
    if (i < lines.length - 1) state.ensureNewLine();
  });
  state.closeBlock(node);
}

// ---------------------------------------------------------------------------
// extensions
// ---------------------------------------------------------------------------

export const RundockTable = Table.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      src: {
        default: null,
        parseHTML: (el) => {
          const v = el.getAttribute('data-src');
          if (!v) return null;
          try { return decodeURIComponent(v); } catch { return null; }
        },
        renderHTML: (attrs) => (attrs.src ? { 'data-src': encodeURIComponent(attrs.src) } : {}),
      },
    };
  },

  addProseMirrorPlugins() {
    return [...(this.parent?.() || []), createDirtyTrackingPlugin()];
  },

  addStorage() {
    return {
      markdown: {
        serialize: serializeTableNode,
        parse: {
          setup(markdownit) {
            registerTableMarkdownIt(markdownit);
          },
        },
      },
    };
  },
});

export const RundockTableRow = TableRow.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      srcIdx: {
        default: null,
        parseHTML: (el) => {
          const v = el.getAttribute('data-src-idx');
          return v == null || v === '' ? null : Number(v);
        },
        renderHTML: (attrs) => (attrs.srcIdx == null ? {} : { 'data-src-idx': String(attrs.srcIdx) }),
      },
    };
  },
});

function cellAttributes(parentAttrs) {
  return {
    ...parentAttrs,
    dirty: {
      default: false,
      parseHTML: () => false, // never trusted from the DOM; the plugin owns it
      renderHTML: () => ({}),
    },
    textAlign: {
      default: null,
      parseHTML: (el) => (el.style && el.style.textAlign) || null,
      renderHTML: (attrs) => (attrs.textAlign ? { style: `text-align: ${attrs.textAlign}` } : {}),
    },
  };
}

export const RundockTableHeader = TableHeader.extend({
  addAttributes() { return cellAttributes(this.parent?.()); },
});

export const RundockTableCell = TableCell.extend({
  addAttributes() { return cellAttributes(this.parent?.()); },
});

export const tableExtensions = [RundockTable, RundockTableRow, RundockTableHeader, RundockTableCell];
