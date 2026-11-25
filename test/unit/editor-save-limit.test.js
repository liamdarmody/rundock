'use strict';
// A save from the editor, or from a view writing a named source, whose frame
// the server would not read. The server closes a connection that sends a
// frame over its limit, so the page measures the exact frame it would send,
// in UTF-8 bytes, and over the limit sends nothing, keeps every baseline and
// the person's unsaved text as they were, and says why on the status line.
//
// The code under test is cut out of public/views/files.js and run in a window
// with a stub socket and a stub disk, so it is the code that ships, and a
// renamed or missing piece fails here by name.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
// The server's limit, loaded so that a tree without it fails on the
// assertion in page(), never on the require.
const receive = (() => {
  try { return require('../../lib/attachments/receive.js'); } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND' && /attachments[\\/]receive/.test(String(e.message))) return null;
    throw e;
  }
})();
const MAX_PAYLOAD = receive ? receive.MAX_PAYLOAD : undefined;

const ROOT = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf-8');
const FILES_SRC = read('public', 'views', 'files.js');

// A stretch of shipped source between two anchors, holding each function it
// is meant to hold.
function between(from, to, label, holds) {
  const start = FILES_SRC.indexOf(from);
  const end = start === -1 ? -1 : FILES_SRC.indexOf(to, start + from.length);
  assert.ok(start !== -1 && end !== -1, `the client no longer carries ${label}`);
  const piece = FILES_SRC.slice(start, end);
  for (const name of holds) assert.ok(piece.includes(`function ${name}(`), `${label} no longer holds ${name}`);
  return piece;
}

const GUARD = () => between('// ---- External-edit guard ----', 'function destroyTiptapEditorIfActive()', 'the external-edit guard',
  ['saveFileGuarded', 'hideExternalEditConflict', 'showExternalEditConflict']);
const SOURCES_STATE = () => between('let sourcesWatchId = null;', '// VIEW STATE, the page', 'the named-sources state', ['requestSources']);
const SOURCES = () => between('function noteSourceBaselines(list) {', '// WHAT THE SERVER SAID ABOUT HANDING', 'the named-sources replies and save',
  ['noteSourceBaselines', 'saveSourceGuarded']);

const OPEN = 'notes/a.md';
const NOTE = 'dash.md';
const SOURCE = 'notes/a.csv';
const SAID = 'Not saved: this file is too large to save from the editor (the limit is 28 MB)';

// A window holding the cut pieces, the open file loaded as `old` and the
// source's baseline `old a`, with the frames the page sent kept as sent.
function page() {
  assert.strictEqual(typeof MAX_PAYLOAD, 'number', 'the server declares the largest frame it reads');
  const dom = new JSDOM('<!doctype html><html><body><div id="editor-header"></div><div id="editor-status"></div></body></html>', { runScripts: 'dangerously' });
  const w = dom.window;
  w.eval(read('public', 'external-refresh-model.js'));
  w.__disk = { [OPEN]: 'old', [SOURCE]: 'old a' };
  w.__sent = [];
  w.eval(`window.__api = (function () {
    let currentFilePath = ${JSON.stringify(OPEN)}; let editorDirty = false; let rawFileContent = 'old';
    let activeFileViewer = null; let activeTiptapEditor = null; let _tiptapEditorModuleResolved = null; let editorMode = 'edit';
    let activeExtensionMount = { updateSources: () => {} };
    let activeExtensionMountInfo = { extension: 'dash', path: ${JSON.stringify(NOTE)} };
    const ws = { readyState: 1, send: (m) => window.__sent.push(m) };
    const WebSocket = { OPEN: 1 };
    const fetch = async (url) => {
      const p = decodeURIComponent(String(url).split('path=')[1]);
      return p in window.__disk ? { ok: true, text: async () => window.__disk[p] } : { ok: false };
    };
    const esc = (s) => String(s);
    ${GUARD()}
    ${SOURCES_STATE()}
    ${SOURCES()}
    diskBaselines.set(${JSON.stringify(OPEN)}, 'old');
    noteSourceBaselines([{ path: ${JSON.stringify(SOURCE)}, content: 'old a' }]);
    return {
      saveFileGuarded, saveSourceGuarded,
      baseline: (p) => diskBaselines.get(p),
      sourceBaseline: (p) => sourceBaselines.get(p),
      editor: () => ({ text: rawFileContent, dirty: editorDirty }),
      type: (text) => { rawFileContent = text; editorDirty = true; },
    };
  })();`);
  const status = () => w.document.getElementById('editor-status');
  return { w, api: w.__api, status, sent: w.__sent };
}

const bytes = (s) => Buffer.byteLength(s, 'utf8');
const FILE_FRAME = (content, origin) => JSON.stringify(origin
  ? { type: 'save_file', path: OPEN, content, origin }
  : { type: 'save_file', path: OPEN, content });
const SOURCE_FRAME = (content) => JSON.stringify({ type: 'save_source', path: NOTE, source: SOURCE, content });

// Content of plain letters whose frame is exactly `size` bytes.
function sized(frameOf, size) {
  const content = 'a'.repeat(size - bytes(frameOf('')));
  assert.strictEqual(bytes(frameOf(content)), size);
  return content;
}

// Content of two-byte characters whose frame is over the limit in bytes but
// under it in characters.
function wide(frameOf) {
  const content = 'é'.repeat(MAX_PAYLOAD / 2);
  const frame = frameOf(content);
  assert.ok(bytes(frame) > MAX_PAYLOAD && frame.length < MAX_PAYLOAD);
  return content;
}

// Nothing sent, nothing taken as saved, and the reason on the status line.
function refusedAsItWas(p, { text, dirty, baseline, sourceBaseline }) {
  assert.strictEqual(p.sent.length, 0, 'nothing is sent');
  const editor = p.api.editor();
  assert.ok(editor.text === text && editor.dirty === dirty, 'the person\'s text and its unsaved state are as they were');
  assert.strictEqual(p.api.baseline(OPEN), baseline, 'the file\'s baseline is as it was');
  assert.strictEqual(p.api.sourceBaseline(SOURCE), sourceBaseline, 'the source\'s baseline is as it was');
  assert.strictEqual(p.status().textContent, SAID);
  assert.strictEqual(p.status().style.color, 'var(--attention)');
}

describe('the editor\'s save, against the largest frame the server reads', () => {
  test('a frame of exactly the limit is sent', async () => {
    const p = page();
    const content = sized(FILE_FRAME, MAX_PAYLOAD);
    p.api.type(content);
    assert.strictEqual(await p.api.saveFileGuarded(OPEN, content), true);
    assert.strictEqual(p.sent.length, 1);
    assert.strictEqual(bytes(p.sent[0]), MAX_PAYLOAD);
  });

  test('a frame one byte over is not sent, and nothing is taken as saved', async () => {
    const p = page();
    const content = sized(FILE_FRAME, MAX_PAYLOAD + 1);
    p.api.type(content);
    assert.strictEqual(await p.api.saveFileGuarded(OPEN, content), false);
    refusedAsItWas(p, { text: content, dirty: true, baseline: 'old', sourceBaseline: 'old a' });
  });

  test('a frame over the limit in UTF-8 bytes but under it in characters is not sent', async () => {
    const p = page();
    const content = wide(FILE_FRAME);
    p.api.type(content);
    assert.strictEqual(await p.api.saveFileGuarded(OPEN, content), false);
    refusedAsItWas(p, { text: content, dirty: true, baseline: 'old', sourceBaseline: 'old a' });
  });

  test('the frame measured is the one that would be sent, with an extension\'s origin in it', async () => {
    const fits = page();
    const exact = sized((c) => FILE_FRAME(c, 'extension'), MAX_PAYLOAD);
    assert.strictEqual(await fits.api.saveFileGuarded(OPEN, exact, { origin: 'extension' }), true);
    assert.strictEqual(bytes(fits.sent[0]), MAX_PAYLOAD);
    const over = page();
    const plainFits = sized(FILE_FRAME, MAX_PAYLOAD);
    assert.strictEqual(await over.api.saveFileGuarded(OPEN, plainFits, { origin: 'extension' }), false,
      'content that fits without the origin is over the limit with it');
    refusedAsItWas(over, { text: 'old', dirty: false, baseline: 'old', sourceBaseline: 'old a' });
  });
});

describe('a view\'s save of a named source, against the largest frame the server reads', () => {
  test('a frame of exactly the limit is sent', async () => {
    const p = page();
    const content = sized(SOURCE_FRAME, MAX_PAYLOAD);
    assert.strictEqual(await p.api.saveSourceGuarded(NOTE, SOURCE, content), true);
    assert.strictEqual(p.sent.length, 1);
    assert.strictEqual(bytes(p.sent[0]), MAX_PAYLOAD);
  });

  test('a frame one byte over is not sent, and nothing is taken as saved', async () => {
    const p = page();
    p.api.type('the person\'s text');
    const content = sized(SOURCE_FRAME, MAX_PAYLOAD + 1);
    assert.strictEqual(await p.api.saveSourceGuarded(NOTE, SOURCE, content), false);
    refusedAsItWas(p, { text: 'the person\'s text', dirty: true, baseline: 'old', sourceBaseline: 'old a' });
  });

  test('a frame over the limit in UTF-8 bytes but under it in characters is not sent', async () => {
    const p = page();
    const content = wide(SOURCE_FRAME);
    assert.strictEqual(await p.api.saveSourceGuarded(NOTE, SOURCE, content), false);
    refusedAsItWas(p, { text: 'old', dirty: false, baseline: 'old', sourceBaseline: 'old a' });
  });
});
