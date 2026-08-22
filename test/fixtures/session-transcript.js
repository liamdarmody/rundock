'use strict';
// Session transcript lines, in the shape Claude Code really writes them.
//
// CAPTURED, NOT INVENTED. Every shape here was read out of a transcript
// produced by a real `claude` run (2.1.240) driven the way the scheduler
// drives one: --print --output-format stream-json --verbose
// --dangerously-skip-permissions, with a fixed --session-id, one Write that
// succeeded and one Write that failed. The captured facts these builders
// preserve, because the reader depends on each of them:
//
//   - A tool call is an `assistant` line whose message.content holds a
//     `tool_use` block; its outcome is a LATER `user` line whose
//     message.content holds a `tool_result` block naming the same id.
//   - A write that succeeded carries a `toolUseResult` OBJECT with the path
//     it really wrote and `type: 'create'` for a new file or 'update' for an
//     existing one, and its tool_result block has no `is_error`.
//   - A write that failed carries `is_error: true` on the block and a STRING
//     `toolUseResult` holding the error text. Nothing else distinguishes it:
//     the tool_use line of a failed write is identical to that of one that
//     worked, which is the whole reason the reader must reach the result.
//
// A double that got any of those wrong would let a reader that never checks
// an outcome pass its tests, which is the defect these fixtures exist to make
// impossible.

// Line ids are per-file and only have to be unique within one transcript.
let seq = 0;
function toolId() { return `toolu_fixture_${++seq}`; }

function line(obj) { return JSON.stringify(obj) + '\n'; }

/** The user's prompt: message.content is a STRING here, not an array. */
function prompt(sessionId, text, at = '2026-08-22T19:15:00.000Z') {
  return line({
    type: 'user', sessionId, timestamp: at, cwd: '/w', userType: 'external',
    message: { role: 'user', content: text },
  });
}

/** Assistant prose, which is what the run says it is doing between tools. */
function say(sessionId, text, at = '2026-08-22T19:15:05.000Z') {
  return line({
    type: 'assistant', sessionId, timestamp: at,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });
}

/**
 * A file tool asking, and the answer it got.
 *
 * `outcome` is 'create' or 'update' for a write that happened, and 'error'
 * for one that did not. `at` stamps the ASK, which is when the run touched
 * the file.
 */
function fileTool(sessionId, { tool = 'Write', file, outcome = 'create', at = '2026-08-22T19:15:10.000Z', resultPath } = {}) {
  const id = toolId();
  const inputKey = tool === 'NotebookEdit' ? 'notebook_path' : 'file_path';
  const ask = line({
    type: 'assistant', sessionId, timestamp: at,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: tool, input: { [inputKey]: file, content: 'body' } }] },
  });
  const answered = outcome === 'error'
    ? line({
      type: 'user', sessionId, timestamp: at,
      toolUseResult: `Error: EPERM: operation not permitted, open '${file}.tmp'`,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: `EPERM: operation not permitted, open '${file}.tmp'` }] },
    })
    : line({
      type: 'user', sessionId, timestamp: at,
      toolUseResult: { type: outcome, filePath: resultPath || file, content: 'body', structuredPatch: [] },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `File ${outcome === 'create' ? 'created' : 'updated'} successfully at: ${resultPath || file}` }] },
    });
  return { ask, answered, id };
}

/** An ask with no answer yet: the shape a transcript has WHILE a tool runs. */
function unanswered(sessionId, opts) {
  return fileTool(sessionId, opts).ask;
}

/** Ask and answer together, which is what a finished tool call looks like. */
function completed(sessionId, opts) {
  const { ask, answered } = fileTool(sessionId, opts);
  return ask + answered;
}

module.exports = { prompt, say, fileTool, unanswered, completed };
