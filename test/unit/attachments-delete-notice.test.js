'use strict';
// A deleted conversation whose attached files the server couldn't remove:
// the page shows the server's sentence as a row in a strip above the view,
// where it stays, whatever the person opens next, until its own close.
//
// THE PAGE HERE IS THE PAGE THAT SHIPS. It is built from public/index.html,
// and every script index.html names is run in it, in order, as classic
// scripts sharing one window, as a browser runs them. Each frame arrives on
// the page's own socket, so it reaches the page's own handle(d) and, through
// it, whatever the page holds as showFilesKeptNotice: a notice function that
// draws nothing fails here. Only what the page reaches outside itself is
// stood in for: the WebSocket constructor (a socket that records what is sent
// and never touches the network), fetch (which never answers), and
// matchMedia, which jsdom does not have.
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
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
const NOTICE = () => piece(CONVOS_SRC, 'function showFilesKeptNotice(', '\n}\n', 'showFilesKeptNotice');

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

// Where the server reads each script the page names: under public/, except
// the one it serves out of the markdown package (lib/http-router.js).
const FROM_PACKAGE = { '/marked.min.js': path.join(ROOT, 'node_modules', 'marked', 'lib', 'marked.umd.js') };
const scriptFile = (src) => FROM_PACKAGE[src] || path.join(PUBLIC, ...src.split('/').filter(Boolean));

// Every script index.html names, in its order, compiled once and run in each
// page.
let scripts = null;
function pageScripts() {
  if (scripts) return scripts;
  const srcs = [...new JSDOM(INDEX_HTML).window.document.querySelectorAll('script[src]')].map((el) => el.getAttribute('src'));
  assert.ok(srcs.includes('/views/conversations.js') && srcs.includes('/app.js'), 'index.html loads the conversations view and app.js');
  assert.ok(srcs.indexOf('/views/conversations.js') < srcs.indexOf('/app.js'), 'the conversations view before app.js');
  scripts = srcs.map((src) => {
    const file = scriptFile(src);
    return new vm.Script(fs.readFileSync(file, 'utf-8'), { filename: file });
  });
  return scripts;
}

// Each page's window is closed after its test: the page sets timers and an
// interval as it loads.
const opened = [];
afterEach(() => { for (const w of opened.splice(0)) w.close(); });

// The shipped page, loaded and connected, with a conversation on screen whose
// messages are loaded. `notify` sends a conversation_files_kept frame on the
// page's socket; `sent` is what the page has sent since it connected.
async function page() {
  requirePieces();
  const sockets = [];
  const dom = new JSDOM(INDEX_HTML, {
    url: 'http://localhost/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(w) {
      w.WebSocket = class {
        constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
        send(data) { this.sent.push(String(data)); }
        close() {}
      };
      Object.assign(w.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
      w.fetch = () => new Promise(() => {});
      w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
    },
  });
  const w = dom.window;
  opened.push(w);
  const ctx = dom.getInternalVMContext();
  for (const script of pageScripts()) script.runInContext(ctx);
  // The page connects once its sign-in check settles, a few ticks after it
  // loads.
  for (let i = 0; i < 50 && !sockets.length; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(sockets.length, 1, 'the page opens its socket');
  const socket = sockets[0];
  socket.readyState = 1;
  socket.onopen();
  const since = socket.sent.length;
  const state = (expr) => vm.runInContext(expr, ctx);
  state("conversations.push({ id: 'conv-gamma', messages: [{ role: 'user', content: 'hello' }] }); activeConversation = conversations[0];");
  const doc = w.document;
  const box = () => doc.getElementById(STRIP);
  const rows = () => [...box().children];
  const texts = () => rows().map((row) => row.querySelector('.held-strip-text').textContent);
  const notify = (id, text = textFor(id)) => socket.onmessage({ data: JSON.stringify({ type: 'conversation_files_kept', id, text }) });
  const messages = () => doc.getElementById('messages');
  const conversations = () => JSON.parse(state('JSON.stringify(conversations)'));
  const sent = () => socket.sent.slice(since);
  return { w, doc, box, rows, texts, notify, messages, conversations, sent, state };
}

describe('the notice that a deleted conversation\'s files were kept', () => {
  test('a conversation_files_kept frame on the page\'s socket reaches the page\'s own showFilesKeptNotice, which adds one row with the server\'s text to #files-kept-notices', async () => {
    const p = await page();
    const text = serverText('conv-alpha');
    const before = p.messages().innerHTML;
    assert.strictEqual(p.box().hidden, true, 'the strip is hidden before the frame');
    p.notify('conv-alpha', text);
    assert.strictEqual(p.rows().length, 1, `one row in #${STRIP}`);
    assert.deepStrictEqual(p.texts(), [text], 'with the server\'s text');
    assert.strictEqual(p.box().hidden, false, 'and the strip is shown');
    assert.strictEqual(p.messages().innerHTML, before, 'nothing is added to #messages');
  });

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

  test('a notice is one row built from elements: the text, then one close button', async () => {
    const p = await page();
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

  test('the row says exactly where the files are', async () => {
    const p = await page();
    const expected = 'Rundock deleted the conversation but couldn\'t remove its attached files. They\'re still in .rundock/attachments/1764000000000/.';
    assert.strictEqual(serverText('1764000000000'), expected, 'the server\'s sentence');
    p.notify('1764000000000', serverText('1764000000000'));
    assert.deepStrictEqual(p.texts(), [expected]);
  });

  test('nothing is drawn in the conversation on screen or kept in any conversation\'s messages', async () => {
    const p = await page();
    const before = p.conversations();
    p.messages().append(Object.assign(p.doc.createElement('div'), { className: 'msg-user', textContent: 'hello' }));
    p.notify('conv-alpha');
    assert.deepStrictEqual([...p.messages().children].map((el) => el.className), ['msg-user'], 'no line in #messages');
    assert.deepStrictEqual(p.conversations(), before, 'no conversation gains an entry');
  });

  test('a text with markup reaches the page as text', async () => {
    const p = await page();
    const images = p.doc.querySelectorAll('img').length;
    p.notify('conv-alpha', '<img src=x onerror=alert(1)>');
    assert.strictEqual(p.doc.querySelectorAll('img').length, images, 'no img element is added');
    assert.deepStrictEqual(p.texts(), ['<img src=x onerror=alert(1)>']);
  });
});

describe('the files-kept notice stays until it is closed', () => {
  // The row is there with its text, and the strip is shown.
  function stillShown(p) {
    assert.strictEqual(p.box().hidden, false, 'the strip is still shown');
    assert.deepStrictEqual(p.texts(), [ALPHA], 'the row is still there with its text');
  }

  test('opening another conversation, which empties the message view, leaves the row', async () => {
    const p = await page();
    p.notify('conv-alpha');
    const open = piece(CONVOS_SRC, 'function openConversation(', '\n}\n', 'openConversation');
    const empty = "const el=document.getElementById('messages'); el.innerHTML='';";
    assert.ok(open.includes(empty), 'openConversation empties #messages this way');
    p.w.eval(`(function () { ${empty} })();`);
    assert.strictEqual(p.messages().children.length, 0, 'the message view is empty');
    stillShown(p);
  });

  test('starting a new conversation, which empties the message view, leaves the row', async () => {
    const p = await page();
    p.notify('conv-alpha');
    const create = piece(CONVOS_SRC, 'function createConversation(', '\n}\n', 'createConversation');
    const empty = "document.getElementById('messages').innerHTML = '';";
    assert.ok(create.includes(empty), 'createConversation empties #messages this way');
    p.w.eval(`(function () { ${empty} })();`);
    assert.strictEqual(p.messages().children.length, 0, 'the message view is empty');
    stillShown(p);
  });

  test('a history drawn at the top of the message view leaves the row', async () => {
    const p = await page();
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

  test('a second notice adds a second row after the first, and both show', async () => {
    const p = await page();
    p.notify('conv-alpha');
    p.notify('conv-beta');
    assert.deepStrictEqual(p.texts(), [ALPHA, BETA]);
    assert.strictEqual(p.box().hidden, false);
  });

  test('a close removes its own row only, and the other stays with its text', async () => {
    const p = await page();
    p.notify('conv-alpha');
    p.notify('conv-beta');
    closeOf(p.rows()[0]).click();
    assert.deepStrictEqual(p.texts(), [BETA]);
    assert.strictEqual(p.box().hidden, false, 'the strip stays shown');
  });

  test('when the last row is closed the strip is hidden', async () => {
    const p = await page();
    p.notify('conv-alpha');
    p.notify('conv-beta');
    closeOf(p.rows()[1]).click();
    assert.strictEqual(p.box().hidden, false, 'one row left, still shown');
    closeOf(p.rows()[0]).click();
    assert.strictEqual(p.rows().length, 0);
    assert.strictEqual(p.box().hidden, true);
  });

  test('a close sends nothing to the server', async () => {
    const p = await page();
    p.notify('conv-alpha');
    closeOf(p.rows()[0]).click();
    assert.deepStrictEqual(p.sent(), [], 'nothing sent');
  });
});
