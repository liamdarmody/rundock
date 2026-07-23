'use strict';
// Conversation unread-signal bookkeeping, tracked by REASON so resolving one
// reason never clears another. Regression suite for L4: a background permission
// card timing out must clear its own contribution to the unread badge, but must
// NOT wipe a co-occurring unread agent message. The client wiring in app.js is
// DOM glue (not unit-testable), so this module is where the logic is pinned.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { createUnreadState } = require('../../public/unread-state.js');

describe('createUnreadState', () => {
  test('an unread message marks the conversation unread', () => {
    const u = createUnreadState();
    assert.strictEqual(u.isUnread('c1'), false);
    u.markMessage('c1');
    assert.strictEqual(u.isUnread('c1'), true);
  });

  test('a pending permission marks the conversation unread', () => {
    const u = createUnreadState();
    u.markPermission('c1');
    assert.strictEqual(u.isUnread('c1'), true);
  });

  test('ids() is the union of both reasons; size() counts distinct conversations', () => {
    const u = createUnreadState();
    u.markMessage('c1');
    u.markPermission('c2');
    u.markMessage('c3'); u.markPermission('c3'); // both reasons, same convo
    assert.deepStrictEqual([...u.ids()].sort(), ['c1', 'c2', 'c3']);
    assert.strictEqual(u.size(), 3);
  });

  test('clearConvo clears every reason and reports whether anything was cleared', () => {
    const u = createUnreadState();
    u.markMessage('c1'); u.markPermission('c1');
    assert.strictEqual(u.clearConvo('c1'), true);
    assert.strictEqual(u.isUnread('c1'), false);
    assert.strictEqual(u.clearConvo('c1'), false); // nothing left to clear
  });

  // THE L4 fix: a permission resolving (answered elsewhere or timed out) clears
  // only the permission reason; a co-occurring unread message survives.
  test('resolvePermission clears the permission reason only, keeping an unread message', () => {
    const u = createUnreadState();
    u.markMessage('c1');
    u.markPermission('c1');
    u.resolvePermission('c1');
    assert.strictEqual(u.isUnread('c1'), true, 'still unread: the message remains');
    assert.ok(u.ids().has('c1'));
  });

  test('resolvePermission on a permission-only conversation clears the signal', () => {
    const u = createUnreadState();
    u.markPermission('c1');
    u.resolvePermission('c1');
    assert.strictEqual(u.isUnread('c1'), false, 'badge clears when nothing else keeps it unread');
    assert.strictEqual(u.size(), 0);
  });

  test('clearAll resets every conversation and reason', () => {
    const u = createUnreadState();
    u.markMessage('c1'); u.markPermission('c2');
    u.clearAll();
    assert.strictEqual(u.size(), 0);
    assert.strictEqual(u.isUnread('c1'), false);
    assert.strictEqual(u.isUnread('c2'), false);
  });

  test('falsy conversation ids are ignored, never marked unread', () => {
    const u = createUnreadState();
    u.markMessage('');
    u.markPermission(undefined);
    assert.strictEqual(u.size(), 0);
  });

  test('independent instances do not share state', () => {
    const a = createUnreadState();
    const b = createUnreadState();
    a.markMessage('c1');
    assert.strictEqual(b.isUnread('c1'), false);
  });
});
