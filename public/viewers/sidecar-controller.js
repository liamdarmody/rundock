// Sidecar review controller: the non-markdown counterpart of the editor's
// review controller (public/editor/review/controller.js). Same interface,
// same handback language: the review panel renders either one, and
// Done-Reviewing returns the same { review, comments, suggestions } payload
// shape the markdown loop ships, so inline, batch, and future workspace
// review all speak one language.
//
// Differences, by design:
//  - Storage is a sidecar JSON in .rundock/reviews/ (the artifact file
//    stays clean and valid), not inline constructs + YAML endmatter.
//  - Anchoring is quote + context (text-anchor.js), not document positions.
//  - Comment-only in v1: artifacts are read-only in Rundock, agents apply
//    the changes. Suggestion operations exist but refuse (return false),
//    and suggestions serialize as an empty map so the handback shape is
//    identical.
//
// DOM-free: anchoring needs only { text } from a text index, so the whole
// controller tests under plain Node.

import { locateSelector } from './text-anchor.js';

export const SIDECAR_FORMAT = 'rundock-review-sidecar/1';

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

// Deterministic sidecar filename: readable slug + FNV-1a hash of the exact
// relative path (collision-proofing for slug-identical paths).
export function sidecarNameFor(path) {
  let h = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const slug = path.replace(/[\\/]/g, '__').replace(/[^\w.-]/g, '_').slice(0, 60);
  return `${slug}-${h.toString(16).padStart(8, '0')}.json`;
}

export function sidecarPathFor(path) {
  return `.rundock/reviews/${sidecarNameFor(path)}`;
}

// Parse a sidecar file's content. Anything unusable returns a fresh store
// (the file may not exist yet); a parse failure on real content also
// returns fresh but flags it so the caller can warn instead of silently
// overwriting someone's data.
export function parseSidecar(content, path) {
  const fresh = { format: SIDECAR_FORMAT, path, comments: {}, suggestions: {}, review: {} };
  if (!content || typeof content !== 'string' || !content.trim()) return { data: fresh, corrupt: false };
  try {
    const parsed = JSON.parse(content);
    if (!isPlainObject(parsed)) return { data: fresh, corrupt: true };
    // A present-but-wrong-shape section (e.g. comments serialized as an
    // array, or a newer schema field type) means this is NOT an empty
    // sidecar: flag corrupt so the caller refuses to overwrite it, rather
    // than silently coercing the data away.
    const shapeOk = (k) => parsed[k] === undefined || isPlainObject(parsed[k]);
    if (!shapeOk('comments') || !shapeOk('suggestions') || !shapeOk('review')) {
      return { data: fresh, corrupt: true };
    }
    return {
      data: {
        format: SIDECAR_FORMAT,
        path: typeof parsed.path === 'string' ? parsed.path : path,
        comments: isPlainObject(parsed.comments) ? parsed.comments : {},
        suggestions: isPlainObject(parsed.suggestions) ? parsed.suggestions : {},
        review: isPlainObject(parsed.review) ? parsed.review : {},
      },
      corrupt: false,
    };
  } catch {
    return { data: fresh, corrupt: true };
  }
}

export function createSidecarController({ path, content = null, index, author = 'me', now = () => new Date().toISOString(), onChange = null }) {
  if (!index || typeof index.text !== 'string') throw new Error('createSidecarController: a text index is required');
  const parsed = parseSidecar(content, path);
  const data = parsed.data;
  let dirty = false;

  const touch = () => {
    dirty = true;
    if (typeof onChange === 'function') onChange();
  };

  function nextId(prefix) {
    let max = 0;
    const consider = (id) => {
      const m = typeof id === 'string' && id.match(/^([cs])(\d+)$/);
      if (m && m[1] === prefix) max = Math.max(max, Number(m[2]));
    };
    Object.keys(data.comments).forEach(consider);
    Object.keys(data.suggestions).forEach(consider);
    return `${prefix}${max + 1}`;
  }

  // ------------------------------------------------------------------
  // listing
  // ------------------------------------------------------------------

  // Anchor resolution per listing: the artifact document is static for the
  // lifetime of a mount, but the sidecar may hold anchors written against
  // an older version of the file, which is exactly the orphan case.
  function locateEntry(entry) {
    if (!entry.quote) return { pos: -1, orphaned: false }; // document-level comment: pinned to the top
    const hit = locateSelector(index, { quote: entry.quote, prefix: entry.prefix || '', suffix: entry.suffix || '' });
    if (!hit) return { pos: Number.MAX_SAFE_INTEGER, orphaned: true }; // orphans sink to the end, never vanish
    return { pos: hit.start, orphaned: false };
  }

  function listItems() {
    const items = [];
    for (const [id, entry] of Object.entries(data.comments)) {
      if (!isPlainObject(entry) || entry.re) continue; // replies render inside their parent card
      if (entry.resolved) continue; // resolved items leave the surface, stay in data for audit
      const { pos, orphaned } = locateEntry(entry);
      const replies = Object.entries(data.comments)
        .filter(([, e]) => isPlainObject(e) && e.re === id)
        .map(([rid, e]) => ({ id: rid, ...e }));
      items.push({
        kind: 'comment',
        type: 'sidecarComment',
        id,
        pos,
        text: entry.body || '',
        anchor: entry.quote || null,
        orphaned,
        meta: { by: entry.by, at: entry.at },
        replies,
      });
    }
    return items.sort((a, b) => a.pos - b.pos);
  }

  // ------------------------------------------------------------------
  // operations
  // ------------------------------------------------------------------

  // selector: { quote, prefix, suffix } captured by the surface from the
  // live selection, or null for a document-level comment.
  function addComment(text, selector = null) {
    if (!text) return false;
    const id = nextId('c');
    const entry = { by: author, at: now(), body: text };
    if (selector && selector.quote) {
      entry.quote = selector.quote;
      entry.prefix = selector.prefix || '';
      entry.suffix = selector.suffix || '';
    }
    data.comments[id] = entry;
    touch();
    return id;
  }

  function reply(parentId, text) {
    if (!text) return false;
    const parent = data.comments[parentId];
    if (!isPlainObject(parent) || parent.re) return false; // replies attach to root comments only
    const id = nextId('c');
    data.comments[id] = { body: text, re: parentId, by: author, at: now() };
    touch();
    return id;
  }

  function resolve(locator) {
    const id = typeof locator === 'string' ? locator : locator && locator.id;
    const entry = data.comments[id];
    if (!isPlainObject(entry) || entry.re || entry.resolved) return false;
    entry.resolved = true;
    entry.resolvedAt = now();
    touch();
    return true;
  }

  // Artifacts are read-only in Rundock: there is no document to apply a
  // suggestion to. Agents apply changes; humans comment. These refuse
  // rather than half-work.
  const refuse = () => false;

  // ------------------------------------------------------------------
  // handback (identical shape to the markdown loop)
  // ------------------------------------------------------------------

  function progress() {
    const items = listItems();
    const commentEntries = Object.values(data.comments).filter(isPlainObject);
    return {
      suggestions: { accepted: 0, rejected: 0, open: 0 },
      comments: {
        resolved: commentEntries.filter((c) => c.resolved === true && !c.re).length,
        open: items.length,
        replies: commentEntries.filter((c) => c.re).length,
      },
    };
  }

  function doneReviewing() {
    data.review = { status: 'done', at: now(), summary: progress() };
    touch();
    return {
      review: data.review,
      comments: structuredClone(data.comments),
      suggestions: structuredClone(data.suggestions),
    };
  }

  function serialize() {
    return JSON.stringify(data, null, 2) + '\n';
  }

  return {
    listItems,
    accept: refuse,
    reject: refuse,
    resolve,
    release: refuse,
    reply,
    addComment,
    suggestReplace: refuse,
    suggestInsert: refuse,
    progress,
    doneReviewing,
    isDirty: () => dirty,
    getData: () => data,
    serialize,
    wasCorrupt: () => parsed.corrupt,
  };
}
