'use strict';
// Whether a run used the shell, from the reader to the record.
//
// The reader reports `usedShell: true` on a known list when the run called a
// shell tool (test/unit/session-transcript.test.js). This file holds the two
// writers to it: the ending that closes a run's record, and the startup close
// that finishes a record a dead process left open. Each is driven through a
// real run of a private scheduler with the reader swapped for a stand-in that
// answers as the reader would, the technique
// test/unit/scheduler-transcript-failure.test.js uses, so what is asserted is
// the writer's handling of the reader's answer and nothing else.
//
// THE FIELD IS ABSENT WITHOUT SHELL USE, so the record of every other run is
// key for key what it was. The key lists below are the shapes the two writers
// produce today, pinned, so a field written on every record turns this red.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { _internal: srv } = require('../../server.js');
const { makeWorkspace, standardTeam, cleanup } = require('../helpers/workspace.js');

const CLAUDE_KEY = require.resolve('../../lib/runtime/claude.js');
const TRANSCRIPT_KEY = require.resolve('../../lib/runtime/session-transcript.js');
const SCHEDULER_KEY = require.resolve('../../lib/scheduler.js');

after(cleanup);

const KNOWN = { status: 'known', reason: null, files: [{ path: '/w/notes.md', tool: 'Write', change: 'created', at: null, source: 'transcript' }], activity: null };
const WITH_SHELL = { ...KNOWN, usedShell: true };

// The closed record's keys, in the order endRunRecord writes them, for a run
// with no notice, no declared failure and no refused cards.
const CLOSED_KEYS = ['id', 'agent', 'routine', 'sessionId', 'trigger', 'status', 'startedAt', 'endedAt',
  'durationMs', 'error', 'files', 'filesStatus', 'filesReason'];

/**
 * Load a private scheduler whose reader answers `observation`, run `fn` with
 * it, and put the shared modules back however `fn` ends.
 */
function withReader(observation, workspace, fn) {
  const claude = require(CLAUDE_KEY);
  const transcript = require(TRANSCRIPT_KEY);
  const realSpawn = claude.spawnClaude;
  const realRead = transcript.readSessionTranscript;
  const cachedScheduler = require.cache[SCHEDULER_KEY];
  const prevClaudeDeps = claude.wireClaudeRuntimeDeps({ getActualPort: () => 0 });
  const seen = { child: null, reads: 0 };
  claude.spawnClaude = () => { seen.child = new EventEmitter(); return seen.child; };
  transcript.readSessionTranscript = () => { seen.reads++; return observation; };
  try {
    delete require.cache[SCHEDULER_KEY];
    const sched = require(SCHEDULER_KEY);
    delete require.cache[SCHEDULER_KEY];
    sched.wireSchedulerDeps({ getWssClients: () => [] });
    srv.setWorkspace(workspace);
    return fn(sched, seen);
  } finally {
    claude.spawnClaude = realSpawn;
    transcript.readSessionTranscript = realRead;
    claude.wireClaudeRuntimeDeps(prevClaudeDeps);
    if (cachedScheduler) require.cache[SCHEDULER_KEY] = cachedScheduler;
  }
}

function records(workspace) {
  const dir = path.join(workspace, '.rundock', 'runs');
  return fs.readdirSync(dir).filter(n => n.endsWith('.json'))
    .map(n => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf-8')));
}

/** Run one routine to its ending with the reader answering `observation`. */
function closeARun(observation) {
  const workspace = makeWorkspace({ agents: standardTeam() });
  withReader(observation, workspace, (sched, seen) => {
    assert.strictEqual(sched.executeRoutine({ id: 'runner', name: 'Runner' }, { name: 'sweep', prompt: 'p' }, 'runner:sweep'), true,
      'the run started, so there is an ending to reach');
    seen.child.emit('close', 0);
    assert.ok(seen.reads > 0, 'the ending really did ask the stand-in reader');
  });
  const [record] = records(workspace);
  assert.strictEqual(record.status, 'succeeded', 'the record was closed by the ending');
  return record;
}

/**
 * A record a dead process left open, closed by the next load with the reader
 * answering `observation`.
 */
function closeAnAbandonedRun(observation) {
  const workspace = makeWorkspace({ agents: standardTeam() });
  const dir = path.join(workspace, '.rundock', 'runs');
  const open = {
    id: 'a0000000-0000-4000-8000-000000000001', agent: 'runner', routine: 'sweep',
    sessionId: 'b0000000-0000-4000-8000-000000000001', trigger: 'scheduled', status: 'running',
    startedAt: '2026-11-01T07:00:00.000Z', endedAt: null, durationMs: null, error: null,
    files: null, filesStatus: 'unknown', filesReason: 'running',
  };
  withReader(observation, workspace, (sched, seen) => {
    // Planted after the switch to this workspace, which runs a load of its
    // own in the shared scheduler: the record is left for this one to close.
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${open.id}.json`), JSON.stringify(open));
    sched.loadRoutineState();
    assert.ok(seen.reads > 0, 'the startup close really did ask the stand-in reader');
  });
  const [record] = records(workspace);
  assert.strictEqual(record.status, 'interrupted', 'the record was closed by the startup close');
  return { open, record };
}

describe('the record says when a run used the shell', () => {
  test('a run whose reader reported the shell closes a record saying so', () => {
    const record = closeARun(WITH_SHELL);
    assert.strictEqual(record.usedShell, true);
    assert.strictEqual(record.filesStatus, 'known', 'beside the list the file tools gave, which is kept');
    assert.deepStrictEqual(record.files.map(f => f.path), ['/w/notes.md']);
  });

  test('a run whose reader reported no shell closes the record as it always was, key for key', () => {
    const record = closeARun(KNOWN);
    assert.ok(!('usedShell' in record), 'no shell field on a run that never used the shell');
    assert.deepStrictEqual(Object.keys(record), CLOSED_KEYS);
  });

  test('the startup close writes the shell field from the same reader', () => {
    const { record } = closeAnAbandonedRun(WITH_SHELL);
    assert.strictEqual(record.usedShell, true);
    assert.strictEqual(record.filesStatus, 'known');
  });

  test('the startup close of a run that never used the shell adds no field', () => {
    const { open, record } = closeAnAbandonedRun(KNOWN);
    assert.ok(!('usedShell' in record), 'no shell field on a run that never used the shell');
    assert.deepStrictEqual(Object.keys(record), Object.keys(open));
  });
});
