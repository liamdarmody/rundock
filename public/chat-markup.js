'use strict';
// The single source of chat thread markup: agent and user messages, the
// thinking indicator, delegation dividers and resolved permission cards.
// Pure string builders: no DOM, no
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
//   .permission-*     the resolved card reads .permission-summary out of the
//                     card it is replacing, so the two shapes are a pair
// Renaming any of them means changing those readers in the same commit.
//
// Load-order and naming note. Unlike the modules under public/views/, this one
// does NOT republish its helpers onto the root object. Republication exists so
// that inline handlers in index.html and generated onclick attributes can
// resolve moved functions as bare window properties. Nothing resolves these
// names that way: every call site is ordinary module code written against
// this API, so one namespaced global is enough and the client's global surface
// does not grow by eight more names.
//
// Behaviour contract pinned by test/unit/chat-markup.test.js, whose expected
// strings were produced by evaluating the original literals at every call site
// this module replaced.
//
// ===========================================================================
// WHAT ARRIVES ESCAPED HERE, AND WHAT DOES NOT.
// ===========================================================================
//
// This module has two kinds of parameter and they are not interchangeable.
//
//   PRE-RENDERED, inserted as-is. `bodyHtml`, `escapedHtml` and `text` are
//   already HTML: renderer output, or a caller's own esc(). Escaping them here
//   would double-encode every message in the thread.
//
//   RAW, escaped here. The agent object is not. `colour`, `icon` and
//   `displayName` are copied verbatim out of an agent file's frontmatter by
//   lib/agents/discovery.js, which parses `key: value` lines and validates
//   nothing, and agent files are written BY agents. So the agent identity in a
//   chat bubble is document text on the same terms as the message body, and it
//   was the one thing in this file going into the page unescaped.
//
// That distinction was implicit and cost three fields. The header said
// `bodyHtml` arrives pre-rendered and said nothing about the agent, so the
// agent read as app-produced when it is the opposite: `icon: <img src=x
// onerror=...>` in a frontmatter block fired on the thinking bubble, before a
// single token of the response had arrived.
//
// COLOUR IS JUDGED, NOT ESCAPED, and the difference matters. It goes into a
// `style` attribute, and escaping only stops a value ENDING the attribute; it
// does nothing about a value that stays inside it and is still CSS, which in an
// app with no Content-Security-Policy is a `url()` away from being a request.
// A colour has a small grammar, so the answer is the renderer's answer for a
// link destination: judge it against what it is allowed to be and refuse
// anything else, rather than escape and hope. A refused colour becomes the
// accent, which is the same fallback a missing one already got.
//
// Nothing valid changes shape. Every colour the grammar admits, and every icon
// and name that is not markup, renders byte-for-byte as it did, which is what
// the expected strings in the test file are.
(/** @param {any} root @param {() => object} factory */ function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RundockChatMarkup = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  /** @typedef {{ colour?: string, icon?: string, displayName?: string } | null | undefined} AgentLike */

  // Escape for HTML TEXT position: the three characters that can start markup
  // or an entity. Character for character the same rule as escapeHtml in
  // markdown-render.js and as esc() in app.js, and a deliberate third copy for
  // the reason markdown-render.js records: this module has to stay requireable
  // in node without app.js, which cannot load outside a browser.
  //
  // NOT safe for an attribute value: quotes are untouched.
  /** @param {unknown} s */
  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // What a colour is allowed to be. Four shapes, and everything Rundock itself
  // produces is one of the first two: the hex literals in the palette at
  // lib/agents/discovery.js, and the `var(--accent)` fallback the call sites
  // already used. Named colours and the functional notations are admitted
  // because an agent file may reasonably carry one and refusing them would be
  // a behaviour change dressed up as a fix.
  //
  // Anchored at both ends, so a value cannot be a colour followed by anything.
  // No `;`, no `(` outside the notations named, no whitespace beyond what the
  // functional forms need: a value that passes this cannot carry a second CSS
  // declaration, cannot open a `url()`, and has no character to escape.
  // A DELIBERATE SECOND COPY of public/agent-colour.js, which is where this
  // rule lives, is documented, and is used by every view. It is copied here
  // for the reason markdown-render.js records about its own escapeAttr: this
  // module has to stay requireable under node without the rest of the client,
  // and reaching for a global at factory time is the one thing the UMD
  // contract forbids (docs/CLIENT-ARCHITECTURE.md: the factory must be
  // side-effect-free).
  //
  // A second copy is only acceptable while something checks the two agree.
  // `chat-markup.js and this module agree on every input above`, in
  // test/unit/agent-colour.test.js, is that something: it runs both over the
  // same corpus and fails on any disagreement. If one gains a shape the other
  // should gain it too, and that test is what says so.
  const COLOUR = /^(?:#[0-9a-fA-F]{3,8}|[a-zA-Z]+|var\(\s*--[a-zA-Z0-9_-]+\s*\)|(?:rgb|rgba|hsl|hsla)\(\s*[0-9a-zA-Z.,%\/\s-]+\s*\))$/;

  // A colour to write into a style attribute, or the accent. The empty-string
  // and missing cases fall through to the same accent the call sites used
  // before this module existed, so `colour: ''` in a frontmatter block still
  // means "no colour" rather than an invalid one.
  //
  // Only a string is a colour: the pattern admits a bare name, so `false`
  // stringifies to "false", which is letters, which the grammar would accept.
  /** @param {unknown} value */
  function safeColour(value) {
    if (typeof value !== 'string') return 'var(--accent)';
    const s = value.trim();
    return s && COLOUR.test(s) ? s : 'var(--accent)';
  }

  // The agent's three display fields, each made safe for the position it goes
  // into. Read once here rather than at four call sites below, so a new builder
  // cannot reach the raw object by forgetting to.
  /** @param {AgentLike} agent */
  function identity(agent) {
    return {
      colour: safeColour(agent?.colour),
      icon: escapeHtml(agent?.icon || '?'),
      name: escapeHtml(agent?.displayName || 'Agent'),
    };
  }

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
    const { colour, icon, name } = identity(agent);
    return `<div class="msg-sender" style="color:${colour}"><div class="avatar xs" style="background:${colour}">${icon}</div> ${name}${timeHtml || ''}</div>`;
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
    const { colour } = identity(agent);
    return agentSenderHtml(agent, '') +
      `<div class="msg-bubble thinking-bubble"><div class="thinking-pulse" style="background:${colour}"></div><div><div class="thinking-label">Thinking</div><div class="thinking-status" id="thinking-status"></div></div></div>`;
  }

  // A user message: bubble only, no sender line, because the thread already
  // makes authorship obvious by alignment. Callers pass escaped text.
  /** @param {string} escapedHtml */
  function userBubbleHtml(escapedHtml) {
    return `<div class="msg-bubble">${escapedHtml}</div>`;
  }

  // The rule between two agents in a thread: a hairline either side of a badge
  // naming who took over. `joined` on a handoff, `resumed` when an orchestrator
  // takes the thread back.
  /** @param {AgentLike} agent @param {boolean} [isReturn] */
  function delegationDividerHtml(agent, isReturn) {
    const { colour, icon, name } = identity(agent);
    return `<div class="delegation-line"></div><div class="delegation-badge" style="color:${colour}"><span class="avatar xs" style="background:${colour}">${icon}</span>${name} ${isReturn ? 'resumed' : 'joined'}</div><div class="delegation-line"></div>`;
  }

  // What a permission card becomes once it has been answered, whether the user
  // answered it or the server timed it out. The class comes from the decision
  // rather than the label, because the label varies ('✓', '✓ Always', '✕',
  // '✕ Timed out') while the styling only cares whether it was allowed.
  //
  // `text` arrives already escaped and the separating space is emitted only
  // when there is text, so the timeout card renders exactly as it always did.
  /** @param {boolean} allowed @param {string} label @param {string} [text] */
  function permissionResolvedHtml(allowed, label, text) {
    return `<div class="permission-resolved ${allowed ? 'allowed' : 'denied'}"><span>${label}</span>${text ? ' ' + text : ''}</div>`;
  }

  return {
    // Exported so the mutation harness and the payload tests can reach the
    // judgement itself, and so a caller building agent markup outside this
    // file has the same rule available rather than writing a fourth one.
    safeColour,
    msgTimeHtml,
    agentSenderHtml,
    agentMessageHtml,
    agentStreamingMessageHtml,
    thinkingIndicatorHtml,
    userBubbleHtml,
    delegationDividerHtml,
    permissionResolvedHtml,
  };
}));
