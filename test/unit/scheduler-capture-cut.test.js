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
// ticks and at no other time, and every look at the size goes through
// deps.captureSize, which the test wires: on the look it chooses, the stand-in
// child writes just before the size is read, or the read throws. Every run
// takes the same path through the cut.
//
// WHAT IS ASSERTED IS WHAT THE CUT IS FOR. Claude Code's refusal to load an
// agent file is the last line it writes, and the run reads it from the end of
// the capture to decide whether to fall back to a plain session. So the
// refusal is placed where each case puts it (before the cut, during it, split
// across it, after it) and the run is ended: the record's notice quoting it
// says the line survived the cut, and a run recorded as failed without one
// says it was lost. The file on disk is read between looks for what the cut
// did to it.
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
// that no longer matches, which is every test below.
const KEEP = 4096;
const EVERY_MS = 50;

const AGENT = { id: 'runner', name: 'Runner', fileName: 'runner.md', description: 'Runs' };
const ROUTINE = { name: 'r', prompt: 'p' };
const KEY = 'runner:r';
// The line Claude Code writes when it cannot load the agent, and what the
// run's record says when the ending read it.
const REFUSAL = "--agent 'Runner' not found. Available agents: claude, Explore\n";
const READ_IT = /Claude Code said: --agent 'Runner' not found\./;
// A look at the size that throws, as an fstat can.
const THROWS = Symbol('the look throws');

// `n` bytes of something else on one line, ending in a newline.
const noise = (n) => `${'x'.repeat(n - 1)}\n`;

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
 *   write(text)  what the child writes to its stderr, through the descriptor
 *                the scheduler gave it;
 *   cut(steps)   one tick of the cut's interval. `steps` maps a look (0 is
 *                the look that decides whether to cut, 1 to 3 the looks
 *                after the tail is read) to text the child writes just before
 *                that look reads the size, or to THROWS. Returns how many
 *                looks the cut took;
 *   onDisk()     what the capture file holds now;
 *   end(code)    the child exits, and the run is waited out.
 *
 * With `seam: false` the scheduler is left with its own size reader, and
 * cut() counts nothing.
 *
 * Returns the run's record, the number of children started, and whether the
 * capture file outlived the run. The spawn and the stop signaller are stood
 * in for the way test/unit/scheduler-lib.test.js does it: lib/scheduler.js
 * destructures both at load, so a private copy required after the swap closes
 * over the stand-ins, and the shared instance never sees them.
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

    let steps = {};
    let looks = 0;
    const wiring = { getWssClients: () => [] };
    if (seam) {
      wiring.captureSize = (fd) => {
        const step = steps[looks++];
        if (step === THROWS) throw new Error('the size could not be read');
        if (step) fs.writeSync(fd, step);
        return fs.fstatSync(fd).size;
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
      write: (text) => fs.writeSync(first.fd, text),
      cut: (next = {}) => {
        steps = next;
        looks = 0;
        t.mock.timers.tick(EVERY_MS);
        steps = {};
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
    const runs = path.join(ws, '.rundock', 'runs');
    const [record] = fs.readdirSync(runs).filter((n) => n.endsWith('.json'))
      .map((n) => JSON.parse(fs.readFileSync(path.join(runs, n), 'utf8')));
    return { record, children: children.length, captureLeft: fs.existsSync(file) };
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

// The run fell back once, with the refusal read from the capture.
function readTheRefusal(outcome, why) {
  assert.strictEqual(outcome.children, 2, `${why}: the agent, refused, then one plain session`);
  assert.match(outcome.record.notice || '', READ_IT, why);
  assert.strictEqual(outcome.captureLeft, false, 'and the capture went with the run');
}

// ===== A WRITE THAT LANDS WHILE THE FILE IS BEING CUT =====

test('with no growth, the cut looks once more, finds the same size, and empties the file', async (t) => {
  const outcome = await aRun(t, async (run) => {
    run.write(noise(5000) + REFUSAL);
    assert.strictEqual(run.cut(), 2, 'one look finds more than 4 KB, and one more finds the same size');
    assert.strictEqual(run.onDisk(), '', 'so the file was emptied');
    await run.end(1);
  });
  readTheRefusal(outcome, 'the refusal written before the cut was kept in memory');
});

test('a write that lands after the tail is first read is kept: the tail kept is the one read after it', async (t) => {
  const outcome = await aRun(t, async (run) => {
    run.write(noise(5000));
    assert.strictEqual(run.cut({ 1: REFUSAL }), 3,
      'the first look after the tail sees the file grown, and the next finds it the same size');
    assert.strictEqual(run.onDisk(), '', 'the file was emptied after the growth, not before it');
    await run.end(1);
  });
  readTheRefusal(outcome, 'the refusal written during the cut was in the tail kept, not lost with the file');
});

// The retry: the file goes on growing at every look the cut is allowed.
test('growth on every look ends in one cut after the third, keeping the last tail read', async (t) => {
  const outcome = await aRun(t, async (run) => {
    run.write(noise(5000));
    assert.strictEqual(run.cut({ 1: noise(100), 2: noise(200), 3: REFUSAL }), 4,
      'the look that decides, then the three looks after it, each finding the file grown');
    assert.strictEqual(run.onDisk(), '', 'and the cut still happened, once, at the end of them');
    assert.strictEqual(run.cut(), 1, 'the next tick finds the file under 4 KB and leaves it');
    await run.end(1);
  });
  readTheRefusal(outcome, 'what the child wrote at the last look was in the tail kept');
});

// ===== WHAT THE CUT KEEPS, AND WHAT THE ENDING READS =====

// The inverse: a capture at or under 4 KB is never cut.
test('a capture that never passes 4 KB is never cut, and the ending reads all of it', async (t) => {
  const whole = REFUSAL + noise(KEEP - REFUSAL.length);
  assert.strictEqual(Buffer.byteLength(whole), KEEP, 'exactly 4 KB, the most a capture holds uncut');
  const outcome = await aRun(t, async (run) => {
    run.write(whole);
    for (let i = 0; i < 3; i++) assert.strictEqual(run.cut(), 1, 'one look each time, which finds nothing to cut');
    assert.strictEqual(run.onDisk(), whole, 'the file still holds every byte the child wrote');
    await run.end(1);
  });
  readTheRefusal(outcome, 'the first line of the 4 KB, the refusal, was read at the end');
});

// The undo: what a cut took out of the file is in memory, and the file starts
// again from empty, so the two together are the child's writes in order. The
// refusal is split across the cut to show it: its start ends the kept tail and
// its end is the first thing the file holds after it.
test('after a cut, a child that writes under 4 KB more has the kept tail and the new bytes, in order', async (t) => {
  const start = "--agent 'Runner' not fo";
  const rest = 'und. Available agents: claude, Explore\n';
  assert.strictEqual(start + rest, REFUSAL);
  const outcome = await aRun(t, async (run) => {
    run.write(noise(5000) + start);
    assert.strictEqual(run.cut(), 2);
    assert.strictEqual(run.onDisk(), '', 'the cut emptied the file');
    run.write(rest);
    assert.strictEqual(run.onDisk(), rest, 'the next write starts the file again, alone in it');
    assert.strictEqual(run.cut(), 1, 'and is under 4 KB, so nothing more is cut');
    assert.strictEqual(run.onDisk(), rest);
    await run.end(1);
  });
  readTheRefusal(outcome, 'the kept tail and the bytes after it were joined, in that order, into the one line');
});

// The most common next step: the child ends soon after a cut.
test('a run that ends after a cut reads the kept tail followed by what the file holds now', async (t) => {
  const outcome = await aRun(t, async (run) => {
    run.write(noise(6000));
    assert.strictEqual(run.cut(), 2);
    run.write(REFUSAL);
    assert.strictEqual(run.onDisk(), REFUSAL, 'the refusal is in the file, after the cut');
    await run.end(1);
  });
  readTheRefusal(outcome, 'what the file held came after the kept tail, so it was the end of what was read');
});

// ===== A LOOK THAT FAILS =====

// The control failing: a look that throws gives up that cut, with the file as
// it was, and the next tick tries again.
for (const [which, steps, looks] of [
  ['the look that decides whether to cut', { 0: THROWS }, 1],
  ['a look after the tail was read', { 1: THROWS }, 2],
]) {
  test(`when ${which} throws, the file is left as it was and the next look cuts it`, async (t) => {
    const before = noise(5000) + REFUSAL;
    const outcome = await aRun(t, async (run) => {
      run.write(before);
      assert.strictEqual(run.cut(steps), looks, 'the cut stopped at the look that threw');
      assert.strictEqual(run.onDisk(), before, 'and left every byte where it was');
      assert.strictEqual(run.cut(), 2, 'the next tick looks again');
      assert.strictEqual(run.onDisk(), '', 'and cuts');
      await run.end(1);
    });
    readTheRefusal(outcome, 'nothing the child wrote was lost to the look that threw');
  });
}

test('a run that ends straight after a look threw reads the file whole', async (t) => {
  const outcome = await aRun(t, async (run) => {
    run.write(noise(5000) + REFUSAL);
    assert.strictEqual(run.cut({ 1: THROWS }), 2);
    await run.end(1);
  });
  readTheRefusal(outcome, 'the end of the file the throw left alone was read');
});

// ===== THE SEAM ITSELF =====

test('left unwired, the cut reads the real size of the file', async (t) => {
  const outcome = await aRun(t, async (run) => {
    run.write(noise(5000) + REFUSAL);
    run.cut();
    assert.strictEqual(run.onDisk(), '', 'the scheduler\'s own reader saw more than 4 KB, and the file was cut');
    await run.end(1);
  }, { seam: false });
  readTheRefusal(outcome, 'the tail the real reader kept held the refusal');
});

test('nothing outside the tests names the seam, so the server leaves it at the real reader', () => {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((f) => /\.(c|m)?js$/.test(f) && !f.startsWith('test/') && !f.startsWith('node_modules/'));
  assert.ok(tracked.includes('server.js') && tracked.length > 100,
    `only ${tracked.length} source files were listed; the walk has gone blind`);
  const naming = tracked.filter((f) => fs.readFileSync(path.join(ROOT, f), 'utf8').includes('captureSize'));
  assert.deepStrictEqual(naming, ['lib/scheduler.js'],
    'the scheduler declares and reads it, and no other source file wires it');
});
