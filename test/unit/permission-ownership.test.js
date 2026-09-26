'use strict';
// Where a permission card is drawn, and whether it can still be answered.
//
// TWO DEFECTS, ONE CARD. A routine's request arrived with no conversation and
// the client put it in whichever conversation was open: a routine asking to
// change email appeared inside an unrelated chat, one click from approval.
// And a card could outlive its request: nothing stopped a copy that arrived
// late, or one queued for a background conversation, from being drawn with
// Allow after the server had already denied it.
//
// What is pinned here, through the real card code under jsdom:
//   - a request with no conversation is never drawn in the open one, and the
//     dispatch that used to fall back to it no longer can (read off app.js)
//   - a routine's card names the routine and the agent; a card nothing could
//     be matched to says it is unattributed
//   - a request that has ended renders as ended, with no Allow, on every road
//     a card is drawn by: live, from the background queue, replayed
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf-8');
const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf-8');

// The dock exactly as index.html declares it, so the test draws into the
// markup the app ships rather than a copy of it.
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
  global.RundockPermissions = require('../../public/permissions.js');
  global.RundockChatMarkup = require('../../public/chat-markup.js');
  global.serverPlatform = 'darwin';
  global.workspaceMode = 'knowledge';
  global.agents = [{ id: 'assistant', displayName: 'Ada' }];
  global.updateUnreadBadge = () => {};
  global.renderConvoList = () => {};
  chat = require('../../public/views/chat.js');
});
after(() => { if (dom) dom.window.close(); });
beforeEach(() => {
  document.getElementById('messages').innerHTML = '';
  document.querySelector('.approvals-dock-list').innerHTML = '';
  global.pendingPermissions.clear();
  global.pendingPermissionsByConvo.clear();
  global.activeConversation = { id: 'c-open' };
  sent = [];
  unreadCalls = [];
  global.unread = { markPermission: (c) => unreadCalls.push(['mark', c]), resolvePermission: (c) => unreadCalls.push(['resolve', c]) };
  global.ws = { send: (s) => sent.push(JSON.parse(s)) };
});

let seq = 0;
const nextId = () => `perm-own-${++seq}`;
function request(id, extra) {
  return Object.assign({
    type: 'control_request', request_id: id,
    request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'sh scripts/apply-labels.sh --ids a,b,c' } },
    _conversationId: '',
  }, extra || {});
}
const inThread = (id) => !!document.querySelector(`#messages #perm-${id}`);
const inDock = (id) => !!document.querySelector(`#approvals-dock #perm-${id}`);
const answerable = (id) => !!document.querySelector(`#perm-${id} [data-perm-action="allow"]`);

describe('a request with no conversation of its own', () => {
  test('the dispatch never falls back to the conversation on screen', () => {
    // Read off app.js: the one place the fallback lived. If `|| activeConversation`
    // comes back in any form, this fails.
    const at = APP_SRC.indexOf("case 'control_request'");
    assert.ok(at > 0, 'app.js dispatches control_request');
    const block = APP_SRC.slice(at, APP_SRC.indexOf('break;', at));
    assert.ok(!block.includes('activeConversation'), 'the control_request case reads no active conversation');
    assert.ok(block.includes('handleOwnerlessPermissionRequest(d)'), 'a request with no conversation goes to the ownerless path');
  });

  test('a routine request is drawn in the approvals dock, naming the routine and the agent, and not in the open thread', () => {
    const id = nextId();
    chat.handleOwnerlessPermissionRequest(request(id, { _run: { id: 'run-1', routine: 'Morning Briefing', agent: 'assistant' } }));
    assert.ok(!inThread(id), 'absent from the conversation on screen');
    assert.ok(inDock(id), 'present in the approvals dock');
    const origin = document.querySelector(`#perm-${id} .permission-origin`).textContent;
    assert.strictEqual(origin.trim(), 'Morning Briefing, run by Ada');
    assert.ok(answerable(id), 'and it can be answered there');
    assert.strictEqual(document.getElementById('approvals-dock').hidden, false, 'the dock shows itself');
    assert.match(document.querySelector('.approvals-dock-count').textContent, /1 waiting/);
  });

  test('a request nothing could be matched to is drawn as unattributed, and not in the open thread', () => {
    const id = nextId();
    chat.handleOwnerlessPermissionRequest(request(id));
    assert.ok(!inThread(id));
    assert.ok(inDock(id));
    assert.match(document.querySelector(`#perm-${id} .permission-origin`).textContent, /^Unattributed/);
  });

  test('answering a dock card sends no conversation of its own', () => {
    const id = nextId();
    chat.handleOwnerlessPermissionRequest(request(id, { _run: { id: 'run-1', routine: 'Morning Briefing', agent: 'assistant' } }));
    document.querySelector(`#perm-${id} [data-perm-action="deny"]`).click();
    const response = sent.find(m => m.type === 'permission_response');
    assert.strictEqual(response.requestId, id);
    assert.strictEqual(response.conversationId, '');
    assert.strictEqual(response.allow, false);
  });

  test('a conversation request still goes to its own conversation', () => {
    const id = nextId();
    chat.handlePermissionRequest(request(id, { _conversationId: 'c-open' }), 'c-open');
    assert.ok(inThread(id));
    assert.ok(!inDock(id));
  });
});

describe('a request that has ended', () => {
  test('ended while its conversation was in the background, it renders as timed out when opened, with no Allow', () => {
    const id = nextId();
    chat.handlePermissionRequest(request(id, { _conversationId: 'c-bg' }), 'c-bg');
    assert.ok(!document.getElementById('perm-' + id), 'queued, not drawn, while off screen');
    chat.endPermissionRequest(id, 'timeout');
    assert.deepStrictEqual(unreadCalls.at(-1), ['resolve', 'c-bg'], 'its unread signal clears');

    global.activeConversation = { id: 'c-bg' };
    chat.renderPendingPermissionCards('c-bg');
    assert.ok(document.getElementById('perm-' + id), 'shown when its conversation opens');
    assert.ok(!answerable(id), 'with nothing to click');
    assert.match(document.getElementById('perm-' + id).textContent, /Timed out/);
    assert.match(document.getElementById('perm-' + id).textContent, /Nobody answered in time/);
  });

  test('a copy that arrives after the news it ended renders as ended, never answerable', () => {
    const id = nextId();
    chat.endPermissionRequest(id, 'timeout');
    chat.handlePermissionRequest(request(id, { _conversationId: 'c-open' }), 'c-open');
    assert.ok(document.getElementById('perm-' + id), 'drawn');
    assert.ok(!answerable(id), 'but settled');
    assert.ok(!global.pendingPermissions.has(id), 'and nothing will be sent for it');
    chat.handleOwnerlessPermissionRequest(request(id));
    assert.ok(!inDock(id), 'an ended ownerless copy is not raised in the dock either');
  });

  test('after a reconnect, a card the server no longer names is settled', () => {
    const kept = nextId();
    const gone = nextId();
    chat.handlePermissionRequest(request(kept, { _conversationId: 'c-open' }), 'c-open');
    chat.handlePermissionRequest(request(gone, { _conversationId: 'c-open' }), 'c-open');
    chat.reconcilePendingPermissions([kept]);
    assert.ok(answerable(kept), 'the one still waiting stays answerable');
    assert.ok(!answerable(gone), 'the one that ended while away is settled');
    assert.match(document.getElementById('perm-' + gone).textContent, /No longer waiting/);
  });

  test('answered in another window, the card here says so; answered here, it keeps its own answer', () => {
    const elsewhere = nextId();
    chat.handlePermissionRequest(request(elsewhere, { _conversationId: 'c-open' }), 'c-open');
    chat.endPermissionRequest(elsewhere, 'answered', true);
    assert.ok(!answerable(elsewhere));
    assert.match(document.getElementById('perm-' + elsewhere).textContent, /Answered in another window/);

    const here = nextId();
    chat.handlePermissionRequest(request(here, { _conversationId: 'c-open' }), 'c-open');
    document.querySelector(`#perm-${here} [data-perm-action="allow"]`).click();
    chat.endPermissionRequest(here, 'answered', true);
    assert.doesNotMatch(document.getElementById('perm-' + here).textContent, /another window/);
  });

  test('a click the server says came too late is admitted on the card', () => {
    const id = nextId();
    chat.handlePermissionRequest(request(id, { _conversationId: 'c-open' }), 'c-open');
    document.querySelector(`#perm-${id} [data-perm-action="allow"]`).click();
    chat.endPermissionRequest(id, 'not-pending');
    assert.match(document.getElementById('perm-' + id).textContent, /Too late/);
  });
});
