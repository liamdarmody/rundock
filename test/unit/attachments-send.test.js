'use strict';
// Sending a message with files from the composer, and what the page does with
// the server's answer.
//
// The page here runs the shipped public/views/chat.js, conversations.js and
// composer.js whole, with the shipped composer markup cut out of
// public/index.html and, cut out of public/app.js, the escaping helpers, the
// message field's listeners, the line of the message handler that takes the
// answer and the socket's close handler. The socket is a stand-in that writes
// down every frame sent. A picked file holds bytes the detector takes as the
// type its name says (test/helpers/attachment-bytes.js), and a pick is
// awaited until its add has settled. A renamed or missing piece fails here by
// name.
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { typed } = require('../helpers/attachment-bytes.js');
// Loaded so that a tree without the wording fails on an assertion, never on
// the require.
const wording = (() => {
  try { return require('../../public/attachment-wording.js'); } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND' && /attachment-wording/.test(String(e.message))) return null;
    throw e;
  }
})();
function refusalWording(...args) {
  assert.strictEqual(typeof (wording && wording.refusalWording), 'function', 'the wording exports refusalWording');
  return wording.refusalWording(...args);
}

const ROOT = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf-8');

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
const LIMIT = 28000000;
const NOT_CONFIRMED = {
  title: 'Message not confirmed',
  text: 'The connection closed before Rundock confirmed this message. Check the conversation before sending it again.',
};

const AGENTS = [
  { id: 'lead', displayName: 'Lead', colour: '#000', icon: 'L', runtime: 'claude', status: 'onTeam', type: 'specialist' },
  { id: 'helper', displayName: 'Helper', colour: '#000', icon: 'H', status: 'onTeam', type: 'specialist' },
];

const opened = [];
afterEach(() => { while (opened.length) opened.pop().w.close(); });

// A window holding the conversation view, with conversation `c1` on screen.
function page({ listeners = true } = {}) {
  // The new files are checked before they are read, so a tree without them
  // fails here on an assertion.
  for (const file of ['attachment-wording.js', 'attachment-sniff.js', 'views/composer.js']) {
    assert.ok(fs.existsSync(path.join(ROOT, 'public', file)), `the page no longer carries public/${file}`);
  }
  const markup = between(INDEX, '<div class="chat-input">', '\n      </div>', 'the composer markup');
  const dom = new JSDOM(`<!doctype html><html><body><div id="convo-list"></div>
    <input id="chat-title-input"><span id="chat-agent-label"></span><span id="chat-agent-avatar"></span>
    <div id="chat-convo-status"><span class="state-label"></span><span class="action-label"></span></div>
    <div id="chat-status"></div><div id="messages"></div>
    ${markup}</div></body></html>`, { runScripts: 'dangerously' });
  const w = dom.window;
  w.eval(`var agents = ${JSON.stringify(AGENTS)}; var conversations = []; var activeConversation = null; var convoState = {};
    function getConvoState(id) { return convoState[id] || (convoState[id] = { isProcessing: false, activeAgentId: null }); }
    var workingConvos = new Set(); var userScrolledUp = false; var activeSidebarPill = 'all'; var conversationsLoaded = true;
    var currentView = 'chat'; var agentLastActivity = {};
    var unread = { ids: () => [], isUnread: () => false, markMessage() {} };
    function updateWorkingBadge() {} function updateUnreadBadge() {} function formatTimeAgo() { return 'now'; }
    function renderPendingPermissionCards() {} function switchNav() {} function showView() {}
    var ws = { readyState: 1, sent: [], send(raw) { this.sent.push(raw); } };
    ${between(APP, 'function esc(t){', '\nfunction stripRundockMarkers', 'the escaping helpers')}`);
  for (const lib of ['markers.js', 'chat-markup.js', 'conversation-state.js', 'conversation-list.js', 'attachment-wording.js', 'attachment-sniff.js']) w.eval(read('public', lib));
  if (fs.existsSync(path.join(ROOT, 'public', 'attachment-scale.js'))) w.eval(read('public', 'attachment-scale.js'));
  for (const view of ['chat.js', 'conversations.js', 'composer.js']) w.eval(read('public', 'views', view));
  for (const fn of ['showComposerFor', 'pickFiles', 'sendWithFiles', 'fileSendAnswered', 'attachmentsConnectionLost']) {
    assert.strictEqual(typeof w[fn], 'function', `the composer has ${fn}`);
  }
  // The last pick's add, for `pick` to wait on.
  let lastAdd = Promise.resolve();
  const pickFiles = w.pickFiles;
  w.pickFiles = (input) => (lastAdd = Promise.resolve(pickFiles(input)));
  assert.ok(w.document.getElementById('attach-input'), 'the composer markup has the file picker');
  // Permission cards are not part of this page.
  w.renderPendingPermissionCards = () => {};
  if (listeners) w.eval(between(APP, "const msgInput = document.getElementById('msg-input');", '\n// Enter submits', 'the message field\'s listeners'));
  w.eval(`function __open(id, agentId) {
      let c = conversations.find(x => x.id === id);
      if (!c) {
        c = { id, agentId: agentId || 'lead', agent: agents.find(a => a.id === (agentId || 'lead')), title: 'Chat with Lead', messages: [], status: 'active', createdAt: '2026-01-01T00:00:00.000Z' };
        conversations.push(c);
      }
      activeConversation = c; setupChat(c); return c;
    }`);
  const doc = w.document;
  const $ = (id) => doc.getElementById(id);
  const p = {
    w, doc, $,
    open: (id, agentId) => w.__open(id, agentId),
    chips: () => [...doc.querySelectorAll('#composer-chips .composer-chip')].map(c => c.querySelector('.composer-chip-name').textContent),
    bubbles: () => [...doc.querySelectorAll('#messages .msg-user')].map(b => b.textContent),
    notice: () => {
      const title = $('composer-notice').querySelector('strong');
      return title ? { title: title.textContent, text: title.nextElementSibling.textContent } : null;
    },
    file: (name, bytes) => new w.File([new Uint8Array(typed(name, bytes))], name),
    added: () => lastAdd,
    raw: () => w.ws.sent.filter(raw => raw.startsWith('{"type":"chat"')),
    frames: () => w.ws.sent.map(raw => JSON.parse(raw)),
    chatFrames: () => p.frames().filter(f => f.type === 'chat'),
    // The line of the message handler that takes the answer, run as the
    // handler runs it.
    answer: (d) => {
      const line = between(APP, "case 'chat_stored':", '\n', 'the answer to a message sent with files');
      w.eval(`(function (d) { switch (d.type) { ${line} } })`)(d);
    },
    // The socket's close handler, with the reconnect and the other views'
    // handlers standing in.
    closeSocket: () => {
      const onclose = between(APP, 'ws.onclose = () => {', '\n', 'the socket\'s close handler');
      w.eval(`(function () { function setConn() {} function packagesConnectionLost() {} function extensionFetchesConnectionLost() {}
        function linkCreatesConnectionLost() {} function showIfSignedOut() {} function connect() {}
        ws.readyState = 3; ${onclose} ws.onclose(); })`)();
    },
  };
  p.open('c1');
  opened.push(p);
  return p;
}

// The browser handing the picker its chosen files.
async function pick(p, ...files) {
  const input = p.$('attach-input');
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  input.dispatchEvent(new p.w.Event('change'));
  await p.added();
}

function type(p, text) {
  p.$('msg-input').value = text;
  p.$('msg-input').dispatchEvent(new p.w.Event('input'));
}

function pressEnter(p) {
  p.$('msg-input').dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}

async function until(check, label) {
  for (let i = 0; i < 1000; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(`timed out waiting for ${label}`);
}

const bytesOf = (n, seed) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + seed) % 256);

// A message with two files sent from c1, waiting for its answer.
async function sendTwo(p, text = 'see these') {
  await pick(p, p.file('a.png', bytesOf(40, 1)));
  await pick(p, p.file('b.txt', bytesOf(12, 2)));
  type(p, text);
  p.$('send-btn').click();
  await until(() => p.chatFrames().length === 1, 'the frame');
  const frame = p.chatFrames()[0];
  assert.deepStrictEqual((frame.attachments || []).map(a => a.name), ['a.png', 'b.txt'], 'the frame carries the files');
  return frame;
}

describe('Send lights for text or files', () => {
  test('typing and then clearing the field leaves Send lit while files are attached', async () => {
    const p = page();
    await pick(p, p.file('a.png', 10));
    type(p, 'x');
    type(p, '');
    assert.ok(p.$('send-btn').classList.contains('active'));
  });

  test('a conversation opened again with files and no text shows Send lit', async () => {
    const p = page();
    await pick(p, p.file('a.png', 10));
    p.open('c2');
    assert.ok(!p.$('send-btn').classList.contains('active'), 'c2 has nothing to send');
    p.open('c1');
    assert.ok(p.$('send-btn').classList.contains('active'));
  });

  test('when the agent finishes, Send is lit for files and no text drafted meanwhile', async () => {
    const p = page();
    await pick(p, p.file('a.png', 10));
    p.w.startProcessing('c1');
    assert.ok(!p.$('send-btn').classList.contains('active'), 'Send is the Stop button while the agent works');
    p.w.finishProcessing('c1');
    assert.ok(p.$('send-btn').classList.contains('active'));
  });

  test('a message a view drafts is judged ready by the same check as typed text', () => {
    const p = page({ listeners: false });
    const real = p.w.sendReady;
    const judged = [];
    p.w.sendReady = (text) => { judged.push(text); return real(text); };
    assert.strictEqual(p.w.askFromView({ agentId: 'helper', message: 'Summarise this', extension: 'dash', path: 'dash.md' }), null);
    assert.ok(judged.includes('Summarise this'), `judged: ${JSON.stringify(judged)}`);
    assert.ok(p.$('send-btn').classList.contains('active'));
  });
});

describe('a message of files alone', () => {
  test('Send with files and no text sends them', async () => {
    const p = page();
    await pick(p, p.file('a.png', bytesOf(5, 3)));
    p.$('send-btn').click();
    await until(() => p.chatFrames().length === 1, 'the frame');
    const frame = p.chatFrames()[0];
    assert.strictEqual(frame.content, '');
    assert.deepStrictEqual(frame.attachments.map(a => a.name), ['a.png']);
  });

  test('a new conversation whose first message is files alone takes the first file\'s name as its title, as text', async () => {
    const p = page();
    const name = '<img src=x onerror=alert(1)>.png';
    await pick(p, p.file(name, 10), p.file('b.txt', 10));
    p.$('send-btn').click();
    assert.strictEqual(p.$('chat-title-input').value, name);
    assert.deepStrictEqual([...p.doc.querySelectorAll('#convo-list .convo-title')].map(t => t.textContent), [name]);
    assert.strictEqual(p.doc.querySelector('img'), null);
  });
});

describe('the frame a message with files puts on the socket', () => {
  test('each file goes as canonical base64 in chip order, with the fields a text message carries', async () => {
    const p = page();
    p.w.conversations[0].sessionId = 'session-1';
    const first = bytesOf(70000, 5);
    const second = bytesOf(7, 9);
    await pick(p, p.file('first.png', first));
    await pick(p, p.file('second.csv', second));
    type(p, 'see these');
    p.$('send-btn').click();
    await until(() => p.chatFrames().length === 1, 'the frame');
    const frame = p.chatFrames()[0];
    assert.deepStrictEqual(Object.keys(frame).sort(), ['agent', 'attachments', 'content', 'conversationId', 'sessionId', 'type']);
    assert.deepStrictEqual({ content: frame.content, agent: frame.agent, conversationId: frame.conversationId, sessionId: frame.sessionId },
      { content: 'see these', agent: 'lead', conversationId: 'c1', sessionId: 'session-1' });
    assert.deepStrictEqual(frame.attachments.map(a => a.name), ['first.png', 'second.csv']);
    for (const [i, bytes] of [first, second].entries()) {
      assert.strictEqual(frame.attachments[i].data, Buffer.from(bytes).toString('base64'));
      assert.deepStrictEqual(new Uint8Array(Buffer.from(frame.attachments[i].data, 'base64')), bytes);
    }
  });

  test('the frame goes to the agent a text message would, with that agent\'s own session', async () => {
    const p = page();
    p.w.getConvoState('c1').activeAgentId = 'helper';
    p.w.conversations[0].sessionId = 'session-lead';
    p.w.conversations[0].sessionIds = [{ agentId: 'lead', sessionId: 'session-lead' }, { agentId: 'helper', sessionId: 'session-helper' }];
    const frame = await sendTwo(p);
    assert.strictEqual(frame.agent, 'helper');
    assert.strictEqual(frame.sessionId, 'session-helper');
  });

  test('a conversation with no session sends no sessionId', async () => {
    const frame = await sendTwo(page());
    assert.ok(!('sessionId' in frame));
  });

  test('a chip removed before sending is left out of the frame', async () => {
    const p = page();
    await pick(p, p.file('a.png', 3), p.file('b.png', 3), p.file('c.png', 3));
    p.doc.querySelectorAll('#composer-chips .composer-chip-remove')[1].click();
    p.$('send-btn').click();
    await until(() => p.chatFrames().length === 1, 'the frame');
    assert.deepStrictEqual(p.chatFrames()[0].attachments.map(a => a.name), ['a.png', 'c.png']);
  });
});

describe('the page stops a frame over the limit', () => {
  // The frame for `content` with one file, a.txt holding "hello", from c1.
  const frameOf = (content) => JSON.stringify({ type: 'chat', content, agent: 'lead', conversationId: 'c1', attachments: [{ name: 'a.txt', data: 'aGVsbG8=' }] });
  const base = Buffer.byteLength(frameOf(''));
  const hello = (p) => p.file('a.txt', Buffer.from('hello'));

  test('a frame of exactly 28,000,000 bytes is sent', async () => {
    const p = page();
    await pick(p, hello(p));
    type(p, 'a'.repeat(LIMIT - base));
    p.$('send-btn').click();
    await until(() => p.raw().length === 1, 'the frame');
    assert.strictEqual(Buffer.byteLength(p.raw()[0]), LIMIT);
  });

  test('a frame of 28,000,001 bytes is not sent, and the message says why with the text and files kept', async () => {
    const p = page();
    await pick(p, hello(p));
    const text = 'a'.repeat(LIMIT - base + 1);
    type(p, text);
    p.$('send-btn').click();
    await until(() => p.notice(), 'the inline message');
    assert.deepStrictEqual(p.notice(), refusalWording({ code: 'too-large', bytes: LIMIT + 1 }, 1));
    assert.strictEqual(p.raw().length, 0);
    assert.ok(p.$('msg-input').value === text, 'the text is kept');
    assert.deepStrictEqual(p.chips(), ['a.txt']);
    assert.strictEqual(p.$('send-btn').disabled, false);
    assert.deepStrictEqual(p.bubbles(), []);
  });

  test('a frame over 28,000,000 bytes but under 28,000,000 characters, of multibyte text, is not sent', async () => {
    const p = page();
    await pick(p, hello(p));
    const text = 'é'.repeat(14000000);
    assert.ok(frameOf(text).length < LIMIT && Buffer.byteLength(frameOf(text)) > LIMIT);
    type(p, text);
    p.$('send-btn').click();
    await until(() => p.notice(), 'the inline message');
    assert.deepStrictEqual(p.notice(), refusalWording({ code: 'too-large', bytes: Buffer.byteLength(frameOf(text)) }, 1));
    assert.strictEqual(p.raw().length, 0);
  });
});

describe('from the send until the answer', () => {
  test('Send is off, and the text and files stay in the composer', async () => {
    const p = page();
    await sendTwo(p);
    assert.strictEqual(p.$('send-btn').disabled, true);
    assert.strictEqual(p.$('msg-input').value, 'see these');
    assert.deepStrictEqual(p.chips(), ['a.png', 'b.txt']);
  });

  test('no bubble is drawn, nothing is pushed or saved, and processing does not start', async () => {
    const p = page();
    await sendTwo(p);
    assert.deepStrictEqual(p.bubbles(), []);
    assert.strictEqual(p.w.conversations[0].messages.length, 0);
    assert.strictEqual(p.w.getConvoState('c1').isProcessing, false);
    assert.ok(!p.frames().some(f => f.type === 'save_conversation'));
  });

  test('Send pressed again, or Enter, sends nothing more', async () => {
    const p = page();
    await sendTwo(p);
    p.$('send-btn').click();
    pressEnter(p);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.strictEqual(p.chatFrames().length, 1);
  });

  test('Send stays off on returning to the conversation, and is on in another', async () => {
    const p = page();
    await sendTwo(p);
    p.open('c2');
    assert.strictEqual(p.$('send-btn').disabled, false);
    p.open('c1');
    assert.strictEqual(p.$('send-btn').disabled, true);
  });

  test('files cannot be added or removed', async () => {
    const p = page();
    await sendTwo(p);
    await pick(p, p.file('c.png', 3));
    p.doc.querySelector('#composer-chips .composer-chip-remove').click();
    assert.deepStrictEqual(p.chips(), ['a.png', 'b.txt']);
  });
});

describe('when the message is stored', () => {
  const STORED = 'see these\n\n[Attached: a.png (attachments/c1/one/a.png)]\n[Attached: b.txt (attachments/c1/one/b.txt)]';

  test('on screen: the composer clears, the stored text is drawn and pushed, and the turn starts', async () => {
    const p = page();
    await sendTwo(p);
    p.answer({ type: 'chat_stored', conversationId: 'c1', entry: 'one', content: STORED });
    assert.strictEqual(p.$('msg-input').value, '');
    assert.deepStrictEqual(p.chips(), []);
    assert.strictEqual(p.notice(), null);
    assert.deepStrictEqual(p.bubbles(), [STORED]);
    const messages = p.w.conversations[0].messages;
    assert.strictEqual(messages.length, 1);
    assert.deepStrictEqual({ role: messages[0].role, content: messages[0].content }, { role: 'user', content: STORED });
    assert.strictEqual(p.w.getConvoState('c1').isProcessing, true);
    assert.ok(p.$('send-btn').classList.contains('cancel'), 'Send is the Stop button');
    assert.ok(p.frames().some(f => f.type === 'save_conversation' && f.conversation.id === 'c1'), 'the conversation is saved');
  });

  test('a conversation saved earlier comes back to the current session', async () => {
    const p = page();
    Object.assign(p.w.conversations[0], { persisted: true, status: 'archived' });
    await sendTwo(p);
    p.answer({ type: 'chat_stored', conversationId: 'c1', entry: 'one', content: STORED });
    assert.deepStrictEqual({ persisted: p.w.conversations[0].persisted, status: p.w.conversations[0].status }, { persisted: false, status: 'active' });
  });

  test('off screen: only the sending conversation changes, and nothing is drawn', async () => {
    const p = page();
    await sendTwo(p);
    p.open('c2');
    type(p, 'a draft in c2');
    await pick(p, p.file('c2.png', 3));
    p.answer({ type: 'chat_stored', conversationId: 'c1', entry: 'one', content: STORED });
    assert.deepStrictEqual(p.bubbles(), []);
    assert.strictEqual(p.$('msg-input').value, 'a draft in c2');
    assert.deepStrictEqual(p.chips(), ['c2.png']);
    assert.ok(!p.$('send-btn').classList.contains('cancel'));
    const [c1, c2] = p.w.conversations;
    assert.deepStrictEqual(Array.from(c1.messages, m => m.content), [STORED]);
    assert.strictEqual(c2.messages.length, 0);
    assert.strictEqual(p.w.getConvoState('c1').isProcessing, true);
    p.open('c1');
    assert.strictEqual(p.$('msg-input').value, '');
    assert.deepStrictEqual(p.chips(), []);
  });
});

describe('when the message is refused', () => {
  // Built in each test, after page() has checked the wording is there.
  const refused = () => ({ type: 'chat_refused', conversationId: 'c1', code: 'disk-full', ...refusalWording({ code: 'disk-full' }, 2) });

  test('a disk-full refusal shows the server\'s title and text, brings Send back, and keeps the text and files', async () => {
    const p = page();
    const refusal = refused();
    await sendTwo(p);
    p.answer(refusal);
    assert.deepStrictEqual(p.notice(), { title: refusal.title, text: refusal.text });
    assert.strictEqual(p.$('send-btn').disabled, false);
    assert.strictEqual(p.$('msg-input').value, 'see these');
    assert.deepStrictEqual(p.chips(), ['a.png', 'b.txt']);
    assert.deepStrictEqual(p.bubbles(), []);
    assert.strictEqual(p.w.conversations[0].messages.length, 0);
    assert.strictEqual(p.w.getConvoState('c1').isProcessing, false);
  });

  test('sending again after a refusal is one press of Send', async () => {
    const p = page();
    const refusal = refused();
    const first = await sendTwo(p);
    p.answer(refusal);
    p.$('send-btn').click();
    await until(() => p.chatFrames().length === 2, 'the second frame');
    assert.deepStrictEqual(p.chatFrames()[1], first);
  });
});

// The text in the field while a send waits is the text sent, so nothing typed
// then can be lost when the answer clears it: the field takes no edits until
// the answer, and is the person's again after it.
describe('the text of a send waiting for its answer', () => {
  const stored = { type: 'chat_stored', conversationId: 'c1', entry: 'one', content: 'see these\n[Attached: a.png]' };

  test('cannot be changed until the answer comes', async () => {
    const p = page();
    await sendTwo(p);
    assert.strictEqual(p.$('msg-input').readOnly, true);
    assert.strictEqual(p.$('msg-input').value, 'see these');
  });

  test('once stored, the field is empty and takes the next message, which sends', async () => {
    const p = page();
    await sendTwo(p);
    p.answer(stored);
    assert.strictEqual(p.$('msg-input').readOnly, false);
    assert.strictEqual(p.$('msg-input').value, '');
    p.w.finishProcessing('c1');
    type(p, 'and one more');
    p.$('send-btn').click();
    assert.strictEqual(p.chatFrames().length, 2);
    assert.strictEqual(p.chatFrames()[1].content, 'and one more');
  });

  test('once refused, the text is kept and can be changed before sending again', async () => {
    const p = page();
    await sendTwo(p);
    p.answer({ type: 'chat_refused', conversationId: 'c1', code: 'disk-full', title: 'Not sent', text: 'The disk is full' });
    assert.strictEqual(p.$('msg-input').readOnly, false);
    assert.strictEqual(p.$('msg-input').value, 'see these');
    type(p, 'see these again');
    p.$('send-btn').click();
    await until(() => p.chatFrames().length === 2, 'the second frame');
    assert.strictEqual(p.chatFrames()[1].content, 'see these again');
  });

  test('when the socket closes first, the text is kept and can be changed', async () => {
    const p = page();
    await sendTwo(p);
    p.closeSocket();
    assert.strictEqual(p.$('msg-input').readOnly, false);
    assert.strictEqual(p.$('msg-input').value, 'see these');
  });

  test('another conversation\'s field takes edits meanwhile, and coming back finds the sent text still fixed', async () => {
    const p = page();
    await sendTwo(p);
    p.open('c2');
    assert.strictEqual(p.$('msg-input').readOnly, false);
    type(p, 'a draft for c2');
    p.open('c1');
    assert.strictEqual(p.$('msg-input').readOnly, true);
    assert.strictEqual(p.$('msg-input').value, 'see these');
    p.open('c2');
    assert.strictEqual(p.$('msg-input').value, 'a draft for c2');
  });

  test('stored while another conversation is on screen, the field is empty and takes edits on coming back', async () => {
    const p = page();
    await sendTwo(p);
    p.open('c2');
    p.answer(stored);
    p.open('c1');
    assert.strictEqual(p.$('msg-input').readOnly, false);
    assert.strictEqual(p.$('msg-input').value, '');
  });
});

// The workspace changing under the page, as onWorkspaceReady takes a different
// workspace: its line of resets run as written (the other views' resets
// standing in), the conversation list emptied, and the conversation `c1` of
// the new workspace opened under the same ID.
function switchWorkspace(p) {
  const line = between(APP, 'if (!isSameWorkspace) {', '\n', 'the resets for a different workspace');
  p.w.eval(`(function () { const isSameWorkspace = false;
    function packagesWorkspaceChanged() {} function connectorsWorkspaceChanged() {} function workingFoldersWorkspaceChanged() {}
    ${line} conversations = []; activeConversation = null; })`)();
  p.open('c1');
}

// Files belong to the workspace and conversation they were picked in, so none
// reach a conversation of the same ID in another workspace.
describe('the composer when the workspace changes', () => {
  test('files picked and not sent are gone from the same conversation ID in the next workspace, and a send there carries none', async () => {
    const p = page();
    await pick(p, p.file('a.txt', bytesOf(12, 3)));
    assert.deepStrictEqual(p.chips(), ['a.txt']);
    switchWorkspace(p);
    assert.deepStrictEqual(p.chips(), []);
    type(p, 'hello');
    p.$('send-btn').click();
    assert.strictEqual(p.chatFrames().length, 1);
    assert.ok(!('attachments' in p.chatFrames()[0]), 'the frame carries no files');
  });

  test('a send whose files are still being read when the workspace changes puts nothing on the socket', async () => {
    const p = page();
    await pick(p, p.file('a.txt', bytesOf(12, 3)));
    type(p, 'see this');
    p.$('send-btn').click();
    switchWorkspace(p);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.strictEqual(p.chatFrames().length, 0, 'no frame is sent');
  });

  test('a send waiting for its answer when the workspace changes leaves the next workspace\'s composer free, and its late answer changes nothing', async () => {
    const p = page();
    await sendTwo(p);
    switchWorkspace(p);
    assert.deepStrictEqual(p.chips(), []);
    assert.strictEqual(p.$('send-btn').disabled, false);
    assert.strictEqual(p.$('msg-input').readOnly, false);
    p.answer({ type: 'chat_stored', conversationId: 'c1', entry: 'one', content: 'see these\n[Attached: a.png]' });
    assert.deepStrictEqual(p.bubbles(), []);
    assert.strictEqual(p.w.activeConversation.messages.length, 0, 'the conversation holds no message');
  });

  test('the next workspace\'s composer takes its own files and sends only those', async () => {
    const p = page();
    await pick(p, p.file('a.txt', bytesOf(12, 3)));
    switchWorkspace(p);
    await pick(p, p.file('b.txt', bytesOf(5, 4)));
    assert.deepStrictEqual(p.chips(), ['b.txt']);
    type(p, 'see this');
    p.$('send-btn').click();
    await until(() => p.chatFrames().length === 1, 'the frame');
    assert.deepStrictEqual(p.chatFrames()[0].attachments.map((f) => f.name), ['b.txt']);
  });
});

describe('when the socket closes first', () => {
  test('the text and files stay, Send comes back, and the message says it was not confirmed', async () => {
    const p = page();
    await sendTwo(p);
    p.closeSocket();
    assert.deepStrictEqual(p.notice(), NOT_CONFIRMED);
    assert.strictEqual(p.$('send-btn').disabled, false);
    assert.strictEqual(p.$('msg-input').value, 'see these');
    assert.deepStrictEqual(p.chips(), ['a.png', 'b.txt']);
  });

  test('a send that waits off screen is told too, and shows it on returning', async () => {
    const p = page();
    await sendTwo(p);
    p.open('c2');
    p.closeSocket();
    assert.strictEqual(p.notice(), null);
    p.open('c1');
    assert.deepStrictEqual(p.notice(), NOT_CONFIRMED);
    assert.strictEqual(p.$('send-btn').disabled, false);
  });

  test('a socket already closed at Send keeps everything and says the message was not confirmed', async () => {
    const p = page();
    p.w.ws.readyState = 3;
    await pick(p, p.file('a.png', 3));
    type(p, 'see these');
    p.$('send-btn').click();
    await until(() => p.notice(), 'the inline message');
    assert.deepStrictEqual(p.notice(), NOT_CONFIRMED);
    assert.strictEqual(p.w.ws.sent.length, 0);
    assert.deepStrictEqual(p.chips(), ['a.png']);
  });

  test('sending again once connected is one press of Send', async () => {
    const p = page();
    const first = await sendTwo(p);
    p.closeSocket();
    p.w.ws.readyState = 1;
    p.$('send-btn').click();
    await until(() => p.chatFrames().length === 2, 'the second frame');
    assert.deepStrictEqual(p.chatFrames()[1], first);
  });
});

describe('answers for a conversation with no send waiting', () => {
  test('are ignored', async () => {
    const p = page();
    p.answer({ type: 'chat_stored', conversationId: 'c1', entry: 'one', content: 'stray' });
    p.answer({ type: 'chat_refused', conversationId: 'c1', code: 'disk-full', title: 'stray', text: 'stray' });
    assert.deepStrictEqual(p.bubbles(), []);
    assert.strictEqual(p.notice(), null);
    p.open('c2');
    p.open('c1');
    await sendTwo(p);
    p.answer({ type: 'chat_stored', conversationId: 'c2', entry: 'one', content: 'stray' });
    p.answer({ type: 'chat_refused', conversationId: 'c2', code: 'disk-full', title: 'stray', text: 'stray' });
    assert.strictEqual(p.$('send-btn').disabled, true, 'c1 still waits');
    assert.deepStrictEqual(Array.from(p.w.conversations, c => c.messages.length), [0, 0]);
    p.answer({ type: 'chat_stored', conversationId: 'c1', entry: 'one', content: 'stored' });
    p.answer({ type: 'chat_stored', conversationId: 'c1', entry: 'one', content: 'stored' });
    assert.deepStrictEqual(p.bubbles(), ['stored']);
    assert.strictEqual(p.w.conversations[0].messages.length, 1);
  });
});

describe('a text-only send', () => {
  test('goes as today: no attachments key, and the bubble is drawn at once', () => {
    const p = page();
    type(p, 'hello');
    p.$('send-btn').click();
    const frames = p.chatFrames();
    assert.strictEqual(frames.length, 1);
    assert.ok(!('attachments' in frames[0]));
    assert.strictEqual(frames[0].content, 'hello');
    assert.deepStrictEqual(p.bubbles(), ['hello']);
    assert.strictEqual(p.$('msg-input').value, '');
    assert.strictEqual(p.w.getConvoState('c1').isProcessing, true);
  });

  // The inline message goes on a send, a send of text alone included.
  const sixFiles = (p) => Array.from({ length: 6 }, (_, i) => p.file(`f${i}.txt`, bytesOf(3, i)));

  test('takes away the inline message a refused pick left, and it stays gone', async () => {
    const p = page();
    await pick(p, ...sixFiles(p));
    assert.ok(p.notice(), 'the refused pick says why');
    assert.deepStrictEqual(p.chips(), []);
    type(p, 'hello');
    p.$('send-btn').click();
    assert.strictEqual(p.chatFrames().length, 1);
    assert.ok(!('attachments' in p.chatFrames()[0]));
    assert.strictEqual(p.notice(), null);
    p.open('c2');
    p.open('c1');
    assert.strictEqual(p.notice(), null, 'the conversation shown again has no inline message');
  });

  test('takes away only the sending conversation\'s inline message', async () => {
    const p = page();
    p.open('c2');
    await pick(p, ...sixFiles(p));
    const c2Notice = p.notice();
    assert.ok(c2Notice, 'c2\'s refused pick says why');
    p.open('c1');
    type(p, 'hello');
    p.$('send-btn').click();
    assert.strictEqual(p.notice(), null);
    p.open('c2');
    assert.deepStrictEqual(p.notice(), c2Notice);
  });
});
