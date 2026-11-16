'use strict';
// AN OPEN CARD SURVIVES A SWITCH TO ANOTHER CONVERSATION AND BACK.
//
// A card used to be kept for later only when it arrived while its
// conversation was in the background. One drawn while its conversation was on
// screen lived in the page alone: switch away and the page was replaced, come
// back and nothing redrew it, and the request waited with no card until the
// server timed it out and denied it. Every card drawn in a conversation is now
// held per conversation from the moment it can be answered, so the redraw on
// return finds it, and every way the request ends takes it out again.
//
// What is pinned here, through the real card code under jsdom:
//   - every kind of card a conversation draws comes back live after a switch,
//     once, and its one click sends one answer naming its own request and
//     conversation
//   - a card answered here comes back once more, settled exactly as it was
//     answered, and never live; nothing on it sends, and it leaves its
//     conversation waiting on nothing
//   - a request that ends while its conversation is in the background comes
//     back settled, saying why, at most once, and nothing on it sends
//   - a card is drawn only in its own conversation
//   - a conversation left with an open card waits in the list until its last
//     card is answered or ends
//   - the five sequences: the inverse action, the undo, the retry, the most
//     common next step, and the control failing
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const P = require('../../public/permissions.js');

describe('the conversations left waiting on the person', () => {
  const payload = id => ({ request_id: id, request: { tool_name: 'Bash', input: { command: 'npm test' } } });

  test('every conversation holding a request is waiting, except the one on screen', () => {
    const byConvo = new Map();
    P.queuePendingPermission(byConvo, 'convo-a', 'r1', payload('r1'));
    P.queuePendingPermission(byConvo, 'convo-b', 'r2', payload('r2'));
    P.queuePendingPermission(byConvo, 'convo-b', 'r3', payload('r3'));
    assert.deepStrictEqual(P.waitingConversations(byConvo, 'convo-a'), ['convo-b']);
    assert.deepStrictEqual(P.waitingConversations(byConvo, 'convo-b'), ['convo-a']);
    assert.deepStrictEqual(P.waitingConversations(byConvo, 'convo-c'), ['convo-a', 'convo-b'], 'on a third, both wait');
    assert.deepStrictEqual(P.waitingConversations(byConvo, null), ['convo-a', 'convo-b'], 'with none on screen, both wait');
  });

  test('a conversation whose last request was taken out is no longer waiting', () => {
    const byConvo = new Map();
    P.queuePendingPermission(byConvo, 'convo-a', 'r1', payload('r1'));
    P.removePendingPermission(byConvo, 'r1');
    assert.deepStrictEqual(P.waitingConversations(byConvo, 'convo-b'), []);
    byConvo.set('convo-c', new Map());
    assert.deepStrictEqual(P.waitingConversations(byConvo, 'convo-b'), [], 'an empty bucket holds nothing to wait on');
  });

  test('a request with no conversation of its own is never a conversation waiting', () => {
    const byConvo = new Map();
    P.queuePendingPermission(byConvo, '', 'r1', payload('r1'));
    assert.deepStrictEqual(P.waitingConversations(byConvo, 'convo-a'), []);
  });
});

describe('an answer given on a card in this window', () => {
  test('reads as the answer it was, never as another window\'s', () => {
    assert.deepStrictEqual(P.endedPermissionCopy('answered-here', true, false), { allowed: true, label: '✓', why: '' });
    assert.deepStrictEqual(P.endedPermissionCopy('answered-here', true, true), { allowed: true, label: '✓ Always', why: '' });
    assert.deepStrictEqual(P.endedPermissionCopy('answered-here', false, true), { allowed: false, label: '✕', why: '' });
  });

  test('is recorded as over, with what its card said, until the server says the click came too late', () => {
    const ended = new Map();
    P.markPermissionAnswered(ended, 'r1', false, false, 'Run npm test');
    assert.deepStrictEqual(P.permissionEnded(ended, 'r1'), { reason: 'answered-here', allow: false, always: false, text: 'Run npm test' });
    P.markPermissionAnswered(ended, 'r2', true, true, '');
    assert.deepStrictEqual(P.permissionEnded(ended, 'r2'), { reason: 'answered-here', allow: true, always: true, text: '' });
    P.markPermissionEnded(ended, 'r1', 'not-pending');
    assert.deepStrictEqual(P.permissionEnded(ended, 'r1'), { reason: 'not-pending', allow: false });
  });
});

// ── The window ────────────────────────────────────────────────────────────

const ROOT = path.join(__dirname, '..', '..');
const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf-8');
function dockMarkup() {
  const shell = new JSDOM(INDEX_SRC).window.document.getElementById('approvals-dock');
  assert.ok(shell, 'index.html declares the approvals dock');
  return shell.outerHTML;
}

let chat, dom, sent, unreadCalls;
before(() => {
  dom = new JSDOM(`<div id="messages"></div>${dockMarkup()}`);
  global.window = dom.window;
  global.document = dom.window.document;
  global.pendingPermissions = new Map();
  global.pendingPermissionsByConvo = new Map();
  global.userScrolledUp = false;
  global.esc = (t) => { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; };
  global.escAttr = (t) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  global.RundockPermissions = P;
  global.RundockChatMarkup = require('../../public/chat-markup.js');
  global.serverPlatform = 'darwin';
  global.workspaceMode = 'knowledge';
  global.agents = [{ id: 'helper', displayName: 'Helper' }];
  global.updateUnreadBadge = () => {};
  global.renderConvoList = () => {};
  const convoStates = {};
  global.getConvoState = (id) => (convoStates[id] = convoStates[id] || {});
  chat = require('../../public/views/chat.js');
});
after(() => { if (dom) dom.window.close(); });

// The real unread state, with every call it is given written down.
function unreadState() {
  const real = require('../../public/unread-state.js').createUnreadState();
  return {
    ...real,
    markPermission: (c) => { unreadCalls.push(['mark', c]); real.markPermission(c); },
    resolvePermission: (c) => { unreadCalls.push(['resolve', c]); real.resolvePermission(c); },
    clearConvo: (c) => { unreadCalls.push(['clear', c]); return real.clearConvo(c); },
  };
}

let seq = 0;
let A, B, C;
beforeEach(() => {
  document.getElementById('messages').innerHTML = '';
  document.querySelector('.approvals-dock-list').innerHTML = '';
  global.pendingPermissions.clear();
  global.pendingPermissionsByConvo.clear();
  global.activeConversation = null;
  sent = [];
  unreadCalls = [];
  global.unread = unreadState();
  global.ws = { send: (s) => sent.push(JSON.parse(s)) };
  // Conversations of this test's own: what one test leaves settled in a
  // conversation can never be drawn in another's.
  seq++;
  A = `convo-${seq}-a`; B = `convo-${seq}-b`; C = `convo-${seq}-c`;
});

const nextId = (() => { let n = 0; return () => `req-${++n}`; })();
const MEDIUM = { tool_name: 'Bash', input: { command: 'npm install left-pad' } };
function request(id, convoId, req) {
  return { type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', ...(req || MEDIUM) }, _conversationId: convoId };
}
// A request arriving from the server, handed on as app.js hands it.
function arrive(id, convoId, req) { chat.handlePermissionRequest(request(id, convoId, req), convoId); }
// What opening a conversation does to the thread: it becomes the one on
// screen, its marks clear, the page is replaced and the cards it holds are
// drawn again (conversations.js, openConversation).
function open(convoId) {
  global.activeConversation = { id: convoId };
  unread.clearConvo(convoId);
  document.getElementById('messages').innerHTML = '';
  chat.renderPendingPermissionCards(convoId);
}
const copies = (id) => document.querySelectorAll(`#messages [id="perm-${id}"]`).length;
const card = (id) => document.querySelector(`#messages #perm-${id}`);
const live = (id) => !!document.querySelector(`#messages #perm-${id} [data-perm-action="allow"]`);
const answers = () => sent.filter(m => m.type === 'permission_response');
function click(id, action) {
  const btn = document.querySelector(`#perm-${id} [data-perm-action="${action || 'allow'}"]`);
  assert.ok(btn, `the card offers ${action || 'allow'}`);
  btn.click();
}
// Everything a person could do to a card that is no longer live: click every
// part of it, and press Enter and Space on every part of it.
function pokeAt(id) {
  const el = card(id);
  assert.ok(el, 'the card is there to poke at');
  for (const node of [el, ...el.querySelectorAll('*')]) {
    node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    for (const key of ['Enter', ' ']) node.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true }));
  }
}

describe('a card drawn while its conversation is on screen', () => {
  test('is still shown, and can be answered, after switching to another conversation and back', () => {
    open(A);
    const id = nextId();
    arrive(id, A);
    assert.ok(live(id), 'drawn live while its conversation is on screen');
    open(B);
    assert.strictEqual(copies(id), 0, 'gone with the page when the person leaves');
    open(A);
    assert.strictEqual(copies(id), 1, 'drawn again on return');
    assert.ok(live(id), 'and still answerable');
    click(id, 'allow');
    assert.deepStrictEqual(answers(), [{
      type: 'permission_response', requestId: id, conversationId: A, allow: true, card: true, toolInput: MEDIUM.input,
    }]);
  });

  // Every card the window draws inside a conversation, drawn on screen, then
  // left and come back to: the same card, live, once, answered by its own
  // button with its own request and conversation.
  const PUT_BACK_PATH = '/ws/.rundock/permissions.json';
  const KINDS = [
    {
      name: 'an ordinary card graded low',
      // A read is answered without a card; one that touches the person's own
      // answers is carded whatever its grade.
      req: { tool_name: 'Bash', input: { command: 'cat notes.md' }, answer_file: true },
      looks: '.permission-card.risk-low', button: 'allow',
    },
    // Answered "Always allow", which the window remembers for the session: a
    // command of its own, so no other test's request is answered by it.
    { name: 'an ordinary card graded medium', req: { tool_name: 'Bash', input: { command: 'sh scripts/apply-labels.sh --ids a,b,c' } }, looks: '.permission-card.risk-medium', button: 'always' },
    { name: 'an ordinary card graded high', req: { tool_name: 'Bash', input: { command: 'rm -rf build' } }, looks: '.permission-card.risk-high', button: 'allow' },
    {
      name: 'the hand-off card',
      req: { tool_name: 'SaveAgent', input: { kind: 'agent', action: 'add', name: 'helper', file: '.claude/agents/helper.md', by: 'Lead', content: '---\nname: helper\n---\n\nYou help.' } },
      looks: '.permission-card', button: 'allow',
    },
    {
      name: 'the folder-grant card',
      req: { tool_name: 'Bash', input: { command: 'touch /etc/probe' }, boundary: true, resolved_path: '/etc/probe', grant_dir: '/etc' },
      looks: '[data-perm-action="allow-folder"]', button: 'allow-folder', grantDir: '/etc',
    },
    {
      name: 'the put-back card',
      req: {
        tool_name: 'WriteFile', input: { path: PUT_BACK_PATH, content: '{}\n', approvalKind: 'fileChange' },
        answer_file: true, resolved_path: PUT_BACK_PATH, grant_dir: null, crossings: [{ path: PUT_BACK_PATH, answerFile: true }],
        put_back: { relative: '.rundock/permissions.json', before: '{\n  "allowedTools": []\n}\n', after: '{\n  "allowedTools": ["Bash"]\n}\n', runtime: 'claude', outsideTurn: false },
      },
      looks: '.btn-keep-change', button: 'allow',
    },
  ];
  for (const kind of KINDS) {
    test(`comes back after a switch: ${kind.name}`, () => {
      open(A);
      const id = nextId();
      arrive(id, A, kind.req);
      assert.ok(card(id) && card(id).querySelector(kind.looks), 'drawn as its own kind of card');
      const drawn = card(id).outerHTML;
      open(B);
      assert.strictEqual(copies(id), 0);
      open(A);
      assert.strictEqual(copies(id), 1, 'one copy');
      assert.strictEqual(card(id).outerHTML, drawn, 'the same card, live, as it was drawn');
      click(id, kind.button);
      const sentNow = answers();
      assert.strictEqual(sentNow.length, 1, 'one answer');
      assert.strictEqual(sentNow[0].requestId, id);
      assert.strictEqual(sentNow[0].conversationId, A);
      assert.strictEqual(sentNow[0].allow, true);
      if (kind.grantDir) assert.strictEqual(sentNow[0].grantDir, kind.grantDir, 'and the folder it offered to remember');
    });
  }
});

describe('a card answered after the switch', () => {
  test('sends one answer with its own request and conversation, and is never drawn live again', () => {
    open(A);
    const id = nextId();
    arrive(id, A);
    open(B);
    open(A);
    click(id, 'deny');
    assert.deepStrictEqual(answers().map(m => [m.requestId, m.conversationId, m.allow]), [[id, A, false]]);
    assert.ok(!live(id), 'settled where it was answered');
    // Away and back before the server has said anything about it.
    open(B);
    open(A);
    assert.ok(!live(id), 'not live on return');
    assert.ok(!pendingPermissions.has(id), 'and nothing could send for it');
    // The server's word that it was answered, then away and back again.
    chat.endPermissionRequest(id, 'answered', false);
    open(B);
    open(A);
    assert.ok(!live(id), 'still not live');
    assert.strictEqual(answers().length, 1, 'one answer, all told');
  });

  // Each answer a card offers, given after a switch and confirmed by the
  // server: the next return draws the card once more, settled exactly as it
  // settled under the click, in its own conversation only, and the return
  // after that draws nothing. An answered card never leaves its conversation
  // waiting, and nothing on the settled card sends.
  const ANSWERS = [
    { name: 'Allow', button: 'allow', allowed: true, label: '✓' },
    // A command of its own, so the remembered answer touches no other test.
    { name: 'Always allow', button: 'always', allowed: true, label: '✓ Always', req: { tool_name: 'Bash', input: { command: 'make release' } } },
    { name: 'Deny', button: 'deny', allowed: false, label: '✕' },
    {
      name: 'Allow for the folder', button: 'allow-folder', allowed: true, label: '✓',
      req: { tool_name: 'Bash', input: { command: 'touch /etc/probe' }, boundary: true, resolved_path: '/etc/probe', grant_dir: '/etc' },
    },
    {
      name: 'leaving a put-back change restored', button: 'deny', allowed: false, label: '✕',
      req: {
        tool_name: 'WriteFile', input: { path: '/ws/.rundock/permissions.json', content: '{}\n', approvalKind: 'fileChange' },
        answer_file: true, resolved_path: '/ws/.rundock/permissions.json', grant_dir: null, crossings: [{ path: '/ws/.rundock/permissions.json', answerFile: true }],
        put_back: { relative: '.rundock/permissions.json', before: '{}\n', after: '{ "allowedTools": ["Bash"] }\n', runtime: 'claude', outsideTurn: false },
      },
    },
  ];
  for (const a of ANSWERS) {
    test(`comes back once, settled as it was answered, then never again: ${a.name}`, () => {
      open(A);
      const id = nextId();
      arrive(id, A, a.req);
      open(B);
      open(A);
      click(id, a.button);
      const settled = card(id).outerHTML;
      const shown = card(id).querySelector('.permission-resolved');
      assert.ok(shown && shown.classList.contains(a.allowed ? 'allowed' : 'denied'), 'settled showing its answer');
      assert.strictEqual(shown.querySelector('span').textContent, a.label);
      chat.endPermissionRequest(id, 'answered', a.allowed);
      const callsBefore = unreadCalls.length;
      open(B);
      assert.strictEqual(document.querySelectorAll('#messages .msg-permission').length, 0, 'never drawn in another conversation, which shows no card at all');
      assert.ok(!unread.isUnread(A), 'answered, it leaves its conversation waiting on nothing');
      open(A);
      assert.strictEqual(copies(id), 1, 'drawn once on return');
      assert.ok(!live(id), 'settled, never live');
      assert.strictEqual(card(id).outerHTML, settled, 'exactly as it settled when answered');
      pokeAt(id);
      assert.strictEqual(answers().length, 1, 'one answer, and nothing on the settled card sends');
      open(C);
      assert.strictEqual(document.querySelectorAll('#messages .msg-permission').length, 0, 'nor in a conversation that never asked');
      open(A);
      assert.strictEqual(copies(id), 0, 'and a later return draws nothing');
      assert.ok(!unreadCalls.slice(callsBefore).some(([what, c]) => what === 'mark' && c === A), 'never marked waiting');
    });
  }

  test('answered while its conversation is on screen, it comes back once, settled, after leaving and returning', () => {
    open(A);
    const id = nextId();
    arrive(id, A);
    click(id, 'allow');
    const settled = card(id).outerHTML;
    open(B);
    assert.strictEqual(document.querySelectorAll('#messages .msg-permission').length, 0, 'never drawn in another conversation');
    assert.ok(!unread.isUnread(A), 'nothing left waiting');
    open(A);
    assert.strictEqual(copies(id), 1, 'drawn once on return');
    assert.strictEqual(card(id).outerHTML, settled, 'exactly as it settled when answered');
    pokeAt(id);
    open(B);
    open(A);
    assert.strictEqual(copies(id), 0, 'and a later return draws nothing');
    assert.deepStrictEqual(answers().map(m => [m.requestId, m.conversationId, m.allow]), [[id, A, true]]);
  });
});

describe('a request that ends while its conversation is in the background', () => {
  const WAYS = [
    { reason: 'answered', allow: true, says: /Answered in another window/ },
    { reason: 'timeout', says: /Timed out[\s\S]*Nobody answered in time/ },
    { reason: 'cancelled', says: /Stopped[\s\S]*stopped before this was answered/ },
    { reason: 'ended', says: /No longer waiting[\s\S]*nothing left to answer/ },
  ];
  for (const way of WAYS) {
    test(`comes back settled, saying why, at most once: ${way.reason}`, () => {
      open(A);
      const id = nextId();
      arrive(id, A);
      open(B);
      chat.endPermissionRequest(id, way.reason, way.allow);
      open(A);
      assert.strictEqual(copies(id), 1, 'shown once');
      assert.ok(!live(id), 'settled, with nothing to click');
      assert.match(card(id).textContent, way.says);
      pokeAt(id);
      assert.deepStrictEqual(answers(), [], 'nothing on it sends');
      open(B);
      open(A);
      assert.strictEqual(copies(id), 0, 'and not shown again');
    });
  }
});

// The record of which requests have ended keeps only the latest. A card kept
// to be shown settled carries how it ended, so it is never drawn live however
// many other requests end before its conversation is opened again.
describe('a settled card kept while more requests end than the record of ended requests holds', () => {
  const FLOOD = 600;
  const flood = () => { for (let i = 0; i < FLOOD; i++) chat.endPermissionRequest(`${A}-other-${i}`, 'ended'); };

  test('the record forgets the oldest request once that many more have ended', () => {
    const ended = new Map();
    P.markPermissionEnded(ended, 'first', 'timeout');
    for (let i = 0; i < FLOOD; i++) P.markPermissionEnded(ended, `other-${i}`, 'ended');
    assert.strictEqual(P.permissionEnded(ended, 'first'), null);
  });

  const THEN = [
    { name: 'it timed out in the background', act: (id) => { open(B); chat.endPermissionRequest(id, 'timeout'); }, says: /Timed out[\s\S]*Nobody answered in time/, sent: 0 },
    { name: 'it was answered here', act: (id) => { click(id, 'allow'); open(B); }, says: /✓/, sent: 1 },
    { name: 'it was answered here too late', act: (id) => { click(id, 'allow'); open(B); chat.endPermissionRequest(id, 'not-pending'); }, says: /Too late[\s\S]*nothing was approved/, sent: 1 },
  ];
  for (const t of THEN) {
    test(`comes back once, settled, never live: ${t.name}`, () => {
      open(A);
      const id = nextId();
      arrive(id, A);
      t.act(id);
      flood();
      open(A);
      assert.strictEqual(copies(id), 1, 'shown once');
      assert.ok(!live(id), 'with no answer buttons');
      assert.ok(!pendingPermissions.has(id), 'and nothing that could send for it');
      assert.match(card(id).textContent, t.says);
      pokeAt(id);
      assert.strictEqual(answers().length, t.sent, 'nothing on it sends');
      open(B);
      open(A);
      assert.strictEqual(copies(id), 0, 'and a later return draws none');
    });
  }
});

describe('open cards in two conversations', () => {
  test('each card is drawn only in its own conversation, and answering one leaves the other open', () => {
    open(A);
    const first = nextId();
    arrive(first, A);
    open(B);
    const second = nextId();
    arrive(second, B);
    for (let i = 0; i < 2; i++) {
      open(A);
      assert.ok(live(first) && copies(second) === 0, 'only its own card in the first');
      open(B);
      assert.ok(live(second) && copies(first) === 0, 'only its own card in the second');
    }
    click(second, 'allow');
    assert.deepStrictEqual(answers().map(m => [m.requestId, m.conversationId]), [[second, B]]);
    open(A);
    assert.ok(live(first), 'the other is still open');
    assert.strictEqual(copies(second), 0);
    open(B);
    assert.strictEqual(copies(first), 0, 'and still never drawn outside its own');
    assert.ok(!live(second));
    assert.strictEqual(answers().length, 1, 'and still unanswered');
  });
});

describe('a conversation left with an open card', () => {
  test('is marked waiting in the list, as one whose card arrived in the background is', () => {
    open(A);
    const id = nextId();
    arrive(id, A);
    assert.ok(!unread.isUnread(A), 'not marked while on screen');
    open(B);
    assert.ok(unread.isUnread(A), 'marked once left');
    assert.ok(unreadCalls.some(([what, c]) => what === 'mark' && c === A), 'as a card waiting, the way a background arrival is marked');
    assert.ok(!unread.isUnread(B), 'the one on screen is not');
    // The background arrival it is measured against.
    const queued = nextId();
    arrive(queued, C);
    assert.ok(unread.isUnread(C));
  });

  test('its mark clears when its last card ends, and not before', () => {
    open(A);
    const first = nextId();
    const second = nextId();
    arrive(first, A);
    arrive(second, A);
    open(B);
    assert.ok(unread.isUnread(A));
    chat.endPermissionRequest(first, 'timeout');
    assert.ok(unread.isUnread(A), 'another card still waits');
    chat.endPermissionRequest(second, 'answered', false);
    assert.ok(!unread.isUnread(A), 'answered in another window, the last one clears it');
  });

  test('answering its last card leaves it unmarked; while another waits, leaving marks it again', () => {
    open(A);
    const first = nextId();
    const second = nextId();
    arrive(first, A);
    arrive(second, A);
    open(B);
    open(A);
    click(first, 'allow');
    open(B);
    assert.ok(unread.isUnread(A), 'one card still waits');
    open(A);
    click(second, 'allow');
    open(B);
    assert.ok(!unread.isUnread(A), 'nothing waits');
  });
});

describe('the cards outside this change', () => {
  test('a card in the approvals dock is held for no conversation', () => {
    open(A);
    const id = nextId();
    chat.handleOwnerlessPermissionRequest(request(id, ''));
    assert.ok(document.querySelector(`#approvals-dock #perm-${id}`), 'drawn in the dock');
    assert.strictEqual(pendingPermissionsByConvo.size, 0);
    open(B);
    assert.ok(!unread.isUnread(A) && !unread.isUnread(''), 'and marks no conversation');
  });
});

describe('the five sequences', () => {
  test('the inverse action: switching away and back redraws an open card, and with no card open draws nothing', () => {
    open(A);
    const id = nextId();
    arrive(id, A);
    open(B);
    open(A);
    assert.strictEqual(copies(id), 1, 'the open card comes back');
    click(id, 'deny');
    open(B);
    open(A);
    assert.strictEqual(copies(id), 1, 'the answered card is shown once more, settled');
    assert.ok(!live(id));
    open(B);
    open(A);
    assert.strictEqual(document.querySelectorAll('#messages .msg-permission').length, 0, 'with none open, nothing is drawn');
    open(C);
    assert.strictEqual(document.querySelectorAll('#messages .msg-permission').length, 0, 'nor in a conversation that never asked');
    assert.ok(!unread.isUnread(A) && !unread.isUnread(B), 'and nothing is marked waiting');
    assert.strictEqual(answers().length, 1);
  });

  test('the undo: clicking a settled card, or pressing a key on it, sends nothing', () => {
    open(A);
    const answered = nextId();
    const expired = nextId();
    arrive(answered, A);
    arrive(expired, A);
    open(B);
    chat.endPermissionRequest(expired, 'timeout');
    open(A);
    click(answered, 'allow');
    assert.strictEqual(answers().length, 1);
    pokeAt(answered);
    pokeAt(expired);
    assert.strictEqual(answers().length, 1, 'neither the answered card nor the expired one sends again');
  });

  test('the retry: switching away and back five times leaves one copy, still live, and one click sends one answer', () => {
    open(A);
    const id = nextId();
    arrive(id, A);
    for (let i = 0; i < 5; i++) {
      open(B);
      open(A);
      assert.strictEqual(copies(id), 1, `one copy after switch ${i + 1}`);
      assert.ok(live(id), `still live after switch ${i + 1}`);
    }
    // The redraw run again over the same page, as a reconnect replays.
    chat.renderPendingPermissionCards(A);
    chat.handlePermissionRequest(request(id, A), A);
    assert.strictEqual(copies(id), 1, 'a second redraw over the same page adds nothing');
    click(id, 'allow');
    pokeAt(id);
    assert.deepStrictEqual(answers().map(m => [m.requestId, m.conversationId, m.allow]), [[id, A, true]]);
  });

  test('the most common next step: come back, click Allow, and the answer goes out for that card at once', () => {
    open(A);
    const id = nextId();
    arrive(id, A);
    open(B);
    // Coming back to a conversation still working restores its indicator
    // before the cards are drawn (openConversation).
    global.activeConversation = { id: A };
    unread.clearConvo(A);
    document.getElementById('messages').innerHTML = '<div class="msg msg-agent" id="thinking-indicator"></div>';
    chat.renderPendingPermissionCards(A);
    const indicator = document.getElementById('thinking-indicator');
    assert.strictEqual(indicator.style.display, 'none', 'the indicator waits while the card does');
    click(id, 'allow');
    assert.deepStrictEqual(answers(), [{
      type: 'permission_response', requestId: id, conversationId: A, allow: true, card: true, toolInput: MEDIUM.input,
    }], 'sent at once, as an answer a person gave on a card');
    assert.strictEqual(indicator.style.display, '', 'and the conversation shows it is working again');
  });

  test('the control failing: timed out while in the background, the card comes back settled saying so, and clicking it sends nothing', () => {
    open(A);
    const id = nextId();
    arrive(id, A);
    open(B);
    chat.endPermissionRequest(id, 'timeout');
    open(A);
    assert.strictEqual(copies(id), 1);
    assert.ok(!live(id));
    assert.match(card(id).textContent, /Timed out/);
    assert.match(card(id).textContent, /Nobody answered in time, so it was denied/);
    pokeAt(id);
    assert.deepStrictEqual(answers(), []);
    assert.ok(!pendingPermissions.has(id));
  });
});
