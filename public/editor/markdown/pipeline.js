// Markdown pipeline: parseFile and serialiseFile.
//
// parseFile(rawMarkdown)                -> { raw, parsed, body, trailing }
// serialiseFile(editor, raw, trailing)  -> string
//
// The editor receives only the body. Frontmatter is stripped before
// setContent so the YAML never reaches ProseMirror, and the original raw
// block is re-prepended on save so files round-trip byte-for-byte. The
// body's trailing newline run is captured the same way: markdown parsing
// swallows final newlines, so without this every save would strip the
// file's POSIX trailing newline.
//
// Wikilink and Callout parsing happens inside markdown-it via plugins
// registered on each node's addStorage().markdown.parse.setup hook. No regex
// pre-processors run here.

import { extractFrontmatter, restoreFrontmatter } from './frontmatter.js';

const TRAILING_NEWLINES_RE = /(?:\r?\n)+$/;

export function parseFile(rawMarkdown) {
  const extracted = extractFrontmatter(rawMarkdown);
  const m = extracted.body.match(TRAILING_NEWLINES_RE);
  const trailing = m ? m[0] : '';
  const body = trailing ? extracted.body.slice(0, -trailing.length) : extracted.body;
  return { ...extracted, body, trailing };
}

export function serialiseFile(editor, rawFrontmatter, trailing = '') {
  const body = editor.storage.markdown.getMarkdown();
  return restoreFrontmatter(rawFrontmatter, body) + trailing;
}
