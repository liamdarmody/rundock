'use strict';
// Conversation-list model: ordering, filtering, and item-variant decisions
// for the sidebar. Pure functions extracted from renderConvoList in app.js
// (same UMD pattern as markers.js and permissions.js) so the WhatsApp-model
// ordering rules are unit-testable: pinned conversations always group first,
// BOTH groups sort by last activity descending, and pills filter without
// reordering.
//
// Behaviour contract (pinned by test/unit/conversation-list.test.js):
//   - sortKeyTime falls back lastActiveAt -> pinnedAt -> createdAt -> ''.
//   - Comparison is string-based (ISO timestamps compare lexically).
//   - The Unread pill filters to the unread set; pinned-first still applies.
//   - Archived conversations are a separate section, recency-ordered,
//     never pinned-grouped.
//   - Item variant: persisted-and-not-pinned renders as 'previous' (delete
//     affordance); everything else in the main list is 'current' (pin).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RundockConvoList = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  function sortKeyTime(c) { return c.lastActiveAt || c.pinnedAt || c.createdAt || ''; }

  function compareTimeDesc(a, b) { return sortKeyTime(b).localeCompare(sortKeyTime(a)); }

  function pinnedFirst(a, b) {
    return ((b.pinned === true) - (a.pinned === true)) || compareTimeDesc(a, b);
  }

  // Split and order the sidebar's data: the main list (non-archived,
  // optionally filtered to unread, pinned grouped first) and the archived
  // section (recency only). unreadIds is a Set-like with .has().
  function partitionConversations(conversations, opts) {
    const pill = (opts && opts.pill) || 'all';
    const unreadIds = (opts && opts.unreadIds) || { has: () => false };

    let main = conversations.filter(c => c.status !== 'archived');
    if (pill === 'unread') main = main.filter(c => unreadIds.has(c.id));
    main.sort(pinnedFirst);

    const archived = conversations
      .filter(c => c.status === 'archived')
      .sort(compareTimeDesc);

    return { main, archived };
  }

  // Main-list item variant: 'previous' items carry the delete affordance and
  // dimming; 'current' items carry the pin button. Pinned-and-persisted
  // stays 'current' so users can still unpin it.
  function itemVariant(c) { return (c.persisted && !c.pinned) ? 'previous' : 'current'; }

  return { sortKeyTime, compareTimeDesc, pinnedFirst, partitionConversations, itemVariant };
}));
