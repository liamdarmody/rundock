'use strict';
// The words for a delegate that stopped before finishing.
//
// The server decides that a delegate failed (engine.js, finishDelegateClose);
// this module only names why and builds the line a person reads. Kept apart
// from the engine so the engine's deps surface and exports stay as they are,
// and so every wording can be tested without a server.

/** A name on one line: every run of whitespace is one space, ends trimmed. */
function cleanName(name) {
  if (typeof name !== 'string') return null;
  const one = name.replace(/\s+/g, ' ').trim();
  return one || null;
}

/**
 * Exactly one reason, taken in this order: a Codex delegate, an error result,
 * a signal, an integer exit code, and otherwise stopped by the system.
 */
function stopReason({ codex, lastTurnOutcome, code, signal } = {}) {
  if (codex) return 'Codex reported an error';
  if (lastTurnOutcome === 'error') return 'Claude Code reported an error';
  if (signal) return 'stopped by the system';
  if (Number.isInteger(code)) return `exit code ${code}`;
  return 'stopped by the system';
}

/**
 * The title, a newline, the body, then a newline and the detail when there is
 * one. The parent's sentence is left out when there is no parent name.
 */
function stoppedLineText({ delegateName, parentName, reason, detail } = {}) {
  const d = cleanName(delegateName);
  const p = cleanName(parentName);
  const title = `${d || 'The agent'} stopped before finishing`;
  const body = `${d ? `${d}'s` : "The agent's"} session ended before a final answer (${reason}). `
    + (p ? `${p} has the conversation again. ` : '')
    + `Anything ${d || 'the agent'} changed before stopping is still in your workspace.`;
  const extra = typeof detail === 'string' && detail.trim() ? `\n${detail.trim()}` : '';
  return `${title}\n${body}${extra}`;
}

module.exports = { cleanName, stopReason, stoppedLineText };
