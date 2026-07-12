// Table source preservation. DOM-free on purpose: this module is imported by
// Node tests directly and by the table node extension in the browser.
//
// Policy: table serialization is source-preserving, never normalising.
// The markdown-it parse stage stamps each table with its raw source slice
// (src) and each row with its source row index (srcIdx). At serialize time:
//
//   - a row whose cells are all clean re-emits its source line verbatim
//   - a row with an edited cell is rebuilt from the source cell spans, so
//     only the edited cell's content bytes change (its original leading and
//     trailing whitespace is kept)
//   - rows added in the editor serialize in canonical single-space style
//   - the delimiter line (alignment markers, dash counts) is emitted verbatim
//
// If the column count changed, per-span reconstruction is no longer
// meaningful; the caller falls back to canonical style for the whole table.

// Splits one table line into { prefix, cells, suffix } where cells are
// { raw, leading, content, trailing } and raw excludes the pipe delimiters.
// Backslash escapes the next character, so \| does not split (GFM).
export function splitRow(line) {
  const hasLeadingPipe = line.startsWith('|');
  let i = hasLeadingPipe ? 1 : 0;
  const prefix = hasLeadingPipe ? '|' : '';
  const segments = [];
  let start = i;
  let escaped = false;
  for (; i < line.length; i++) {
    const ch = line[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '|') {
      segments.push(line.slice(start, i));
      start = i + 1;
    }
  }
  const tail = line.slice(start);
  let suffix = '';
  if (start === line.length && line.endsWith('|')) {
    // The line ended exactly on a pipe: that pipe is the closing delimiter.
    suffix = '|';
  } else if (tail.length || segments.length === 0) {
    // Trailing content without a closing pipe is a final cell (GFM allows
    // pipe-less table edges).
    segments.push(tail);
  }
  const cells = segments.map((raw) => {
    const leading = (raw.match(/^\s*/) || [''])[0];
    const trailing = raw === leading ? '' : (raw.match(/\s*$/) || [''])[0];
    const content = raw.slice(leading.length, raw.length - trailing.length);
    return { raw, leading, content, trailing };
  });
  return { prefix, cells, suffix };
}

// Parses a table's raw source slice into rows with exact spans.
// Returns { lines, headerIdx: 0, delimiterIdx: 1, rows, cols } where rows is
// indexed by SOURCE ROW index (header = 0, first body row = 1, ...) and each
// entry is { line, cells } — the delimiter line is excluded from rows and
// kept as `delimiter`.
export function parseTableSource(src) {
  if (typeof src !== 'string' || !src.length) return null;
  const lines = src.split('\n');
  if (lines.length < 2) return null;
  const header = splitRow(lines[0]);
  const delimiter = lines[1];
  const rows = [{ line: lines[0], cells: header.cells, prefix: header.prefix, suffix: header.suffix }];
  for (let i = 2; i < lines.length; i++) {
    const parsed = splitRow(lines[i]);
    rows.push({ line: lines[i], cells: parsed.cells, prefix: parsed.prefix, suffix: parsed.suffix });
  }
  return { lines, rows, delimiter, cols: header.cells.length };
}

// Escapes pipe characters for markdown table cell content. The bundled
// prosemirror-markdown esc() predates GFM-table pipe escaping, so the table
// serializer applies this to freshly serialized (edited/new) cell content.
export function escapeCellPipes(text) {
  let out = '';
  let escaped = false;
  for (const ch of String(text)) {
    if (escaped) { out += ch; escaped = false; continue; }
    if (ch === '\\') { out += ch; escaped = true; continue; }
    out += ch === '|' ? '\\|' : ch;
  }
  return out;
}

// Renders one canonical row: | a | b | c |
export function canonicalRow(contents) {
  return `| ${contents.join(' | ')} |`;
}

// Renders a full canonical table (used for tables authored in the editor,
// or as the fallback when the column count no longer matches the source).
// alignments: array of null | 'left' | 'center' | 'right'.
export function canonicalTable(headerContents, bodyRows, alignments = []) {
  const delim = headerContents.map((_, i) => {
    const a = alignments[i];
    if (a === 'left') return ':---';
    if (a === 'center') return ':---:';
    if (a === 'right') return '---:';
    return '---';
  });
  const lines = [canonicalRow(headerContents), `| ${delim.join(' | ')} |`];
  for (const row of bodyRows) lines.push(canonicalRow(row));
  return lines.join('\n');
}

// Reassembles a table from its source plus the current editor grid.
//
// grid: array of rows in document order; each row is
//   { srcIdx: number|null, cells: [{ changed: boolean, content: string }] }
// where content is only consulted for changed cells (and for all cells of
// rows with srcIdx null). Returns the table text, or null when per-span
// reconstruction is impossible (the column count changed, detected on the
// header row) — callers then fall back to canonicalTable. Ragged source
// rows (fewer or more cells than the header) are handled per-row.
export function rebuildTable(source, grid) {
  const parsed = typeof source === 'string' ? parseTableSource(source) : source;
  if (!parsed) return null;
  if (!grid.length) return null;
  if (grid[0].cells.length !== parsed.cols) return null;

  const out = [];
  grid.forEach((row, gi) => {
    const srcRow = row.srcIdx != null ? parsed.rows[row.srcIdx] : null;
    if (srcRow) {
      // GFM rows may be ragged: markdown-it pads short source rows with
      // empty cells and truncates long ones to the header width, so the
      // editor grid can have more or fewer cells than the source line.
      // Grid cells beyond the source spans ("extras") only appear in the
      // output if they were actually edited; source spans beyond the grid
      // (truncated by the parser) are preserved verbatim.
      const spanCount = srcRow.cells.length;
      const gridCore = row.cells.slice(0, spanCount);
      const extras = row.cells.slice(spanCount);
      if (gridCore.every((c) => !c.changed) && extras.every((c) => !c.changed)) {
        out.push(srcRow.line);
      } else {
        const prefix = srcRow.prefix !== '' ? srcRow.prefix : '|';
        const suffix = srcRow.suffix !== '' ? srcRow.suffix : '|';
        const parts = [];
        for (let j = 0; j < spanCount; j++) {
          const span = srcRow.cells[j];
          const c = gridCore[j];
          if (!c || !c.changed) { parts.push(span.raw); continue; }
          parts.push((span.leading || ' ') + c.content + (span.trailing || ' '));
        }
        for (const c of extras) {
          if (c.changed) parts.push(` ${c.content} `);
        }
        out.push(prefix + parts.join('|') + suffix);
      }
    } else {
      out.push(canonicalRow(row.cells.map((c) => c.content)));
    }
    if (gi === 0) out.push(parsed.delimiter);
  });
  return out.join('\n');
}
