'use strict';
// Each place a system error reaches a person carries the plain sentence and,
// beside it, the raw words for the "Details" control (public/readable-error.js).
//
// The install card, the editor save, the file create, the workspace open and
// the run-now refusal are driven through their real handlers in their own
// suites (extension-install, files-handler-edges, protocol-handlers-lib,
// ws-handler-edges, run-now) and the routines and run detail screens through
// their real views (routines-view, run-detail-view). This file holds the rest:
// a package's update or uninstall row, an extension's row and switch, the
// Packages page itself, and a save an extension view makes to a named source.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const updateModel = require('../../public/packages-update-model.js');
const manageModel = require('../../public/packages-manage-model.js');
const extensionsView = require('../../public/extensions-view-model.js');
const RE = require('../../public/readable-error.js');

const RAW = "EBUSY: resource busy or locked, unlink 'C:\\Users\\example\\Workspace\\.claude\\agents\\analyst.md'";
const SENTENCE = RE.describe(Object.assign(new Error(RAW), { code: 'EBUSY', syscall: 'unlink' })).message;
const ID = 'https://github.com/someone/investment-partner';
const CARD = {
  id: ID, name: 'investment-partner', title: 'Investment Partner', repo: 'someone/investment-partner', updatable: true,
  reference: 'v1.0.0', commit: 'a'.repeat(40), extension: null, counts: { agent: 1 }, items: [],
};

describe('a package row', () => {
  for (const operation of ['package-update', 'package-uninstall']) {
    test(`a ${operation} the system refuses shows the sentence, with Details`, () => {
      const busy = operation === 'package-update'
        ? { ...updateModel.initial(), busy: { operation, id: ID } }
        : { ...updateModel.initial(), uninstall: { id: ID, plan: null, busy: true } };
      const state = updateModel.reply(busy, { type: 'package_install_error', operation, id: ID, message: SENTENCE, detail: RAW }).state;
      const status = updateModel.statusFor(state, CARD, false);
      assert.deepStrictEqual(status, { text: SENTENCE, tone: 'danger', detail: RAW });
    });
  }

  test('a refusal with no system error carries no Details', () => {
    const busy = { ...updateModel.initial(), busy: { operation: 'package-update', id: ID } };
    const state = updateModel.reply(busy, { type: 'package_install_error', operation: 'package-update', id: ID, message: 'nothing is awaiting this confirmation', detail: null }).state;
    assert.strictEqual('detail' in updateModel.statusFor(state, CARD, false), false);
  });
});

describe('an extension row, the pause switch and the page', () => {
  const entry = { id: 'csv-echo', name: 'csv-echo', version: '1.0.0', enabled: true, renderers: [], refusals: [], resources: [], installedAt: '2026-08-25T10:00:00.000Z' };
  const loaded = () => manageModel.reply(manageModel.initial(), { type: 'packages_page', extensions: [entry], receipts: [] }).state;

  test('a switch the system refuses notes the row with the sentence and Details', () => {
    const waiting = { ...loaded(), busy: { operation: 'set-enabled', name: 'csv-echo' } };
    const state = manageModel.reply(waiting, { type: 'package_install_error', operation: 'set-enabled', name: 'csv-echo', message: SENTENCE, detail: RAW }).state;
    assert.deepStrictEqual(state.notes['csv-echo'], { text: SENTENCE, tone: 'danger', detail: RAW });
    const [row] = extensionsView.rows(state, { now: new Date(2026, 8, 1) });
    assert.strictEqual(row.note.detail, RAW, 'the row the view draws carries it');
  });

  test('pausing every extension, refused by the system, says so beneath the list with Details', () => {
    const waiting = { ...loaded(), busy: { operation: 'set-all-off', name: null } };
    const state = manageModel.reply(waiting, { type: 'package_install_error', operation: 'set-all-off', message: SENTENCE, detail: RAW }).state;
    assert.deepStrictEqual(state.notice, { text: SENTENCE, tone: 'danger', detail: RAW });
  });

  test('a page that could not be read keeps the raw words for Details, and a later error without them shows none', () => {
    const failed = manageModel.reply(manageModel.initial(), { type: 'packages_page_error', reason: SENTENCE, detail: RAW }).state;
    assert.strictEqual(failed.errorDetail, RAW);
    const plain = manageModel.reply(failed, { type: 'packages_page_error', reason: 'No workspace is open.' }).state;
    assert.strictEqual(plain.errorDetail, null);
  });
});

describe('the Packages page handler', () => {
  test('a page read the system refuses answers the sentence and the detail', () => {
    const config = require('../../lib/config.js');
    const handlers = require('../../lib/protocol/handlers/packages.js');
    const original = config.getWorkspace();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'readable-page-'));
    // The extension records as a FOLDER where a file is read: EISDIR.
    fs.mkdirSync(path.join(dir, '.rundock', 'extensions.json'), { recursive: true });
    const sent = [];
    try {
      config.setWorkspace(dir);
      handlers.handleGetPackagesPage({}, { send: (m) => sent.push(JSON.parse(m)) });
    } finally {
      config.setWorkspace(original);
      fs.rmSync(dir, { recursive: true, force: true });
    }
    assert.strictEqual(sent[0].type, 'packages_page_error');
    assert.strictEqual(sent[0].reason, "Rundock couldn't read your packages because there is a folder where a file should be. Rename or move that folder, or choose a different name, then try again.");
    assert.match(sent[0].detail, /^EISDIR/);
  });
});

describe('a save an extension view makes to a named source', () => {
  test('a write the system refuses is answered with the sentence and Details, never dropped', () => {
    const sources = require('../../lib/protocol/handlers/sources.js');
    const config = require('../../lib/config.js');
    const original = config.getWorkspace();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'readable-source-'));
    const sent = [];
    try {
      config.setWorkspace(dir);
      // Driven where the write happens: the fs call the save ends in.
      const realWriteSync = fs.writeSync;
      fs.writeFileSync(path.join(dir, 'Board.md'), '---\nsources:\n  - data.csv\n---\n');
      fs.writeFileSync(path.join(dir, 'data.csv'), 'a,b\n');
      fs.writeSync = () => { throw Object.assign(new Error(`EPERM: operation not permitted, write '${path.join(dir, 'data.csv')}'`), { code: 'EPERM', syscall: 'write' }); };
      try {
        sources.handleSaveSource({}, { readyState: 1, send: (m) => sent.push(JSON.parse(m)) }, { path: 'Board.md', source: 'data.csv', content: 'a,b\n1,2\n' });
      } finally {
        fs.writeSync = realWriteSync;
      }
    } finally {
      config.setWorkspace(original);
      fs.rmSync(dir, { recursive: true, force: true });
    }
    assert.strictEqual(sent.length, 1, 'answered once');
    const [answer] = sent;
    assert.strictEqual(answer.type, 'source_save_refused');
    assert.match(answer.reason, /^Rundock couldn't save this file because your computer didn't allow a change to a file\./);
    assert.ok(!answer.reason.includes(dir), 'no path in the sentence');
    assert.ok(answer.detail.includes('EPERM') && answer.detail.includes(dir), 'code and path are in the detail');
  });
});
