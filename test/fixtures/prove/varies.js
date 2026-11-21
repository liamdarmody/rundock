'use strict';
// A fixture whose one test passes or fails by chance, the way a test that
// depends on timing or order does. The capture script runs it until it has
// one pass and two failures. Never part of `npm test`.
const { test } = require('node:test');
const assert = require('node:assert');

test('the result varies between runs', () => {
  assert.ok(Math.random() < 0.5, 'this run drew the failing half');
});
