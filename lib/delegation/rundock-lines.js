'use strict';
// RUNDOCK'S OWN LINES IN A SESSION FILE, never a message anyone wrote to the
// conversation.
//
// Claude Code's session file keeps every prompt an agent was sent and every
// reply it gave, and some of those prompts are Rundock's: a delegate's brief, a
// handback to the orchestrator, a resume prime. Most open with a catch-up
// heading (catch-up.js) rather than with their own tag, which is how a filter
// that knew only the tags let them through. And an orchestrator answers a
// finished delegation with the <silent> sentinel and nothing else.
//
// ONE LIST, read by everything that turns a session file into bubbles or counts
// them: the history rebuild (lib/protocol/handlers/history.js) and the
// conversation list's message counts (server.js). The headings are taken from
// catch-up.js itself, so a heading reworded there cannot leave this behind.

const { CATCH_UP_HEADINGS } = require('./catch-up.js');
const { stripRundockMarkers } = require('./markers.js');

/** How a prompt Rundock sent an agent opens. */
const PROMPT_OPENINGS = Object.freeze([
  'CONVERSATION SO FAR:',
  '[SYSTEM:',
  '[DELEGATION BRIEF]',
  ...Object.values(CATCH_UP_HEADINGS),
]);

/** Whether a user line in a session file is a prompt Rundock sent. */
function isRundockPrompt(text) {
  const t = String(text == null ? '' : text);
  return PROMPT_OPENINGS.some((opening) => t.startsWith(opening));
}

/**
 * What a reply says once the <silent> sentinel and Rundock's markers are taken
 * out. The first step of isSilentParkResponse (server.js) as well, so the live
 * path and the history cannot disagree on what the sentinel is.
 */
function withoutSilentSentinel(text) {
  return stripRundockMarkers(String(text == null ? '' : text).replace(/<silent>/gi, '').trim()).trim();
}

/**
 * Whether a reply in a session file is Rundock's own: the <silent> sentinel and
 * nothing else, or the placeholder a session resumed with nothing to say leaves.
 * A short reply of the agent's own, "Done." or "OK", is a message and is kept,
 * which is where this is narrower than isSilentParkResponse.
 */
function isRundockReply(text) {
  const t = String(text == null ? '' : text).trim();
  if (t === 'No response requested.') return true;
  return /<silent>/i.test(t) && withoutSilentSentinel(t) === '';
}

module.exports = { PROMPT_OPENINGS, isRundockPrompt, isRundockReply, withoutSilentSentinel };
