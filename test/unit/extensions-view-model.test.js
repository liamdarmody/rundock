'use strict';
// What the Extensions page shows per row, from the manage model's own state.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const V = require('../../public/extensions-view-model.js');
const Manage = require('../../public/packages-manage-model.js');

const NOW = new Date('2026-09-24T12:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000).toISOString();
function state(extensions, extra) {
  return { ...Manage.initial(), loaded: true, extensions, ...extra };
}

describe('each row', () => {
  test('name, version, when it was added, and its own setting as On or Off', () => {
    const [on, off] = V.rows(state([
      { id: 'investment-partner', version: '1.0.0', installedAt: daysAgo(2), enabled: true },
      { id: 'broken-sync', version: '2.1.0', installedAt: daysAgo(95), enabled: false },
    ]), NOW);
    assert.deepStrictEqual([on.name, on.versionLabel, on.addedLabel, on.on, on.onLabel, on.switchLabel], ['investment-partner', 'v1.0.0', 'Added 2 days ago', true, 'On', 'investment-partner']);
    assert.deepStrictEqual([off.addedLabel, off.on, off.onLabel, off.failed], ['Added 3 months ago', false, 'Off', false]);
  });

  test('added: today, yesterday, days, weeks, months, years', () => {
    const at = (d) => V.addedLabel(daysAgo(d), NOW);
    assert.deepStrictEqual([0, 1, 4, 13, 42, 59, 90, 400].map(at),
      ['Added today', 'Added yesterday', 'Added 4 days ago', 'Added 13 days ago', 'Added 6 weeks ago', 'Added 8 weeks ago', 'Added 3 months ago', 'Added 1 year ago']);
    assert.strictEqual(V.addedLabel('not a date', NOW), null);
  });

  test('a row that could not load says so and has no own setting to show', () => {
    const [row] = V.rows(state([{ id: 'csv-viewer', version: '1.4.0', installedAt: daysAgo(4), broken: true, reason: 'entry missing' }]), NOW);
    assert.deepStrictEqual([row.failed, row.failedText], [true, 'Rundock couldn\'t load this extension.']);
  });

  test('a row that could not load points to its package only when the package is known, and otherwise says so plainly', () => {
    const packages = [{ id: 'https://github.com/someone/csv-viewer', title: 'Csv Viewer' }];
    const [known, unknown, working] = V.rows(state([
      { id: 'csv-viewer', broken: true, source: { url: 'https://github.com/someone/csv-viewer' } },
      { id: 'old-importer', broken: true },
      { id: 'reading-list', enabled: true, source: { url: 'https://github.com/someone/csv-viewer' } },
    ], { packages }), NOW);
    assert.deepStrictEqual(known.failedWay, { before: 'Uninstall it from ', link: 'its package', after: '.' });
    assert.deepStrictEqual(unknown.failedWay, { text: 'Rundock can\'t tell which package installed it.' });
    assert.strictEqual(working.failedWay, null);
  });

  test('paused, each row keeps its own setting, and its switch says it is paused', () => {
    const rows = V.rows(state([
      { id: 'a', enabled: false, allOff: true, ownEnabled: true },
      { id: 'b', enabled: false, allOff: true, ownEnabled: false },
    ], { allOff: true }), NOW);
    assert.deepStrictEqual(rows.map((r) => [r.on, r.onLabel, r.paused, r.switchLabel]), [[true, 'On', true, 'a, paused'], [false, 'Off', true, 'b, paused']]);
  });

  test('paused, every switch is disabled and keeps its own position', () => {
    const rows = V.rows(state([
      { id: 'a', enabled: false, allOff: true, ownEnabled: true },
      { id: 'b', enabled: false, allOff: true, ownEnabled: false },
    ], { allOff: true }), NOW);
    assert.deepStrictEqual(rows.map((r) => [r.id, r.on, r.disabled]), [['a', true, true], ['b', false, true]]);
  });

  test('not paused, no switch is disabled', () => {
    const rows = V.rows(state([{ id: 'a', enabled: true }, { id: 'b', enabled: false }], { allOff: false }), NOW);
    assert.deepStrictEqual(rows.map((r) => [r.id, r.on, r.disabled]), [['a', true, false], ['b', false, false]]);
  });

  test('the package it came from is named only where a package card names the same source', () => {
    const packages = [{ id: 'https://github.com/dougseven/investment-partner', title: 'Investment Partner' }];
    const [known, unknown] = V.rows(state([
      { id: 'investment-partner', source: { url: 'https://github.com/DougSeven/investment-partner.git' } },
      { id: 'reading-list', source: { url: 'https://github.com/someone/reading-list' } },
    ], { packages }), NOW);
    assert.deepStrictEqual(known.provenance, { name: 'Investment Partner', package: 'https://github.com/dougseven/investment-partner' });
    assert.strictEqual(unknown.provenance, null);
  });


  test('an update is flagged only when the state already knows one exists', () => {
    const ext = [{ id: 'reading-list', enabled: true }];
    assert.strictEqual(V.rows(state(ext), NOW)[0].updateAvailable, false);
    assert.strictEqual(V.rows(state(ext, { statuses: { 'reading-list': { outcome: 'newer-available', newer: ['v0.5.0'] } } }), NOW)[0].updateAvailable, true);
  });

  test('no row carries an uninstall question, and the page sends none: removal is the package\'s', () => {
    const rows = V.rows(state([{ id: 'csv-viewer' }, { id: 'broken', broken: true }], { confirming: 'csv-viewer' }), NOW);
    for (const row of rows) assert.ok(!('confirm' in row), `${row.id} carries no question`);
    assert.deepStrictEqual(V.SENDS.filter((t) => /uninstall/.test(t)), []);
  });
});

describe('the pause', () => {
  test('offered below the list when running, and a banner with Resume when paused', () => {
    assert.deepStrictEqual(V.pauseControl(state([], { allOff: false })), { paused: false, text: V.PAUSE_TEXT, label: 'Pause all extensions', disabled: false });
    const paused = V.pauseControl(state([], { allOff: true }));
    assert.deepStrictEqual([paused.paused, paused.banner, paused.label], [true, 'All extensions are paused. Each one goes back to its own setting when you resume.', 'Resume extensions']);
  });
});

describe('the name the package goes by', () => {
  test('a displayName as written, else the manifest name title-cased, else the repository name', () => {
    assert.strictEqual(V.displayNameFor({ id: 'investment-partner', displayName: 'Investment Partner Pro' }, 'x'), 'Investment Partner Pro');
    assert.strictEqual(V.displayNameFor({ id: 'investment-partner' }, 'https://github.com/o/rundock-investment-partner'), 'Investment Partner');
    assert.strictEqual(V.displayNameFor({ id: 'reading_list' }, 'x'), 'Reading List');
    assert.strictEqual(V.displayNameFor({}, 'https://github.com/o/rundock-investment-partner.git'), 'rundock-investment-partner');
  });
});
