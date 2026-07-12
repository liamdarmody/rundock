// Review controller: the single owner of review state for one editor
// instance. Bridges the inline construct atoms (nodes/critic-marks.js) and
// the YAML endmatter (review/endmatter.js), and implements the review
// semantics:
//
//  - suggestions ({++}/{--}/{~~}) carry Accept / Reject; a verdict applies
//    or discards the change in the document AND records itself in the
//    endmatter (verdict + decidedAt), so the file carries the decision.
//  - comments ({>>}) carry reply + resolve. Resolve releases the paired
//    highlight back to plain text, removes the inline construct, and marks
//    the endmatter entry resolved (body preserved for the audit trail).
//  - Done-Reviewing stamps review.status/at plus a compact verdict summary
//    into the endmatter and returns the machine-readable payload. The file
//    IS the handback; no agent run is triggered here.
//  - Both authoring directions: the human adds comments (anchored to a
//    plain-text selection as {==...==}{>>...<<}{#cN}, or standalone) and
//    suggested edits ({~~sel~>replacement~~}{#sN} on a selection,
//    {++text++}{#sN} at the cursor).
//
// The endmatter passes through byte-exact until the first review operation;
// after that getEndmatterRaw() rebuilds the block from the mutated data.

import { buildEndmatter } from './endmatter.js';

const SUGGESTION_TYPES = new Set(['criticInsert', 'criticDelete', 'criticSubstitution']);

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

export function createReviewController({ editor, endmatter, author = 'liam', now = () => new Date().toISOString(), onChange = null }) {
  if (!editor) throw new Error('createReviewController: editor is required');

  const originalRaw = (endmatter && endmatter.raw) || '';
  const data = structuredClone((endmatter && endmatter.data) || {});
  if (!isPlainObject(data.comments)) data.comments = isPlainObject(data.comments) ? data.comments : {};
  if (!isPlainObject(data.suggestions)) data.suggestions = {};
  if (!isPlainObject(data.review)) data.review = {};
  let dirty = false;

  const touch = () => {
    dirty = true;
    if (typeof onChange === 'function') onChange();
  };

  // ------------------------------------------------------------------
  // document scanning
  // ------------------------------------------------------------------

  function scan() {
    const found = [];
    editor.state.doc.descendants((node, pos, parent, index) => {
      if (node.type.name === 'criticComment' || SUGGESTION_TYPES.has(node.type.name)) {
        found.push({ node, pos, index, parent });
      }
      return true;
    });
    return found;
  }

  function findConstruct(id) {
    let hit = null;
    editor.state.doc.descendants((node, pos) => {
      if (hit) return false;
      if ((node.type.name.startsWith('critic')) && node.attrs.id === id) {
        hit = { node, pos };
        return false;
      }
      return true;
    });
    return hit;
  }

  // The highlight paired with a comment is its immediate previous sibling.
  function pairedHighlight(commentPos) {
    const $pos = editor.state.doc.resolve(commentPos);
    const index = $pos.index();
    if (index === 0) return null;
    const sibling = $pos.parent.child(index - 1);
    if (sibling.type.name !== 'criticHighlight') return null;
    return { node: sibling, pos: commentPos - sibling.nodeSize };
  }

  function listItems() {
    return scan().map(({ node, pos }) => {
      const isComment = node.type.name === 'criticComment';
      const anchorNode = isComment ? pairedHighlight(pos) : null;
      const meta = isComment ? data.comments[node.attrs.id] : data.suggestions[node.attrs.id];
      const replies = isComment
        ? Object.entries(data.comments)
            .filter(([, entry]) => entry && entry.re === node.attrs.id)
            .map(([rid, entry]) => ({ id: rid, ...entry }))
        : [];
      return {
        kind: isComment ? 'comment' : 'suggestion',
        type: node.type.name,
        id: node.attrs.id,
        pos,
        text: isComment ? node.attrs.content : (node.type.name === 'criticSubstitution' ? node.attrs.to : node.attrs.content),
        from: node.type.name === 'criticSubstitution' ? node.attrs.from : null,
        anchor: anchorNode ? anchorNode.node.attrs.content : null,
        meta: meta || null,
        replies,
      };
    });
  }

  // ------------------------------------------------------------------
  // id allocation
  // ------------------------------------------------------------------

  function nextId(prefix) {
    let max = 0;
    const consider = (id) => {
      const m = typeof id === 'string' && id.match(/^([cs])(\d+)$/);
      if (m && m[1] === prefix) max = Math.max(max, Number(m[2]));
    };
    scan().forEach(({ node }) => consider(node.attrs.id));
    Object.keys(data.comments).forEach(consider);
    Object.keys(data.suggestions).forEach(consider);
    return `${prefix}${max + 1}`;
  }

  // ------------------------------------------------------------------
  // node surgery helpers
  // ------------------------------------------------------------------

  function replaceRangeWithText(from, to, text) {
    editor.chain().command(({ tr, state }) => {
      if (text) tr.replaceWith(from, to, state.schema.text(text));
      else tr.delete(from, to);
      return true;
    }).run();
  }

  function ensureSuggestionEntry(id, node) {
    if (!data.suggestions[id]) {
      data.suggestions[id] = { by: 'unknown', at: null };
      const excerpt = node.type.name === 'criticSubstitution'
        ? `${node.attrs.from} ~> ${node.attrs.to}`
        : node.attrs.content;
      if (excerpt) data.suggestions[id].text = excerpt;
    }
    return data.suggestions[id];
  }

  // ------------------------------------------------------------------
  // verdicts (suggestions)
  // ------------------------------------------------------------------

  function applyVerdict(id, verdict) {
    const hit = findConstruct(id);
    if (!hit || !SUGGESTION_TYPES.has(hit.node.type.name)) return false;
    const { node, pos } = hit;
    const end = pos + node.nodeSize;
    const accept = verdict === 'accepted';
    let replacement = '';
    if (node.type.name === 'criticInsert') replacement = accept ? node.attrs.content : '';
    if (node.type.name === 'criticDelete') replacement = accept ? '' : node.attrs.content;
    if (node.type.name === 'criticSubstitution') replacement = accept ? node.attrs.to : node.attrs.from;
    replaceRangeWithText(pos, end, replacement);
    const entryId = id || nextId('s');
    const entry = ensureSuggestionEntry(entryId, node);
    entry.verdict = verdict;
    entry.decidedAt = now();
    touch();
    return true;
  }

  const accept = (id) => applyVerdict(id, 'accepted');
  const reject = (id) => applyVerdict(id, 'rejected');

  // ------------------------------------------------------------------
  // comments
  // ------------------------------------------------------------------

  function resolve(id) {
    const hit = findConstruct(id);
    if (!hit || hit.node.type.name !== 'criticComment') return false;
    const { node, pos } = hit;
    const highlight = pairedHighlight(pos);
    const from = highlight ? highlight.pos : pos;
    const to = pos + node.nodeSize;
    replaceRangeWithText(from, to, highlight ? highlight.node.attrs.content : '');
    const entryId = id || nextId('c');
    const entry = data.comments[entryId] || (data.comments[entryId] = {});
    if (entry.body == null && node.attrs.content) entry.body = node.attrs.content;
    entry.resolved = true;
    entry.resolvedAt = now();
    touch();
    return true;
  }

  function reply(parentId, text) {
    if (!text) return false;
    const id = nextId('c');
    data.comments[id] = { body: text, re: parentId, by: author, at: now() };
    touch();
    return id;
  }

  // ------------------------------------------------------------------
  // authoring
  // ------------------------------------------------------------------

  // A selection is safe to wrap as a highlight when it is plain text inside
  // one textblock: no marks (they would be flattened) and no inline nodes.
  function selectionIsPlainText(from, to) {
    if (from === to) return false;
    let plain = true;
    const $from = editor.state.doc.resolve(from);
    const $to = editor.state.doc.resolve(to);
    if (!$from.sameParent($to)) return false;
    editor.state.doc.nodesBetween(from, to, (node) => {
      if (!plain) return false;
      if (node.isTextblock) return true;
      if (!node.isText || node.marks.length > 0) plain = false;
      return plain;
    });
    return plain;
  }

  // range is optional: the review composer captures the selection when it
  // opens (typing in the sidebar blurs the editor), then passes it back.
  function addComment(text, range = null) {
    if (!text) return false;
    const id = nextId('c');
    const { from, to } = range || editor.state.selection;
    editor.chain().command(({ tr, state }) => {
      const comment = state.schema.nodes.criticComment.create({ content: text, id });
      if (selectionIsPlainText(from, to)) {
        const anchorText = state.doc.textBetween(from, to);
        const highlight = state.schema.nodes.criticHighlight.create({ content: anchorText });
        tr.replaceWith(from, to, [highlight, comment]);
      } else {
        tr.insert(to, comment);
      }
      return true;
    }).run();
    data.comments[id] = { by: author, at: now() };
    touch();
    return id;
  }

  function suggestReplace(replacement, range = null) {
    const { from, to } = range || editor.state.selection;
    if (from === to) return false;
    const id = nextId('s');
    editor.chain().command(({ tr, state }) => {
      const original = state.doc.textBetween(from, to);
      const node = state.schema.nodes.criticSubstitution.create({ from: original, to: replacement || '', id });
      tr.replaceWith(from, to, node);
      return true;
    }).run();
    data.suggestions[id] = { by: author, at: now() };
    touch();
    return id;
  }

  function suggestInsert(text) {
    if (!text) return false;
    const id = nextId('s');
    const { to } = editor.state.selection;
    editor.chain().command(({ tr, state }) => {
      tr.insert(to, state.schema.nodes.criticInsert.create({ content: text, id }));
      return true;
    }).run();
    data.suggestions[id] = { by: author, at: now() };
    touch();
    return id;
  }

  // ------------------------------------------------------------------
  // Done-Reviewing (the handback gate)
  // ------------------------------------------------------------------

  function progress() {
    const items = listItems();
    const openSuggestions = items.filter((i) => i.kind === 'suggestion').length;
    const openComments = items.filter((i) => i.kind === 'comment').length;
    const suggestionEntries = Object.values(data.suggestions);
    const commentEntries = Object.values(data.comments);
    return {
      suggestions: {
        accepted: suggestionEntries.filter((s) => s && s.verdict === 'accepted').length,
        rejected: suggestionEntries.filter((s) => s && s.verdict === 'rejected').length,
        open: openSuggestions,
      },
      comments: {
        resolved: commentEntries.filter((c) => c && c.resolved === true).length,
        open: openComments,
        replies: commentEntries.filter((c) => c && c.re).length,
      },
    };
  }

  function doneReviewing() {
    const summary = progress();
    data.review = { status: 'done', at: now(), summary };
    touch();
    return {
      review: data.review,
      comments: data.comments,
      suggestions: data.suggestions,
    };
  }

  // ------------------------------------------------------------------

  return {
    listItems,
    accept,
    reject,
    resolve,
    reply,
    addComment,
    suggestReplace,
    suggestInsert,
    progress,
    doneReviewing,
    isDirty: () => dirty,
    getData: () => data,
    getEndmatterRaw: () => (dirty ? buildEndmatter(data) : originalRaw),
  };
}
