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
  // Guarded: a tree without the composer has a setupChat that never calls it.
  try { Object.assign(global, require(path.join(ROOT, 'public', 'views', 'composer.js'))); } catch (e) {
    if (!(e && e.code === 'MODULE_NOT_FOUND' && /composer\.js/.test(String(e.message)))) throw e;
  }
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

// The page's own dispatch, cut from app.js and run as it ships: the whole
// handle(), getConvoState, the effect runner and the full executor table, with
// the routing helper above, the real reducer and the view's notice. Each
// function and the table is cut from the start of its declaration to the first
// brace that closes at column zero (the reply set to its own close), and fails
// here by name when it is renamed or gone.
function pageDispatch() {
  const cut = (start, end, label) => {
    const at = APP.indexOf(start);
    assert.ok(at > -1, `app.js no longer carries ${label}`);
    const stop = APP.indexOf(end, at);
    assert.ok(stop > -1, `${label} has no end in app.js`);
    return APP.slice(at, stop + end.length);
  };
  const replies = cut('const EXTENSIONS_PAGE_REPLIES = new Set(', ']);', 'EXTENSIONS_PAGE_REPLIES');
  const handleSrc = cut('function handle(d) {', '\n}', 'handle()');
  assert.ok(handleSrc.includes("if(d.subtype==='delegate_stopped' && convoId) {"), 'handle() no longer dispatches delegate_stopped');
  const stateSrc = cut('function getConvoState(convoId) {', '\n}', 'getConvoState()');
  const tableSrc = cut('const EFFECT_EXECUTORS = {', '\n};', 'EFFECT_EXECUTORS');
  const runSrc = cut('function executeEffects(convoId, effects) {', '\n}', 'executeEffects()');
  /* eslint-disable no-new-func */
  const table = new Function('addDelegateStoppedToConvo', `${tableSrc} return EFFECT_EXECUTORS;`)(routingHelper());
  assert.strictEqual(typeof table['show-delegate-stopped'], 'function', 'the executor table runs show-delegate-stopped');
  const executeEffects = new Function('EFFECT_EXECUTORS', `${runSrc} return executeEffects;`)(table);
  const convoState = {};
  const getConvoState = new Function('convoState', 'RundockConversationState', `${stateSrc} return getConvoState;`)(convoState, cs);
  const handle = new Function('EXTENSIONS_PAGE_REPLIES', 'RundockConversationState', 'convoState', 'getConvoState', 'executeEffects',
    `${handleSrc} return handle;`)(new Function(`${replies} return EXTENSIONS_PAGE_REPLIES;`)(), cs, convoState, getConvoState, executeEffects);
  /* eslint-enable no-new-func */
  return handle;
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

describe('the line handed to the page\'s own dispatch', () => {
  let a;
  let b;
  const line = (extra) => ({ type: 'system', subtype: 'delegate_stopped', _conversationId: 'convo-a', content: LINE, ...extra });
  beforeEach(() => {
    messagesEl().innerHTML = '';
    a = { id: 'convo-a', agentId: 'chief-of-staff', messages: [{ role: 'user', content: 'write the post' }] };
    b = { id: 'convo-b', agentId: 'chief-of-staff', messages: [{ role: 'user', content: 'something else' }] };
    global.conversations = [a, b];
    global.activeConversation = a;
  });

  test('the server\'s line draws one notice in the conversation on screen and keeps one row with it', () => {
    pageDispatch()(line());
    const drawn = notices();
    assert.strictEqual(drawn.length, 1, 'exactly one notice is drawn');
    assert.strictEqual(drawn[0].querySelector('.stopped-title').textContent, LINE.split('\n')[0], 'with the line\'s words');
    assert.deepStrictEqual(a.messages.slice(1), [{ role: 'system', type: 'delegation', content: LINE }],
      'one row is kept with that conversation');
    assert.strictEqual(b.messages.length, 1, 'and nothing with another');
  });

  test('the same line with a process id draws nothing and keeps nothing', () => {
    const handle = pageDispatch();
    for (const pid of ['p1', null]) {
      handle(line({ _processId: pid }));
      assert.strictEqual(notices().length, 0, `nothing drawn for process id ${JSON.stringify(pid)}`);
      assert.deepStrictEqual(a.messages, [{ role: 'user', content: 'write the post' }], `nothing kept for process id ${JSON.stringify(pid)}`);
    }
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
