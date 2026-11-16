'use strict';
// AN OPEN CARD SURVIVES A SWITCH TO ANOTHER CONVERSATION AND BACK.
//
// A card used to be kept for later only when it arrived while its
// conversation was in the background. One drawn while its conversation was on
// screen lived in the page alone: switch away and the page was replaced, come
// back and nothing redrew it, and the request waited with no card until the
// server timed it out and denied it. Every card drawn in a conversation is now
// held per conversation from the moment it can be answered, so the redraw on
// return finds it, and every way a request ends takes it out again.
const { test, describe } = require('node:test');
const assert = require('node:assert');

const P = require('../../public/permissions.js');

describe('the conversations left waiting on the person', () => {
  const payload = id => ({ request_id: id, request: { tool_name: 'Bash', input: { command: 'npm test' } } });

  test('every conversation holding a request is waiting, except the one on screen', () => {
    const byConvo = new Map();
    P.queuePendingPermission(byConvo, 'convo-a', 'r1', payload('r1'));
    P.queuePendingPermission(byConvo, 'convo-b', 'r2', payload('r2'));
    P.queuePendingPermission(byConvo, 'convo-b', 'r3', payload('r3'));
    assert.deepStrictEqual(P.waitingConversations(byConvo, 'convo-a'), ['convo-b']);
    assert.deepStrictEqual(P.waitingConversations(byConvo, 'convo-b'), ['convo-a']);
    assert.deepStrictEqual(P.waitingConversations(byConvo, 'convo-c'), ['convo-a', 'convo-b'], 'on a third, both wait');
    assert.deepStrictEqual(P.waitingConversations(byConvo, null), ['convo-a', 'convo-b'], 'with none on screen, both wait');
  });

  test('a conversation whose last request was taken out is no longer waiting', () => {
    const byConvo = new Map();
    P.queuePendingPermission(byConvo, 'convo-a', 'r1', payload('r1'));
    P.removePendingPermission(byConvo, 'r1');
    assert.deepStrictEqual(P.waitingConversations(byConvo, 'convo-b'), []);
    byConvo.set('convo-c', new Map());
    assert.deepStrictEqual(P.waitingConversations(byConvo, 'convo-b'), [], 'an empty bucket holds nothing to wait on');
  });

  test('a request with no conversation of its own is never a conversation waiting', () => {
    const byConvo = new Map();
    P.queuePendingPermission(byConvo, '', 'r1', payload('r1'));
    assert.deepStrictEqual(P.waitingConversations(byConvo, 'convo-a'), []);
  });
});
