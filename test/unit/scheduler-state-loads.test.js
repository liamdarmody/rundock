'use strict';
// A state file that is there but does not parse is never loaded as empty.
//
// Every loader used to end in a catch that started empty, which reads a file
// cut off by a stopped process or a full disk the same as no file at all. For
// the routine state that is the expensive direction: its stamps are the only
// input to double-fire suppression, so every routine that already ran today
// runs again, and the next save overwrites the evidence.
//
// Now such a file is renamed aside under a dated name and one error line names
// both paths. The routine state is rebuilt from the run records, each
// routine's stamp from its newest scheduled run, so a routine that ran this
// period does not run again. The slot file and the pid file start empty, which
// is already the quiet direction for each: fewer gap records, and a launch
// that cannot reap a previous process's children. A missing file is still an
// ordinary empty start.
//
// The run record reader is held to the names records are written under, so a
// temporary file left by a write cut off before its rename is never a run.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCHEDULER_KEY = require.resolve('../../lib/scheduler.js');
const claude = require('../../lib/runtime/claude.js');

// A private copy per test, so wiring and state never leak into the shared one.
function freshScheduler() {
  const cached = require.cache[SCHEDULER_KEY];
  delete require.cache[SCHEDULER_KEY];
  const mod = require(SCHEDULER_KEY);
  delete require.cache[SCHEDULER_KEY];
  if (cached) require.cache[SCHEDULER_KEY] = cached;
  mod.wireSchedulerDeps({ now: () => NOW, getWssClients: () => [] });
  return mod;
}

function withWorkspace(fn) {
  const config = require('../../lib/config.js');
  const original = config.getWorkspace();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-state-loads-'));
  config.setWorkspace(ws);
  try {
    fs.mkdirSync(path.join(ws, '.rundock', 'runs'), { recursive: true });
    return fn(ws);
  } finally {
    config.setWorkspace(original);
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

// July 2026, local time, so nothing here depends on the machine's zone. A daily
// 09:00 routine that ran at 09:03, loaded an hour later.
const SCHEDULE = 'every day at 09:00';
const KEY = 'piper:Compile the ops summary';
const OTHER = 'piper:Refresh the reading digest';
const NOW = new Date(2026, 6, 1, 10, 0, 0);
const STARTED = new Date(2026, 6, 1, 9, 0, 0);
const RAN_AT = new Date(2026, 6, 1, 9, 3, 0);
const RUN_ID = '0b9f6a52-1c3d-4e5f-8a7b-9c0d1e2f3a4b';

const stateFile = (ws) => path.join(ws, '.rundock', 'routine-state.json');
const slotsFile = (ws) => path.join(ws, '.rundock', 'routine-slots.json');
const pidFile = (ws) => path.join(ws, '.rundock', 'child-pids.json');
const recordFile = (ws, id = RUN_ID) => path.join(ws, '.rundock', 'runs', `${id}.json`);

// A scheduled run that started at 09:00 and ended at 09:03, as its ending wrote it.
function runRecord(over) {
  return {
    id: RUN_ID, agent: 'piper', routine: 'Compile the ops summary', sessionId: null, trigger: 'scheduled',
    status: 'succeeded', startedAt: STARTED.toISOString(), endedAt: RAN_AT.toISOString(), durationMs: 180000,
    error: null, files: [], filesStatus: 'known', filesReason: null, ...over,
  };
}
function writeRecord(ws, record) {
  fs.writeFileSync(recordFile(ws, record.id), JSON.stringify(record, null, 2));
}

// Every console.error line written while `fn` runs.
function errorsDuring(fn) {
  const real = console.error;
  const lines = [];
  console.error = (...args) => { lines.push(args.map(String).join(' ')); };
  try { fn(); } finally { console.error = real; }
  return lines;
}

// The one file beside `file` that a load set aside, by name.
function setAsideBeside(file) {
  const base = path.basename(file);
  return fs.readdirSync(path.dirname(file))
    .filter(n => n !== base && n.startsWith(`${base}.`) && !n.endsWith('.tmp'))
    .map(n => path.join(path.dirname(file), n));
}

const WHOLE_STATE = JSON.stringify({ [KEY]: { lastRun: RAN_AT.toISOString(), status: 'completed', duration: 180 } }, null, 2);
const DAMAGE = [
  ['cut in half', Buffer.from(WHOLE_STATE).subarray(0, Math.floor(WHOLE_STATE.length / 2))],
  ['empty', Buffer.alloc(0)],
];

describe('a routine state that does not parse is set aside and rebuilt from the run records', () => {
  for (const [how, bytes] of DAMAGE) {
    test(`${how}: the routine that ran at 09:03 is not due at 10:00, and the file is kept`, () => {
      withWorkspace((ws) => {
        fs.writeFileSync(stateFile(ws), bytes);
        writeRecord(ws, runRecord());
        const sched = freshScheduler();
        const errors = errorsDuring(() => sched.loadRoutineState());

        const state = sched.routineState[KEY];
        assert.strictEqual(sched.getNextRun(SCHEDULE, state && state.lastRun), null,
          `the routine that ran at 09:03 is due again at 10:00: it was loaded as ${JSON.stringify(state)}`);
        assert.deepStrictEqual(state, { lastRun: RAN_AT.toISOString(), status: 'completed', duration: 180 },
          'the stamp is not the one its run record gives');

        const aside = setAsideBeside(stateFile(ws));
        assert.strictEqual(aside.length, 1, `the file was not set aside once: ${aside.join(', ')}`);
        assert.ok(path.basename(aside[0]).includes(NOW.toISOString().slice(0, 10)), `the set-aside name is not dated: ${aside[0]}`);
        assert.ok(fs.readFileSync(aside[0]).equals(bytes), 'the set-aside file does not hold the original bytes');
        assert.strictEqual(errors.length, 1, `not one error line:\n${errors.join('\n')}`);
        assert.ok(errors[0].includes(stateFile(ws)) && errors[0].includes(aside[0]),
          `the error line does not name both paths: ${errors[0]}`);

        // Put back at once, so a restart before the next run does not find
        // no file and start empty.
        const next = freshScheduler();
        next.loadRoutineState();
        assert.deepStrictEqual(next.routineState[KEY], state, 'the rebuilt state was not saved');
      });
    });
  }

  test('each stamp is its newest scheduled run: the ending, or the start of one still open', () => {
    withWorkspace((ws) => {
      fs.writeFileSync(stateFile(ws), DAMAGE[0][1]);
      const yesterday = (d) => new Date(d.getTime() - 24 * 3600 * 1000);
      writeRecord(ws, runRecord({ id: '11111111-1111-4111-8111-111111111111', startedAt: yesterday(STARTED).toISOString(), endedAt: yesterday(RAN_AT).toISOString() }));
      writeRecord(ws, runRecord());
      // Pressed by a person after the scheduled run: it stamps nothing, so it
      // rebuilds nothing.
      writeRecord(ws, runRecord({ id: '22222222-2222-4222-8222-222222222222', trigger: 'manual', status: 'failed',
        startedAt: new Date(2026, 6, 1, 9, 30).toISOString(), endedAt: new Date(2026, 6, 1, 9, 31).toISOString(), durationMs: 60000 }));
      // Still open when the process that started it went away.
      const openedAt = new Date(2026, 6, 1, 9, 10);
      writeRecord(ws, runRecord({ id: '33333333-3333-4333-8333-333333333333', routine: 'Refresh the reading digest', status: 'running',
        startedAt: openedAt.toISOString(), endedAt: null, durationMs: null, files: null, filesStatus: 'unknown', filesReason: 'running' }));
      const sched = freshScheduler();
      errorsDuring(() => sched.loadRoutineState());
      assert.deepStrictEqual(sched.routineState[KEY], { lastRun: RAN_AT.toISOString(), status: 'completed', duration: 180 });
      assert.deepStrictEqual(sched.routineState[OTHER], { lastRun: openedAt.toISOString(), status: 'interrupted', duration: null });
      assert.deepStrictEqual(Object.keys(sched.routineState).sort(), [KEY, OTHER].sort());
    });
  });

  // The inverse. A file that parses is read exactly as before: nothing set
  // aside, nothing written, and the clock, which only names a set-aside file,
  // never read. A clock that throws must not cost a load that never needed it.
  test('a state file that parses loads as before, without reading the clock', () => {
    withWorkspace((ws) => {
      fs.writeFileSync(stateFile(ws), WHOLE_STATE);
      const slots = JSON.stringify({ observedAt: RAN_AT.toISOString(), routines: {} }, null, 2);
      fs.writeFileSync(slotsFile(ws), slots);
      writeRecord(ws, runRecord());
      const folder = fs.readdirSync(path.join(ws, '.rundock')).sort();
      const sched = freshScheduler();
      let reads = 0;
      sched.wireSchedulerDeps({ now: () => { reads++; throw new Error('the clock is not available'); } });
      const errors = errorsDuring(() => sched.loadRoutineState());
      assert.deepStrictEqual(sched.routineState[KEY], JSON.parse(WHOLE_STATE)[KEY], 'the file that parses was not loaded');
      assert.strictEqual(sched.routineSlots.observedAt, RAN_AT.toISOString(), 'the slot file that parses was not loaded');
      assert.strictEqual(reads, 0, 'the clock was read by a load that set nothing aside');
      assert.deepStrictEqual(errors, []);
      assert.strictEqual(fs.readFileSync(stateFile(ws), 'utf-8'), WHOLE_STATE, 'the file was rewritten');
      assert.deepStrictEqual(fs.readdirSync(path.join(ws, '.rundock')).sort(), folder, 'the folder changed');
    });
  });

  test('a missing state file still starts empty, and says nothing', () => {
    withWorkspace((ws) => {
      writeRecord(ws, runRecord());
      const sched = freshScheduler();
      const errors = errorsDuring(() => sched.loadRoutineState());
      assert.deepStrictEqual(sched.routineState, {});
      assert.deepStrictEqual(errors, []);
      assert.ok(!fs.existsSync(stateFile(ws)), 'a state file was made where there was none');
    });
  });
});

describe('the slot file and the pid file are set aside and start empty', () => {
  test('a slot file that does not parse', () => {
    withWorkspace((ws) => {
      const whole = JSON.stringify({ observedAt: RAN_AT.toISOString(), routines: { [KEY]: { due: STARTED.toISOString(), schedule: 'daily:09:00', missed: [] } } }, null, 2);
      const half = Buffer.from(whole).subarray(0, 40);
      fs.writeFileSync(slotsFile(ws), half);
      const sched = freshScheduler();
      const errors = errorsDuring(() => sched.loadRoutineSlots());
      assert.deepStrictEqual(sched.routineSlots, { observedAt: null, routines: {} });
      const aside = setAsideBeside(slotsFile(ws));
      assert.strictEqual(aside.length, 1, 'the slot file was not set aside');
      assert.ok(fs.readFileSync(aside[0]).equals(half), 'the set-aside file does not hold the original bytes');
      assert.strictEqual(errors.length, 1, `not one error line:\n${errors.join('\n')}`);
      assert.ok(errors[0].includes(slotsFile(ws)) && errors[0].includes(aside[0]), `the error line does not name both paths: ${errors[0]}`);
    });
  });

  test('a pid file that does not parse', () => {
    withWorkspace((ws) => {
      const half = Buffer.from(JSON.stringify([{ pid: 4242, at: 1, cmd: 'claude' }])).subarray(0, 12);
      fs.writeFileSync(pidFile(ws), half);
      const day = new Date().toISOString().slice(0, 10);
      const errors = errorsDuring(() => assert.deepStrictEqual(claude.loadPidFile(), []));
      const aside = setAsideBeside(pidFile(ws));
      assert.strictEqual(aside.length, 1, 'the pid file was not set aside');
      assert.ok(path.basename(aside[0]).includes(day) || path.basename(aside[0]).includes(new Date().toISOString().slice(0, 10)),
        `the set-aside name is not dated: ${aside[0]}`);
      assert.ok(fs.readFileSync(aside[0]).equals(half), 'the set-aside file does not hold the original bytes');
      assert.strictEqual(errors.length, 1, `not one error line:\n${errors.join('\n')}`);
      assert.ok(errors[0].includes(pidFile(ws)) && errors[0].includes(aside[0]), `the error line does not name both paths: ${errors[0]}`);
      // Gone from under its name, so the next load is an ordinary empty one.
      assert.deepStrictEqual(errorsDuring(() => assert.deepStrictEqual(claude.loadPidFile(), [])), []);
    });
  });
});

describe('a temporary file in runs/ is never a run', () => {
  test('a complete copy left by a write cut off before its rename is neither listed nor closed', () => {
    withWorkspace((ws) => {
      writeRecord(ws, runRecord());
      // An earlier write of the same record, whole, under the name it had
      // before its rename, from a process that stopped there.
      const stale = runRecord({ status: 'running', endedAt: null, durationMs: null, files: null, filesStatus: 'unknown', filesReason: 'running' });
      fs.writeFileSync(`${recordFile(ws)}.48213.1.tmp`, JSON.stringify(stale, null, 2));
      const sched = freshScheduler();
      assert.deepStrictEqual(sched.readRunRecords().map(r => r.status), ['succeeded'],
        'the temporary file was read as a second copy of the run');
      sched.loadRoutineState();
      assert.strictEqual(JSON.parse(fs.readFileSync(recordFile(ws), 'utf-8')).status, 'succeeded',
        "the load closed the temporary copy as abandoned and wrote that over the run's real ending");
    });
  });
});
