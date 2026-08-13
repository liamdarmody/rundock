'use strict';
// The single source of chat message markup. Pure string builders: no DOM, no
// globals, no clock. Callers create the element, set innerHTML from one of
// these, and own every side effect.
//
// Why this module exists. The agent sender line and the thinking bubble were
// written out as inline template literals at seven call sites across app.js,
// views/chat.js and views/conversations.js, and the thinking bubble's 432
// characters were byte-identical in all three files. Changing a bubble in one
// place left the streaming path, the chat view and the reconnect path
// rendering visibly different bubbles for the same agent, and no test caught
// it because each file's markup was only ever asserted against itself. The
// duplication was created by the view extraction work: each slice moved a
// caller into a new file and carried its copy of the markup along.
//
// The class names here are contracts, not decoration. Other code finds these
// nodes again by selector:
//   .msg-bubble       the cancelled badge appends into it; the find bar's
//                     conversation backend walks its text nodes
//   .streaming-text   render-stream-text and promote-handoff-message rewrite
//                     its innerHTML on every frame of a response
//   #thinking-status  ensure-tool-status and update-tool-status write the
//                     current tool name into it by id
// Renaming any of them means changing those readers in the same commit.
//
// Load-order and naming note. Unlike the modules under public/views/, this one
// does NOT republish its helpers onto the root object. Republication exists so
// that inline handlers in index.html and generated onclick attributes can
// resolve moved functions as bare window properties. Nothing resolves these
// names that way: every call site is ordinary module code written against
// this API, so one namespaced global is enough and the client's global surface
// does not grow by six more names.
//
// Behaviour contract pinned by test/unit/chat-markup.test.js, whose expected
// strings were produced by evaluating the original seven literals.
(/** @param {any} root @param {() => object} factory */ function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RundockChatMarkup = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  /** @typedef {{ colour?: string, icon?: string, displayName?: string } | null | undefined} AgentLike */

  // A timestamp span, or nothing. Returns '' for a missing or unparseable
  // date: a conversation saved with a malformed timestamp otherwise rendered
  // the string "Invalid Date" into the sender line.
  //
  // The date is a parameter rather than read here so the builders stay pure
  // and the caller keeps the choice between "now" and a stored timestamp.
  /** @param {Date | null | undefined} date */
  function msgTimeHtml(date) {
    if (!date || isNaN(date.getTime())) return '';
    return `<span class="msg-time">${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>`;
  }

  // The sender line: coloured avatar, display name, optional time span.
  // Shared by every agent-authored message shape below.
  /** @param {AgentLike} agent @param {string} [timeHtml] */
  function agentSenderHtml(agent, timeHtml) {
    const colour = agent?.colour || 'var(--accent)';
    return `<div class="msg-sender" style="color:${colour}"><div class="avatar xs" style="background:${colour}">${agent?.icon || '?'}</div> ${agent?.displayName || 'Agent'}${timeHtml || ''}</div>`;
  }

  // A settled agent message. bodyHtml arrives pre-rendered (formatMd or esc
  // output) and is inserted as-is; escaping here would double-encode every
  // message in the thread.
  /** @param {AgentLike} agent @param {string} bodyHtml @param {string} [timeHtml] */
  function agentMessageHtml(agent, bodyHtml, timeHtml) {
    return agentSenderHtml(agent, timeHtml) + `<div class="msg-bubble">${bodyHtml}</div>`;
  }

  // An agent message that is still streaming. The inner span is the node the
  // stream rewrites, so it exists even when empty: a fresh bubble passes ''
  // and the reconnect path passes the text the server accumulated while the
  // client was away.
  /** @param {AgentLike} agent @param {string} bodyHtml @param {string} [timeHtml] */
  function agentStreamingMessageHtml(agent, bodyHtml, timeHtml) {
    return agentSenderHtml(agent, timeHtml) + `<div class="msg-bubble"><span class="streaming-text">${bodyHtml}</span></div>`;
  }

  // The pre-response thinking indicator. Deliberately carries no timestamp:
  // it is replaced by a real bubble the moment the first token arrives, so a
  // time on it would be the time the agent started thinking rather than the
  // time it answered.
  /** @param {AgentLike} agent */
  function thinkingIndicatorHtml(agent) {
    const colour = agent?.colour || 'var(--accent)';
    return agentSenderHtml(agent, '') +
      `<div class="msg-bubble thinking-bubble"><div class="thinking-pulse" style="background:${colour}"></div><div><div class="thinking-label">Thinking</div><div class="thinking-status" id="thinking-status"></div></div></div>`;
  }

  // A user message: bubble only, no sender line, because the thread already
  // makes authorship obvious by alignment. Callers pass escaped text.
  /** @param {string} escapedHtml */
  function userBubbleHtml(escapedHtml) {
    return `<div class="msg-bubble">${escapedHtml}</div>`;
  }

  return {
    msgTimeHtml,
    agentSenderHtml,
    agentMessageHtml,
    agentStreamingMessageHtml,
    thinkingIndicatorHtml,
    userBubbleHtml,
  };
}));
