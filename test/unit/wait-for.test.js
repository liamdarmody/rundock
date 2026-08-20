'use strict';
// The smoke harnesses' polling helper.
//
// It polls for things a server is still producing, so a predicate routinely
// runs before the thing it looks for exists. `existsSync` returns false there;
// `readdirSync` throws ENOENT. Both mean "not yet", and until 2026-08-20 only
// one of them was survivable: a throwing predicate propagated out of the poll
// loop and aborted the whole journey.
//
// That cost two release gate runs in one afternoon. A persona journey died on
// ENOENT and reported 5 of 14 checks, while the same suite standalone passed
// 16 of 16 on the same commit. The difference was load: inside the gate the
// step follows a long browser suite, scaffolding is slower, and the first poll
// landed before the directory existed.
//
// These tests are the reason the helper now has one home rather than a copy in
// each harness: the same eight lines had to be fixed twice.

const { test, describe } = require('node:test');
const assert = require('node:assert');

let waitFor;
test('load the module', async () => {
  ({ waitFor } = await import('../../scripts/smoke/wait-for.mjs'));
  assert.strictEqual(typeof waitFor, 'function');
});

describe('waitFor', () => {
  test('a predicate that throws, then succeeds, resolves rather than aborting', async () => {
    // The exact shape that killed the gate: read a directory that does not
    // exist yet, then does.
    let calls = 0;
    const result = await waitFor(() => {
      calls += 1;
      if (calls < 3) throw new Error('ENOENT: no such file or directory, scandir');
      return 'found';
    }, 2000, 10);

    assert.strictEqual(result, 'found');
    assert.ok(calls >= 3, 'it kept polling past the throws');
  });

  test('a predicate that only ever throws times out instead of propagating', async () => {
    // A condition that never becomes true must be reported as a timeout, not
    // raised as an exception. Otherwise one unmet condition takes down every
    // check that would have run after it, which is what turned a single missing
    // directory into nine skipped assertions.
    const result = await waitFor(() => { throw new Error('always'); }, 60, 10);
    assert.strictEqual(result, null);
  });

  test('a rejected promise counts as not yet, the same as a throw', async () => {
    let calls = 0;
    const result = await waitFor(async () => {
      calls += 1;
      if (calls < 2) return Promise.reject(new Error('not ready'));
      return 'ready';
    }, 2000, 10);
    assert.strictEqual(result, 'ready');
  });

  test('a successful predicate returns its value, not merely true', async () => {
    // Callers use the returned value, so swallowing it into a boolean would
    // break them quietly.
    const result = await waitFor(() => ({ agents: 2 }), 1000, 10);
    assert.deepStrictEqual(result, { agents: 2 });
  });

  test('a falsey predicate still times out to null', async () => {
    const started = Date.now();
    const result = await waitFor(() => false, 60, 10);
    assert.strictEqual(result, null);
    assert.ok(Date.now() - started >= 50, 'it waited for the deadline');
  });
});
