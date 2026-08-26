// Inline markdown rendering for kanban card text. Cards display styled markdown
// (bold, italic, strikethrough, inline code, links, wikilinks) rather than raw
// syntax. Card text is untrusted (user- or agent-authored), so the input is
// HTML-escaped FIRST and every transform operates on the escaped string; only
// the tags this module emits are ever introduced. A link URL is rendered only
// when its scheme is safe (http/https/mailto), so a javascript: or data: URL
// can never become an href.

// A NUL sentinel that HTML-escaped text can never contain, used as a
// collision-proof placeholder delimiter for extracted inline code (a plain
// digit token would clash with numbers that appear in card text).
var SENT = String.fromCharCode(0);

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeUrl(url) {
  // url is already HTML-escaped; test the scheme on a decoded copy.
  var decoded = url.replace(/&amp;/g, '&');
  return /^(https?:|mailto:)/i.test(decoded.trim());
}

// Render one line of already-escaped text with inline markdown. Inline code is
// extracted to placeholders first so its contents are never re-parsed as
// emphasis, then restored last.
//
// AN ATTRIBUTE VALUE IS HELD OUT OF THE STRING once it is written, and this is
// the whole of the fix for a real defect rather than tidying.
//
// Escaping on entry is correct and was never the problem. The problem is that
// eight transforms then run over the RESULT, and two of them emit markup: the
// tag rule writes `<span class="board-tag">` and the date rule writes
// `<span class="board-date">`. Once the link and wikilink rules have written a
// value into `href="..."` or `data-target="..."`, those spans land INSIDE the
// attribute and end it at their own first quote. Measured, not reasoned:
//
//   [[note #tag x]]        -> data-target="note <span class="   (truncated)
//   [link](https://x/2024-01-01/y)
//                          -> href="https://x/<span class="     (truncated)
//                             AND target/rel dropped with it
//
// The second one is the one that bites: `rel="noreferrer noopener"` was
// written after the attribute that got cut, so it is gone. The emphasis rules
// have the same shape (`[[a *b* c]]` puts an `<em>` inside data-target), which
// is why the answer is positional rather than a fix to those two rules.
//
// It is not XSS as written, and the reason is worth stating so nobody relies
// on it twice: the injected markup is a fixed `class="board-..."`, so the
// parser ends the value at the first quote, reads `board-tag"` as a bare
// attribute name, and the very next `>` closes the tag. There is no attacker
// attribute name or value, and the rest of their text becomes element content.
// One reordering of these rules is all that stands between that and the other
// thing.
//
// So an attribute value goes into a placeholder the moment it is written and
// comes back after every transform has run. The placeholder is inert for all
// of them: it introduces no `#`, no digits that form a date, and no `*`, `_`
// or `~`. The value it holds was escaped on entry with the five-character
// rule, quotes included, so what returns cannot end the attribute either.
function renderInline(escaped) {
  var codes = [];
  var s = escaped.replace(/`([^`]+)`/g, function (_, c) {
    codes.push(c);
    return SENT + (codes.length - 1) + SENT;
  });

  // Attribute values, held out of reach of every transform below. A separate
  // marker shape from the inline-code one (`a` prefix), so the code restore's
  // `SENT(\d+)SENT` cannot match one of these by accident.
  var attrs = [];
  function holdAttr(value) {
    attrs.push(value);
    return SENT + 'a' + (attrs.length - 1) + SENT;
  }

  // Links [text](url) before emphasis so bracketed text is not eaten.
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (m, text, url) {
    return safeUrl(url) ? '<a href="' + holdAttr(url) + '" target="_blank" rel="noreferrer noopener">' + text + '</a>' : m;
  });

  // Wikilinks [[target]] or [[target|alias]] render as links (navigation wired
  // by the host); display the alias when present.
  s = s.replace(/\[\[([^\[\]\|]+?)(?:\|([^\[\]\|]+?))?\]\]/g, function (m, target, alias) {
    return '<a class="board-wikilink" data-target="' + holdAttr(target.trim()) + '">' + (alias || target).trim() + '</a>';
  });

  // Tags (#tag) render as chips and ISO dates as styled spans, like the
  // Obsidian Kanban card. Done on plain escaped text before emphasis so the
  // spans they emit are never re-parsed.
  s = s.replace(/(^|\s)#([A-Za-z][\w/-]*)/g, '$1<span class="board-tag">#$2</span>');
  s = s.replace(/(^|[^\d>])(\d{4}-\d{2}-\d{2})(?![\d-])/g, '$1<span class="board-date">$2</span>');

  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_\w])_([^_\s][^_]*?)_(?![\w])/g, '$1<em>$2</em>');

  s = s.replace(new RegExp(SENT + '(\\d+)' + SENT, 'g'), function (_, i) {
    return '<code>' + codes[Number(i)] + '</code>';
  });

  // Attribute values back, LAST, after every transform and after the code
  // restore. A backtick span inside a wikilink target restores as the escaped
  // characters it was written with rather than as a <code> element, because an
  // element inside an attribute value is the defect this function is fixing.
  return s.replace(new RegExp(SENT + 'a(\\d+)' + SENT, 'g'), function (_, i) {
    var held = attrs[Number(i)];
    return held.replace(new RegExp(SENT + '(\\d+)' + SENT, 'g'), function (__, j) {
      return '`' + codes[Number(j)] + '`';
    });
  });
}

// Render a card's raw title text (possibly multi-line) to display HTML.
export function renderCardHtml(raw) {
  // Strip any NUL from the input so real card text can never collide with the
  // inline-code placeholder sentinel (SENT).
  var lines = String(raw == null ? '' : raw).replace(/\x00/g, '').split('\n');
  return lines.map(function (line) { return renderInline(escapeHtml(line)); }).join('<br>');
}
