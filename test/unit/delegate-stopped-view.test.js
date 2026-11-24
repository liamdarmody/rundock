'use strict';
// The line a person reads when a delegate stopped before finishing, on the
// page: which messages draw it, the notice it is drawn as, where it is kept,
// and how a reopened conversation draws it again.
//
// Measured on the document, through the real view functions and the real
// routing helper lifted out of app.js (the pattern of team-line-view.test.js).
const { test, describe, before, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const APP = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const cs = require(path.join(ROOT, 'public', 'conversation-state.js'));

const LINE = "Wren stopped before finishing\nWren's session ended before a final answer (exit code 1). "
  + 'Cos has the conversation again. Anything Wren changed before stopping is still in your workspace.';

let chat;
let convos;
before(() => {
  const dom = new JSDOM('<!doctype html><html><body><div id="messages"></div><div id="chat-status"></div><input id="msg-input">'
    + '<button id="send-btn"></button><span id="chat-agent-label"></span><span id="chat-agent-avatar"></span>'
    + '<input id="chat-title-input"><div id="chat-title"></div><div id="convo-list"></div></body></html>');
  global.window = dom.window;
  global.document = dom.window.document;
  dom.window.Element.prototype.scrollIntoView = function () {};
  global.esc = (t) => String(t);
  global.formatMd = (t) => String(t);
  global.userScrolledUp = false;
  global.getConvoState = () => ({ currentStreamingMsg: null, isProcessing: false });
  global.renderConvoList = () => {};
  global.createHistoryDivider = () => document.createElement('hr');
  global.tryMessageAnchor = () => {};
  global.setActiveAgentPill = () => {};
  global.renderPendingPermissionCards = () => {};
  global.agents = [
    { id: 'chief-of-staff', displayName: 'Cos', type: 'orchestrator' },
    { id: 'content-lead', displayName: 'Wren', type: 'specialist' },
  ];
  global.RundockChatMarkup = require(path.join(ROOT, 'public', 'chat-markup.js'));
  global.RundockMarkers = require(path.join(ROOT, 'public', 'markers.js'));
  global.stripRundockMarkers = (t) => global.RundockMarkers.stripMarkers(String(t || ''));
  global.restoredActiveAgentId = require(path.join(ROOT, 'public', 'delegation-restore.js')).restoredActiveAgentId;
  chat = require(path.join(ROOT, 'public', 'views', 'chat.js'));
  Object.assign(global, chat);
  convos = require(path.join(ROOT, 'public', 'views', 'conversations.js'));
});

const messagesEl = () => document.getElementById('messages');
const notices = () => [...messagesEl().querySelectorAll('.msg-stopped')];

function noticeBuilder() {
  assert.strictEqual(typeof chat.buildDelegateStoppedNotice, 'function', 'the view builds the notice');
  return chat.buildDelegateStoppedNotice;
}

// The routing helper, lifted out of app.js and run against these globals.
function routingHelper() {
  const at = APP.indexOf('function addDelegateStoppedToConvo');
  assert.ok(at > -1, 'the routing helper exists in app.js');
  // eslint-disable-next-line no-new-func
  return new Function(`${APP.slice(at, APP.indexOf('\n}', at) + 2)}; return addDelegateStoppedToConvo;`)();
}

describe('only the server\'s own line draws a notice', () => {
  const line = (extra) => ({ type: 'system', subtype: 'delegate_stopped', _conversationId: 'c1', content: LINE, ...extra });

  test('a line with a process id, whatever its value, draws nothing', () => {
    for (const pid of ['abc', null, 0, '']) {
      assert.deepStrictEqual(cs.reduce(cs.createState(), line({ _processId: pid }), {}).effects, [], `process id ${JSON.stringify(pid)}`);
    }
  });

  test('a line with no words draws nothing', () => {
    const { content, ...noContent } = line();
    assert.ok(content, 'sanity');
    assert.deepStrictEqual(cs.reduce(cs.createState(), noContent, {}).effects, [], 'missing');
    for (const bad of ['', null, 42]) {
      assert.deepStrictEqual(cs.reduce(cs.createState(), line({ content: bad }), {}).effects, [], JSON.stringify(bad));
    }
  });

  test('the server\'s line draws exactly one notice, with its words', () => {
    assert.deepStrictEqual(cs.reduce(cs.createState(), line(), {}).effects, [{ type: 'show-delegate-stopped', content: LINE }]);
  });

  test('the page sends the line to the reducer and draws it through the helper', () => {
    assert.match(APP, /d\.subtype\s*===\s*'delegate_stopped'/, 'the line is dispatched');
    const at = APP.indexOf("'show-delegate-stopped':");
    assert.ok(at > -1, 'the effect has an executor');
    assert.match(APP.slice(at, APP.indexOf('\n', at)), /addDelegateStoppedToConvo\(ef\.content,\s*convoId\)/);
  });
});

describe('the notice', () => {
  beforeEach(() => { messagesEl().innerHTML = ''; });

  test('is a status with a hidden icon, a title and a reason', () => {
    const n = noticeBuilder()(LINE);
    assert.strictEqual(n.tagName, 'DIV');
    assert.ok(n.classList.contains('msg-stopped'));
    assert.strictEqual(n.getAttribute('role'), 'status');
    const svg = n.querySelector('svg');
    assert.ok(svg, 'an icon');
    assert.strictEqual(svg.getAttribute('aria-hidden'), 'true');
    assert.strictEqual(svg.querySelectorAll('circle').length, 1);
    assert.strictEqual(svg.querySelectorAll('path').length, 2);
    const [title, reason] = LINE.split('\n');
    assert.strictEqual(n.querySelector('.stopped-title').textContent, title);
    assert.strictEqual(n.querySelector('.stopped-reason').textContent, reason);
    assert.strictEqual(n.querySelector('.stopped-detail'), null, 'no detail when there is none');
  });

  test('a detail holds everything after the reason, its own newlines included', () => {
    const n = noticeBuilder()('T\nR\nfirst detail line\nsecond detail line');
    assert.strictEqual(n.querySelector('.stopped-detail').textContent, 'first detail line\nsecond detail line');
    assert.strictEqual(noticeBuilder()('T\nR\n').querySelector('.stopped-detail'), null, 'an empty remainder adds nothing');
  });

  test('markup in the words is shown as words', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const n = noticeBuilder()(`${hostile} stopped before finishing\nreason\n${hostile}`);
    assert.strictEqual(n.querySelector('img'), null, 'no image is made');
    assert.strictEqual(n.querySelector('.stopped-title').textContent, `${hostile} stopped before finishing`);
    assert.strictEqual(n.querySelector('.stopped-detail').textContent, hostile);
  });
});

describe('a line that arrives while the page is open', () => {
  let a;
  let b;
  beforeEach(() => {
    messagesEl().innerHTML = '';
    a = { id: 'convo-a', agentId: 'chief-of-staff', messages: [{ role: 'user', content: 'write the post' }] };
    b = { id: 'convo-b', agentId: 'chief-of-staff', messages: [{ role: 'user', content: 'something else' }] };
    global.conversations = [a, b];
  });

  test('for the conversation on screen: drawn once, kept, and drawn again on coming back to it', () => {
    global.activeConversation = a;
    routingHelper()(LINE, 'convo-a');
    assert.strictEqual(notices().length, 1);
    assert.deepStrictEqual(a.messages.slice(-1), [{ role: 'system', type: 'delegation', content: LINE }]);
    messagesEl().innerHTML = '';
    convos.replayConversationInto(messagesEl(), a);
    assert.strictEqual(notices().length, 1, 'drawn again from what was kept');
  });

  test('for another conversation: not drawn here, kept with its own, and drawn when that one is opened', () => {
    global.activeConversation = b;
    routingHelper()(LINE, 'convo-a');
    assert.strictEqual(notices().length, 0);
    assert.strictEqual(b.messages.length, 1, 'nothing kept with the one on screen');
    assert.deepStrictEqual(a.messages.slice(-1), [{ role: 'system', type: 'delegation', content: LINE }]);
    convos.replayConversationInto(messagesEl(), a);
    assert.strictEqual(notices().length, 1);
  });

  test('for a conversation whose history is not loaded yet: not kept, so the history brings it', () => {
    global.activeConversation = b;
    const unloaded = { id: 'convo-c', agentId: 'chief-of-staff', persisted: true, messages: [] };
    global.conversations.push(unloaded);
    routingHelper()(LINE, 'convo-c');
    assert.deepStrictEqual(unloaded.messages, []);
  });
});

describe('the history after a reload', () => {
  test('draws a stored line as the notice, keeps it unchanged, and draws it again on coming back', () => {
    messagesEl().innerHTML = '';
    const stored = `${LINE}\nThe last output was <!-- RUNDOCK:COMPLETE -->`;
    const convo = { id: 'convo-h', agentId: 'chief-of-staff', agent: global.agents[0], messages: [] };
    global.conversations = [convo];
    global.activeConversation = convo;
    noticeBuilder();
    chat.renderSessionHistory({ conversationId: 'convo-h', hasMore: false, totalCount: 2, messages: [
      { role: 'user', content: 'write the post' },
      { role: 'system', type: 'delegation', content: stored, agentId: null },
    ] });
    const drawn = notices();
    assert.strictEqual(drawn.length, 1, 'one notice');
    assert.ok(drawn[0].classList.contains('history-msg'), 'drawn as history');
    const kept = convo.messages.filter((m) => m.type === 'delegation');
    assert.deepStrictEqual(kept.map((m) => [m.role, m.content]), [['system', stored]], 'kept with its words unchanged');

    messagesEl().innerHTML = '';
    convos.replayConversationInto(messagesEl(), convo);
    const again = notices();
    assert.strictEqual(again.length, 1, 'drawn again on coming back');
    assert.strictEqual(again[0].querySelector('.stopped-detail').textContent, 'The last output was <!-- RUNDOCK:COMPLETE -->');
  });
});
