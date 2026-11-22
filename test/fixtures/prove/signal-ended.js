'use strict';
// A test named exactly as its own file's path, which ends its file's process
// with a signal before it can report, so Node reports the file under that
// same name. Never part of `npm test`.
const { test } = require('node:test');

test('test/fixtures/prove/signal-ended.js', () => {
  process.kill(process.pid, 'SIGTERM');
  return new Promise(() => {});
});
