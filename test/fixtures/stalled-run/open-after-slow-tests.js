'use strict';
// A test that takes a minute and a half passes, and a timer it then leaves
// running holds the file open. Run by stalled-test-run.check.js through the
// npm test command; npm test's own glob never picks it up.
const { test } = require('node:test');

test('a test that passes after a minute and a half', async () => {
  await new Promise((resolve) => setTimeout(resolve, 90 * 1000));
  // Long enough that a run that waits for it is still going at the five-minute
  // mark, and bounded, so such a run cannot outlive the check for long.
  setTimeout(() => {}, 6 * 60 * 1000);
});
