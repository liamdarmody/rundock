'use strict';
// SEVERAL REPLIES IN ONE REQUEST, EACH WITH ITS OWN LINE.
//
// While a lead's helpers run, the lead replies, and each helper that ends
// wakes it for another turn with its own result. The page draws each of
// those replies with the time, usage and steps its own result reported,
// never the first turn's and never a sum.
//
// Passes on a server without helpers too, by design: the page's reducer
// already handles each result on its own. The sibling that shares this setup
// and fails there is the server test "with helpers on, each helper that ends
// wakes the lead for a turn with its own time, usage and steps".
//
// Measured on the document through the real reducer, the real effect
// executors cut from app.js and the real view functions, the pattern of
// turn-used-view.test.js.
const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const sj = require('../fixtures/stream-json.js');

const ROOT = path.join(__dirname, '..', '..');
const APP = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

const CONVO = '1764000000000';
const START = 1764000000000;
const WAKE = START + 30000;
const LIVE = { isActive: true, viewingChat: true, convoExists: true, convoInWorkspace: true, delegationTriggered: false };
const FIRST_USAGE = { input_tokens: 18240, output_tokens: 3905 };
const SECOND_USAGE = { input_tokens: 2210, output_tokens: 412 };

const cut = (start, end, label) => {
  const at = APP.indexOf(start);
  assert.ok(at > -1, `${label} found in app.js`);
  const stop = APP.indexOf(end, at);
  assert.ok(stop > -1, `${label} ends in app.js`);
  return APP.slice(at, stop + end.length);
};

let cs;
let executeEffects;
let states = {};

before(() => {
  const dom = new JSDOM('<!doctype html><html><body><div id="messages"></div><div id="chat-status"></div><input id="msg-input">'
    + '<button id="send-btn"></button><span id="chat-agent-label"></span><span id="chat-agent-avatar"></span>'
    + '<input id="chat-title-input"><div id="chat-title"></div><div id="convo-list"></div></body></html>');
  global.window = dom.window;
  global.document = dom.window.document;
  dom.window.Element.prototype.scrollIntoView = function () {};
  global.esc = (t) => { const d = document.createElement('div'); d.textContent = String(t); return d.innerHTML; };
  global.escAttr = (t) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  global.formatMd = (t) => global.esc(t);
  global.userScrolledUp = false;
  global.renderConvoList = () => {};
  global.tryMessageAnchor = () => {};
  global.setActiveAgentPill = () => {};
  global.renderPendingPermissionCards = () => {};
  global.agents = [{ id: 'wren', displayName: 'Wren', type: 'specialist' }];
  global.RundockChatMarkup = require(path.join(ROOT, 'public', 'chat-markup.js'));
  global.RundockMarkers = require(path.join(ROOT, 'public', 'markers.js'));
  global.RundockPermissions = require(path.join(ROOT, 'public', 'permissions.js'));
  global.stripRundockMarkers = (t) => global.RundockMarkers.stripMarkers(String(t || ''));
  global.restoredActiveAgentId = require(path.join(ROOT, 'public', 'delegation-restore.js')).restoredActiveAgentId;
  global.pendingPermissions = new Map();
  global.pendingPermissionsByConvo = new Map();
  global.unread = { markMessage() {}, markPermission() {} };
  global.updateUnreadBadge = () => {};
  global.stripMd = (t) => String(t);
  global.addSystemMsgToConvo = () => {};
  cs = require(path.join(ROOT, 'public', 'conversation-state.js'));
  global.RundockConversationState = cs;
  global.getConvoState = (id) => states[id] || (states[id] = Object.assign(cs.createState(), { currentStreamingMsg: null }));
  const chat = require(path.join(ROOT, 'public', 'views', 'chat.js'));
  Object.assign(global, chat);
  try { Object.assign(global, require(path.join(ROOT, 'public', 'views', 'composer.js'))); } catch (e) {
    if (!(e && e.code === 'MODULE_NOT_FOUND' && /composer\.js/.test(String(e.message)))) throw e;
  }
  global.finishProcessing = (id) => {
    const s = global.getConvoState(id);
    s.isProcessing = false;
    s.currentStreamingMsg = null;
  };
  chat.cardArming.ms = 0;
  const table = new Function(`${cut('const EFFECT_EXECUTORS = {', '\n};', 'EFFECT_EXECUTORS')} return EFFECT_EXECUTORS;`)();
  executeEffects = new Function('EFFECT_EXECUTORS', `${cut('function executeEffects(convoId, effects) {', '\n}', 'executeEffects()')} return executeEffects;`)(table);
});

beforeEach(() => {
  document.getElementById('messages').replaceChildren();
  states = {};
  const convo = { id: CONVO, agentId: 'wren', agent: global.agents[0], title: 'Wren', messages: [] };
  global.conversations = [convo];
  global.activeConversation = convo;
});

// One message through the reducer and the executors, as app.js does it.
function feed(message) {
  const r = cs.reduce(global.getConvoState(CONVO), { _conversationId: CONVO, ...message }, LIVE);
  states[CONVO] = r.state;
  executeEffects(CONVO, r.effects);
  return r.effects;
}
const steps = (from, n) => Array.from({ length: n }, (_, i) => ({ tool: 'Read', time: from + 1000 * (i + 1), arg: '' }));
// One turn of the lead's: its words streamed, then its result.
function turn(text, fields) {
  feed(sj.contentBlockStartText());
  feed(sj.textDelta(text));
  const effects = feed(sj.result({ text, extra: fields }));
  const drawn = effects.filter((e) => e.type === 'finalize-stream-bubble' || e.type === 'append-final-message');
  assert.strictEqual(drawn.length, 1, `one reply is drawn for "${text}"`);
  return drawn[0];
}
const lines = () => [...document.querySelectorAll('#messages > .msg.msg-agent > div.turn-used span.turn-used-line')]
  .map((el) => el.textContent.replace(/\s+/g, ' ').trim());

test('two results from one request each give the page their own time, usage and steps', () => {
  const first = turn('Started two explorers.', {
    duration_ms: 24600, usage: FIRST_USAGE, _turnStartTime: START, _toolCalls: steps(START, 2),
  });
  const second = turn('The first explorer reported back.', {
    duration_ms: 4300, usage: SECOND_USAGE, _turnStartTime: WAKE, _toolCalls: steps(WAKE, 1),
  });

  assert.strictEqual(first.durationMs, 24600);
  assert.deepStrictEqual(first.usage, FIRST_USAGE);
  assert.strictEqual(first.turnStartTime, START);
  assert.strictEqual(first.toolCalls.length, 2);
  assert.strictEqual(second.durationMs, 4300);
  assert.deepStrictEqual(second.usage, SECOND_USAGE);
  assert.strictEqual(second.turnStartTime, WAKE);
  assert.strictEqual(second.toolCalls.length, 1);

  assert.deepStrictEqual(lines(), ['2 steps · Worked 24 s', '1 step · Worked 4 s'], 'each reply carries its own line');
});
