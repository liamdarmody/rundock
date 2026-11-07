'use strict';
// A routine moved to a later time on a day it has already run fires at the new
// time, through the whole product: a real run, the schedule saved through the
// save handler over the socket, the real tick, and the row drawn from the
// roster the save sends back.
//
// WHY END TO END. The suppression and the row's next run are both pure
// functions of the run stamp, and their unit tests ask them directly. What
// those cannot show is that the stamp a real run leaves, read by the real tick
// after a real save, produces one second run at the new time and no more, and
// that the row a reader is shown agrees with it at each step.
//
// Setup is the scheduler-clock template from scheduler-missed-slots.test.js:
// stop the boot-armed tick first, then mock setInterval, then start, so the
// interval being driven is the mocked one. The clock is the scheduler's own
// seam, so a tick lands on exactly the minute a test names. The zone is set
// before the first require, because the row speaks in the zone it is given and
// every instant below is local.
process.env.TZ = 'Europe/London';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const h = require('../helpers/harness.js');
const { agentFile } = require('../helpers/workspace.js');

const scheduler = require('../../lib/scheduler.js');
const { invalidateAgentCache, rosterMessage } = require('../../lib/agents/discovery.js');
const model = require('../../public/routines-model.js');

const AGENT = 'mover';
const ROUTINE = 'briefing';
const KEY = `${AGENT}:${ROUTINE}`;
const BODY = 'the routine that gets moved';
const ZONE = 'Europe/London';

// Friday 6 November 2026, Greenwich Mean Time, from local components.
const friday = (hour, minute) => new Date(2026, 10, 6, hour, minute);
const saturday = (hour, minute) => new Date(2026, 10, 7, hour, minute);

function routineFile(schedule) {
  return agentFile({
    name: AGENT, displayName: 'Mover', type: 'specialist', order: 1,
    routines: [{ name: ROUTINE, schedule, prompt: BODY, enabled: true }],
  });
}

let client = null;
before(async () => {
  await h.boot({ agents: { [AGENT]: routineFile('every day at 20:01') } });
  h.writeScenario([
    { match: { agent: AGENT, promptIncludes: BODY }, turn: [{ text: 'routine ran' }] },
  ]);
  // Connected before any test mocks setInterval, so nothing the socket arms is
  // driven by a test's fake interval.
  client = await h.connect();
});
after(h.shutdown);

const agentPath = () => path.join(h.workspaceDir, '.claude', 'agents', `${AGENT}.md`);

// A day that starts with the routine on `schedule` and no history at all,
// established by REAL runs rather than a state literal, as the missed-slots
// file does. Run records from earlier tests stay on disk, so the ones this
// test made are told apart by id.
let earlierRuns = new Set();
function startDay(schedule) {
  h.internal.stopScheduler();
  fs.writeFileSync(agentPath(), routineFile(schedule));
  invalidateAgentCache();
  delete scheduler.routineState[KEY];
  scheduler.routineSlots.observedAt = null;
  for (const k of Object.keys(scheduler.routineSlots.routines)) delete scheduler.routineSlots.routines[k];
  h.clearPrompts();
  earlierRuns = new Set(scheduler.readRunRecords().map(r => r.id));
}

/** When each run this test started began, in order. */
function runStarts() {
  return scheduler.readRunRecords()
    .filter(r => r.routine === ROUTINE && !earlierRuns.has(r.id))
    .map(r => r.startedAt)
    .sort();
}
function runCount() { return h.promptsFor(AGENT).filter(p => p.includes(BODY)).length; }

/** Tick once at `when`, and wait for any run it started to reach an outcome. */
async function tickAt(t, clock, when) {
  clock.at = when;
  t.mock.timers.tick(60_000);
  await h.waitUntil(() => {
    const s = scheduler.routineState[KEY];
    return !s || s.status !== 'running';
  });
}

/** A tick on every minute from `from` to `to`, both included. */
async function tickEveryMinute(t, clock, from, to) {
  for (let at = from.getTime(); at <= to.getTime(); at += 60_000) await tickAt(t, clock, new Date(at));
}

/**
 * What the routine's row says about its next run, drawn by the model from the
 * roster exactly as the view hands it over. `roster` is the message a client
 * was sent, or, when omitted, the one a client would be sent now.
 */
function rowSays(clock, roster) {
  if (!roster) {
    invalidateAgentCache();
    roster = rosterMessage();
  }
  const agent = roster.agents.find(a => a.id === AGENT);
  const r = agent.routines.find(x => x.name === ROUTINE);
  const row = model.row({
    name: r.name, schedule: r.schedule, agentName: agent.displayName || agent.name, runOn: r.runOn,
    lastStart: r.lastStart, lastRunStatus: r.state ? r.state.status : null, lastSlot: r.lastSlot,
    missedSlot: r.missedSlot, nextRun: r.nextRun, paused: !!r.paused, enabled: r.enabled,
    scheduleReadable: r.scheduleReadable, refusal: r.refusal, approvedBefore: r.approvedBefore,
    running: r.running, prompt: r.prompt, workspace: r.workspace, servingWorkspace: roster.workspace,
    now: clock.at, zone: ZONE,
  });
  return { text: row.nextRun ? row.nextRun.text : null, nextRun: r.nextRun };
}

/** Save a new schedule through the save handler, as the editor does. */
async function saveSchedule(schedule) {
  const since = client.messages.length;
  client.send({ type: 'set_routine_schedule', agentId: AGENT, name: ROUTINE, occurrence: 0, schedule });
  const answer = await client.waitFor(m => m.type === 'routine_rescheduled' || m.type === 'routine_error',
    { since, label: 'the answer to the save' });
  if (answer.msg.type === 'routine_error') return { refused: answer.msg.message };
  const roster = await client.waitFor(m => m.type === 'agents', { since: answer.index + 1, label: 'the roster the save sends' });
  return { roster: roster.msg };
}

// Ran at 20:01 under `from`, then moved to 20:30 at 20:10 through the save
// handler, with the row read from the roster that save sent back.
async function ranThenMoved(t, clock, from, to) {
  startDay(from);
  t.mock.timers.enable({ apis: ['setInterval'] });
  h.internal.startScheduler();
  await tickAt(t, clock, friday(20, 1));
  assert.strictEqual(runCount(), 1, 'it ran at 20:01');
  clock.at = friday(20, 10);
  const saved = await saveSchedule(to);
  assert.ok(saved.roster, `the save went through: ${saved.refused}`);
  return saved.roster;
}

function withClock(fn) {
  return async (t) => {
    const clock = { at: friday(20, 1) };
    const prevDeps = scheduler.wireSchedulerDeps({ now: () => clock.at });
    try {
      await fn(t, clock);
    } finally {
      h.internal.stopScheduler();
      t.mock.timers.reset();
      scheduler.wireSchedulerDeps(prevDeps);
    }
  };
}

// The defect at its smallest: a daily routine run at 20:01 and moved to 20:30
// that evening. The row promised 20:30 and the tick held it, because both
// times are in hour 20. Now it runs at 20:30, once, and the row says each step
// of that as it happens.
test('a daily routine moved later in the same hour runs once more, at the new time', withClock(async (t, clock) => {
  const roster = await ranThenMoved(t, clock, 'every day at 20:01', 'every day at 20:30');
  assert.strictEqual(rowSays(clock, roster).text, 'Next run: today, 8:30pm, London time',
    'after the save, the row says tonight at the new time');

  await tickEveryMinute(t, clock, friday(20, 10), friday(20, 29));
  assert.strictEqual(runCount(), 1, 'nothing ran before the new time');

  await tickAt(t, clock, friday(20, 30));
  assert.strictEqual(runCount(), 2, 'at 20:30 it ran');
  assert.strictEqual(rowSays(clock).text, 'Next run: tomorrow, 8:30pm, London time',
    'and the row then looks to tomorrow');

  await tickEveryMinute(t, clock, friday(20, 31), friday(23, 59));
  assert.deepStrictEqual(runStarts(), [friday(20, 1).toISOString(), friday(20, 30).toISOString()],
    'two runs that day, the second started at 20:30');
  assert.strictEqual(runCount(), 2);
}));

// The weekly shape, which held a routine moved later on its own day for a
// whole week while its row said that evening.
test('a weekly routine moved later on its own day runs once more, at the new time', withClock(async (t, clock) => {
  const roster = await ranThenMoved(t, clock, 'every friday at 20:01', 'every friday at 20:30');
  assert.strictEqual(rowSays(clock, roster).text, 'Next run: today, 8:30pm, London time');

  await tickEveryMinute(t, clock, friday(20, 10), friday(20, 29));
  assert.strictEqual(runCount(), 1, 'nothing ran before the new time');

  await tickAt(t, clock, friday(20, 30));
  assert.strictEqual(runCount(), 2, 'at 20:30 it ran');
  assert.strictEqual(rowSays(clock).nextRun, new Date(2026, 10, 13, 20, 30).toISOString(),
    'and the row then looks to next Friday');

  await tickEveryMinute(t, clock, friday(20, 31), friday(23, 59));
  assert.deepStrictEqual(runStarts(), [friday(20, 1).toISOString(), friday(20, 30).toISOString()],
    'two runs that day, the second started at 20:30');
}));

// Closed through the new time and opened again the same evening: the slot is
// still inside its day, so it is caught up once, late, on the first tick back.
test('closed through the new time and opened the same evening, it catches the new time up once', withClock(async (t, clock) => {
  await ranThenMoved(t, clock, 'every day at 20:01', 'every day at 20:30');
  await tickEveryMinute(t, clock, friday(20, 10), friday(20, 15));

  // Nothing ticks from 20:15 to 21:00.
  await tickAt(t, clock, friday(21, 0));
  assert.strictEqual(runCount(), 2, 'the first tick back ran the slot it slept through');
  await tickEveryMinute(t, clock, friday(21, 1), friday(23, 59));
  assert.deepStrictEqual(runStarts(), [friday(20, 1).toISOString(), friday(21, 0).toISOString()],
    'once, at 21:00, and not again');
}));

// Closed through the new time and past midnight: the slot's day has ended, so
// it is not run, and a record says it was missed.
test('closed through the new time until after midnight, it is not run, and one missed slot is kept', withClock(async (t, clock) => {
  await ranThenMoved(t, clock, 'every day at 20:01', 'every day at 20:30');
  await tickEveryMinute(t, clock, friday(20, 10), friday(20, 15));

  await tickEveryMinute(t, clock, saturday(0, 10), saturday(0, 20));
  assert.strictEqual(runCount(), 1, 'the slot whose day had ended was not run');
  assert.deepStrictEqual(scheduler.routineSlots.routines[KEY].missed, [{ slot: friday(20, 30).toISOString() }],
    'and the slot it slept through is recorded, once');
}));

// A save the writer refuses changes nothing: the file keeps the old schedule,
// the stamp stays where the run left it, and nothing fires at 20:30.
test('a refused save leaves the schedule and the stamp as they were, and nothing runs at 20:30', withClock(async (t, clock) => {
  startDay('every day at 20:01');
  t.mock.timers.enable({ apis: ['setInterval'] });
  h.internal.startScheduler();
  await tickAt(t, clock, friday(20, 1));
  assert.strictEqual(runCount(), 1, 'it ran at 20:01');

  clock.at = friday(20, 10);
  const fileBefore = fs.readFileSync(agentPath(), 'utf-8');
  const stampBefore = { ...scheduler.routineState[KEY] };
  const saved = await saveSchedule('every day at 8:30pm');
  assert.ok(saved.refused, 'the writer refused a schedule the scheduler cannot read');
  assert.strictEqual(fs.readFileSync(agentPath(), 'utf-8'), fileBefore, 'the file kept its schedule');
  assert.deepStrictEqual(scheduler.routineState[KEY], stampBefore, 'and the stamp is where the run left it');

  await tickEveryMinute(t, clock, friday(20, 10), friday(23, 59));
  assert.strictEqual(runCount(), 1, 'nothing ran at 20:30, or after it');
}));
