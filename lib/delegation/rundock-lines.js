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

/** What a reply says once the <silent> sentinel and Rundock's markers are taken out. */
function withoutSilentSentinel(text) {
  return stripRundockMarkers(String(text == null ? '' : text).replace(/<silent>/gi, '').trim()).trim();
}

/**
 * Whether a silent-park response is effectively empty: the sentinel, near-empty,
 * or a no-op. True means the live path neither appends it to the transcript nor
 * shows it. Here rather than in server.js so the history decides by the very
 * same test.
 */
function isSilentParkResponse(text) {
  if (!text) return true;
  const cleaned = withoutSilentSentinel(text);
  // Treat as empty if under 10 non-whitespace chars or matches known no-op patterns
  const nonWs = cleaned.replace(/\s/g, '');
  if (nonWs.length < 10) return true;
  const noOpPatterns = ['No response requested.', 'OK', 'Understood.', 'Acknowledged.'];
  if (noOpPatterns.includes(cleaned)) return true;
  return false;
}

/**
 * Whether a reply in a session file is Rundock's own: the placeholder a session
 * resumed with nothing to say leaves, or a reply carrying the <silent> sentinel
 * that the live path parked (isSilentParkResponse), "<silent> Done." included.
 * Only a reply carrying the sentinel is put to that test: a short reply of the
 * agent's own, "Done." or "OK", is a message and is kept, as it was live.
 */
function isRundockReply(text) {
  const t = String(text == null ? '' : text).trim();
  if (t === 'No response requested.') return true;
  return /<silent>/i.test(t) && isSilentParkResponse(t);
}

/**
 * A reply as it is shown: a sentinel reply the live path did not park was
 * shown with the sentinel taken out (public/conversation-state.js), so it is
 * shown the same way here. Any other reply is shown as written.
 */
function shownReply(text) {
  const t = String(text == null ? '' : text);
  return /<silent>/i.test(t) ? t.replace(/<silent>/gi, '').trim() : t;
}

module.exports = { PROMPT_OPENINGS, isRundockPrompt, isRundockReply, isSilentParkResponse, shownReply, withoutSilentSentinel };
