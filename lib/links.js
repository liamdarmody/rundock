'use strict';
/**
 * Link extraction: what a file SAYS it points at.
 *
 * Deliberately stops short of resolution, and that boundary is the design.
 * Resolution is a function of the WHOLE workspace, not of one file's content:
 * which file [[Roadmap]] means depends on every other file in the tree, so a
 * resolved path stored against a source file goes stale the moment an
 * unrelated file is added or a folder is renamed. The index therefore stores
 * the raw target and resolution happens at read time against the current tree.
 *
 * That is not a hypothetical. It is the same mechanism behind the resolver
 * defect this change fixes on the client, where tree order silently decided a
 * link's destination.
 *
 * Extraction rules mirror what the client actually renders as a link:
 *   - [[target]] and [[target|alias]]; the alias is display only and never
 *     resolves, so only the target is kept.
 *   - ![[target]] is an EMBED, labelled separately. Embeds render a file's
 *     contents inside another rather than linking to it, and nothing else in
 *     the app parses them, so callers decide whether they count.
 *   - Markdown links whose href is a workspace file. The extension list is
 *     markdown-render.js's, which is narrower than the file tree's: a .png is
 *     a valid wikilink target but not a valid markdown-link target. That
 *     inconsistency is the app's, and it is mirrored rather than corrected.
 *   - Code is stripped first. A wikilink inside a fence is not rendered as a
 *     link, so counting it would inflate every number downstream.
 */

// Mirrors WORKSPACE_FILE_HREF in public/markdown-render.js.
const MD_LINK_HREF_RE = /^(?!https?:\/\/|mailto:|obsidian:\/\/).*\.(?:md|yaml|yml|json|txt)$/;

const WIKILINK_RE = /(!?)\[\[([^[\]\n|]+)(?:\|([^[\]\n]*))?\]\]/g;
const MD_LINK_RE = /\[([^\]\n]*)\]\(([^()\s]+)\)/g;

/**
 * Blank out fenced and inline code, preserving length so any future offset
 * reporting stays truthful.
 */
function stripCode(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, (m) => ' '.repeat(m.length))
    .replace(/~~~[\s\S]*?~~~/g, (m) => ' '.repeat(m.length))
    .replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));
}

/**
 * @returns {Array<{target: string, kind: 'wikilink'|'markdown'|'embed'}>}
 * Extracted from RAW file content, before any frontmatter stripping: the
 * editor renders wikilinks inside frontmatter, so they are links.
 */
function extractLinks(content) {
  const text = stripCode(content);
  const out = [];
  let m;
  WIKILINK_RE.lastIndex = 0;
  while ((m = WIKILINK_RE.exec(text)) !== null) {
    const target = m[2].trim();
    if (!target) continue;
    out.push({ target, kind: m[1] === '!' ? 'embed' : 'wikilink' });
  }
  MD_LINK_RE.lastIndex = 0;
  while ((m = MD_LINK_RE.exec(text)) !== null) {
    const href = m[2].trim();
    if (!MD_LINK_HREF_RE.test(href)) continue;
    out.push({ target: href, kind: 'markdown' });
  }
  return out;
}

// The search-name rule (drop the #anchor, default the extension) is
// deliberately NOT here: it lives beside the resolver in
// public/views/files.js, which is the one copy every surface consults, and a
// second copy in the extraction module is how two surfaces come to disagree
// about what a target means.
module.exports = {
  extractLinks,
  stripCode,
  MD_LINK_HREF_RE,
};
