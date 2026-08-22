'use strict';
// A finished run can say what it changed, and a running one can say what it
// is doing.
//
// THE TRAP EVERY TEST HERE IS BUILT AROUND. An empty list and an unknown list
// look identical unless something makes them different, and a list that
// happens to match the fixture the test asked for proves nothing about
// whether anything was read at all. So the runs here really do write their
// files: the stub creates them on disk, and each assertion compares the list
// a run REPORTS against what is actually in the workspace afterwards. A
// reader that returned the empty list, or the ask instead of the outcome,
// fails against the disk rather than against a fixture.
//
// Every run also attempts a write that cannot happen, in the same run as one
// that can, because the two are indistinguishable at the moment the agent
// asks. Only the outcome tells them apart, which is the property the whole
// card turns on.
//
// Setup is the scheduler-run-records template: stop the boot-armed tick, mock
// setInterval, then start, so the interval driven is the mocked one, and every
// instant comes from the scheduler's own clock seam rather than from elapsed
// time.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const h = require('../helpers/harness.js');
const { agentFile } = require('../helpers/workspace.js');

const scheduler = require('../../lib/scheduler.js');

const WRITER = 'writer:sweep';
const OTHER = 'other:sweep';
const SILENT = 'silent:sweep';
const CODEX = 'codex-writer:sweep';
const SLOW = 'slow:sweep';
const ALL = [WRITER, OTHER, SILENT, CODEX, SLOW];

function dayAt(day, hour, minute) { return new Date(2026, 9, day, hour, minute, 0); }

const clock = { at: dayAt(1, 5, 30) };
let prevDeps = null;

before(async () => {
  await h.boot({
    agents: {
      writer: agentFile({
        name: 'writer', type: 'specialist', order: 1,
        routines: [{ name: 'sweep', schedule: 'every day at 05:00', prompt: 'writer sweep' }],
      }),
      other: agentFile({
        name: 'other', type: 'specialist', order: 2,
        routines: [{ name: 'sweep', schedule: 'every day at 05:00', prompt: 'other sweep' }],
      }),
      // A run whose transcript never appears: the agent tool wrote it
      // somewhere else, pruned it, or never got that far.
      silent: agentFile({
        name: 'silent', type: 'specialist', order: 3,
        routines: [{ name: 'sweep', schedule: 'every day at 05:00', prompt: 'silent sweep' }],
      }),
      // The other runtime, which keeps no session transcript at all.
      'codex-writer': agentFile({
        name: 'codex-writer', type: 'specialist', order: 4, runtime: 'codex',
        routines: [{ name: 'sweep', schedule: 'every day at 05:00', prompt: 'codex sweep' }],
      }),
      slow: agentFile({
        name: 'slow', type: 'specialist', order: 5,
        routines: [{ name: 'sweep', schedule: 'every day at 05:00', prompt: 'slow sweep' }],
      }),
    },
  });
  h.writeScenario([
    {
      match: { agent: 'writer' },
      writes: [
        { file: 'made-by-writer.md', outcome: 'create' },
        { file: 'kept-by-writer.md', outcome: 'update' },
        { file: 'refused-for-writer.md', outcome: 'error' },
      ],
      turn: [{ text: 'writer done' }],
    },
    {
      match: { agent: 'other' },
      writes: [{ file: 'made-by-other.md', outcome: 'create' }],
      turn: [{ text: 'other done' }],
    },
    // Runs, writes a file, and leaves no transcript behind.
    {
      match: { agent: 'silent' },
      skipTranscript: true,
      writes: [{ file: 'made-by-silent.md', outcome: 'create' }],
      turn: [{ text: 'silent done' }],
    },
    // Held open past the synchronous tick, so its transcript can be read
    // while the run is still going.
    {
      match: { agent: 'slow' },
      delayMs: 400,
      writes: [{ file: 'made-by-slow.md', outcome: 'create' }],
      turn: [{ text: 'slow done' }],
    },
  ]);
  h.writeCodexScenario([]);
  prevDeps = scheduler.wireSchedulerDeps({ now: () => clock.at });
});

after(async () => {
  if (prevDeps) scheduler.wireSchedulerDeps(prevDeps);
  await h.shutdown();
});

function runsDir() { return path.join(h.workspaceDir, '.rundock', 'runs'); }
function wipeRuns() { fs.rmSync(runsDir(), { recursive: true, force: true }); }
function recordsFor(agentId) { return scheduler.readRunRecords().filter(r => r.agent === agentId); }

function quieten(day, live) {
  for (const key of ALL) {
    if (live.includes(key)) continue;
    h.internal.routineState[key] = { lastRun: dayAt(day, 23, 0).toISOString(), status: 'completed', duration: 1 };
  }
}

function begin(day, live, hour = 5, minute = 30) {
  wipeRuns();
  h.clearInvocations();
  clock.at = dayAt(day, hour, minute);
  for (const key of live) delete h.internal.routineState[key];
  quieten(day, live);
}

function driveTicks(t, count = 1) {
  const real = { log: console.log, error: console.error };
  h.internal.stopScheduler();
  t.mock.timers.enable({ apis: ['setInterval'] });
  console.log = () => {};
  console.error = () => {};
  try {
    h.internal.startScheduler();
    for (let i = 0; i < count; i++) t.mock.timers.tick(60_000);
  } finally {
    console.log = real.log;
    console.error = real.error;
    h.internal.stopScheduler();
    t.mock.timers.reset();
  }
}

function settled(key) {
  return h.waitUntil(() => {
    const s = h.internal.routineState[key];
    return s && s.status !== 'running';
  });
}

// The workspace as the CHILD sees it. A run resolves its own paths against
// its working directory, and on macOS the temp directory reaches it through a
// symlink, so the run reports /private/... where the harness holds /tmp/...
// Comparing the two without resolving would fail on a difference that has
// nothing to do with what was changed.
const inWorkspace = (name) => path.join(fs.realpathSync(h.workspaceDir), name);
const listed = (record) => (record.files || []).map(f => f.path);

// ---------------------------------------------------------------------------
// What a finished run says it changed
// ---------------------------------------------------------------------------

// AC-4, AC-5, AC-6, AC-22, AC-23 and AC-24 in one run, because the criterion
// is about telling three files apart within a single run rather than about
// three separate runs.
//
// The assertions are made against the WORKSPACE, not against the scenario:
// two files exist afterwards and one does not, and the run's list is required
// to be exactly the two that exist. A reader that ignored the outcome would
// list a file this test proves is not there.
test('a finished run lists the files it changed, and not the one it could not', async (t) => {
  begin(1, [WRITER]);

  driveTicks(t);
  clock.at = dayAt(1, 5, 32);
  assert.ok(await settled(WRITER), 'the run finished');

  const created = inWorkspace('made-by-writer.md');
  const updated = inWorkspace('kept-by-writer.md');
  const refused = inWorkspace('refused-for-writer.md');
  assert.ok(fs.existsSync(created), 'the run really created a file');
  assert.ok(fs.existsSync(updated), 'and really wrote over another');
  assert.ok(!fs.existsSync(refused), 'and really failed to write the third');

  const [record] = recordsFor('writer');
  assert.ok(record, 'the run left a record');
  assert.strictEqual(record.filesStatus, 'known', 'the run can account for what it changed');
  assert.strictEqual(record.filesReason, null, 'with nothing standing in the way');
  assert.deepStrictEqual(listed(record).sort(), [created, updated].sort(),
    'the files it reports are the files that are actually there, and not the one that is not');
  assert.ok(!listed(record).includes(refused),
    'a write it attempted and did not make is not a file it changed');

  const byPath = new Map(record.files.map(f => [f.path, f]));
  assert.strictEqual(byPath.get(created).change, 'created', 'a file that was not there is a creation');
  assert.strictEqual(byPath.get(updated).change, 'edited', 'a file that was is an edit');
  assert.strictEqual(byPath.get(created).source, 'transcript', 'and each entry says where it was learned');
  assert.strictEqual(byPath.get(created).tool, 'Write', 'and which tool did it');
  assert.ok(byPath.get(created).at, 'and when');
});

// AC-1 and AC-2, at the level where the identification actually happens. Two
// runs on the SAME tick, each writing a different file, and the second one
// finishes last so "the most recent transcript" would answer both records
// with the second run's file.
test('two runs on one pass each report their own files', async (t) => {
  begin(2, [WRITER, OTHER]);

  driveTicks(t);
  clock.at = dayAt(2, 5, 33);
  assert.ok(await settled(WRITER), 'the first run finished');
  assert.ok(await settled(OTHER), 'the second run finished');

  const [writer] = recordsFor('writer');
  const [other] = recordsFor('other');
  assert.deepStrictEqual(listed(other), [inWorkspace('made-by-other.md')],
    'the second run reports its own file');
  assert.ok(!listed(writer).includes(inWorkspace('made-by-other.md')),
    'and the first run does not inherit it');
  assert.ok(listed(writer).includes(inWorkspace('made-by-writer.md')),
    'while still reporting what it changed itself');

  // The identification, read from the spawn the run really made: the session
  // the child was told to be is the run's own id, which is what names the
  // transcript. Nothing here depends on when anything happened.
  const spawns = h.readInvocations().filter(i => Array.isArray(i.argv) && i.argv.includes('--session-id'));
  const sessions = new Map(spawns.map(i => [i.argv[i.argv.indexOf('--session-id') + 1], i.argv[i.argv.indexOf('--agent') + 1]]));
  assert.strictEqual(sessions.get(writer.sessionId), 'writer',
    'the session the first run states in its record is the session its child was told to be');
  assert.strictEqual(sessions.get(other.sessionId), 'other', 'and the same holds for the second');
  assert.notStrictEqual(writer.sessionId, other.sessionId, 'so the two transcripts cannot be the same file');
});

// AC-3, AC-7 and AC-25. The run wrote a file, so a reader that reported
// "changed nothing" would be wrong about the workspace as well as about the
// run. Unknown is a different answer and has to survive as one.
test('a run whose transcript is missing is unknown, not a run that changed nothing', async (t) => {
  begin(3, [SILENT]);

  driveTicks(t);
  clock.at = dayAt(3, 5, 34);
  assert.ok(await settled(SILENT), 'the run finished');
  assert.ok(fs.existsSync(inWorkspace('made-by-silent.md')),
    'the run did change a file, so "nothing" would be a false answer as well as an unfounded one');

  const [record] = recordsFor('silent');
  assert.strictEqual(record.status, 'succeeded', 'the run itself succeeded');
  assert.strictEqual(record.filesStatus, 'unknown', 'but what it changed cannot be established');
  assert.strictEqual(record.filesReason, 'no-transcript', 'and the record says which way it failed');
  assert.strictEqual(record.files, null,
    'with no list at all, so nothing downstream can read this as a run that changed nothing');
});

// The second runtime has no session transcript to read, and says so with its
// own reason rather than looking like a run whose file went missing.
test('a run on a runtime with no transcript says so in its own terms', async (t) => {
  begin(4, [CODEX]);

  driveTicks(t);
  clock.at = dayAt(4, 5, 35);
  assert.ok(await settled(CODEX), 'the run finished');

  const [record] = recordsFor('codex-writer');
  assert.strictEqual(record.filesStatus, 'unknown');
  assert.strictEqual(record.filesReason, 'no-session', 'no session was ever opened, which is not a missing file');
  assert.strictEqual(record.files, null);
});

// ---------------------------------------------------------------------------
// Progress while it runs
// ---------------------------------------------------------------------------

// AC-8 and AC-9. Read WHILE the child is alive, from the transcript, by
// asking. Nothing here registers for a filesystem event, and nothing waits
// for elapsed time: the tick is driven through the clock seam and the run is
// still in flight when the question is asked.
test('a running routine can be asked what it is doing', async (t) => {
  begin(5, [SLOW]);

  driveTicks(t);
  const [open] = recordsFor('slow');
  assert.strictEqual(open.status, 'running', 'the run is still going');
  assert.strictEqual(open.filesStatus, 'unknown', 'so what it changed is not settled yet');
  assert.strictEqual(open.filesReason, 'running', 'and the reason is that it has not finished');

  let progress = null;
  const answered = await h.waitUntil(() => {
    progress = scheduler.readRunProgress(open.id);
    return progress.status === 'known';
  });
  assert.ok(answered, 'the run in flight answered');
  assert.ok(progress.activity, 'with something it is doing');
  assert.strictEqual(progress.activity.kind, 'tool', 'which is the tool it is on');
  assert.strictEqual(progress.activity.path, inWorkspace('made-by-slow.md'), 'and the file that tool is touching');

  clock.at = dayAt(5, 5, 36);
  assert.ok(await settled(SLOW), 'the run finished');
  assert.deepStrictEqual(listed(recordsFor('slow')[0]), [inWorkspace('made-by-slow.md')],
    'and the finished record lists what it changed');
});

test('progress for a run nobody has a record of is unknown rather than invented', () => {
  const progress = scheduler.readRunProgress('no-such-run-id');
  assert.strictEqual(progress.status, 'unknown');
  assert.strictEqual(progress.reason, 'no-record');
  assert.strictEqual(progress.activity, null);
});

// ---------------------------------------------------------------------------
// Separation, which prior cards paid for
// ---------------------------------------------------------------------------

// AC-12, AC-13 and AC-14. routineState is the ONLY input to double-fire
// suppression. This change writes a session id, a file list and a status, and
// none of them may reach it.
//
// The first assertion is what stops this passing vacuously: a run that
// reported no files at all would satisfy every negative assertion below.
test('nothing this change writes reaches the value double-fire suppression reads', async (t) => {
  begin(6, [WRITER]);

  driveTicks(t);
  clock.at = dayAt(6, 5, 45);
  assert.ok(await settled(WRITER), 'the run finished');

  const [record] = recordsFor('writer');
  assert.ok(record.files.length > 0, 'the run really did report files, so this test has something to leak');

  assert.deepStrictEqual(Object.keys(h.internal.routineState[WRITER]).sort(), ['duration', 'lastRun', 'status'],
    'the routine state kept its shape: no session id, no file list, nothing new');
  assert.strictEqual(h.internal.routineState[WRITER].lastRun, dayAt(6, 5, 45).toISOString(),
    'and its stamp is the one the run wrote when it ended');
  assert.notStrictEqual(h.internal.routineState[WRITER].lastRun, record.startedAt,
    'so a record field reaching the suppression stamp would move it, visibly');

  // The consequence: the routine is still held for the rest of its period.
  driveTicks(t);
  assert.strictEqual(recordsFor('writer').length, 1, 'the same day started no second run');
});

// AC-13. The hold is released by the run's outcome, and reading a transcript
// happens inside that same handler. A read that threw would release nothing.
test('the single-flight hold still releases after a run that reports files', async (t) => {
  begin(7, [WRITER]);

  driveTicks(t);
  clock.at = dayAt(7, 5, 40);
  assert.ok(await settled(WRITER), 'the run finished');

  // A new day, so the routine is due again. If the hold had survived, this
  // pass would find it in flight and start nothing.
  begin(8, [WRITER]);
  driveTicks(t);
  assert.strictEqual(recordsFor('writer').length, 1, 'the next day started a run, so nothing stayed held');
  clock.at = dayAt(8, 5, 40);
  assert.ok(await settled(WRITER), 'and it finished too');
});
