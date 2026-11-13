'use strict';
// The line a person reads about an agent or skill change, on the page: drawn
// in the conversation it belongs to, kept with that conversation so coming
// back to it draws it again, and drawn from the history after a reload.
//
// Measured on the document, through the real view functions (the pattern of
// replay-no-dividers.test.js) and the real routing helper lifted out of
// app.js (the pattern of marker-pill-routing.test.js).
const { test, describe, before, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const APP = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

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
  global.agents = [{ id: 'rundock-guide', displayName: 'Doc', type: 'platform' }];
  global.RundockChatMarkup = require(path.join(ROOT, 'public', 'chat-markup.js'));
  global.RundockMarkers = require(path.join(ROOT, 'public', 'markers.js'));
  global.stripRundockMarkers = (t) => global.RundockMarkers.stripMarkers(String(t || ''));
  global.restoredActiveAgentId = require(path.join(ROOT, 'public', 'delegation-restore.js')).restoredActiveAgentId;
  chat = require(path.join(ROOT, 'public', 'views', 'chat.js'));
  Object.assign(global, chat);
  convos = require(path.join(ROOT, 'public', 'views', 'conversations.js'));
});

// The routing helper, lifted out of app.js and run against these globals.
function routingHelper() {
  const at = APP.indexOf('function addSystemMsgToConvo');
  assert.ok(at > -1, 'the routing helper still exists in app.js');
  // eslint-disable-next-line no-new-func
  return new Function(`${APP.slice(at, APP.indexOf('\n}', at) + 2)}; return addSystemMsgToConvo;`)();
}

const drawn = () => [...document.getElementById('messages').querySelectorAll('.msg-system')].map((el) => el.textContent);
const LINE = 'Agent "helper" created';

describe('a line that arrives while the page is open', () => {
  let a;
  let b;
  beforeEach(() => {
    document.getElementById('messages').innerHTML = '';
    a = { id: 'convo-a', agentId: 'rundock-guide', messages: [{ role: 'user', content: 'make a helper' }, { role: 'agent', content: 'Made it.', agentId: 'rundock-guide' }] };
    b = { id: 'convo-b', agentId: 'rundock-guide', messages: [{ role: 'user', content: 'something else' }] };
    global.conversations = [a, b];
  });

  test('for another conversation: not drawn here, kept with its own conversation, and drawn when that one is opened', () => {
    global.activeConversation = b;
    routingHelper()(LINE, 'convo-a', false, true);
    assert.deepStrictEqual(drawn(), [], 'nothing is drawn in the conversation on screen');
    assert.deepStrictEqual(b.messages.map((m) => m.role), ['user'], 'nor kept with it');
    assert.deepStrictEqual(a.messages.slice(-1), [{ role: 'system', content: LINE }], 'it is kept with the conversation it belongs to');
    convos.replayConversationInto(document.getElementById('messages'), a);
    assert.deepStrictEqual(drawn(), [LINE], 'and opening that conversation draws it');
  });

  test('for the conversation on screen: drawn once, and drawn again on coming back to it', () => {
    global.activeConversation = a;
    routingHelper()(LINE, 'convo-a', false, true);
    assert.deepStrictEqual(drawn(), [LINE]);
    document.getElementById('messages').innerHTML = '';
    convos.replayConversationInto(document.getElementById('messages'), a);
    assert.deepStrictEqual(drawn(), [LINE]);
  });

  test('for a conversation whose history is not loaded yet: not kept, so the history load still runs and brings it', () => {
    global.activeConversation = b;
    const unloaded = { id: 'convo-c', agentId: 'rundock-guide', persisted: true, messages: [] };
    global.conversations.push(unloaded);
    routingHelper()(LINE, 'convo-c', false, true);
    assert.deepStrictEqual(unloaded.messages, []);
  });

  test('every agent and skill line the page is sent is kept this way', () => {
    for (const kind of ['agent_saved', 'skill_saved', 'agent_deleted', 'skill_deleted', 'agent_error', 'skill_error']) {
      const at = APP.indexOf(`case '${kind}':`);
      const body = APP.slice(at, APP.indexOf('break;', at));
      assert.match(body, /addSystemMsgToConvo\([^;]*?,\s*d\.conversationId,\s*false,\s*true\)/s, `${kind} keeps its line with its conversation`);
    }
  });
});

describe('the history after a reload', () => {
  test('draws a stored line as Rundock\'s line, in its place, and keeps it for coming back', () => {
    document.getElementById('messages').innerHTML = '';
    const convo = { id: 'convo-h', agentId: 'rundock-guide', agent: global.agents[0], messages: [] };
    global.conversations = [convo];
    global.activeConversation = convo;
    chat.renderSessionHistory({ conversationId: 'convo-h', hasMore: false, totalCount: 3, messages: [
      { role: 'user', content: 'make a helper' },
      { role: 'assistant', content: 'Made it.', agentId: 'rundock-guide' },
      { role: 'system', type: 'team', content: LINE },
    ] });
    const rows = [...document.getElementById('messages').children].map((el) => [el.className.split(' ')[0], el.textContent.includes(LINE)]);
    assert.deepStrictEqual(rows.slice(0, 3), [['msg', false], ['msg', false], ['msg-system', true]]);
    assert.deepStrictEqual(convo.messages.map((m) => [m.role, m.content]), [['user', 'make a helper'], ['agent', 'Made it.'], ['system', LINE]]);
  });
});
