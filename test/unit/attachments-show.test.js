'use strict';
// A person's sent message shows the files it was sent with: a thumbnail for an
// image, a chip for a document, and "File not available" for a file that isn't
// there as it was sent.
//
// The page here runs the shipped public/views/chat.js, conversations.js and
// composer.js whole, styled by the shipped public/styles/views/chat.css, with
// the shipped public/attachment-lines.js and public/sent-files.js, the
// composer markup cut out of public/index.html and, cut out of public/app.js,
// the escaping helpers and the line of the message handler that takes the
// answer to a message sent with files. The socket is a stand-in that writes
// down every frame sent. A renamed or missing piece fails here by name, and a
// tree without the new modules fails each test on an assertion.
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { JSDOM } = require('jsdom');
const { storedText } = require('../../lib/attachments/receive.js');
const { typed } = require('../helpers/attachment-bytes.js');

const ROOT = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf-8');
const exists = (...parts) => fs.existsSync(path.join(ROOT, ...parts));

// A stretch of shipped source from one anchor to another, the second
// included when `through` is set.
function between(src, from, to, label, through = false) {
  const start = src.indexOf(from);
  const end = start === -1 ? -1 : src.indexOf(to, start + from.length);
  assert.ok(start !== -1 && end !== -1, `the page no longer carries ${label}`);
  return src.slice(start, through ? end + to.length : end);
}

const INDEX = read('public', 'index.html');
const APP = read('public', 'app.js');
const CSS = read('public', 'styles', 'views', 'chat.css');

const ID = '1764000000000';
const OTHER = '1764000000001';
const PNG = { file: '1-diagram.png', name: 'diagram.png', type: 'png', bytes: 1900000, width: 2576, height: 1610 };
const PDF = { file: '2-report.pdf', name: 'report.pdf', type: 'pdf', bytes: 52000 };
const CSV = { file: '3-notes.csv', name: 'notes.csv', type: 'csv', bytes: 120 };
const TXT = { file: '4-readme.txt', name: 'readme.txt', type: 'txt', bytes: 2400 };
const MD = { file: '5-plan.md', name: 'plan.md', type: 'md', bytes: 3100 };

// What the server says of a file it has as it was sent.
function present(f, extra = {}) {
  const entry = { name: f.name, type: f.type, bytes: f.bytes, state: 'present' };
  if (f.width) Object.assign(entry, { width: f.width, height: f.height });
  return Object.assign(entry, extra);
}
// The text the server stores for a message, with one line per file.
const stored = (content, id, ...files) => storedText(content, id, { files });

const AGENTS = [
  { id: 'lead', displayName: 'Lead', colour: '#000', icon: 'L', runtime: 'claude', status: 'onTeam', type: 'specialist' },
];

const opened = [];
afterEach(() => { while (opened.length) opened.pop().w.close(); });

// A window holding the conversation view, with conversation ID on screen.
function page() {
  const markup = between(INDEX, '<div class="chat-input">', '\n      </div>', 'the composer markup');
  const dom = new JSDOM(`<!doctype html><html><head><style>${CSS}</style></head><body><div id="convo-list"></div>
    <input id="chat-title-input"><span id="chat-agent-label"></span><span id="chat-agent-avatar"></span>
    <div id="chat-convo-status"><span class="state-label"></span><span class="action-label"></span></div>
    <div id="chat-status"></div><div id="messages"></div>
    ${markup}</div></body></html>`, { runScripts: 'dangerously' });
  const w = dom.window;
  w.Element.prototype.scrollIntoView = function () {};
  w.eval(`var agents = ${JSON.stringify(AGENTS)}; var conversations = []; var activeConversation = null; var convoState = {};
    function getConvoState(id) { return convoState[id] || (convoState[id] = { isProcessing: false, activeAgentId: null }); }
    var workingConvos = new Set(); var userScrolledUp = false; var activeSidebarPill = 'all'; var conversationsLoaded = true;
    var currentView = 'chat'; var agentLastActivity = {};
    var unread = { ids: () => [], isUnread: () => false, markMessage() {} };
    function updateWorkingBadge() {} function updateUnreadBadge() {} function formatTimeAgo() { return 'now'; }
    function renderPendingPermissionCards() {} function switchNav() {} function showView() {}
    function tryMessageAnchor() {} function formatMd(t) { return esc(t); }
    var ws = { readyState: 1, sent: [], send(raw) { this.sent.push(raw); } };
    ${between(APP, 'function esc(t){', '\nfunction stripRundockMarkers', 'the escaping helpers')}
    function stripRundockMarkers(t) { return RundockMarkers.stripMarkers(t); }`);
  const libs = ['markers.js', 'chat-markup.js', 'conversation-state.js', 'conversation-list.js', 'delegation-restore.js', 'attachment-wording.js'];
  // The new modules load only where they exist, so a tree without them
  // builds the page as it ships and fails on the assertions below.
  for (const lib of ['attachment-lines.js', 'sent-files.js', 'attachment-sniff.js']) if (exists('public', lib)) libs.push(lib);
  for (const lib of libs) w.eval(read('public', lib));
  for (const view of ['chat.js', 'conversations.js', 'composer.js']) w.eval(read('public', 'views', view));
  w.renderPendingPermissionCards = () => {};
  w.eval(between(APP, "const msgInput = document.getElementById('msg-input');", '\n// Enter submits', 'the message field\'s listeners'));
  w.eval(`function __open(id) {
      let c = conversations.find(x => x.id === id);
      if (!c) {
        c = { id, agentId: 'lead', agent: agents[0], title: 'Chat with Lead', messages: [], status: 'active', createdAt: '2026-01-01T00:00:00.000Z' };
        conversations.push(c);
      }
      activeConversation = c; setupChat(c); return c;
    }`);
  const doc = w.document;
  const $ = (id) => doc.getElementById(id);
  const p = {
    w, doc, $,
    open: (id) => w.__open(id),
    convo: (id) => w.conversations.find(c => c.id === id),
    bubbles: () => [...doc.querySelectorAll('#messages .msg-user')],
    last: () => p.bubbles()[p.bubbles().length - 1],
    frames: () => w.ws.sent.map(raw => JSON.parse(raw)),
    // The line of the message handler that takes the answer, run as the
    // handler runs it.
    answer: (d) => {
      const line = between(APP, "case 'chat_stored':", '\n', 'the answer to a message sent with files');
      w.eval(`(function (d) { switch (d.type) { ${line} } })`)(d);
    },
  };
  p.open(ID);
  opened.push(p);
  return p;
}

// The page's map of files, which only the server's replies fill.
function sentFiles(p) {
  const sent = p.w.RundockSentFiles;
  assert.strictEqual(typeof (sent && sent.mergeSentFiles), 'function', 'public/sent-files.js loads and exports mergeSentFiles');
  return sent;
}
function remember(p, id, files) {
  sentFiles(p).mergeSentFiles(id, files);
}
// Every lookup of the map made from here on.
function lookups(p) {
  const sent = sentFiles(p);
  const real = sent.entryFor;
  const calls = [];
  sent.entryFor = (...args) => { calls.push(args); return real(...args); };
  return calls;
}

// The bubble addUserMsg draws for a text, given the conversation's id.
function draw(p, text, id = ID) {
  p.w.addUserMsg(text, true, id);
  return p.last().querySelector('.msg-bubble');
}
// The chips of a bubble, which come first in it.
function chips(bubble) {
  const row = bubble.firstElementChild;
  assert.ok(row && row.matches('div.msg-files'), `the bubble starts with its files: ${bubble.innerHTML.slice(0, 200)}`);
  return [...row.children];
}
function chip(bubble) {
  const all = chips(bubble);
  assert.strictEqual(all.length, 1, 'one chip');
  return all[0];
}
const nameOf = (el) => el.querySelector('.att-name').textContent;
const metaOf = (el) => el.querySelector('.att-meta').textContent;

function assertGone(el, name) {
  assert.ok(el.matches('div.att-chip.gone'), `a gone chip: ${el.outerHTML.slice(0, 200)}`);
  assert.strictEqual(el.getAttribute('role'), 'group');
  assert.strictEqual(el.getAttribute('aria-label'), name);
  assert.strictEqual(el.getAttribute('title'), name);
  assert.strictEqual(nameOf(el), name);
  assert.strictEqual(metaOf(el), 'File not available');
  assert.strictEqual(el.querySelector('img'), null, 'a gone chip creates no image');
  assert.strictEqual(el.querySelector('button'), null);
}

function assertPlain(el, name, meta) {
  assert.ok(el.matches('div.att-chip.plain'), `a plain chip: ${el.outerHTML.slice(0, 200)}`);
  assert.strictEqual(el.getAttribute('role'), 'group');
  assert.strictEqual(el.getAttribute('aria-label'), name);
  assert.strictEqual(el.getAttribute('title'), name);
  assert.strictEqual(nameOf(el), name);
  assert.strictEqual(metaOf(el), meta);
  assert.strictEqual(el.querySelector('button, img'), null, 'a plain chip holds nothing that opens');
}

const TYPED = `Compare <b>these</b> & "those"\n[Attached: .rundock/attachments/${ID}/1-diagram.png (PNG image, 1.9 MB)] as typed`;

describe('a message that names no file draws as before', () => {
  const asBefore = (p, el) => p.w.RundockChatMarkup.userBubbleHtml(p.w.esc(TYPED));

  test('a message sent from the field with no attached-file line draws as before', () => {
    const p = page();
    p.w.dispatchMessage(p.convo(ID), TYPED);
    assert.strictEqual(p.bubbles().length, 1);
    assert.strictEqual(p.last().innerHTML, asBefore(p));
  });

  test('a message the server stored with no attached-file line draws as before', async () => {
    const p = page();
    const input = p.$('attach-input');
    Object.defineProperty(input, 'files', { value: [new p.w.File([typed('a.png', 4)], 'a.png')], configurable: true });
    input.dispatchEvent(new p.w.Event('change'));
    for (let i = 0; i < 500 && !p.doc.querySelector('#composer-chips .composer-chip'); i++) await new Promise(r => setTimeout(r, 2));
    p.$('send-btn').click();
    for (let i = 0; i < 500 && !p.frames().some(f => f.type === 'chat'); i++) await new Promise(r => setTimeout(r, 2));
    assert.ok(p.frames().some(f => f.type === 'chat'), 'the message was sent');
    p.answer({ type: 'chat_stored', conversationId: ID, entry: { files: [{ ...PNG, sha256: 'x' }] }, content: TYPED });
    assert.strictEqual(p.bubbles().length, 1);
    assert.strictEqual(p.last().innerHTML, asBefore(p));
  });

  test('a message replayed with no attached-file line draws as before', () => {
    const p = page();
    p.convo(ID).messages = [{ role: 'user', content: TYPED }];
    p.w.replayConversationInto(p.$('messages'), p.convo(ID));
    assert.strictEqual(p.bubbles().length, 1);
    assert.strictEqual(p.last().innerHTML, asBefore(p));
  });

  test('a message in the history with no attached-file line draws as before', () => {
    const p = page();
    p.w.renderSessionHistory({ conversationId: ID, messages: [{ role: 'user', content: TYPED }], totalCount: 1, hasMore: false, files: {} });
    assert.strictEqual(p.bubbles().length, 1);
    assert.strictEqual(p.last().className, 'msg msg-user history-msg');
    assert.strictEqual(p.last().innerHTML, asBefore(p));
  });
});

describe('a sent file shows in its bubble', () => {
  test('an image the page has is drawn as a thumbnail button that opens it, above the text', () => {
    const p = page();
    remember(p, ID, { [PNG.file]: present(PNG) });
    const bubble = draw(p, stored('Does the drop line up with <b>the outage</b>?', ID, PNG));
    const thumb = chip(bubble);
    assert.ok(thumb.matches('button.msg-thumb'), `a thumbnail button: ${thumb.outerHTML.slice(0, 200)}`);
    assert.strictEqual(thumb.getAttribute('type'), 'button');
    assert.strictEqual(thumb.getAttribute('aria-label'), 'Open diagram.png');
    assert.strictEqual(thumb.getAttribute('title'), 'diagram.png');
    const img = thumb.querySelector('img');
    assert.ok(img, 'the thumbnail holds the image');
    assert.strictEqual(img.getAttribute('alt'), 'diagram.png');
    assert.strictEqual(img.getAttribute('src'), '/workspace-file?path=' + encodeURIComponent(`.rundock/attachments/${ID}/1-diagram.png`));
    assert.strictEqual(bubble.childNodes.length, 2, 'the files, then the text');
    assert.strictEqual(bubble.lastChild.nodeType, 3, 'the text is text');
    assert.strictEqual(bubble.lastChild.textContent, 'Does the drop line up with <b>the outage</b>?');
  });

  test('a thumbnail fits inside 224 by 168 at its own shape, and a small image keeps its size', () => {
    const p = page();
    const wide = { ...PNG };
    const small = { ...PNG, file: '2-small.png', name: 'small.png', width: 100, height: 50 };
    const tall = { ...PNG, file: '3-tall.png', name: 'tall.png', width: 1000, height: 2000 };
    remember(p, ID, { [wide.file]: present(wide), [small.file]: present(small), [tall.file]: present(tall) });
    const sizes = chips(draw(p, stored('', ID, wide, small, tall))).map((el) => {
      const img = el.querySelector('img');
      assert.ok(img, `a thumbnail: ${el.outerHTML.slice(0, 200)}`);
      return [img.getAttribute('width'), img.getAttribute('height')];
    });
    assert.deepStrictEqual(sizes, [['224', '140'], ['100', '50'], ['84', '168']]);
  });

  test('a PDF the page has is drawn as a chip button with its type and size', () => {
    const p = page();
    remember(p, ID, { [PDF.file]: present(PDF) });
    const el = chip(draw(p, stored('the report', ID, PDF)));
    assert.ok(el.matches('button.att-chip'), `a chip button: ${el.outerHTML.slice(0, 200)}`);
    assert.ok(!el.matches('.plain, .gone'));
    assert.strictEqual(el.getAttribute('type'), 'button');
    assert.strictEqual(el.getAttribute('aria-label'), 'Open report.pdf');
    assert.strictEqual(el.getAttribute('title'), 'report.pdf');
    assert.strictEqual(nameOf(el), 'report.pdf');
    assert.strictEqual(metaOf(el), 'PDF · 52 KB');
    assert.strictEqual(el.querySelector('img'), null);
  });

  test('a CSV file is drawn as a plain chip with its type and size', () => {
    const p = page();
    remember(p, ID, { [CSV.file]: present(CSV) });
    assertPlain(chip(draw(p, stored('', ID, CSV))), 'notes.csv', 'CSV · 1 KB');
  });

  test('a text file is drawn as a plain chip with its type and size', () => {
    const p = page();
    remember(p, ID, { [TXT.file]: present(TXT) });
    assertPlain(chip(draw(p, stored('', ID, TXT))), 'readme.txt', 'Text · 3 KB');
  });

  test('a Markdown file is drawn as a plain chip with its type and size', () => {
    const p = page();
    remember(p, ID, { [MD.file]: present(MD) });
    assertPlain(chip(draw(p, stored('', ID, MD))), 'plan.md', 'Markdown · 4 KB');
  });

  test('each file shows as a chip in the order its lines come, and a message of files alone holds no text', () => {
    const p = page();
    remember(p, ID, { [PNG.file]: present(PNG), [PDF.file]: present(PDF), [CSV.file]: present(CSV) });
    const bubble = draw(p, stored('', ID, CSV, PNG, PDF, CSV));
    assert.deepStrictEqual(chips(bubble).map(el => el.getAttribute('title')), ['notes.csv', 'diagram.png', 'report.pdf', 'notes.csv']);
    assert.strictEqual(bubble.childNodes.length, 1, 'only the files');
  });

  test('a line whose file the page has heard nothing of is drawn as not available, under its stored name', () => {
    const p = page();
    assertGone(chip(draw(p, stored('see this', ID, PNG))), '1-diagram.png');
  });

  test('a file changed since it was attached is drawn as not available', () => {
    const p = page();
    remember(p, ID, { [PNG.file]: present(PNG, { state: 'changed' }) });
    assertGone(chip(draw(p, stored('see this', ID, PNG))), 'diagram.png');
  });

  test('a missing file is drawn as not available, under the name it was recorded with', () => {
    const p = page();
    remember(p, ID, { [PNG.file]: present(PNG, { state: 'missing' }), [PDF.file]: { state: 'missing' } });
    const [image, pdf] = chips(draw(p, stored('see these', ID, PNG, PDF)));
    assertGone(image, 'diagram.png');
    assertGone(pdf, '2-report.pdf');
  });

  test('a file the record gives another type than its name\'s is drawn as not available', () => {
    const p = page();
    remember(p, ID, { [PNG.file]: present(PNG, { type: 'pdf' }) });
    assertGone(chip(draw(p, stored('see this', ID, PNG))), 'diagram.png');
  });

  test('a line naming another conversation\'s file is drawn as not available, never looked up or loaded', () => {
    const p = page();
    remember(p, ID, { [PNG.file]: present(PNG), [PDF.file]: present(PDF) });
    remember(p, OTHER, { [PNG.file]: present(PNG) });
    const calls = lookups(p);
    const [theirs, ours] = chips(draw(p, `${stored('', OTHER, PNG)}\n${stored('', ID, PDF)}`));
    assertGone(theirs, '1-diagram.png');
    assert.ok(ours.matches('button.att-chip'), 'this conversation\'s own file still draws');
    assert.deepStrictEqual(calls, [[ID, PDF.file]], 'only this conversation\'s own line is looked up');
    assert.strictEqual(p.last().querySelector('img'), null);
  });

  test('the form a turn writes for a file that wasn\'t there is drawn as not available, never looked up', () => {
    const p = page();
    remember(p, ID, { [PNG.file]: present(PNG) });
    const calls = lookups(p);
    assertGone(chip(draw(p, 'see this\n[Attached file not available: 1-diagram.png]')), '1-diagram.png');
    assert.deepStrictEqual(calls, []);
  });

  test('the form a turn writes for a file changed since it was attached is drawn as not available, never looked up', () => {
    const p = page();
    remember(p, ID, { [PNG.file]: present(PNG) });
    const calls = lookups(p);
    assertGone(chip(draw(p, 'see this\n[Attached file changed since it was attached, so it isn\'t shown: 1-diagram.png]')), '1-diagram.png');
    assert.deepStrictEqual(calls, []);
  });

  test('an image recorded without a width, or with one that isn\'t a whole number of pixels, is drawn as not available', () => {
    const p = page();
    const noWidth = present(PNG);
    delete noWidth.width;
    const half = { ...PNG, file: '2-half.png', name: 'half.png' };
    const flat = { ...PNG, file: '3-flat.png', name: 'flat.png' };
    remember(p, ID, { [PNG.file]: noWidth, [half.file]: present(half, { width: 10.5 }), [flat.file]: present(flat, { height: 0 }) });
    const all = chips(draw(p, stored('', ID, PNG, half, flat)));
    assertGone(all[0], 'diagram.png');
    assertGone(all[1], 'half.png');
    assertGone(all[2], 'flat.png');
  });

  test('a thumbnail whose image fails to load stays a thumbnail', () => {
    const p = page();
    remember(p, ID, { [PNG.file]: present(PNG) });
    const bubble = draw(p, stored('', ID, PNG));
    const img = bubble.querySelector('.msg-thumb img');
    assert.ok(img, 'a thumbnail');
    img.dispatchEvent(new p.w.Event('error'));
    const thumb = chip(bubble);
    assert.ok(thumb.matches('button.msg-thumb'));
    assert.strictEqual(thumb.querySelector('img'), img);
    assert.strictEqual(bubble.querySelector('.gone'), null);
  });

  test('a person who types a whole line for this conversation\'s file sees its chip', () => {
    const p = page();
    remember(p, ID, { [PDF.file]: present(PDF) });
    p.w.dispatchMessage(p.convo(ID), stored('the report again', ID, PDF));
    assert.ok(chip(p.last().querySelector('.msg-bubble')).matches('button.att-chip'));
  });
});

describe('what the page knows of each file, and where it comes from', () => {
  test('the answer to a message sent with files draws its bubble with a thumbnail', async () => {
    const p = page();
    sentFiles(p);
    const input = p.$('attach-input');
    Object.defineProperty(input, 'files', { value: [new p.w.File([typed('diagram.png', 4)], 'diagram.png')], configurable: true });
    input.dispatchEvent(new p.w.Event('change'));
    for (let i = 0; i < 500 && !p.doc.querySelector('#composer-chips .composer-chip'); i++) await new Promise(r => setTimeout(r, 2));
    p.$('send-btn').click();
    for (let i = 0; i < 500 && !p.frames().some(f => f.type === 'chat'); i++) await new Promise(r => setTimeout(r, 2));
    assert.ok(p.frames().some(f => f.type === 'chat'), 'the message was sent');
    assert.strictEqual(p.bubbles().length, 0, 'nothing is drawn before the answer');
    p.answer({ type: 'chat_stored', conversationId: ID, entry: { files: [{ ...PNG, sha256: 'x' }] }, content: stored('', ID, PNG) });
    const thumb = chip(p.last().querySelector('.msg-bubble'));
    assert.ok(thumb.matches('button.msg-thumb'), `a thumbnail: ${thumb.outerHTML.slice(0, 200)}`);
    assert.strictEqual(thumb.getAttribute('title'), 'diagram.png');
  });

  test('the history\'s files draw a thumbnail, and a later history marking the file missing draws it as not available', () => {
    const p = page();
    sentFiles(p);
    const messages = [{ role: 'user', content: stored('see this', ID, PNG) }, { role: 'assistant', content: 'Seen.' }];
    p.w.renderSessionHistory({ conversationId: ID, messages, totalCount: 2, hasMore: false, files: { [PNG.file]: present(PNG) } });
    assert.strictEqual(p.last().className, 'msg msg-user history-msg');
    assert.ok(chip(p.last().querySelector('.msg-bubble')).matches('button.msg-thumb'), 'a thumbnail from the first reply');
    // Read again, as a reload reads it.
    p.convo(ID).messages = [];
    p.convo(ID)._historyCount = 0;
    p.$('messages').replaceChildren();
    p.w.renderSessionHistory({ conversationId: ID, messages, totalCount: 2, hasMore: false, files: { [PNG.file]: present(PNG, { state: 'missing' }) } });
    assert.strictEqual(p.bubbles().length, 1);
    assertGone(chip(p.last().querySelector('.msg-bubble')), 'diagram.png');
  });

  test('replaying a conversation draws its chips from that conversation\'s own files', () => {
    const p = page();
    remember(p, OTHER, { [PNG.file]: present(PNG) });
    p.open(OTHER);
    p.open(ID);
    const theirs = p.convo(OTHER);
    theirs.messages = [{ role: 'user', content: stored('see this', OTHER, PNG) }];
    p.w.replayConversationInto(p.$('messages'), theirs);
    assert.ok(chip(p.last().querySelector('.msg-bubble')).matches('button.msg-thumb'), 'drawn from the replayed conversation\'s files');
  });

  test('what is saved of a conversation is unchanged while the page knows its files', () => {
    const p = page();
    remember(p, ID, { [PNG.file]: present(PNG) });
    draw(p, stored('see this', ID, PNG));
    p.w.ws.sent.length = 0;
    p.w.persistConversation(p.convo(ID));
    const saves = p.frames().filter(f => f.type === 'save_conversation');
    assert.strictEqual(saves.length, 1);
    assert.deepStrictEqual(Object.keys(saves[0]), ['type', 'conversation']);
    assert.deepStrictEqual(Object.keys(saves[0].conversation),
      ['id', 'agentId', 'activeAgentId', 'sessionId', 'sessionIds', 'title', 'status', 'pinned', 'pinnedAt', 'listIds', 'createdAt']);
    assert.ok(!p.w.ws.sent[0].includes('diagram'), 'no file is saved');
  });

  test('the bubble names each type as the composer does', () => {
    assert.ok(exists('public', 'sent-files.js'), 'the page carries public/sent-files.js');
    const cut = (src, label) => {
      const text = between(src, 'const CHIP_TYPES = new Map([', ']);', label, true);
      return [...new Function(`${text}\nreturn CHIP_TYPES;`)()];
    };
    assert.deepStrictEqual(cut(read('public', 'sent-files.js'), 'the bubble\'s types'), cut(read('public', 'views', 'composer.js'), 'the composer\'s types'));
  });
});

// The page above builds its own list of scripts, so the window's own order is
// read from public/index.html as a browser reads it.
describe('the window finds a message\'s lines with the function the server uses', () => {
  test('the window loads attachment-lines.js before chat.js', () => {
    const dom = new JSDOM(INDEX);
    try {
      const scripts = [...dom.window.document.querySelectorAll('script[src]')].map((s) => s.getAttribute('src'));
      const once = (src) => {
        const at = scripts.indexOf(src);
        assert.ok(at !== -1 && scripts.lastIndexOf(src) === at, `public/index.html loads ${src} once`);
        return at;
      };
      assert.ok(once('/attachment-lines.js') < once('/views/chat.js'), 'attachment-lines.js loads before chat.js');
    } finally {
      dom.window.close();
    }
  });

  test('the bubble finds its lines through the global RundockAttachmentLines', () => {
    const p = page();
    const shared = p.w.RundockAttachmentLines;
    assert.strictEqual(typeof (shared && shared.splitAttachmentLines), 'function',
      'public/attachment-lines.js sets the global RundockAttachmentLines in the window');
    const real = shared.splitAttachmentLines;
    const asked = [];
    shared.splitAttachmentLines = (text) => { asked.push(text); return real(text); };
    remember(p, ID, { [PNG.file]: present(PNG) });
    const text = stored('see this', ID, PNG);
    assert.ok(chip(draw(p, text)).matches('button.msg-thumb'), 'the line draws as its thumbnail');
    assert.ok(asked.includes(text), 'the bubble asked RundockAttachmentLines.splitAttachmentLines for its lines');
  });
});

// The viewers the files pane loads. A document here has no module loader, so
// the page is given the shipped module in its place.
let registry = null;
async function viewers() {
  if (!registry) registry = await import(pathToFileURL(path.join(ROOT, 'public', 'viewers', 'registry.js')).href);
  return registry;
}
const GONE = { file: '6-old.png', name: 'old.png', type: 'png', bytes: 4000, width: 10, height: 10 };
const PNG_PATH = `.rundock/attachments/${ID}/${PNG.file}`;
const PDF_PATH = `.rundock/attachments/${ID}/${PDF.file}`;

// A bubble holding a thumbnail, a PDF chip, a plain chip and a gone chip.
async function sentBubble(p) {
  const sent = sentFiles(p);
  const shipped = await viewers();
  sent.loadViewers = () => Promise.resolve(shipped);
  remember(p, ID, { [PNG.file]: present(PNG), [PDF.file]: present(PDF), [CSV.file]: present(CSV) });
  const [thumb, pdf, plain, gone] = chips(draw(p, stored('see these', ID, PNG, PDF, CSV, GONE)));
  return { thumb, pdf, plain, gone };
}
const overlay = (p) => p.doc.querySelector('.palette-overlay');
const dialog = (p) => p.doc.querySelector('[role="dialog"]');
const closeButton = (p) => dialog(p).querySelector('button[aria-label="Close"]');
// The file mounted in the dialog, once the viewers have loaded.
async function mounted(p, selector) {
  for (let i = 0; i < 250; i++) {
    const found = dialog(p) && dialog(p).querySelector(selector);
    if (found) return found;
    await new Promise(r => setTimeout(r, 2));
  }
  return assert.fail(`the dialog mounts its file: ${dialog(p) ? dialog(p).outerHTML.slice(0, 300) : 'no dialog is open'}`);
}
function key(p, target, k) {
  const e = new p.w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
}
// A press of the pointer, down and up on one element, as a browser sends it.
function press(p, target) {
  for (const type of ['mousedown', 'mouseup', 'click']) target.dispatchEvent(new p.w.MouseEvent(type, { bubbles: true, cancelable: true }));
}
// Every Escape that reaches the document on its way back up.
function escapesReaching(p) {
  const seen = [];
  p.doc.addEventListener('keydown', (e) => { if (e.key === 'Escape') seen.push(e); });
  return seen;
}
function assertOpen(p, name) {
  assert.ok(dialog(p), 'a dialog is open');
  assert.strictEqual(dialog(p).getAttribute('aria-label'), name);
}
function assertClosed(p, opener) {
  assert.strictEqual(overlay(p), null, 'the scrim is gone');
  assert.strictEqual(dialog(p), null, 'the dialog is gone');
  assert.strictEqual(p.doc.activeElement, opener, 'focus is back on the button that opened it');
}

describe('an image or a PDF opens larger over the conversation', () => {
  test('a PNG opens a dialog over the palette\'s scrim with its name, its line and a Close button', async () => {
    const p = page();
    const { thumb } = await sentBubble(p);
    press(p, thumb);
    const scrim = overlay(p);
    assert.ok(scrim, 'a scrim is drawn');
    assert.strictEqual(p.doc.querySelectorAll('.palette-overlay').length, 1, 'one overlay');
    const rule = between(read('public', 'styles', 'components', 'palette.css'), '.palette-overlay {', '}', 'the palette\'s scrim');
    assert.ok(rule.includes('position: fixed; inset: 0; background: rgba(0,0,0,0.18);'), `the scrim covers the window in the palette's background: ${rule}`);
    const d = dialog(p);
    assert.ok(d && d.parentElement === scrim, 'the dialog sits over the scrim');
    assert.strictEqual(p.doc.querySelectorAll('[role="dialog"]').length, 1);
    assert.strictEqual(d.getAttribute('aria-modal'), 'true');
    assert.strictEqual(d.getAttribute('aria-label'), 'diagram.png');
    const texts = [...d.querySelectorAll('*')].filter(el => el.children.length === 0 && el.textContent).map(el => el.textContent);
    assert.deepStrictEqual(texts, ['diagram.png', 'PNG · 2,576 × 1,610 px · 1.9 MB'], 'the name, then the line under it');
    const close = closeButton(p);
    assert.ok(close && close.matches('button[type="button"]'), 'a Close button');
    assert.ok(await mounted(p, 'img'), 'the file');
  });

  test('the open image has the file\'s name as its alt', async () => {
    const p = page();
    const { thumb } = await sentBubble(p);
    press(p, thumb);
    const img = await mounted(p, 'img');
    assert.strictEqual(img.getAttribute('alt'), 'diagram.png');
    assert.strictEqual(img.getAttribute('src'), (await viewers()).workspaceFileUrl(PNG_PATH));
  });

  test('a PDF opens in a frame over the file\'s own address, with its pages panel shut', async () => {
    const p = page();
    const { pdf } = await sentBubble(p);
    press(p, pdf);
    assertOpen(p, 'report.pdf');
    const texts = [...dialog(p).querySelectorAll('*')].filter(el => el.children.length === 0 && el.textContent).map(el => el.textContent);
    assert.deepStrictEqual(texts, ['report.pdf', 'PDF · 52 KB']);
    const frame = await mounted(p, 'iframe');
    assert.strictEqual(frame.getAttribute('src'), (await viewers()).workspaceFileUrl(PDF_PATH) + '#navpanes=0');
  });

  test('Enter or Space on a thumbnail opens it', async () => {
    const p = page();
    const { thumb } = await sentBubble(p);
    for (const k of ['Enter', ' ']) {
      thumb.focus();
      assert.strictEqual(key(p, thumb, k).defaultPrevented, false, `${k} is left to the button's own activation`);
      assert.ok(thumb.matches('button[type="button"]'), 'a button, which the key activates');
      // What a browser does for a key that activates a focused button.
      thumb.click();
      assertOpen(p, 'diagram.png');
      key(p, p.doc.activeElement, 'Escape');
    }
  });

  test('opening a file moves focus onto Close', async () => {
    const p = page();
    const { pdf } = await sentBubble(p);
    pdf.focus();
    press(p, pdf);
    assertOpen(p, 'report.pdf');
    assert.strictEqual(p.doc.activeElement, closeButton(p));
  });

  test('Escape closes the file and puts focus back on its thumbnail, and the next Escape is the page\'s', async () => {
    const p = page();
    const { thumb } = await sentBubble(p);
    thumb.focus();
    press(p, thumb);
    await mounted(p, 'img');
    const seen = escapesReaching(p);
    const e = key(p, p.doc.activeElement, 'Escape');
    assert.strictEqual(e.defaultPrevented, true);
    assert.strictEqual(seen.length, 0, 'the find bar and the rest of the page never see this Escape');
    assertClosed(p, thumb);
    const next = key(p, thumb, 'Escape');
    assert.strictEqual(next.defaultPrevented, false);
    assert.strictEqual(seen.length, 1, 'with nothing open, Escape goes on to the page');
  });

  test('the Close button closes the file', async () => {
    const p = page();
    const { pdf } = await sentBubble(p);
    press(p, pdf);
    await mounted(p, 'iframe');
    press(p, closeButton(p));
    assertClosed(p, pdf);
  });

  test('a click on the scrim closes the file', async () => {
    const p = page();
    const { thumb } = await sentBubble(p);
    press(p, thumb);
    assertOpen(p, 'diagram.png');
    press(p, overlay(p));
    assertClosed(p, thumb);
  });

  test('a click inside the dialog leaves it open', async () => {
    const p = page();
    const { thumb } = await sentBubble(p);
    press(p, thumb);
    const img = await mounted(p, 'img');
    for (const el of [dialog(p), dialog(p).firstElementChild, img]) press(p, el);
    assertOpen(p, 'diagram.png');
    assert.ok(overlay(p), 'the scrim stays');
  });

  test('with no file open, the explanation\'s Escape still closes the explanation', () => {
    const p = page();
    const divider = p.w.createSummarisedDivider({ key: 'k1' });
    p.$('messages').appendChild(divider);
    const why = divider.querySelector('button.summarised-why');
    why.click();
    assert.strictEqual(why.getAttribute('aria-expanded'), 'true');
    why.focus();
    const seen = escapesReaching(p);
    const e = key(p, why, 'Escape');
    assert.strictEqual(e.defaultPrevented, true);
    assert.strictEqual(why.getAttribute('aria-expanded'), 'false', 'the explanation is shut');
    assert.strictEqual(divider.querySelector('.summarised-explain').hidden, true);
    assert.strictEqual(seen.length, 0);
    assert.strictEqual(key(p, why, 'Escape').defaultPrevented, false, 'with it shut, Escape is the page\'s');
    assert.strictEqual(seen.length, 1);
  });

  test('a plain chip and a gone chip open nothing when clicked', async () => {
    const p = page();
    const { plain, gone } = await sentBubble(p);
    assertPlain(plain, 'notes.csv', 'CSV · 1 KB');
    assertGone(gone, '6-old.png');
    for (const el of [plain, gone, plain.querySelector('.att-name'), gone.querySelector('.att-tile')]) press(p, el);
    await new Promise(r => setTimeout(r, 10));
    assert.strictEqual(overlay(p), null);
    assert.strictEqual(dialog(p), null);
  });
});

// A name that is markup, and the stored names the write would give it.
const MARKUP = '<img src=x onerror=alert(1)>.png';
const MARKED = { file: '7-img-src-x-onerror-alert-1.png', name: MARKUP, type: 'png', bytes: 1900000, width: 2576, height: 1610 };
const MARKED_GONE = { file: '8-img-src-x-onerror-alert-1.png', name: MARKUP, type: 'png', bytes: 4000, width: 10, height: 10 };

// Every element under root as tag and classes, in order, with an icon's
// paths and whatever a viewer mounted left out (each is checked on its own).
function shape(root, skip = () => false) {
  const out = [];
  const walk = (node) => {
    for (const child of node.children) {
      const cls = child.getAttribute('class');
      out.push(child.tagName.toLowerCase() + (cls ? '.' + cls.split(' ').join('.') : ''));
      if (child.tagName.toLowerCase() === 'svg') {
        assert.ok([...child.querySelectorAll('*')].every(el => el.tagName.toLowerCase() === 'path' && el.attributes.length === 1),
          'an icon holds only its paths');
      } else if (!skip(child)) walk(child);
    }
  };
  walk(root);
  return out;
}
function assertNoMarkup(p, root) {
  assert.strictEqual(root.querySelector('[onerror]'), null, 'no element carries the name\'s handler');
  assert.strictEqual(p.doc.querySelector('img[src="x"]'), null, 'no image is made from the name');
}

describe('a file\'s name is shown as text', () => {
  test('a name holding markup shows as that text in a thumbnail and a gone chip, and the bubble holds only what the draw made', () => {
    const p = page();
    remember(p, ID, { [MARKED.file]: present(MARKED), [MARKED_GONE.file]: present(MARKED_GONE, { state: 'changed' }) });
    const bubble = draw(p, stored('look', ID, MARKED, MARKED_GONE));
    const [thumb, gone] = chips(bubble);
    assert.ok(thumb.matches('button.msg-thumb'), `a thumbnail: ${thumb.outerHTML.slice(0, 200)}`);
    assert.strictEqual(thumb.getAttribute('aria-label'), `Open ${MARKUP}`);
    assert.strictEqual(thumb.getAttribute('title'), MARKUP);
    assert.strictEqual(thumb.querySelector('img').getAttribute('alt'), MARKUP);
    assertGone(gone, MARKUP);
    assertNoMarkup(p, bubble);
    assert.deepStrictEqual(shape(bubble), ['div.msg-files', 'button.msg-thumb', 'img',
      'div.att-chip.gone', 'span.att-tile', 'svg.ic', 'span.att-txt', 'span.att-name', 'span.att-meta']);
    assert.strictEqual(bubble.lastChild.nodeType, p.w.Node.TEXT_NODE);
    assert.strictEqual(bubble.lastChild.textContent, 'look');
  });

  test('a name holding markup shows as that text in the open file\'s name and label, and the dialog holds only what the draw made', async () => {
    const p = page();
    const sent = sentFiles(p);
    const shipped = await viewers();
    sent.loadViewers = () => Promise.resolve(shipped);
    remember(p, ID, { [MARKED.file]: present(MARKED) });
    press(p, chip(draw(p, stored('look', ID, MARKED))));
    assertOpen(p, MARKUP);
    const img = await mounted(p, 'img');
    const d = dialog(p);
    assert.strictEqual(d.querySelector('.sent-file-name').textContent, MARKUP);
    assert.strictEqual(img.getAttribute('alt'), MARKUP);
    assertNoMarkup(p, overlay(p));
    const body = d.querySelector('.sent-file-body');
    assert.deepStrictEqual(shape(overlay(p), el => el === body), ['div.sent-file', 'div.sent-file-head', 'div.sent-file-title',
      'div.sent-file-name', 'div.sent-file-line', 'button.sent-file-close', 'svg.ic', body.tagName.toLowerCase() + '.' + body.className.split(' ').join('.')]);
    // The body holds what the viewer draws for this file and nothing more.
    const alone = p.doc.createElement('div');
    shipped.mountImageViewer({ paneElement: alone, path: `.rundock/attachments/${ID}/${MARKED.file}`, alt: MARKUP });
    assert.strictEqual(body.innerHTML, alone.innerHTML);
  });
});

// THE COLORS. Each row names the rule in the shipped stylesheets and the
// property carrying a color, reads that declaration (a `body.light` variant
// wins in light, as on the page), checks it is the token the design sets,
// resolves it against tokens.css in each theme and measures the WCAG 2 ratio
// on the surface it is drawn on: a translucent surface over what is under it,
// and a history bubble at its opacity over the page, each rounded to the 8
// bits a screen shows. The source is read with plain string search.
function rules(css) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const map = new Map();
  let at = 0;
  for (;;) {
    const open = src.indexOf('{', at);
    if (open === -1) return map;
    const selector = src.slice(at, open).trim();
    if (selector.startsWith('@')) {
      let depth = 1;
      let i = open + 1;
      for (; depth && i < src.length; i++) depth += src[i] === '{' ? 1 : src[i] === '}' ? -1 : 0;
      at = i;
      continue;
    }
    const close = src.indexOf('}', open);
    const decls = new Map();
    for (const d of src.slice(open + 1, close).split(';')) {
      const colon = d.indexOf(':');
      if (colon > 0) decls.set(d.slice(0, colon).trim(), d.slice(colon + 1).trim());
    }
    for (const sel of selector.split(',').map(s => s.trim()).filter(Boolean)) map.set(sel, new Map([...(map.get(sel) || []), ...decls]));
    at = close + 1;
  }
}
const SHEETS = { chat: rules(CSS), base: rules(read('public', 'styles', 'base.css')) };
const TOKENS = rules(read('public', 'styles', 'tokens.css'));
const THEMES = { dark: new Map(TOKENS.get(':root')), light: new Map([...TOKENS.get(':root'), ...TOKENS.get('body.light')]) };

function declared(sheet, selector, property, theme) {
  const light = SHEETS[sheet].get(`body.light ${selector}`);
  if (theme === 'light' && light && light.has(property)) return light.get(property);
  const rule = SHEETS[sheet].get(selector);
  assert.ok(rule && rule.has(property), `no ${property} on ${selector}; if the rule moved, move this row with it`);
  return rule.get(property);
}
// A color value as { rgb, alpha }, through as many tokens as it names.
function paint(value, theme, where) {
  const v = value.trim();
  if (v.startsWith('var(') && v.endsWith(')')) {
    const name = v.slice(4, -1).trim();
    assert.ok(THEMES[theme].has(name), `${where} reads ${name}, which tokens.css does not declare`);
    return paint(THEMES[theme].get(name), theme, `${where} via ${name}`);
  }
  if (v.startsWith('#') && v.length === 7) {
    const n = parseInt(v.slice(1), 16);
    assert.ok(Number.isInteger(n), `${where} resolves to ${v}`);
    return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], alpha: 1 };
  }
  if (v.startsWith('rgba(') && v.endsWith(')')) {
    const parts = v.slice(5, -1).split(',').map(Number);
    assert.ok(parts.length === 4 && parts.every(Number.isFinite), `${where} resolves to ${v}`);
    return { rgb: parts.slice(0, 3), alpha: parts[3] };
  }
  return assert.fail(`${where} resolves to ${v}, not a color this test reads`);
}
const blend = (rgb, alpha, under) => rgb.map((c, i) => Math.round(c * alpha + under[i] * (1 - alpha)));
const over = (top, under) => blend(top.rgb, top.alpha, under);
function luminance(c) {
  const [r, g, b] = c.map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const ratio = (a, b) => { const x = luminance(a); const y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

// A declaration that must be the token the design sets, resolved in a theme.
function token(sheet, selector, property, expected, theme) {
  const value = declared(sheet, selector, property, theme);
  assert.strictEqual(value, expected, `${selector} ${property} in ${theme}`);
  return value;
}
// The surfaces, from the page up: the conversation on the main pane, a
// person's bubble over it, and a chip in the bubble.
function surfaces(theme) {
  const page = paint(declared('base', '.main', 'background', theme), theme, '.main').rgb;
  const bubble = over(paint(token('chat', '.msg-user .msg-bubble', 'background', 'var(--accent-glow)', theme), theme, 'the bubble'), page);
  return { page, bubble };
}
// A color the last word of a border or outline names, after its width and style.
function line(sheet, selector, property, width, style, color, theme) {
  const value = token(sheet, selector, property, `${width} ${style} ${color}`, theme);
  return value.split(' ').pop();
}
function assertRatio(label, theme, fg, bg, need) {
  const r = ratio(fg, bg);
  assert.ok(r >= need, `${label} in ${theme} measures ${r.toFixed(2)}:1, needs ${need}`);
}
const BOTH = ['dark', 'light'];

describe('every part of a chip and the open file meets its contrast in dark and in light', () => {
  const chipSurface = (theme) => over(paint(token('chat', '.msg-files .att-chip', 'background', 'var(--card)', theme), theme, 'a chip'), surfaces(theme).bubble);

  test('a chip\'s name, in --text-1 on the chip\'s --card, clears 4.5:1', () => {
    for (const theme of BOTH) {
      const fg = over(paint(token('chat', '.msg-files .att-name', 'color', 'var(--text-1)', theme), theme, 'the name'), chipSurface(theme));
      assertRatio('a chip\'s name', theme, fg, chipSurface(theme), 4.5);
    }
  });

  test('a chip\'s meta, in --text-2-strong on the chip\'s --card, clears 4.5:1', () => {
    for (const theme of BOTH) {
      const fg = over(paint(token('chat', '.msg-files .att-meta', 'color', 'var(--text-2-strong)', theme), theme, 'the meta'), chipSurface(theme));
      assertRatio('a chip\'s meta', theme, fg, chipSurface(theme), 4.5);
    }
  });

  test('a chip\'s icon, in --text-2-strong on its tile\'s --elevated, clears 3:1', () => {
    for (const theme of BOTH) {
      const tile = over(paint(token('chat', '.msg-files .att-tile', 'background', 'var(--elevated)', theme), theme, 'the tile'), chipSurface(theme));
      const fg = over(paint(token('chat', '.msg-files .att-tile', 'color', 'var(--text-2-strong)', theme), theme, 'the icon'), tile);
      assertRatio('a chip\'s icon', theme, fg, tile, 3);
    }
  });

  test('the focus ring of a thumbnail or a chip, --accent-control 2px out on the bubble\'s --accent-glow over --elevated, clears 3:1', () => {
    for (const theme of BOTH) {
      const { page, bubble } = surfaces(theme);
      assert.strictEqual(token('base', '.main', 'background', 'var(--elevated)', theme), 'var(--elevated)');
      for (const selector of ['.msg-thumb:focus-visible', '.msg-files .att-chip:focus-visible']) {
        const color = line('chat', selector, 'outline', '2px', 'solid', 'var(--accent-control)', theme);
        token('chat', selector, 'outline-offset', '2px', theme);
        assertRatio(`${selector}'s ring`, theme, over(paint(color, theme, selector), bubble), bubble, 3);
      }
      assert.notDeepStrictEqual(bubble, page, 'the bubble is drawn over the page');
    }
  });

  // A gone chip in a history bubble, which is drawn at the history's opacity
  // over the page.
  function goneParts(theme) {
    const { page, bubble } = surfaces(theme);
    const opacity = Number(declared('chat', '.history-msg', 'opacity', theme));
    assert.ok(opacity > 0 && opacity < 1, `the history is dimmed: ${opacity}`);
    const chipBg = over(paint(token('chat', '.msg-files .att-chip.gone', 'background', 'var(--elevated)', theme), theme, 'a gone chip'), bubble);
    const dim = (rgb) => blend(rgb, opacity, page);
    return { opacity, chipBg, dim };
  }

  test('a gone chip\'s name, meta and icon, in --text-1 on --elevated at the history\'s opacity, clear 4.5:1', () => {
    for (const theme of BOTH) {
      const { chipBg, dim } = goneParts(theme);
      token('chat', '.msg-files .att-chip.gone .att-tile', 'background', 'transparent', theme);
      for (const part of ['.att-name', '.att-meta', '.att-tile']) {
        const selector = `.msg-files .att-chip.gone ${part}`;
        const fg = over(paint(token('chat', selector, 'color', 'var(--text-1)', theme), theme, selector), chipBg);
        assertRatio(`a gone chip's ${part.slice(5)}`, theme, dim(fg), dim(chipBg), 4.5);
      }
    }
  });

  test('a gone chip\'s outline, 1px dashed --text-1 at the history\'s opacity, clears 3:1', () => {
    for (const theme of BOTH) {
      const { chipBg, dim } = goneParts(theme);
      const color = line('chat', '.msg-files .att-chip.gone', 'border', '1px', 'dashed', 'var(--text-1)', theme);
      assertRatio('a gone chip\'s outline', theme, dim(over(paint(color, theme, 'the outline'), chipBg)), dim(chipBg), 3);
    }
  });

  const fileSurface = (theme) => {
    line('chat', '.sent-file', 'border', '1px', 'solid', 'var(--border)', theme);
    return paint(token('chat', '.sent-file', 'background', 'var(--elevated)', theme), theme, 'the open file').rgb;
  };

  test('the open file\'s name, in --text-1 on its --elevated, clears 4.5:1', () => {
    for (const theme of BOTH) {
      const fg = over(paint(token('chat', '.sent-file-name', 'color', 'var(--text-1)', theme), theme, 'the name'), fileSurface(theme));
      assertRatio('the open file\'s name', theme, fg, fileSurface(theme), 4.5);
    }
  });

  test('the open file\'s line, in --text-2-strong on its --elevated, clears 4.5:1', () => {
    for (const theme of BOTH) {
      const fg = over(paint(token('chat', '.sent-file-line', 'color', 'var(--text-2-strong)', theme), theme, 'the line'), fileSurface(theme));
      assertRatio('the open file\'s line', theme, fg, fileSurface(theme), 4.5);
    }
  });

  test('the open file\'s Close, in --text-2-strong on its --elevated, clears 3:1', () => {
    for (const theme of BOTH) {
      const fg = over(paint(token('chat', '.sent-file-close', 'color', 'var(--text-2-strong)', theme), theme, 'Close'), fileSurface(theme));
      assertRatio('the open file\'s Close', theme, fg, fileSurface(theme), 3);
    }
  });
});
