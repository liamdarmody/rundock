'use strict';
// A routine that runs once a month.
//
// Its period is the calendar month: a slot is caught up any time Rundock is
// open later in the same month, and recorded as missed once the month ends
// without it. That makes the period thirty times longer than a daily one, so
// every question a reader asks of a period is asked here with real runs: does
// the routine fire once, through ticks, a restart and a workspace switch; does
// it catch up within the month and only then; and is a slot that was never
// owed (passed before the routine existed, while it was held, or before its
// plan was approved) left alone by the tick AND by the row, so the two agree.
//
// Setup is the scheduler-missed-slots template: stop the boot-armed tick, mock
// setInterval, start, and move the scheduler's own clock between ticks. Every
// instant is a fixed local time under an explicit zone.
process.env.TZ = 'Europe/London';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const h = require('../helpers/harness.js');
const { agentFile, makeWorkspace } = require('../helpers/workspace.js');

const scheduler = require('../../lib/scheduler.js');
const config = require('../../lib/config.js');
const { invalidateAgentCache, discoverAgents } = require('../../lib/agents/discovery.js');
const approvalStore = require('../../lib/agents/approval-store.js');
const { computePlanHash } = require('../../lib/agents/routines.js');
const editorModel = require('../../public/routine-editor-model.js');

// Built rather than written, so the byte that makes the thrower's start throw
// is visible in the source.
const NUL = String.fromCharCode(0);

// One routine per agent. The plans never change, so the approvals the fixture
// is booted with keep holding: each test rewrites the files to say which one is
// live and when, and the schedule, `enabled` and `paused` are outside the plan.
const ROUTINES = {
  ledger: { name: 'report', prompt: 'ledger report body' },
  // Its child crashes.
  breaker: { name: 'report', prompt: 'breaker report body' },
  // Its start throws: the prompt reaches spawn as an argument Node refuses.
  thrower: { name: 'report', prompt: `thrower${NUL}body` },
};
const KEYS = { ledger: 'ledger:report', breaker: 'breaker:report', thrower: 'thrower:report' };
const QUIET = 'on day 1 of every month at 00:00';
const DAY_15 = 'on day 15 of every month at 09:00';

// 2026, local components.
const at = (month, day, hour = 0, minute = 0) => new Date(2026, month - 1, day, hour, minute, 0);
const iso = (d) => d.toISOString();

const clock = { at: at(1, 1) };
let prevDeps = null;

function fileFor(slug, schedule, fields = {}) {
  const r = ROUTINES[slug];
  return agentFile({
    name: slug, type: 'specialist', order: Object.keys(ROUTINES).indexOf(slug) + 1,
    routines: [{ name: r.name, schedule, prompt: r.prompt, enabled: true, ...fields }],
  });
}

before(async () => {
  await h.boot({
    agents: Object.fromEntries(Object.keys(ROUTINES).map(slug => [slug, fileFor(slug, QUIET)])),
  });
  h.writeScenario([
    { match: { agent: 'ledger', promptIncludes: ROUTINES.ledger.prompt }, turn: [{ text: 'ledger ran' }] },
    { match: { agent: 'breaker', promptIncludes: ROUTINES.breaker.prompt }, crash: 1 },
  ]);
  prevDeps = scheduler.wireSchedulerDeps({ now: () => clock.at });
});

after(async () => {
  if (prevDeps) scheduler.wireSchedulerDeps(prevDeps);
  await h.shutdown();
});

/** Make `live` the one routine in service, on `schedule`, with `fields`. */
function write(live, schedule, fields = {}) {
  for (const slug of Object.keys(ROUTINES)) {
    const content = slug === live ? fileFor(slug, schedule, fields) : fileFor(slug, QUIET, { enabled: false });
    fs.writeFileSync(path.join(h.workspaceDir, '.claude', 'agents', `${slug}.md`), content);
  }
  invalidateAgentCache();
}

// Everything the scheduler remembers, on disk and in memory, dropped so each
// test starts from a machine that has never seen these routines.
function resetTimeline() {
  h.internal.stopScheduler();
  for (const key of Object.values(KEYS)) delete h.internal.routineState[key];
  h.internal.routineSlots.observedAt = null;
  for (const k of Object.keys(h.internal.routineSlots.routines)) delete h.internal.routineSlots.routines[k];
  for (const file of ['routine-state.json', 'routine-slots.json']) {
    fs.rmSync(path.join(h.workspaceDir, '.rundock', file), { force: true });
  }
  fs.rmSync(path.join(h.workspaceDir, '.rundock', 'runs'), { recursive: true, force: true });
  h.clearPrompts();
}

const runs = (slug) => h.promptsFor(slug).filter(p => p.includes(ROUTINES[slug].prompt)).length;
const entry = (slug) => h.internal.routineSlots.routines[KEYS[slug]];
const missed = (slug) => (entry(slug) ? entry(slug).missed.map(m => m.slot) : []);
const recordsFor = (slug) => scheduler.readRunRecords().filter(r => r.agent === slug);

/** What the row is told: the routine as the roster carries it. */
function row(slug) {
  invalidateAgentCache();
  const agent = discoverAgents().find(a => a.id === slug);
  return agent.routines[0];
}

/** One tick at `when`, and wait for any run it started to reach its outcome. */
async function tickAt(t, when) {
  clock.at = when;
  t.mock.timers.tick(60_000);
  await h.waitUntil(() => scheduler.runningRuns().length === 0
    && Object.values(KEYS).every(k => !h.internal.routineState[k] || h.internal.routineState[k].status !== 'running'));
}

async function withTicks(t, fn) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  try {
    h.internal.startScheduler();
    await fn();
  } finally {
    h.internal.stopScheduler();
    t.mock.timers.reset();
  }
}

// ===== ONCE A MONTH =====

test('a monthly routine fires once at its slot, and not again that month through ticks, a restart and a switch', async (t) => {
  resetTimeline();
  write('ledger', DAY_15);
  await withTicks(t, async () => {
    await tickAt(t, at(10, 1, 8));
    assert.strictEqual(runs('ledger'), 0, 'the slot is two weeks ahead');

    await tickAt(t, at(10, 15, 9, 0));
    assert.strictEqual(runs('ledger'), 1, 'it fired at its slot');

    for (const when of [at(10, 15, 9, 1), at(10, 15, 23, 59), at(10, 16, 9), at(10, 20, 12)]) await tickAt(t, when);
    assert.strictEqual(runs('ledger'), 1, 'later ticks in the month leave it alone');

    // A restart: both stores read back from the workspace's files.
    h.internal.stopScheduler();
    h.internal.loadRoutineState();
    h.internal.startScheduler();
    await tickAt(t, at(10, 25, 9));
    assert.strictEqual(runs('ledger'), 1, 'a restart does not fire it again');

    // A switch to another workspace and back, through the server's own path.
    h.internal.setWorkspace(makeWorkspace({ agents: {} }));
    await tickAt(t, at(10, 27, 9));
    h.internal.setWorkspace(h.workspaceDir);
    await tickAt(t, at(10, 31, 23, 59));
    assert.strictEqual(runs('ledger'), 1, 'one run in October');
    assert.deepStrictEqual(missed('ledger'), [], 'and nothing recorded as missed');

    await tickAt(t, at(11, 15, 9, 0));
    assert.strictEqual(runs('ledger'), 2, "November's slot fires in November");
  });
});

// ===== CATCH-UP WITHIN THE MONTH, OR A RECORD =====

test('closed from the 14th to the 20th, a 15th slot runs once on the 20th', async (t) => {
  resetTimeline();
  write('ledger', DAY_15);
  await withTicks(t, async () => {
    await tickAt(t, at(10, 1, 8));
    await tickAt(t, at(10, 14, 8));
    await tickAt(t, at(10, 20, 10));
    assert.strictEqual(runs('ledger'), 1, 'caught up at the first tick back in the month');
    assert.deepStrictEqual(missed('ledger'), [], 'and so not recorded as missed');
    const [record] = recordsFor('ledger');
    assert.strictEqual(record.dueAt, iso(at(10, 15, 9)), 'its record says when it was due');
    assert.strictEqual(record.startedAt, iso(at(10, 20, 10)), 'and when it ran');

    await tickAt(t, at(10, 20, 10, 1));
    await tickAt(t, at(10, 31, 12));
    assert.strictEqual(runs('ledger'), 1, 'once, not once a tick');
  });
});

test('closed from 14 October to 2 November, the October slot is recorded and never run', async (t) => {
  resetTimeline();
  write('ledger', DAY_15);
  await withTicks(t, async () => {
    await tickAt(t, at(10, 1, 8));
    await tickAt(t, at(10, 14, 8));
    await tickAt(t, at(11, 2, 10));
    assert.strictEqual(runs('ledger'), 0, 'the month ended first, so there is nothing to catch up');
    assert.deepStrictEqual(missed('ledger'), [iso(at(10, 15, 9))], 'one record, for 15 October');
  });
});

test('closed from 14 August to 2 November, three slots are recorded and none run', async (t) => {
  resetTimeline();
  write('ledger', DAY_15);
  await withTicks(t, async () => {
    await tickAt(t, at(8, 1, 8));
    await tickAt(t, at(8, 14, 8));
    await tickAt(t, at(11, 2, 10));
    assert.strictEqual(runs('ledger'), 0, 'three months closed produce no runs');
    assert.deepStrictEqual(missed('ledger'), [iso(at(8, 15, 9)), iso(at(9, 15, 9)), iso(at(10, 15, 9))],
      'and one record for each month');
  });
});

test('a last-day slot at 18:00 is caught up on the 30th at 21:00, and missed by 1 December', async (t) => {
  resetTimeline();
  write('ledger', 'on the last day of every month at 18:00');
  await withTicks(t, async () => {
    await tickAt(t, at(11, 1, 8));
    await tickAt(t, at(11, 29, 8));
    await tickAt(t, at(11, 30, 21));
    assert.strictEqual(runs('ledger'), 1, 'opened on the last day after its slot, it runs');
    assert.deepStrictEqual(missed('ledger'), []);
  });

  resetTimeline();
  write('ledger', 'on the last day of every month at 18:00');
  await withTicks(t, async () => {
    await tickAt(t, at(11, 1, 8));
    await tickAt(t, at(11, 29, 8));
    await tickAt(t, at(12, 1, 9));
    assert.strictEqual(runs('ledger'), 0, 'opened the next morning, the month has ended');
    assert.deepStrictEqual(missed('ledger'), [iso(at(11, 30, 18))], 'and 30 November is recorded');
  });
});

// ===== A SLOT THAT WAS NEVER OWED =====
// Each case asserts both readers: the tick does not fire this month's slot, and
// the row names next month's.

test('a slot that passed before the routine was first seen is not owed', async (t) => {
  resetTimeline();
  write('ledger', DAY_15);
  await withTicks(t, async () => {
    await tickAt(t, at(10, 20, 10));
    await tickAt(t, at(10, 21, 10));
    assert.strictEqual(runs('ledger'), 0, 'made on the 20th, it did not exist on the 15th');
    assert.strictEqual(row('ledger').nextRun, iso(at(11, 15, 9)), "and the row names November's slot");
  });
});

test('a slot that passed while the routine was paused is not owed once it resumes', async (t) => {
  resetTimeline();
  write('ledger', DAY_15);
  await withTicks(t, async () => {
    await tickAt(t, at(10, 1, 8));
    write('ledger', DAY_15, { paused: true });
    await tickAt(t, at(10, 14, 8));
    await tickAt(t, at(10, 15, 10));
    write('ledger', DAY_15);
    await tickAt(t, at(10, 16, 8));
    await tickAt(t, at(10, 20, 8));
    assert.strictEqual(runs('ledger'), 0, 'resumed after its slot, it waits for the next one');
    assert.strictEqual(row('ledger').nextRun, iso(at(11, 15, 9)), "and the row names November's slot");
  });
});

test('a slot that passed while the routine was switched off is not owed once it is turned on', async (t) => {
  resetTimeline();
  write('ledger', DAY_15, { enabled: false });
  await withTicks(t, async () => {
    await tickAt(t, at(10, 1, 8));
    await tickAt(t, at(10, 15, 10));
    assert.strictEqual(row('ledger').nextRun, iso(at(11, 15, 9)),
      "while it is off, the offer to turn it on names November's slot");
    write('ledger', DAY_15);
    await tickAt(t, at(10, 16, 8));
    assert.strictEqual(runs('ledger'), 0, 'turned on after its slot, it waits for the next one');
    assert.strictEqual(row('ledger').nextRun, iso(at(11, 15, 9)), "and the row names November's slot");
  });
});

// A HOLD WAIVES ONLY THE SLOTS AT OR BEFORE IT. The two tests above end the
// hold after the slot, which a rule that waived the slot for any recorded hold
// would pass too, and that rule cancels the month's run for a routine paused
// for a week before its day, and every later month's with it. So the hold ends
// here before the slot, with Rundock open throughout, and once after October's
// slot with November's still to come.
for (const [how, held] of [['paused', { paused: true }], ['switched off', { enabled: false }]]) {
  test(`a monthly routine ${how} and back before its slot runs once at the slot`, async (t) => {
    resetTimeline();
    write('ledger', DAY_15);
    await withTicks(t, async () => {
      await tickAt(t, at(10, 1, 8));
      write('ledger', DAY_15, held);
      await tickAt(t, at(10, 3, 8));
      await tickAt(t, at(10, 7, 8));
      write('ledger', DAY_15);
      await tickAt(t, at(10, 10, 8));
      assert.strictEqual(row('ledger').nextRun, iso(at(10, 15, 9)), "back before its slot, the row names this month's");
      await tickAt(t, at(10, 14, 23, 59));
      assert.strictEqual(runs('ledger'), 0, 'not before its slot');

      await tickAt(t, at(10, 15, 9, 0));
      assert.strictEqual(runs('ledger'), 1, 'it runs at the slot');
      await tickAt(t, at(10, 15, 9, 1));
      await tickAt(t, at(10, 31, 23, 59));
      assert.strictEqual(runs('ledger'), 1, 'exactly once that month');
      assert.deepStrictEqual(missed('ledger'), []);
    });
  });
}

test("a monthly routine held through October's slot runs at November's", async (t) => {
  resetTimeline();
  write('ledger', DAY_15);
  await withTicks(t, async () => {
    await tickAt(t, at(10, 1, 8));
    write('ledger', DAY_15, { paused: true });
    await tickAt(t, at(10, 14, 8));
    await tickAt(t, at(10, 15, 10));
    write('ledger', DAY_15);
    await tickAt(t, at(10, 16, 8));
    await tickAt(t, at(10, 31, 23, 59));
    assert.strictEqual(runs('ledger'), 0, "October's slot passed while it was held");

    await tickAt(t, at(11, 14, 8));
    assert.strictEqual(row('ledger').nextRun, iso(at(11, 15, 9)), "the row names November's slot");
    await tickAt(t, at(11, 15, 9, 0));
    assert.strictEqual(runs('ledger'), 1, "and November's slot fires: the October hold does not reach it");
  });
});

test('a slot that passed before the plan was approved is not owed', async (t) => {
  resetTimeline();
  write('ledger', DAY_15);
  const routine = row('ledger');
  const identity = approvalStore.identityOf(routine);
  const hash = computePlanHash(routine);
  try {
    await withTicks(t, async () => {
      await tickAt(t, at(10, 1, 8));
      await tickAt(t, at(10, 15, 8));
      approvalStore.recordApproval(config.getWorkspace(), identity, hash, iso(at(10, 16, 12)));
      await tickAt(t, at(10, 16, 13));
      await tickAt(t, at(10, 20, 13));
      assert.strictEqual(runs('ledger'), 0, 'approved after its slot, it waits for the next one');
      assert.strictEqual(row('ledger').nextRun, iso(at(11, 15, 9)),
        "and the row reads the approval's moment, as the tick does, and names November's slot");
    });
  } finally {
    approvalStore.recordApproval(config.getWorkspace(), identity, hash, null);
  }
});

// ===== THE FIVE SEQUENCES, ON THE SERVER =====

// The inverse action: monthly back to daily through Edit schedule's own save.
test('a monthly routine changed back to daily saves the daily words, resyncs, and runs every day', async (t) => {
  resetTimeline();
  write('ledger', DAY_15);
  await withTicks(t, async () => {
    await tickAt(t, at(10, 1, 8));
    await tickAt(t, at(10, 15, 9));
    assert.strictEqual(runs('ledger'), 1);

    const client = await h.connect();
    try {
      client.send({ type: 'set_routine_schedule', agentId: 'ledger', name: 'report', occurrence: 0, schedule: 'every day at 09:00' });
      await client.waitFor(m => m.type === 'routine_rescheduled', { label: 'routine_rescheduled' });
    } finally { client.close(); }
    const saved = row('ledger').schedule;
    assert.strictEqual(saved, 'every day at 09:00', 'the file says the daily words');
    assert.deepStrictEqual(editorModel.readSchedule(saved), { frequency: 'day', time: '09:00' }, 'and reopens as daily');

    await tickAt(t, at(10, 15, 10));
    assert.strictEqual(entry('ledger').schedule, 'daily:9:0', 'the anchor resynced to the daily shape');
    assert.deepStrictEqual(missed('ledger'), [], 'with no missed record invented');
    assert.strictEqual(runs('ledger'), 1, "today's 09:00 was already served by the run at 09:00");

    await tickAt(t, at(10, 16, 9));
    await tickAt(t, at(10, 17, 9));
    assert.strictEqual(runs('ledger'), 3, 'and it fires on the daily rule');
    assert.deepStrictEqual(missed('ledger'), []);
  });
});

// The retry: a failed run, and a start that throws, are not retried that month.
test('a monthly run whose child fails is not run again that month', async (t) => {
  resetTimeline();
  write('breaker', DAY_15);
  await withTicks(t, async () => {
    await tickAt(t, at(10, 1, 8));
    await tickAt(t, at(10, 15, 9));
    assert.strictEqual(runs('breaker'), 1);
    assert.strictEqual(h.internal.routineState[KEYS.breaker].status, 'failed', 'the run failed');
    await tickAt(t, at(10, 15, 9, 1));
    await tickAt(t, at(10, 22, 9));
    assert.strictEqual(runs('breaker'), 1, 'and the tick did not retry it');
    await tickAt(t, at(11, 15, 9));
    assert.strictEqual(runs('breaker'), 2, 'next month it is attempted again');
  });
});

test('a monthly routine whose start throws is attempted once that month', async (t) => {
  resetTimeline();
  write('thrower', DAY_15);
  await withTicks(t, async () => {
    await tickAt(t, at(10, 1, 8));
    await tickAt(t, at(10, 15, 9));
    assert.strictEqual(h.internal.routineState[KEYS.thrower].status, 'failed', 'the start threw and was recorded');
    await tickAt(t, at(10, 15, 9, 1));
    await tickAt(t, at(10, 22, 9));
    assert.strictEqual(recordsFor('thrower').length, 1, 'one attempt, held by the floor the failed start stamped');
  });
});

test('a pressed run of a monthly routine moves nothing', async (t) => {
  resetTimeline();
  write('ledger', DAY_15);
  await withTicks(t, async () => {
    await tickAt(t, at(10, 1, 8));
    assert.strictEqual(row('ledger').nextRun, iso(at(10, 15, 9)));
    const slotsBefore = JSON.stringify(h.internal.routineSlots);

    clock.at = at(10, 3, 14);
    const agent = discoverAgents().find(a => a.id === 'ledger');
    const pressed = scheduler.runRoutineNow(agent, agent.routines[0], KEYS.ledger);
    assert.strictEqual(pressed.started, true);
    await h.waitUntil(() => scheduler.runningRuns().length === 0 && runs('ledger') === 1);
    assert.strictEqual(runs('ledger'), 1, 'the press ran it');
    assert.strictEqual(h.internal.routineState[KEYS.ledger], undefined, 'and wrote no lastRun');
    assert.strictEqual(JSON.stringify(h.internal.routineSlots), slotsBefore, 'and left the slot store alone');
    assert.strictEqual(row('ledger').nextRun, iso(at(10, 15, 9)), 'the next run did not move');
    const [record] = recordsFor('ledger');
    assert.strictEqual(record.trigger, 'manual');
    assert.strictEqual('dueAt' in record, false, 'a pressed run was due at no slot');

    await tickAt(t, at(10, 15, 9));
    assert.strictEqual(runs('ledger'), 2, 'and the slot still fires');
  });
});

// The path failing: a hand-typed day 31, and a slot file from before monthly.
test('a hand-typed day 31 never fires, and the row is told the schedule cannot be read', async (t) => {
  resetTimeline();
  write('ledger', 'on day 31 of every month at 09:00');
  await withTicks(t, async () => {
    await tickAt(t, at(10, 1, 8));
    await tickAt(t, at(10, 31, 9));
    await tickAt(t, at(10, 31, 10));
    assert.strictEqual(runs('ledger'), 0, 'day 31 is not in every month, and Rundock will not pick another day');
    assert.strictEqual(entry('ledger'), undefined, 'nothing is anchored for it');
    assert.strictEqual(row('ledger').scheduleReadable, false);
    assert.strictEqual(row('ledger').nextRun, null);
  });
});

test('a slot file written before monthly schedules existed resyncs rather than walking', async (t) => {
  for (const stored of [null, 'daily:9:0']) {
    resetTimeline();
    // What a build that could not read the monthly form left behind: an anchor
    // from August, under no shape (its schedule had stopped parsing) or under
    // the daily one the routine had before it was edited.
    fs.mkdirSync(path.join(h.workspaceDir, '.rundock'), { recursive: true });
    fs.writeFileSync(path.join(h.workspaceDir, '.rundock', 'routine-slots.json'), JSON.stringify({
      observedAt: iso(at(8, 1, 10)),
      routines: { [KEYS.ledger]: { due: iso(at(8, 1, 9)), schedule: stored, missed: [], since: iso(at(7, 1, 10)) } },
    }, null, 2));
    h.internal.loadRoutineState();
    write('ledger', DAY_15);
    await withTicks(t, async () => {
      await tickAt(t, at(11, 2, 10));
      assert.deepStrictEqual(missed('ledger'), [], `from ${stored}: nothing is walked from the old anchor`);
      assert.strictEqual(entry('ledger').due, iso(at(11, 15, 9)), "the anchor resynced to November's slot");
      assert.strictEqual(entry('ledger').schedule, 'monthly:15:9:0');
      assert.strictEqual(runs('ledger'), 0);
    });
  }
});
