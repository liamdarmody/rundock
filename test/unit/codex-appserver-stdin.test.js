'use strict';
// A request written to the Codex app-server after its process has stopped,
// before the client has heard, driven against the real stub binary. The write
// fails asynchronously with EPIPE; it must be logged in one line and left to
// the process's close, which rejects the request and restarts the server, and
// it must never reach the host as an uncaught exception.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

const { createCodexAppServer } = require('../../codex-appserver.js');

const STUB_BIN = path.join(__dirname, '..', 'helpers', 'stub-codex', 'codex');

const uncaught = [];
process.on('uncaughtExceptionMonitor', (err) => { uncaught.push(err); });
beforeEach(() => { uncaught.length = 0; });

const dirs = [];
test.after(() => {
  for (const dir of dirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* best-effort */ }
  }
});

function makeServer(log) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-appserver-stdin-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'stub-codex-scenario.json'), JSON.stringify({ appServer: {} }));
  const server = createCodexAppServer({
    binPath: STUB_BIN,
    cwd: dir,
    requestTimeoutMs: 5000,
    restartBackoff: { baseMs: 25, maxMs: 100 },
    shutdownGraceMs: 1000,
    log,
  });
  return { server, dir };
}

// End the child and return once it has gone, without yielding to the event
// loop, so the client has not heard of the exit when it returns. Gone is read
// from the pipe: a blank line written to it, which the stub skips, is refused
// once nothing reads it.
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
  assert.fail('the app-server did not stop within ten seconds of SIGKILL');
}

// Bounded, and the stopped process let go at the end: with the handler gone,
// the error is thrown out of the stream's teardown and leaves its pipe open,
// which must fail this test in seconds rather than hold the file open.
test('a request written after the app-server stopped is logged once, rejected by its close, and the server restarts', { timeout: 30000 }, async () => {
  const lines = [];
  const { server, dir } = makeServer((line) => lines.push(line));
  let proc = null;
  try {
    await server.start();
    proc = server._proc;
    assert.ok(proc && proc.pid === server.pid(), 'the app-server is running');
    const restarted = once(server, 'ready', { signal: AbortSignal.timeout(10000) });
    endUnheard(proc);
    await assert.rejects(server.startThread({ cwd: dir }), /exited before responding/,
      'the close path rejects the request, as it does for any request the process never answered');
    await restarted;

    assert.deepStrictEqual(uncaught.map((e) => `${e.code || ''} ${e.message}`), [],
      'nothing reaches the host as an uncaught exception');
    const failed = lines.filter((l) => l.startsWith('[Stdin]'));
    assert.strictEqual(failed.length, 1, `one line, for the one failed write: ${JSON.stringify(lines)}`);
    assert.match(failed[0], new RegExp(`^\\[Stdin\\] codex app-server pid=${proc.pid}: a write failed \\((EPIPE|ENOTCONN|ECONNRESET): `));

    // The most common next step: the restarted server takes the request.
    const again = await server.startThread({ cwd: dir });
    assert.ok(again.threadId, 'the restarted app-server answers');
    assert.strictEqual(lines.filter((l) => l.startsWith('[Stdin]')).length, 1, 'and logs no failure of its own');
  } finally {
    await server.shutdown();
    if (proc) for (const s of [proc.stdin, proc.stdout, proc.stderr]) { try { s.unref(); } catch (e) { /* nothing to let go */ } }
  }
});
