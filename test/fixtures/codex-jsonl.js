'use strict';
// Codex CLI `exec --json` JSONL event fixtures.
//
// Shapes follow the Codex CLI's documented JSON output: one JSON object per
// line, four event types that matter to Rundock (thread.started,
// item.completed with an agent_message item, turn.completed, turn.failed)
// plus a bare error form. Anything else is noise to be skipped.
//
// These fixtures are the single source of truth for both the unit tests and
// the stub codex binary, so the parser and the integration harness can never
// drift apart. Validate against a real `codex` binary when changing them.

function threadStarted(threadId) {
  return { type: 'thread.started', thread_id: threadId };
}

function agentMessage(text) {
  return { type: 'item.completed', item: { type: 'agent_message', text } };
}

// A non-message item completion (e.g. a command run or reasoning step).
// Rundock ignores these; only the final agent message is user-facing.
function otherItem(itemType = 'command_execution') {
  return { type: 'item.completed', item: { type: itemType, command: 'ls' } };
}

function turnCompleted(usage = {}) {
  return {
    type: 'turn.completed',
    usage: {
      input_tokens: usage.input ?? 100,
      cached_input_tokens: usage.cached ?? 0,
      output_tokens: usage.output ?? 50,
    },
  };
}

function turnFailed(message) {
  return { type: 'turn.failed', error: { message } };
}

function bareError(message) {
  return { type: 'error', message };
}

// The quota-exhaustion message the CLI emits when a ChatGPT plan's Codex
// allowance is used up. Wording varies; the classifier keys on "usage limit".
const QUOTA_MESSAGE = "You've hit your usage limit. Try again at 3pm.";

function toLines(events) {
  return events.map(e => JSON.stringify(e)).join('\n') + '\n';
}

module.exports = {
  threadStarted, agentMessage, otherItem, turnCompleted, turnFailed, bareError,
  toLines, QUOTA_MESSAGE,
};
