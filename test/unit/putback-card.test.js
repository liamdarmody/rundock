'use strict';
// THE PUT-BACK CARD: ONE MESSAGE, AFTER THE COMMAND, IN THE PAST TENSE.
//
// When Rundock puts back a change to the workspace's permission files, the
// person used to see a notice, then an ordinary Allow / Deny card asking in
// the present tense about something already undone, then the agent's reply
// narrating a write that had quietly been reverted. Now one card says what
// happened and asks whether to keep the change instead: "Leave it restored"
// (the default, today's Deny) or "Keep the change" (today's Allow), never
// remembered. It sits after the command and before the agent's reply.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><div id="messages"></div>');
global.window = dom.window;
global.document = dom.window.document;
global.pendingPermissions = new Map();
global.pendingPermissionsByConvo = new Map();
global.userScrolledUp = false;
global.esc = (t) => { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; };
global.escAttr = (t) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const permissions = require('../../public/permissions.js');
global.RundockPermissions = permissions;
global.RundockChatMarkup = require('../../public/chat-markup.js');
global.activeConversation = { id: 'c1' };
global.unread = { markPermission() {} };
global.updateUnreadBadge = () => {};
global.renderConvoList = () => {};
const convoStates = {};
global.getConvoState = (id) => (convoStates[id] = convoStates[id] || {});
const chat = require('../../public/views/chat.js');

const PATH = '/ws/.rundock/permissions.json';
function request(putBack, id = 'pb1') {
  return {
    request_id: id,
    request: {
      tool_name: 'WriteFile', input: { path: PATH, content: putBack.after, approvalKind: 'fileChange' },
      answer_file: true, resolved_path: PATH, grant_dir: null, crossings: [{ path: PATH, answerFile: true }],
      put_back: { relative: '.rundock/permissions.json', before: '{\n  "allowedTools": []\n}\n', after: '{\n  "allowedTools": ["Bash"]\n}\n', ...putBack },
    },
  };
}
function fresh() {
  document.getElementById('messages').innerHTML = '';
  global.pendingPermissions.clear();
  for (const k of Object.keys(convoStates)) delete convoStates[k];
}
const text = (el) => (el ? el.textContent.trim() : null);

describe('the card says what happened, and asks whether to keep the change', () => {
  test('a Claude Code agent\'s change', () => {
    fresh();
    chat.renderPermissionCard(request({ runtime: 'claude', outsideTurn: false }), 'c1');
    const card = document.querySelector('#perm-pb1 .permission-card');
    assert.ok(card, 'drawn');
    assert.strictEqual(text(card.querySelector('.permission-origin')), 'Claude Code, running in this conversation');
    assert.ok(!card.querySelector('.permission-origin').classList.contains('unattributed'));
    assert.strictEqual(text(card.querySelector('.permission-summary')), 'Rundock put back a change to your permission answers');
    assert.strictEqual(text(card.querySelector('.permission-context')),
      'Claude Code ran a command that changed .rundock/permissions.json, the file that holds your own answers about what agents may do. '
      + 'Rundock restored it straight away. Keep the agent\'s change instead?');
    assert.strictEqual(text(card.querySelector(':scope > code.permission-detail')), '.rundock/permissions.json');
    assert.strictEqual(text(card.querySelector('details.permission-detail-collapse > summary')), 'Show change');
    const lines = [...card.querySelectorAll('details .diff-line')].map((l) => [l.className.replace('diff-line ', ''), l.textContent]);
    assert.deepStrictEqual(lines, [['diff-ctx', '  {'], ['diff-del', '-   "allowedTools": []'], ['diff-add', '+   "allowedTools": ["Bash"]'], ['diff-ctx', '  }']]);
    const buttons = [...card.querySelectorAll('.permission-actions button')].map((b) => [b.className, b.textContent, b.dataset.permAction]);
    assert.deepStrictEqual(buttons, [
      ['btn-perm btn-leave-restored', 'Leave it restored', 'deny'],
      ['btn-perm btn-keep-change', 'Keep the change', 'allow'],
    ], 'the restore is the solid default on the left; keeping the change is the outlined override; nothing to remember');
  });

  test('a Codex agent\'s change names Codex', () => {
    fresh();
    chat.renderPermissionCard(request({ runtime: 'codex', outsideTurn: false }), 'c1');
    const card = document.querySelector('#perm-pb1 .permission-card');
    assert.strictEqual(text(card.querySelector('.permission-origin')), 'Codex, running in this conversation');
    assert.match(text(card.querySelector('.permission-context')), /^Codex ran a command that changed \.rundock\/permissions\.json,/);
  });

  test('a change made while no agent was running', () => {
    fresh();
    chat.renderPermissionCard(request({ runtime: 'claude', outsideTurn: true }), 'c1');
    const card = document.querySelector('#perm-pb1 .permission-card');
    const origin = card.querySelector('.permission-origin');
    assert.ok(origin.classList.contains('unattributed'), 'the existing "cannot say who" style');
    assert.strictEqual(text(origin), 'No agent was running when this happened');
    assert.strictEqual(text(card.querySelector('.permission-context')),
      '.rundock/permissions.json changed while no agent was running. Rundock restored it straight away. Keep that change instead?');
  });

  test('Leave it restored answers no, Keep the change answers yes, and neither is remembered', () => {
    for (const [cls, allow] of [['.btn-leave-restored', false], ['.btn-keep-change', true]]) {
      fresh();
      const sent = [];
      global.ws = { readyState: 1, send: (x) => sent.push(JSON.parse(x)) };
      global.WebSocket = { OPEN: 1 };
      try {
        chat.renderPermissionCard(request({ runtime: 'claude', outsideTurn: false }), 'c1');
        document.querySelector(`#perm-pb1 ${cls}`).click();
      } finally { global.ws = null; }
      const answer = sent.find((m) => m.type === 'permission_response');
      assert.strictEqual(answer.allow, allow, cls);
      assert.strictEqual(sent.filter((m) => m.type === 'add_tool_allow').length, 0, 'never remembered');
    }
  });
});

describe('it sits after the command and before the agent\'s reply', () => {
  test('text the agent had written stays above; what it writes next goes below', () => {
    fresh();
    const m = document.getElementById('messages');
    const bubble = document.createElement('div');
    bubble.className = 'msg msg-agent';
    bubble.innerHTML = '<div class="streaming-text">Checking the file.</div>';
    m.appendChild(bubble);
    Object.assign(getConvoState('c1'), { currentStreamingMsg: bubble, streamedText: 'Checking the file.' });
    chat.renderPermissionCard(request({ runtime: 'claude', outsideTurn: false }), 'c1');
    const kids = [...m.children];
    assert.strictEqual(kids[0], bubble, 'the words before the command');
    assert.strictEqual(kids[1].id, 'perm-pb1', 'then the card');
    const next = getConvoState('c1').currentStreamingMsg;
    assert.strictEqual(kids[2], next, 'then a new bubble for the reply');
    assert.ok(next !== bubble && next.querySelector('.streaming-text'));
    assert.strictEqual(chat.streamTextAfterCut(getConvoState('c1'), 'Checking the file. Rundock put it back.'), ' Rundock put it back.');
  });

  test('with nothing written yet, the card is simply next, and the reply follows it', () => {
    fresh();
    chat.renderPermissionCard(request({ runtime: 'claude', outsideTurn: false }), 'c1');
    assert.strictEqual(document.getElementById('messages').lastElementChild.id, 'perm-pb1');
    assert.strictEqual(chat.streamTextAfterCut(getConvoState('c1'), 'All of it.'), 'All of it.');
  });

  test('an ordinary card still goes above the reply being written, as before', () => {
    fresh();
    const m = document.getElementById('messages');
    const bubble = document.createElement('div');
    bubble.className = 'msg msg-agent';
    m.appendChild(bubble);
    getConvoState('c1').currentStreamingMsg = bubble;
    chat.renderPermissionCard({ request_id: 'o1', request: { tool_name: 'Bash', input: { command: 'npm publish' } } }, 'c1');
    assert.strictEqual(m.firstElementChild.id, 'perm-o1');
  });
});

describe('the change, shown line by line', () => {
  test('a whitespace-only change is visible', () => {
    const lines = permissions.putBackDiffLines('{\n}\n', '{\n} \n');
    assert.deepStrictEqual(lines.filter((l) => l.kind !== 'ctx').map((l) => l.text), ['}', '}·']);
  });
  test('a file that did not exist, or was removed', () => {
    assert.deepStrictEqual(permissions.putBackDiffLines(null, 'a\n').map((l) => l.kind), ['add']);
    assert.deepStrictEqual(permissions.putBackDiffLines('a\n', null).map((l) => l.kind), ['del']);
  });
  test('long unchanged stretches are folded', () => {
    const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    const after = before.replace('line 20', 'line twenty');
    const lines = permissions.putBackDiffLines(before, after);
    assert.ok(lines.length <= 8, `folded to the change and a little around it: ${lines.length}`);
    assert.ok(lines.some((l) => l.kind === 'gap'));
  });
});

test('the two buttons share the existing button declarations', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'styles', 'views', 'chat.css'), 'utf8');
  assert.match(css, /\.btn-allow,\s*\.btn-leave-restored\s*\{[^}]*background: var\(--success\)/);
  assert.match(css, /\.btn-deny,\s*\.btn-keep-change\s*\{[^}]*border-color: var\(--border-strong\)/);
});

test('the server passes the put-back details through to the browser', () => {
  // A server-originated request reaches the browser only with the fields the
  // server names; a field left off that list never arrives, and the card falls
  // back to an ordinary one.
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  const line = src.split('\n').find((l) => l.startsWith('const SERVER_REQUEST_FIELDS'));
  assert.ok(line, 'the list is found');
  assert.match(line, /'put_back'/);
});
