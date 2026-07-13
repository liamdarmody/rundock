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

// `author` is the workspace user's handle, resolved by the host (workspace
// profile -> OS username -> 'me'); it is written into `by:` for everything
// authored through the UI. Attribution is only ever read from `by:` fields,
// never inferred.
export function createReviewController({ editor, endmatter, author = 'me', now = () => new Date().toISOString(), onChange = null }) {
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
      if (node.type.name === 'criticComment' || node.type.name === 'criticHighlight' || SUGGESTION_TYPES.has(node.type.name)) {
        found.push({ node, pos, index, parent });
      }
      return true;
    });
    return found;
  }

  // A highlight is an anchor when a comment sits immediately after it;
  // otherwise it is an orphan (comment resolved elsewhere, or external
  // edits separated the pair) and must stay releasable from the sidebar.
  function highlightIsAnchor(pos, node) {
    const after = editor.state.doc.nodeAt(pos + node.nodeSize);
    return !!after && after.type.name === 'criticComment';
  }

  function findConstruct(id) {
    if (id == null) return null; // id-less constructs are addressed by position
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

  // Operations accept either an anchor id ('s1') or a position locator for
  // id-less constructs — sidebar items always carry pos, type, and text.
  // Position locators verify IDENTITY, not just position: every operation
  // shifts positions, so a stale locator (double-fired handler, cached
  // listItems snapshot) must refuse rather than hit whichever construct
  // moved into that slot.
  function locate(locator) {
    if (typeof locator === 'string') return findConstruct(locator);
    if (!locator || !Number.isInteger(locator.pos) || locator.pos < 0) return null;
    if (locator.pos >= editor.state.doc.content.size) return null;
    let node = null;
    try { node = editor.state.doc.nodeAt(locator.pos); } catch { return null; }
    if (!node || !node.type.name.startsWith('critic')) return null;
    if (locator.type && node.type.name !== locator.type) return null;
    if (locator.content != null) {
      const nodeContent = node.type.name === 'criticSubstitution'
        ? `${node.attrs.from}~>${node.attrs.to}`
        : node.attrs.content;
      if (nodeContent !== locator.content) return null;
    }
    return { node, pos: locator.pos };
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
      if (node.type.name === 'criticHighlight') {
        if (highlightIsAnchor(pos, node)) return null; // rendered with its comment
        return { kind: 'highlight', type: node.type.name, id: node.attrs.id, pos, text: node.attrs.content, from: null, anchor: null, meta: null, replies: [] };
      }
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
    }).filter(Boolean);
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
      // Record only what is actually known. A construct that arrived with
      // no metadata gets a text excerpt for the audit trail and nothing
      // else: never placeholder values (by: unknown, at: null) in files.
      data.suggestions[id] = {};
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

  function applyVerdict(locator, verdict) {
    const hit = locate(locator);
    if (!hit || !SUGGESTION_TYPES.has(hit.node.type.name)) return false;
    const { node, pos } = hit;
    const end = pos + node.nodeSize;
    const accept = verdict === 'accepted';
    let replacement = '';
    if (node.type.name === 'criticInsert') replacement = accept ? node.attrs.content : '';
    if (node.type.name === 'criticDelete') replacement = accept ? '' : node.attrs.content;
    if (node.type.name === 'criticSubstitution') replacement = accept ? node.attrs.to : node.attrs.from;
    replaceRangeWithText(pos, end, replacement);
    const entryId = node.attrs.id || nextId('s');
    const entry = ensureSuggestionEntry(entryId, node);
    entry.verdict = verdict;
    entry.decidedAt = now();
    touch();
    return true;
  }

  const accept = (locator) => applyVerdict(locator, 'accepted');
  const reject = (locator) => applyVerdict(locator, 'rejected');

  // Releases an ORPHAN highlight back to plain text. A highlight anchoring
  // a live comment is refused: resolve the comment instead (which releases
  // its anchor as part of the resolution).
  function release(locator) {
    const hit = locate(locator);
    if (!hit || hit.node.type.name !== 'criticHighlight') return false;
    if (highlightIsAnchor(hit.pos, hit.node)) return false;
    replaceRangeWithText(hit.pos, hit.pos + hit.node.nodeSize, hit.node.attrs.content);
    return true;
  }

  // ------------------------------------------------------------------
  // comments
  // ------------------------------------------------------------------

  function resolve(locator) {
    const hit = locate(locator);
    if (!hit || hit.node.type.name !== 'criticComment') return false;
    const { node, pos } = hit;
    const highlight = pairedHighlight(pos);
    const from = highlight ? highlight.pos : pos;
    const to = pos + node.nodeSize;
    replaceRangeWithText(from, to, highlight ? highlight.node.attrs.content : '');
    const entryId = node.attrs.id || nextId('c');
    const entry = data.comments[entryId] || (data.comments[entryId] = {});
    if (entry.body == null && node.attrs.content) entry.body = node.attrs.content;
    entry.resolved = true;
    entry.resolvedAt = now();
    touch();
    return true;
  }

  function reply(parentId, text) {
    if (!text) return false;
    // The parent must be a COMMENT (inline construct or endmatter entry):
    // replies to suggestion/highlight ids or phantom ids would persist
    // threads nothing ever renders.
    const construct = findConstruct(parentId);
    const isComment = (construct && construct.node.type.name === 'criticComment') || !!data.comments[parentId];
    if (!isComment) return false;
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
  // reconciliation
  // ------------------------------------------------------------------

  // A construct that is present in the document is undecided by definition.
  // Undo restores constructs but not endmatter mutations, so decision fields
  // whose construct is back (verdict/decidedAt on suggestions; resolved/
  // resolvedAt, plus the resolution-captured body, on root comments) are
  // stale and must not serialize — otherwise Cmd+Z after a verdict hands
  // agents a file that says both "undecided" and "accepted".
  function reconciledData() {
    const out = structuredClone(data);
    for (const [id, entry] of Object.entries(out.suggestions)) {
      if (entry && entry.verdict != null && findConstruct(id)) {
        delete entry.verdict;
        delete entry.decidedAt;
      }
    }
    for (const [id, entry] of Object.entries(out.comments)) {
      if (entry && entry.resolved && findConstruct(id)) {
        delete entry.resolved;
        delete entry.resolvedAt;
        // A root comment's text lives inline; its endmatter body only ever
        // comes from resolution capture. Replies (re:) keep their body.
        if (!entry.re) delete entry.body;
      }
    }
    return out;
  }

  function getEndmatterRaw() {
    if (!dirty) return originalRaw;
    const reconciled = reconciledData();
    // A fully undone session serializes the original bytes, not a
    // semantically-equal reformatting of them.
    if (endmatter && endmatter.data && JSON.stringify(reconciled) === JSON.stringify(endmatter.data)) {
      return originalRaw;
    }
    return buildEndmatter(reconciled);
  }

  // ------------------------------------------------------------------
  // Done-Reviewing (the handback gate)
  // ------------------------------------------------------------------

  function progress() {
    const items = listItems();
    const openSuggestions = items.filter((i) => i.kind === 'suggestion').length;
    const openComments = items.filter((i) => i.kind === 'comment').length;
    const current = reconciledData();
    const suggestionEntries = Object.values(current.suggestions);
    const commentEntries = Object.values(current.comments);
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
    const current = reconciledData();
    return {
      review: data.review,
      comments: current.comments,
      suggestions: current.suggestions,
    };
  }

  // ------------------------------------------------------------------

  return {
    listItems,
    accept,
    reject,
    resolve,
    release,
    reply,
    addComment,
    suggestReplace,
    suggestInsert,
    progress,
    doneReviewing,
    isDirty: () => dirty,
    getData: () => data,
    getEndmatterRaw,
  };
}
