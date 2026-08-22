'use strict';
// Reading what a run did out of the session transcript it left on disk.
//
// WHAT EVERY TEST HERE HAS TO BE CAREFUL OF, and it is why several of them
// are heavier than their assertion. An empty list and an unknown list look
// identical to a careless assertion, and a reader that found nothing at all
// produces the same `[]` as a run that genuinely changed nothing. So each
// test here either asserts a NON-EMPTY list whose contents could only come
// from the transcript it wrote, or asserts the status field that separates
// the two cases, and the tests that care about identity put a SECOND
// transcript on disk so "it found the only file there" cannot pass for
// "it found the right file".
//
// The transcript root is $HOME/.claude/projects, read at call time rather
// than at require time, which is what lets these tests point it at a
// disposable directory.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const fx = require('../fixtures/session-transcript.js');
const { readSessionTranscript } = require('../../lib/runtime/session-transcript.js');

let home = null;
let realHome = null;

before(() => {
  realHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-transcript-'));
  process.env.HOME = home;
});

after(() => {
  process.env.HOME = realHome;
  fs.rmSync(home, { recursive: true, force: true });
});

/**
 * Write a transcript for `sessionId` into a project directory, the way the
 * agent tool does: one file per session, named for the session, under a
 * directory named for the working directory the run happened in.
 */
function writeTranscript(sessionId, lines, projectDir = '-w-one') {
  const dir = path.join(home, '.claude', 'projects', projectDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, lines.join(''));
  return file;
}

const paths = (result) => (result.files || []).map(f => f.path);

// ---------------------------------------------------------------------------
// Identification
// ---------------------------------------------------------------------------

describe('finding the transcript that belongs to one run', () => {
  // AC-1. Two runs, two transcripts, in two different project directories,
  // because the directory is named for the working directory and nothing
  // promises a routine's cwd is the one that produced any given file. The
  // wanted transcript is NOT the only one on disk and NOT the only one in its
  // directory, so a reader that grabbed any transcript at all would report the
  // other run's file.
  test('a run is identified by its own session id, not by which directory it sits in', () => {
    writeTranscript('11111111-1111-4111-8111-111111111111',
      [fx.prompt('11111111-1111-4111-8111-111111111111', 'go'),
        fx.completed('11111111-1111-4111-8111-111111111111', { file: '/w/mine.md' })], '-w-one');
    writeTranscript('22222222-2222-4222-8222-222222222222',
      [fx.prompt('22222222-2222-4222-8222-222222222222', 'go'),
        fx.completed('22222222-2222-4222-8222-222222222222', { file: '/w/theirs.md' })], '-w-two');

    const mine = readSessionTranscript('11111111-1111-4111-8111-111111111111');
    assert.strictEqual(mine.status, 'known', 'the run\'s transcript was found');
    assert.deepStrictEqual(paths(mine), ['/w/mine.md'], 'and it is that run\'s file, not the other run\'s');

    const theirs = readSessionTranscript('22222222-2222-4222-8222-222222222222');
    assert.deepStrictEqual(paths(theirs), ['/w/theirs.md'], 'and the other run reads its own, from a different directory');
  });

  // AC-2. The wanted transcript is written FIRST and a different run's is
  // written after it, so it is the OLDEST file on disk and the least recently
  // modified. Anything reaching for "the latest transcript" answers with
  // newer.md here, which is a plausible list of files belonging to a run
  // nobody asked about: the exact silent failure this criterion exists for.
  test('the run asked about is answered even when a newer run has happened since', () => {
    const wanted = '33333333-3333-4333-8333-333333333333';
    const file = writeTranscript(wanted, [fx.prompt(wanted, 'go'), fx.completed(wanted, { file: '/w/older.md' })]);
    const newer = writeTranscript('44444444-4444-4444-8444-444444444444',
      [fx.prompt('44444444-4444-4444-8444-444444444444', 'go'),
        fx.completed('44444444-4444-4444-8444-444444444444', { file: '/w/newer.md' })]);
    // Stated as a measurement rather than assumed from the order of the two
    // writes above, so the premise of the test is proved before its assertion.
    const older = fs.statSync(file).mtimeMs;
    fs.utimesSync(newer, new Date(older + 60_000), new Date(older + 60_000));
    assert.ok(fs.statSync(newer).mtimeMs > older, 'the run NOT asked about really is the most recent one');

    assert.deepStrictEqual(paths(readSessionTranscript(wanted)), ['/w/older.md'],
      'the older run still answers with its own file');
  });

  // AC-3 and AC-25. A run whose transcript is not there says so. Reported as
  // a run that changed nothing, this is a lie that revert would eventually
  // act on.
  test('a run with no transcript is unknown, and unknown is not empty', () => {
    const result = readSessionTranscript('55555555-5555-4555-8555-555555555555');
    assert.strictEqual(result.status, 'unknown', 'not knowing is a status of its own');
    assert.strictEqual(result.reason, 'no-transcript', 'and it names why');
    assert.strictEqual(result.files, null,
      'with no list at all: an empty list would read as a run that changed nothing');
  });

  test('a run with no session id at all is unknown for that reason', () => {
    const result = readSessionTranscript(null);
    assert.strictEqual(result.status, 'unknown');
    assert.strictEqual(result.reason, 'no-session', 'a runtime that keeps no session is not a missing file');
    assert.strictEqual(result.files, null);
  });
});

// ---------------------------------------------------------------------------
// What a run says it did
// ---------------------------------------------------------------------------

describe('the files a run changed', () => {
  // AC-4, AC-6. Created and edited are different answers, and both are read
  // from the outcome the tool reported rather than guessed from the name of
  // the tool that asked.
  test('a file created is distinguished from a file edited', () => {
    const sid = '66666666-6666-4666-8666-666666666666';
    writeTranscript(sid, [
      fx.prompt(sid, 'go'),
      fx.completed(sid, { file: '/w/new.md', outcome: 'create' }),
      fx.completed(sid, { file: '/w/existing.md', outcome: 'update' }),
      fx.completed(sid, { tool: 'Edit', file: '/w/edited.md', outcome: 'update' }),
    ]);

    const result = readSessionTranscript(sid);
    assert.strictEqual(result.status, 'known');
    assert.deepStrictEqual(result.files.map(f => [f.path, f.change]), [
      ['/w/new.md', 'created'],
      ['/w/existing.md', 'edited'],
      ['/w/edited.md', 'edited'],
    ], 'a write to a file that was not there is a creation; a write over one that was is an edit');
  });

  // The entry shape the revert card needs: a second producer has to be able
  // to add a backup handle to one of these without the list changing shape.
  test('each file carries what it was, which tool touched it, when, and where that was learned', () => {
    const sid = '77777777-7777-4777-8777-777777777777';
    writeTranscript(sid, [fx.prompt(sid, 'go'),
      fx.completed(sid, { file: '/w/one.md', at: '2026-08-22T19:20:00.000Z' })]);

    const [entry] = readSessionTranscript(sid).files;
    assert.deepStrictEqual(entry, {
      path: '/w/one.md', tool: 'Write', change: 'created',
      at: '2026-08-22T19:20:00.000Z', source: 'transcript',
    }, 'an entry, not a string: a path alone cannot say how it was learned or what it was');
  });

  // AC-5, AC-23, AC-24. The two tool_use lines are IDENTICAL apart from the
  // path, so nothing about the ask distinguishes the write that happened from
  // the one that did not. Only the outcome does, which is what makes this the
  // test that fails when the outcome is ignored.
  test('a write the run attempted and did not make is not among the files it changed', () => {
    const sid = '88888888-8888-4888-8888-888888888888';
    writeTranscript(sid, [
      fx.prompt(sid, 'go'),
      fx.completed(sid, { file: '/w/written.md', outcome: 'create' }),
      fx.completed(sid, { file: '/System/refused.md', outcome: 'error' }),
    ]);

    const result = readSessionTranscript(sid);
    assert.deepStrictEqual(paths(result), ['/w/written.md'],
      'the write that succeeded is listed and the write that failed is not');
    assert.ok(!paths(result).includes('/System/refused.md'),
      'a list of attempted writes is not a list of files changed');
  });

  // A tool still running when the transcript was read has asked and not been
  // answered, which is the same absence of evidence as a refusal.
  test('a write with no outcome yet is not counted as one that happened', () => {
    const sid = '99999999-9999-4999-8999-999999999999';
    writeTranscript(sid, [
      fx.prompt(sid, 'go'),
      fx.completed(sid, { file: '/w/done.md' }),
      fx.unanswered(sid, { file: '/w/in-flight.md' }),
    ]);

    assert.deepStrictEqual(paths(readSessionTranscript(sid)), ['/w/done.md'],
      'only the write that reported back is a write that happened');
  });

  // The gap the review found in the existing tool matcher: the permission
  // hook's own list includes these two and the chat-side matcher does not.
  test('multi-edit and notebook writes count, because they change files too', () => {
    const sid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    writeTranscript(sid, [
      fx.prompt(sid, 'go'),
      fx.completed(sid, { tool: 'MultiEdit', file: '/w/many.md', outcome: 'update' }),
      fx.completed(sid, { tool: 'NotebookEdit', file: '/w/book.ipynb', outcome: 'update' }),
    ]);

    assert.deepStrictEqual(paths(readSessionTranscript(sid)), ['/w/many.md', '/w/book.ipynb']);
  });

  // The path is taken from the OUTCOME when the outcome names one, because
  // that is the file the tool reports having written, and only the ask is
  // available otherwise.
  test('the path recorded is the one the write reported, not the one it asked for', () => {
    const sid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    writeTranscript(sid, [fx.prompt(sid, 'go'),
      fx.completed(sid, { file: 'relative.md', resultPath: '/w/relative.md' })]);

    assert.deepStrictEqual(paths(readSessionTranscript(sid)), ['/w/relative.md']);
  });

  // AC-7. The other half of the unknown/empty separation: a real transcript
  // with no file tools in it is a run that genuinely changed nothing, and it
  // must not be reported as a run nobody can account for.
  test('a run that changed nothing is known to have changed nothing', () => {
    const sid = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    writeTranscript(sid, [fx.prompt(sid, 'go'), fx.say(sid, 'I had nothing to do.')]);

    const result = readSessionTranscript(sid);
    assert.strictEqual(result.status, 'known', 'the transcript was read and understood');
    assert.deepStrictEqual(result.files, [], 'and it changed nothing, which is a different answer from not knowing');
  });
});

// ---------------------------------------------------------------------------
// Progress while it runs
// ---------------------------------------------------------------------------

describe('what a run is doing', () => {
  // AC-8, AC-9. Read twice from a file that grew in between, which is what
  // polling is. Nothing here registers for a filesystem event.
  test('the latest activity moves as the run writes more of its transcript', () => {
    const sid = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const file = writeTranscript(sid, [fx.prompt(sid, 'go'), fx.say(sid, 'Starting the sweep.')]);

    const first = readSessionTranscript(sid);
    assert.deepStrictEqual(first.activity, { kind: 'text', text: 'Starting the sweep.', at: '2026-08-22T19:15:05.000Z' },
      'the run says what it is doing in its own words');

    fs.appendFileSync(file, fx.unanswered(sid, { file: '/w/late.md', at: '2026-08-22T19:16:00.000Z' }));
    const second = readSessionTranscript(sid);
    assert.deepStrictEqual(second.activity, { kind: 'tool', tool: 'Write', path: '/w/late.md', at: '2026-08-22T19:16:00.000Z' },
      'a later poll sees the tool it has since reached');
    assert.notDeepStrictEqual(second.activity, first.activity,
      'so the second reading is a reading and not the first one handed back');
  });

  test('a run with no transcript is not doing anything anybody can see', () => {
    const result = readSessionTranscript('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
    assert.strictEqual(result.status, 'unknown');
    assert.strictEqual(result.activity, null, 'no activity, rather than an invented one');
  });
});

// ---------------------------------------------------------------------------
// Failing safely
// ---------------------------------------------------------------------------

describe('a transcript that cannot be used', () => {
  // AC-15, AC-16, AC-17. Every one of these is read while a run is ending, on
  // the unattended path, so throwing here would take down the thing being
  // recorded rather than the record.
  test('a transcript that cannot be read is unknown, and reading it does not throw', () => {
    const sid = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const file = writeTranscript(sid, [fx.prompt(sid, 'go'), fx.completed(sid, { file: '/w/hidden.md' })]);
    // Proved readable first, so the assertion below is about the permission
    // change and not about a fixture that never worked.
    assert.deepStrictEqual(paths(readSessionTranscript(sid)), ['/w/hidden.md'], 'readable to begin with');
    fs.chmodSync(file, 0o000);
    try {
      const result = readSessionTranscript(sid);
      assert.strictEqual(result.status, 'unknown', 'unreadable is not empty');
      assert.strictEqual(result.reason, 'unreadable');
      assert.strictEqual(result.files, null);
    } finally {
      fs.chmodSync(file, 0o600);
    }
  });

  // A format this reader does not know. Valid JSON lines, none of them a
  // message: the honest answer is that nothing here can be vouched for, which
  // is different from a transcript that was understood and held no writes.
  test('a transcript whose shape is not understood is unknown rather than empty', () => {
    const sid = 'a0000000-0000-4000-8000-000000000001';
    writeTranscript(sid, [
      JSON.stringify({ kind: 'something-else', v: 2 }) + '\n',
      JSON.stringify({ kind: 'something-else', v: 3 }) + '\n',
    ]);

    const result = readSessionTranscript(sid);
    assert.strictEqual(result.status, 'unknown');
    assert.strictEqual(result.reason, 'unrecognized', 'a shape nobody here understands is named as such');
    assert.strictEqual(result.files, null);
  });

  // One bad line in a transcript that is otherwise fine. A half-written line
  // is the ordinary state of a file being appended to while it is read.
  test('a half-written line does not cost the run the rest of its transcript', () => {
    const sid = 'a0000000-0000-4000-8000-000000000002';
    writeTranscript(sid, [
      fx.prompt(sid, 'go'),
      fx.completed(sid, { file: '/w/before.md' }),
      '{"type":"assistant","message":{"content":[{"type":"tool_u\n',
      fx.completed(sid, { file: '/w/after.md', outcome: 'update' }),
    ]);

    assert.deepStrictEqual(paths(readSessionTranscript(sid)), ['/w/before.md', '/w/after.md'],
      'the lines that parse are still read');
  });
});
