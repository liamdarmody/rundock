'use strict';
// Unit: the tracked child-pid list must not forget a process it has not
// confirmed is gone, and must not signal a pid the OS has recycled.
//
// killAllChildren used to send SIGTERM and clear the file in the same tick,
// with no wait and no escalation. Any child that was slow to exit, or that
// ignored the signal, became untracked and could never be reaped on a later
// launch. The file also held bare integers, so a recycled pid belonging to an
// unrelated process was indistinguishable from one of ours.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawn } = require('node:child_process');

const srv = require('../../server.js');

const { pidRecordAlive, processCommand } = srv._internal;

/**
 * Spawn a long-lived child and wait until it genuinely exists.
 *
 * The 'spawn' event is not enough. It fires when the fork has happened, and on
 * macOS `ps -p <pid> -o args=` reports an EMPTY command line between the fork
 * and the exec: measured here, 30 spawns out of 30 read empty at that moment.
 * commandsMatch treats an empty command as unknown and answers true, so a test
 * that asks whether a MISMATCHED record is refused gets true and fails, on a
 * race that has nothing to do with what it is testing. Whether the race is lost
 * depends on how much work happens between the spawn and the lookup, which is
 * why the suite could pass for a long time and then fail on an unrelated commit
 * that changed nothing but its own timing.
 *
 * So wait for what the assertion actually depends on: a command line the
 * platform can read back.
 */
async function liveChild() {
  const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    kid.once('spawn', resolve);
    kid.once('error', reject);
  });
  const deadline = Date.now() + 5000;
  while (!processCommand(kid.pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return kid;
}

describe('child pid records', () => {
  test('a live process spawned as the recorded command is recognised', async () => {
    const kid = await liveChild();
    try {
      const rec = { pid: kid.pid, at: Date.now(), cmd: path.basename(process.execPath) };
      // Report what the platform actually said. `ps -o comm=` differs by OS and
      // has differed by Node version, so a bare true/false failure here is not
      // diagnosable from a CI log.
      assert.strictEqual(pidRecordAlive(rec), true,
        'our own live child must be recognised. '
        + `execPath=${process.execPath} recorded=${rec.cmd} `
        + `ps=${JSON.stringify(processCommand(kid.pid))} alive=${(() => { try { process.kill(kid.pid, 0); return true; } catch (e) { return false; } })()}`);
    } finally {
      try { kid.kill('SIGKILL'); } catch (e) {}
    }
  });

  // Windows has no cheap command lookup, so the guard is deliberately skipped
  // there and an unverifiable record is assumed to be ours: leaking a process
  // is worse than a redundant signal. Asserting the POSIX behaviour on Windows
  // would report a designed difference as a defect.
  const guardActive = process.platform !== 'win32';

  test('a pid running a DIFFERENT command is refused, so a recycled pid is not signalled', async () => {
    const kid = await liveChild();
    try {
      // Same live pid, but recorded as something we never spawned it as.
      const rec = { pid: kid.pid, at: Date.now(), cmd: 'definitely-not-this-binary' };
      assert.strictEqual(pidRecordAlive(rec), guardActive ? false : true,
        guardActive
          ? 'a pid whose command does not match the record must not be treated as ours'
          : 'on a platform without a command lookup the record is assumed ours, never discarded');
    } finally {
      try { kid.kill('SIGKILL'); } catch (e) {}
    }
  });

  test('a dead pid is not alive', () => {
    assert.strictEqual(pidRecordAlive({ pid: 2147480000, cmd: 'node' }), false);
  });

  test('legacy bare-integer records are still read, without the recycling guard', () => {
    assert.strictEqual(pidRecordAlive(process.pid), true, 'the current process is alive');
    assert.strictEqual(pidRecordAlive(2147480000), false, 'a dead bare pid is not alive');
  });
});
