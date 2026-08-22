'use strict';
// What happens to a run when reading its transcript goes wrong.
//
// WHY THIS IS ITS OWN FILE. Reading the transcript is a NEW fallible call, and
// of all the places it could have gone, it went inside the handler that ends a
// run: the one frame whose comments say, at length, that nothing raised here
// may escape. Everything downstream of that handler is what releases the
// routine. A throw there means the outcome is never recorded, the single-flight
// hold is never released, and the routine never runs again for the life of the
// process, which is precisely the fault the deadlock card was written to end.
//
// Reachability is weak: the reader catches its own filesystem errors and every
// other line in it is pure. That is a reason to expect this to hold, not a
// reason to leave it unproven. This file's own history is the argument:
// structurally-safe-but-unproven has been wrong here before, and a requirement
// stated in a comment and pinned nowhere is a comment.
//
// The technique is the one test/unit/doc-claims.test.js uses for the same
// module: swap the dependency's export, load a private copy of the scheduler
// so it closes over the stand-in, and put the shared instance back before
// anything else in the suite can see it.
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

/**
 * Run one routine to completion with the transcript reader throwing, and hand
 * back everything a caller would need to see the run through: the private
 * scheduler, the child it spawned, and where its records went.
 */
function runWithAThrowingReader(workspace) {
  const claude = require(CLAUDE_KEY);
  const transcript = require(TRANSCRIPT_KEY);
  const realSpawn = claude.spawnClaude;
  const realRead = transcript.readSessionTranscript;
  const cachedScheduler = require.cache[SCHEDULER_KEY];
  const prevClaudeDeps = claude.wireClaudeRuntimeDeps({ getActualPort: () => 0 });

  let child = null;
  let reads = 0;
  claude.spawnClaude = () => { child = new EventEmitter(); return child; };
  transcript.readSessionTranscript = () => { reads++; throw new Error('transcript reader exploded'); };

  let sched;
  try {
    delete require.cache[SCHEDULER_KEY];
    sched = require(SCHEDULER_KEY);
    delete require.cache[SCHEDULER_KEY];
    sched.wireSchedulerDeps({ getWssClients: () => [] });
    srv.setWorkspace(workspace);

    const started = sched.executeRoutine({ id: 'runner', name: 'Runner' }, { name: 'sweep', prompt: 'p' }, 'runner:sweep');
    assert.strictEqual(started, true, 'the run started, so there is an ending to reach');
    assert.ok(child, 'and a child to end it');
    child.emit('close', 0);
  } finally {
    claude.spawnClaude = realSpawn;
    transcript.readSessionTranscript = realRead;
    claude.wireClaudeRuntimeDeps(prevClaudeDeps);
    if (cachedScheduler) require.cache[SCHEDULER_KEY] = cachedScheduler;
  }
  return { sched, reads };
}

describe('a transcript reader that throws', () => {
  test('does not stop the run being recorded, and does not hold the routine forever', () => {
    const workspace = makeWorkspace({ agents: standardTeam() });
    const { sched, reads } = runWithAThrowingReader(workspace);

    // THE SETUP, ASSERTED BEFORE ANYTHING IS CONCLUDED FROM IT. A stand-in
    // that was never reached would make every assertion below pass against a
    // build with no reader in it at all.
    assert.ok(reads > 0, 'the ending really did reach the reader that throws');

    const records = fs.readdirSync(path.join(workspace, '.rundock', 'runs'))
      .map(name => JSON.parse(fs.readFileSync(path.join(workspace, '.rundock', 'runs', name), 'utf-8')));
    assert.strictEqual(records.length, 1, 'the run left one record');
    assert.strictEqual(records[0].status, 'succeeded',
      'closed with the outcome the run really had, rather than abandoned at running by the throw');
    assert.strictEqual(records[0].filesStatus, 'unknown', 'what it changed could not be established');
    assert.strictEqual(records[0].files, null, 'and no list was invented for it');
    assert.ok(records[0].endedAt, 'the ending was written');

    // The hold, which is the part that would cost the user a routine that
    // never runs again. A second start proves it: refused while held, allowed
    // once released.
    const again = sched.executeRoutine({ id: 'runner', name: 'Runner' }, { name: 'sweep', prompt: 'p' }, 'runner:sweep');
    assert.strictEqual(again, true, 'the routine is free to run again, so nothing stayed held');
  });
});
