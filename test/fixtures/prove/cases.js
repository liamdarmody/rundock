'use strict';
// Tests that end every way the prove workflow has to judge. This file is a
// fixture: its name keeps it out of `npm test`, and the capture script in
// this directory runs one test from it at a time and keeps the TAP.
const { test, describe, it } = require('node:test');
const assert = require('node:assert');

test('an assertion fails', () => {
  assert.strictEqual(1 + 1, 3);
});

test('a subtest assertion fails', async (t) => {
  await t.test('the inner check', () => {
    assert.deepStrictEqual({ a: 1 }, { a: 2 });
  });
});

test('a non-assertion error is thrown', () => {
  throw new TypeError('not an assertion');
});

test('the test passes', () => {
  assert.strictEqual(1 + 1, 2);
});

test('a name with # and \\ in it passes', () => {
  assert.strictEqual(1 + 1, 2);
});

test('the test times out', { timeout: 50 }, () => new Promise((resolve) => setTimeout(resolve, 1000)));

test('a module is missing', () => {
  require('./no-such-module');
});

test('the test is skipped', { skip: true }, () => {
  assert.strictEqual(1 + 1, 3);
});

test('the test is todo', { todo: true }, () => {
  assert.strictEqual(1 + 1, 3);
});

test('two tests share this name', () => {});
test('two tests share this name', () => {});

describe('a suite', () => {
  it('holds a nested test', () => {
    assert.strictEqual('a', 'b');
  });
  it('holds another nested test', () => {});
});
