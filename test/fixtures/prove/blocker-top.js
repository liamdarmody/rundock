'use strict';
// Two top-level tests whose names differ only by a trailing space. Node
// trims a test's full name before it compares it with the name asked for,
// so the name `blocker` selects both. Never part of `npm test`.
const { test } = require('node:test');
const assert = require('node:assert');

test('blocker ', () => {
  assert.strictEqual(1, 2);
});

test('blocker', () => {
  assert.strictEqual(1, 2);
});
