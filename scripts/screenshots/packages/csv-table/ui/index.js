// CSV table: a read-only renderer for .csv files, mounted by Rundock's
// extension host.
//
// This is the whole extension. The host inlines this one file into a
// sandboxed frame (opaque origin, no network, no filesystem), waits for a
// `ready` message, then posts `init` carrying the opened file's path, its
// text, and the active theme. Everything below either parses that text or draws it; nothing here
// reaches outside the frame except through the four messages the host's
// contract names.
//
// The file is UMD-shaped so the parser and the escaper can be tested under
// Node with `require`, while the same bytes run as a plain inline script in
// the frame: when `module` exists the functions are exported, otherwise they
// are attached to `window` and the browser bootstrap at the bottom runs.

(function (root, factory) {
  if (typeof module === 'object' && module && module.exports) {
    module.exports = factory();
  } else {
    root.RundockCsvTable = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // How many data rows the table draws. Beyond this the caption says how
  // many were left out; a frame that tries to lay out a hundred thousand
  // rows helps nobody.
  var MAX_ROWS = 5000;

  // The only characters that matter for HTML text and attribute contexts.
  // Every cell passes through this before it is put anywhere near innerHTML.
  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // RFC 4180 with the usual tolerances: quoted fields may hold commas,
  // newlines and doubled quotes; records end with CRLF or LF; a trailing
  // newline does not produce an empty final record. Two things are refused
  // rather than guessed at, because guessing would draw a table that
  // silently disagrees with the file: a quoted field that never closes, and
  // text after a closing quote before the next delimiter.
  function parseCsv(text) {
    var rows = [];
    var row = [];
    var field = '';
    var i = 0;
    var n = text.length;
    var line = 1;
    var quoted = false;
    var fieldStartLine = 1;
    var sawAnything = false;

    function endField() {
      row.push(field);
      field = '';
    }
    function endRow() {
      endField();
      rows.push(row);
      row = [];
    }

    while (i < n) {
      var ch = text[i];
      if (quoted) {
        if (ch === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          quoted = false;
          i += 1;
          var next = text[i];
          if (i < n && next !== ',' && next !== '\n' && next !== '\r') {
            throw new Error('line ' + line + ': text after a closing quote must be a comma or a line break');
          }
          continue;
        }
        if (ch === '\n') line += 1;
        field += ch;
        i += 1;
        continue;
      }
      if (ch === '"') {
        if (field.length !== 0) {
          throw new Error('line ' + line + ': a quote inside an unquoted field; quote the whole field and double the inner quotes');
        }
        quoted = true;
        fieldStartLine = line;
        sawAnything = true;
        i += 1;
        continue;
      }
      if (ch === ',') {
        endField();
        sawAnything = true;
        i += 1;
        continue;
      }
      if (ch === '\r' || ch === '\n') {
        endRow();
        if (ch === '\r' && text[i + 1] === '\n') i += 1;
        i += 1;
        line += 1;
        sawAnything = false;
        continue;
      }
      field += ch;
      sawAnything = true;
      i += 1;
    }
    if (quoted) {
      throw new Error('line ' + fieldStartLine + ': a quoted field is never closed');
    }
    // A final record without a trailing line break still counts; a trailing
    // line break has already closed the last record and leaves nothing.
    if (sawAnything || field.length || row.length) endRow();
    return rows;
  }

  function formatCount(value) {
    return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function plural(count, noun) {
    return formatCount(count) + ' ' + noun + (count === 1 ? '' : 's');
  }

  // Turn parsed rows into the table's HTML. Pure: takes rows, returns a
  // string and the facts the caption states, so a test can read both.
  // Every cell goes through escapeHtml; nothing from the file reaches the
  // markup unescaped.
  function renderTableHtml(rows) {
    if (!rows.length) {
      return { html: '<p class="note">This file is empty.</p>', rows: 0, columns: 0, ragged: 0, shown: 0 };
    }
    var header = rows[0];
    var body = rows.slice(1);
    var total = body.length;
    var shown = Math.min(total, MAX_ROWS);
    var width = header.length;
    var ragged = 0;
    var r;
    for (r = 0; r < body.length; r += 1) {
      if (body[r].length !== header.length) ragged += 1;
      if (body[r].length > width) width = body[r].length;
    }

    var parts = [];
    var captionParts = [plural(total, 'row'), plural(header.length, 'column')];
    if (total > MAX_ROWS) {
      captionParts.push('showing the first ' + formatCount(MAX_ROWS));
    }
    if (ragged) {
      captionParts.push(plural(ragged, 'ragged row') + ' padded to the widest');
    }
    parts.push('<table><caption>' + escapeHtml(captionParts.join(', ')) + '</caption>');
    parts.push('<thead><tr>');
    var c;
    for (c = 0; c < width; c += 1) {
      parts.push('<th>' + escapeHtml(c < header.length ? header[c] : '') + '</th>');
    }
    parts.push('</tr></thead><tbody>');
    for (r = 0; r < shown; r += 1) {
      var row = body[r];
      parts.push(row.length === header.length ? '<tr>' : '<tr class="ragged">');
      for (c = 0; c < width; c += 1) {
        parts.push('<td>' + escapeHtml(c < row.length ? row[c] : '') + '</td>');
      }
      parts.push('</tr>');
    }
    parts.push('</tbody></table>');
    if (total > MAX_ROWS) {
      parts.push('<p class="note">Showing the first ' + formatCount(MAX_ROWS) + ' of '
        + formatCount(total) + ' rows. The rest are in the file, not in this view.</p>');
    }
    return { html: parts.join(''), rows: total, columns: header.length, ragged: ragged, shown: shown };
  }

  // Two palettes, one stylesheet. The host names the active theme on init
  // and the bootstrap sets `theme-dark` on the body for 'dark'; every other
  // value, and a missing theme, leaves the light palette in force. The dark
  // values are Rundock's own dark chrome tones (surface #212121, elevated
  // #272727, border #3D3D3D, text #F0EDE8) so the frame sits level with the
  // pane around it rather than glowing inside it. Inlined from here because
  // the host composes the frame from the entry alone; there is no
  // stylesheet to load.
  var THEME_DARK_CLASS = 'theme-dark';

  function themeClass(theme) {
    return theme === 'dark' ? THEME_DARK_CLASS : '';
  }

  var STYLES = [
    'html,body{margin:0;padding:0;background:#ffffff;color:#1f2328;',
    'font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}',
    '#csv-root{padding:12px 16px 16px}',
    'table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}',
    'caption{caption-side:top;text-align:left;padding:0 0 8px;color:#57606a;font-size:12px}',
    'th,td{border:1px solid #d0d7de;padding:4px 8px;text-align:left;vertical-align:top;',
    'white-space:pre-wrap;overflow-wrap:anywhere}',
    'th{background:#f6f8fa;font-weight:600;position:sticky;top:0}',
    'tbody tr:nth-child(even) td{background:#fafbfc}',
    'tr.ragged td{background:#fff8e6}',
    '.note{color:#57606a;font-size:12px;margin:8px 0 0}',
    '.error{color:#a40e26;white-space:pre-wrap}',
    'body.theme-dark{background:#212121;color:#F0EDE8}',
    'body.theme-dark caption,body.theme-dark .note{color:#9A9590}',
    'body.theme-dark th,body.theme-dark td{border-color:#3D3D3D}',
    'body.theme-dark th{background:#272727}',
    'body.theme-dark tbody tr:nth-child(even) td{background:#1E1E1E}',
    'body.theme-dark tr.ragged td{background:#332A1A}',
    'body.theme-dark .error{color:#F0706E}',
  ].join('');

  return {
    MAX_ROWS: MAX_ROWS,
    STYLES: STYLES,
    THEME_DARK_CLASS: THEME_DARK_CLASS,
    themeClass: themeClass,
    escapeHtml: escapeHtml,
    parseCsv: parseCsv,
    renderTableHtml: renderTableHtml,
    formatCount: formatCount,
  };
}));

// The browser bootstrap. Runs only where there is a document and a parent
// to talk to, which is the sandboxed frame; under Node's `require` the
// guard is false and nothing below executes.
(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (!window.RundockCsvTable) return;
  var lib = window.RundockCsvTable;
  var host = window.parent;

  // The contract's envelope: a plain object with a string `type`, posted to
  // the parent with a wildcard target because the frame's own origin is
  // opaque and the host's origin is not something the frame can know.
  function post(message) {
    host.postMessage(message, '*');
  }

  var style = document.createElement('style');
  style.textContent = lib.STYLES;
  document.head.appendChild(style);

  var rootEl = document.createElement('div');
  rootEl.id = 'csv-root';
  document.body.appendChild(rootEl);

  function measure() {
    var doc = document.documentElement;
    var body = document.body;
    return Math.max(doc ? doc.scrollHeight : 0, body ? body.scrollHeight : 0);
  }

  function reportSize() {
    post({ type: 'resize', height: measure() });
  }

  function showError(reason) {
    rootEl.innerHTML = '<p class="error">' + lib.escapeHtml('Could not read this file as CSV: ' + reason) + '</p>';
    reportSize();
    post({ type: 'error', message: 'CSV table: ' + reason });
  }

  function render(content) {
    var rows;
    try {
      rows = lib.parseCsv(content);
    } catch (e) {
      showError(e && e.message ? e.message : String(e));
      return;
    }
    rootEl.innerHTML = lib.renderTableHtml(rows).html;
    reportSize();
  }

  function onInit(data) {
    // The theme is applied before anything is drawn, so no frame ever
    // flashes the wrong palette; an absent or unknown theme is the light one.
    document.body.className = lib.themeClass(data.theme);
    if (typeof data.content !== 'string') {
      // A host that has not yet adopted the init payload: say so rather
      // than draw an empty table that looks like the file's fault.
      rootEl.innerHTML = '<p class="note">'
        + lib.escapeHtml('The host sent no file content with init, so there is nothing to render.')
        + '</p>';
      reportSize();
      return;
    }
    render(data.content);
  }

  window.addEventListener('message', function (event) {
    // Only the host may speak to this frame. Its origin is unknowable from
    // here, but its window is the parent, and nothing else holds a handle.
    if (event.source !== host) return;
    var data = event.data;
    if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;
    if (data.type === 'init') {
      onInit(data);
      return;
    }
    if (data.type === 'refused') {
      var note = document.createElement('p');
      note.className = 'note';
      note.textContent = 'The host refused a "' + data.of + '" message: ' + data.reason;
      rootEl.appendChild(note);
    }
  });

  post({ type: 'ready' });
}());
