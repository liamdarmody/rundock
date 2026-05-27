// Markdown pipeline: parseFile and serialiseFile.
//
// parseFile(rawMarkdown)         -> { raw, parsed, body }
// serialiseFile(editor, raw)     -> string
//
// The editor receives only the body. Frontmatter is stripped before
// setContent so the YAML never reaches ProseMirror, and the original raw
// block is re-prepended on save so files round-trip byte-for-byte.
//
// Wikilink and Callout parsing happens inside markdown-it via plugins
// registered on each node's addStorage().markdown.parse.setup hook. No regex
// pre-processors run here.

import { extractFrontmatter, restoreFrontmatter } from './frontmatter.js';

export function parseFile(rawMarkdown) {
  return extractFrontmatter(rawMarkdown);
}

export function serialiseFile(editor, rawFrontmatter) {
  const body = editor.storage.markdown.getMarkdown();
  return restoreFrontmatter(rawFrontmatter, body);
}
