'use strict';
// Every test passes, but a timer left running holds the file open after them.
// Run by stalled-test-run.check.js through the npm test
// command; npm test's own glob never picks it up.
const { test } = require('node:test');

// Long enough that a run that waits for it is still going at the five-minute
// mark, and bounded, so such a run cannot outlive the check for long.
setTimeout(() => {}, 6 * 60 * 1000);

test('a test that passes', () => {});

test('another test that passes', async () => {});
