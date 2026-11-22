'use strict';
// A `blocker ` nested in a suite beside a top-level `blocker`. The nested
// test's full name holds the suite's name, so the name `blocker` selects
// only the top-level test. Never part of `npm test`.
const { test, describe, it } = require('node:test');
const assert = require('node:assert');

describe('a suite', () => {
  it('blocker ', () => {
    assert.strictEqual(1, 2);
  });
});

test('blocker', () => {
  assert.strictEqual(1, 2);
});
