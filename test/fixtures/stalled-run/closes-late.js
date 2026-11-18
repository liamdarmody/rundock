'use strict';
// Every test passes, and a timer then keeps the file open for a little over two
// minutes before it ends on its own, as a file does that waits out a two-minute
// timer of the app's. Run by stalled-test-run.check.js through
// the npm test command; npm test's own glob never picks it up.
const { test } = require('node:test');

setTimeout(() => {}, 130 * 1000);

test('a test that passes', () => {});
