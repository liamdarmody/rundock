// Tests for the pending-update launch counter (electron/update-launches.js).
//
// When an update downloads but does not install, each subsequent launch is
// evidence the install is failing. After enough of them the app stops
// pretending the next restart will work and offers a direct download instead
// (see electron/update-state.js). This module owns the counting; these tests
// pin down what counts as "another launch with the update still pending".
//
// The property that matters most: the counter must reset the moment an
// update actually applies, or a user whose install once got stuck would see
// the failure message forever, on every version, for the rest of time.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { reconcileOnLaunch, recordDownloaded } = require('../../electron/update-launches.js');

describe('nothing pending', () => {
  test('no stored record means zero launches pending', () => {
    assert.deepStrictEqual(
      reconcileOnLaunch({ currentVersion: '0.11.5', stored: null }),
      { record: null, launchesSinceDownload: 0 }
    );
  });

  test('a malformed record is discarded, not counted', () => {
    assert.deepStrictEqual(
      reconcileOnLaunch({ currentVersion: '0.11.5', stored: { junk: true } }),
      { record: null, launchesSinceDownload: 0 }
    );
  });

  test('a record that is not an object is discarded', () => {
    assert.deepStrictEqual(
      reconcileOnLaunch({ currentVersion: '0.11.5', stored: 'corrupt' }),
      { record: null, launchesSinceDownload: 0 }
    );
  });
});

describe('the update applied', () => {
  test('running the downloaded version clears the record', () => {
    const out = reconcileOnLaunch({
      currentVersion: '0.11.6',
      stored: { downloadedVersion: '0.11.6', launches: 2 },
    });
    assert.deepStrictEqual(out, { record: null, launchesSinceDownload: 0 });
  });
});

describe('the update is still pending', () => {
  test('each launch on the old version increments the count', () => {
    const out = reconcileOnLaunch({
      currentVersion: '0.11.5',
      stored: { downloadedVersion: '0.11.6', launches: 1 },
    });
    assert.deepStrictEqual(out, {
      record: { downloadedVersion: '0.11.6', launches: 2 },
      launchesSinceDownload: 2,
    });
  });

  test('a record with a corrupt count restarts from one', () => {
    const out = reconcileOnLaunch({
      currentVersion: '0.11.5',
      stored: { downloadedVersion: '0.11.6', launches: 'many' },
    });
    assert.deepStrictEqual(out, {
      record: { downloadedVersion: '0.11.6', launches: 1 },
      launchesSinceDownload: 1,
    });
  });
});

describe('a fresh download', () => {
  test('starts the count at zero for that version', () => {
    assert.deepStrictEqual(recordDownloaded('0.11.6'), {
      downloadedVersion: '0.11.6',
      launches: 0,
    });
  });

  test('re-downloading the same pending version keeps the count', () => {
    // A stuck install downloads the same update again on every launch. If
    // that reset the count, the count could never reach the threshold and
    // the escape hatch would be unreachable by exactly the users who need
    // it.
    const out = recordDownloaded('0.11.6', { downloadedVersion: '0.11.6', launches: 2 });
    assert.deepStrictEqual(out, { downloadedVersion: '0.11.6', launches: 2 });
  });

  test('a different pending version starts over', () => {
    const out = recordDownloaded('0.11.7', { downloadedVersion: '0.11.6', launches: 2 });
    assert.deepStrictEqual(out, { downloadedVersion: '0.11.7', launches: 0 });
  });

  test('a newer download replaces the count, not extends it', () => {
    // 0.11.6 got stuck at 3 launches, then 0.11.7 downloads. The new
    // version deserves a fresh chance before being called stuck.
    const afterNewDownload = recordDownloaded('0.11.7');
    const out = reconcileOnLaunch({ currentVersion: '0.11.5', stored: afterNewDownload });
    assert.deepStrictEqual(out, {
      record: { downloadedVersion: '0.11.7', launches: 1 },
      launchesSinceDownload: 1,
    });
  });
});
