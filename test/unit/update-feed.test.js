// Tests for the update feed override (electron/update-feed.js).
//
// The updater can be pointed at a locally served feed through the
// RUNDOCK_UPDATE_FEED environment variable, so the whole update cycle can be
// exercised against scripts/update-harness/ without publishing anything.
//
// The property these tests defend: a value that is set but unusable is
// reported as invalid, never silently ignored. Someone who sets the override
// believes they are testing against their own feed. If a typo made the app
// fall back to the production feed, their test would pass against the wrong
// updates, which is worse than no test at all.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { resolveUpdateFeed } = require('../../electron/update-feed.js');

describe('no override set', () => {
  test('an absent variable means no override', () => {
    assert.deepStrictEqual(resolveUpdateFeed({}), { kind: 'none' });
  });

  test('an empty string means no override', () => {
    assert.deepStrictEqual(resolveUpdateFeed({ RUNDOCK_UPDATE_FEED: '' }), { kind: 'none' });
  });

  test('whitespace only means no override', () => {
    assert.deepStrictEqual(resolveUpdateFeed({ RUNDOCK_UPDATE_FEED: '   ' }), { kind: 'none' });
  });

  test('a missing env object means no override', () => {
    assert.deepStrictEqual(resolveUpdateFeed(undefined), { kind: 'none' });
  });
});

describe('a usable override', () => {
  test('an http URL is accepted', () => {
    const feed = resolveUpdateFeed({ RUNDOCK_UPDATE_FEED: 'http://localhost:8384' });
    assert.strictEqual(feed.kind, 'feed');
    assert.strictEqual(feed.url, 'http://localhost:8384');
  });

  test('an https URL is accepted', () => {
    const feed = resolveUpdateFeed({ RUNDOCK_UPDATE_FEED: 'https://feeds.example.com/rundock' });
    assert.strictEqual(feed.kind, 'feed');
    assert.strictEqual(feed.url, 'https://feeds.example.com/rundock');
  });

  test('surrounding whitespace is trimmed', () => {
    const feed = resolveUpdateFeed({ RUNDOCK_UPDATE_FEED: '  http://localhost:8384  ' });
    assert.strictEqual(feed.kind, 'feed');
    assert.strictEqual(feed.url, 'http://localhost:8384');
  });
});

describe('an unusable override is invalid, never ignored', () => {
  test('a non-URL value is invalid', () => {
    const feed = resolveUpdateFeed({ RUNDOCK_UPDATE_FEED: 'not a url' });
    assert.strictEqual(feed.kind, 'invalid');
    assert.ok(feed.reason.length > 0);
  });

  test('a non-http scheme is invalid', () => {
    const feed = resolveUpdateFeed({ RUNDOCK_UPDATE_FEED: 'ftp://localhost:8384' });
    assert.strictEqual(feed.kind, 'invalid');
  });

  test('a host without a scheme is invalid', () => {
    // The URL parser reads "localhost:8384" as scheme "localhost:", so this
    // must be rejected explicitly rather than accidentally accepted.
    const feed = resolveUpdateFeed({ RUNDOCK_UPDATE_FEED: 'localhost:8384' });
    assert.strictEqual(feed.kind, 'invalid');
  });

  test('the invalid result echoes the value so the typo is findable', () => {
    const feed = resolveUpdateFeed({ RUNDOCK_UPDATE_FEED: 'htp://localhost:8384' });
    assert.strictEqual(feed.kind, 'invalid');
    assert.ok(feed.reason.includes('htp://localhost:8384'));
  });
});
