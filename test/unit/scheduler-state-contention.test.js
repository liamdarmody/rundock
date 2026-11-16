'use strict';
// A reader in another process never sees a state file part written.
//
// Inside one process the scheduler's writes and reads are synchronous and
// cannot interleave, so the window is a second process: a second Rundock on
// the workspace, or anything else that reads the file while it is being
// replaced. Driven deliberately rather than by waiting for load: a child
// process rewrites the routine state, the slot file and the pid file through
// the real writers, as fast as it can, while this process reads and parses all
// three in a tight loop until the child says it is done.
//
// Rewritten in place, as they were, the same loop met an empty or half file in
// about one read in twenty on macOS. Replaced whole, it must meet none.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const WRITES = 400;
const ROUTINES = 40;

// The child: one workspace, forty routines' state, slots and child pids, each
// file rewritten WRITES times with a field that changes, so every write is a
// real replacement of bytes a reader might be holding.
const CHILD = `
const fs = require('fs');
const path = require('path');
const [ws, done, writes, routines] = process.argv.slice(1);
require(${JSON.stringify(path.join(ROOT, 'lib', 'config.js'))}).setWorkspace(ws);
const sched = require(${JSON.stringify(path.join(ROOT, 'lib', 'scheduler.js'))});
const claude = require(${JSON.stringify(path.join(ROOT, 'lib', 'runtime', 'claude.js'))});
const pids = [];
for (let r = 0; r < Number(routines); r++) {
  const key = 'agent-' + r + ':routine number ' + r + ' with a name of ordinary length';
  sched.routineState[key] = { lastRun: new Date(Date.UTC(2026, 6, 1, 8, r)).toISOString(), status: 'completed', duration: r };
  sched.routineSlots.routines[key] = { due: new Date(Date.UTC(2026, 6, 2, 8, r)).toISOString(), schedule: 'daily:09:00', missed: [], since: '2026-06-01T08:00:00.000Z' };
  pids.push({ pid: 50000 + r, at: Date.now(), cmd: 'claude' });
}
for (let i = 0; i < Number(writes); i++) {
  const stamp = new Date(Date.UTC(2026, 6, 1, 9, 0, i % 60, i % 1000)).toISOString();
  sched.routineState['agent-0:routine number 0 with a name of ordinary length'].duration = i;
  sched.routineSlots.observedAt = stamp;
  pids[0].at = i;
  sched.saveRoutineState();
  sched.saveRoutineSlots();
  claude.savePidFile(pids);
}
fs.writeFileSync(done, String(writes));
process.exit(0);
`;

test('a second process reading the state files while they are rewritten never meets one part written', { timeout: 120000 }, async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-state-contention-'));
  const rundock = path.join(ws, '.rundock');
  const files = ['routine-state.json', 'routine-slots.json', 'child-pids.json'].map(n => path.join(rundock, n));
  const done = path.join(ws, 'writer-done');
  const child = spawn(process.execPath, ['-e', CHILD, ws, done, String(WRITES), String(ROUTINES)],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  const exited = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
  try {
    // Wait for the first write of each, so every read below finds a file.
    const deadline = Date.now() + 30000;
    while (!files.every(f => fs.existsSync(f)) && !fs.existsSync(done) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 5));
    }
    assert.ok(files.every(f => fs.existsSync(f)), `the writer never wrote all three files:\n${stderr}`);

    // Synchronous on purpose: nothing in this process runs between two reads.
    let reads = 0;
    let duringWrites = 0;
    const bad = [];
    const stop = Date.now() + 90000;
    while (Date.now() < stop) {
      const writing = !fs.existsSync(done);
      for (const file of files) {
        reads++;
        if (writing) duringWrites++;
        try {
          JSON.parse(fs.readFileSync(file, 'utf-8'));
        } catch (e) {
          if (bad.length < 5) bad.push(`${path.basename(file)}: ${e.message}`);
          else bad.push(null);
        }
      }
      if (!writing) break;
    }
    const result = await exited;
    assert.deepStrictEqual(result, { code: 0, signal: null }, `the writer failed:\n${stderr}`);
    assert.strictEqual(fs.readFileSync(done, 'utf-8'), String(WRITES), 'the writer did not finish its writes');
    assert.strictEqual(bad.length, 0,
      `${bad.length} of ${reads} reads met a part-written file, for example:\n${bad.filter(Boolean).join('\n')}`);
    // And enough reads landed while the writer was going for none to mean
    // something.
    assert.ok(duringWrites >= 300, `only ${duringWrites} of ${reads} reads overlapped the writes`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
