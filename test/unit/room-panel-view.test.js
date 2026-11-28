'use strict';
// THE HELPERS PANEL, ON THE PAGE.
//
// While a lead's teammates and helpers work, each batch of them is a panel
// directly under the lead's message that started it: a title saying who
// started what, a line saying how fast the plan's allowance goes, and a row
// for each with who it is, its task, what it is doing now and Stop. Under the
// composer, a note says who still works and where a message goes while only
// helpers work. A helper's end that wakes the lead shows it replying again,
// and a pending card stays.
//
// Measured on the document through the real reducer, the effect executors and
// the message cases cut from app.js, and the real view functions, the pattern
// of helpers-several-results-view.test.js. Every value a helper or agent wrote
// is given here holding markup, so a value drawn as anything but text shows.
const { test, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const sj = require('../fixtures/stream-json.js');

const ROOT = path.join(__dirname, '..', '..');
const APP = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const CONVERSATIONS = fs.readFileSync(path.join(ROOT, 'public', 'views', 'conversations.js'), 'utf8');
const PANEL = path.join(ROOT, 'public', 'room-panel.js');

const CONVO = 'c-room';
const OTHER = 'c-other';
const PID = 'p-wren';
const LIVE = { isActive: true, viewingChat: true, convoExists: true, convoInWorkspace: true, delegationTriggered: false };
const WREN = { id: 'wren', displayName: 'Wren', colour: '#2f7d5b', icon: 'W', type: 'specialist' };
const ASH = { id: 'ash', displayName: 'Ash', colour: '#7a4bd1', icon: 'A', type: 'specialist' };
const ROWAN = { id: 'example-research-lead', displayName: 'Rowan', colour: '#b0632a', icon: 'R', type: 'specialist' };
const FERN = { id: 'fern', displayName: 'Fern', colour: '#2a6fb0', icon: 'F', type: 'specialist' };
const MARKUP = '<img src=x onerror="window.pwned=1"><b>bold</b>';
// A file's name holds no slash, so the whole of it is the name.
const FILE_MARKUP = '<img src=x onerror="window.pwned=1">.md';

const cutFrom = (src, file, start, end, label) => {
  const at = src.indexOf(start);
  assert.ok(at > -1, `${label} found in ${file}`);
  const stop = src.indexOf(end, at);
  assert.ok(stop > -1, `${label} ends in ${file}`);
  return src.slice(at, stop + end.length);
};
const cut = (start, end, label) => cutFrom(APP, 'app.js', start, end, label);

let cs;
let chat;
let executeEffects;
let states = {};
let sent = [];
let opened = [];
let tree = new Map();

before(() => {
  const dom = new JSDOM('<!doctype html><html><body><div id="messages"></div><div id="chat-status"></div>'
    + '<textarea id="msg-input" placeholder="Message Wren..."></textarea><button id="send-btn" title="Send message"></button>'
    + '<div id="composer-notice" aria-live="polite"></div><span id="chat-agent-label"></span><span id="chat-agent-avatar"></span>'
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
  global.agents = [WREN, ASH, ROWAN, FERN];
  global.RundockChatMarkup = require(path.join(ROOT, 'public', 'chat-markup.js'));
  global.RundockMarkers = require(path.join(ROOT, 'public', 'markers.js'));
  global.RundockPermissions = require(path.join(ROOT, 'public', 'permissions.js'));
  // Each page module is loaded only where it exists, so a page without one
  // fails a test on its assertion rather than in this hook.
  const words = path.join(ROOT, 'public', 'room-words.js');
  if (fs.existsSync(words)) global.RundockRoomWords = require(words);
  if (fs.existsSync(PANEL)) global.RundockRoomPanel = require(PANEL);
  global.stripRundockMarkers = (t) => global.RundockMarkers.stripMarkers(String(t || ''));
  global.restoredActiveAgentId = require(path.join(ROOT, 'public', 'delegation-restore.js')).restoredActiveAgentId;
  global.pendingPermissions = new Map();
  global.pendingPermissionsByConvo = new Map();
  global.unread = { markMessage() {}, markPermission() {}, resolvePermission() {} };
  global.updateUnreadBadge = () => {};
  global.updateWorkingBadge = () => {};
  global.persistConversation = () => {};
  global.formatTimeAgo = () => 'just now';
  global.agentLastActivity = {};
  global.workingConvos = new Set();
  global.currentView = 'chat';
  global.workspaceMode = 'code';
  global.serverPlatform = 'darwin';
  global.WebSocket = { OPEN: 1 };
  global.stripMd = (t) => String(t);
  global.addSystemMsgToConvo = () => {};
  global.treePathOf = (recorded) => tree.get(recorded) || null;
  global.openWorkspaceFilePath = (p) => opened.push(p);
  cs = require(path.join(ROOT, 'public', 'conversation-state.js'));
  global.RundockConversationState = cs;
  global.getConvoState = (id) => states[id] || (states[id] = Object.assign(cs.createState(), { currentStreamingMsg: null }));
  chat = require(path.join(ROOT, 'public', 'views', 'chat.js'));
  Object.assign(global, chat);
  Object.assign(global, require(path.join(ROOT, 'public', 'views', 'composer.js')));
  chat.cardArming.ms = 0;
  const table = new Function(`${cut('const EFFECT_EXECUTORS = {', '\n};', 'EFFECT_EXECUTORS')} return EFFECT_EXECUTORS;`)();
  executeEffects = new Function('EFFECT_EXECUTORS', `${cut('function executeEffects(convoId, effects) {', '\n}', 'executeEffects()')} return executeEffects;`)(table);
});

beforeEach(() => {
  document.getElementById('messages').replaceChildren();
  for (const id of ['helpers-note']) { const el = document.getElementById(id); if (el) el.remove(); }
  states = {};
  global.convoState = states;
  sent = [];
  opened = [];
  tree = new Map();
  global.ws = { readyState: 1, send: (s) => sent.push(JSON.parse(s)) };
  const convo = { id: CONVO, agentId: 'wren', agent: WREN, title: 'Wren', messages: [{ role: 'user', content: 'hello' }] };
  const fern = { id: OTHER, agentId: 'fern', agent: FERN, title: 'Fern', messages: [{ role: 'user', content: 'hello' }] };
  global.conversations = [convo, fern];
  global.activeConversation = convo;
  global.getConvoState(CONVO).activeProcessId = PID;
  const send = document.getElementById('send-btn');
  send.title = 'Send message';
  send.onclick = null;
  send.className = 'send-btn';
});

afterEach(() => {
  for (const s of Object.values(states)) if (s.processingTimeout) clearInterval(s.processingTimeout);
});

// Each test's conversation is its own, so no room outlives its test.
let seq = 0;
function fresh(agent = WREN) {
  const id = `c-room-${++seq}`;
  const convo = { id, agentId: agent.id, agent, title: agent.displayName, messages: [{ role: 'user', content: 'hello' }] };
  global.conversations.push(convo);
  global.activeConversation = convo;
  global.getConvoState(id).activeProcessId = PID;
  return id;
}

// One message through the reducer and the executors, as app.js does it.
function feed(convo, message) {
  const r = cs.reduce(global.getConvoState(convo), { _conversationId: convo, ...message }, LIVE);
  states[convo] = r.state;
  executeEffects(convo, r.effects);
  return r.effects;
}
// The message cases app.js adds, cut from it and run as it runs them.
function handle(d) {
  if (d.type === 'helpers_changed') {
    const body = cut("case 'helpers_changed':", 'break;', 'the helpers_changed case');
    return new Function('d', 'convoId', `switch (d.type) { ${body} }`)(d, d._conversationId);
  }
  if (d.type === 'system' && d.subtype === 'helpers_wake') {
    const body = cut("if(d.subtype==='helpers_wake'", '\n      }', 'the helpers_wake dispatch');
    return new Function('d', 'convoId', 'convoState', 'executeEffects', body)(d, d._conversationId, states, executeEffects);
  }
  return feed(d._conversationId, d);
}
function changed(convo, rows, most = {}, lead = 'wren') {
  handle({ type: 'helpers_changed', _conversationId: convo, agentId: lead, helpers: rows, most });
}
const row = (toolUseId, agent, kind, extra = {}) => ({
  toolUseId, agent, kind, task: kind === 'codex' ? null : `Look into ${agent}`, state: 'running', step: null, batch: 'b1', file: null, ...extra,
});
const mate = (id, agent, extra) => row(id, agent, 'teammate', extra);
const helper = (id, type, extra) => row(id, type, 'builtin', extra);
const codex = (id, nick, extra) => row(id, nick, 'codex', { role: null, capped: false, firstBatch: false, ...extra });

// The lead's words, streamed and finished, as one agent message.
function lead(convo, text) {
  feed(convo, sj.contentBlockStartText());
  feed(convo, sj.textDelta(text));
  feed(convo, sj.result({ text }));
}

function one(rootEl, selector, label) {
  const found = rootEl.querySelector(selector);
  assert.ok(found, `${label} is drawn`);
  return found;
}
const panels = () => [...document.querySelectorAll('#messages > .room-panel')];
function panel(batch = 'b1') {
  const found = panels().find((p) => p.getAttribute('data-batch') === batch);
  assert.ok(found, `a panel for batch ${batch}`);
  return found;
}
const title = (p = panel()) => one(p, '.room-title', 'the title').textContent;
const rate = (p = panel()) => one(p, '.room-rate', 'the rate line').textContent;
const rowEls = (p = panel()) => [...one(p, '.room-rows', 'the rows').children];
const text = (el) => el.textContent.replace(/\s+/g, ' ').trim();
const cell = (el, selector) => (el.querySelector(selector) ? el.querySelector(selector).textContent : null);
const noteText = () => {
  const note = document.getElementById('helpers-note');
  return note && !note.hidden ? note.textContent : '';
};
const agentMessages = () => [...document.querySelectorAll('#messages > .msg.msg-agent')].filter((m) => m.id !== 'thinking-indicator');

// ── Where the panel goes, and its title ─────────────────────────────────────

test('a batch\'s panel goes directly after the lead\'s streaming message and keeps its place as later messages arrive', () => {
  const convo = fresh();
  feed(convo, sj.contentBlockStartText());
  feed(convo, sj.textDelta('Starting two.'));
  const streaming = global.getConvoState(convo).currentStreamingMsg;
  assert.ok(streaming, 'the lead is streaming');
  changed(convo, [mate('t1', 'ash'), mate('t2', 'example-research-lead')]);
  assert.strictEqual(streaming.nextElementSibling, panel(), 'directly after the streaming message');
  feed(convo, sj.result({ text: 'Starting two.' }));
  lead(convo, 'Ash reported back.');
  assert.strictEqual(agentMessages()[0].nextElementSibling, panel(), 'still after the message that started it');
  assert.strictEqual(panel().nextElementSibling, agentMessages()[1], 'with the later message below it');
});

test('with no streaming message, a batch\'s panel goes after the last agent message', () => {
  const convo = fresh();
  lead(convo, 'First.');
  lead(convo, 'Second, starting a helper.');
  changed(convo, [helper('t1', 'Explore')]);
  assert.strictEqual(agentMessages()[1].nextElementSibling, panel());
  assert.strictEqual(panels().length, 1);
});

test('two batches are two panels, each after the message in the thread when its first row arrived', () => {
  const convo = fresh();
  lead(convo, 'One batch.');
  changed(convo, [helper('t1', 'Explore')]);
  lead(convo, 'Another batch.');
  changed(convo, [helper('t1', 'Explore'), helper('t2', 'Plan', { batch: 'b2' })]);
  assert.deepStrictEqual(panels().map((p) => p.getAttribute('data-batch')), ['b1', 'b2']);
  assert.strictEqual(agentMessages()[0].nextElementSibling, panel('b1'));
  assert.strictEqual(agentMessages()[1].nextElementSibling, panel('b2'));
});

test('a helpers_changed for another conversation draws nothing in this one', () => {
  const convo = fresh();
  lead(convo, 'Here.');
  changed(OTHER, [codex('f1', 'rates', { batch: 'turn-1' })], { 'turn-1': 1 }, 'fern');
  changed(convo, [helper('t1', 'Explore')]);
  assert.deepStrictEqual(panels().map((p) => p.getAttribute('data-batch')), ['b1'], 'only this conversation\'s batch');
});

const TITLES = [
  ['two teammates', WREN, [mate('t1', 'ash'), mate('t2', 'example-research-lead')], 'Wren started 2 teammates'],
  ['two teammates and a helper', WREN, [mate('t1', 'ash'), mate('t2', 'example-research-lead'), helper('t3', 'Explore')], 'Wren started 2 teammates and a helper'],
  ['two teammates and two helpers', WREN, [mate('t1', 'ash'), helper('t2', 'Explore'), mate('t3', 'example-research-lead'), helper('t4', 'Plan')], 'Wren started 2 teammates and 2 helpers'],
  ['two helpers', WREN, [helper('t1', 'Explore'), helper('t2', 'Plan')], 'Wren started 2 helpers'],
  ['a helper', WREN, [helper('t1', 'Explore')], 'Wren started a helper'],
  ['one teammate, by name', WREN, [mate('t1', 'example-research-lead')], 'Wren started Rowan'],
  ['one teammate and a helper', WREN, [mate('t1', 'example-research-lead'), helper('t2', 'Explore')], 'Wren started Rowan and a helper'],
  ['two helpers on Codex', FERN, [codex('f1', 'rates'), codex('f2', 'pipeline')], 'Fern started 2 helpers'],
  ['a helper on Codex', FERN, [codex('f1', 'rates')], 'Fern started a helper'],
];
for (const [what, by, rows, said] of TITLES) {
  test(`the title for ${what}: "${said}"`, () => {
    const convo = fresh(by);
    lead(convo, 'Starting.');
    changed(convo, rows, { b1: rows.length }, by.id);
    assert.strictEqual(title(), said);
  });
}

test('a capped row counts in the title', () => {
  const convo = fresh(FERN);
  lead(convo, 'Six.');
  const rows = ['rates', 'pipeline', 'deck', 'hooks', 'calendar'].map((n, i) => codex(`f${i}`, n));
  rows.push(codex('f5', 'inbox', { state: 'killed', capped: true }));
  changed(convo, rows, { b1: 5 }, 'fern');
  assert.strictEqual(title(), 'Fern started 6 helpers');
});

// ── The rows ───────────────────────────────────────────────────────────────

test('a teammate\'s row shows its avatar and name, then its task, then what it is doing, then Stop', () => {
  const convo = fresh();
  lead(convo, 'One.');
  changed(convo, [mate('t1', 'ash', { task: 'Check the October numbers' })]);
  const [r] = rowEls();
  const avatar = one(r, '.room-who .avatar', 'the avatar');
  assert.strictEqual(avatar.getAttribute('data-icon'), 'A');
  assert.strictEqual(r.querySelector('.room-who svg'), null, 'no bolt for a teammate');
  assert.deepStrictEqual([...r.children].map((c) => c.className), ['room-who', 'room-task', 'room-state', 'room-stop']);
  assert.deepStrictEqual([cell(r, '.room-name'), cell(r, '.room-task'), cell(r, '.room-state'), cell(r, '.room-stop')],
    ['Ash', 'Check the October numbers', 'Working', 'Stop']);
});

test('a helper outside the team shows the bolt, a stroked path and never an avatar, and its label from the closed map', () => {
  const convo = fresh();
  lead(convo, 'Many.');
  const types = ['Explore', 'Plan', 'web-fetch', 'general-purpose', undefined, 'claude', 'made-up', MARKUP];
  changed(convo, types.map((t, i) => helper(`t${i}`, t)));
  const rs = rowEls();
  assert.deepStrictEqual(rs.map((r) => cell(r, '.room-name')),
    ['Search helper', 'Planning helper', 'Web helper', 'Helper', 'Helper 2', 'Helper 3', 'Helper 4', 'Helper 5']);
  for (const r of rs) {
    const bolt = one(r, '.room-who svg', 'the bolt');
    assert.strictEqual(bolt.getAttribute('fill'), 'none');
    assert.strictEqual(bolt.getAttribute('stroke'), 'currentColor');
    assert.strictEqual(bolt.getAttribute('stroke-width'), '1.8');
    assert.strictEqual(r.querySelector('.avatar'), null);
  }
});

test('within a panel a repeated label takes its number: "Search helper 2", "Helper 2"', () => {
  const convo = fresh();
  lead(convo, 'Again.');
  changed(convo, [helper('t1', 'Explore'), helper('t2', 'general-purpose'), helper('t3', 'Explore'), helper('t4', 'general-purpose'), helper('t5', 'Explore')]);
  assert.deepStrictEqual(rowEls().map((r) => cell(r, '.room-name')), ['Search helper', 'Helper', 'Search helper 2', 'Helper 2', 'Search helper 3']);
});

test('a Codex row shows the bolt, its nickname and its role in smaller text, and no task line', () => {
  const convo = fresh(FERN);
  lead(convo, 'Rates.');
  changed(convo, [codex('f1', 'rates', { role: 'worker' }), codex('f2', 'pipeline')], {}, 'fern');
  const [rates, pipeline] = rowEls();
  one(rates, '.room-who svg', 'the bolt');
  assert.deepStrictEqual([cell(rates, '.room-name'), cell(rates, '.room-role'), cell(rates, '.room-task')], ['rates', 'worker', null]);
  assert.deepStrictEqual([cell(pipeline, '.room-name'), cell(pipeline, '.room-role')], ['pipeline', null], 'no role when Codex gives none');
  assert.strictEqual(one(rates, '.room-stop', 'Stop').getAttribute('aria-label'), 'Stop rates');
});

test('a task, a nickname, a role, a step and a file name holding markup are drawn as text', () => {
  const convo = fresh(FERN);
  lead(convo, 'Markup.');
  tree.set(`/ws/${FILE_MARKUP}`, FILE_MARKUP);
  changed(convo, [
    codex('f1', MARKUP, { role: MARKUP, step: { type: 'Read', detail: FILE_MARKUP } }),
    mate('t2', 'ash', { task: MARKUP, state: 'completed', file: `/ws/${FILE_MARKUP}` }),
  ], {}, 'fern');
  const p = panel();
  assert.strictEqual(p.querySelector('img'), null, 'no element made from a value');
  assert.strictEqual(p.querySelector('b'), null, 'no element made from a value');
  const [first, second] = rowEls(p);
  assert.deepStrictEqual([cell(first, '.room-name'), cell(first, '.room-role'), cell(first, '.room-state')], [MARKUP, MARKUP, `Working: reading ${FILE_MARKUP}`]);
  assert.deepStrictEqual([cell(second, '.room-task'), cell(second, '.room-state')], [MARKUP, `Done: ${FILE_MARKUP}`]);
  assert.strictEqual(one(second, 'button.room-file', 'the file link').textContent, FILE_MARKUP);
  assert.strictEqual(global.window.pwned, undefined);
});

const STATES = [
  ['a running row reading a file, frame 3b\'s', { step: { type: 'Read', detail: 'Content-Metrics-October.md' } }, 'Working: reading Content-Metrics-October.md'],
  ['a running row running a command', { step: { type: 'Bash', detail: null } }, 'Working: running a command'],
  ['a running row with no step', {}, 'Working'],
  ['a completed row with no file', { state: 'completed' }, 'Done'],
  ['a failed row', { state: 'failed' }, 'Stopped before finishing'],
  ['a killed row', { state: 'killed' }, 'Stopped before finishing'],
  ['a waiting row', { state: 'waiting' }, 'Waiting. Starts when one finishes'],
];
for (const [what, fields, said] of STATES) {
  test(`${what} reads "${said}"`, () => {
    const convo = fresh();
    lead(convo, 'One.');
    changed(convo, [helper('t1', 'Explore', fields)]);
    assert.strictEqual(cell(rowEls()[0], '.room-state'), said);
  });
}

test('a capped row reads "Stopped. At most five helpers run at once." and has no Stop', () => {
  const convo = fresh();
  lead(convo, 'Six.');
  const rows = Array.from({ length: 5 }, (_, i) => helper(`t${i}`, 'Explore'));
  rows.push(helper('t5', 'Explore', { state: 'killed', capped: true }));
  changed(convo, rows, { b1: 5 });
  const capped = rowEls()[5];
  assert.strictEqual(cell(capped, '.room-state'), 'Stopped. At most five helpers run at once.');
  assert.strictEqual(capped.querySelector('.room-stop'), null, 'no Stop');
  assert.ok(rowEls()[0].querySelector('.room-stop'), 'a running row beside it has Stop');
});

test('a completed row\'s file found in the tree reads "Done: <name>", linked, asked again at click time and opened through the tree\'s path', () => {
  const convo = fresh();
  lead(convo, 'Write it.');
  tree.set('/ws/out/report.md', 'out/report.md');
  changed(convo, [helper('t1', 'general-purpose', { state: 'completed', file: '/ws/out/report.md' })]);
  const state = one(rowEls()[0], '.room-state', 'the state');
  assert.strictEqual(state.textContent, 'Done: report.md');
  const link = one(state, 'button.room-file', 'the file link');
  assert.strictEqual(link.textContent, 'report.md');
  assert.strictEqual(link.getAttribute('type'), 'button');
  tree.set('/ws/out/report.md', 'out/report.md (now)');
  link.click();
  assert.deepStrictEqual(opened, ['out/report.md (now)'], 'what the tree says at click time is what opens');
});

test('a completed row\'s file the tree doesn\'t have is its name as plain text', () => {
  const convo = fresh();
  lead(convo, 'Write it.');
  changed(convo, [helper('t1', 'general-purpose', { state: 'completed', file: '/elsewhere/report.md' })]);
  const state = one(rowEls()[0], '.room-state', 'the state');
  assert.strictEqual(state.textContent, 'Done: report.md');
  assert.strictEqual(state.querySelector('button, a'), null, 'nothing to click');
});

test('a file that has left the tree by the time it is clicked opens nothing', () => {
  const convo = fresh();
  lead(convo, 'Write it.');
  tree.set('/ws/out/report.md', 'out/report.md');
  changed(convo, [helper('t1', 'general-purpose', { state: 'completed', file: '/ws/out/report.md' })]);
  const link = one(rowEls()[0], 'button.room-file', 'the file link');
  tree.delete('/ws/out/report.md');
  link.click();
  assert.deepStrictEqual(opened, []);
  assert.strictEqual(cell(rowEls()[0], '.room-state'), 'Done: report.md', 'the name stays');
});

test('a row that hasn\'t finished has Stop, a button named for the row, which sends stop_helper', () => {
  const convo = fresh();
  lead(convo, 'Two.');
  changed(convo, [mate('t1', 'ash'), helper('t2', 'Explore', { state: 'waiting' }), helper('t3', 'Plan', { state: 'completed' })]);
  const stops = rowEls().map((r) => r.querySelector('.room-stop'));
  assert.strictEqual(stops[2], null, 'a finished row has none');
  assert.deepStrictEqual(stops.slice(0, 2).map((b) => [b.textContent, b.getAttribute('type'), b.getAttribute('aria-label')]),
    [['Stop', 'button', 'Stop Ash'], ['Stop', 'button', 'Stop Search helper']]);
  stops[1].click();
  assert.deepStrictEqual(sent.filter((m) => m.type === 'stop_helper'), [{ type: 'stop_helper', conversationId: convo, toolUseId: 't2' }]);
});

test('while any row runs or waits the title line has "Stop all", which sends cancel, and it is gone once none does', () => {
  const convo = fresh();
  lead(convo, 'Two.');
  changed(convo, [helper('t1', 'Explore'), helper('t2', 'Plan', { state: 'waiting' })]);
  const head = one(panel(), '.room-head', 'the title line');
  const stopAll = one(head, 'button.room-stop-all', 'Stop all');
  assert.deepStrictEqual([stopAll.textContent, stopAll.getAttribute('type')], ['Stop all', 'button']);
  stopAll.click();
  assert.deepStrictEqual(sent.filter((m) => m.type === 'cancel'), [{ type: 'cancel', conversationId: convo }]);
  changed(convo, [helper('t1', 'Explore', { state: 'completed' }), helper('t2', 'Plan', { state: 'running' })]);
  assert.ok(head.querySelector('.room-stop-all'), 'still there while one runs');
  changed(convo, [helper('t1', 'Explore', { state: 'completed' }), helper('t2', 'Plan', { state: 'failed' })]);
  assert.strictEqual(head.querySelector('.room-stop-all'), null, 'gone once none runs or waits');
  assert.strictEqual(title(), 'Wren started 2 helpers', 'the title stays');
});

test('the rows are a polite live region, and a row that hasn\'t changed keeps its element', () => {
  const convo = fresh();
  lead(convo, 'Two.');
  changed(convo, [helper('t1', 'Explore'), helper('t2', 'Plan')]);
  const box = one(panel(), '.room-rows', 'the rows');
  assert.strictEqual(box.getAttribute('aria-live'), 'polite');
  const [first, second] = rowEls();
  changed(convo, [helper('t1', 'Explore', { step: { type: 'Grep', detail: null } }), helper('t2', 'Plan')]);
  assert.notStrictEqual(rowEls()[0], first, 'the changed row is drawn again');
  assert.strictEqual(cell(rowEls()[0], '.room-state'), 'Working: searching the workspace');
  assert.strictEqual(rowEls()[1], second, 'the unchanged row is left alone');
});

test('Codex\'s first batch shows its notice above its rows, a capped row counted', () => {
  const convo = fresh(FERN);
  lead(convo, 'Three.');
  changed(convo, [codex('f1', 'rates', { firstBatch: true }), codex('f2', 'pipeline', { firstBatch: true }),
    codex('f3', 'deck', { firstBatch: true, state: 'killed', capped: true })], {}, 'fern');
  const p = panel();
  const notice = one(p, '.room-notice', 'the notice');
  assert.strictEqual(notice.hidden, false);
  assert.strictEqual(notice.textContent, 'Fern started 3 helpers. Codex starts helpers straight away, so this wasn\'t asked first. Stop any you don\'t want.');
  const order = [...p.children];
  assert.ok(order.indexOf(notice) < order.indexOf(one(p, '.room-rows', 'the rows')), 'above the rows');
});

test('Codex\'s first batch of one helper reads "Fern started a helper." and a later batch shows no notice', () => {
  const convo = fresh(FERN);
  lead(convo, 'One.');
  changed(convo, [codex('f1', 'rates', { firstBatch: true })], {}, 'fern');
  assert.strictEqual(one(panel(), '.room-notice', 'the notice').textContent,
    'Fern started a helper. Codex starts helpers straight away, so this wasn\'t asked first. Stop any you don\'t want.');
  lead(convo, 'Another.');
  changed(convo, [codex('f1', 'rates', { firstBatch: true }), codex('f2', 'deck', { batch: 'b2' })], {}, 'fern');
  const later = panel('b2').querySelector('.room-notice');
  assert.ok(!later || later.hidden || later.textContent === '', 'no notice on a later batch');
  assert.strictEqual(title(panel('b2')), 'Fern started a helper', 'the later batch is drawn');
});

// ── The rate line ──────────────────────────────────────────────────────────

test('the rate line, checked after each of six helpers Fern starts one at a time, the sixth stopped by the cap', () => {
  const convo = fresh(FERN);
  lead(convo, 'Six, one at a time.');
  const names = ['rates', 'pipeline', 'deck', 'hooks', 'calendar'];
  const said = [];
  for (let k = 1; k <= 5; k++) {
    changed(convo, names.slice(0, k).map((n, i) => codex(`f${i}`, n)), { b1: k }, 'fern');
    said.push(rate());
  }
  changed(convo, [...names.map((n, i) => codex(`f${i}`, n)), codex('f5', 'inbox', { state: 'killed', capped: true })], { b1: 5 }, 'fern');
  said.push(rate());
  assert.deepStrictEqual(said, [
    'Fern\'s helper works at the same time as Fern, so your plan\'s allowance is used up to twice as fast while it works.',
    'Fern\'s 2 helpers work at the same time, so your plan\'s allowance is used up to three times as fast while they work.',
    'Fern\'s 3 helpers work at the same time, so your plan\'s allowance is used up to four times as fast while they work.',
    'Fern\'s 4 helpers work at the same time, so your plan\'s allowance is used up to five times as fast while they work.',
    'Fern\'s 5 helpers work at the same time, so your plan\'s allowance is used up to six times as fast while they work.',
    'Fern\'s 5 helpers work at the same time, so your plan\'s allowance is used up to six times as fast while they work.',
  ]);
});

test('the rate line names teammates by name and the rest as the lead\'s, in the order they started', () => {
  const convo = fresh();
  lead(convo, 'Three.');
  changed(convo, [mate('t1', 'ash'), mate('t2', 'example-research-lead'), helper('t3', 'Explore')], { b1: 3 });
  assert.strictEqual(rate(), 'Ash, Rowan and Wren\'s helper work at the same time, so your plan\'s allowance is used up to four times as fast while they work.');
});

test('a capped row is never named in the rate line', () => {
  const convo = fresh();
  lead(convo, 'Three.');
  changed(convo, [mate('t1', 'ash'), mate('t2', 'example-research-lead'), helper('t3', 'Explore', { state: 'killed', capped: true })], { b1: 2 });
  assert.strictEqual(rate(), 'Ash and Rowan work at the same time, so your plan\'s allowance is used up to three times as fast while they work.');
});

test('a row that finishes never lowers N or removes a name', () => {
  const convo = fresh();
  lead(convo, 'Two.');
  changed(convo, [mate('t1', 'ash'), mate('t2', 'example-research-lead')], { b1: 2 });
  const before = rate();
  assert.strictEqual(before, 'Ash and Rowan work at the same time, so your plan\'s allowance is used up to three times as fast while they work.');
  changed(convo, [mate('t1', 'ash', { state: 'completed' }), mate('t2', 'example-research-lead')], { b1: 2 });
  assert.strictEqual(rate(), before, 'one finished');
  changed(convo, [mate('t1', 'ash', { state: 'completed' }), mate('t2', 'example-research-lead', { state: 'completed' })], {});
  assert.strictEqual(rate(), before, 'both finished, and a message with no most for the batch');
});

test('a batch of one teammate names the lead and whoever else runs in the conversation', () => {
  const convo = fresh();
  lead(convo, 'Ash first.');
  changed(convo, [mate('t1', 'ash')], { b1: 1 });
  lead(convo, 'Rowan too.');
  changed(convo, [mate('t1', 'ash'), mate('t2', 'example-research-lead', { batch: 'b2' })], { b1: 2, b2: 2 });
  assert.strictEqual(rate(panel('b2')), 'Rowan works at the same time as Wren and Ash, so your plan\'s allowance is used up to three times as fast while they work.');
  changed(convo, [mate('t1', 'ash', { state: 'completed' }), mate('t2', 'example-research-lead', { batch: 'b2' })], { b1: 2, b2: 2 });
  assert.strictEqual(rate(panel('b2')), 'Rowan works at the same time as Wren and Ash, so your plan\'s allowance is used up to three times as fast while they work.', 'Ash stays named once finished');
});

test('a batch of one teammate with nobody else running: "Rowan works while Wren carries on"', () => {
  const convo = fresh();
  lead(convo, 'Rowan.');
  changed(convo, [mate('t1', 'example-research-lead')], { b1: 1 });
  assert.strictEqual(rate(), 'Rowan works while Wren carries on, so your plan\'s allowance is used up to twice as fast while Rowan works.');
});

test('a batch of more than five rows that aren\'t capped reads frame 12\'s line', () => {
  const convo = fresh();
  lead(convo, 'Six.');
  const rows = ['ash', 'example-research-lead', 'ash', 'example-research-lead', 'ash'].map((a, i) => mate(`t${i}`, a));
  rows.push(mate('t5', 'ash', { state: 'waiting' }));
  changed(convo, rows, { b1: 5 });
  assert.strictEqual(rate(), 'Up to five of these teammates work at the same time, so your plan\'s allowance is used up to six times as fast while they work.');
  rows[5] = helper('t5', 'Explore', { state: 'waiting' });
  changed(convo, rows, { b1: 5 });
  assert.strictEqual(rate(), 'Up to five of these helpers work at the same time, so your plan\'s allowance is used up to six times as fast while they work.');
});

// ── The composer, the wake, the cards and a reload ─────────────────────────

// Passes on 4b's merge by design: a held result already finishes processing.
// The sibling that shares this setup and fails there is "while a row runs and
// the lead isn't replying, the note names one teammate".
test('after a held result Send reads "Send message" and sends, and the placeholder stays "Message Wren..."', () => {
  const convo = fresh();
  feed(convo, { type: 'system', subtype: 'process_started', _processId: PID });
  global.startProcessing(convo);
  lead(convo, 'Ash is on it.');
  const send = document.getElementById('send-btn');
  assert.strictEqual(send.title, 'Send message');
  const input = document.getElementById('msg-input');
  input.value = 'And the November numbers?';
  global.sendMessage();
  assert.deepStrictEqual(sent.filter((m) => m.type === 'chat').map((m) => [m.content, m.agent, m.conversationId]), [['And the November numbers?', 'wren', convo]]);
  assert.strictEqual(input.getAttribute('placeholder'), 'Message Wren...');
});

const NOTES = [
  ['one teammate', [mate('t1', 'ash')], 'Ash is still working. Your message goes to Wren.'],
  ['two teammates', [mate('t1', 'ash'), mate('t2', 'example-research-lead')], 'Ash and Rowan are still working. Your message goes to Wren.'],
  ['a teammate and a helper', [mate('t1', 'ash'), helper('t2', 'Explore')], 'Ash and Wren\'s helper are still working. Your message goes to Wren.'],
];
for (const [what, rows, said] of NOTES) {
  test(`while a row runs and the lead isn't replying, the note names ${what}: "${said}"`, () => {
    const convo = fresh();
    global.startProcessing(convo);
    feed(convo, sj.contentBlockStartText());
    changed(convo, rows);
    assert.strictEqual(noteText(), '', 'no note while the lead replies');
    feed(convo, sj.textDelta('On it.'));
    feed(convo, sj.result({ text: 'On it.' }));
    assert.strictEqual(noteText(), said);
    assert.strictEqual(document.getElementById('helpers-note').getAttribute('aria-live'), 'polite');
  });
}

test('the note is gone once no row runs', () => {
  const convo = fresh();
  lead(convo, 'On it.');
  changed(convo, [mate('t1', 'ash'), mate('t2', 'example-research-lead')]);
  assert.strictEqual(noteText(), 'Ash and Rowan are still working. Your message goes to Wren.');
  changed(convo, [mate('t1', 'ash', { state: 'completed' }), mate('t2', 'example-research-lead')]);
  assert.strictEqual(noteText(), 'Rowan is still working. Your message goes to Wren.');
  changed(convo, [mate('t1', 'ash', { state: 'completed' }), mate('t2', 'example-research-lead', { state: 'failed' })]);
  assert.strictEqual(noteText(), '');
});

// A helper's card, pending, as the page draws one.
function helperCard(convo, id) {
  global.renderPermissionCard({
    type: 'control_request', request_id: id, _conversationId: convo, _agent: 'wren', _helper: { agentId: 'agent-1', agentType: 'Explore' },
    request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'node tools/build.js' } },
  }, convo);
  return one(document, `#perm-${id}`, 'the helper\'s card');
}

test('a helpers_wake starts processing, Send becoming Stop, and removes no card', () => {
  const convo = fresh();
  lead(convo, 'On it.');
  changed(convo, [helper('t1', 'Explore')]);
  helperCard(convo, 'wake-card');
  assert.strictEqual(noteText(), 'Wren\'s helper is still working. Your message goes to Wren.');
  handle({ type: 'system', subtype: 'helpers_wake', _conversationId: convo, _processId: PID, _agent: 'wren' });
  const send = document.getElementById('send-btn');
  assert.strictEqual(global.getConvoState(convo).isProcessing, true, 'processing');
  assert.strictEqual(send.title, 'Stop agent', 'Send became Stop');
  assert.ok(document.getElementById('perm-wake-card'), 'the card stays');
  assert.strictEqual(noteText(), '', 'no note while the lead replies');
});

test('a person\'s message to a lead whose helper\'s card is pending leaves the card in place and answerable', () => {
  const convo = fresh();
  lead(convo, 'On it.');
  changed(convo, [helper('t1', 'Explore')]);
  const card = helperCard(convo, 'kept-card');
  feed(convo, { type: 'system', subtype: 'process_started', _processId: PID, _agent: 'wren' });
  assert.ok(card.isConnected, 'the card is still on the page');
  one(card, '[data-perm-action="allow"]', 'Allow').click();
  assert.deepStrictEqual(sent.filter((m) => m.type === 'permission_response').map((m) => [m.requestId, m.allow]), [['kept-card', true]]);
});

test('a reload while only helpers work draws the live panel after the last agent message, with Stop and Stop all, and leaves Send in place', () => {
  const convo = fresh();
  lead(convo, 'Earlier.');
  lead(convo, 'Started two.');
  global.handleActiveProcesses([{
    conversationId: convo, processId: PID, agentId: 'wren', idle: false, responseText: '', delegation: null,
    replying: false, most: { b1: 2 }, helpers: [mate('t1', 'ash'), helper('t2', 'Explore')],
  }]);
  assert.strictEqual(agentMessages()[1].nextElementSibling, panel());
  assert.strictEqual(title(), 'Wren started Ash and a helper');
  assert.strictEqual(rate(), 'Ash and Wren\'s helper work at the same time, so your plan\'s allowance is used up to three times as fast while they work.');
  assert.deepStrictEqual(rowEls().map((r) => one(r, '.room-stop', 'Stop').getAttribute('aria-label')), ['Stop Ash', 'Stop Search helper']);
  one(panel(), '.room-stop-all', 'Stop all');
  assert.strictEqual(global.getConvoState(convo).isProcessing, false, 'not processing');
  assert.strictEqual(document.getElementById('send-btn').title, 'Send message', 'Send stays');
});

test('a reload while the lead replies starts processing as it always has', () => {
  const convo = fresh();
  lead(convo, 'Started two.');
  global.handleActiveProcesses([{
    conversationId: convo, processId: PID, agentId: 'wren', idle: false, responseText: '', delegation: null,
    replying: true, most: { b1: 1 }, helpers: [helper('t1', 'Explore')],
  }]);
  assert.strictEqual(global.getConvoState(convo).isProcessing, true);
  assert.strictEqual(document.getElementById('send-btn').title, 'Stop agent');
  assert.strictEqual(title(), 'Wren started a helper');
});

test('a conversation opened again draws its live panel after its last agent message', () => {
  const convo = fresh();
  lead(convo, 'Started one.');
  changed(convo, [helper('t1', 'Explore')]);
  document.getElementById('messages').replaceChildren();
  lead(convo, 'Started one.');
  const line = cutFrom(CONVERSATIONS, 'conversations.js', 'renderPendingPermissionCards(id);', 'RundockRoomPanel.draw(id);', 'the panels drawn on open');
  new Function('id', line)(convo);
  assert.strictEqual(agentMessages()[0].nextElementSibling, panel());
  assert.strictEqual(title(), 'Wren started a helper');
});
