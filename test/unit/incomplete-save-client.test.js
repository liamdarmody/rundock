'use strict';
// A failed save's answer says what the file holds now (`left`), and the page
// believes it. For the editor, that is the file's baseline: the watcher's
// push of the same bytes is then no change, so the person's text and its
// unsaved state are kept with no choice raised, any other change is still
// an outside edit, and the next save passes the check. For a named source it
// is the source's baseline too, and when the previous content could not be
// put back, the view keeps the person's text over exactly those bytes until
// it saves again or the file moves on. No list is ever held back from a view.
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
// The status line's two arms and the sentence they add.
const APP = () => [
  cutFrom(APP_SRC, /const INCOMPLETE_SAVE_NOTE = [^\n]*;/, 'the incomplete-save sentence'),
  `function handle(d) { switch (d.type) { ${['file_save_failed', 'source_save_refused']
    .map((type) => cutFrom(APP_SRC, new RegExp(`case '${type}': \\{[\\s\\S]*?\\n    \\}`), `the ${type} arm`)).join('\n')} } }`,
].join('\n');

// Values made inside the window belong to its realm, so they are compared
// as plain data.
const plain = (v) => JSON.parse(JSON.stringify(v));

const OPEN = 'notes/a.md';
const NOTE = 'dash.md';
const A = 'notes/a.csv';
const B = 'notes/b.csv';

// A window holding the cut pieces, with the disk a test sets and a record of
// what the page sent and what the view was handed. Everything is evaluated
// in one function, so the pieces share their state as they do in the product.
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
    let activeExtensionMountInfo = { extension: 'dash', path: ${JSON.stringify(NOTE)} };
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
      show: (p) => { currentFilePath = p; },
    };
  })();`);
  const banner = () => w.document.getElementById('external-edit-banner');
  const status = () => w.document.getElementById('editor-status');
  return { w, api: w.__api, banner, status, sent: w.__sent, updates: w.__updates, disk: w.__disk };
}

// The person's text, saved: the page sends it and takes it as what is on
// disk, as it does before the server has answered; then the save fails, and
// the answer says what the file holds.
async function sentAndFailed(p, left) {
  p.api.loadFileContent(OPEN, 'old');
  p.api.type('the person\'s text');
  p.disk[OPEN] = 'old';
  assert.strictEqual(await p.api.saveFileGuarded(OPEN, 'the person\'s text'), true);
  p.api.fileSaveFailed(OPEN, left);
}

describe('the editor, after a failed save', () => {
  test('the watcher\'s push of the bytes the answer named is no change: no choice, the text and its unsaved state kept', async () => {
    const p = page();
    await sentAndFailed(p, 'the person\'s te');
    p.status().textContent = 'the failure, as it was said';
    p.api.handleExternalFileChange(OPEN, 'the person\'s te');
    assert.strictEqual(p.banner(), null);
    assert.deepStrictEqual(plain(p.api.editor()), { path: OPEN, text: 'the person\'s text', dirty: true });
    assert.strictEqual(p.status().textContent, 'the failure, as it was said', 'the status line is left alone');
  });

  test('any other change is an outside edit, and raises the choice', async () => {
    const p = page();
    await sentAndFailed(p, 'the person\'s te');
    p.api.handleExternalFileChange(OPEN, 'an agent rewrote this note');
    assert.ok(p.banner(), 'a real outside edit is never taken for the failed write\'s bytes');
  });

  test('the next save passes the check when the disk still holds those bytes, and raises the choice when it does not', async () => {
    const p = page();
    await sentAndFailed(p, 'the person\'s te');
    p.disk[OPEN] = 'the person\'s te';
    assert.strictEqual(await p.api.saveFileGuarded(OPEN, 'the person\'s text'), true);
    assert.strictEqual(p.banner(), null);
    const q = page();
    await sentAndFailed(q, 'the person\'s te');
    q.disk[OPEN] = 'an agent rewrote this note';
    assert.strictEqual(await q.api.saveFileGuarded(OPEN, 'the person\'s text'), false);
    assert.ok(q.banner());
  });

  test('a failed save that was put back keeps the check on: an outside edit before the retry raises the choice', async () => {
    const p = page();
    await sentAndFailed(p, 'old');
    assert.strictEqual(p.api.baseline(OPEN), 'old');
    p.disk[OPEN] = 'an edit made outside';
    assert.strictEqual(await p.api.saveFileGuarded(OPEN, 'the person\'s text'), false);
    assert.ok(p.banner());
  });

  test('an answer that could not say what the file holds drops the baseline, as before', async () => {
    const p = page();
    await sentAndFailed(p, undefined);
    assert.strictEqual(p.api.baseline(OPEN), undefined);
    p.disk[OPEN] = 'old';
    assert.strictEqual(await p.api.saveFileGuarded(OPEN, 'the person\'s text'), true);
  });

  test('a real outside edit, with no failed save behind it, is treated exactly as before', () => {
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

// A view mounted on the note, handed two sources.
async function mounted(p) {
  const asked = p.api.requestSources(NOTE);
  p.api.sourcesReplyArrived({ type: 'sources_resolved', watchId: p.api.watchId(), ok: true, sources: [{ path: A, content: 'old a' }, { path: B, content: 'old b' }] });
  const resolved = await asked;
  p.api.noteSourceBaselines(resolved.sources);
  p.disk[A] = 'old a';
  p.disk[B] = 'old b';
}
const refused = (extra) => ({ type: 'source_save_refused', path: NOTE, source: A, reason: 'Rundock couldn\'t save this file because the drive is full.', detail: 'ENOSPC: no space left on device, write', ...extra });
const changed = (p, a, b) => p.api.sourcesReplyArrived({ type: 'sources_changed', watchId: p.api.watchId(), ok: true, sources: [{ path: A, content: a }, { path: B, content: b }] });
const handed = (p) => plain(p.updates).map((list) => Object.fromEntries(list.map((s) => [s.path, s.content])));

// The view saved A, and the save failed with A left holding `left`.
async function viewSavedA(p, extra) {
  await mounted(p);
  assert.strictEqual(await p.api.saveSourceGuarded(NOTE, A, 'VIEW'), true);
  p.api.sourcesReplyArrived(refused(extra));
}

describe('a named source, after a failed save', () => {
  test('a failed save that was put back takes what the file holds as the baseline, so a retry raises no false choice and the check stays on', async () => {
    const p = page();
    await viewSavedA(p, { left: 'old a' });
    assert.strictEqual(p.api.sourceBaseline(A), 'old a');
    assert.strictEqual(await p.api.saveSourceGuarded(NOTE, A, 'VIEW'), true, 'the retry is sent');
    assert.strictEqual(p.banner(), null);
    const q = page();
    await viewSavedA(q, { left: 'old a' });
    q.disk[A] = 'an edit made outside';
    assert.strictEqual(await q.api.saveSourceGuarded(NOTE, A, 'VIEW'), false, 'an outside edit before the retry still raises the choice');
    assert.ok(q.banner());
  });

  test('while A is held, an outside edit to B still raises the choice, still reaches the view, and no list is held back', async () => {
    const p = page();
    await viewSavedA(p, { left: 'VI', incomplete: true });
    p.disk[B] = 'outside b';
    assert.strictEqual(await p.api.saveSourceGuarded(NOTE, B, 'VIEW-B built on old b'), false);
    assert.ok(p.banner(), 'the choice for B is raised as without a hold');
    changed(p, 'VI', 'outside b');
    changed(p, 'VI', 'outside b, again');
    changed(p, 'VI', 'outside b, a third time');
    assert.deepStrictEqual(handed(p), [
      { [A]: 'VIEW', [B]: 'outside b' },
      { [A]: 'VIEW', [B]: 'outside b, again' },
      { [A]: 'VIEW', [B]: 'outside b, a third time' },
    ], 'every list reaches the view; A carries the person\'s text over the bytes the failed write left');
    assert.strictEqual(p.api.sourceBaseline(A), 'VI', 'the baselines are the real list\'s');
  });

  test('an outside edit to the held source itself goes to the view as it would with no hold, and ends the hold', async () => {
    const p = page();
    await viewSavedA(p, { left: 'VI', incomplete: true });
    changed(p, 'an edit made outside', 'old b');
    changed(p, 'VI', 'old b');
    assert.deepStrictEqual(handed(p), [
      { [A]: 'an edit made outside', [B]: 'old b' },
      { [A]: 'VI', [B]: 'old b' },
    ], 'once the file has moved on, its bytes are handed as they are');
    p.disk[A] = 'another edit made outside';
    assert.strictEqual(await p.api.saveSourceGuarded(NOTE, A, 'VIEW'), false);
    assert.ok(p.banner(), 'and the check sees the next outside edit');
  });

  test('the view\'s next save of the held source passes the check and ends the hold', async () => {
    const p = page();
    await viewSavedA(p, { left: 'VI', incomplete: true });
    p.disk[A] = 'VI';
    assert.strictEqual(await p.api.saveSourceGuarded(NOTE, A, 'VIEW'), true);
    assert.strictEqual(p.banner(), null);
    changed(p, 'VI', 'old b');
    assert.deepStrictEqual(handed(p), [{ [A]: 'VI', [B]: 'old b' }], 'the hold ended with the send');
  });

  test('a mount that ends is the end of its holds', async () => {
    const p = page();
    await viewSavedA(p, { left: 'VI', incomplete: true });
    p.api.endSourcesWatch();
    await mounted(p);
    changed(p, 'VI', 'old b');
    assert.deepStrictEqual(handed(p), [{ [A]: 'VI', [B]: 'old b' }]);
  });

  test('a late refusal for another note changes nothing', async () => {
    const p = page();
    await mounted(p);
    await p.api.saveSourceGuarded(NOTE, A, 'VIEW');
    p.api.sourcesReplyArrived(refused({ path: 'another-note.md', left: 'VI', incomplete: true }));
    assert.strictEqual(p.api.sourceBaseline(A), 'VIEW');
    changed(p, 'VI', 'old b');
    assert.deepStrictEqual(handed(p), [{ [A]: 'VI', [B]: 'old b' }], 'nothing is held for a refusal that is not this mount\'s');
  });

  test('a refusal by a rule, with no system detail, changes nothing', async () => {
    const p = page();
    await mounted(p);
    await p.api.saveSourceGuarded(NOTE, A, 'VIEW');
    p.api.sourcesReplyArrived({ type: 'source_save_refused', path: NOTE, source: A, reason: 'a rule' });
    assert.strictEqual(p.api.sourceBaseline(A), 'VIEW');
  });

  test('a list read again after "Reload theirs" is prepared the same way', async () => {
    const p = page();
    await viewSavedA(p, { left: 'VI', incomplete: true });
    p.api.show(NOTE);
    p.disk[B] = 'outside b';
    assert.strictEqual(await p.api.saveSourceGuarded(NOTE, B, 'VIEW-B'), false);
    p.banner().querySelector('[data-choice="theirs"]').click();
    p.api.sourcesReplyArrived({ type: 'sources_resolved', watchId: p.api.watchId(), ok: true, sources: [{ path: A, content: 'VI' }, { path: B, content: 'outside b' }] });
    await new Promise((r) => setTimeout(r, 0));
    assert.deepStrictEqual(handed(p), [{ [A]: 'VIEW', [B]: 'outside b' }]);
  });

  test('with no failed save, an outside edit to a source raises the choice and every list reaches the view, as before', async () => {
    const p = page();
    await mounted(p);
    p.disk[A] = 'an edit made outside';
    assert.strictEqual(await p.api.saveSourceGuarded(NOTE, A, 'VIEW'), false);
    assert.ok(p.banner());
    changed(p, 'an edit made outside', 'old b');
    assert.deepStrictEqual(handed(p), [{ [A]: 'an edit made outside', [B]: 'old b' }]);
  });
});

describe('what the person is told', () => {
  const failed = (extra) => ({ type: 'file_save_failed', path: OPEN, message: 'Rundock couldn\'t save this file because the drive is full. Free up some space on the drive, then try again.', detail: 'ENOSPC: no space left on device, write', ...extra });
  const said = (p) => p.status().firstChild.nodeValue;

  test('a failed save that could not be put back says so after its own sentence, and its answer becomes the baseline', async () => {
    const p = page({ app: true });
    assert.ok(typeof p.api.note === 'string' && /\.$/.test(p.api.note), 'one sentence');
    await sentAndFailed(p, 'unused');
    p.api.handle(failed({ incomplete: true, left: 'the person\'s te' }));
    assert.strictEqual(said(p), `${failed().message} ${p.api.note}`);
    assert.strictEqual(p.api.baseline(OPEN), 'the person\'s te');
  });

  test('a failed save that was put back says only its own sentence', () => {
    const p = page({ app: true });
    p.api.handle(failed({ left: 'old' }));
    assert.strictEqual(said(p), failed().message);
  });

  test('a source save that could not be put back says so too, and reaches the sources reply', async () => {
    const p = page({ app: true });
    await mounted(p);
    await p.api.saveSourceGuarded(NOTE, A, 'VIEW');
    p.api.handle(refused({ incomplete: true, left: 'VI' }));
    assert.strictEqual(said(p), `${refused().reason} ${p.api.note}`);
    changed(p, 'VI', 'old b');
    assert.deepStrictEqual(handed(p), [{ [A]: 'VIEW', [B]: 'old b' }], 'the arm passed the answer on');
  });
});
