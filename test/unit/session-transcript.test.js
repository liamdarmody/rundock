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

  // AC-7, and the case a partial list gets wrong. One write reported back and
  // one never did, which after the run has ended means the run was cut off
  // between the tool writing the file and the runtime recording the outcome.
  // The open write may well be on disk. A list holding only the resolved one
  // is quietly incomplete, and quietly incomplete is the failure this reader
  // exists to prevent: the honest answer is that the list cannot be vouched
  // for, whatever else in the same transcript could be.
  test('a write with no outcome yet makes the whole list unknown, not a shorter list', () => {
    const sid = '99999999-9999-4999-8999-999999999999';
    writeTranscript(sid, [
      fx.prompt(sid, 'go'),
      fx.completed(sid, { file: '/w/done.md' }),
      fx.unanswered(sid, { file: '/w/in-flight.md' }),
    ]);

    const result = readSessionTranscript(sid);
    assert.strictEqual(result.status, 'unknown', 'one open ask is enough, however many closed');
    assert.strictEqual(result.reason, 'unresolved', 'and it names which absence this is');
    assert.strictEqual(result.files, null,
      'no list at all: a list of the writes that did report back reads as the whole of what the run changed');
    assert.deepStrictEqual(result.activity, { kind: 'tool', tool: 'Write', path: '/w/in-flight.md', at: '2026-08-22T19:15:10.000Z' },
      'while what the run was last seen doing survives, which is what progress is read from');
  });

  // An outcome that reports its own failure in a field of its own, which is
  // what a notebook edit carries (empty in the capture, where it worked). A
  // file whose write says something went wrong is not a file this reader may
  // list as changed.
  test('an outcome that reports an error of its own is not a file changed', () => {
    const sid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab';
    writeTranscript(sid, [
      fx.prompt(sid, 'go'),
      fx.completed(sid, { tool: 'NotebookEdit', file: '/w/book.ipynb', outcome: 'update' })
        .split('"oldString"').join('"error":"cell not found","oldString"'),
    ]);
    const result = readSessionTranscript(sid);
    assert.strictEqual(result.status, 'unknown', 'an outcome carrying an error is not an outcome to list');
    assert.strictEqual(result.files, null);
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
// Work the run handed to somebody else
// ---------------------------------------------------------------------------

/**
 * A subagent's transcript, where the runtime really files one: under a
 * directory named for the session, beside the session's own transcript.
 */
function writeSidechain(sessionId, lines, projectDir = '-w-one', name = 'agent-fixture.jsonl') {
  const dir = path.join(home, '.claude', 'projects', projectDir, sessionId, 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.join(''));
  return file;
}

describe('a run that handed work to a subagent', () => {
  // AC-4 and AC-7, settled by capture rather than by argument. A delegated
  // subagent gets a transcript of its OWN, and its outcome entries carry no
  // toolUseResult: the path and whether the file was created or overwritten
  // are only in an English sentence. So the reader can see THAT a subagent
  // asked to write and cannot say what came of it, which is not a list it may
  // publish beside the parent's as though it were complete.
  test('a subagent that asked to change a file makes the run\'s list unknown', () => {
    const sid = 'd1000000-0000-4000-8000-000000000001';
    writeTranscript(sid, [fx.prompt(sid, 'go'), fx.completed(sid, { file: '/w/parent.md' }), fx.delegate(sid)]);
    writeSidechain(sid, [fx.sidechainWrite(sid, { file: '/w/by-the-subagent.md' })]);

    const result = readSessionTranscript(sid);
    assert.strictEqual(result.status, 'unknown', 'the parent\'s own writes are not the whole of what the run changed');
    assert.strictEqual(result.reason, 'delegated', 'and it names where the rest of the answer went');
    assert.strictEqual(result.files, null,
      'no list: the parent\'s file alone would read as everything the run touched');
    assert.ok(result.activity, 'and the run can still say what it was last seen doing');
  });

  // The other half, so 'delegated' is a finding rather than a blanket refusal
  // to answer whenever an Agent appears. A subagent that changed nothing
  // leaves the parent's list complete, and a complete list is the answer.
  test('a subagent that changed nothing leaves the parent\'s list intact', () => {
    const sid = 'd1000000-0000-4000-8000-000000000002';
    writeTranscript(sid, [fx.prompt(sid, 'go'), fx.completed(sid, { file: '/w/parent.md' }), fx.delegate(sid)]);
    writeSidechain(sid, [fx.sidechainSay(sid, 'I read three files and reported back.')]);

    const result = readSessionTranscript(sid);
    assert.strictEqual(result.status, 'known', 'nothing was changed anywhere this reader cannot see');
    assert.deepStrictEqual(paths(result), ['/w/parent.md']);
  });

  // The delegation whose transcript is not where this reader looks. Reached by
  // a runtime that files it elsewhere, and by a subagent still running. Either
  // way the parent asked somebody else to do work and this reader has not seen
  // what came of it, so the list is not one it can vouch for.
  test('a delegation with no subagent transcript to be found is unknown too', () => {
    const sid = 'd1000000-0000-4000-8000-000000000003';
    writeTranscript(sid, [fx.prompt(sid, 'go'), fx.completed(sid, { file: '/w/parent.md' }), fx.delegate(sid)]);

    const result = readSessionTranscript(sid);
    assert.strictEqual(result.status, 'unknown', 'an unanswered delegation is not a run that only did what the parent did');
    assert.strictEqual(result.reason, 'delegated');
    assert.strictEqual(result.files, null);
  });

  // A run that delegated nothing must be unaffected, or the guard above is a
  // rule that fires on the ordinary case.
  test('a run that delegated nothing still reports its own files', () => {
    const sid = 'd1000000-0000-4000-8000-000000000004';
    writeTranscript(sid, [fx.prompt(sid, 'go'), fx.completed(sid, { file: '/w/alone.md' })]);
    assert.deepStrictEqual(paths(readSessionTranscript(sid)), ['/w/alone.md']);
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

// ---------------------------------------------------------------------------
// Drift in a format nobody here owns
// ---------------------------------------------------------------------------

describe('a format that has moved', () => {
  // THE FAILURE THESE EXIST FOR. The transcript belongs to the agent tool. If
  // it changes shape, the danger is not an error: it is a reader that carries
  // on and reports, with total confidence, that a run which rewrote the
  // workspace changed nothing. Each mutation below is a plausible drift, and
  // each must make the reader say it does not know.
  //
  // Every one starts from the SAME lines that are proved to work two
  // assertions in, so a mutation that fails to apply cannot pass as a drift
  // that was caught.
  const drifted = (sid, mutate) => {
    const lines = [
      fx.prompt(sid, 'go'),
      fx.completed(sid, { file: '/w/one.md', outcome: 'create' }),
    ];
    const before = readSessionTranscript(writeAt(sid, lines));
    assert.strictEqual(before.status, 'known', 'the unmutated lines read cleanly');
    assert.deepStrictEqual(before.files.map(f => f.path), ['/w/one.md'], 'and yield the file');
    writeTranscript(sid, lines.map(mutate));
    return readSessionTranscript(sid);
  };
  // Helper that writes and returns the id, so the pre-check above reads the
  // same transcript the mutation will replace.
  function writeAt(sid, lines) { writeTranscript(sid, lines); return sid; }

  const renameJson = (from, to) => (line) => line.split(`"${from}"`).join(`"${to}"`);

  test('a renamed block type is drift, not a run that changed nothing', () => {
    const result = drifted('b0000000-0000-4000-8000-000000000001', renameJson('tool_use', 'toolCall'));
    assert.strictEqual(result.status, 'unknown');
    assert.strictEqual(result.reason, 'unrecognized');
    assert.strictEqual(result.files, null, 'no list, rather than an empty one');
  });

  test('a renamed input field is drift', () => {
    const result = drifted('b0000000-0000-4000-8000-000000000002', renameJson('file_path', 'path'));
    assert.strictEqual(result.status, 'unknown');
    assert.strictEqual(result.reason, 'unrecognized');
    assert.strictEqual(result.files, null);
  });

  test('an outcome payload in a shape this reader has not been shown is drift', () => {
    const result = drifted('b0000000-0000-4000-8000-000000000003', renameJson('filePath', 'file'));
    assert.strictEqual(result.status, 'unknown');
    assert.strictEqual(result.reason, 'unrecognized');
    assert.strictEqual(result.files, null);
  });

  // The error marker moving is the worst of them: it turns a refused write
  // into a file the run reports having changed, which inverts the one claim
  // this whole reader exists to make.
  test('an error marker that has moved does not turn a refused write into a change', () => {
    const sid = 'b0000000-0000-4000-8000-000000000004';
    writeTranscript(sid, [
      fx.prompt(sid, 'go'),
      fx.completed(sid, { file: '/w/refused.md', outcome: 'error' }).split('"is_error":true').join('"error":true'),
    ]);
    const result = readSessionTranscript(sid);
    assert.strictEqual(result.status, 'unknown', 'a refusal it cannot recognise is not a change it may report');
    assert.strictEqual(result.files, null);
  });

  // A Write reports what it did to the file, always. One that arrives with
  // the payload an EDIT carries, or with an outcome word this reader has
  // never been shown, is a shape that has moved: it names a real path, so the
  // temptation is to list it and call it changed, and the honest answer is
  // that nobody can say whether it created or replaced anything.
  test('a write whose outcome no longer says what it did is drift', () => {
    const sid = 'b0000000-0000-4000-8000-000000000006';
    writeTranscript(sid, [
      fx.prompt(sid, 'go'),
      fx.completed(sid, { file: '/w/one.md', outcome: 'create' }).split('"type":"create",').join(''),
    ]);
    const result = readSessionTranscript(sid);
    assert.strictEqual(result.status, 'unknown', 'a write with no outcome word is not a write this reader can classify');
    assert.strictEqual(result.files, null);

    const other = 'b0000000-0000-4000-8000-000000000007';
    writeTranscript(other, [
      fx.prompt(other, 'go'),
      fx.completed(other, { file: '/w/one.md', outcome: 'create' }).split('"type":"create"').join('"type":"replaced"'),
    ]);
    const renamed = readSessionTranscript(other);
    assert.strictEqual(renamed.status, 'unknown', 'and neither is one whose outcome word has been renamed');
    assert.strictEqual(renamed.files, null);
  });

  // The marker that decides whether a write counts as a change, arriving as
  // something other than a boolean. Read for truthiness, the string "false"
  // is a refusal and the write vanishes from the list; read strictly, it is
  // not a refusal and the write is listed as though nothing had been said.
  // Both are answers this reader has no right to give.
  test('an error marker that is no longer a boolean is drift', () => {
    const sid = 'b0000000-0000-4000-8000-000000000008';
    // A write that otherwise reads as a SUCCESS, so the marker is the only
    // thing in question. Put on a refusal instead, the payload beside it is
    // an error string this reader cannot read either, and the marker would
    // never decide anything.
    writeTranscript(sid, [
      fx.prompt(sid, 'go'),
      fx.completed(sid, { file: '/w/one.md', outcome: 'create' })
        .split('"type":"tool_result"').join('"type":"tool_result","is_error":"false"'),
    ]);
    const result = readSessionTranscript(sid);
    assert.strictEqual(result.status, 'unknown', 'a marker in a shape this reader cannot judge is not judged');
    assert.strictEqual(result.reason, 'unrecognized');
    assert.strictEqual(result.files, null);
  });

  // A whole run of writes with nothing ever coming back. Reachable two ways
  // and both matter: a run cut off mid-write, and a runtime that stopped
  // writing outcomes at all.
  test('writes that never came back are unresolved rather than nothing', () => {
    const sid = 'b0000000-0000-4000-8000-000000000005';
    writeTranscript(sid, [fx.prompt(sid, 'go'), fx.unanswered(sid, { file: '/w/pending.md' })]);
    const result = readSessionTranscript(sid);
    assert.strictEqual(result.status, 'unknown');
    assert.strictEqual(result.reason, 'unresolved');
    assert.strictEqual(result.files, null);
    assert.ok(result.activity, 'and the run can still say what it is doing, which is how progress works');
  });
});

// ---------------------------------------------------------------------------
// Two outcomes in one entry
// ---------------------------------------------------------------------------

// NOT the shape the installed runtime writes, and the committed capture
// proves it: a parallel batch of writes arrives as ONE api message and the
// transcript splits it, one line per block. These pin what happens if that
// ever stops being true, because the outcome payload sits on the entry while
// the ask sits on the block, and reading the entry's payload for two blocks
// reports one file twice and loses the other.
describe('an entry carrying more than one outcome', () => {
  function twoResults(sid, { payloads, ids }) {
    const asks = ids.map((id, i) => JSON.stringify({
      type: 'assistant', sessionId: sid, timestamp: '2026-08-22T19:15:10.000Z',
      message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Write', input: { file_path: `/w/p${i}.md`, content: 'x' } }] },
    }) + '\n').join('');
    const answer = JSON.stringify({
      type: 'user', sessionId: sid, timestamp: '2026-08-22T19:15:11.000Z',
      toolUseResult: payloads,
      message: { role: 'user', content: ids.map(id => ({ type: 'tool_result', tool_use_id: id, content: 'ok' })) },
    }) + '\n';
    writeTranscript(sid, [fx.prompt(sid, 'go'), asks, answer]);
  }

  test('outcomes are matched to their own writes by the path each names', () => {
    const sid = 'c0000000-0000-4000-8000-000000000001';
    twoResults(sid, {
      ids: ['toolu_a', 'toolu_b'],
      payloads: [
        { type: 'create', filePath: '/w/p0.md' },
        { type: 'update', filePath: '/w/p1.md' },
      ],
    });
    const result = readSessionTranscript(sid);
    assert.strictEqual(result.status, 'known');
    assert.deepStrictEqual(result.files.map(f => [f.path, f.change]), [['/w/p0.md', 'created'], ['/w/p1.md', 'edited']],
      'each write gets its own outcome, rather than one file twice and the other lost');
  });

  test('outcomes that cannot be matched are not guessed at', () => {
    const sid = 'c0000000-0000-4000-8000-000000000002';
    twoResults(sid, {
      ids: ['toolu_c', 'toolu_d'],
      payloads: { type: 'create', filePath: '/w/p0.md' }, // one payload, two results
    });
    const result = readSessionTranscript(sid);
    assert.strictEqual(result.status, 'unknown', 'an outcome that cannot be attributed is not an outcome');
    assert.strictEqual(result.files, null, 'and never a file listed twice');
  });
});
