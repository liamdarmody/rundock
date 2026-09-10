'use strict';
// Which agent a conversation is pointed at when it is opened with no live process.
//
// WHY THIS IS ITS OWN MODULE. The rule lives on both sides of the wire: the
// server decides what to persist on load, and the client decides what to route
// the next message to. Written twice it drifts, and while it was written twice
// the two halves disagreed: the server preserved the specialist on disk and the
// client still sent the next message to the orchestrator, so the reported bug
// survived a fix that looked complete on the server.
//
// It is also here because the view module it came from needs a DOM to load, and
// a rule nothing can test without a browser is a rule nobody tests.
//
// THE RULE. A conversation with no live process is in one of two states, and
// they are not distinguishable by the absence itself:
//
//   the delegate handed back      -> the orchestrator owns the conversation
//   the app quit mid-delegation   -> the specialist still owns it
//
// Only an observed handback tells them apart, and `delegationReturned` is
// written at the moment the engine sees one. Absence of a process says nothing:
// the process map lives in memory and dies with the server.

/**
 * @param {{agentId: string, activeAgentId?: string|null, delegationReturned?: boolean}} convo
 * @returns {string} the agent this conversation is pointed at
 */
function restoredActiveAgentId(convo) {
  if (!convo || !convo.agentId) return '';
  if (convo.delegationReturned === true) return convo.agentId;
  return convo.activeAgentId || convo.agentId;
}

// Node-requireable for its tests, window-attached for the view that uses it.
// The view reaches it through the global lexical environment, the same way it
// reaches its other classic-script helpers.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { restoredActiveAgentId };
} else if (typeof self !== 'undefined') {
  self.restoredActiveAgentId = restoredActiveAgentId;
  self.RundockDelegationRestore = { restoredActiveAgentId };
}
