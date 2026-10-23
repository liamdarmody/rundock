// Links inside a frontmatter property value.
//
// The Map counts a link wherever [[target]] appears in a file's raw text,
// frontmatter included (lib/links.js). The properties panel reads values
// after YAML has parsed them, so it recognises the same links in two places:
//
//  - inside a string value, wherever they sit among other words;
//  - an UNQUOTED `key: [[X]]`, which YAML reads as a list holding a list. The
//    parsed form cannot be trusted for the name ([[2024]] arrives as a number,
//    [[One, Two]] as two items), so the name is read from the raw YAML text,
//    and only when the parsed value has the nested-list shape that text gives.
//
// The grammar is lib/links.js's, so the panel and the Map agree on what is a
// link: an embed (![[X]]) is not one, and neither is a link inside `code`.

const LINK_RE = /(!?)\[\[([^[\]\n|]+)(?:\|([^[\]\n]*))?\]\]/g;
const CODE_SPAN_RE = /`[^`\n]*`/g;

// Splits text into runs: { text } for words, { text, link: { target, alias } }
// for a link, where text is the link exactly as written. Joining every run's
// text gives back the input.
export function linkSegments(value) {
  const src = String(value);
  const masked = src.replace(CODE_SPAN_RE, (m) => ' '.repeat(m.length));
  const out = [];
  let last = 0;
  let m;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(masked)) !== null) {
    if (m[1] === '!') continue;
    const target = m[2].trim();
    if (!target) continue;
    if (m.index > last) out.push({ text: src.slice(last, m.index) });
    const end = m.index + m[0].length;
    out.push({ text: src.slice(m.index, end), link: { target, alias: (m[3] || '').trim() || null } });
    last = end;
  }
  if (last < src.length) out.push({ text: src.slice(last) });
  return out;
}

// The link a whole value is, ignoring surrounding space, or null.
export function wholeLink(value) {
  if (typeof value !== 'string') return null;
  const segs = linkSegments(value.trim());
  return segs.length === 1 && segs[0].link ? segs[0].link : null;
}

// An unquoted [[X]] as the text that was written, or null. `parsed` is what
// YAML made of it; `rawText` is the value as written after `key:` or `- `.
// A trailing YAML comment is allowed after the link and is not part of it.
export function unquotedLinkText(parsed, rawText) {
  if (!Array.isArray(parsed) || parsed.length !== 1 || !Array.isArray(parsed[0])) return null;
  if (typeof rawText !== 'string') return null;
  const segs = linkSegments(rawText.trim());
  if (!segs.length || !segs[0].link) return null;
  if (segs.length > 2 || (segs.length === 2 && !/^\s+#/.test(segs[1].text))) return null;
  return segs[0].text;
}
