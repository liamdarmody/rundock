'use strict';
// The handler a child's stdin is given where the child starts
// (lib/runtime/child-stdin.js), driven against real child processes: a write
// to one that has stopped is logged in one line and never reaches the process
// as an uncaught exception, which in the server would end it.
//
// Two ways a write meets a stopped child, and both are here: a write made
// after it stopped, before this process has heard, and a write still going
// when a child that never reads exits.
const { test, describe, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { guardChildStdin, failureLog } = require('../../lib/runtime/child-stdin.js');

const uncaught = [];
process.on('uncaughtExceptionMonitor', (err) => { uncaught.push(err); });
beforeEach(() => { uncaught.length = 0; });

// A child that reads its stdin and says back each line it reads.
const ECHO = "process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => process.stdout.write('got:' + d));";
// A child that never reads its stdin, and exits after a moment.
const DEAF = 'setTimeout(() => process.exit(0), 300);';
// A child that never reads and never exits on its own.
const IDLE = 'setInterval(() => {}, 1000);';

const children = [];
function child(code, stdio = ['pipe', 'pipe', 'pipe']) {
  const proc = spawn(process.execPath, ['-e', code], { stdio });
  children.push(proc);
  return proc;
}
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

// FAIL CLOSED, AND FAST. With the handler broken, the error it should have
// caught is thrown out of the middle of the stream's teardown: the stream is
// left half destroyed, its pipe still open, and the child's 'close', which
// waits for every pipe, never comes. So each test waits for the child's exit,
// which does not wait for its pipes, and only for so long; each test has a
// limit of its own; and at the end every child and pipe this file started is
// let go, so a broken handler fails these tests in seconds rather than
// holding the file open for good.
function exitedP(proc, ms = 8000) {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the child (pid ${proc.pid}) did not exit within ${ms}ms`)), ms);
    proc.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}
const LIMIT = { timeout: 20000 };
after(() => {
  for (const proc of children) {
    try { proc.kill('SIGKILL'); } catch (e) { /* already gone */ }
    for (const s of [proc.stdin, proc.stdout, proc.stderr]) {
      try { if (s && typeof s.unref === 'function') s.unref(); } catch (e) { /* nothing to let go */ }
    }
    try { proc.unref(); } catch (e) { /* nothing to let go */ }
  }
});

// End a child and return once it has gone, without yielding to the event
// loop, so this process has not heard of the exit when it returns. Gone is
// read from the pipe: a blank line written to it is refused once nothing
// reads it.
const READER_GONE = new Set(['EPIPE', 'ENOTCONN', 'ECONNRESET']);
function endUnheard(proc) {
  const fd = proc.stdin._handle && proc.stdin._handle.fd;
  assert.ok(Number.isInteger(fd) && fd >= 0, 'the stdin is a pipe this platform can write to directly');
  process.kill(proc.pid, 'SIGKILL');
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { fs.writeSync(fd, '\n'); } catch (e) {
      if (READER_GONE.has(e.code)) return;
      if (e.code !== 'EAGAIN') throw e;
    }
  }
  assert.fail('the child did not stop within ten seconds of SIGKILL');
}

function noUncaught(label) {
  assert.deepStrictEqual(uncaught.map((e) => `${e.code || ''} ${e.message}`), [], `${label}: nothing reaches the process as an uncaught exception`);
}

describe('a write to a child that has stopped', () => {
  test('made after it stopped: one line naming the process and the error, and nothing thrown', LIMIT, async () => {
    const proc = child(IDLE);
    const lines = [];
    assert.strictEqual(guardChildStdin(proc, 'the test child', { log: (l) => lines.push(l) }), true);
    await tick(200);
    const done = exitedP(proc);
    endUnheard(proc);
    let callbackErr = 'not called';
    assert.doesNotThrow(() => proc.stdin.write('hello\n', (err) => { callbackErr = err; }));
    await done;
    await tick();
    noUncaught('a write after the child stopped');
    assert.strictEqual(lines.length, 1, JSON.stringify(lines));
    assert.match(lines[0], /^\[Stdin\] the test child pid=\d+: a write failed \((EPIPE|ENOTCONN|ECONNRESET): /);
    assert.ok(lines[0].includes(`pid=${proc.pid}:`), 'naming the process');
    assert.ok(callbackErr && READER_GONE.has(callbackErr.code), 'the writer\'s own callback still hears of the failure');
  });

  test('still going when a child that never reads exits: one line, and nothing thrown', LIMIT, async () => {
    const proc = child(DEAF);
    const lines = [];
    guardChildStdin(proc, () => 'a deaf child', { log: (l) => lines.push(l) });
    const done = exitedP(proc);
    proc.stdin.write('x'.repeat(1024 * 1024) + '\n');
    await done;
    await tick();
    noUncaught('a write going when the child exited');
    assert.strictEqual(lines.length, 1, JSON.stringify(lines));
    assert.match(lines[0], /^\[Stdin\] a deaf child pid=\d+: a write failed \((EPIPE|ECONNRESET): /);
  });

  test('the retry: a second write to the same stopped child logs once more, and nothing is thrown', LIMIT, async () => {
    const proc = child(DEAF);
    const lines = [];
    guardChildStdin(proc, 'twice', { log: (l) => lines.push(l) });
    const done = exitedP(proc);
    proc.stdin.write('x'.repeat(1024 * 1024) + '\n');
    proc.stdin.write('the second\n');
    await done;
    await tick();
    proc.stdin.write('after it closed\n');
    await tick();
    noUncaught('three writes to one stopped child');
    assert.strictEqual(lines.length, 3, `one line per failed write: ${JSON.stringify(lines)}`);
    assert.match(lines[2], /ERR_STREAM_DESTROYED/, 'a write after the close is refused by the stream itself, and said so');
  });

  test('an error the stream raises for no write of its own is logged once', LIMIT, async () => {
    const proc = child(IDLE);
    const lines = [];
    guardChildStdin(proc, 'odd', { log: (l) => lines.push(l) });
    proc.stdin.destroy(Object.assign(new Error('torn down'), { code: 'ETEST' }));
    await tick();
    noUncaught('an error from the stream');
    assert.deepStrictEqual(lines.map((l) => /\(ETEST: torn down\)/.test(l)), [true]);
    proc.kill('SIGKILL');
    await exitedP(proc);
  });
});

describe('a write to a live child', () => {
  test('the inverse: it is delivered exactly as written, its callback runs, and nothing is logged', LIMIT, async () => {
    const proc = child(ECHO);
    const lines = [];
    guardChildStdin(proc, 'live', { log: (l) => lines.push(l) });
    let out = '';
    proc.stdout.on('data', (d) => { out += d; });
    const calls = [];
    proc.stdin.write('one\n', (err) => calls.push(['one', err || null]));
    proc.stdin.write(Buffer.from('two\n'));
    proc.stdin.write('74687265650a', 'hex', (err) => calls.push(['three', err || null]));
    const deadline = Date.now() + 5000;
    while (!out.includes('three') && Date.now() < deadline) await tick(20);
    assert.ok(out.includes('got:one') && out.includes('two') && out.includes('three'), `delivered: ${JSON.stringify(out)}`);
    assert.deepStrictEqual(calls, [['one', null], ['three', null]], 'each callback runs, with no error');
    assert.deepStrictEqual(lines, []);
    proc.kill('SIGKILL');
    await exitedP(proc);
    noUncaught('writes to a live child');
  });
});

describe('the handler itself', () => {
  test('the control failing: a log that throws is swallowed, and the failed write still throws nothing', LIMIT, async () => {
    const proc = child(DEAF);
    guardChildStdin(proc, 'broken log', { log: () => { throw new Error('the log is broken'); } });
    const done = exitedP(proc);
    proc.stdin.write('x'.repeat(1024 * 1024) + '\n');
    await done;
    await tick();
    noUncaught('a failed write whose log throws');
  });

  test('a default log that throws, and a name that cannot be read, are swallowed too', LIMIT, async () => {
    const proc = child(DEAF);
    const restore = failureLog.write;
    const lines = [];
    failureLog.write = (l) => { lines.push(l); throw new Error('the default log is broken'); };
    try {
      guardChildStdin(proc, () => { throw new Error('no name'); });
      const done = exitedP(proc);
      proc.stdin.write('x'.repeat(1024 * 1024) + '\n');
      await done;
      await tick();
    } finally {
      failureLog.write = restore;
    }
    noUncaught('a failed write whose default log and name both throw');
    assert.strictEqual(lines.length, 1, 'the line was still offered, under a plain name');
    assert.match(lines[0], /^\[Stdin\] a child process pid=/);
  });

  test('is given once: guarding the same child again adds nothing', LIMIT, async () => {
    const proc = child(IDLE);
    const lines = [];
    assert.strictEqual(guardChildStdin(proc, 'once', { log: (l) => lines.push(l) }), true);
    const listeners = proc.stdin.listenerCount('error');
    const write = proc.stdin.write;
    assert.strictEqual(guardChildStdin(proc, 'twice', { log: (l) => lines.push(l) }), true);
    assert.strictEqual(proc.stdin.listenerCount('error'), listeners, 'no second listener');
    assert.strictEqual(proc.stdin.write, write, 'and no second wrapper');
    const done = exitedP(proc);
    endUnheard(proc);
    proc.stdin.write('hello\n');
    await done;
    await tick();
    assert.strictEqual(lines.length, 1, 'so a failed write is logged once');
    assert.match(lines[0], /\] once pid=/);
  });

  test('a child with no stdin pipe is left alone', LIMIT, async () => {
    const proc = child('', ['ignore', 'pipe', 'pipe']);
    assert.strictEqual(guardChildStdin(proc, 'none'), false);
    assert.strictEqual(guardChildStdin(null, 'none'), false);
    await exitedP(proc);
  });
});
