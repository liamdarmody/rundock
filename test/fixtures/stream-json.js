'use strict';
// SHARED stream-json envelope fixtures.
//
// These builders produce the exact wire shapes Claude Code emits with
// `--output-format stream-json --verbose --include-partial-messages`, as
// consumed by server.js. They are used by BOTH:
//   - the unit tests that exercise wireProcessHandlers and the close-handler
//     buffer flushes (the duplicated stream-json parse sites), and
//   - the stub `claude` binary (test/helpers/stub-claude/claude) that drives
//     the full delegation lifecycle in integration tests.
// Keeping one source of truth means a later refactor that deduplicates the
// parse sites can be validated against a single fixture set.

function init(sessionId) {
  return { type: 'system', subtype: 'init', session_id: sessionId };
}

function contentBlockStartText(index = 0) {
  return { type: 'stream_event', event: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } } };
}

function textDelta(text, index = 0) {
  return { type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: 'text_delta', text } } };
}

function contentBlockStop(index = 0) {
  return { type: 'stream_event', event: { type: 'content_block_stop', index } };
}

// Tool use block (Agent, Read, Bash, ...) streamed as start -> input_json_delta -> stop.
// `id` is the block's tool_use id; by default it is made from the index.
function toolUseStart(name, index = 1, id = `toolu_${index}`) {
  return { type: 'stream_event', event: { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name } } };
}

function inputJsonDelta(partialJson, index = 1) {
  return { type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: partialJson } } };
}

// End-of-message events. The REAL interactive stream closes every assistant
// message with message_delta (stop_reason) then message_stop, and does NOT
// reliably emit a consolidated `assistant` envelope before tool execution
// begins. The 0.11.6 interception regression shipped because these events
// were missing here: the stub's stream shape diverged from production, so
// a decision point anchored on the assistant envelope passed every test and
// never fired in real use.
function messageDelta(stopReason = 'end_turn') {
  return { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: {} } };
}
function messageStop() {
  return { type: 'stream_event', event: { type: 'message_stop' } };
}

// Full tool_use flow with the input JSON split into two deltas.
function toolUseFlow(name, input, index = 1, id = undefined) {
  const json = JSON.stringify(input);
  const mid = Math.max(1, Math.floor(json.length / 2));
  return [
    toolUseStart(name, index, id),
    inputJsonDelta(json.slice(0, mid), index),
    inputJsonDelta(json.slice(mid), index),
    contentBlockStop(index),
  ];
}

function assistantMessage(text, extraBlocks = []) {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }, ...extraBlocks] },
  };
}

function result({ text = '', isError = false, sessionId = null, extra = {} } = {}) {
  return {
    type: 'result',
    subtype: isError ? 'error_during_execution' : 'success',
    is_error: isError,
    result: text,
    ...(sessionId ? { session_id: sessionId } : {}),
    duration_ms: 10,
    ...extra,
  };
}

// A complete plain text turn: streamed deltas + assistant message + result.
function textTurn(text, { sessionId = null, deltaChunks = 2 } = {}) {
  const events = [contentBlockStartText()];
  const size = Math.ceil(text.length / deltaChunks) || 1;
  for (let i = 0; i < text.length; i += size) events.push(textDelta(text.slice(i, i + size)));
  events.push(contentBlockStop());
  events.push(assistantMessage(text));
  events.push(result({ text, sessionId }));
  return events;
}

function toLines(events) {
  return events.map(e => JSON.stringify(e)).join('\n') + '\n';
}

// Canonical marker strings, so tests and stub scenarios never typo them. The
// save markers carry their body on its own lines, as the marker scan reads
// them (public/markers.js): without the line break after the opening marker
// the scan sees no save at all, and a test built on one proves nothing.
const MARKERS = {
  RETURN: '<!-- RUNDOCK:RETURN -->',
  COMPLETE: '<!-- RUNDOCK:COMPLETE -->',
  saveAgent: (name, payload) => `<!-- RUNDOCK:SAVE_AGENT name=${name} -->\n${payload}\n<!-- /RUNDOCK:SAVE_AGENT -->`,
  saveSkill: (name, payload) => `<!-- RUNDOCK:SAVE_SKILL name=${name} -->\n${payload}\n<!-- /RUNDOCK:SAVE_SKILL -->`,
};

// Lines about the helpers a lead started with Agent. Claude Code marks every
// line a helper writes with the tool_use id of the call that started it, and
// reports each helper's life as `task_*` system lines carrying that same id.
// A lead's own lines carry no parent id (null or absent).

// Any envelope as a helper's: the same line, marked with its parent call.
function helperLine(envelope, parentToolUseId) {
  return { ...envelope, parent_tool_use_id: parentToolUseId };
}

function taskStarted({ taskId, toolUseId, description = '', subagentType } = {}) {
  return {
    type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: toolUseId,
    description, task_type: 'local_agent',
    ...(subagentType ? { subagent_type: subagentType } : {}),
  };
}

function taskProgress({ taskId, toolUseId, description = '', lastToolName, usage } = {}) {
  return {
    type: 'system', subtype: 'task_progress', task_id: taskId, tool_use_id: toolUseId,
    description, usage: usage || { total_tokens: 0, tool_uses: 0, duration_ms: 0 },
    ...(lastToolName ? { last_tool_name: lastToolName } : {}),
  };
}

// status: completed, killed or failed.
function taskUpdated(taskId, status) {
  return { type: 'system', subtype: 'task_updated', task_id: taskId, status };
}

// status: completed, failed or stopped (a stopped helper is a killed one).
function taskNotification({ taskId, toolUseId, status = 'completed', summary = '' } = {}) {
  return {
    type: 'system', subtype: 'task_notification', task_id: taskId, tool_use_id: toolUseId,
    status, summary,
  };
}

module.exports = {
  init, contentBlockStartText, textDelta, contentBlockStop,
  toolUseStart, inputJsonDelta, toolUseFlow, messageDelta, messageStop,
  assistantMessage, result, textTurn, toLines, MARKERS,
  helperLine, taskStarted, taskProgress, taskUpdated, taskNotification,
};
