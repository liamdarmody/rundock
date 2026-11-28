'use strict';
// THE ALLOW CARD AND "ASKED BY", ON THE PAGE.
//
// A lead's first batch of teammates asks first, on a card that names each
// teammate and its task and says how fast the plan's allowance would go, with
// Allow and Deny and no standing answer. A card a helper raised says which
// helper asked and which lead it helps. Each is drawn through the real
// renderPermissionCard, and every name and task is given holding markup, so a
// value drawn as anything but text shows.
const { test, before, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const WREN = { id: 'wren', displayName: 'Wren', colour: '#2f7d5b', icon: 'W' };
const ASH = { id: 'ash', displayName: 'Ash', colour: '#7a4bd1', icon: 'A' };
const ROWAN = { id: 'example-research-lead', displayName: 'Rowan', colour: '#b0632a', icon: 'R' };
const FERN = { id: 'fern', displayName: 'Fern', colour: '#2a6fb0', icon: 'F' };
const MARKUP = '<img src=x onerror="window.pwned=1"><b>bold</b>';
const CONVO = 'c-allow';

let chat;
let sent;
let states;
before(() => {
  const dom = new JSDOM('<!doctype html><html><body><div id="messages"></div></body></html>');
  global.window = dom.window;
  global.document = dom.window.document;
  global.pendingPermissions = new Map();
  global.pendingPermissionsByConvo = new Map();
  global.userScrolledUp = false;
  global.esc = (t) => { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; };
  global.escAttr = (t) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  global.RundockPermissions = require(path.join(ROOT, 'public', 'permissions.js'));
  global.RundockChatMarkup = require(path.join(ROOT, 'public', 'chat-markup.js'));
  global.RundockRoomWords = require(path.join(ROOT, 'public', 'room-words.js'));
  try { global.RundockRoomPanel = require(path.join(ROOT, 'public', 'room-panel.js')); } catch (e) {
    if (!(e && e.code === 'MODULE_NOT_FOUND')) throw e;
  }
  global.serverPlatform = 'darwin';
  global.workspaceMode = 'code';
  global.updateUnreadBadge = () => {};
  global.renderConvoList = () => {};
  global.getConvoState = (id) => (states[id] = states[id] || { currentStreamingMsg: null });
  chat = require(path.join(ROOT, 'public', 'views', 'chat.js'));
});
beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  document.getElementById('messages').replaceChildren();
  global.pendingPermissions.clear();
  global.pendingPermissionsByConvo.clear();
  global.agents = [WREN, ASH, ROWAN, FERN, { id: 'evil', displayName: MARKUP, colour: '#123456', icon: 'E' }];
  global.activeConversation = { id: CONVO, agentId: 'wren' };
  global.conversations = [];
  global.unread = { markPermission() {}, resolvePermission() {} };
  states = {};
  sent = [];
  global.ws = { readyState: 1, send: (s) => sent.push(JSON.parse(s)) };
  chat.cardArming.ms = 0;
});
afterEach(() => { mock.timers.reset(); });

let seq = 0;
// A first batch's card as the server sends it, and as it replays it.
function allowRequest(helpers, others = 0, extra = {}) {
  return {
    type: 'control_request', request_id: `allow-${++seq}`,
    request: { subtype: 'can_use_tool', tool_name: 'Agent', input: {}, helpers, helper_others: others },
    _conversationId: CONVO, _agent: 'wren', ...extra,
  };
}
function helperRequest(helper, lead = 'wren') {
  return {
    type: 'control_request', request_id: `helper-${++seq}`,
    request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'node tools/build.js' } },
    _conversationId: CONVO, _agent: lead, _helper: helper,
  };
}
function draw(d) {
  chat.renderPermissionCard(d, d._conversationId);
  const card = document.getElementById(`perm-${d.request_id}`);
  assert.ok(card, 'the card is drawn');
  return card;
}
function one(rootEl, selector, label) {
  const found = rootEl.querySelector(selector);
  assert.ok(found, `${label} is drawn`);
  return found;
}
const text = (el) => el.textContent.replace(/\s+/g, ' ').trim();
const actions = (card) => [...card.querySelectorAll('[data-perm-action]')].map((b) => b.getAttribute('data-perm-action'));
const lines = (card) => [...card.querySelectorAll('.allow-helper')];

// Rows already running in the conversation, as a helpers_changed draws them.
function running(convo, rows) {
  assert.ok(global.RundockRoomPanel, 'public/room-panel.js exists');
  global.RundockRoomPanel.changed(convo, { type: 'helpers_changed', _conversationId: convo, agentId: 'wren', helpers: rows, most: {} });
}

test('a first batch of two teammates is the Allow card: its title, a line each with avatar, name and task, the rate line, then Allow and Deny', () => {
  const card = draw(allowRequest([{ agent: 'ash', task: 'Check the October numbers' }, { agent: 'example-research-lead', task: 'Draft the summary' }]));
  assert.strictEqual(text(one(card, '.permission-summary', 'the title')), 'Wren wants to start 2 teammates');
  assert.deepStrictEqual(lines(card).map((l) => [one(l, '.avatar', 'an avatar').getAttribute('data-icon'), text(one(l, '.allow-helper-name', 'a name')), text(one(l, '.allow-helper-task', 'a task'))]),
    [['A', 'Ash', 'Check the October numbers'], ['R', 'Rowan', 'Draft the summary']]);
  assert.strictEqual(text(one(card, '.allow-rate', 'the rate line')),
    'Ash and Rowan work at the same time, so your plan\'s allowance is used up to three times as fast while they work.');
  assert.deepStrictEqual(actions(card), ['allow', 'deny'], 'Allow then Deny, and no Always allow');
  const order = [...card.querySelectorAll('.permission-summary, .allow-helper, .allow-rate, .permission-actions')].map((e) => e.className);
  assert.deepStrictEqual(order, ['permission-summary', 'allow-helper', 'allow-helper', 'allow-rate', 'permission-actions']);
});

test('the Allow card for one teammate: "Wren wants to start Rowan"', () => {
  const card = draw(allowRequest([{ agent: 'example-research-lead', task: 'Draft the summary' }]));
  assert.strictEqual(text(one(card, '.permission-summary', 'the title')), 'Wren wants to start Rowan');
  assert.strictEqual(text(one(card, '.allow-rate', 'the rate line')),
    'Rowan works while Wren carries on, so your plan\'s allowance is used up to twice as fast while Rowan works.');
});

test('the rate line counts the teammates, the helpers beside them and the rows already running, plus one', () => {
  running('c-allow-running', [{ toolUseId: 'r1', agent: 'Explore', kind: 'builtin', task: 'Look', state: 'running', step: null, batch: 'r1', file: null }]);
  const card = draw(allowRequest([{ agent: 'ash', task: 'One' }, { agent: 'example-research-lead', task: 'Two' }], 1, { _conversationId: 'c-allow-running' }));
  assert.strictEqual(text(one(card, '.allow-rate', 'the rate line')),
    'Ash, Rowan and Wren\'s helper work at the same time, so your plan\'s allowance is used up to five times as fast while they work.');
});

test('the rate line is never more than six times, and more than five teammates read frame 12\'s line', () => {
  const six = ['ash', 'example-research-lead', 'ash', 'example-research-lead', 'ash', 'example-research-lead'].map((agent, i) => ({ agent, task: `Part ${i}` }));
  const card = draw(allowRequest(six));
  assert.strictEqual(text(one(card, '.allow-rate', 'the rate line')),
    'Up to five of these teammates work at the same time, so your plan\'s allowance is used up to six times as fast while they work.');
  assert.strictEqual(lines(card).length, 6);
});

test('the Allow card\'s names and tasks holding markup are drawn as text', () => {
  const card = draw(allowRequest([{ agent: 'evil', task: MARKUP }]));
  assert.strictEqual(card.querySelector('.allow-helpers img, .allow-helpers b, .permission-summary img'), null, 'no element made from a value');
  assert.strictEqual(text(one(card, '.allow-helper-task', 'the task')), MARKUP);
  assert.strictEqual(text(one(card, '.allow-helper-name', 'the name')), MARKUP);
  assert.strictEqual(text(one(card, '.permission-summary', 'the title')), `Wren wants to start ${MARKUP}`);
  assert.strictEqual(global.window.pwned, undefined);
});

test('Allow and Deny answer as any card does, and the card waits before taking a click and keeps its risk outline', () => {
  const ordinary = draw({ type: 'control_request', request_id: `plain-${++seq}`, request: { subtype: 'can_use_tool', tool_name: 'Agent', input: {} }, _conversationId: CONVO, _agent: 'wren' });
  const risk = [...one(ordinary, '.permission-card', 'the card').classList].find((c) => c.startsWith('risk-'));
  document.getElementById('messages').replaceChildren();
  chat.cardArming.ms = 500;
  const d = allowRequest([{ agent: 'ash', task: 'One' }, { agent: 'example-research-lead', task: 'Two' }]);
  const card = draw(d);
  assert.deepStrictEqual(actions(card), ['allow', 'deny'], 'Allow then Deny');
  assert.ok(one(card, '.permission-card', 'the card').classList.contains(risk), `the outline keeps its risk color, ${risk}`);
  const allow = one(card, '[data-perm-action="allow"]', 'Allow');
  assert.strictEqual(allow.getAttribute('aria-disabled'), 'true', 'it waits as it appears');
  allow.click();
  assert.deepStrictEqual(sent.filter((m) => m.type === 'permission_response'), [], 'a click while it waits sends nothing');
  mock.timers.tick(500);
  allow.click();
  assert.deepStrictEqual(sent.filter((m) => m.type === 'permission_response').map((m) => [m.requestId, m.allow]), [[d.request_id, true]]);
  assert.deepStrictEqual(actions(card), [], 'answered');
  const denied = draw(allowRequest([{ agent: 'ash', task: 'One' }]));
  mock.timers.tick(500);
  one(denied, '[data-perm-action="deny"]', 'Deny').click();
  assert.deepStrictEqual(sent.filter((m) => m.type === 'permission_response').map((m) => m.allow), [true, false]);
});

test('the Allow card replayed on reconnect is drawn the same way', () => {
  const first = allowRequest([{ agent: 'ash', task: 'One' }, { agent: 'example-research-lead', task: 'Two' }], 1);
  const drawn = draw(first).outerHTML;
  document.getElementById('messages').replaceChildren();
  // The replay as the server builds it: the request's fields in its own order.
  const replay = {
    type: 'control_request', request_id: first.request_id,
    request: { subtype: 'can_use_tool', tool_name: 'Agent', input: {}, helpers: first.request.helpers, helper_others: 1 },
    _conversationId: CONVO, _agent: 'wren',
  };
  assert.strictEqual(draw(replay).outerHTML, drawn);
  assert.strictEqual(text(one(document, '.permission-summary', 'the title')), 'Wren wants to start 2 teammates');
});

const ASKED = [
  ['a teammate helping', { agentId: 'agent-1', agentType: 'ash' }, 'wren', 'Asked by Ash, helping Wren', 'avatar'],
  ['a helper outside the team', { agentId: 'agent-2', agentType: 'Explore' }, 'wren', 'Asked by Search helper, helping Wren', 'bolt'],
  ['a helper of a made-up type', { agentId: 'agent-3', agentType: MARKUP }, 'wren', 'Asked by Helper, helping Wren', 'bolt'],
  ['a Codex helper', { agentId: 'thread-1', agentType: 'rates', runtime: 'codex' }, 'fern', 'Asked by rates, helping Fern', 'bolt'],
];
for (const [what, helper, lead, said, icon] of ASKED) {
  test(`a card ${what} raised reads "${said}" after its ${icon === 'bolt' ? 'bolt' : 'avatar'}`, () => {
    const card = draw(helperRequest(helper, lead));
    const origins = card.querySelectorAll('.permission-origin');
    assert.strictEqual(origins.length, 1, 'one line saying who asked');
    assert.strictEqual(text(origins[0]), said);
    if (icon === 'bolt') {
      const bolt = one(origins[0], 'svg', 'the bolt');
      assert.deepStrictEqual([bolt.getAttribute('fill'), bolt.getAttribute('stroke-width')], ['none', '1.8']);
      assert.strictEqual(origins[0].querySelector('.avatar'), null);
    } else {
      assert.strictEqual(one(origins[0], '.avatar', 'the avatar').getAttribute('data-icon'), 'A');
    }
  });
}

test('a Codex helper\'s nickname holding markup is drawn as text', () => {
  const card = draw(helperRequest({ agentId: 'thread-2', agentType: MARKUP, runtime: 'codex' }, 'fern'));
  const origin = one(card, '.permission-origin', 'the line');
  assert.strictEqual(origin.querySelector('img, b'), null, 'no element made from a value');
  assert.strictEqual(text(origin), `Asked by ${MARKUP}, helping Fern`);
});

test('a card with no _helper still reads "Asked by Wren", beside a helper\'s card that names the helper', () => {
  const helpers = draw(helperRequest({ agentId: 'agent-4', agentType: 'Plan' }));
  assert.strictEqual(text(one(helpers, '.permission-origin', 'the helper\'s line')), 'Asked by Planning helper, helping Wren');
  const card = draw({ type: 'control_request', request_id: `own-${++seq}`, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } }, _conversationId: CONVO, _agent: 'wren' });
  assert.strictEqual(text(one(card, '.permission-origin', 'the line')), 'Asked by Wren');
  assert.ok(one(card, '.permission-origin', 'the line').querySelector('.avatar'), 'with Wren\'s avatar');
  assert.ok(actions(card).includes('allow'));
});

test('a helper\'s card replayed on reconnect is drawn the same way', () => {
  const first = helperRequest({ agentId: 'thread-3', agentType: 'rates', runtime: 'codex' }, 'fern');
  const drawn = draw(first).outerHTML;
  document.getElementById('messages').replaceChildren();
  const replay = {
    type: 'control_request', request_id: first.request_id, request: first.request,
    _conversationId: CONVO, _agent: 'fern', _helper: { agentId: 'thread-3', agentType: 'rates', runtime: 'codex' },
  };
  assert.strictEqual(draw(replay).outerHTML, drawn);
  assert.strictEqual(text(one(document, '.permission-origin', 'the line')), 'Asked by rates, helping Fern');
});
