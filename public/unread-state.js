'use strict';
// Conversation unread-signal bookkeeping, tracked by REASON.
//
// A conversation shows the unread signal (sidebar dot + nav badge, and the
// "Unread" pill filter) if EITHER an agent message arrived while the user was
// not viewing it, OR a permission card is queued for it and not yet seen. The
// two reasons are kept in separate sets so resolving one never clears the
// other: when a background permission card times out (or is answered
// elsewhere), it must clear its own contribution to the badge WITHOUT wiping a
// co-occurring unread message (the L4 bug, where a single flat set conflated
// the two). Viewing the conversation clears every reason.
//
// UMD so it loads as a browser global (RundockUnread) and is requireable in
// node tests, matching code-language.js / permissions.js.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RundockUnread = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  function createUnreadState() {
    const messageUnread = new Set();     // an agent message arrived while not viewing
    const permissionUnread = new Set();  // a permission card is queued, not yet seen

    return {
      // An agent message landed in a conversation the user is not viewing.
      markMessage(convoId) { if (convoId) messageUnread.add(convoId); },

      // A permission request was queued for a background conversation.
      markPermission(convoId) { if (convoId) permissionUnread.add(convoId); },

      // The user viewed the conversation (or it was removed): every reason
      // clears. Returns whether anything was actually cleared (mirrors the
      // Set.delete return the caller used to branch on).
      clearConvo(convoId) {
        const a = messageUnread.delete(convoId);
        const b = permissionUnread.delete(convoId);
        return a || b;
      },

      // A queued permission resolved with none left pending for the
      // conversation (timed out or answered): clear ONLY the permission
      // reason, leaving any unread message intact.
      resolvePermission(convoId) { permissionUnread.delete(convoId); },

      // Reset everything (e.g. switching workspaces).
      clearAll() { messageUnread.clear(); permissionUnread.clear(); },

      // Does this conversation show the unread signal for any reason?
      isUnread(convoId) { return messageUnread.has(convoId) || permissionUnread.has(convoId); },

      // The set of all unread conversation ids (union of both reasons).
      ids() {
        const s = new Set(messageUnread);
        for (const id of permissionUnread) s.add(id);
        return s;
      },

      // How many distinct conversations are unread.
      size() {
        let n = messageUnread.size;
        for (const id of permissionUnread) if (!messageUnread.has(id)) n++;
        return n;
      },
    };
  }

  return { createUnreadState };
}));
