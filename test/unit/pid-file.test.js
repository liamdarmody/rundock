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
const { pidRecordAlive } = srv._internal;

describe('child pid records', () => {
  test('a live process spawned as the recorded command is recognised', async () => {
    const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' });
    try {
      const rec = { pid: kid.pid, at: Date.now(), cmd: path.basename(process.execPath) };
      assert.strictEqual(pidRecordAlive(rec), true, 'our own live child must be recognised');
    } finally {
      try { kid.kill('SIGKILL'); } catch (e) {}
    }
  });

  test('a pid running a DIFFERENT command is refused, so a recycled pid is not signalled', () => {
    const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' });
    try {
      // Same live pid, but recorded as something we never spawned it as.
      const rec = { pid: kid.pid, at: Date.now(), cmd: 'definitely-not-this-binary' };
      assert.strictEqual(pidRecordAlive(rec), false,
        'a pid whose command does not match the record must not be treated as ours');
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
