'use strict';
// A deleted conversation whose attached files the server couldn't remove:
// the page shows the server's sentence as a row in a strip above the view,
// where it stays, whatever the person opens next, until its own close.
//
// The arm is cut out of handle(d) in public/app.js and run in a window built
// from index.html's <main> markup, with showFilesKeptNotice from the
// conversations view and the addSystemMsgToConvo and addSystemMsg the arm
// used to call, so it is the code that ships, and a missing piece fails here
// by name.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const PUBLIC = path.join(ROOT, 'public');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf-8');
const APP_SRC = read('public', 'app.js');
const CHAT_SRC = read('public', 'views', 'chat.js');
const CONVOS_SRC = read('public', 'views', 'conversations.js');
const INDEX_HTML = read('public', 'index.html');
const HANDLER_SRC = read('lib', 'protocol', 'handlers', 'conversations.js');

const STRIP = 'files-kept-notices';

// The source from `from` up to and including the first `to` after it.
function piece(src, from, to, label) {
  const start = src.indexOf(from);
  const end = start === -1 ? -1 : src.indexOf(to, start + from.length);
  assert.ok(start !== -1 && end !== -1, `the page does not carry ${label}`);
  return src.slice(start, end + to.length);
}

const ARM = () => piece(APP_SRC, "case 'conversation_files_kept':", 'break;', 'the conversation_files_kept arm');
const TO_CONVO = () => piece(APP_SRC, 'function addSystemMsgToConvo(', '\n}\n', 'addSystemMsgToConvo');
const NOTICE = () => piece(CONVOS_SRC, 'function showFilesKeptNotice(', '\n}\n', 'showFilesKeptNotice');
const SYSTEM = () => piece(CHAT_SRC, 'function addSystemMsg(', '\n', 'addSystemMsg');
const MAIN = () => piece(INDEX_HTML, '<main class="main">', '</main>', 'the main markup');

// The sentence the server sends for a conversation, from its own template.
function serverText(id) {
  const template = piece(HANDLER_SRC, 'text: `Rundock deleted', '`', 'the files-kept text').slice('text: '.length);
  return new Function('msg', `return ${template};`)({ id });
}
const textFor = (id) => `Rundock deleted the conversation but couldn't remove its attached files. They're still in .rundock/attachments/${id}/.`;
const ALPHA = textFor('conv-alpha');
const BETA = textFor('conv-beta');

// The things the change needs, asserted before anything is built from them.
function requirePieces() {
  assert.ok(INDEX_HTML.includes(`id="${STRIP}"`), `index.html holds #${STRIP}`);
  const view = require(path.join(PUBLIC, 'views', 'conversations.js'));
  assert.strictEqual(typeof view.showFilesKeptNotice, 'function', 'showFilesKeptNotice is a page function');
}

// A window with index.html's <main>, the arm and the functions it may call,
// another conversation on screen with its messages loaded, and a socket that
// records what is sent.
function page() {
  requirePieces();
  const dom = new JSDOM(`<!doctype html><html><body>${MAIN()}</body></html>`, { runScripts: 'dangerously' });
  const w = dom.window;
  w.eval(`window.__api = (function () {
    const conversations = [{ id: 'conv-gamma', messages: [{ role: 'user', content: 'hello' }] }];
    let activeConversation = conversations[0];
    const scrollBottom = () => {};
    const ws = { readyState: 1, sent: [], send(data) { this.sent.push(data); } };
    ${SYSTEM()}
    ${TO_CONVO()}
    ${NOTICE()}
    function handle(d) { switch (d.type) { ${ARM()} } }
    return { handle, sent: () => JSON.stringify(ws.sent), conversations: () => JSON.parse(JSON.stringify(conversations)) };
  })();`);
  const doc = w.document;
  const box = () => doc.getElementById(STRIP);
  const rows = () => [...box().children];
  const texts = () => rows().map((row) => row.querySelector('.held-strip-text').textContent);
  const notify = (id, text = textFor(id)) => w.__api.handle({ type: 'conversation_files_kept', id, text });
  const messages = () => doc.getElementById('messages');
  return { w, doc, api: w.__api, box, rows, texts, notify, messages };
}

describe('the notice that a deleted conversation\'s files were kept', () => {
  test('the arm hands the server\'s text to showFilesKeptNotice and draws no line in the conversation', () => {
    requirePieces();
    const arm = ARM();
    assert.ok(arm.includes('showFilesKeptNotice(d.text)'), 'the arm calls showFilesKeptNotice(d.text)');
    assert.ok(!arm.includes('addSystemMsgToConvo'), 'and no longer calls addSystemMsgToConvo');
  });

  test('the strip sits in main directly after the held-routines strip, outside the chat view and every view panel', () => {
    requirePieces();
    const doc = new JSDOM(INDEX_HTML).window.document;
    const el = doc.getElementById(STRIP);
    assert.ok(el, `index.html holds #${STRIP}`);
    assert.strictEqual(el.tagName, 'DIV');
    assert.strictEqual(el.getAttribute('role'), 'status');
    assert.strictEqual(el.hidden, true, 'hidden until a notice comes');
    assert.strictEqual(el.children.length, 0, 'and empty');
    assert.ok(el.parentElement.matches('main.main'), 'a child of main.main');
    assert.strictEqual(el.previousElementSibling && el.previousElementSibling.id, 'held-strip', 'directly after #held-strip');
    assert.strictEqual(el.closest('#view-chat'), null, 'outside #view-chat');
    assert.strictEqual(el.closest('.view-panel'), null, 'outside every .view-panel');
  });

  test('a notice is one row built from elements: the text, then one close button', () => {
    const p = page();
    p.notify('conv-alpha');
    assert.strictEqual(p.box().hidden, false, 'the strip is shown');
    assert.strictEqual(p.rows().length, 1, 'one row');
    const row = p.rows()[0];
    assert.strictEqual(row.tagName, 'DIV');
    assert.strictEqual(row.className, 'held-strip');
    const [span, close, ...rest] = row.children;
    assert.deepStrictEqual(rest, [], 'the row holds the text and the close button only');
    assert.strictEqual(span.tagName, 'SPAN');
    assert.strictEqual(span.className, 'held-strip-text');
    assert.strictEqual(span.textContent, ALPHA);
    assert.strictEqual(close.tagName, 'BUTTON');
    assert.strictEqual(close.className, 'held-strip-close');
    assert.strictEqual(close.getAttribute('type'), 'button');
    assert.strictEqual(close.textContent, '\u00d7');
    assert.strictEqual(close.getAttribute('aria-label'), 'Close');
    assert.strictEqual(row.querySelectorAll('button').length, 1, 'no other button');
  });

  test('the row says exactly where the files are', () => {
    const p = page();
    const expected = 'Rundock deleted the conversation but couldn\'t remove its attached files. They\'re still in .rundock/attachments/1764000000000/.';
    assert.strictEqual(serverText('1764000000000'), expected, 'the server\'s sentence');
    p.notify('1764000000000', serverText('1764000000000'));
    assert.deepStrictEqual(p.texts(), [expected]);
  });

  test('nothing is drawn in the conversation on screen or kept in any conversation\'s messages', () => {
    const p = page();
    const before = p.api.conversations();
    p.messages().append(Object.assign(p.doc.createElement('div'), { className: 'msg-user', textContent: 'hello' }));
    p.notify('conv-alpha');
    assert.deepStrictEqual([...p.messages().children].map((el) => el.className), ['msg-user'], 'no line in #messages');
    assert.deepStrictEqual(p.api.conversations(), before, 'no conversation gains an entry');
  });

  test('a text with markup reaches the page as text', () => {
    const p = page();
    p.notify('conv-alpha', '<img src=x onerror=alert(1)>');
    assert.strictEqual(p.doc.querySelectorAll('img').length, 0, 'no img element');
    assert.deepStrictEqual(p.texts(), ['<img src=x onerror=alert(1)>']);
  });
});

describe('the files-kept notice stays until it is closed', () => {
  // The row is there with its text, and the strip is shown.
  function stillShown(p) {
    assert.strictEqual(p.box().hidden, false, 'the strip is still shown');
    assert.deepStrictEqual(p.texts(), [ALPHA], 'the row is still there with its text');
  }

  test('opening another conversation, which empties the message view, leaves the row', () => {
    const p = page();
    p.notify('conv-alpha');
    const open = piece(CONVOS_SRC, 'function openConversation(', '\n}\n', 'openConversation');
    const empty = "const el=document.getElementById('messages'); el.innerHTML='';";
    assert.ok(open.includes(empty), 'openConversation empties #messages this way');
    p.w.eval(`(function () { ${empty} })();`);
    assert.strictEqual(p.messages().children.length, 0, 'the message view is empty');
    stillShown(p);
  });

  test('starting a new conversation, which empties the message view, leaves the row', () => {
    const p = page();
    p.notify('conv-alpha');
    const create = piece(CONVOS_SRC, 'function createConversation(', '\n}\n', 'createConversation');
    const empty = "document.getElementById('messages').innerHTML = '';";
    assert.ok(create.includes(empty), 'createConversation empties #messages this way');
    p.w.eval(`(function () { ${empty} })();`);
    assert.strictEqual(p.messages().children.length, 0, 'the message view is empty');
    stillShown(p);
  });

  test('a history drawn at the top of the message view leaves the row', () => {
    const p = page();
    p.notify('conv-alpha');
    const render = piece(CHAT_SRC, 'function renderSessionHistory(', '\n}\n', 'renderSessionHistory');
    const insert = 'el.insertBefore(frag, el.firstChild);';
    assert.ok(render.includes(insert), 'renderSessionHistory draws its history this way');
    p.w.eval(`(function () {
      const el = document.getElementById('messages');
      const frag = document.createDocumentFragment();
      const old = document.createElement('div'); old.className = 'msg-user'; old.textContent = 'earlier';
      frag.appendChild(old);
      ${insert}
    })();`);
    assert.strictEqual(p.messages().firstElementChild.textContent, 'earlier', 'the history is drawn');
    stillShown(p);
  });

  test('only index.html, showFilesKeptNotice and its close handler name the strip in the page', () => {
    requirePieces();
    const named = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const at = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(at);
        else if (fs.readFileSync(at).includes(STRIP)) named.push(path.relative(PUBLIC, at).split(path.sep).join('/'));
      }
    };
    walk(PUBLIC);
    assert.deepStrictEqual(named.sort(), ['index.html', 'views/conversations.js'], 'named only in index.html and the conversations view');
    const count = (src, what) => src.split(what).length - 1;
    assert.strictEqual(count(INDEX_HTML, STRIP), 1, 'index.html names it once, as the element');
    const notice = NOTICE();
    assert.strictEqual(count(CONVOS_SRC, STRIP), count(notice, STRIP), 'the conversations view names it only inside showFilesKeptNotice, close handler included');
    const doc = new JSDOM(INDEX_HTML).window.document;
    const el = doc.getElementById(STRIP);
    assert.ok(el && el.parentElement.matches('main.main'), 'in index.html it is a child of main.main');
    assert.strictEqual(el.closest('#view-chat'), null, 'and not inside #view-chat');
  });
});

describe('each files-kept notice closes on its own', () => {
  const closeOf = (row) => row.querySelector('.held-strip-close');

  test('a second notice adds a second row after the first, and both show', () => {
    const p = page();
    p.notify('conv-alpha');
    p.notify('conv-beta');
    assert.deepStrictEqual(p.texts(), [ALPHA, BETA]);
    assert.strictEqual(p.box().hidden, false);
  });

  test('a close removes its own row only, and the other stays with its text', () => {
    const p = page();
    p.notify('conv-alpha');
    p.notify('conv-beta');
    closeOf(p.rows()[0]).click();
    assert.deepStrictEqual(p.texts(), [BETA]);
    assert.strictEqual(p.box().hidden, false, 'the strip stays shown');
  });

  test('when the last row is closed the strip is hidden', () => {
    const p = page();
    p.notify('conv-alpha');
    p.notify('conv-beta');
    closeOf(p.rows()[1]).click();
    assert.strictEqual(p.box().hidden, false, 'one row left, still shown');
    closeOf(p.rows()[0]).click();
    assert.strictEqual(p.rows().length, 0);
    assert.strictEqual(p.box().hidden, true);
  });

  test('a close sends nothing to the server', () => {
    const p = page();
    p.notify('conv-alpha');
    closeOf(p.rows()[0]).click();
    assert.strictEqual(p.api.sent(), '[]', 'nothing sent');
  });
});
