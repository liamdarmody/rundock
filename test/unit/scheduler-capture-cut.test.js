'use strict';
// The cut that keeps a routine's stderr capture to its last 4 KB, driven one
// look at a time.
//
// WHY THIS IS ITS OWN FILE. While a routine's child runs, boundCapture in
// lib/scheduler.js looks at the capture every 50 ms, and once it holds more
// than 4 KB it keeps the last 4 KB in memory and empties the file. A write
// that lands while the file is being cut would go with it, so the cut reads
// the size again after the tail, and the tail again if the file grew, up to
// three times. With a real child that re-read runs only when one of the
// child's writes happens to land between two looks, so whether its lines ran
// depended on timing, and the coverage floor for lib/scheduler.js failed at
// random on code nobody had changed.
//
// Here the interval runs on mock timers, so a look happens when the test
// ticks and at no other time. Every look at the size goes through
// deps.captureSize and every tail read through deps.captureRead, which the
// test wires: on the look it chooses the stand-in child writes just before
// the size is read, or the look throws, and on the read it chooses the read
// throws. Every run takes the same path through the cut.
//
// WHAT IS ASSERTED IS WHAT THE CUT IS FOR, TO THE BYTE. The ending reads back
// the tail the last cut kept followed by what the file holds, and hands it to
// deps.captureTaken, which the test also wires. Each case writes text whose
// every 4 KB window is different, so the bytes the ending read are compared
// whole, in order, with the last 4 KB the child wrote: a cut that kept an
// earlier tail, kept part of one, or joined them in the wrong order fails.
// Claude Code's refusal to load an agent file is the last line it writes, and
// the run reads it from the end of the capture to decide whether to fall back
// to a plain session, so most cases also end in that line and check the
// record's notice quotes it. The file on disk is read between looks for what
// the cut did to it.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const SCHEDULER_KEY = require.resolve('../../lib/scheduler.js');
const CLAUDE_KEY = require.resolve('../../lib/runtime/claude.js');
const config = require('../../lib/config.js');

// The scheduler's own two numbers, CAPTURE_BYTES and CAPTURE_TRIM_MS. Not
// exported, so restated here; a change to either shows up as a look count
// or a kept tail that no longer matches, which is every test below.
const KEEP = 4096;
const EVERY_MS = 50;

const AGENT = { id: 'runner', name: 'Runner', fileName: 'runner.md', description: 'Runs' };
const ROUTINE = { name: 'r', prompt: 'p' };
const KEY = 'runner:r';
// The line Claude Code writes when it cannot load the agent, and what the
// run's record says when the ending read it.
const REFUSAL = "--agent 'Runner' not found. Available agents: claude, Explore\n";
const READ_IT = /Claude Code said: --agent 'Runner' not found\./;
// A look at the size, or a read of the tail, that throws, as an fstat or a
// read can.
const THROWS = Symbol('this one throws');

// `n` bytes on one line ending in a newline, numbered as they go, so no two
// stretches of it are alike and a tail taken a byte early or late is a
// different string. ASCII, so its length in characters is its length in bytes.
function text(tag, n) {
  let s = '';
  for (let i = 0; s.length < n - 1; i++) s += `${tag}${i} `;
  return `${s.slice(0, n - 1)}\n`;
}
// What the cut keeps of everything the child wrote: its last 4 KB.
const last4k = (s) => s.slice(-KEEP);
// What the child wrote before each case's first cut.
const BEFORE = text('a', 5000);

async function until(predicate, tries = 400) {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return false;
}

/**
 * One routine run whose first child is a stand-in that writes only when the
 * test does. `drive` is handed:
 *
 *   write(text)        what the child writes to its stderr, through the
 *                      descriptor the scheduler gave it;
 *   cut(looks, reads)  one tick of the cut's interval. `looks` maps a look at
 *                      the size (0 decides whether to cut, 1 to 3 come after
 *                      a tail is read) to text the child writes just before
 *                      that look, or to THROWS. `reads` maps a tail read (0 is
 *                      the first of the cut) to THROWS. Returns how many looks
 *                      the cut took;
 *   onDisk()           what the capture file holds now;
 *   end(code)          the child exits, and the run is waited out.
 *
 * With `seam: false` the scheduler keeps its own size reader and tail reader,
 * and cut() counts nothing; what the ending read is still handed over.
 *
 * Returns the run's record, the number of children started, whether the
 * capture file outlived the run, and `said`, the bytes the ending read back
 * for the first child. The spawn and the stop signaller are stood in for the
 * way test/unit/scheduler-lib.test.js does it: lib/scheduler.js destructures
 * both at load, so a private copy required after the swap closes over the
 * stand-ins, and the shared instance never sees them.
 */
async function aRun(t, drive, { seam = true } = {}) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-cut-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-cut-home-'));
  const prevWorkspace = config.getWorkspace();
  const prevHome = Object.prototype.hasOwnProperty.call(process.env, 'HOME') ? process.env.HOME : null;
  config.setWorkspace(ws);
  // No transcript exists in a home of its own, so a child that exits at once
  // reads as one that never started a session, which is half of a refusal.
  process.env.HOME = home;

  const claude = require(CLAUDE_KEY);
  const realSpawn = claude.spawnClaude;
  const realKill = claude.killProcessTree;
  const prevClaudeDeps = claude.wireClaudeRuntimeDeps({ getActualPort: () => 0 });
  const children = [];
  const signalled = [];
  claude.spawnClaude = (args, options) => {
    const child = new EventEmitter();
    children.push({ fd: options.stdio[2], child });
    // The plain session a refused run falls back to ends by itself.
    if (children.length > 1) setImmediate(() => child.emit('close', 0));
    return child;
  };
  claude.killProcessTree = (...how) => { signalled.push(how); };

  const cached = require.cache[SCHEDULER_KEY];
  try {
    delete require.cache[SCHEDULER_KEY];
    const sched = require(SCHEDULER_KEY);
    delete require.cache[SCHEDULER_KEY];
    if (cached) require.cache[SCHEDULER_KEY] = cached;

    let lookSteps = {};
    let readSteps = {};
    let looks = 0;
    let reads = 0;
    const taken = [];
    const wiring = { getWssClients: () => [], captureTaken: (said) => { taken.push(said); } };
    if (seam) {
      wiring.captureSize = (fd) => {
        const step = lookSteps[looks++];
        if (step === THROWS) throw new Error('the size could not be read');
        if (step) fs.writeSync(fd, step);
        return fs.fstatSync(fd).size;
      };
      wiring.captureRead = (fd, buf, position) => {
        if (readSteps[reads++] === THROWS) throw new Error('the tail could not be read');
        return fs.readSync(fd, buf, 0, buf.length, position);
      };
    }
    sched.wireSchedulerDeps(wiring);

    sched.executeRoutine(AGENT, ROUTINE, KEY);
    const [first] = children;
    assert.ok(first && typeof first.fd === 'number', 'the child was given a file for its stderr');
    const [live] = sched.runningRuns();
    const file = path.join(ws, '.rundock', 'runs', `${live.id}.stderr`);
    const ended = () => sched.routineState[KEY] && sched.routineState[KEY].status !== 'running';

    await drive({
      write: (s) => fs.writeSync(first.fd, s),
      cut: (atLooks = {}, atReads = {}) => {
        lookSteps = atLooks;
        readSteps = atReads;
        looks = 0;
        reads = 0;
        t.mock.timers.tick(EVERY_MS);
        lookSteps = {};
        readSteps = {};
        return looks;
      },
      onDisk: () => fs.readFileSync(file, 'utf8'),
      end: async (code) => {
        first.child.emit('close', code);
        assert.ok(await until(ended), 'the run ended');
      },
    });
    assert.ok(ended(), 'every case ends its run');
    assert.deepStrictEqual(signalled, [], 'nothing was stopped, so nothing was signalled');
    assert.strictEqual(taken.length, children.length, 'the ending read back each child\'s capture once');
    const runs = path.join(ws, '.rundock', 'runs');
    const [record] = fs.readdirSync(runs).filter((n) => n.endsWith('.json'))
      .map((n) => JSON.parse(fs.readFileSync(path.join(runs, n), 'utf8')));
    return { record, children: children.length, captureLeft: fs.existsSync(file), said: taken[0] };
  } finally {
    claude.spawnClaude = realSpawn;
    claude.killProcessTree = realKill;
    claude.wireClaudeRuntimeDeps(prevClaudeDeps);
    config.setWorkspace(prevWorkspace);
    if (prevHome === null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// The bytes the ending read back are exactly `expected`, and, when they end
// in the refusal, the run fell back once with the refusal quoted.
function readBack(outcome, expected, why) {
  assert.strictEqual(outcome.said, expected, why);
  assert.strictEqual(outcome.captureLeft, false, 'and the capture went with the run');
  if (!expected.endsWith(REFUSAL)) return;
  assert.strictEqual(outcome.children, 2, `${why}: the agent, refused, then one plain session`);
  assert.match(outcome.record.notice || '', READ_IT, `${why}: and the record quotes the refusal`);
}

// ===== A WRITE THAT LANDS WHILE THE FILE IS BEING CUT =====

test('with no growth, the cut looks once more, finds the same size, and keeps the last 4 KB', async (t) => {
  const wrote = BEFORE + REFUSAL;
  const outcome = await aRun(t, async (run) => {
    run.write(wrote);
    assert.strictEqual(run.cut(), 2, 'one look finds more than 4 KB, and one more finds the same size');
    assert.strictEqual(run.onDisk(), '', 'so the file was emptied');
    await run.end(1);
  });
  readBack(outcome, last4k(wrote), 'the bytes kept are the last 4 KB the child wrote, every one of them');
});

test('a write that lands after the tail is first read is kept: the tail kept is the last 4 KB at the final look', async (t) => {
  const during = text('b', 300) + REFUSAL;
  const atFirstLook = last4k(BEFORE);
  const atFinalLook = last4k(BEFORE + during);
  assert.notStrictEqual(atFinalLook, atFirstLook, 'the two tails differ, so which one was kept can be told');
  const outcome = await aRun(t, async (run) => {
    run.write(BEFORE);
    assert.strictEqual(run.cut({ 1: during }), 3,
      'the first look after the tail sees the file grown, and the next finds it the same size');
    assert.strictEqual(run.onDisk(), '', 'the file was emptied after the growth, not before it');
    await run.end(1);
  });
  readBack(outcome, atFinalLook,
    'the bytes kept are the last 4 KB the file held at the final look, not the tail read before the growth');
});

// The retry: the file goes on growing at every look the cut is allowed.
test('growth on every look ends in one cut after the third, keeping the last 4 KB at the last look', async (t) => {
  const grew = [text('c', 100), text('d', 200), text('e', 150) + REFUSAL];
  const atLook2 = last4k(BEFORE + grew[0] + grew[1]);
  const atLook3 = last4k(BEFORE + grew.join(''));
  assert.notStrictEqual(atLook3, atLook2, 'the last two tails differ, so which one was kept can be told');
  const outcome = await aRun(t, async (run) => {
    run.write(BEFORE);
    assert.strictEqual(run.cut({ 1: grew[0], 2: grew[1], 3: grew[2] }), 4,
      'the look that decides, then the three looks after it, each finding the file grown');
    assert.strictEqual(run.onDisk(), '', 'and the cut still happened, once, at the end of them');
    assert.strictEqual(run.cut(), 1, 'the next tick finds the file under 4 KB and leaves it');
    await run.end(1);
  });
  readBack(outcome, atLook3, 'the bytes kept are the tail read at the third look, after the last growth');
});

// ===== WHAT THE CUT KEEPS, AND WHAT THE ENDING READS =====

// The inverse: a capture at or under 4 KB is never cut.
test('a capture that never passes 4 KB is never cut, and the ending reads all of it', async (t) => {
  const whole = REFUSAL + text('f', KEEP - REFUSAL.length);
  assert.strictEqual(Buffer.byteLength(whole), KEEP, 'exactly 4 KB, the most a capture holds uncut');
  const outcome = await aRun(t, async (run) => {
    run.write(whole);
    for (let i = 0; i < 3; i++) assert.strictEqual(run.cut(), 1, 'one look each time, which finds nothing to cut');
    assert.strictEqual(run.onDisk(), whole, 'the file still holds every byte the child wrote');
    await run.end(1);
  });
  readBack(outcome, whole, 'the ending read the whole capture, from its first byte to its last');
  assert.strictEqual(outcome.children, 2, 'and found its first line, the refusal');
  assert.match(outcome.record.notice || '', READ_IT);
});

// The undo: what a cut took out of the file is in memory, and the file starts
// again from empty, so the two together are the child's writes in order. The
// refusal is split across the cut, so the line is there only if they are.
test('after a cut, a child that writes under 4 KB more has the kept tail and the new bytes, in order', async (t) => {
  const start = "--agent 'Runner' not fo";
  const rest = 'und. Available agents: claude, Explore\n';
  assert.strictEqual(start + rest, REFUSAL);
  const kept = last4k(BEFORE + start);
  const outcome = await aRun(t, async (run) => {
    run.write(BEFORE + start);
    assert.strictEqual(run.cut(), 2);
    assert.strictEqual(run.onDisk(), '', 'the cut emptied the file');
    run.write(rest);
    assert.strictEqual(run.onDisk(), rest, 'the next write starts the file again, alone in it');
    assert.strictEqual(run.cut(), 1, 'and is under 4 KB, so nothing more is cut');
    assert.strictEqual(run.onDisk(), rest);
    await run.end(1);
  });
  readBack(outcome, kept.slice(rest.length) + rest,
    'exactly the kept tail followed by the new bytes, as much of the tail as still fits in 4 KB');
  assert.strictEqual(outcome.said, last4k(BEFORE + REFUSAL), 'which is the last 4 KB the child wrote, in order');
});

// The most common next step: the child ends soon after a cut.
test('a run that ends after a cut reads the kept tail followed by what the file holds now', async (t) => {
  const before = text('g', 6000);
  const kept = last4k(before);
  const outcome = await aRun(t, async (run) => {
    run.write(before);
    assert.strictEqual(run.cut(), 2);
    run.write(REFUSAL);
    assert.strictEqual(run.onDisk(), REFUSAL, 'the refusal is in the file, after the cut');
    await run.end(1);
  });
  readBack(outcome, kept.slice(REFUSAL.length) + REFUSAL,
    'the kept tail, then what the file held, cut to the last 4 KB of the two together');
});

// ===== A LOOK OR A READ THAT FAILS =====

// The control failing: a cut that cannot look at the size or read the tail
// gives up, with the file as it was, and the next tick tries again.
const GREW = text('h', 300) + REFUSAL;
for (const [which, first, atLooks, atReads, looks] of [
  ['the look that decides whether to cut throws', BEFORE + REFUSAL, { 0: THROWS }, {}, 1],
  ['a look after the tail was read throws', BEFORE + REFUSAL, { 1: THROWS }, {}, 2],
  ['the tail read throws', BEFORE + REFUSAL, {}, { 0: THROWS }, 1],
  ['the tail read after the file grew throws', BEFORE, { 1: GREW }, { 1: THROWS }, 2],
]) {
  test(`when ${which}, the file is left as it was and the next look cuts it`, async (t) => {
    const wrote = first + (atLooks[1] === GREW ? GREW : '');
    const outcome = await aRun(t, async (run) => {
      run.write(first);
      assert.strictEqual(run.cut(atLooks, atReads), looks, 'the cut stopped where it failed');
      assert.strictEqual(run.onDisk(), wrote, 'and left every byte where it was, growth included');
      assert.strictEqual(run.cut(), 2, 'the next tick looks again');
      assert.strictEqual(run.onDisk(), '', 'and cuts');
      await run.end(1);
    });
    readBack(outcome, last4k(wrote), 'the tail kept by the cut that worked is the last 4 KB the child wrote');
  });
}

for (const [which, atLooks, atReads] of [
  ['a look', { 1: THROWS }, {}],
  ['a tail read', {}, { 0: THROWS }],
]) {
  test(`a run that ends straight after ${which} threw reads the file whole`, async (t) => {
    const wrote = BEFORE + REFUSAL;
    const outcome = await aRun(t, async (run) => {
      run.write(wrote);
      run.cut(atLooks, atReads);
      assert.strictEqual(run.onDisk(), wrote, 'nothing was cut');
      await run.end(1);
    });
    readBack(outcome, last4k(wrote), 'the ending read the last 4 KB of the file the failure left alone');
  });
}

// ===== THE SEAM ITSELF =====

test('left unwired, the cut reads the real size and the real tail of the file', async (t) => {
  const wrote = BEFORE + REFUSAL;
  const outcome = await aRun(t, async (run) => {
    run.write(wrote);
    run.cut();
    assert.strictEqual(run.onDisk(), '', 'the scheduler\'s own reader saw more than 4 KB, and the file was cut');
    await run.end(1);
  }, { seam: false });
  readBack(outcome, last4k(wrote), 'the scheduler\'s own reads kept the last 4 KB');
});

test('nothing outside the tests names the seams, so the server leaves them at the real reads', () => {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((f) => /\.(c|m)?js$/.test(f) && !f.startsWith('test/') && !f.startsWith('node_modules/'));
  assert.ok(tracked.includes('server.js') && tracked.length > 100,
    `only ${tracked.length} source files were listed; the walk has gone blind`);
  const sources = tracked.map((f) => [f, fs.readFileSync(path.join(ROOT, f), 'utf8')]);
  for (const seam of ['captureSize', 'captureRead', 'captureTaken']) {
    assert.deepStrictEqual(sources.filter(([, src]) => src.includes(seam)).map(([f]) => f), ['lib/scheduler.js'],
      `the scheduler declares and uses ${seam}, and no other source file wires it`);
  }
});
