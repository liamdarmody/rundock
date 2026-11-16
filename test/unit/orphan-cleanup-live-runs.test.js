'use strict';
// The orphan cleanup never signals the child of a routine run this process is
// still running, and decides that without reading the process table.
//
// THE FAULT. The cleanup reads the pid file of the workspace being opened and
// signals every record it judges alive. A routine's child is registered in that
// file like any other, so re-selecting the workspace a run started in, or going
// away and coming back, killed the run as an orphan of a previous session. The
// judgement "alive and still ours" reads a process command line, and where none
// can be read (a command sandbox that blocks `ps`, or Windows) the record is
// assumed ours. Either way the child was signalled, and whether it was rested on
// a reading the switch had no reason to need.
//
// WHAT IS PINNED. A run the scheduler still holds names the pid it was started
// as, and the cleanup skips that pid before the recycled-pid guard is asked
// anything. The guard's command reader is the cleanup's parameter, so a reader
// that records its calls shows the live run's pid never reaches it, both when
// the reader answers nothing (the side a sandbox gives) and when it answers
// with the child's own command line (the side a readable /proc gives). Beside
// it, a pid no run holds is asked about and signalled, so the reader is wired
// and the cleanup still reaps what it exists for.
//
// WHY THE SPAWN IS SWAPPED BEFORE THE SERVER LOADS. The scheduler takes
// spawnClaude from the runtime module when it loads, and server.js loads it
// once per process. Swapping the export first is the only way to hand the
// server's own scheduler a child this test owns, and node --test runs each
// file in a process of its own, so nothing else sees the swap. The stand-in is
// a real process, because the cleanup signals real process groups.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { makeTempDir } = require('../helpers/workspace.js');

const claude = require('../../lib/runtime/claude.js');
const LONG_LIVED = ['-e', 'setInterval(() => {}, 1e9)'];
const spawned = [];
// The stand-in registers itself in the pid file the way spawnClaude does: as
// the command it was spawned as, so the guard's own matching would call it
// ours whenever it can read a command line.
claude.spawnClaude = () => {
  const kid = spawn(process.execPath, LONG_LIVED, { stdio: 'ignore', detached: true });
  const file = claude.registerChildPid(kid.pid, process.execPath);
  kid.on('close', () => claude.unregisterChildPid(kid.pid, file));
  spawned.push(kid);
  return kid;
};

const srv = require('../../server.js');
const { cleanOrphanedProcesses, setWorkspace, stopScheduler, executeRoutine, loadPidFile } = srv._internal;
const scheduler = require('../../lib/scheduler.js');

const AGENT = { id: 'keeper', name: 'keeper' };
const ROUTINE = { name: 'keep-check', prompt: 'keep body', schedule: 'every day at 09:00' };
const KEY = 'keeper:keep-check';

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return false; }
}

async function until(predicate, ms = 4000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(r => setTimeout(r, 20));
  }
  return predicate();
}

// A process nobody holds, recorded in the same file as a leftover from a
// previous session would be.
async function leftover() {
  const kid = spawn(process.execPath, LONG_LIVED, { stdio: 'ignore', detached: true });
  await new Promise((resolve, reject) => { kid.once('spawn', resolve); kid.once('error', reject); });
  claude.registerChildPid(kid.pid, process.execPath);
  spawned.push(kid);
  return kid;
}

after(() => {
  for (const kid of spawned) { try { process.kill(-kid.pid, 'SIGKILL'); } catch (e) { try { kid.kill('SIGKILL'); } catch (e2) { /* gone */ } } }
});

test('the orphan cleanup never asks the process table about a live run\'s child, and never signals it', async () => {
  const dir = makeTempDir('orphan-cleanup-');
  setWorkspace(dir);
  stopScheduler();
  assert.strictEqual(executeRoutine(AGENT, ROUTINE, KEY, new Date(2026, 6, 1, 9, 30)), true, 'the run started');
  const child = spawned[spawned.length - 1];
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  assert.ok(loadPidFile().some(rec => rec.pid === child.pid),
    'the run\'s child is in the pid file the cleanup reads, as a routine\'s child always is');

  // The two sides of the process table, each with a command reader that
  // records what it was asked.
  const sides = [
    ['a reader that can read no command line', () => null],
    ['a reader that reads the child\'s own command line', () => `${process.execPath} ${LONG_LIVED.join(' ')}`],
  ];
  for (const [side, answer] of sides) {
    const other = await leftover();
    const asked = [];
    cleanOrphanedProcesses((pid) => { asked.push(pid); return answer(pid); });

    assert.ok(await until(() => !alive(other.pid)),
      `${side}: the leftover nobody holds was signalled, so the cleanup still reaps what it exists for`);
    assert.ok(alive(child.pid), `${side}: the live run's child survived the cleanup`);
    assert.ok(!asked.includes(child.pid),
      `${side}: the live run's pid was put to the command reader (asked about ${JSON.stringify(asked)})`);
    assert.ok(asked.includes(other.pid),
      `${side}: and the reader is the one the cleanup consults, because the leftover was put to it`);
    assert.ok(loadPidFile().some(rec => rec.pid === child.pid),
      `${side}: and its record stays in the file, for a later launch to reap if this process stops`);
  }

  // Ended by the test, so nothing outlives it: the run then closes as failed.
  process.kill(-child.pid, 'SIGKILL');
  assert.ok(await until(() => !scheduler.runningRuns().some(run => run.key === KEY)), 'the run ended');
  fs.rmSync(path.join(dir, '.rundock'), { recursive: true, force: true });
});
