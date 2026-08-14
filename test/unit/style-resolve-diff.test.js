'use strict';
// The resolver behind style-resolve-diff.
//
// It exists because three browser-based attempts to see hover and error states
// produced results that could not be explained. This one is deterministic and
// its behaviour is pinned here, so if it ever starts lying it does so loudly.
const { test, describe } = require('node:test');
const assert = require('node:assert');

const { resolve, declarations, diff } = require('../tools/style-resolve-diff.js');

const T = new Map([
  ['--accent', '#E87A5A'],
  ['--danger', '#E85A5A'],
  ['--radius-lg', '8px'],
  ['--pointer', 'var(--accent)'],
]);

describe('resolving var() to what it actually renders', () => {
  test('a defined token wins over its fallback', () => {
    assert.strictEqual(resolve('var(--danger, #d9534f)', T), '#E85A5A');
  });

  test('an undefined token falls back', () => {
    // The exact case that made this necessary: var(--danger, #e55) rendered
    // #e55 for as long as --danger did not exist, and #E85A5A the moment it
    // did. Nothing in the app changed; a token appeared somewhere else.
    assert.strictEqual(resolve('var(--danger, #e55)', new Map()), '#e55');
  });

  test('an undefined token with no fallback resolves to nothing, and says so', () => {
    // This is how .ws-picker-error rendered as ordinary body text instead of
    // red. A silent empty value is exactly the kind of thing a diff must name
    // rather than skip.
    assert.strictEqual(resolve('var(--danger)', new Map()), '<<UNRESOLVED>>');
  });

  test('a token whose value is itself a var is followed', () => {
    assert.strictEqual(resolve('var(--pointer)', T), '#E87A5A');
  });

  test('several vars in one value all resolve', () => {
    assert.strictEqual(
      resolve('0 0 0 2px color-mix(in srgb, var(--danger) 30%, transparent)', T),
      '0 0 0 2px color-mix(in srgb, #E85A5A 30%, transparent)',
    );
  });

  test('a value with no var is returned unchanged but normalised', () => {
    assert.strictEqual(resolve('  0 1px   2px  rgba(0,0,0,0.1)  ', T), '0 1px 2px rgba(0,0,0,0.1)');
  });

  test('a self-referential token terminates instead of hanging', () => {
    // Malformed CSS should make the tool useless, not unresponsive.
    const loop = new Map([['--a', 'var(--b)'], ['--b', 'var(--a)']]);
    const out = resolve('var(--a)', loop);
    assert.ok(typeof out === 'string');
  });
});

describe('reading declarations out of the repo', () => {
  test('the current tree parses into a substantial declaration set', () => {
    const d = declarations('WORKTREE');
    assert.ok(d.size > 1500, `expected thousands of declarations, got ${d.size}`);
    // Keys are file|selector|property, so a change can be pointed at.
    const sample = [...d.keys()][0].split('|');
    assert.strictEqual(sample.length, 3);
  });

  test('a comment above a selector is not part of the selector', () => {
    // The first version reported a selector as the whole preceding comment
    // block, which made its output unreadable at exactly the moment it mattered.
    const d = declarations('WORKTREE');
    for (const key of d.keys()) {
      assert.ok(!key.includes('/*'), `selector still carries a comment: ${key.slice(0, 80)}`);
    }
  });

  test('it reports the change that the computed-style snapshot could not see', () => {
    // Adding --danger altered eight declarations, every one of them in a
    // :hover, an error state, or a review-mode rule. The snapshot tool reported
    // zero because it only ever captures default states. This is the guard
    // against believing that report again.
    const r = diff('181bfa4', '638f8b7');
    const reds = r.changed.filter(c => /#E85A5A/i.test(c.to) && /#E06C6C|#e55|#d9534f/i.test(c.from));
    assert.strictEqual(reds.length, 8, 'the eight red unifications must be visible');
    for (const c of reds) {
      assert.match(c.key, /:hover|invalid|critic|review/, `${c.key} should be an interactive or error state`);
    }
  });
});
