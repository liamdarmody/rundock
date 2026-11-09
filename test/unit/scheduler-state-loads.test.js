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
const { test, describe, after, mock } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');

const SCHEDULER_KEY = require.resolve('../../lib/scheduler.js');
const claude = require('../../lib/runtime/claude.js');
const signals = require('../../lib/signals.js');
const { agentFile, cleanup } = require('../helpers/workspace.js');
const { invalidateAgentCache } = require('../../lib/agents/discovery.js');
const { computePlanHash } = require('../../lib/agents/routines.js');
after(cleanup);

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
        // no file and start empty. The undo: that restart reads the rebuilt
        // file as any other, quietly, and sets nothing aside a second time.
        const next = freshScheduler();
        const again = errorsDuring(() => next.loadRoutineState());
        assert.deepStrictEqual(next.routineState[KEY], state, 'the rebuilt state was not saved');
        assert.deepStrictEqual(again, [], 'the load after the rebuild said something');
        assert.deepStrictEqual(setAsideBeside(stateFile(ws)), aside, 'the load after the rebuild set a file aside again');
        assert.ok(fs.readFileSync(aside[0]).equals(bytes), 'the set-aside file changed');
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(stateFile(ws), 'utf-8'))[KEY], state, 'the state file does not hold the rebuilt state');
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

// Run `fn` with the replacement of the state file failing at one step: the
// create, the write or the flush of the temporary file it is written to. The
// count of failures is returned, so a test can tell a write that was cut off
// from one that never got that far.
function withStateWriteFailing(ws, step, code, fn) {
  const target = stateFile(ws);
  const isTemp = (p) => typeof p === 'string' && path.resolve(p).startsWith(`${target}.`) && p.endsWith('.tmp');
  const real = { openSync: fs.openSync, writeFileSync: fs.writeFileSync, fsyncSync: fs.fsyncSync, closeSync: fs.closeSync };
  const temps = new Set();
  let fired = 0;
  const fail = (syscall) => {
    fired++;
    throw Object.assign(new Error(`${code}: made to fail here, ${syscall}`), { code, syscall });
  };
  fs.openSync = function (p, ...rest) {
    if (isTemp(p) && step === 'open') fail('open');
    const fd = real.openSync.call(this, p, ...rest);
    if (isTemp(p)) temps.add(fd);
    return fd;
  };
  fs.writeFileSync = function (p, ...rest) {
    if (temps.has(p) && step === 'write') fail('write');
    return real.writeFileSync.call(this, p, ...rest);
  };
  fs.fsyncSync = function (fd, ...rest) {
    if (temps.has(fd) && step === 'fsync') fail('fsync');
    return real.fsyncSync.call(this, fd, ...rest);
  };
  fs.closeSync = function (fd, ...rest) {
    temps.delete(fd);
    return real.closeSync.call(this, fd, ...rest);
  };
  try { fn(); } finally { Object.assign(fs, real); }
  return fired;
}

// The control failing. A state file that does not parse is written back at
// once, rebuilt from the run records, and that write can fail: a full disk
// fails a write where a rename needs no space. Whatever stops it, a restart
// must still find the file, rebuild again, and not fire a routine that already
// ran. Renamed aside before the write, it would find no file and start empty.
// The most common next step after a rebuild: the scheduler's next tick. It
// must not start the routine whose run the rebuild found. With no run to find,
// the same tick starts it, which shows the tick was live.
describe('the tick after a rebuild', () => {
  function startsOnTheTickAfterALoad(ws) {
    const agents = path.join(ws, '.claude', 'agents');
    fs.mkdirSync(agents, { recursive: true });
    const routine = { name: 'Compile the ops summary', schedule: SCHEDULE, prompt: 'go', runOn: 'local', enabled: true };
    fs.writeFileSync(path.join(agents, 'piper.md'), agentFile({
      name: 'piper', displayName: 'Piper', type: 'specialist', order: 1,
      routines: [{ ...routine, planApprovedHash: computePlanHash(routine) }],
    }));
    require('../helpers/approvals.js').seenHere(ws);
    invalidateAgentCache();
    // In place before the scheduler is required: it takes both at require time.
    const realSpawn = claude.spawnClaude;
    const realRecordEvent = signals.recordEvent;
    const prevClaudeDeps = claude.wireClaudeRuntimeDeps({ getActualPort: () => 0 });
    const started = [];
    claude.spawnClaude = (args) => {
      const child = new EventEmitter();
      child.pid = 4000 + started.length;
      child.kill = () => {};
      started.push(args);
      return child;
    };
    signals.recordEvent = () => {};
    try {
      const sched = freshScheduler();
      errorsDuring(() => sched.loadRoutineState());
      mock.timers.enable({ apis: ['setInterval'] });
      try {
        sched.startScheduler();
        mock.timers.tick(60_000);
      } finally {
        sched.stopScheduler();
        mock.timers.reset();
      }
      return started.length;
    } finally {
      claude.spawnClaude = realSpawn;
      signals.recordEvent = realRecordEvent;
      claude.wireClaudeRuntimeDeps(prevClaudeDeps);
      invalidateAgentCache();
    }
  }

  test('the routine that ran at 09:03 is not started again by the 10:00 tick', () => {
    withWorkspace((ws) => {
      fs.writeFileSync(stateFile(ws), DAMAGE[0][1]);
      writeRecord(ws, runRecord());
      assert.strictEqual(startsOnTheTickAfterALoad(ws), 0, 'the tick after the rebuild started the routine again');
    });
  });

  test('with no run to find, the same tick starts it', () => {
    withWorkspace((ws) => {
      fs.writeFileSync(stateFile(ws), DAMAGE[0][1]);
      assert.strictEqual(startsOnTheTickAfterALoad(ws), 1, 'the tick did not start a routine due since 09:00, so it proves nothing');
    });
  });
});

describe('a state file whose replacement cannot be written stays where it is', () => {
  const CUTS = [
    ['the disk is full when the replacement is written', 'write', 'ENOSPC'],
    ['the flush of the replacement fails', 'fsync', 'EIO'],
    ['the replacement cannot be created', 'open', 'EEXIST'],
  ];
  for (const [how, step, code] of CUTS) {
    test(`${how}: a restart rebuilds again, and the routine that ran at 09:03 is not due at 10:00`, () => {
      withWorkspace((ws) => {
        const bytes = DAMAGE[0][1];
        fs.writeFileSync(stateFile(ws), bytes);
        writeRecord(ws, runRecord());
        const folder = fs.readdirSync(path.join(ws, '.rundock')).sort();
        const sched = freshScheduler();
        let fired = 0;
        const errors = errorsDuring(() => { fired = withStateWriteFailing(ws, step, code, () => sched.loadRoutineState()); });
        const leftOnDisk = fs.existsSync(stateFile(ws)) ? fs.readFileSync(stateFile(ws)) : null;
        const leftBeside = fs.readdirSync(path.join(ws, '.rundock')).sort();

        // The retry: another start, with the disk working again.
        const next = freshScheduler();
        const again = errorsDuring(() => next.loadRoutineState());
        assert.strictEqual(next.getNextRun(SCHEDULE, next.routineState[KEY] && next.routineState[KEY].lastRun), null,
          `after a write-back that failed, a restart finds the routine that ran at 09:03 due again at 10:00: it loaded ${JSON.stringify(next.routineState[KEY])}`);

        assert.strictEqual(fired, 1, `sanity: the write-back reached the step made to fail (${fired})`);
        assert.strictEqual(sched.getNextRun(SCHEDULE, sched.routineState[KEY] && sched.routineState[KEY].lastRun), null,
          'the process whose write-back failed would fire the routine again');
        assert.ok(leftOnDisk && leftOnDisk.equals(bytes), 'the state file is not the one that was there before the write-back failed');
        assert.deepStrictEqual(leftBeside, folder, 'the failed write-back left the folder changed');
        assert.strictEqual(errors.length, 1, `not one error line:\n${errors.join('\n')}`);
        assert.ok(errors[0].includes(stateFile(ws)) && errors[0].includes(code), `the error line does not say which file, or why: ${errors[0]}`);

        // That start rebuilt it, kept the bytes once and wrote back a file that parses.
        assert.deepStrictEqual(next.routineState[KEY], { lastRun: RAN_AT.toISOString(), status: 'completed', duration: 180 });
        const aside = setAsideBeside(stateFile(ws));
        assert.strictEqual(aside.length, 1, `the file was not set aside once: ${aside.join(', ')}`);
        assert.ok(fs.readFileSync(aside[0]).equals(bytes), 'the set-aside file does not hold the original bytes');
        JSON.parse(fs.readFileSync(stateFile(ws), 'utf-8'));
        assert.strictEqual(again.length, 1, `not one error line on the retry:\n${again.join('\n')}`);
      });
    });
  }

  test('a clock that fails when the file is set aside: nothing is written over it, and a restart rebuilds again', () => {
    withWorkspace((ws) => {
      const bytes = DAMAGE[0][1];
      fs.writeFileSync(stateFile(ws), bytes);
      writeRecord(ws, runRecord());
      const folder = fs.readdirSync(path.join(ws, '.rundock')).sort();
      const sched = freshScheduler();
      sched.wireSchedulerDeps({ now: () => { throw new Error('the clock is not available'); } });
      const errors = errorsDuring(() => sched.loadRoutineState());
      // Back, for the question below: what is due is asked of the clock.
      sched.wireSchedulerDeps({ now: () => NOW });
      assert.strictEqual(sched.getNextRun(SCHEDULE, sched.routineState[KEY] && sched.routineState[KEY].lastRun), null,
        'the process whose clock failed would fire the routine again');
      assert.ok(fs.readFileSync(stateFile(ws)).equals(bytes), 'the state file was written over without its bytes kept');
      assert.deepStrictEqual(fs.readdirSync(path.join(ws, '.rundock')).sort(), folder, 'the folder changed');
      assert.strictEqual(errors.length, 1, `not one error line:\n${errors.join('\n')}`);
      assert.ok(errors[0].includes(stateFile(ws)), `the error line does not name the file: ${errors[0]}`);

      const next = freshScheduler();
      errorsDuring(() => next.loadRoutineState());
      assert.strictEqual(next.getNextRun(SCHEDULE, next.routineState[KEY] && next.routineState[KEY].lastRun), null,
        'a restart finds the routine that ran at 09:03 due again at 10:00');
      assert.strictEqual(setAsideBeside(stateFile(ws)).length, 1, 'the restart did not set the file aside');
    });
  });

  // A filesystem with no hard links (FAT, some network shares) keeps the bytes
  // as a copy instead.
  test('where the filesystem refuses a second name, the bytes are kept as a copy', () => {
    withWorkspace((ws) => {
      const bytes = DAMAGE[0][1];
      fs.writeFileSync(stateFile(ws), bytes);
      writeRecord(ws, runRecord());
      const sched = freshScheduler();
      const realLink = fs.linkSync;
      let refused = 0;
      fs.linkSync = () => { refused++; throw Object.assign(new Error('EPERM: operation not permitted, link'), { code: 'EPERM' }); };
      let errors;
      try { errors = errorsDuring(() => sched.loadRoutineState()); } finally { fs.linkSync = realLink; }
      assert.strictEqual(refused, 1, 'sanity: the second name was asked for');
      const aside = setAsideBeside(stateFile(ws));
      assert.strictEqual(aside.length, 1, `the file was not set aside once: ${aside.join(', ')}`);
      assert.ok(fs.readFileSync(aside[0]).equals(bytes), 'the copy does not hold the original bytes');
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(stateFile(ws), 'utf-8'))[KEY], { lastRun: RAN_AT.toISOString(), status: 'completed', duration: 180 });
      assert.strictEqual(errors.length, 1, `not one error line:\n${errors.join('\n')}`);
      assert.ok(errors[0].includes(stateFile(ws)) && errors[0].includes(aside[0]), `the error line does not name both paths: ${errors[0]}`);
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

// A write stopped between its open and its rename leaves its temporary file,
// and nothing else ever removes it. The next load removes those whose process
// has gone. One whose process is still running may be a write in progress, and
// a name of any other shape is not the helper's to remove.
describe('a temporary file a stopped process left is removed on load', () => {
  // A process that has run and exited, so its id names no running process.
  const gonePid = () => spawnSync(process.execPath, ['-e', '']).pid;
  const STORES = [
    ['routine-state.json', stateFile, (sched) => sched.loadRoutineState()],
    ['routine-slots.json', slotsFile, (sched) => sched.loadRoutineSlots()],
    ['a run record', (ws) => recordFile(ws), (sched) => sched.loadRoutineState()],
    ['child-pids.json', pidFile, () => claude.loadPidFile()],
  ];
  for (const [store, target, load] of STORES) {
    test(`${store}: one whose process has gone is removed; one whose process runs, and any other name, is kept`, () => {
      withWorkspace((ws) => {
        const file = target(ws);
        const gone = gonePid();
        const left = `${file}.${gone}.1.tmp`;
        const writing = `${file}.${process.pid}.999999.tmp`;
        const others = [
          `${file}.tmp`, `${file}.${gone}.tmp`, `${file}.0${gone}.1.tmp`, `${file}.${gone}.1.tmp.keep`,
          path.join(path.dirname(file), `notes.json.${gone}.1.tmp`),
        ];
        for (const f of [left, writing, ...others]) fs.writeFileSync(f, '{}');
        errorsDuring(() => load(freshScheduler()));
        assert.ok(!fs.existsSync(left), `${store}: the temporary file a stopped process left is still there`);
        assert.ok(fs.existsSync(writing), `${store}: the temporary file of a process still running was removed`);
        for (const f of others) assert.ok(fs.existsSync(f), `${store}: ${path.basename(f)} is not the helper's, and was removed`);
      });
    });
  }
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
