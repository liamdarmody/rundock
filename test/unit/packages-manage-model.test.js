'use strict';
// The manage model: the state the Packages and Extensions pages share, the
// installation history the Packages page lists, and the only messages
// either page may send about installed extensions. Pure, so every promise
// about what is sent when is exhausted here without a page. Updates are the
// update model's (packages-update-model.test.js); this model only hears
// which packages have a newer release.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const model = require('../../public/packages-manage-model.js');

// A roster entry as the server's reader answers it.
function entry(extra = {}) {
  return {
    id: 'csv-echo', name: 'csv-echo', version: '1.0.0', enabled: true,
    renderers: [{ id: 'view', target: '.csv' }], refusals: [], resources: [],
    source: { url: 'https://github.com/example/csv-echo', reference: 'v1.0.0' },
    installedAt: '2026-08-25T10:00:00.000Z',
    ...extra,
  };
}

function loaded(extensions, receipts = [], extra = {}) {
  return model.reply(model.initial(), { type: 'packages_page', extensions, receipts, ...extra }).state;
}


describe('the messages the pages send, and when', () => {
  test('opening asks for the page; enable and disable name the extension and the flag', () => {
    const opened = model.open(model.initial());
    assert.deepStrictEqual([opened.send, opened.state.busy], [{ type: 'get_packages_page' }, { operation: 'page', name: null }]);
    assert.deepStrictEqual(model.setEnabled(loaded([entry()]), 'csv-echo', false).send, { type: 'set_extension_enabled', name: 'csv-echo', enabled: false });
    assert.deepStrictEqual(model.setEnabled(loaded([entry({ enabled: false })]), 'csv-echo', true).send, { type: 'set_extension_enabled', name: 'csv-echo', enabled: true });
  });

  test('a state reply carries the fresh roster; a second action while one is in flight, or an unknown name, sends nothing', () => {
    const busy = model.setEnabled(loaded([entry()]), 'csv-echo', false).state;
    const next = model.reply(busy, { type: 'extension_state', operation: 'set-enabled', name: 'csv-echo', enabled: false, extensions: [entry({ enabled: false })] }).state;
    assert.deepStrictEqual([next.busy, next.extensions[0].enabled], [null, false]);
    assert.strictEqual(model.setEnabled(busy, 'csv-echo', false).send, undefined);
    assert.strictEqual(model.setEnabled(loaded([entry()]), 'ghost', false).send, undefined);
  });

  test('an error for the operation in flight lands as a danger note on that extension and frees the page; an error for another operation changes nothing', () => {
    const busy = model.setEnabled(loaded([entry()]), 'csv-echo', false).state;
    const next = model.reply(busy, { type: 'package_install_error', operation: 'set-enabled', token: null, message: 'the store could not be written', code: null }).state;
    assert.strictEqual(next.busy, null);
    assert.deepStrictEqual(next.notes['csv-echo'], { text: 'the store could not be written', tone: 'danger' });
    const state = loaded([entry()]);
    assert.strictEqual(model.reply(state, { type: 'package_install_error', operation: 'install', token: 'pkg-1', message: 'x' }).state, state);
  });

  test('a completed install, import or update asks for the page again, but only once the page has been read; a projection asks nothing', () => {
    const state = loaded([entry()]);
    assert.deepStrictEqual(model.reply(state, { type: 'extension_install_result', operation: 'install', token: 'pkg-1', record: entry() }).send, { type: 'get_packages_page' });
    assert.deepStrictEqual(model.reply(state, { type: 'package_import_result', operation: 'apply', status: 'ready', writes: [] }).send, { type: 'get_packages_page' });
    assert.deepStrictEqual(model.reply(state, { type: 'package_update_result', status: 'ready', id: 'x' }).send, { type: 'get_packages_page' });
    assert.strictEqual(model.reply(state, { type: 'package_update_result', status: 'stale', id: 'x' }).send, undefined, 'a stale update changed nothing');
    assert.strictEqual(model.reply(state, { type: 'package_import_result', operation: 'evaluate', status: 'ready' }).send, undefined);
    assert.strictEqual(model.reply(model.initial(), { type: 'extension_install_result', operation: 'install', token: 'pkg-1', record: entry() }).send, undefined);
  });

  test('a lost connection frees the page with the reason on the extension, and sends nothing', () => {
    const out = model.connectionLost(model.setEnabled(loaded([entry()]), 'csv-echo', false).state);
    assert.deepStrictEqual([out.send, out.state.busy], [undefined, null]);
    assert.match(out.state.notes['csv-echo'].text, /connection dropped/);
  });

  test('nothing this model can do sends an update message', () => {
    assert.ok(!('checkForUpdate' in model) && !('updateTarget' in model) && !('retryTarget' in model));
  });
});

describe('a newer release reaches the extension its package installed', () => {
  test('a package\'s check is matched to its extension by source, and says nothing to any other', () => {
    const state = loaded([entry(), entry({ id: 'other', name: 'other', source: { url: 'https://github.com/example/other', reference: 'v1.0.0' } })]);
    const next = model.reply(state, { type: 'package_update_status', id: 'https://github.com/example/csv-echo', outcome: 'newer-available', current: 'v1.0.0', newer: ['v1.1.0'] }).state;
    assert.deepStrictEqual(next.statuses, { 'csv-echo': { outcome: 'newer-available', newer: ['v1.1.0'], current: 'v1.0.0' } });
    assert.strictEqual(model.reply(state, { type: 'package_update_status', id: 'https://github.com/example/none', outcome: 'newer-available', newer: ['v2.0.0'] }).state, state);
  });
});

describe('pausing every extension', () => {
  test('the switch asks by no name, and its reply frees the wait', () => {
    const out = model.setAllOff(loaded([entry()]), true);
    assert.deepStrictEqual(out.send, { type: 'set_extensions_all_off', off: true });
    const on = model.reply(out.state, { type: 'extension_state', operation: 'set-all-off', allOff: true, extensions: [entry({ enabled: false, allOff: true, ownEnabled: true })] }).state;
    assert.deepStrictEqual([on.busy, on.allOff], [null, true]);
  });

  // The switch is asked for by no name, so its refusal carries none either;
  // it must still free the wait and say why, or the button reads "Pausing…"
  // for ever.
  test('a refusal of the switch frees the wait and says why beneath the list', () => {
    const out = model.setAllOff(loaded([entry()]), true);
    const next = model.reply(out.state, { type: 'package_install_error', operation: 'set-all-off', message: 'extension records unreadable' }).state;
    assert.strictEqual(next.busy, null);
    assert.deepStrictEqual(next.notice, { text: 'extension records unreadable', tone: 'danger' });
    const other = model.reply(out.state, { type: 'package_install_error', operation: 'install', message: 'nope' }).state;
    assert.deepStrictEqual(other.busy, out.state.busy, 'an install\'s error is not the switch\'s');
  });

  test('a roster another window was sent updates this page without disturbing its wait', () => {
    const waiting = { ...loaded([entry()]), busy: { operation: 'set-enabled', name: 'csv-echo' } };
    const next = model.reply(waiting, { type: 'extensions', allOff: true, extensions: [entry({ enabled: false, allOff: true, ownEnabled: true })] }).state;
    assert.strictEqual(next.allOff, true);
    assert.deepStrictEqual(next.busy, waiting.busy);
  });
});

describe('the saved-updates folder', () => {
  test('its size is said only when there is something in it', () => {
    assert.strictEqual(model.folderLabel(loaded([], [])), null);
    assert.strictEqual(model.folderLabel(loaded([], [], { updatesFolder: { bytes: 2048, files: 3 } })),
      'Saved during updates: 3 files, 2 KB, kept in .rundock/package-updates. Nothing clears it by itself.');
  });
});

describe('the package cards ride on the page read', () => {
  test('the page reply carries them, and an uninstall reads the page again', () => {
    const cards = [{ id: 'https://github.com/a/b', items: [], counts: {} }];
    const state = loaded([], [], { packages: cards });
    assert.deepStrictEqual(state.packages, cards);
    assert.deepStrictEqual(model.reply(state, { type: 'package_uninstall_result', id: 'https://github.com/a/b' }).send, { type: 'get_packages_page' });
  });
});
