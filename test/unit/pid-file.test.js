'use strict';
// Unit: the tracked child-pid list must not forget a process it has not
// confirmed is gone, and must not signal a pid the OS has recycled.
//
// killAllChildren used to send SIGTERM and clear the file in the same tick,
// with no wait and no escalation. Any child that was slow to exit, or that
// ignored the signal, became untracked and could never be reaped on a later
// launch. The file also held bare integers, so a recycled pid belonging to an
// unrelated process was indistinguishable from one of ours.
//
// The guard needs a process's COMMAND LINE, and there are two ways to get one.
// Reading /proc/<pid>/cmdline spawns nothing and therefore survives a command
// sandbox; `ps -p <pid> -o args=` spawns and is blocked by one. Where neither
// works the guard is genuinely weaker (it assumes an unverifiable record is
// ours), so the tests that need the lookup SKIP with the missing capability
// named, and the tests that pin the degraded behaviour run everywhere.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawn } = require('node:child_process');

const srv = require('../../server.js');

/** Spawn a long-lived child and wait until it genuinely exists. */
async function liveChild() {
  const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    kid.once('spawn', resolve);
    kid.once('error', reject);
  });
  return kid;
}
const { pidRecordAlive, processCommand, readProcCmdline, parseProcCmdline, psCommand, commandLineCapability } = srv._internal;

// Decided once, at load, so a skip can name what is missing rather than
// reporting an environment as a defect.
const capability = commandLineCapability();
const noLookup = capability.ok ? false : `missing capability: ${capability.missing}`;
const procWorks = readProcCmdline(process.pid) != null;
const psWorks = psCommand(process.pid) != null;
const noComparison = procWorks && psWorks ? false : 'missing capability: '
  + [!procWorks && 'the non-spawning source /proc/<pid>/cmdline is unreadable here',
     !psWorks && 'the spawning source `ps -p <pid> -o args=` is unavailable here'].filter(Boolean).join(', and ');

describe('child pid records', () => {
  test('a live process spawned as the recorded command is recognised', async () => {
    const kid = await liveChild();
    try {
      const rec = { pid: kid.pid, at: Date.now(), cmd: path.basename(process.execPath) };
      // Report what the platform actually said. The command line differs by OS
      // and has differed by Node version, so a bare true/false failure here is
      // not diagnosable from a CI log.
      assert.strictEqual(pidRecordAlive(rec), true,
        'our own live child must be recognised. '
        + `execPath=${process.execPath} recorded=${rec.cmd} `
        + `command=${JSON.stringify(processCommand(kid.pid))} alive=${(() => { try { process.kill(kid.pid, 0); return true; } catch (e) { return false; } })()}`);
    } finally {
      try { kid.kill('SIGKILL'); } catch (e) {}
    }
  });

  // THE MEASUREMENT the whole non-spawning path rests on. The two sources must
  // agree, character for character, INCLUDING how arguments are separated:
  // /proc gives NUL-separated argv, `ps -o args=` gives them joined by spaces,
  // and a wrong join here would show up as a guard that quietly stops matching.
  //
  // It also pins WHAT the value is. A thread name ("MainThread" on Node 24) or
  // an executable name ("node", or a full path on macOS) cannot contain the
  // script text this child was spawned with; a command line must.
  test('the non-spawning source gives the same command line as ps, not a thread or executable name', { skip: noComparison }, async (t) => {
    const kid = await liveChild();
    try {
      const viaProc = readProcCmdline(kid.pid);
      const viaPs = psCommand(kid.pid);
      t.diagnostic(`platform=${process.platform} node=${process.version}`);
      t.diagnostic(`/proc/<pid>/cmdline  -> ${JSON.stringify(viaProc)}`);
      t.diagnostic(`ps -p <pid> -o args= -> ${JSON.stringify(viaPs)}`);
      assert.strictEqual(viaProc, viaPs, 'the two sources must yield the identical string');
      assert.ok(String(viaProc).includes('setInterval'),
        `the value must be the command line, not a thread or executable name. got ${JSON.stringify(viaProc)}`);
      assert.strictEqual(processCommand(kid.pid), viaProc,
        'processCommand must return the non-spawning value where one is available');
    } finally {
      try { kid.kill('SIGKILL'); } catch (e) {}
    }
  });

  test('a pid running a DIFFERENT command is refused, so a recycled pid is not signalled', { skip: noLookup }, async () => {
    const kid = await liveChild();
    try {
      // Same live pid, but recorded as something we never spawned it as.
      const rec = { pid: kid.pid, at: Date.now(), cmd: 'definitely-not-this-binary' };
      assert.strictEqual(pidRecordAlive(rec), false,
        'a pid whose command does not match the record must not be treated as ours. '
        + `source=${capability.source} command=${JSON.stringify(processCommand(kid.pid))}`);
    } finally {
      try { kid.kill('SIGKILL'); } catch (e) {}
    }
  });

  // The same discrimination with the OS taken out of it, so the matching logic
  // is covered on every machine including the ones that cannot read a command
  // line at all. The reader is the seam; everything else is the real guard.
  test('the match is made against the command line the reader returns', () => {
    const rec = { pid: process.pid, at: Date.now(), cmd: 'definitely-not-this-binary' };
    assert.strictEqual(pidRecordAlive(rec, () => '/usr/bin/some-other-thing --flag'), false,
      'a foreign command line must be refused');
    assert.strictEqual(pidRecordAlive({ ...rec, cmd: 'some-other-thing' }, () => '/usr/bin/some-other-thing --flag'), true,
      'our own command line must be accepted');
  });

  // The honesty of the degraded case, pinned rather than described. When no
  // command line can be read the record is ASSUMED OURS: leaking a tracked
  // process forever is worse than a redundant signal. Changing this to discard
  // unverifiable records would silently un-track every child on a machine with
  // no lookup, which is exactly what a sandbox produces.
  test('with no readable command line the record is assumed ours, never discarded', () => {
    const rec = { pid: process.pid, at: Date.now(), cmd: 'definitely-not-this-binary' };
    assert.strictEqual(pidRecordAlive(rec, () => null), true,
      'an unverifiable record must be kept, not dropped');
  });

  // The capability report is what a skip's reason and any caller's decision are
  // built from, so it is pinned on every platform rather than only where one of
  // the sources happens to answer.
  test('the capability report names the source that answered, or both that did not', () => {
    const none = commandLineCapability(() => null, () => null);
    assert.strictEqual(none.ok, false);
    assert.strictEqual(none.source, null);
    assert.match(String(none.missing), /\/proc\/<pid>\/cmdline/, 'the missing report must name the non-spawning source');
    assert.match(String(none.missing), /ps -p <pid> -o args=/, 'the missing report must name the spawning source');

    const free = commandLineCapability(() => '/x/node -e code', () => 'ps would have said this');
    assert.deepStrictEqual(free, { ok: true, source: '/proc/<pid>/cmdline', missing: null },
      'the non-spawning source is preferred when it answers');

    const spawned = commandLineCapability(() => null, () => '/x/node -e code');
    assert.deepStrictEqual(spawned, { ok: true, source: 'ps -p <pid> -o args=', missing: null },
      'the spawning source remains for platforms with no other');
  });

  // The separator question, covered on every machine including the ones with no
  // procfs to read. What /proc hands over is argv with a NUL after every
  // argument INCLUDING the last; what the guard needs is the same string `ps -o
  // args=` prints. Getting this wrong yields a command line that matches
  // nothing, which looks like every record being foreign.
  test('argv separated by NULs becomes the space-joined command line', () => {
    assert.strictEqual(parseProcCmdline('/usr/bin/node\0-e\0setInterval(() => {}, 1e9)\0'),
      '/usr/bin/node -e setInterval(() => {}, 1e9)', 'NULs become single spaces and the trailing one goes');
    assert.strictEqual(parseProcCmdline('/usr/bin/node\0'), '/usr/bin/node', 'a one-argument command line survives');
    assert.strictEqual(parseProcCmdline('/usr/bin/node\0-e\0x'), '/usr/bin/node -e x', 'a missing trailing NUL is not a missing argument');
    assert.strictEqual(parseProcCmdline(''), null, 'an empty cmdline is no answer, not an empty command line');
    assert.strictEqual(parseProcCmdline('\0\0'), null, 'nor is one that is all separator');
  });

  // AC of the whole card: where the command line can be read without spawning,
  // it IS read that way. Unobservable in the value, because both sources return
  // the identical string wherever both work: a mutant that asks ps first passed
  // the entire suite on Linux. What distinguishes them is the spawn, so that is
  // what this observes.
  test('nothing is spawned when the command line can be read without it', () => {
    let spawns = 0;
    const value = processCommand(process.pid, () => '/x/node -e code', () => { spawns++; return '/x/node -e code'; });
    assert.strictEqual(value, '/x/node -e code');
    assert.strictEqual(spawns, 0, 'the spawning source must not be reached when the free one answered');

    let fallbacks = 0;
    const viaPs = processCommand(process.pid, () => null, () => { fallbacks++; return '/x/node -e code'; });
    assert.strictEqual(viaPs, '/x/node -e code', 'and it must still be reached when the free one cannot answer');
    assert.strictEqual(fallbacks, 1);
  });

  // Neither reader may invent an answer for a process that is not there. A '' or
  // a stray value here would match every record through the deliberately loose
  // comparison, which is the exact failure the guard exists to prevent.
  test('a pid that does not exist yields no command line from either source', () => {
    assert.strictEqual(readProcCmdline(2147480000), null, 'the non-spawning source must say nothing');
    assert.strictEqual(psCommand(2147480000), null, 'the spawning source must say nothing');
    assert.strictEqual(processCommand(2147480000), null, 'and so must the reader that picks between them');
  });

  test('a dead pid is not alive', () => {
    assert.strictEqual(pidRecordAlive({ pid: 2147480000, cmd: 'node' }), false);
  });

  test('legacy bare-integer records are still read, without the recycling guard', () => {
    assert.strictEqual(pidRecordAlive(process.pid), true, 'the current process is alive');
    assert.strictEqual(pidRecordAlive(2147480000), false, 'a dead bare pid is not alive');
  });
});
