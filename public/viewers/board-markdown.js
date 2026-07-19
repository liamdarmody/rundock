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
function renderInline(escaped) {
  var codes = [];
  var s = escaped.replace(/`([^`]+)`/g, function (_, c) {
    codes.push(c);
    return SENT + (codes.length - 1) + SENT;
  });

  // Links [text](url) before emphasis so bracketed text is not eaten.
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (m, text, url) {
    return safeUrl(url) ? '<a href="' + url + '" target="_blank" rel="noreferrer noopener">' + text + '</a>' : m;
  });

  // Wikilinks [[target]] or [[target|alias]] render as links (navigation wired
  // by the host); display the alias when present.
  s = s.replace(/\[\[([^\[\]\|]+?)(?:\|([^\[\]\|]+?))?\]\]/g, function (m, target, alias) {
    return '<a class="board-wikilink" data-target="' + target.trim() + '">' + (alias || target).trim() + '</a>';
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

  return s.replace(new RegExp(SENT + '(\\d+)' + SENT, 'g'), function (_, i) {
    return '<code>' + codes[Number(i)] + '</code>';
  });
}

// Render a card's raw title text (possibly multi-line) to display HTML.
export function renderCardHtml(raw) {
  // Strip any NUL from the input so real card text can never collide with the
  // inline-code placeholder sentinel (SENT).
  var lines = String(raw == null ? '' : raw).replace(/\x00/g, '').split('\n');
  return lines.map(function (line) { return renderInline(escapeHtml(line)); }).join('<br>');
}
