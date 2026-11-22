'use strict';
// A passing test named exactly as its own file's path, which is the name
// Node reports a file under when it selects nothing or fails to load. Never
// part of `npm test`.
const { test } = require('node:test');
const assert = require('node:assert');

test('test/fixtures/prove/path-named.js', () => {
  assert.strictEqual(1 + 1, 2);
});
