'use strict';
// A TEST THAT NEVER SETTLES ENDS ITS FILE, AND THE RUN SAYS WHICH ONE IT WAS.
//
// Without this, a test whose promise nobody resolves, or whose callback is
// never called, holds its file open for as long as something else keeps the
// process alive, and the run prints nothing more until the CI job's own time
// limit ends it with no test named.
//
// The npm test scripts load it with --require, which `node --test` hands to
// every test file it runs, so this file is the one place the limit is set.
//
// WHY NOT --test-timeout. Node 22 and Node 24 read it differently. On 24 it is
// a limit per test. On 22 the runner applies it to each file as a whole, so a
// file of many passing tests would be cut off at the limit. Root beforeEach and
// afterEach hooks behave the same on both, so the limit is kept here.
//
// A synchronous test cannot be interrupted by a timer: one that runs past the
// limit and then returns is not stopped. Only a test that is still waiting
// when the limit passes is.
const path = require('node:path');

// The longest one test may run before its file is stopped. Well above the
// slowest test the suite has, so a slow machine is not mistaken for a stall,
// and short enough that a stalled run ends within five minutes.
const LIMIT_MS = 240 * 1000;

// How long a file may stay open once its tests have finished: time enough for
// its own after hooks to close what it opened.
const EXIT_GRACE_MS = 60 * 1000;

const timers = new Map();

function fileName() {
  return path.relative(process.cwd(), process.argv[1] || '') || 'a test file';
}

// Ends this file's process with a failure, once the reason is written. The
// runner reports the file as failed and moves on to the rest of the run.
function stop(reason) {
  process.exitCode = 1;
  process.stderr.write(`\n[stalled test] ${fileName()}: ${reason}\n`, () => process.exit(1));
}

// Starts test t's clock: t has ms to finish. Called again for the same test, it
// starts the clock again with the new limit, which is how a test that runs
// another test run inside it asks for longer than LIMIT_MS.
function setLimit(t, ms = LIMIT_MS) {
  clearTimeout(timers.get(t));
  const timer = setTimeout(() => {
    if (t.passed || t.error) return;
    stop(`test "${t.fullName}" did not finish within ${ms / 1000} seconds.`);
  }, ms);
  timer.unref();
  timers.set(t, timer);
}

function clearLimit(t) {
  clearTimeout(timers.get(t));
  timers.delete(t);
}

// The process `node --test` itself runs in only hands files out to child
// processes; the tests run in those, so that is where the hooks go.
if (!process.execArgv.includes('--test')) {
  const { beforeEach, afterEach, after } = require('node:test');
  beforeEach((t) => setLimit(t));
  afterEach((t) => clearLimit(t));
  // Every test has passed, but a server, timer or child the file left running
  // can still hold it open with nothing more to report. Ending the file with
  // --test-force-exit would hide that, and pass; this ends it as a failure
  // that names what was still open.
  after(() => {
    setTimeout(() => {
      const open = [...new Set(process.getActiveResourcesInfo())].join(', ');
      stop(`every test finished, but the file was still open ${EXIT_GRACE_MS / 1000} seconds later (open: ${open}).`);
    }, EXIT_GRACE_MS).unref();
  });
}

module.exports = { LIMIT_MS, setLimit };
