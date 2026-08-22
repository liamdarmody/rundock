'use strict';
// The reader, against a transcript a real run really produced.
//
// WHY THIS FILE AND NOT MORE FIXTURES. Every other test of this reader is
// written against shapes this repository invented. They can only ever prove
// the reader is self-consistent: get the shape wrong and the fixtures are
// wrong in exactly the same way, and everything passes while the product
// reports nonsense. The format belongs to the agent tool, so the only thing
// that can settle a question about it is an artefact from the tool itself.
//
// The capture is committed (scripts/transcript-truth/captured-transcript.json)
// and was taken from a run driven the way the scheduler drives one: print
// mode, permissions skipped, output discarded, session named by the caller.
// It contains a file created, a file edited, a file overwritten, a write that
// was refused, and two writes issued in parallel from a single message.
//
// This half runs in continuous integration, which has no runtime to spend.
// The half that checks the capture is still CURRENT (the installed CLI's
// version against the capture's) lives in the harness that took it, and is
// run by the release gate rather than by CI. Both facts are stated at the top
// of that harness.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { readSessionTranscript } = require('../../lib/runtime/session-transcript.js');
const { checkTranscriptInvariants, EXPECTED_EXTRACTION, EXPECTED_ABSENT } = require('../../scripts/transcript-truth/truth.js');

const captured = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', '..', 'scripts', 'transcript-truth', 'captured-transcript.json'), 'utf-8'));

let home = null;
let realHome = null;

before(() => {
  realHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-capture-'));
  // Laid down where a transcript lives, so the lookup under test is the real
  // one: found by session id, in a directory named for nothing in particular.
  const dir = path.join(home, '.claude', 'projects', 'captured-run');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${captured.sessionId}.jsonl`), captured.lines.join('\n') + '\n');
  process.env.HOME = home;
});

after(() => {
  process.env.HOME = realHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('the committed capture', () => {
  test('is a real transcript from a named runtime', () => {
    assert.match(captured.runtimeVersion, /^\d+\.\d+\.\d+$/, 'the capture says which runtime produced it');
    assert.ok(captured.lines.length > 20, 'and holds a whole run rather than a fragment');
    assert.match(captured.sessionId, /^[0-9a-f-]{36}$/, 'named for the session the run was told to be');
  });

  // The setup, asserted before anything is concluded from it. Every claim
  // below is about this artefact containing particular shapes; if a
  // re-capture ever loses one, these tests would pass for the wrong reason.
  test('still contains every shape the reader depends on', () => {
    assert.deepStrictEqual(checkTranscriptInvariants(captured.lines), [],
      'the capture satisfies each assumption the reader makes about the format');
  });

  test('really does contain the write that was refused', () => {
    const blocks = captured.lines
      .filter(l => l.includes(EXPECTED_ABSENT))
      .map(l => JSON.parse(l))
      .flatMap(entry => (entry.message && Array.isArray(entry.message.content) ? entry.message.content : []));
    assert.ok(blocks.some(b => b.type === 'tool_use'), 'the refused write was really asked for in this capture');
    assert.ok(blocks.some(b => b.type === 'tool_result' && b.is_error === true),
      'and its answer carries the marker the reader excludes on, so excluding it is a real exclusion');
  });
});

describe('the reader over the capture', () => {
  test('extracts exactly the files that run changed, and what happened to each', () => {
    const result = readSessionTranscript(captured.sessionId);
    assert.strictEqual(result.status, 'known', 'the real transcript is one this reader understands');
    assert.deepStrictEqual(result.files.map(f => [path.basename(f.path), f.change]), EXPECTED_EXTRACTION,
      'a creation, an edit, an overwrite and both halves of a parallel batch, each named for what it was');
  });

  test('does not list the write the run attempted and did not make', () => {
    const result = readSessionTranscript(captured.sessionId);
    assert.ok(!result.files.some(f => f.path.includes(EXPECTED_ABSENT)),
      'the refused write is in the transcript and is not in the list');
  });

  test('reports the paths the run itself named', () => {
    const result = readSessionTranscript(captured.sessionId);
    // Taken from the capture's own asks rather than written here, because the
    // run happened in a temporary directory belonging to the machine that
    // captured it.
    const asked = new Set();
    for (const line of captured.lines) {
      const entry = JSON.parse(line);
      const content = entry.message && entry.message.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block.type === 'tool_use' && block.input && typeof block.input.file_path === 'string') asked.add(block.input.file_path);
      }
    }
    for (const file of result.files) {
      assert.ok(asked.has(file.path), `${file.path} is a path the run really asked to write`);
      assert.ok(path.isAbsolute(file.path), 'and it is absolute, so it can be opened from the record');
    }
  });

  test('both halves of a parallel batch are listed once each, against their own paths', () => {
    const result = readSessionTranscript(captured.sessionId);
    const parallel = result.files.filter(f => path.basename(f.path).startsWith('par-'));
    assert.strictEqual(parallel.length, 2, 'two parallel writes, two entries');
    assert.strictEqual(new Set(parallel.map(f => f.path)).size, 2, 'and two different files, not one file twice');
  });
});
