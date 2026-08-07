// Tests for the update strip's view decision (public/update-strip-view.js).
//
// The sidebar's update surface has two weights: a collapsed ring while a
// download runs (ambient, ignorable) and an expanded row when an update is
// ready (the one moment the feature exists for, so it is visible by
// default). "Later" defers the ready row to a small chip; it never
// dismisses, because the pending update is still pending no matter what the
// interface shows.
//
// Input is exactly what the main process sends the renderer: the decided UI
// object from the updater's decision module. This module only chooses how
// the strip presents it.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const updateStripView = require('../../public/update-strip-view.js');

describe('nothing to show', () => {
  test('no update activity hides the strip', () => {
    assert.deepStrictEqual(updateStripView({ kind: 'none' }, false), { show: false });
  });

  test('a dialog-only decision hides the strip (the dialog is native)', () => {
    assert.deepStrictEqual(updateStripView({ kind: 'dialog', dialog: {} }, false), { show: false });
  });

  test('missing input hides the strip rather than throwing', () => {
    assert.deepStrictEqual(updateStripView(null, false), { show: false });
    assert.deepStrictEqual(updateStripView(undefined, true), { show: false });
  });
});

describe('downloading', () => {
  test('progress shows the download mode with a percentage', () => {
    const v = updateStripView({ kind: 'progress', percent: 67, indeterminate: false, text: 'Downloading Rundock 0.12.0. You can keep working.' }, false);
    assert.strictEqual(v.show, true);
    assert.strictEqual(v.mode, 'download');
    assert.strictEqual(v.percent, 67);
    assert.strictEqual(v.indeterminate, false);
    assert.ok(v.text.includes('0.12.0'));
  });

  test('before the first progress event the ring is indeterminate', () => {
    const v = updateStripView({ kind: 'progress', percent: 0, indeterminate: true, text: 'Downloading an update. You can keep working.' }, false);
    assert.strictEqual(v.mode, 'download');
    assert.strictEqual(v.indeterminate, true);
  });

  test('a deferred choice does not apply to downloading', () => {
    // "Later" belongs to the ready state; a new download shows normally.
    const v = updateStripView({ kind: 'progress', percent: 10, indeterminate: false, text: 't' }, true);
    assert.strictEqual(v.mode, 'download');
  });
});

describe('ready to install', () => {
  const ready = { kind: 'ready', version: '0.12.0', text: 'Rundock 0.12.0 is ready to install.', detail: 'Restarting takes a few seconds.' };

  test('ready is expanded by default, with restart offered', () => {
    const v = updateStripView(ready, false);
    assert.strictEqual(v.show, true);
    assert.strictEqual(v.mode, 'ready');
    assert.ok(v.text.includes('ready to install'));
    assert.strictEqual(v.canRestart, true);
  });

  test('Later defers ready to the quiet chip, never dismisses', () => {
    const v = updateStripView(ready, true);
    assert.strictEqual(v.show, true);
    assert.strictEqual(v.mode, 'chip');
  });

  test('the stuck state shows expanded and ignores deferral', () => {
    // Repeated failed installs are an escalation; quieting it defeats the
    // escape hatch. The native dialog carries the download link; the strip
    // stays visible with the plain message.
    const stuck = { kind: 'stuck', text: 'An update was downloaded but has not installed after several restarts.', downloadUrl: 'https://example.invalid/download' };
    const v = updateStripView(stuck, true);
    assert.strictEqual(v.mode, 'ready');
    assert.ok(v.text.includes('has not installed'));
    assert.strictEqual(v.canRestart, true);
  });
});
