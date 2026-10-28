'use strict';
// After a save fails and its previous content could not be put back either
// (`incomplete`), the page treats what its own failed write left on disk as
// its own: it keeps the person's text, raises no "changed outside Rundock"
// choice for it, never hands it to an extension view, and the next save
// writes over it. A real outside edit, with no such save behind it, still
// raises the choice exactly as before.
//
// The code under test is cut out of public/views/files.js and public/app.js
// and run in a window with a stub socket and a stub disk, so it is the code
// that ships, and a renamed or missing piece fails here by name.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf-8');
const APP_SRC = read('public', 'app.js');
const FILES_SRC = read('public', 'views', 'files.js');

// A stretch of shipped source between two anchors. It refuses to come back
// missing, or without each function it is meant to hold.
function between(src, from, to, label, holds) {
  const start = src.indexOf(from);
  const end = start === -1 ? -1 : src.indexOf(to, start + from.length);
  assert.ok(start !== -1 && end !== -1, `the client no longer carries ${label}`);
  const piece = src.slice(start, end);
  for (const name of holds) assert.ok(piece.includes(`function ${name}(`), `${label} no longer holds ${name}`);
  return piece;
}

// One function, or one line, by its opening; refuses when it is missing.
function cutFrom(src, pattern, label) {
  const found = src.match(pattern);
  assert.ok(found, `the client no longer carries ${label}`);
  return found[0];
}

const GUARD = () => between(FILES_SRC, '// ---- External-edit guard ----', 'function destroyTiptapEditorIfActive()', 'the external-edit guard',
  ['fileSaveFailed', 'saveFileGuarded', 'hideExternalEditConflict', 'showExternalEditConflict', 'currentLiveContent', 'handleExternalFileChange']);
const SOURCES_STATE = () => between(FILES_SRC, 'let sourcesWatchId = null;', '// VIEW STATE, the page', 'the named-sources state', ['requestSources']);
const SOURCES = () => between(FILES_SRC, 'function noteSourceBaselines(list) {', '// WHAT THE SERVER SAID ABOUT HANDING', 'the named-sources replies and save',
  ['noteSourceBaselines', 'sourcesReplyArrived', 'endSourcesWatch', 'saveSourceGuarded']);
const LOAD = () => cutFrom(FILES_SRC, /function loadFileContent\(path, content\) \{[\s\S]*?\n\}/, 'loadFileContent');
// The status line's two arms and the sentence they add, for the tests that
// read what the person is told.
const APP = () => [
  cutFrom(APP_SRC, /const INCOMPLETE_SAVE_NOTE = [^\n]*;/, 'the incomplete-save sentence'),
  `function handle(d) { switch (d.type) { ${['file_save_failed', 'source_save_refused']
    .map((type) => cutFrom(APP_SRC, new RegExp(`case '${type}': \\{[\\s\\S]*?\\n    \\}`), `the ${type} arm`)).join('\n')} } }`,
].join('\n');

// Values made inside the window belong to its realm, so they are compared
// as plain data.
const plain = (v) => JSON.parse(JSON.stringify(v));

const OPEN = 'notes/a.md';
const SOURCE = 'notes/a.csv';

// A window holding the cut pieces, with the disk a test sets and a record of
// what the page sent. Everything is evaluated in one function, so the pieces
// share their state as they do in the product.
function page({ app = false } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="editor-header"></div><div id="editor-status"></div>'
    + '<div id="editor-filename"></div><div id="editor-empty"></div></body></html>', { runScripts: 'dangerously' });
  const w = dom.window;
  w.eval(read('public', 'external-refresh-model.js'));
  w.eval(read('public', 'readable-error.js'));
  w.__disk = {};
  w.__sent = [];
  w.__updates = [];
  w.eval(`window.__api = (function () {
    let currentFilePath = ${JSON.stringify(OPEN)}; let editorDirty = false; let rawFileContent = '';
    let activeFileViewer = null; let activeTiptapEditor = null; let _tiptapEditorModuleResolved = null; let editorMode = 'edit';
    let activeExtensionMount = { updateSources: (list) => window.__updates.push(list) };
    const ws = { readyState: 1, send: (m) => window.__sent.push(JSON.parse(m)) };
    const WebSocket = { OPEN: 1 };
    const fetch = async (url) => {
      const p = decodeURIComponent(String(url).split('path=')[1]);
      return p in window.__disk ? { ok: true, text: async () => window.__disk[p] } : { ok: false };
    };
    const esc = (s) => String(s);
    const closeFindBar = () => {}; const flushBoardSave = () => {}; const destroyActiveFileViewer = () => {};
    const removeFileConnections = () => {}; const updateEditorBackButton = () => {};
    const loadViewersModule = () => new Promise(() => {});
    ${GUARD()}
    ${SOURCES_STATE()}
    ${SOURCES()}
    ${LOAD()}
    ${app ? APP() : ''}
    return {
      fileSaveFailed, saveFileGuarded, handleExternalFileChange, loadFileContent,
      noteSourceBaselines, sourcesReplyArrived, endSourcesWatch, saveSourceGuarded, requestSources,
      ${app ? 'handle, note: INCOMPLETE_SAVE_NOTE,' : ''}
      watchId: () => sourcesWatchId,
      baseline: (p) => diskBaselines.get(p),
      sourceBaseline: (p) => sourceBaselines.get(p),
      editor: () => ({ path: currentFilePath, text: rawFileContent, dirty: editorDirty }),
      type: (text) => { rawFileContent = text; editorDirty = true; },
    };
  })();`);
  const banner = () => w.document.getElementById('external-edit-banner');
  const status = () => w.document.getElementById('editor-status');
  return { w, api: w.__api, banner, status, sent: w.__sent, updates: w.__updates, disk: w.__disk };
}

// The person's text, saved: the page sends it and takes it as what is on
// disk, as it does before the server has answered.
async function sentAndFailed(p, { incomplete }) {
  p.api.loadFileContent(OPEN, 'old');
  p.api.type('the person\'s text');
  p.disk[OPEN] = 'old';
  assert.strictEqual(await p.api.saveFileGuarded(OPEN, 'the person\'s text'), true);
  p.api.fileSaveFailed(OPEN, incomplete);
}

describe('the editor, after a save that could not be put back', () => {
  test('what the failed write left is taken as the baseline: no choice, and the text and its unsaved state are kept', async () => {
    const p = page();
    await sentAndFailed(p, { incomplete: true });
    p.status().textContent = 'the failure, as it was said';
    p.api.handleExternalFileChange(OPEN, 'the person\'s te');
    assert.strictEqual(p.banner(), null, 'no "changed outside Rundock" choice for the page\'s own failed write');
    assert.deepStrictEqual(plain(p.api.editor()), { path: OPEN, text: 'the person\'s text', dirty: true });
    assert.strictEqual(p.api.baseline(OPEN), 'the person\'s te');
    assert.strictEqual(p.status().textContent, 'the failure, as it was said', 'the status line is left alone');
  });

  test('the next save passes the guard and writes over it, and is the end of the mark', async () => {
    const p = page();
    await sentAndFailed(p, { incomplete: true });
    p.api.handleExternalFileChange(OPEN, 'the person\'s te');
    p.disk[OPEN] = 'the person\'s te';
    assert.strictEqual(await p.api.saveFileGuarded(OPEN, 'the person\'s text'), true);
    assert.strictEqual(p.banner(), null);
    assert.deepStrictEqual(plain(p.sent.filter((m) => m.type === 'save_file').map((m) => m.content)), ['the person\'s text', 'the person\'s text']);
    // The mark ended with that send: a real outside edit now raises the choice.
    p.api.type('more of the person\'s text');
    p.api.handleExternalFileChange(OPEN, 'an edit made outside');
    assert.ok(p.banner(), 'an outside edit after the retry raises the choice as before');
  });

  test('with no change pushed in between, the next save passes the guard too', async () => {
    const p = page();
    await sentAndFailed(p, { incomplete: true });
    p.disk[OPEN] = 'the person\'s te';
    assert.strictEqual(await p.api.saveFileGuarded(OPEN, 'the person\'s text'), true);
    assert.strictEqual(p.banner(), null);
  });

  test('opening the file again is the end of the mark: its text is the disk\'s from then on', async () => {
    const p = page();
    await sentAndFailed(p, { incomplete: true });
    p.api.loadFileContent(OPEN, 'the person\'s te');
    p.api.type('typed after the reload');
    p.api.handleExternalFileChange(OPEN, 'an edit made outside');
    assert.ok(p.banner(), 'an outside edit after a reload raises the choice as before');
  });

  test('a failed save that was put back sets no mark: a change pushed after it is treated as before', async () => {
    const p = page();
    await sentAndFailed(p, { incomplete: false });
    p.api.handleExternalFileChange(OPEN, 'an edit made outside');
    assert.ok(p.banner(), 'unsaved text and a change on disk still raise the choice');
  });

  test('a real outside edit, with no failed save behind it, is treated exactly as before', async () => {
    const dirty = page();
    dirty.api.loadFileContent(OPEN, 'old');
    dirty.api.type('the person\'s text');
    dirty.api.handleExternalFileChange(OPEN, 'an edit made outside');
    assert.ok(dirty.banner(), 'unsaved text and an outside edit raise the choice');
    const clean = page();
    clean.api.loadFileContent(OPEN, 'old');
    clean.api.handleExternalFileChange(OPEN, 'an edit made outside');
    assert.strictEqual(clean.banner(), null);
    assert.deepStrictEqual(plain(clean.api.editor()), { path: OPEN, text: 'an edit made outside', dirty: false }, 'a clean editor reloads from disk');
  });
});

// The view's source writes go through the same check against the disk.
async function mounted(p) {
  const asked = p.api.requestSources('dash.md');
  p.api.sourcesReplyArrived({ type: 'sources_resolved', watchId: p.api.watchId(), ok: true, sources: [{ path: SOURCE, content: 'old' }] });
  const resolved = await asked;
  p.api.noteSourceBaselines(resolved.sources);
  p.disk[SOURCE] = 'old';
}
const refused = (extra) => ({ type: 'source_save_refused', path: 'dash.md', source: SOURCE, reason: 'Rundock couldn\'t save this file because the drive is full.', detail: 'ENOSPC: no space left on device, write', ...extra });
const changed = (p, content) => p.api.sourcesReplyArrived({ type: 'sources_changed', watchId: p.api.watchId(), ok: true, sources: [{ path: SOURCE, content }] });

describe('a named source, after a failed save', () => {
  test('a source save the system refused drops its baseline, so trying again raises no false choice', async () => {
    const p = page();
    await mounted(p);
    assert.strictEqual(await p.api.saveSourceGuarded('dash.md', SOURCE, 'VIEW'), true);
    p.api.sourcesReplyArrived(refused());
    assert.strictEqual(await p.api.saveSourceGuarded('dash.md', SOURCE, 'VIEW'), true, 'the retry is sent');
    assert.strictEqual(p.banner(), null, 'the disk still holds what it held, which is no outside edit');
    assert.strictEqual(p.sent.filter((m) => m.type === 'save_source').length, 2);
  });

  test('what a failed write left is held back from the view and taken as the baseline; after the retry, the next list goes through', async () => {
    const p = page();
    await mounted(p);
    await p.api.saveSourceGuarded('dash.md', SOURCE, 'VIEW');
    p.api.sourcesReplyArrived(refused({ incomplete: true }));
    changed(p, 'VI');
    assert.deepStrictEqual(plain(p.updates), [], 'the view keeps the person\'s text');
    assert.strictEqual(p.api.sourceBaseline(SOURCE), 'VI');
    p.disk[SOURCE] = 'VI';
    assert.strictEqual(await p.api.saveSourceGuarded('dash.md', SOURCE, 'VIEW'), true, 'the retry passes the guard');
    assert.strictEqual(p.banner(), null);
    changed(p, 'VIEW');
    assert.deepStrictEqual(plain(p.updates), [[{ path: SOURCE, content: 'VIEW' }]], 'the list after the retry resyncs the view');
  });

  test('a mount that ends is the end of the marks it had', async () => {
    const p = page();
    await mounted(p);
    await p.api.saveSourceGuarded('dash.md', SOURCE, 'VIEW');
    p.api.sourcesReplyArrived(refused({ incomplete: true }));
    p.api.endSourcesWatch();
    await mounted(p);
    changed(p, 'a later list');
    assert.strictEqual(p.updates.length, 1, 'a new mount is handed what changes');
  });

  test('a real outside edit to a source, with no failed save behind it, raises the choice as before', async () => {
    const p = page();
    await mounted(p);
    p.disk[SOURCE] = 'an edit made outside';
    assert.strictEqual(await p.api.saveSourceGuarded('dash.md', SOURCE, 'VIEW'), false);
    assert.ok(p.banner(), 'the choice is raised');
    changed(p, 'an edit made outside');
    assert.strictEqual(p.updates.length, 1, 'and a list with no mark behind it reaches the view');
  });
});

describe('what the person is told', () => {
  const failed = (extra) => ({ type: 'file_save_failed', path: OPEN, message: 'Rundock couldn\'t save this file because the drive is full. Free up some space on the drive, then try again.', detail: 'ENOSPC: no space left on device, write', ...extra });
  const said = (p) => p.status().firstChild.nodeValue;

  test('a failed save that could not be put back says so after its own sentence, and is marked', async () => {
    const p = page({ app: true });
    assert.ok(typeof p.api.note === 'string' && /\.$/.test(p.api.note), 'one sentence');
    await sentAndFailed(p, { incomplete: false });
    p.api.handle(failed({ incomplete: true }));
    assert.strictEqual(said(p), `${failed().message} ${p.api.note}`);
    p.api.handleExternalFileChange(OPEN, 'the person\'s te');
    assert.strictEqual(p.banner(), null, 'the arm set the mark');
  });

  test('a failed save that was put back says only its own sentence', () => {
    const p = page({ app: true });
    p.api.handle(failed());
    assert.strictEqual(said(p), failed().message);
  });

  test('a source save that could not be put back says so too, and reaches the sources reply', async () => {
    const p = page({ app: true });
    await mounted(p);
    await p.api.saveSourceGuarded('dash.md', SOURCE, 'VIEW');
    p.api.handle(refused({ incomplete: true }));
    assert.strictEqual(said(p), `${refused().reason} ${p.api.note}`);
    changed(p, 'VI');
    assert.deepStrictEqual(plain(p.updates), [], 'the arm set the mark');
  });
});
