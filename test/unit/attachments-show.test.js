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
const { JSDOM } = require('jsdom');
const { storedText } = require('../../lib/attachments/receive.js');

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
  for (const lib of ['attachment-lines.js', 'sent-files.js']) if (exists('public', lib)) libs.push(lib);
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
    Object.defineProperty(input, 'files', { value: [new p.w.File([new Uint8Array(4)], 'a.png')], configurable: true });
    input.dispatchEvent(new p.w.Event('change'));
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
    Object.defineProperty(input, 'files', { value: [new p.w.File([new Uint8Array(4)], 'diagram.png')], configurable: true });
    input.dispatchEvent(new p.w.Event('change'));
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
