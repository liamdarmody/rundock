'use strict';
// What the page does with this change: the line it draws when a deleted
// conversation's attached files couldn't be removed, and the editor's saves,
// which stop before a frame the server would refuse to read.
//
// The code under test is cut out of public/app.js and public/views/files.js
// and run in a window, so it is the code that ships, and a renamed or missing
// piece fails here by name.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf-8');
const APP_SRC = read('public', 'app.js');

// One function, or one line, by its opening; refuses when it is missing.
function cutFrom(src, pattern, label) {
  const found = src.match(pattern);
  assert.ok(found, `the client no longer carries ${label}`);
  return found[0];
}

const KEPT = 'Rundock deleted the conversation but couldn\'t remove its attached files. They\'re still in .rundock/attachments/alpha/.';

describe('conversation_files_kept', () => {
  // handle(d) holding only the new arm, with the line drawer it calls cut
  // from source and the chat view's addSystemMsg recorded.
  function page(activeConversation) {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'dangerously' });
    const w = dom.window;
    w.__drawn = [];
    w.eval(`window.__api = (function () {
      const conversations = [{ id: 'alpha', messages: [{ role: 'user', content: 'hello' }] }];
      const activeConversation = ${JSON.stringify(activeConversation)};
      const addSystemMsg = (text) => window.__drawn.push(text);
      ${cutFrom(APP_SRC, /function addSystemMsgToConvo\(text, convoId, isError = true, keep = false\) \{[\s\S]*?\n\}/, 'addSystemMsgToConvo')}
      function handle(d) { switch (d.type) { ${cutFrom(APP_SRC, /case 'conversation_files_kept':[^\n]*/, 'the conversation_files_kept arm')} } }
      return { handle, messages: () => JSON.stringify(conversations) };
    })();`);
    return w;
  }

  for (const [label, active] of [['with no conversation open', null], ['with another conversation open', { id: 'beta' }], ['with that conversation open', { id: 'alpha' }]]) {
    test(`draws the text as a system line that isn't an error, ${label}`, () => {
      const w = page(active);
      const before = w.__api.messages();
      w.__api.handle({ type: 'conversation_files_kept', id: 'alpha', text: KEPT });
      assert.deepStrictEqual(Array.from(w.__drawn), [KEPT]);
      assert.strictEqual(w.__api.messages(), before, 'no conversation\'s messages change');
    });
  }
});

// The receive module, or null only while it is missing.
function optional(file) {
  try {
    return require(file);
  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND' && String(e.message).includes(path.basename(file))) return null;
    throw e;
  }
}
const receive = optional('../../lib/attachments/receive.js');

describe('the editor\'s saves stop at the server\'s frame limit', () => {
  const FILES_SRC = read('public', 'views', 'files.js');
  const LIMIT = 28000000;
  const TOO_LARGE = 'Not saved: this file is too large to save from the editor (the limit is 28 MB)';

  // A stretch of shipped source between two anchors, refusing to come back
  // missing or without each function it is meant to hold.
  function between(from, to, label, holds) {
    const start = FILES_SRC.indexOf(from);
    const end = start === -1 ? -1 : FILES_SRC.indexOf(to, start + from.length);
    assert.ok(start !== -1 && end !== -1, `the client no longer carries ${label}`);
    const piece = FILES_SRC.slice(start, end);
    for (const name of holds) assert.ok(piece.includes(`function ${name}(`), `${label} no longer holds ${name}`);
    return piece;
  }

  // The guard and the named-sources save, cut from source and run together in
  // a window with a socket that records each frame as sent.
  function page() {
    const guard = between('// ---- External-edit guard ----', 'function destroyTiptapEditorIfActive()', 'the external-edit guard',
      ['saveFrameTooLarge', 'saveFileGuarded', 'hideExternalEditConflict', 'showExternalEditConflict']);
    const sourcesState = between('let sourcesWatchId = null;', '// VIEW STATE, the page', 'the named-sources state', ['requestSources']);
    const sources = between('function noteSourceBaselines(list) {', '// WHAT THE SERVER SAID ABOUT HANDING', 'the named-sources save', ['saveSourceGuarded']);
    const dom = new JSDOM('<!doctype html><html><body><div id="editor-header"></div><div id="editor-status">Unsaved</div></body></html>', { runScripts: 'dangerously' });
    const w = dom.window;
    w.__sent = [];
    w.eval(`window.__api = (function () {
      let currentFilePath = 'notes/a.md'; let editorDirty = true; let rawFileContent = 'old';
      let activeFileViewer = null; let activeTiptapEditor = null; let _tiptapEditorModuleResolved = null; let editorMode = 'edit';
      let activeExtensionMount = null; let activeExtensionMountInfo = { extension: 'dash', path: 'dash.md' };
      const ws = { readyState: 1, send: (m) => window.__sent.push(m) };
      const WebSocket = { OPEN: 1 };
      const fetch = async () => ({ ok: false });
      const esc = (s) => String(s);
      ${guard}
      ${sourcesState}
      ${sources}
      diskBaselines.set('notes/a.md', 'old');
      sourceBaselines.set('notes/a.csv', 'old');
      return {
        saveFileGuarded, saveSourceGuarded, limit: SAVE_FRAME_LIMIT,
        state: () => ({ disk: diskBaselines.get('notes/a.md'), source: sourceBaselines.get('notes/a.csv'), raw: rawFileContent, dirty: editorDirty }),
      };
    })();`);
    const status = w.document.getElementById('editor-status');
    return { w, api: w.__api, sent: w.__sent, status };
  }

  // Content whose frame from `frameOf` is `bytes` long, in `unit` characters.
  function sized(frameOf, bytes, unit = 'a') {
    const room = bytes - Buffer.byteLength(frameOf(''));
    const each = Buffer.byteLength(unit);
    assert.strictEqual(room % each, 0);
    return unit.repeat(room / each);
  }

  const saves = [
    ['saveFileGuarded', (p, content) => p.api.saveFileGuarded('notes/a.md', content),
      (content) => JSON.stringify({ type: 'save_file', path: 'notes/a.md', content })],
    ['saveFileGuarded, for an extension', (p, content) => p.api.saveFileGuarded('notes/a.md', content, { origin: 'extension' }),
      (content) => JSON.stringify({ type: 'save_file', path: 'notes/a.md', content, origin: 'extension' })],
    ['saveSourceGuarded', (p, content) => p.api.saveSourceGuarded('dash.md', 'notes/a.csv', content),
      (content) => JSON.stringify({ type: 'save_source', path: 'dash.md', source: 'notes/a.csv', content })],
  ];

  async function refused(save, content) {
    const p = page();
    const before = p.api.state();
    assert.strictEqual(await save(p, content), false, 'the save answers false');
    assert.strictEqual(p.sent.length, 0, 'nothing is sent');
    assert.deepStrictEqual(p.api.state(), before, 'the baselines, the text and its unsaved state are as they were');
    assert.strictEqual(p.status.textContent, TOO_LARGE);
    assert.strictEqual(p.status.style.color, 'var(--attention)');
  }

  for (const [label, save, frameOf] of saves) {
    test(`${label}: a frame of exactly 28,000,000 bytes is sent`, async () => {
      const p = page();
      assert.strictEqual(await save(p, sized(frameOf, LIMIT)), true);
      assert.deepStrictEqual(p.sent.map((m) => Buffer.byteLength(m)), [LIMIT]);
    });

    test(`${label}: a frame of 28,000,001 bytes is not sent, and the status line says why`, async () => {
      await refused(save, sized(frameOf, LIMIT + 1));
    });

    test(`${label}: multibyte content over the limit in bytes, though under it in characters, is not sent`, async () => {
      const over = (LIMIT + 1 - Buffer.byteLength(frameOf(''))) % 2 === 0 ? LIMIT + 1 : LIMIT + 2;
      const content = sized(frameOf, over, 'é');
      assert.ok(frameOf(content).length < LIMIT);
      await refused(save, content);
    });
  }

  test('a save for an extension counts the frame it sends, origin and all', async () => {
    const content = sized(saves[0][2], LIMIT);
    await refused(saves[1][1], content);
  });

  test('the page\'s limit is the server\'s MAX_PAYLOAD', () => {
    assert.ok(receive, 'lib/attachments/receive.js is missing');
    assert.strictEqual(page().api.limit, receive.MAX_PAYLOAD);
  });
});
