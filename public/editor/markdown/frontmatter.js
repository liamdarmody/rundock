// Frontmatter helpers. The editor module's deal with frontmatter is:
//
//  - Strip it before the editor sees the body, so the YAML stays opaque to
//    ProseMirror and is rendered separately as a properties panel
//  - Preserve the raw YAML block verbatim so save round-trips byte-for-byte
//    until the user actually edits a property
//  - Parse it with js-yaml only for rendering the panel; the raw form stays
//    the source of truth for serialisation
//
// extractFrontmatter returns { raw, parsed, body }:
//   raw   : the full leading "---\n...\n---\n" block including markers, or null
//   parsed: the parsed object (may include nested fields), or null
//   body  : the markdown body with the frontmatter block stripped
//
// restoreFrontmatter prepends the raw block back onto the editor's output.

import { yaml } from '../../vendor/tiptap-bundle.mjs';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;

export function extractFrontmatter(rawMarkdown) {
  if (!rawMarkdown) return { raw: null, parsed: null, body: '' };
  const m = rawMarkdown.match(FRONTMATTER_RE);
  if (!m) return { raw: null, parsed: null, body: rawMarkdown };
  let raw = m[0];
  const yamlBody = m[1];
  let body = rawMarkdown.slice(raw.length);
  // Blank lines between the closing --- and the body belong to neither the
  // YAML nor the markdown content. Markdown parsing would swallow them, so
  // they travel with the raw block to keep the save round-trip byte-exact.
  const blankRun = body.match(/^(?:[ \t]*\r?\n)+/);
  if (blankRun) {
    raw += blankRun[0];
    body = body.slice(blankRun[0].length);
  }
  let parsed = null;
  try {
    // CORE_SCHEMA keeps timestamps as their authored strings (DEFAULT_SCHEMA
    // parses them to Date objects, which then render and save in UTC, shifting
    // an evening value with a timezone offset to the next calendar day and
    // dropping the time). Numbers and booleans are still typed.
    parsed = yaml.load(yamlBody, { schema: yaml.CORE_SCHEMA });
    if (parsed === undefined) parsed = null;
  } catch (err) {
    // Malformed YAML: keep the raw block so save round-trips, but render
    // an empty properties panel rather than crashing. Logged for visibility.
    console.warn('[editor] frontmatter parse failed; keeping raw block:', err && err.message);
    parsed = null;
  }
  return { raw, parsed, body };
}

export function restoreFrontmatter(rawBlock, bodyMarkdown) {
  if (!rawBlock) return bodyMarkdown;
  return rawBlock + bodyMarkdown;
}
