'use strict';
// A routine that runs on a chosen set of days.
//
// Its period is the slot's calendar day, as a weekly routine's is: a slot on a
// chosen day is caught up any time Rundock is open later that day, and recorded
// as missed once the day ends without it. A day the set leaves out has no slot
// at all, so it never fires, never catches up and never shows as missed. Every
// one of those is asked here with real ticks, through the server's own paths:
// the tick, the roster the row is drawn from, and the message the editor sends
// to save a schedule.
//
// Setup is the scheduler-monthly template: stop the boot-armed tick, mock
// setInterval, start, and move the scheduler's own clock between ticks. Every
// instant is a fixed local time under an explicit zone. 2 November 2026 is a
// Monday.
process.env.TZ = 'Europe/London';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const h = require('../helpers/harness.js');
const { agentFile } = require('../helpers/workspace.js');

const scheduler = require('../../lib/scheduler.js');
const { invalidateAgentCache, discoverAgents } = require('../../lib/agents/discovery.js');
const editorModel = require('../../public/routine-editor-model.js');
const routinesModel = require('../../public/routines-model.js');

const ROUTINE = { name: 'report', prompt: 'ledger report body' };
const KEY = 'ledger:report';
const QUIET = 'on day 1 of every month at 00:00';
const MON_WED_SUN = 'every monday, wednesday and sunday at 09:00';
const WEEKDAY = 'every weekday at 09:00';

// November 2026, local components.
const at = (day, hour = 0, minute = 0) => new Date(2026, 10, day, hour, minute, 0);
const iso = (d) => d.toISOString();
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const clock = { at: at(1) };
let prevDeps = null;

function fileFor(schedule, fields = {}) {
  return agentFile({
    name: 'ledger', type: 'specialist', order: 1,
    routines: [{ name: ROUTINE.name, schedule, prompt: ROUTINE.prompt, enabled: true, ...fields }],
  });
}
const agentPath = () => path.join(h.workspaceDir, '.claude', 'agents', 'ledger.md');

before(async () => {
  await h.boot({ agents: { ledger: fileFor(QUIET) } });
  h.writeScenario([
    { match: { agent: 'ledger', promptIncludes: ROUTINE.prompt }, turn: [{ text: 'ledger ran' }] },
  ]);
  prevDeps = scheduler.wireSchedulerDeps({ now: () => clock.at });
});

after(async () => {
  if (prevDeps) scheduler.wireSchedulerDeps(prevDeps);
  await h.shutdown();
});

function write(schedule, fields = {}) {
  fs.writeFileSync(agentPath(), fileFor(schedule, fields));
  invalidateAgentCache();
}

// Everything the scheduler remembers, on disk and in memory, dropped so each
// test starts from a machine that has never seen this routine.
function resetTimeline() {
  h.internal.stopScheduler();
  delete h.internal.routineState[KEY];
  h.internal.routineSlots.observedAt = null;
  for (const k of Object.keys(h.internal.routineSlots.routines)) delete h.internal.routineSlots.routines[k];
  for (const file of ['routine-state.json', 'routine-slots.json']) {
    fs.rmSync(path.join(h.workspaceDir, '.rundock', file), { force: true });
  }
  fs.rmSync(path.join(h.workspaceDir, '.rundock', 'runs'), { recursive: true, force: true });
  h.clearPrompts();
}

const runs = () => h.promptsFor('ledger').filter(p => p.includes(ROUTINE.prompt)).length;
const entry = () => h.internal.routineSlots.routines[KEY];
const missed = () => (entry() ? entry().missed.map(m => m.slot) : []);
const records = () => scheduler.readRunRecords().filter(r => r.agent === 'ledger');

/** The routine as the roster carries it to the row. */
function row() {
  invalidateAgentCache();
  return discoverAgents().find(a => a.id === 'ledger').routines[0];
}
/** What the row says, at the scheduler's own clock. */
const rowAsShown = () => ({ ...row(), now: iso(clock.at) });

async function tickAt(t, when) {
  clock.at = when;
  t.mock.timers.tick(60_000);
  await h.waitUntil(() => scheduler.runningRuns().length === 0
    && (!h.internal.routineState[KEY] || h.internal.routineState[KEY].status !== 'running'));
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

/** Save a schedule the way the editor does: the message it sends. */
async function saveSchedule(schedule) {
  const client = await h.connect();
  try {
    client.send({ type: 'set_routine_schedule', agentId: 'ledger', name: 'report', occurrence: 0, schedule });
    await client.waitFor(m => m.type === 'routine_rescheduled' || m.type === 'routine_error', { label: 'the save reply' });
  } finally { client.close(); }
  invalidateAgentCache();
}

const scheduleLines = () => fs.readFileSync(agentPath(), 'utf-8').split('\n').filter(l => l.includes('schedule:'));

// ===== ONLY ON THE CHOSEN DAYS =====

test('a Monday, Wednesday and Sunday routine fires on those days at 09:00, across a full week of ticks, and on no other', async (t) => {
  resetTimeline();
  write(MON_WED_SUN);
  await withTicks(t, async () => {
    // First seen on Saturday 31 October, a day the set leaves out, then ticked
    // every half hour from Sunday 1 November to Sunday 8 November.
    await tickAt(t, new Date(2026, 9, 31, 12));
    const byDay = {};
    for (let day = 1; day <= 8; day++) {
      for (let hour = 0; hour < 24; hour++) {
        const before = runs();
        await tickAt(t, at(day, hour));
        await tickAt(t, at(day, hour, 30));
        const name = DAY_NAMES[at(day).getDay()];
        byDay[name] = (byDay[name] || 0) + runs() - before;
      }
    }
    assert.deepStrictEqual(byDay, { Sun: 2, Mon: 1, Tue: 0, Wed: 1, Thu: 0, Fri: 0, Sat: 0 },
      'once on each chosen day, and never on Tuesday, Thursday, Friday or Saturday');
    const due = [at(1, 9), at(2, 9), at(4, 9), at(8, 9)].map(iso);
    assert.deepStrictEqual(records().map(r => r.dueAt).sort(), due, 'each at its own day\'s 09:00');
    assert.deepStrictEqual(records().map(r => r.startedAt).sort(), due, 'and on time');
    assert.deepStrictEqual(missed(), [], 'and nothing recorded as missed');
  });
});

test('a run on a chosen day holds the routine for the rest of that day, through a restart', async (t) => {
  resetTimeline();
  write(MON_WED_SUN);
  await withTicks(t, async () => {
    await tickAt(t, at(3, 12));
    await tickAt(t, at(4, 9));
    assert.strictEqual(runs(), 1);
    h.internal.stopScheduler();
    h.internal.loadRoutineState();
    h.internal.startScheduler();
    for (const when of [at(4, 9, 1), at(4, 14), at(4, 23, 59)]) await tickAt(t, when);
    assert.strictEqual(runs(), 1, 'one run on Wednesday');
    assert.strictEqual(row().nextRun, iso(at(8, 9)), 'and the row names Sunday, the next chosen day');
  });
});

// ===== A MISSED SLOT ON A CHOSEN DAY =====

test('Friday\'s slot missed, seen on Saturday, shows Missed and a next run on Monday', async (t) => {
  resetTimeline();
  write(WEEKDAY);
  await withTicks(t, async () => {
    await tickAt(t, at(6, 8));
    // Rundock closed through Friday's 09:00, and opened on Saturday morning.
    await tickAt(t, at(7, 10));
    assert.strictEqual(runs(), 0, 'Friday\'s day had ended, so there is nothing to catch up');
    assert.deepStrictEqual(missed(), [iso(at(6, 9))], 'one record, for Friday');
    const shown = rowAsShown();
    assert.strictEqual(shown.missedSlot, iso(at(6, 9)));
    assert.strictEqual(shown.nextRun, iso(at(9, 9)), 'the next run is Monday\'s');
    const status = routinesModel.runStatus(shown);
    assert.strictEqual(status.lead, 'Missed');
    assert.match(status.text, /Rundock was closed at 9:00am yesterday/);
    assert.deepStrictEqual(routinesModel.nextRunLabel(shown), { text: 'Next run: Monday, 9:00am', className: 'next-run' });

    // The weekend has no slot: no run, and nothing more recorded.
    for (let day = 7; day <= 8; day++) for (const hour of [9, 12, 23]) await tickAt(t, at(day, hour));
    assert.strictEqual(runs(), 0, 'nothing fires at the weekend');
    assert.deepStrictEqual(missed(), [iso(at(6, 9))], 'and Saturday and Sunday are never missed');
    await tickAt(t, at(9, 9));
    assert.strictEqual(runs(), 1, 'Monday\'s fires on Monday');
  });
});

test('a slot on a chosen day is caught up later that day, and says so on the row until it runs', async (t) => {
  resetTimeline();
  write(MON_WED_SUN);
  await withTicks(t, async () => {
    await tickAt(t, at(4, 8));
    clock.at = at(4, 14);
    assert.deepStrictEqual(routinesModel.nextRunLabel(rowAsShown()),
      { text: 'Next run: shortly. It was due today, 9:00am.', className: 'next-run' });
    await tickAt(t, at(4, 14));
    assert.strictEqual(runs(), 1, 'caught up at the first tick back that day');
    const [record] = records();
    assert.strictEqual(record.dueAt, iso(at(4, 9)), 'its record says when it was due');
    assert.strictEqual(record.startedAt, iso(at(4, 14)), 'and when it ran');
    await tickAt(t, at(4, 18));
    assert.strictEqual(runs(), 1, 'once, not once a tick');
    assert.deepStrictEqual(missed(), []);
  });
});

test('a day the set leaves out has no slot, so closing over it records nothing for it', async (t) => {
  resetTimeline();
  write(MON_WED_SUN);
  await withTicks(t, async () => {
    // Seen Monday at 10:00, after Monday's run, then closed until Saturday.
    await tickAt(t, at(2, 8));
    await tickAt(t, at(2, 9));
    await tickAt(t, at(7, 12));
    assert.strictEqual(runs(), 1, 'Monday ran; nothing caught up on Saturday');
    assert.deepStrictEqual(missed(), [iso(at(4, 9))], 'Wednesday is recorded, and Tuesday, Thursday and Friday are not');
    assert.strictEqual(row().nextRun, iso(at(8, 9)), 'the next run is Sunday\'s');
  });
});

// The two stores the double-fire guard and the row read keep the fields they
// keep for any routine, and no field of a set's own.
test('the suppression files hold for a set of days what they hold for a daily routine', async (t) => {
  const shapes = {};
  for (const schedule of ['every day at 09:00', MON_WED_SUN]) {
    resetTimeline();
    write(schedule);
    await withTicks(t, async () => {
      await tickAt(t, at(1, 8));
      await tickAt(t, at(2, 9));
      await tickAt(t, at(2, 12));
    });
    const read = (file) => JSON.parse(fs.readFileSync(path.join(h.workspaceDir, '.rundock', file), 'utf-8'));
    const state = read('routine-state.json');
    const slots = read('routine-slots.json');
    shapes[schedule] = {
      stateTop: Object.keys(state).sort(),
      state: Object.keys(state[KEY]).sort(),
      slotsTop: Object.keys(slots).sort(),
      slots: Object.keys(slots.routines[KEY]).sort(),
    };
    if (schedule === MON_WED_SUN) assert.strictEqual(slots.routines[KEY].schedule, 'days:1,3,0:9:0');
  }
  assert.deepStrictEqual(shapes[MON_WED_SUN], shapes['every day at 09:00']);
});

// ===== SAVED FROM THE EDITOR =====

test('weekdays saved at 09:00 read as every weekday on the row, name Monday, and fire then and not at the weekend', async (t) => {
  resetTimeline();
  write(QUIET);
  await withTicks(t, async () => {
    await tickAt(t, at(7, 8));
    const schedule = editorModel.buildSchedule({
      frequency: 'week', days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'], time: '09:00',
    });
    await saveSchedule(schedule);
    clock.at = at(7, 10);
    const shown = rowAsShown();
    assert.strictEqual(shown.schedule, 'every weekday at 09:00', 'the file says the one form for Monday to Friday');
    assert.strictEqual(routinesModel.routineSentence(shown), 'Every weekday at 9:00am, run: report');
    assert.deepStrictEqual(routinesModel.nextRunLabel(shown), { text: 'Next run: Monday, 9:00am', className: 'next-run' });
    for (let day = 7; day <= 8; day++) for (let hour = 10; hour < 24; hour += 1) await tickAt(t, at(day, hour));
    assert.strictEqual(runs(), 0, 'nothing at the weekend');
    await tickAt(t, at(9, 8, 59));
    assert.strictEqual(runs(), 0);
    await tickAt(t, at(9, 9));
    assert.strictEqual(runs(), 1, 'Monday at 09:00');
    assert.strictEqual(records()[0].dueAt, iso(at(9, 9)));
  });
});

test('changing the days and changing them back leaves the schedule line byte for byte as it was', async () => {
  resetTimeline();
  write(MON_WED_SUN);
  const original = scheduleLines();
  const opened = editorModel.reopenSchedule(row());
  assert.deepStrictEqual(opened.days, ['monday', 'wednesday', 'sunday']);
  await saveSchedule(editorModel.buildSchedule({ ...opened, days: editorModel.toggleDay(opened.days, 'friday') }));
  assert.strictEqual(row().schedule, 'every monday, wednesday, friday and sunday at 09:00');
  const changed = editorModel.reopenSchedule(row());
  await saveSchedule(editorModel.buildSchedule({ ...changed, days: editorModel.toggleDay(changed.days, 'friday') }));
  assert.deepStrictEqual(scheduleLines(), original, 'the schedule line is the one the file started with');
});

test('saving the same days twice writes the same file and reopens on the same days', async () => {
  resetTimeline();
  write(QUIET);
  const schedule = editorModel.buildSchedule({ frequency: 'week', days: ['saturday', 'sunday'], time: '07:30' });
  await saveSchedule(schedule);
  const first = fs.readFileSync(agentPath(), 'utf-8');
  await saveSchedule(schedule);
  assert.strictEqual(fs.readFileSync(agentPath(), 'utf-8'), first, 'the second save changed the file');
  assert.deepStrictEqual(editorModel.reopenSchedule(row()),
    { frequency: 'week', days: ['saturday', 'sunday'], time: '07:30' });
});

// ===== A LIST NOTHING READS =====

test('a misspelled, shortened or empty list gives the hint, never fires and throws nothing', async (t) => {
  for (const schedule of ['every monday and frday at 09:00', 'every mon and fri at 09:00', 'every  at 09:00']) {
    resetTimeline();
    write(schedule);
    await withTicks(t, async () => {
      for (let day = 1; day <= 8; day++) for (const hour of [0, 9, 12]) await tickAt(t, at(day, hour));
    });
    assert.strictEqual(runs(), 0, `"${schedule}" fired`);
    const shown = rowAsShown();
    assert.strictEqual(shown.scheduleReadable, false, `"${schedule}" read as a schedule`);
    assert.strictEqual(routinesModel.nextRunLabel(shown), null, 'and promises no run');
    assert.strictEqual(routinesModel.scheduleProblem(shown).body,
      'Use Edit schedule, or change the file to say every day at 07:00, every weekday at 07:00, '
      + 'every Monday and Friday at 07:00 or on day 15 of every month at 07:00.');
    assert.strictEqual(editorModel.reopenSchedule(shown), null, 'and the editor opens on nothing of its own');
  }
});
