'use strict';
// A WRITE TO A PROCESS THAT HAS STOPPED NEVER ENDS THE SERVER.
//
// The server sends every message to an agent on its process's stdin. A
// process can stop before the server has heard that it stopped: Claude Code
// refuses a resume and exits before reading anything, or it crashes, or it is
// ended. A write in that gap goes to a pipe nobody reads, and fails with EPIPE
// asynchronously, as an `error` event on the stdin stream: no try/catch
// around the write can see it. With no listener, Node treats that event as an
// uncaught exception, and the server and every conversation in it end.
//
// So each child's stdin is given its handler once, where the child is
// started, and no write site needs one of its own. The handler logs one line
// naming the process and the error, and does nothing else: the process has
// stopped, and its own close path ends its turn or its delegation exactly as
// it does for any process that stops.
//
// One line PER FAILED WRITE. A write still queued behind one that failed
// fails with it, carrying the same error, and is logged as a write of its own:
// two messages lost are two lines, not one. An `error` the stream raises for
// a write already logged is not logged again.
//
// The handler must not fail either: a log that throws is swallowed, because a
// throw from an `error` listener is an uncaught exception of its own.

// Where the line goes. Replaceable, so a test can make the log itself fail.
const failureLog = { write: (line) => console.error(line) };

const GUARDED = Symbol('rundock.childStdinGuarded');

/**
 * Give a child's stdin its error handler. `describe` names the process for
 * the log line: a string, or a function asked only when a write fails.
 * Options: `log`, a function taking the line, in place of `failureLog`.
 * Returns whether the child has a stdin that is now guarded. Calling it again
 * on the same child changes nothing.
 */
function guardChildStdin(proc, describe, { log } = {}) {
  const stdin = proc && proc.stdin;
  if (!stdin || typeof stdin.on !== 'function' || typeof stdin.write !== 'function') return false;
  if (stdin[GUARDED]) return true;
  stdin[GUARDED] = true;

  const logged = new WeakSet();
  const report = (err) => {
    try {
      if (err && typeof err === 'object') logged.add(err);
      let who = '';
      try { who = typeof describe === 'function' ? String(describe()) : String(describe || ''); } catch (e) { who = 'a child process'; }
      const code = (err && err.code) || 'error';
      const message = (err && err.message) || String(err);
      const line = `[Stdin] ${who || 'a child process'} pid=${proc.pid}: a write failed (${code}: ${message}); the process has stopped, and its close ends what it was doing`;
      (typeof log === 'function' ? log : failureLog.write)(line);
    } catch (e) { /* the log failing must not end the server either */ }
  };

  stdin.on('error', (err) => {
    if (err && typeof err === 'object' && logged.has(err)) return;
    report(err);
  });

  const write = stdin.write;
  stdin.write = function guardedWrite(chunk, encoding, callback) {
    if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
    return write.call(this, chunk, encoding, (err) => {
      if (err) report(err);
      if (typeof callback === 'function') callback(err);
    });
  };
  return true;
}

module.exports = { guardChildStdin, failureLog };
