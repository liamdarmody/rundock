'use strict';
// A LINE FOR THE AGENT, KEPT IN THE SERVER'S MEMORY AND HANDED TO THE HOOK.
//
// When Rundock puts back a change an agent made to one of the workspace's
// permission files, the agent should know, or it reads its own write
// vanishing as something having gone wrong. Rundock runs outside the agent's
// process and cannot speak to the model directly, but the PreToolUse hook
// answers every tool call the agent makes, and the runtime adds a hook
// answer's `additionalContext` to the model's context.
//
// ONLY RUNDOCK CAN LEAVE ONE. The line lives here, in this process, and the
// hook asks for it over the local connection it already uses for cards
// (GET /api/agent-notice). Nothing is written to the workspace, so there is
// no file an agent could write to put words of its own into that context,
// for its own conversation or anyone else's.
const PLAIN_ID = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/;
const MAX_CHARS = 2000;
const waiting = new Map(); // conversation id -> lines, in the order left

function plainId(convoId) {
  const id = typeof convoId === 'string' ? convoId : '';
  return PLAIN_ID.test(id) && id !== '.' && id !== '..' ? id : null;
}

// Leave `text` for the conversation's next tool call. Returns whether it did.
function leaveAgentNotice(convoId, text) {
  const id = plainId(convoId);
  const line = String(text || '').trim();
  if (!id || !line) return false;
  const lines = waiting.get(id) || [];
  if (!lines.includes(line)) lines.push(line);
  waiting.set(id, lines);
  return true;
}

// Take whatever is waiting for the conversation, removing it, or null.
function takeAgentNotice(convoId) {
  const id = plainId(convoId);
  if (!id || !waiting.has(id)) return null;
  const lines = waiting.get(id);
  waiting.delete(id);
  const text = lines.join('\n').trim();
  return text ? text.slice(0, MAX_CHARS) : null;
}

module.exports = { leaveAgentNotice, takeAgentNotice };
