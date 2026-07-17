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

describe('list pills (conversation Lists card)', () => {
  const listData = [
    convo('in-work', { listIds: ['l1'], lastActiveAt: '2026-07-10T00:00:00Z' }),
    convo('in-both', { listIds: ['l1', 'l2'], lastActiveAt: '2026-07-12T00:00:00Z' }),
    convo('pinned-in-work', { pinned: true, listIds: ['l1'], lastActiveAt: '2026-07-01T00:00:00Z' }),
    convo('no-lists', { lastActiveAt: '2026-07-16T00:00:00Z' }),
    convo('legacy-no-field', {}),
    convo('archived-in-work', { status: 'archived', listIds: ['l1'] }),
  ];

  test('isListPill / listPillId round the encoding', () => {
    assert.strictEqual(M.isListPill('list:abc'), true);
    assert.strictEqual(M.isListPill('all'), false);
    assert.strictEqual(M.isListPill('unread'), false);
    assert.strictEqual(M.listPillId('list:abc'), 'abc');
    assert.strictEqual(M.listPillId('all'), null);
  });

  test('a list pill filters main to that list, pinned-first ordering unchanged', () => {
    const { main } = M.partitionConversations(listData, { pill: 'list:l1' });
    assert.deepStrictEqual(main.map(c => c.id), ['pinned-in-work', 'in-both', 'in-work']);
  });

  test('many-to-many: a conversation in two lists appears under both pills', () => {
    const l1 = M.partitionConversations(listData, { pill: 'list:l1' }).main.map(c => c.id);
    const l2 = M.partitionConversations(listData, { pill: 'list:l2' }).main.map(c => c.id);
    assert.ok(l1.includes('in-both') && l2.includes('in-both'));
  });

  test('archived conversations stay in the archived section even when in the list', () => {
    const { main, archived } = M.partitionConversations(listData, { pill: 'list:l1' });
    assert.ok(!main.some(c => c.id === 'archived-in-work'));
    assert.ok(archived.some(c => c.id === 'archived-in-work'));
  });

  test('conversations without a listIds field are tolerated (legacy entries)', () => {
    const { main } = M.partitionConversations(listData, { pill: 'list:l1' });
    assert.ok(!main.some(c => c.id === 'legacy-no-field'));
    assert.strictEqual(M.inList({ id: 'x' }, 'l1'), false);
  });

  test('unknown list id yields an empty main list, not an error', () => {
    const { main } = M.partitionConversations(listData, { pill: 'list:nope' });
    assert.deepStrictEqual(main, []);
  });

  test('the all pill ignores list membership entirely', () => {
    const { main } = M.partitionConversations(listData, { pill: 'all' });
    assert.strictEqual(main.length, 5);
  });
});
