// Markdown pipeline: parseFile and serialiseFile.
//
// parseFile(rawMarkdown) -> {
//   raw,          // raw frontmatter block (or null)
//   parsed,       // parsed frontmatter object (or null)
//   body,         // the markdown the editor edits
//   trailingBody, // newline run between body and endmatter ('' if none)
//   endmatter,    // { raw, data } review endmatter ({ raw:'', data:null } if none)
//   trailing,     // the file's trailing newline run ('' if none)
// }
// serialiseFile(editor, parts) -> string, where parts carries the fields
// above (endmatterRaw may be overridden by the review controller when
// review data changed).
//
// The editor receives only the body. Everything else is stripped before
// setContent and re-attached verbatim on save so files round-trip
// byte-for-byte:
//
//   frontmatter | body | trailingBody | endmatter | trailing
//
// Frontmatter YAML never reaches ProseMirror (properties panel renders it),
// review endmatter never reaches ProseMirror (the review sidebar renders
// it), and the newline runs around them are preserved because markdown
// parsing would otherwise swallow them.
//
// Wikilink, Callout, table, and CriticMarkup parsing happens inside
// markdown-it via plugins registered on each node's
// addStorage().markdown.parse.setup hook. No regex pre-processors run here.

import { extractFrontmatter, restoreFrontmatter } from './frontmatter.js';
import { extractEndmatter } from '../review/endmatter.js';

const TRAILING_NEWLINES_RE = /(?:\r?\n)+$/;

function splitTrailingNewlines(text) {
  const m = text.match(TRAILING_NEWLINES_RE);
  const trailing = m ? m[0] : '';
  return { text: trailing ? text.slice(0, -trailing.length) : text, trailing };
}

export function parseFile(rawMarkdown) {
  const fm = extractFrontmatter(rawMarkdown);
  const fileSplit = splitTrailingNewlines(fm.body);
  const em = extractEndmatter(fileSplit.text);
  const bodySplit = splitTrailingNewlines(em.body);
  return {
    raw: fm.raw,
    parsed: fm.parsed,
    body: bodySplit.text,
    trailingBody: bodySplit.trailing,
    endmatter: { raw: em.raw, data: em.data },
    trailing: fileSplit.trailing,
  };
}

export function serialiseFile(editor, parts = {}) {
  const body = editor.storage.markdown.getMarkdown();
  const endmatterRaw = parts.endmatterRaw != null ? parts.endmatterRaw : (parts.endmatter ? parts.endmatter.raw : '');
  let out = restoreFrontmatter(parts.raw || null, body);
  if (endmatterRaw) {
    // A review block that appears on a document that never had one needs a
    // separating blank line; an existing block reuses its original separator
    // bytes (trailingBody). When the endmatter is cleared entirely, its
    // separator newlines go with it.
    out += (parts.trailingBody || '\n\n') + endmatterRaw;
  }
  out += parts.trailing || '';
  return out;
}
