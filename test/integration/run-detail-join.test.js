'use strict';
// The screen finds a run, joined on what the SCHEDULER actually writes.
//
// WHY THIS FILE EXISTS, and it is a defect class rather than a scenario.
//
// The run detail screen is opened from a row on the routines list. The row
// sends the agent id the ROSTER gave it and the routine's name; the server
// matches those against `record.agent` and `record.routine`. Two writers,
// never compared: discovery decides what the roster calls an agent, and the
// scheduler decides what a record calls one.
//
// Every unit test of that join builds both sides itself, so the two
// identifiers are the same string by construction and a join on either would
// look identical. Such a test cannot fail, whatever the product does, which is
// exactly how the ordering test on this card survived until review.
//
// AND THE TWO IDENTIFIERS REALLY DO DIVERGE IN THE FIELD. An agent at order 0
// is the orchestrator, and discovery gives it the id `default` whatever its
// file is called. The owner's own workspace is one of these: the file is
// team-lead.md and the roster id is `default`. So the fixture below is an
// agent whose filename and roster id differ, the run is driven through the
// real scheduler against the real spawn harness, and the record is the one the
// scheduler wrote rather than one this file typed.
//
// WHAT THIS PROVES AND WHAT IT LEAVES TO ANOTHER FILE. This is the server half
// of the journey: asked with the id the roster carries, the handler finds the
// record. The client half, that the row sends the roster id and the routine
// name and nothing else, is pressed as markup in
// test/unit/run-detail-doors.test.js. Together they close the chain.
//
// The clock is the scheduler's own seam, so every instant here is chosen
// rather than measured.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const h = require('../helpers/harness.js');
const { agentFile } = require('../helpers/workspace.js');
const scheduler = require('../../lib/scheduler.js');
const { discoverAgents } = require('../../lib/agents/discovery.js');
const runs = require('../../lib/protocol/handlers/runs.js');

// The FILE is named this. The roster id is not, and that gap is the point.
const FILE_ID = 'team-lead';
const ROUTINE = 'Hello World';
const BODY = 'hello world routine body';

function dayAt(day, hour, minute) { return new Date(2026, 8, day, hour, minute, 0); }
const clock = { at: dayAt(1, 5, 30) };
let prevDeps = null;

before(async () => {
  await h.boot({
    agents: {
      [FILE_ID]: agentFile({
        name: FILE_ID, type: 'orchestrator', order: 0,
        routines: [{ name: ROUTINE, schedule: 'every day at 05:00', prompt: BODY }],
      }),
    },
  });
  // Matched on the prompt rather than the agent, so this rule does not itself
  // assume which identifier the spawn uses.
  h.writeScenario([{ match: { promptIncludes: BODY }, turn: [{ text: 'it ran' }] }]);
  prevDeps = scheduler.wireSchedulerDeps({ now: () => clock.at });
});

after(async () => {
  if (prevDeps) scheduler.wireSchedulerDeps(prevDeps);
  await h.shutdown();
});

/** A socket that keeps what was sent to it, parsed. */
function socket() {
  const sent = [];
  return { sent, send: (raw) => sent.push(JSON.parse(raw)) };
}

// Ticks the real scheduler. The server armed a tick at boot and a second start
// is a no-op, so the real one is stopped before the mocked one this drives.
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

test('the screen finds a record the scheduler wrote, joined on the id the roster carries', async (t) => {
  driveTicks(t);
  await h.waitUntil(() => scheduler.readRunRecords().some(r => r.status !== 'running'));

  const entry = discoverAgents().find(a => (a.routines || []).some(r => r.name === ROUTINE));
  assert.ok(entry, 'the roster carries no agent declaring this routine');

  // THE FIXTURE HAS TO ACTUALLY VARY, or this test is the one it was written
  // to replace. If the roster id and the filename were the same string, a
  // join on either would look identical and nothing here could fail.
  assert.notStrictEqual(entry.id, FILE_ID,
    'the roster id and the agent filename are the same string, so this test cannot '
    + 'discriminate the join it exists to check');

  const record = scheduler.readRunRecords().find(r => r.routine === ROUTINE);
  assert.ok(record, 'the scheduler wrote no record for this run');
  assert.strictEqual(record.agent, entry.id,
    'the scheduler names the run\'s agent with an identifier the roster does not carry, so no '
    + 'row on the routines list can ever find its own run');

  // Driven through the handler with exactly what the row holds, rather than
  // asserted about it.
  const ws = socket();
  runs.handleGetRun({}, ws, { type: 'get_run', agentId: entry.id, routine: ROUTINE });
  assert.strictEqual(ws.sent.length, 1);
  assert.ok(ws.sent[0].run, 'the screen asked with the id its row carries and found no record');
  assert.strictEqual(ws.sent[0].run.id, record.id);

  // And the filename, which is the identifier a naive join would reach for,
  // finds nothing. Stated as a case rather than left implied.
  const wrong = socket();
  runs.handleGetRun({}, wrong, { type: 'get_run', agentId: FILE_ID, routine: ROUTINE });
  assert.strictEqual(wrong.sent[0].run, null,
    'the join answers to an identifier the roster never hands out, so it is not the roster id '
    + 'that is being matched');
});
