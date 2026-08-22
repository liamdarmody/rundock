'use strict';
// The facts about a session transcript that lib/runtime/session-transcript.js
// depends on, written as checks so they can be verified against a real one
// rather than believed.
//
// Two callers, deliberately. The capture runner checks them against a
// transcript a REAL run just produced, so a runtime that has moved is caught
// at capture time. The unit test checks them against the COMMITTED capture and
// then runs the reader over it, so continuous integration, which has no
// runtime to spend, still pins the reader to a real artefact.
//
// Every entry here is a claim the reader would be wrong without. Adding a
// dependency on some other part of the shape means adding it here too, or the
// capture stops covering the thing it exists to cover.

// The declared content-block union (ContentBlock in types.d.ts), which is also
// exactly what the capture contains.
const BLOCK_TYPES = new Set(['text', 'thinking', 'tool_use', 'tool_result']);

const FILE_TOOL_INPUT = { Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' };

function parseLines(lines) {
  return lines.map((line, i) => {
    try { return JSON.parse(line); } catch (e) { throw new Error(`line ${i + 1} is not JSON`); }
  });
}

/**
 * Everything the reader assumes, checked. Returns a list of failures; empty
 * means reality still matches what the reader was built against.
 */
function checkTranscriptInvariants(lines) {
  const failures = [];
  let entries;
  try { entries = parseLines(lines); } catch (e) { return [e.message]; }

  const say = (ok, msg) => { if (!ok) failures.push(msg); };

  const messages = entries.filter(e => e && (e.type === 'user' || e.type === 'assistant') && e.message);
  say(messages.length > 0, 'no user/assistant message envelopes at all: the reader would understand nothing');

  const uses = [];
  const results = [];
  for (const entry of entries) {
    const content = entry && entry.message ? entry.message.content : null;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      say(BLOCK_TYPES.has(block.type), `content block type "${block.type}" is outside the declared union`);
      if (block.type === 'tool_use') uses.push({ entry, block });
      if (block.type === 'tool_result') results.push({ entry, block });
    }
    const inThisEntry = content.filter(b => b && b.type === 'tool_result').length;
    // The reader reads the outcome payload from the ENTRY while the ask is on
    // the BLOCK, which is exact only while one entry carries one result.
    say(inThisEntry <= 1, 'an entry carries more than one tool_result: outcome payloads can no longer be attributed by entry');
  }

  // A parallel batch really was issued and really was split, which is why one
  // result per entry holds even for concurrent writes.
  const byMessageId = new Map();
  for (const { entry, block } of uses) {
    const id = entry.message.id;
    if (!id) continue;
    if (!byMessageId.has(id)) byMessageId.set(id, []);
    byMessageId.get(id).push(block);
  }
  say([...byMessageId.values()].some(blocks => blocks.length > 1),
    'no parallel tool batch in this capture: the split of one message into several lines is unwitnessed');

  for (const { block } of uses) {
    const field = FILE_TOOL_INPUT[block.name];
    if (!field) continue;
    say(block.input && typeof block.input[field] === 'string',
      `${block.name} does not name its file in input.${field}`);
  }

  const payloads = results.map(({ entry, block }) => ({ block, result: entry.toolUseResult }));
  const objects = payloads.filter(p => p.result && typeof p.result === 'object');
  say(objects.some(p => p.result.type === 'create' && typeof p.result.filePath === 'string'),
    'no write reporting type "create" with a filePath: the reader could not tell a creation');
  say(objects.some(p => p.result.type === 'update' && typeof p.result.filePath === 'string'),
    'no write reporting type "update" with a filePath: the reader could not tell an overwrite');
  say(objects.some(p => p.result.type === undefined && typeof p.result.filePath === 'string' && typeof p.result.oldString === 'string'),
    'no edit reporting a filePath with no type: the reader could not tell an edit');
  say(payloads.some(p => p.block.is_error === true && typeof p.result === 'string'),
    'no refused write carrying is_error true: the reader could not exclude an attempted write');

  return failures;
}

/**
 * What the reader must extract from the committed capture, by file name and
 * what happened to it. Names rather than absolute paths, because the capture
 * was taken in a temporary directory whose path belongs to the machine that
 * took it; the paths themselves are asserted against the capture's own asks.
 */
const EXPECTED_EXTRACTION = [
  ['new.md', 'created'],
  ['existing.md', 'edited'],
  ['overwrite.md', 'edited'],
  ['par-a.md', 'created'],
  ['par-b.md', 'created'],
];

// The write the run attempted and did not make. Never a file it changed.
const EXPECTED_ABSENT = 'capture-blocked.txt';

module.exports = { checkTranscriptInvariants, EXPECTED_EXTRACTION, EXPECTED_ABSENT, BLOCK_TYPES, FILE_TOOL_INPUT };
