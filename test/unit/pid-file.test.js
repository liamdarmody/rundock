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
async function liveChild(pad = '') {
  const kid = spawn(process.execPath, ['-e', `setInterval(() => {}, 1e9) //${pad}`], { stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    kid.once('spawn', resolve);
    kid.once('error', reject);
  });
  return kid;
}
const { pidRecordAlive, processCommand, readProcCmdline, parseProcCmdline, psCommand, commandLineCapability } = srv._internal;

// What this machine can do, decided once at load from the ONE report that owns
// both the probing and the names, so a skip names the missing source in the
// same words the product uses and a rename lands in one place.
const capability = commandLineCapability();
const [freeSource, spawningSource] = capability.sources;
const procWorks = freeSource.available;
const psWorks = spawningSource.available;
const absent = (...needed) => `missing capability: ${needed.filter(s => !s.available).map(s => s.name).join(' and ')} unreadable here`;
const noLookup = capability.ok ? false : `missing capability: ${capability.missing}`;
const noComparison = procWorks && psWorks ? false : absent(freeSource, spawningSource);
const noFreeSource = procWorks ? false : absent(freeSource);
const noSpawningSource = psWorks ? false : absent(spawningSource);

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

  // THE MEASUREMENT the whole non-spawning path rests on. For PRINTABLE argv the
  // two sources must agree, character for character, INCLUDING how arguments
  // are separated. Printable is the real limit and is measured below, not a
  // hedge:
  // /proc gives NUL-separated argv, `ps -o args=` gives them joined by spaces,
  // and a wrong join here would show up as a guard that quietly stops matching.
  //
  // It also pins WHAT the value is. A thread name ("MainThread" on Node 24) or
  // an executable name ("node", or a full path on macOS) cannot contain the
  // script text this child was spawned with; a command line must.
  test('for printable argv the non-spawning source gives the same command line as ps, not a thread or executable name', { skip: noComparison }, async (t) => {
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

  // WHERE THE TWO STOP AGREEING, measured after the equality above was claimed
  // too broadly. `ps` renders a command line for a human and escapes what a
  // human could not read: on Linux a newline becomes a space and a tab becomes
  // `?`, on macOS they become `\\012` and `\\011`. /proc returns the bytes as
  // spawned. This matters here rather than in theory, because a spawn from this
  // codebase carries an agent's system prompt in argv and prompts contain
  // newlines, so the real command lines are the disagreeing case.
  //
  // Asserted: that the non-spawning source is FAITHFUL, which is the property
  // the guard is given. The disagreement itself is printed rather than
  // asserted, so a `ps` that stops escaping does not fail a suite for improving.
  test('the non-spawning source returns argv as spawned, control characters and all', { skip: noFreeSource }, async (t) => {
    const script = 'setInterval(() => {}, 1e9) //ONE\nTWO\tTHREE ';
    const kid = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
    await new Promise((resolve, reject) => { kid.once('spawn', resolve); kid.once('error', reject); });
    try {
      const expected = `${process.execPath} -e ${script}`;
      const viaProc = readProcCmdline(kid.pid);
      const viaPs = psCommand(kid.pid);
      t.diagnostic(`argv as spawned      -> ${JSON.stringify(expected)}`);
      t.diagnostic(`/proc/<pid>/cmdline  -> ${JSON.stringify(viaProc)}`);
      t.diagnostic(`ps -p <pid> -o args= -> ${JSON.stringify(viaPs)}`);
      t.diagnostic(`proc===ps ${viaProc === viaPs}, proc===argv ${viaProc === expected}, ps===argv ${viaPs === expected}`);
      assert.strictEqual(viaProc, expected, 'the non-spawning source must return argv unmodified');
    } finally {
      try { kid.kill('SIGKILL'); } catch (e) {}
    }
  });

  // And the statement that is NOT the same statement: that the disagreement
  // above cannot reach the decision. The recorded value is a basename and it
  // sits in argv[0], ahead of anything a system prompt could contain, so the
  // escaping happens past the part that is matched. Runs wherever either source
  // works, so it covers the platform where `ps` is the only one.
  test('a child spawned with control characters in argv is still recognised', { skip: noLookup }, async () => {
    const script = 'setInterval(() => {}, 1e9) //ONE\nTWO\tTHREE ';
    const kid = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
    await new Promise((resolve, reject) => { kid.once('spawn', resolve); kid.once('error', reject); });
    try {
      const rec = { pid: kid.pid, at: Date.now(), cmd: path.basename(process.execPath) };
      assert.strictEqual(pidRecordAlive(rec), true,
        'a prompt full of newlines in argv must not make our own child look foreign. '
        + `command=${JSON.stringify(processCommand(kid.pid))}`);
    } finally {
      try { kid.kill('SIGKILL'); } catch (e) {}
    }
  });

  // The same measurement at a length that matters. `ps` is documented in places
  // as fitting its output to the terminal width, which would make the two
  // sources disagree for a LONG command line while agreeing for a short one:
  // the guard would then look correct in every test and fail on the real thing,
  // because a spawn here carries an agent's whole system prompt in argv.
  // Measured rather than reasoned about, at a length well past any terminal.
  test('the two sources still agree for a command line far longer than any terminal', { skip: noComparison }, async (t) => {
    const kid = await liveChild('A'.repeat(16384));
    try {
      const viaProc = readProcCmdline(kid.pid);
      const viaPs = psCommand(kid.pid);
      t.diagnostic(`/proc/<pid>/cmdline  -> ${String(viaProc).length} chars, ends ${JSON.stringify(String(viaProc).slice(-8))}`);
      t.diagnostic(`ps -p <pid> -o args= -> ${String(viaPs).length} chars, ends ${JSON.stringify(String(viaPs).slice(-8))}`);
      assert.ok(String(viaPs).length > 16384, `ps truncated a long command line to ${String(viaPs).length} chars`);
      assert.strictEqual(viaProc, viaPs, 'neither source may truncate where the other does not');
    } finally {
      try { kid.kill('SIGKILL'); } catch (e) {}
    }
  });

  // The same length question asked of the SPAWNING source alone, because on the
  // platform where it is the only source the test above cannot run at all: it
  // needs both. Without this, a `ps` that starts fitting its output to a width
  // would degrade the guard there and no test would notice.
  test('the spawning source does not truncate a long command line', { skip: noSpawningSource }, async (t) => {
    const pad = 'A'.repeat(16384);
    const kid = await liveChild(pad);
    try {
      const viaPs = psCommand(kid.pid);
      t.diagnostic(`ps -p <pid> -o args= -> ${String(viaPs).length} chars, ends ${JSON.stringify(String(viaPs).slice(-8))}`);
      assert.ok(String(viaPs).length > pad.length, `ps truncated a long command line to ${String(viaPs).length} chars`);
      assert.ok(String(viaPs).endsWith(pad.slice(-64)), 'the end of the command line must survive');
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
    assert.strictEqual(free.ok, true);
    assert.strictEqual(free.missing, null);
    assert.strictEqual(free.source, '/proc/<pid>/cmdline', 'the non-spawning source is preferred when it answers');

    const spawned = commandLineCapability(() => null, () => '/x/node -e code');
    assert.strictEqual(spawned.source, 'ps -p <pid> -o args=', 'the spawning source remains for platforms with no other');
    assert.deepStrictEqual(spawned.sources.map(s => s.available), [false, true],
      'the report says which source answered, not merely that one did');
    assert.deepStrictEqual(none.sources.map(s => s.available), [false, false]);
    assert.deepStrictEqual(free.sources.map(s => s.spawns), [false, true],
      'and which of them costs a spawn, since that is what the order exists for');
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
    assert.strictEqual(parseProcCmdline('/usr/bin/node\0-e\0a\nb'), '/usr/bin/node -e a\nb',
      'a newline INSIDE an argument is kept as it was spawned; only ps escapes it for a human');
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

  // The same property against the REAL default binding, with nothing injected.
  // The test above counts calls on two fakes, so it covers a model of this
  // function rather than the function the guard actually calls: bind the first
  // reader to the spawning one and it stays green, because where both sources
  // answer they answer identically. The seam added to make the behaviour
  // testable was itself the untested part.
  //
  // What makes this one different is that it never names a reader. It replaces
  // the spawning primitive underneath instead, which the guard resolves at call
  // time, so a default that reaches for `ps` is caught wherever the free source
  // works at all.
  test('the DEFAULT reader is the non-spawning one, with nothing injected', { skip: noFreeSource }, async () => {
    const childProcess = require('node:child_process');
    const kid = await liveChild();
    const realExecFileSync = childProcess.execFileSync;
    let spawns = 0;
    childProcess.execFileSync = (...args) => {
      spawns++;
      throw new Error('the guard spawned a process to read a command line it could have read for free');
    };
    try {
      const command = processCommand(kid.pid); // no readers named: this is the shipped path
      assert.ok(command, `the default path must return a command line, got ${JSON.stringify(command)}`);
      assert.strictEqual(spawns, 0, 'the default path must not spawn anything where the free source works');
    } finally {
      childProcess.execFileSync = realExecFileSync;
      try { kid.kill('SIGKILL'); } catch (e) {}
    }
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
