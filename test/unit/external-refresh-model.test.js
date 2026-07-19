'use strict';
// Unit tests for the live-external-refresh decision model.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { externalChangeAction } = require('../../public/external-refresh-model.js');

describe('externalChangeAction', () => {
  test('disk matches current content: no-op (our own save echoed back)', () => {
    assert.strictEqual(
      externalChangeAction({ current: 'a\n', baseline: 'a\n', disk: 'a\n' }), 'noop');
    // Even mid-edit, if disk happens to equal what we have, nothing to do.
    assert.strictEqual(
      externalChangeAction({ current: 'edited\n', baseline: 'orig\n', disk: 'edited\n' }), 'noop');
  });

  test('read-only surface (null current): always reload the newer bytes', () => {
    assert.strictEqual(
      externalChangeAction({ current: null, baseline: 'a\n', disk: 'b\n' }), 'reload');
  });

  test('clean editor (current equals baseline): reload seamlessly', () => {
    assert.strictEqual(
      externalChangeAction({ current: 'a\n', baseline: 'a\n', disk: 'b\n' }), 'reload');
  });

  test('unsaved local edits differ from disk: conflict', () => {
    assert.strictEqual(
      externalChangeAction({ current: 'my edit\n', baseline: 'a\n', disk: 'their edit\n' }), 'conflict');
  });
});
