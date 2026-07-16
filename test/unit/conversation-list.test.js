'use strict';
// Unit tests for public/conversation-list.js: the sidebar ordering model.
// The WhatsApp-model rules (pinned group first, both groups by recency,
// pills filter without reordering) shipped in 0.10.0; these tests pin them.
const { test, describe } = require('node:test');
const assert = require('node:assert');

const M = require('../../public/conversation-list.js');

const convo = (id, over = {}) => ({ id, status: 'active', pinned: false, ...over });

describe('sortKeyTime and comparators', () => {
  test('sort key falls back lastActiveAt -> pinnedAt -> createdAt -> empty', () => {
    assert.strictEqual(M.sortKeyTime({ lastActiveAt: 'A', pinnedAt: 'B', createdAt: 'C' }), 'A');
    assert.strictEqual(M.sortKeyTime({ pinnedAt: 'B', createdAt: 'C' }), 'B');
    assert.strictEqual(M.sortKeyTime({ createdAt: 'C' }), 'C');
    assert.strictEqual(M.sortKeyTime({}), '');
  });

  test('compareTimeDesc orders newest first, lexically on ISO strings', () => {
    const a = { lastActiveAt: '2026-07-16T10:00:00Z' };
    const b = { lastActiveAt: '2026-07-16T11:00:00Z' };
    assert.ok(M.compareTimeDesc(a, b) > 0);
    assert.ok(M.compareTimeDesc(b, a) < 0);
  });

  test('pinnedFirst groups pinned above unpinned, recency within each group', () => {
    const pinnedOld = convo('p-old', { pinned: true, lastActiveAt: '2026-07-01T00:00:00Z' });
    const unpinnedNew = convo('u-new', { lastActiveAt: '2026-07-16T00:00:00Z' });
    assert.ok(M.pinnedFirst(pinnedOld, unpinnedNew) < 0, 'an old pinned convo still outranks a fresh unpinned one');
  });
});

describe('partitionConversations', () => {
  const data = [
    convo('active-new', { lastActiveAt: '2026-07-16T09:00:00Z' }),
    convo('archived-a', { status: 'archived', lastActiveAt: '2026-07-15T00:00:00Z' }),
    convo('pinned-old', { pinned: true, lastActiveAt: '2026-07-10T00:00:00Z', pinnedAt: '2026-07-11T00:00:00Z' }),
    convo('active-old', { lastActiveAt: '2026-07-12T00:00:00Z' }),
    convo('archived-b', { status: 'archived', lastActiveAt: '2026-07-16T00:00:00Z' }),
  ];

  test('main list: pinned first, then recency; archived excluded', () => {
    const { main } = M.partitionConversations(data, {});
    assert.deepStrictEqual(main.map(c => c.id), ['pinned-old', 'active-new', 'active-old']);
  });

  test('archived section: recency only, pinning irrelevant', () => {
    const { archived } = M.partitionConversations(data, {});
    assert.deepStrictEqual(archived.map(c => c.id), ['archived-b', 'archived-a']);
  });

  test('unread pill filters main to the unread set, ordering rules unchanged', () => {
    const unread = new Set(['active-old', 'pinned-old']);
    const { main } = M.partitionConversations(data, { pill: 'unread', unreadIds: unread });
    assert.deepStrictEqual(main.map(c => c.id), ['pinned-old', 'active-old']);
  });

  test('unread pill with nothing unread yields an empty main list', () => {
    const { main } = M.partitionConversations(data, { pill: 'unread', unreadIds: new Set() });
    assert.deepStrictEqual(main, []);
  });

  test('does not mutate the input array order', () => {
    const before = data.map(c => c.id);
    M.partitionConversations(data, {});
    assert.deepStrictEqual(data.map(c => c.id), before);
  });
});

describe('itemVariant', () => {
  test('persisted and not pinned renders as previous (delete affordance)', () => {
    assert.strictEqual(M.itemVariant(convo('a', { persisted: true })), 'previous');
  });
  test('live items and pinned-persisted items stay current (pin affordance)', () => {
    assert.strictEqual(M.itemVariant(convo('b')), 'current');
    assert.strictEqual(M.itemVariant(convo('c', { persisted: true, pinned: true })), 'current');
  });
});
