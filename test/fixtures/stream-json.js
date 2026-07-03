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
function toolUseStart(name, index = 1) {
  return { type: 'stream_event', event: { type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_${index}`, name } } };
}

function inputJsonDelta(partialJson, index = 1) {
  return { type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: partialJson } } };
}

// Full tool_use flow with the input JSON split into two deltas.
function toolUseFlow(name, input, index = 1) {
  const json = JSON.stringify(input);
  const mid = Math.max(1, Math.floor(json.length / 2));
  return [
    toolUseStart(name, index),
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

// Canonical marker strings, so tests and stub scenarios never typo them.
const MARKERS = {
  RETURN: '<!-- RUNDOCK:RETURN -->',
  COMPLETE: '<!-- RUNDOCK:COMPLETE -->',
  saveAgent: (name, payload) => `<!-- RUNDOCK:SAVE_AGENT name=${name} -->${payload}<!-- /RUNDOCK:SAVE_AGENT -->`,
  saveSkill: (name, payload) => `<!-- RUNDOCK:SAVE_SKILL name=${name} -->${payload}<!-- /RUNDOCK:SAVE_SKILL -->`,
};

module.exports = {
  init, contentBlockStartText, textDelta, contentBlockStop,
  toolUseStart, inputJsonDelta, toolUseFlow,
  assistantMessage, result, textTurn, toLines, MARKERS,
};
