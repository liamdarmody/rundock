'use strict';
// Resolve which conversation a permission (PreToolUse hook) request belongs to.
//
// The hook forwards the conversation_id from its process env (RUNDOCK_CONVO_ID).
// If that is ever empty, resolve the owning conversation from the session_id of
// the running process that raised it, so an id-less request is attributed to
// the correct conversation instead of whatever conversation happens to be on
// screen (the L10 misattribution bug: the client used to fall back to the
// active conversation). Returns '' when it genuinely cannot be attributed, so
// callers never silently borrow another conversation's identity.
//
// @param {string} conversationId - the hook-supplied id (may be empty)
// @param {string} sessionId      - the hook-supplied Claude Code session id
// @param {Iterable<[string, {sessionId?: string}]>} processEntries
//        running processes as [conversationId, entry] pairs (e.g. a Map)
// @returns {string} the resolved conversation id, or ''
function resolvePermissionConvoId(conversationId, sessionId, processEntries) {
  if (conversationId) return conversationId;
  if (sessionId && processEntries) {
    for (const [convoId, entry] of processEntries) {
      if (entry && entry.sessionId === sessionId) return convoId;
    }
  }
  return '';
}

module.exports = { resolvePermissionConvoId };
