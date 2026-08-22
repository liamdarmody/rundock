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

// IMPORTED FROM THE READER RATHER THAN RESTATED. These are the reader's
// account of the format, and a checker that keeps its own copy checks a rule
// nobody is using: add a tool to the reader and the copy here would go on
// passing while covering one tool fewer. The independence a checker wants is
// independence from the reader's LOGIC, which this file has, not from its
// declarations.
//
// What that leaves is the real hole: a tool the reader claims and the capture
// never exercised. The partition below closes it. Every tool the reader names
// must be either witnessed by the capture, and checked against it, or listed
// as unwitnessed with the reason, and a tool that is neither fails this file.
const { FILE_TOOLS, KNOWN_BLOCK_TYPES } = require('../../lib/runtime/session-transcript.js');

// Tools the committed capture really contains, each checked below against the
// shapes it produced. Adding a tool to the reader means adding it here and
// extending the capture prompt to exercise it, or declaring it unwitnessed.
const WITNESSED_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

// Tools the reader carries that no capture can witness on this runtime, with
// the reason. Not a to-do list: an entry here is a statement that the tool is
// unverified, and the reader is built so that an unverified tool's outcome
// shape reports drift rather than being guessed at.
const UNWITNESSED_TOOLS = {
  MultiEdit: 'the installed runtime does not offer this tool at all (it is absent from the tool list a run announces), so nothing can produce one. It is carried because the permission hook matcher includes it, and because a runtime that brings it back should not silently drop its writes.',
};

function parseLines(lines) {
  return lines.map((line, i) => {
    try { return JSON.parse(line); } catch (e) { throw new Error(`line ${i + 1} is not JSON`); }
  });
}

/**
 * Everything the reader assumes, checked. Returns a list of failures; empty
 * means reality still matches what the reader was built against.
 */
/**
 * The reader's declarations against this file's account of them. Separate
 * from the transcript checks below because it needs no transcript: it is a
 * check that the two documents agree, and it fails when a tool is added to
 * the reader and nothing here is told about it.
 */
function checkDeclarationsAgree() {
  const failures = [];
  for (const tool of Object.keys(FILE_TOOLS)) {
    if (WITNESSED_TOOLS.has(tool)) continue;
    if (UNWITNESSED_TOOLS[tool]) continue;
    failures.push(`the reader handles ${tool} and this file says nothing about it: add it to WITNESSED_TOOLS and extend the capture prompt to exercise it, or record why no capture can witness it`);
  }
  for (const tool of WITNESSED_TOOLS) {
    if (!FILE_TOOLS[tool]) failures.push(`${tool} is claimed as witnessed but the reader no longer handles it`);
  }
  for (const tool of Object.keys(UNWITNESSED_TOOLS)) {
    if (!FILE_TOOLS[tool]) failures.push(`${tool} is recorded as unwitnessed but the reader no longer handles it`);
  }
  return failures;
}

function checkTranscriptInvariants(lines) {
  const failures = [...checkDeclarationsAgree()];
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
      say(KNOWN_BLOCK_TYPES.has(block.type), `content block type "${block.type}" is one the reader does not know`);
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
    const field = FILE_TOOLS[block.name] ? FILE_TOOLS[block.name].input : null;
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

  // Every tool this file claims the capture witnesses, actually witnessed,
  // with an outcome the reader can read. Without this the partition above
  // would be satisfied by naming a tool and never exercising it, which is the
  // silent narrowing it exists to prevent.
  for (const tool of WITNESSED_TOOLS) {
    const used = uses.filter(u => u.block.name === tool).map(u => u.block.id);
    // THE TWO ABSENCES ARE DIFFERENT PROBLEMS AND GET DIFFERENT SENTENCES, so
    // the complaint sends the reader to the right place. A tool with no call
    // at all means the capture prompt no longer exercises it; a tool called
    // and never answered means its result shape has moved. Told the second
    // when the first is true, somebody goes looking for a broken outcome and
    // finds nothing, because there was no call to answer.
    if (used.length === 0) {
      failures.push(`${tool} is claimed as witnessed and the capture contains no ${tool} call: extend the capture prompt or stop claiming it`);
      continue;
    }
    const answered = results.filter(r => used.includes(r.block.tool_use_id) && r.entry.toolUseResult);
    say(answered.length > 0, `${tool} appears in the capture with no outcome, so its result shape is unwitnessed`);
    // The field the OUTCOME names the file in, per tool, because they differ:
    // a notebook edit reports notebook_path where everything else reports
    // filePath. Checked here because assuming one field for all of them is
    // exactly the mistake this capture caught.
    say(answered.some(r => typeof r.entry.toolUseResult[FILE_TOOLS[tool].result] === 'string'),
      `${tool} outcomes in the capture do not name the file in ${FILE_TOOLS[tool].result}, which is where the reader looks`);
  }

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
  ['book.ipynb', 'edited'],
  ['par-a.md', 'created'],
  ['par-b.md', 'created'],
];

// The write the run attempted and did not make. Never a file it changed.
const EXPECTED_ABSENT = 'capture-blocked.txt';

module.exports = { checkTranscriptInvariants, checkDeclarationsAgree, EXPECTED_EXTRACTION, EXPECTED_ABSENT, WITNESSED_TOOLS, UNWITNESSED_TOOLS };
