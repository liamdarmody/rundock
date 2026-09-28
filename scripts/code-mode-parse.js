'use strict';
// How a command line is read, for the Code-mode verdict: split into the
// commands it runs, and each command into its words.
//
// This is not a shell. It reads exactly as much as the verdict needs and errs
// toward asking wherever it cannot be sure: a word whose value is only known
// when the line runs is marked, never guessed at.
//
// Three dialects, because the same characters mean different things:
//   bash  a backslash escapes the next character; $ and backticks expand
//   ps    a backslash is a path separator; a backtick escapes; $ expands
//   cmd   a backslash is a path separator; %NAME% expands; ^ escapes

// ── Spans whose end is found by reading, not by searching ───────────────────
// A command substitution, a backtick substitution and a here-document each
// hold text with rules of its own: quotes inside `$( )` start afresh, and a
// here-document's body is data up to its delimiter line. Each is read to its
// true end, so an operator, quote or parenthesis inside never ends it early.
// -1 means the end was never found: the caller treats the line as unreadable.

// The index of the `)` closing the `(` at `open`.
function closeParen(s, open, dialect) {
  let depth = 0;
  let quote = null;
  const pending = [];
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (quote === "'") { if (ch === "'") quote = null; continue; }
    if (dialect === 'bash' && ch === '\\') { i++; continue; }
    if (dialect === 'ps' && ch === '`') { i++; continue; }
    if (ch === '$' && s[i + 1] === '(') { const j = closeParen(s, i + 1, dialect); if (j < 0) return -1; i = j; continue; }
    if (dialect === 'bash' && ch === '`') { const j = closeBacktick(s, i); if (j < 0) return -1; i = j; continue; }
    if (quote === '"') { if (ch === '"') quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (dialect === 'bash' && ch === '#' && /\s/.test(s[i - 1] || ' ')) { while (i + 1 < s.length && s[i + 1] !== '\n') i++; continue; }
    // `<<<` is a here-string: one word of data, never a here-document.
    if (dialect === 'bash' && ch === '<' && s[i + 1] === '<' && s[i + 2] === '<') { i += 2; continue; }
    if (dialect === 'bash' && ch === '<' && s[i + 1] === '<' && s[i + 2] !== '<') {
      const m = heredocMarker(s, i + 2);
      if (!m) return -1;
      pending.push(m);
      i = m.end - 1;
      continue;
    }
    if (ch === '\n' && pending.length) {
      const j = skipHeredocBodies(s, i, pending.splice(0));
      if (j < 0) return -1;
      i = j;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i;
  }
  return -1;
}

// The index of the backtick closing the one at `open`.
function closeBacktick(s, open) {
  for (let i = open + 1; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '`') return i;
  }
  return -1;
}

// A here-document's delimiter, read from just after `<<`: { delim, quoted,
// tabs, end }. `quoted` bodies are literal; unquoted ones expand.
function heredocMarker(s, k) {
  let i = k;
  let tabs = false;
  if (s[i] === '-') { tabs = true; i++; }
  while (s[i] === ' ' || s[i] === '\t') i++;
  const q = s[i];
  if (q === "'" || q === '"') {
    const j = s.indexOf(q, i + 1);
    if (j < 0) return null;
    return { delim: s.slice(i + 1, j), quoted: true, tabs, end: j + 1 };
  }
  const m = /^\\?([^\s;&|<>()'"`]+)/.exec(s.slice(i));
  if (!m) return null;
  return { delim: m[1], quoted: m[0].startsWith('\\'), tabs, end: i + m[0].length };
}

// From the newline at `nl`, past the bodies of the pending here-documents, in
// order. Returns the index of the last character of the final delimiter line,
// and fills each marker's `body`.
function skipHeredocBodies(s, nl, markers) {
  let pos = nl + 1;
  for (const m of markers) {
    const start = pos;
    for (;;) {
      if (pos > s.length) return -1;
      let eol = s.indexOf('\n', pos);
      if (eol < 0) eol = s.length;
      const line = s.slice(pos, eol);
      if ((m.tabs ? line.replace(/^\t+/, '') : line) === m.delim) { m.body = s.slice(start, pos); pos = eol + 1; break; }
      pos = eol + 1;
    }
  }
  return pos - 2;
}

// Cut the here-document bodies out of a line, so the data they carry is not
// read as commands. Returns { text, bodies: [{ body, expands }], ok }. The
// marker stays, so a caller can see which command a body was fed to.
function stripHeredocs(line, dialect = 'bash') {
  const s = String(line);
  if (dialect !== 'bash' || s.indexOf('<<') < 0) return { text: s, bodies: [], ok: true };
  let out = '';
  let quote = null;
  const pending = [];
  const bodies = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote === "'") { out += ch; if (ch === "'") quote = null; continue; }
    if (ch === '\\') { out += s.slice(i, i + 2); i++; continue; }
    if ((ch === '$' && s[i + 1] === '(') || ch === '`') {
      const j = ch === '`' ? closeBacktick(s, i) : closeParen(s, i + 1, dialect);
      if (j < 0) return { text: s, bodies, ok: false };
      out += s.slice(i, j + 1);
      i = j;
      continue;
    }
    if (quote === '"') { out += ch; if (ch === '"') quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; out += ch; continue; }
    if (ch === '<' && s[i + 1] === '<' && s[i + 2] === '<') { out += '<<<'; i += 2; continue; }
    if (ch === '<' && s[i + 1] === '<' && s[i + 2] !== '<') {
      const m = heredocMarker(s, i + 2);
      if (!m) return { text: s, bodies, ok: false };
      pending.push(m);
      out += s.slice(i, m.end);
      i = m.end - 1;
      continue;
    }
    if (ch === '\n' && pending.length) {
      const markers = pending.splice(0);
      const j = skipHeredocBodies(s, i, markers);
      if (j < 0) return { text: s, bodies, ok: false };
      for (const m of markers) bodies.push({ body: m.body, expands: !m.quoted });
      out += '\n';
      i = j;
      continue;
    }
    out += ch;
  }
  if (pending.length) return { text: s, bodies, ok: false };
  return { text: out, bodies, ok: true };
}

// The commands a line runs inside itself: the bodies of `$( )`, backticks and
// bash's `<( )` and `>( )`, outermost first (a body's own substitutions are
// found when the body is read in turn). Single quotes hide them; `$(( ))` is
// arithmetic, whose own substitutions are still found. `quoted` reads the text
// as if inside double quotes (an unquoted here-document's body).
function substitutions(text, dialect = 'bash', { quoted = false } = {}) {
  const s = String(text);
  const bodies = [];
  if (dialect === 'cmd') return { bodies, ok: true };
  let quote = quoted ? '"' : null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote === "'") { if (ch === "'") quote = null; continue; }
    if (dialect === 'bash' && ch === '\\') { i++; continue; }
    if (dialect === 'ps' && ch === '`') { i++; continue; }
    const proc = dialect === 'bash' && !quote && (ch === '<' || ch === '>') && s[i + 1] === '(';
    if ((ch === '$' && s[i + 1] === '(') || proc) {
      const j = closeParen(s, i + 1, dialect);
      if (j < 0) return { bodies, ok: false };
      if (ch === '$' && s[i + 2] === '(' && s[j - 1] === ')') {
        const arith = substitutions(s.slice(i + 3, j - 1), dialect, { quoted: true });
        if (!arith.ok) return { bodies, ok: false };
        bodies.push(...arith.bodies);
      } else {
        const body = s.slice(i + 2, j);
        // A case pattern's `)` closes the substitution early here, as it did in
        // older shells: rather than guess where it really ends, give up.
        if (/(^|[\s;(&|])case\s/.test(body)) return { bodies, ok: false };
        bodies.push(body);
      }
      i = j;
      continue;
    }
    if (dialect === 'bash' && ch === '`') {
      const j = closeBacktick(s, i);
      if (j < 0) return { bodies, ok: false };
      bodies.push(s.slice(i + 1, j).replace(/\\([`$\\])/g, '$1'));
      i = j;
      continue;
    }
    if (quoted) continue;
    if (quote === '"') { if (ch === '"') quote = null; continue; }
    if (ch === "'" || ch === '"') quote = ch;
  }
  return { bodies, ok: true };
}

// The commands in a line, each with the operator that joined it to the one
// before: '' for the first, then ';', '&&', '||', '|', '&' or a newline.
// Quotes, $( ), <( ) and { } are kept whole, so an operator inside them never
// splits the line.
// Inside double quotes a bash backslash escapes only these; anywhere else in
// double quotes it is an ordinary character (a Windows path, say).
const DQ_ESCAPABLE = ['$', '`', '"', '\\', '\n'];

// Where a substitution starting at `i` ends: the index of its last character,
// the end of the line if it never closes (the verdict then finds it
// unreadable), or -1 when no substitution starts at `i`. `bare`: outside any
// quotes, where bash's `<( )` and `>( )` also count.
function spanEnd(s, i, dialect, bare) {
  const ch = s[i];
  let j = -2;
  if ((dialect === 'bash' || dialect === 'ps') && ch === '$' && s[i + 1] === '(') j = closeParen(s, i + 1, dialect);
  else if (dialect === 'bash' && ch === '`') j = closeBacktick(s, i);
  else if (dialect === 'bash' && bare && (ch === '<' || ch === '>') && s[i + 1] === '(') j = closeParen(s, i + 1, dialect);
  if (j === -2) return -1;
  return j < 0 ? s.length - 1 : j;
}

function lexSegments(line, dialect = 'bash') {
  const s = String(line);
  const out = [];
  let cur = '';
  let op = '';
  let quote = null;
  let depth = 0;
  const push = (next) => { out.push({ op, text: cur.trim() }); cur = ''; op = next; };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const span = quote === "'" ? -1 : spanEnd(s, i, dialect, !quote);
    if (span !== -1) { cur += s.slice(i, span + 1); i = span; continue; }
    if (quote) {
      cur += ch;
      if (ch === '\\' && dialect === 'bash' && quote === '"' && DQ_ESCAPABLE.includes(s[i + 1])) { cur += s[++i]; continue; }
      if (ch === '`' && dialect === 'ps' && i + 1 < s.length) { cur += s[++i]; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\\' && dialect === 'bash' && i + 1 < s.length) { cur += ch + s[++i]; continue; }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
    if (ch === '(' || ch === '{') { depth++; cur += ch; continue; }
    if ((ch === ')' || ch === '}') && depth > 0) { depth--; cur += ch; continue; }
    if (depth > 0) { cur += ch; continue; }
    if (ch === '&' && s[i + 1] === '&') { push('&&'); i++; continue; }
    if (ch === '|' && s[i + 1] === '|') { push('||'); i++; continue; }
    if (ch === '|') { push('|'); continue; }
    if (ch === ';') { push(';'); continue; }
    if (ch === '\n' || ch === '\r') { push('\n'); continue; }
    if (ch === '&') {
      // `2>&1`, `&>` and `>&` are redirections, not a background operator.
      if (s[i - 1] === '>' || s[i - 1] === '<' || s[i + 1] === '>') { cur += ch; continue; }
      push('&');
      continue;
    }
    cur += ch;
  }
  out.push({ op, text: cur.trim() });
  return out.filter(seg => seg.text);
}

// A redirection operator standing alone (its target is the next word), or a
// redirection with its target attached. Neither is an argument of the command.
const REDIRECT_ALONE = /^(\d*|&|\*)(>>?|<)$/;
const REDIRECT_ATTACHED = /^(\d*|&|\*)(>>?|<)(&\d+|.+)$/;

// The words of one command. Each word carries:
//   text     the value with quotes and escapes removed
//   raw      the word as written
//   expands  it holds something only known when the line runs ($, a backtick,
//            %NAME% in cmd), outside single quotes
//   glob     it holds an unquoted *, ? or [
//   quoted   any part of it was quoted
function lexWords(segment, dialect = 'bash') {
  const s = String(segment);
  const words = [];
  let w = null;
  let quote = null;
  let depth = 0;
  const start = () => { if (!w) w = { text: '', raw: '', expands: false, glob: false, quoted: false }; };
  const end = () => { if (w) { words.push(w); w = null; } };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (!quote && depth === 0 && /\s/.test(ch)) { end(); continue; }
    start();
    const span = quote === "'" ? -1 : spanEnd(s, i, dialect, !quote);
    if (span !== -1) {
      const t = s.slice(i, span + 1);
      w.raw += t; w.text += t; w.expands = true;
      i = span;
      continue;
    }
    w.raw += ch;
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      if (quote === '"') {
        if (ch === '\\' && dialect === 'bash' && DQ_ESCAPABLE.includes(s[i + 1])) { const n = s[++i]; w.raw += n; w.text += n; continue; }
        if (ch === '`' && dialect === 'ps' && i + 1 < s.length) { const n = s[++i]; w.raw += n; w.text += n; continue; }
        if (ch === '$' || (ch === '`' && dialect === 'bash')) w.expands = true;
        if (ch === '%' && dialect === 'cmd') w.expands = true;
      }
      w.text += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; w.quoted = true; continue; }
    if (ch === '\\' && dialect === 'bash' && i + 1 < s.length) { const n = s[++i]; w.raw += n; w.text += n; continue; }
    if (ch === '^' && dialect === 'cmd' && i + 1 < s.length) { const n = s[++i]; w.raw += n; w.text += n; continue; }
    if (ch === '(' || ch === '{') depth++;
    if ((ch === ')' || ch === '}') && depth > 0) depth--;
    if (ch === '$' || (ch === '`' && dialect === 'bash')) w.expands = true;
    if (ch === '%' && dialect === 'cmd') w.expands = true;
    if (ch === '*' || ch === '?' || (ch === '[' && dialect !== 'ps')) w.glob = true;
    w.text += ch;
  }
  end();
  // Drop redirections and their targets: `> out.log`, `2>&1`, `*> x`.
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const t = words[i].text;
    // A here-string's `<<<` is kept with its word: the verdict decides what
    // the word is to the command (data, or a script to a shell).
    if (!words[i].quoted && t === '<<<') { out.push(words[i]); continue; }
    if (!words[i].quoted && REDIRECT_ALONE.test(t)) { i++; continue; }
    if (!words[i].quoted && REDIRECT_ATTACHED.test(t) && !/^-/.test(t)) continue;
    out.push(words[i]);
  }
  return out;
}

module.exports = { lexSegments, lexWords, substitutions, stripHeredocs };
