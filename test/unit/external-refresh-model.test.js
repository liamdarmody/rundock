'use strict';
// Unit tests for the live-external-refresh decision model.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { externalChangeAction } = require('../../public/external-refresh-model.js');

describe('externalChangeAction', () => {
  test('disk equals baseline: no-op (our own save echoed back, or nothing new)', () => {
    assert.strictEqual(
      externalChangeAction({ disk: 'a\n', baseline: 'a\n', dirty: false }), 'noop');
    // Even mid-edit, if disk equals what we last knew, there is nothing to do.
    assert.strictEqual(
      externalChangeAction({ disk: 'a\n', baseline: 'a\n', dirty: true }), 'noop');
  });

  test('disk moved and the editor is clean: reload seamlessly', () => {
    assert.strictEqual(
      externalChangeAction({ disk: 'b\n', baseline: 'a\n', dirty: false }), 'reload');
  });

  test('disk moved and there are unsaved edits: conflict', () => {
    assert.strictEqual(
      externalChangeAction({ disk: 'their edit\n', baseline: 'a\n', dirty: true }), 'conflict');
  });

  test('a clean file whose serialization would differ still reloads (no false conflict)', () => {
    // The decision does not depend on re-serialized content, only on the dirty
    // flag, so a non-idempotent editor never causes a false conflict.
    assert.strictEqual(
      externalChangeAction({ disk: '- item\n', baseline: '* item\n', dirty: false }), 'reload');
  });
});
