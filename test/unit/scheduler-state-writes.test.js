'use strict';
// The scheduler's state files, written whole.
//
// Four files carry what the scheduler and the runtime know across a restart:
// routine-state.json (the only input to double-fire suppression),
// routine-slots.json (the slots that passed unwatched), one record per run
// under runs/, and child-pids.json (the children a later launch may reap).
// Each used to be rewritten in place, which truncates the file and then writes
// it, so a process stopped between the two, a full disk, or a reader in another
// process could meet an empty or half file. Every loader read that as empty,
// and an empty routine state fires again every routine that already ran today.
//
// So each write goes to a temporary file in the same folder, is flushed to
// disk, and is renamed over the target. What is driven here is each real
// writer, with the filesystem calls it makes recorded or made to fail at a
// chosen step. Whether a second process ever sees a part-written file is
// driven by a real second process in scheduler-state-contention.test.js, and
// what a load does with a file that does not parse is in
// scheduler-state-loads.test.js.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const SCHEDULER_KEY = require.resolve('../../lib/scheduler.js');
const claude = require('../../lib/runtime/claude.js');
const { writeWholeFile } = require('../../lib/store/whole-file.js');

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
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-state-files-'));
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
// 09:00 routine that ran at 09:03, looked at an hour later.
const SCHEDULE = 'every day at 09:00';
const KEY = 'piper:Compile the ops summary';
const NOW = new Date(2026, 6, 1, 10, 0, 0);
const STARTED = new Date(2026, 6, 1, 9, 0, 0);
const RAN_AT = new Date(2026, 6, 1, 9, 3, 0);
const RUN_ID = '0b9f6a52-1c3d-4e5f-8a7b-9c0d1e2f3a4b';

const stateFile = (ws) => path.join(ws, '.rundock', 'routine-state.json');
const slotsFile = (ws) => path.join(ws, '.rundock', 'routine-slots.json');
const pidFile = (ws) => path.join(ws, '.rundock', 'child-pids.json');
const recordFile = (ws, id = RUN_ID) => path.join(ws, '.rundock', 'runs', `${id}.json`);

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

// ── Recording what a write does to the disk ────────────────────────────────

const WRITE_FLAGS = fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT
  | fs.constants.O_TRUNC | fs.constants.O_APPEND;
function writeMode(flags) {
  if (flags === undefined || flags === null) return false;
  if (typeof flags === 'number') return (flags & WRITE_FLAGS) !== 0;
  return /[wa+]/.test(String(flags));
}

// Run `fn` with the fs calls a write can make recorded, in order. `fail`, when
// given, is asked before each call and may throw in its place.
function recordingFs(fn, fail = () => {}) {
  const log = [];
  const real = {};
  const wrap = (name, note) => {
    real[name] = fs[name];
    fs[name] = function (...args) {
      fail(name, args);
      const result = real[name].apply(this, args);
      const entry = note(args, result);
      if (entry) log.push({ op: name, ...entry });
      return result;
    };
  };
  const at = (p) => (typeof p === 'number' ? { fd: p } : { path: path.resolve(String(p)) });
  wrap('openSync', ([p, flags], fd) => ({ path: path.resolve(String(p)), write: writeMode(flags), fd }));
  wrap('writeFileSync', ([p]) => ({ ...at(p), write: true }));
  wrap('appendFileSync', ([p]) => ({ ...at(p), write: true }));
  wrap('writeSync', ([fd]) => ({ fd, write: true }));
  wrap('fsyncSync', ([fd]) => ({ fd }));
  wrap('fdatasyncSync', ([fd]) => ({ fd }));
  wrap('closeSync', ([fd]) => ({ fd }));
  wrap('renameSync', ([from, to]) => ({ from: path.resolve(String(from)), to: path.resolve(String(to)) }));
  try { fn(); } finally { Object.assign(fs, real); }
  return log;
}

// The file was replaced whole: never opened for writing under its own name,
// written under another name in the same folder, flushed, then renamed over.
function assertWrittenWhole(log, target, label) {
  const inPlace = log.filter(e => e.path === target && (e.op !== 'openSync' || e.write));
  assert.deepStrictEqual(inPlace, [], `${label}: written in place, so a reader can meet it part written`);
  const renames = log.filter(e => e.op === 'renameSync' && e.to === target);
  assert.strictEqual(renames.length, 1, `${label}: not renamed over once, but ${renames.length} times`);
  const rename = renames[0];
  assert.notStrictEqual(rename.from, target);
  assert.strictEqual(path.dirname(rename.from), path.dirname(target),
    `${label}: the temporary file is in another folder, where a rename is not one step`);
  const opened = log.filter(e => e.op === 'openSync' && e.write && e.path === rename.from);
  assert.strictEqual(opened.length, 1, `${label}: the temporary file was not opened for writing once`);
  const fd = opened[0].fd;
  const renameAt = log.indexOf(rename);
  const lastWrite = log.map((e, i) => (e.write && e.fd === fd ? i : -1)).filter(i => i >= 0).pop();
  assert.ok(lastWrite !== undefined && lastWrite < renameAt, `${label}: nothing was written to the temporary file`);
  const flushed = log.findIndex((e, i) => i > lastWrite && i < renameAt
    && (e.op === 'fsyncSync' || e.op === 'fdatasyncSync') && e.fd === fd);
  assert.ok(flushed !== -1, `${label}: the temporary file was not flushed between its last write and the rename`);
}

// One writer of each store, driven the way the scheduler drives it. `before`
// leaves a previous complete file in place; `write` replaces it.
const WRITERS = [
  {
    store: 'routine-state.json',
    target: stateFile,
    before: (sched) => sched.recordRoutineRun(KEY, { lastRun: RAN_AT.toISOString(), status: 'completed', duration: 180 }),
    write: (sched) => sched.recordRoutineRun(KEY, { lastRun: NOW.toISOString(), status: 'running', duration: null }),
    readBack: (ws) => {
      const next = freshScheduler();
      next.loadRoutineState();
      assert.strictEqual(next.routineState[KEY].lastRun, RAN_AT.toISOString(), 'the next load did not read the last whole file');
      assert.strictEqual(next.getNextRun(SCHEDULE, next.routineState[KEY].lastRun), null,
        'so the routine that ran at 09:03 is due again at 10:00');
    },
  },
  {
    store: 'routine-slots.json',
    target: slotsFile,
    before: (sched) => { sched.routineSlots.observedAt = RAN_AT.toISOString(); sched.saveRoutineSlots(); },
    write: (sched) => { sched.routineSlots.observedAt = NOW.toISOString(); try { sched.saveRoutineSlots(); } catch (e) { /* the tick logs it */ } },
    readBack: () => {
      const next = freshScheduler();
      next.loadRoutineSlots();
      assert.strictEqual(next.routineSlots.observedAt, RAN_AT.toISOString(), 'the next load did not read the last whole file');
    },
  },
  {
    store: 'a run record',
    target: (ws) => recordFile(ws),
    // Opened by a process that is gone, and closed by the next load.
    before: (sched, ws) => writeRecord(ws, runRecord({ status: 'running', endedAt: null, durationMs: null, files: null, filesStatus: 'unknown', filesReason: 'running' })),
    write: (sched) => sched.loadRoutineState(),
    readBack: () => {
      const [record] = freshScheduler().readRunRecords();
      assert.strictEqual(record.status, 'running', 'the next read did not find the last whole record');
    },
  },
  {
    store: 'child-pids.json',
    target: pidFile,
    before: () => claude.savePidFile([{ pid: 4242, at: 1, cmd: 'claude' }]),
    write: () => claude.savePidFile([{ pid: 4242, at: 1, cmd: 'claude' }, { pid: 4343, at: 2, cmd: 'claude' }]),
    readBack: () => {
      assert.deepStrictEqual(claude.loadPidFile(), [{ pid: 4242, at: 1, cmd: 'claude' }], 'the next load did not read the last whole file');
    },
  },
];

describe('every write of a state file replaces it whole', () => {
  for (const writer of WRITERS) {
    test(`${writer.store} is written to a temporary file in its folder, flushed, then renamed over`, () => {
      withWorkspace((ws) => {
        const sched = freshScheduler();
        writer.before(sched, ws);
        const target = path.resolve(writer.target(ws));
        const log = recordingFs(() => writer.write(sched, ws));
        assertWrittenWhole(log, target, writer.store);
        JSON.parse(fs.readFileSync(target, 'utf-8'));
        assert.deepStrictEqual(fs.readdirSync(path.dirname(target)).filter(n => n.endsWith('.tmp')), [],
          'a temporary file was left behind');
      });
    });
  }
});

// The control failing: a write cut off after its bytes are down and before the
// rename. Whatever stopped it, the last whole file must still be the file.
describe('a write cut off before its rename leaves the last whole file', () => {
  for (const writer of WRITERS) {
    test(`${writer.store}: the previous file stays, and the next load reads it rather than starting empty`, () => {
      withWorkspace((ws) => {
        const sched = freshScheduler();
        writer.before(sched, ws);
        const target = path.resolve(writer.target(ws));
        const previous = fs.readFileSync(target);
        const folder = fs.readdirSync(path.dirname(target)).sort();
        let cut = 0;
        errorsDuring(() => recordingFs(() => writer.write(sched, ws), (name, args) => {
          if (name === 'renameSync' && path.resolve(String(args[1])) === target) {
            cut++;
            throw Object.assign(new Error('EIO: i/o error, rename'), { code: 'EIO' });
          }
        }));
        assert.ok(fs.readFileSync(target).equals(previous), `${writer.store} changed although its write was cut off`);
        assert.strictEqual(cut, 1, `sanity: the write reached its rename (${cut})`);
        assert.deepStrictEqual(fs.readdirSync(path.dirname(target)).sort(), folder,
          'the cut-off write left a file behind');
        writer.readBack(ws);
      });
    });
  }
});

// The name the helper's next temporary file in `target`'s folder takes, learned
// from a write of its own beside it: the process and a count.
function nextTempName(target) {
  const probe = path.join(path.dirname(target), 'probe.json');
  const log = recordingFs(() => writeWholeFile(probe, '{}'));
  fs.rmSync(probe);
  const opened = log.find(e => e.op === 'openSync' && e.write);
  const count = Number(/\.(\d+)\.tmp$/.exec(opened.path)[1]);
  return `${target}.${process.pid}.${count + 1}.tmp`;
}

// A file or a link already at the name a temporary file takes is never written
// through: the temporary file is created new, or the write fails. A link
// followed there would put the state wherever it points, and its rename would
// then put the link itself in place of the file.
describe('a temporary file is created new, never opened through what is already there', () => {
  for (const writer of WRITERS) {
    test(`${writer.store}: a link at the next temporary name leaves its target, and the file, as they were`, () => {
      withWorkspace((ws) => {
        const sched = freshScheduler();
        writer.before(sched, ws);
        const target = path.resolve(writer.target(ws));
        const previous = fs.readFileSync(target);
        const elsewhere = path.join(ws, 'elsewhere.txt');
        fs.writeFileSync(elsewhere, 'untouched\n');
        const planted = nextTempName(target);
        fs.symlinkSync(elsewhere, planted);
        errorsDuring(() => writer.write(sched, ws));
        assert.strictEqual(fs.readFileSync(elsewhere, 'utf-8'), 'untouched\n', `${writer.store}: the write went through the link`);
        assert.ok(!fs.lstatSync(target).isSymbolicLink(), `${writer.store}: the link was renamed over the file`);
        assert.ok(fs.readFileSync(target).equals(previous), `${writer.store}: the file changed although its write could not start`);
        assert.ok(fs.lstatSync(planted).isSymbolicLink(), `${writer.store}: what was at the temporary name was removed or replaced`);
        writer.readBack(ws);
      });
    });
  }

  test('the helper throws, as for any other failed write, and leaves the file as it was', () => {
    withWorkspace((ws) => {
      const target = stateFile(ws);
      writeWholeFile(target, '{"before":true}');
      const planted = nextTempName(target);
      fs.writeFileSync(planted, 'somebody else\'s\n');
      assert.throws(() => writeWholeFile(target, '{"after":true}'), (e) => e.code === 'EEXIST');
      assert.strictEqual(fs.readFileSync(target, 'utf-8'), '{"before":true}');
      assert.strictEqual(fs.readFileSync(planted, 'utf-8'), 'somebody else\'s\n', 'a file it did not make was written or removed');
    });
  });

  // Readable by its owner alone, as the run's stderr capture beside the records is.
  test('a state file is written readable by its owner alone', { skip: process.platform === 'win32' && 'no POSIX modes' }, () => {
    withWorkspace((ws) => {
      for (const writer of WRITERS) {
        const sched = freshScheduler();
        writer.before(sched, ws);
        writer.write(sched, ws);
        const mode = fs.statSync(writer.target(ws)).mode & 0o777;
        assert.strictEqual(mode, 0o600, `${writer.store} is written as ${mode.toString(8)}`);
      }
    });
  });
});

// ── AC: the inventory ──────────────────────────────────────────────────────
//
// Every write in lib/ that could land on one of these stores. A file that names
// a store has every write in it listed here, so a write added beside the stores
// that does not go through the whole-file helper fails until it is moved there
// or listed with what it writes instead. The helper's own write names no store.

const STORE_NAMES = ['routine-state.json', 'routine-slots.json', 'child-pids.json'];
// A run record is named for its run, `${record.id}.json`. Conversation
// transcripts are named the same way for a conversation, so the run's own
// names are what is matched.
const RUN_RECORD_NAME = /`\$\{(?:record\.id|run\.id|runId)\}\.json`/;
const WRITE_CALL = /\b(writeFileSync|appendFileSync|writeFile|appendFile|createWriteStream|openSync)\s*\(/g;

// The writes in those files that are aimed at something else, by the text of
// the path they write.
const OTHER_WRITES = [
  { file: 'lib/scheduler.js', call: 'openSync', target: 'capture.file', what: "a run's stderr capture, which sits beside its record under a name the record reader never reads" },
  { file: 'lib/runtime/claude.js', call: 'writeFileSync', target: 'marker', what: "the scratch folder's own .gitignore" },
];

// The source of `file` with its comment lines blanked, so a write named in
// prose is not counted.
function codeOf(file) {
  return fs.readFileSync(file, 'utf-8').split('\n')
    .map(l => (/^\s*(\/\/|\/\*|\*)/.test(l) ? '' : l)).join('\n');
}

// The arguments of the call whose open paren is at `open`, split at the top
// level. Strings and template literals are skipped whole.
function callArgs(src, open) {
  const args = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '\'' || c === '"' || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) { args.push(src.slice(start, i).trim()); return args; }
    } else if (c === ',' && depth === 1) { args.push(src.slice(start, i).trim()); start = i + 1; }
  }
  throw new Error(`an unclosed call at ${open}`);
}

function jsFilesUnder(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFilesUnder(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function writesIn(file) {
  const src = codeOf(file);
  const found = [];
  for (const m of src.matchAll(WRITE_CALL)) {
    const [target, flags] = callArgs(src, m.index + m[0].length - 1);
    if (m[1] === 'openSync' && (flags === undefined || /^['"]r['"]$/.test(flags))) continue;
    found.push({ file: path.relative(ROOT, file).split(path.sep).join('/'), call: m[1], target });
  }
  return found;
}

test('no write in lib/ is aimed at a state file except through the whole-file helper', () => {
  // The extraction on specimens first, so a pattern that stops matching fails
  // here rather than finding no writes anywhere.
  const specimen = "fs.writeFileSync(path.join(dir, `${record.id}.json`), JSON.stringify(record, null, 2));\nfs.openSync(f, 'r');\nfs.openSync(capture.file, FLAGS, 0o600);";
  const seen = [...specimen.matchAll(WRITE_CALL)].map(m => callArgs(specimen, m.index + m[0].length - 1));
  assert.deepStrictEqual(seen.map(a => a[0]), ['path.join(dir, `${record.id}.json`)', 'f', 'capture.file']);
  assert.ok(RUN_RECORD_NAME.test(seen[0][0]), 'the run record pattern misses the name a record is written under');

  const naming = [];
  const direct = [];
  const listed = [];
  for (const file of jsFilesUnder(path.join(ROOT, 'lib'))) {
    const src = codeOf(file);
    const writes = writesIn(file);
    for (const w of writes) {
      if (STORE_NAMES.some(n => w.target.includes(n)) || RUN_RECORD_NAME.test(w.target)) direct.push(w);
    }
    if (STORE_NAMES.some(n => src.includes(n)) || RUN_RECORD_NAME.test(src)) {
      naming.push(path.relative(ROOT, file).split(path.sep).join('/'));
      listed.push(...writes);
    }
  }
  assert.deepStrictEqual(naming.sort(), ['lib/runtime/claude.js', 'lib/scheduler.js'],
    'sanity: the stores are named in the scheduler and the runtime, and nowhere else in lib/');
  assert.deepStrictEqual(direct, [], 'a write names a state file directly');
  const rows = (list) => list.map(({ file, call, target }) => `${file} | ${call} | ${target}`).sort();
  assert.deepStrictEqual(rows(listed), rows(OTHER_WRITES),
    'a file that holds a state file writes something not listed here: if it is a state file, write it through the whole-file helper');
});
