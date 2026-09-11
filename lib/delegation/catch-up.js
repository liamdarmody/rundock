'use strict';

// WHAT AN AGENT IS TOLD IT MISSED, in one place.
//
// Two call sites need the same three rules: which session to resume, how the
// missed turns are worded into a prompt, and what the log says went. They were
// written twice and had already drifted inside a single change: the delegate's
// log reported the truncated-turn count and the orchestrator's did not. Kept
// here so the wording an agent reads and the number a person reads cannot
// disagree between the two paths.
//
// Separate from engine.js because these are the parts worth driving directly.
// The prompt an agent actually receives is assembled by pure functions here, so
// a test can assert on the bytes rather than grep the engine for identifiers.

/**
 * The last session recorded for an agent in a conversation.
 * @param {{id: string, sessionIds?: {agentId: string, sessionId: string}[]}[]} convos
 * @returns {string|null} null when there is none, which means cold spawn.
 */
function lastSessionFor(convos, convoId, agentId) {
  if (!Array.isArray(convos) || !convoId || !agentId) return null;
  const convo = convos.find((c) => c && c.id === convoId);
  const match = ((convo && convo.sessionIds) || [])
    .filter((x) => x && x.agentId === agentId)
    .pop();
  return (match && match.sessionId) || null;
}

/**
 * The missed turns as the agent reads them, or '' when there is nothing to say.
 * @param {{text: string|null}} missed the result of deltaSince
 */
function catchUpPrefix(missed) {
  const text = missed && missed.text;
  return text ? `SINCE YOUR LAST TURN IN THIS CONVERSATION:\n${text}\n\n` : '';
}

/**
 * The log fragment that says whether a delta went, and how big it was.
 *
 * A reader cannot otherwise tell an agent that received no catch-up from one
 * that received it and ignored it: different faults, different fixes.
 *
 * @param {{text: string|null, truncated?: number, clipped?: number}} missed
 * @param {boolean} resumed whether the agent was resumed at all
 */
function deltaNote(missed, resumed) {
  const m = missed || {};
  if (!m.text) return resumed ? ' delta=none' : '';
  return ` delta=${m.text.length}chars`
    + (m.truncated ? `/truncated${m.truncated}` : '')
    + (m.clipped ? '/clipped' : '');
}

/**
 * The full context a delegate is sent.
 *
 * A cold spawn gets the transcript; a resumed delegate gets the brief prefixed
 * by what it missed. Pure, so a test can assert the delegate's own prior turn
 * is absent and another agent's intervening turn is present.
 */
function buildDelegateContext({ transcript, missed, brief }) {
  if (transcript) return `CONVERSATION SO FAR:\n${transcript}\n\nYOUR TASK:\n${brief}`;
  return `${catchUpPrefix(missed)}[DELEGATION BRIEF]\n${brief}`;
}

/**
 * The prompt the orchestrator is sent when a specialist hands back.
 *
 * `outputBlock` already carries the specialist's final message, so the delta
 * passed in must exclude that specialist or the same text arrives twice.
 *
 * THREE MODES, THREE PROMPTS. The mode is the specialist's own declaration of
 * what it wants to happen next, not something inferred from its prose.
 *
 * - complete: the work is finished. The orchestrator stays silent so it does
 *   not parrot the specialist's output back at the user.
 * - continue: this specialist's part is finished and the request is not. The
 *   orchestrator must act, so it is given the output and told to carry on.
 *   This mode exists because `complete` used to serve both and the second
 *   case lost: the orchestrator was ordered to say exactly `<silent>` while
 *   holding a handback that asked it to route the work onward, so it obeyed
 *   and the request died in silence.
 * - return: the specialist never did the work, because it was out of scope.
 *
 * @param {{mode: 'complete'|'continue'|'return'}} args
 */
function buildScopeReturnPrompt({ mode, orchMissed, specialistId, outputBlock, pendingRequest }) {
  const catchUp = catchUpPrefix(orchMissed);
  if (mode === 'complete') {
    return `${catchUp}[SYSTEM: pipeline-complete] ${specialistId} has finished the delegated work. Here is their final message to the conversation:${outputBlock}\n\nYour output for this turn MUST be exactly the literal string <silent> and nothing else. Do not narrate, summarise, or quote the specialist's output. Do not invoke any tools. Do not emit any other text. Just output <silent> and stop.`;
  }
  if (mode === 'continue') {
    return `${catchUp}[SYSTEM: work-continues] ${specialistId} has finished their part and handed back because the request needs more work. Here is their final message to the conversation:${outputBlock}\n\nRead what they said and do what it asks for next. Do not re-delegate work already done, and do not repeat their output back to the user. If it needs another specialist, hand off with one short sentence saying who and why. If nothing remains to be done, say so briefly and stop.`;
  }
  return `${catchUp}[SYSTEM: routing-request] ${specialistId} returned because the request was outside their scope. Here is what they said:${outputBlock}\n\nThe user's latest request was: "${pendingRequest}". Respond with full awareness of what ${specialistId} delivered. Do not re-delegate work already done. Route to the right specialist using the Agent tool.`;
}

module.exports = {
  lastSessionFor,
  catchUpPrefix,
  deltaNote,
  buildDelegateContext,
  buildScopeReturnPrompt
};
