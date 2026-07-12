'use strict';
// SR1 universal search: core primitives (capability probe, FTS5 query
// sanitizer, fuzzy title matcher). These are pure functions/factories in
// search.js with no workspace or server dependency.
const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  probeSqlite,
  sanitizeFtsQuery,
  fuzzyScore,
} = require('../../search.js');

describe('probeSqlite', () => {
  test('reports available with FTS5 on a runtime that has node:sqlite', () => {
    // This test suite itself runs on Node >= 20; if node:sqlite is absent the
    // probe must say so rather than throw. On Node 22.13+/24 it must pass.
    const result = probeSqlite();
    assert.strictEqual(typeof result.available, 'boolean');
    const [major, minor] = process.versions.node.split('.').map(Number);
    const runtimeHasSqlite = major >= 23 || (major === 22 && minor >= 13);
    const envDisabled = process.env.RUNDOCK_SEARCH_DISABLE_SQLITE === '1';
    if (runtimeHasSqlite && !envDisabled) {
      assert.strictEqual(result.available, true);
      assert.ok(result.DatabaseSync, 'DatabaseSync constructor exposed when available');
    }
  });

  test('honours the disable override (grep-fallback gate is testable)', () => {
    const result = probeSqlite({ disabled: true });
    assert.strictEqual(result.available, false);
    assert.strictEqual(result.reason, 'disabled');
  });

  test('never throws', () => {
    assert.doesNotThrow(() => probeSqlite());
  });
});

describe('sanitizeFtsQuery', () => {
  test('quotes bare tokens and joins with implicit AND', () => {
    assert.strictEqual(sanitizeFtsQuery('hello world'), '"hello" "world"');
  });

  test('strips FTS5 operators and syntax characters', () => {
    // None of these may reach the MATCH expression as syntax.
    const nasty = [
      'foo AND bar', 'foo OR bar', 'foo NOT bar', 'a NEAR b',
      'foo*', '(foo)', 'col:foo', 'foo-bar', '"unbalanced', '""', '^foo',
      'foo + bar', '{a b}', 'foo\\bar',
    ];
    for (const q of nasty) {
      const s = sanitizeFtsQuery(q);
      if (s === null) continue; // fully-stripped queries are allowed to be null
      // Every token must be a double-quoted string with no embedded quotes,
      // optionally suffixed with * (prefix mode only).
      assert.match(s, /^"[^"]+"( "[^"]+")*$/, `unsafe expression for input ${JSON.stringify(q)}: ${s}`);
    }
  });

  test('AND/OR/NOT become quoted terms, not operators', () => {
    assert.strictEqual(sanitizeFtsQuery('foo AND bar'), '"foo" "AND" "bar"');
  });

  test('unicode tokens survive quoting', () => {
    assert.strictEqual(sanitizeFtsQuery('café 日本語'), '"café" "日本語"');
  });

  test('empty and operator-only input returns null', () => {
    assert.strictEqual(sanitizeFtsQuery(''), null);
    assert.strictEqual(sanitizeFtsQuery('   '), null);
    assert.strictEqual(sanitizeFtsQuery('()*^:'), null);
    assert.strictEqual(sanitizeFtsQuery(null), null);
    assert.strictEqual(sanitizeFtsQuery(undefined), null);
  });

  test('caps query length', () => {
    const long = 'word '.repeat(200);
    const s = sanitizeFtsQuery(long);
    assert.ok(s.length <= 300, `sanitized query too long: ${s.length}`);
  });

  test('prefix mode stars only the last token (search-as-you-type)', () => {
    assert.strictEqual(sanitizeFtsQuery('hello wor', { prefix: true }), '"hello" "wor"*');
    // A single short token also gets prefix treatment
    assert.strictEqual(sanitizeFtsQuery('wor', { prefix: true }), '"wor"*');
  });
});

describe('fuzzyScore', () => {
  test('exact substring beats scattered subsequence', () => {
    const sub = fuzzyScore('dock', 'rundock');
    const scattered = fuzzyScore('rdk', 'rundock');
    assert.ok(sub !== null && scattered !== null);
    assert.ok(sub > scattered, `substring (${sub}) should outrank subsequence (${scattered})`);
  });

  test('subsequence in order matches; out of order does not', () => {
    assert.notStrictEqual(fuzzyScore('rdck', 'rundock'), null);
    assert.strictEqual(fuzzyScore('kdr', 'rundock'), null);
  });

  test('case-insensitive', () => {
    assert.notStrictEqual(fuzzyScore('RunDock', 'rundock'), null);
    assert.notStrictEqual(fuzzyScore('rundock', 'RunDock Site Notes'), null);
  });

  test('word-boundary starts rank higher than mid-word matches', () => {
    const boundary = fuzzyScore('cs', 'conversation search');
    const midword = fuzzyScore('cs', 'arcs');
    assert.ok(boundary !== null && midword !== null);
    assert.ok(boundary > midword);
  });

  test('non-match returns null; empty needle returns null', () => {
    assert.strictEqual(fuzzyScore('zzz', 'rundock'), null);
    assert.strictEqual(fuzzyScore('', 'rundock'), null);
  });
});
