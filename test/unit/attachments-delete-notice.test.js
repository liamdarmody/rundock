'use strict';
// A deleted conversation whose attached files the server couldn't remove:
// the page draws the server's sentence as a system line, never an error,
// wherever the person is.
//
// The arm is cut out of handle(d) in public/app.js and run in a window with
// the shipped addSystemMsgToConvo and addSystemMsg, so it is the code that
// ships, and a missing piece fails here by name.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf-8');
const APP_SRC = read('public', 'app.js');
const CHAT_SRC = read('public', 'views', 'chat.js');

// The source from `from` up to and including the first `to` after it.
function piece(src, from, to, label) {
  const start = src.indexOf(from);
  const end = start === -1 ? -1 : src.indexOf(to, start + from.length);
  assert.ok(start !== -1 && end !== -1, `the page no longer carries ${label}`);
  return src.slice(start, end + to.length);
}

const ARM = () => piece(APP_SRC, "case 'conversation_files_kept':", 'break;', 'the conversation_files_kept arm');
const TO_CONVO = () => piece(APP_SRC, 'function addSystemMsgToConvo(', '\n}\n', 'addSystemMsgToConvo');
const SYSTEM = () => piece(CHAT_SRC, 'function addSystemMsg(', '\n', 'addSystemMsg');

const ID = 'conv-alpha';
const TEXT = `Rundock deleted the conversation but couldn't remove its attached files. They're still in .rundock/attachments/${ID}/.`;

// A window with the arm and the two functions it calls, another conversation
// on screen, and that conversation's messages loaded.
function page() {
  const dom = new JSDOM('<!doctype html><html><body><div id="messages"></div></body></html>', { runScripts: 'dangerously' });
  const w = dom.window;
  w.eval(`window.__api = (function () {
    const conversations = [{ id: 'conv-beta', messages: [{ role: 'user', content: 'hello' }] }];
    let activeConversation = conversations[0];
    const scrollBottom = () => {};
    ${SYSTEM()}
    ${TO_CONVO()}
    function handle(d) { switch (d.type) { ${ARM()} } }
    return { handle, conversations: () => JSON.parse(JSON.stringify(conversations)) };
  })();`);
  const lines = () => [...w.document.querySelectorAll('#messages > *')].map((el) => [el.className, el.textContent]);
  return { w, api: w.__api, lines };
}

describe('the notice that a deleted conversation\'s files were kept', () => {
  test('is drawn as a system line with the server\'s text, not as an error', () => {
    const p = page();
    p.api.handle({ type: 'conversation_files_kept', id: ID, text: TEXT });
    assert.deepStrictEqual(p.lines(), [['msg-system', TEXT]]);
  });

  test('is drawn in the conversation on screen, and kept in no conversation\'s messages', () => {
    const p = page();
    const before = p.api.conversations();
    p.api.handle({ type: 'conversation_files_kept', id: ID, text: TEXT });
    assert.strictEqual(p.lines().length, 1, 'drawn where the person is');
    assert.deepStrictEqual(p.api.conversations(), before, 'no conversation gains the line');
  });

  test('reaches the page as text', () => {
    const p = page();
    p.api.handle({ type: 'conversation_files_kept', id: ID, text: '<img src=x onerror=alert(1)>' });
    assert.strictEqual(p.w.document.querySelectorAll('img').length, 0);
    assert.deepStrictEqual(p.lines(), [['msg-system', '<img src=x onerror=alert(1)>']]);
  });
});
