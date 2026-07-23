'use strict';
// Which conversation a permission (PreToolUse hook) request belongs to.
// Regression suite for the L10 misattribution bug: when the hook forwarded an
// empty conversation_id, the client fell back to whatever conversation was on
// screen, so a background agent's approval card could appear in (and be
// answered from) the wrong conversation. The server now resolves the owning
// conversation from the session_id of the running process instead.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { resolvePermissionConvoId } = require('../../permission-routing.js');

describe('resolvePermissionConvoId', () => {
  // conversationId -> running process entry (carrying the session id).
  const procs = new Map([
    ['c-active', { sessionId: 's-active' }],
    ['c-bg', { sessionId: 's-bg' }],
  ]);

  test('an explicit conversation_id always wins, even against a different session', () => {
    assert.strictEqual(resolvePermissionConvoId('c-bg', 's-active', procs), 'c-bg');
  });

  test('an empty conversation_id resolves from the session of the running process', () => {
    assert.strictEqual(resolvePermissionConvoId('', 's-bg', procs), 'c-bg');
    assert.strictEqual(resolvePermissionConvoId('', 's-active', procs), 'c-active');
  });

  test('an empty id with an unmatched session yields empty, never a wrong convo', () => {
    assert.strictEqual(resolvePermissionConvoId('', 's-unknown', procs), '');
  });

  test('an empty id with no session yields empty (no active-conversation fallback here)', () => {
    assert.strictEqual(resolvePermissionConvoId('', '', procs), '');
    assert.strictEqual(resolvePermissionConvoId('', undefined, procs), '');
    assert.strictEqual(resolvePermissionConvoId(undefined, undefined, procs), '');
  });

  test('degrades safely when there are no tracked processes', () => {
    assert.strictEqual(resolvePermissionConvoId('', 's-bg', new Map()), '');
    assert.strictEqual(resolvePermissionConvoId('', 's-bg', undefined), '');
  });
});
