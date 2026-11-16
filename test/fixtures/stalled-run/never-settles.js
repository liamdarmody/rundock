'use strict';
// A test that never settles: its promise is never resolved, while a timer keeps
// the process alive. Run by stalled-test-run.check.js through
// the npm test command; npm test's own glob never picks it up.
const { test } = require('node:test');

test('a test that passes first', () => {});

test('a promise nobody resolves', () => new Promise(() => {
  // Long enough that a run with no limit is still going at the five-minute
  // mark, and bounded, so such a run cannot outlive the check for long.
  setTimeout(() => {}, 6 * 60 * 1000);
}));
