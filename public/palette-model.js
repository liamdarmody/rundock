'use strict';
// Palette (universal search) model: grouping/flattening, selection movement,
// stale-reply guarding, empty-state decisions, highlight-marker conversion,
// and message-anchor matching. Pure functions extracted from app.js (same
// UMD pattern as the other client modules); the DOM renderers in app.js
// consume this model.
//
// Behaviour contract (pinned by test/unit/palette-model.test.js):
//   - Group order is fixed: files, conversations, agents, skills; a scope
//     other than 'all' shows only its own group; empty groups are skipped.
//   - A full group's count renders as a floor ("8+"): the server capped it,
//     so the real total may be higher.
//   - Recent (empty-query) replies relabel groups as "Recent <kind>".
//   - Selection movement wraps in both directions.
//   - Server highlight markers are control chars (\u0001/\u0002) swapped for
//     <mark> AFTER HTML escaping, so the only markup present is our own.
//   - Anchor matching normalises to letters/digits and tries the snippet
//     text first, then the highlighted fragment.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RundockPalette = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  const GROUP_ORDER = ['files', 'conversations', 'agents', 'skills'];
  const GROUP_LABELS = { files: 'Files', conversations: 'Conversations', agents: 'Agents', skills: 'Skills' };
  // Per-group result cap. Must match the `limit` sent with search requests:
  // the group-count labels use it to show "8+" instead of implying a full
  // group is the exact total.
  const GROUP_LIMIT = 8;

  // Turn a server reply into ordered display groups plus the flat selectable
  // list. Returns { groups: [{ key, label, countLabel, items, startIdx }],
  // flat: [...] } where startIdx is each group's offset into flat.
  function flattenReply(reply, scope) {
    const groupsIn = (reply && reply.groups) || {};
    const groups = [];
    const flat = [];
    for (const key of GROUP_ORDER) {
      if (scope !== 'all' && scope !== key) continue;
      const items = groupsIn[key] || [];
      if (!items.length) continue;
      const label = reply.recent ? `Recent ${GROUP_LABELS[key].toLowerCase()}` : GROUP_LABELS[key];
      const countLabel = items.length >= GROUP_LIMIT ? `${GROUP_LIMIT}+` : String(items.length);
      groups.push({ key, label, countLabel, items, startIdx: flat.length });
      flat.push(...items);
    }
    return { groups, flat };
  }

  // Which empty state to show when the flat list is empty:
  //   'error'        a genuine server failure must not masquerade as no-matches
  //   'no-matches'   a query produced nothing
  //   'start-typing' no query yet
  function emptyState(reply, query) {
    if (reply && reply.error) return 'error';
    return (query || '').trim() ? 'no-matches' : 'start-typing';
  }

  // Arrow-key selection movement with wrap-around.
  function moveSelection(sel, delta, length) {
    if (!length) return sel;
    return (sel + delta + length) % length;
  }

  // A reply is stale when its request id is not the latest one issued.
  function isStaleReply(reply, latestReqId) {
    return !reply || reply.reqId !== latestReqId;
  }

  // Swap the server's control-char highlight markers for <mark>. The caller
  // supplies its HTML escaper; escaping happens FIRST so the <mark> pair is
  // the only markup in the string.
  function highlightToMark(s, escFn) {
    return escFn(s || '').replace(/\u0001/g, '<mark>').replace(/\u0002/g, '</mark>');
  }

  function snippetPlain(s) {
    return (s || '').replace(/[\u0001\u0002]/g, '');
  }

  // Extract the highlighted fragment from a snippet (the text between the
  // first marker pair), used as the anchor fallback needle.
  function snippetFragment(snippet) {
    return ((snippet || '').match(/\u0001([^\u0002]+)\u0002/) || [])[1] || '';
  }

  // ── Message anchor matching ──────────────────────────────────────────────

  function normAnchorText(t) {
    return (t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }

  // Given the rendered messages' text contents and the anchor, return the
  // index of the first message containing the snippet text (preferred) or
  // the highlighted fragment. Needles shorter than 3 normalised chars are
  // ignored; -1 means no match (message outside the loaded window).
  function findAnchorIndex(textContents, anchor) {
    const needles = [normAnchorText(anchor.text), normAnchorText(anchor.fragment)]
      .filter(n => n.length >= 3);
    for (const needle of needles) {
      for (let i = 0; i < textContents.length; i++) {
        if (normAnchorText(textContents[i]).includes(needle)) return i;
      }
    }
    return -1;
  }

  return {
    GROUP_ORDER, GROUP_LABELS, GROUP_LIMIT,
    flattenReply, emptyState, moveSelection, isStaleReply,
    highlightToMark, snippetPlain, snippetFragment,
    normAnchorText, findAnchorIndex,
  };
}));
