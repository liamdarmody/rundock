'use strict';
// Who asked, and a click that lands as a card appears.
//
// TWO AGENTS, ONE CONVERSATION. With a lead and the agent it handed work to
// both asking in the same thread, a card that said nothing about who asked
// left the person to guess which agent they were answering. And a card that
// arrived, or slid up as the one above it settled, sat where the second click
// of a double-click was already going: one card answered with a click meant
// for another.
//
// What is pinned here, through the real card code under jsdom with the clock
// under the test's control:
//   - a conversation card names the agent that asked, from `_agent` alone,
//     with that agent's avatar, in the thread and in the approvals dock
//   - an agent the page does not know, and a card with no `_agent`, draw no
//     line; routine, unattributed and put-back cards keep their own lines
//   - every button on a card waits half a second after the card is drawn, and
//     again whenever another card in the same place arrives, settles or
//     leaves; while it waits it is aria-disabled, never disabled, and a
//     pointer or keyboard click on it sends nothing
//   - a pending card also waits again whenever anything else moves it on
//     screen (a streamed reply, the thread following the bottom, a scroll, a
//     window resize), and one that stays where it was keeps taking clicks
//   - the waiting look is one opacity rule, with nothing that moves or resizes
const { test, describe, before, after, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf-8');

const WREN = { id: 'wren', displayName: 'Wren', colour: '#2f7d5b', icon: 'W' };
const ASH = { id: 'ash', displayName: 'Ash', colour: '#7a4bd1', icon: 'A' };

// The dock exactly as index.html declares it.
function dockMarkup() {
  const shell = new JSDOM(INDEX_SRC).window.document.getElementById('approvals-dock');
  assert.ok(shell, 'index.html declares the approvals dock');
  return shell.outerHTML;
}

let chat, dom, sent, convoStates;
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
  global.agents = [WREN, ASH];
  global.updateUnreadBadge = () => {};
  global.renderConvoList = () => {};
  global.getConvoState = (id) => (convoStates[id] = convoStates[id] || {});
  chat = require('../../public/views/chat.js');
});
after(() => { if (dom) dom.window.close(); });
beforeEach(() => {
  // The card code calls the bare setTimeout, so the mocked one is what it gets.
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  document.getElementById('messages').innerHTML = '';
  document.querySelector('.approvals-dock-list').innerHTML = '';
  global.pendingPermissions.clear();
  global.pendingPermissionsByConvo.clear();
  global.activeConversation = { id: 'c-open' };
  global.conversations = [];
  // Code mode counts no ordinary command toward the repeat hint, so no hint is
  // drawn unless a test asks for one.
  global.workspaceMode = 'code';
  convoStates = {};
  sent = [];
  global.unread = { markPermission() {}, resolvePermission() {} };
  global.ws = { send: (s) => sent.push(JSON.parse(s)) };
});
afterEach(() => { mock.timers.reset(); });

let seq = 0;
const nextId = () => `asked-${++seq}`;
function request(id, extra, command) {
  return Object.assign({
    type: 'control_request', request_id: id,
    request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: command || 'node tools/build.js' } },
    _conversationId: 'c-open', _agent: 'wren',
  }, extra || {});
}
const PB_PATH = '/ws/.rundock/permissions.json';
function putBackRequest(id, extra) {
  return Object.assign({
    type: 'control_request', request_id: id,
    request: {
      subtype: 'can_use_tool', tool_name: 'WriteFile', input: { path: PB_PATH, content: '{}', approvalKind: 'fileChange' },
      answer_file: true, resolved_path: PB_PATH, grant_dir: null, crossings: [{ path: PB_PATH, answerFile: true }],
      put_back: { runtime: 'claude', outsideTurn: false, relative: '.rundock/permissions.json', before: '{}\n', after: '{"allowedTools":["Bash"]}\n' },
    },
    _conversationId: 'c-open', _agent: 'wren',
  }, extra || {});
}

const dockList = () => document.querySelector('.approvals-dock-list');
const card = (id) => document.getElementById('perm-' + id);
function button(id, action) {
  const b = document.querySelector(`#perm-${id} [data-perm-action="${action}"]`);
  assert.ok(b, `card ${id} has its ${action} button`);
  return b;
}
const actionsOf = (id) => [...card(id).querySelectorAll('[data-perm-action]')].map(b => b.dataset.permAction);
const responses = () => sent.filter(m => m.type === 'permission_response');
const answered = () => responses().map(m => m.requestId);
const collapse = (t) => t.replace(/\s+/g, ' ').trim();
function originLine(id) {
  const lines = card(id).querySelectorAll('.permission-origin');
  assert.strictEqual(lines.length, 1, `card ${id} draws one origin line`);
  return lines[0];
}
// Asserted before a test leans on the page's card wait, so a page without one
// fails here, on an assertion, rather than on a property of undefined.
function waitExists() {
  assert.ok(chat.cardArming && typeof chat.cardArming === 'object', 'the page exposes its card wait');
  assert.strictEqual(chat.cardArming.ms, 500, 'half a second');
}
function lineDrawerExists() {
  assert.strictEqual(typeof RundockChatMarkup.askedByHtml, 'function', 'the page has the asked-by line to draw');
}

// Where a card can be drawn. The dock is reached through renderPermissionCard
// with the dock as host, the only way a conversation's card gets there.
const HOSTS = [
  ['in the thread', (d) => chat.handlePermissionRequest(d, d._conversationId)],
  ['in the approvals dock', (d) => chat.renderPermissionCard(d, d._conversationId, dockList())],
];

describe('a conversation card names the agent that asked', () => {
  for (const [where, draw] of HOSTS) {
    test(`${where}: one line, a decorative avatar then "Asked by Wren"`, () => {
      lineDrawerExists();
      const id = nextId();
      draw(request(id));
      const line = originLine(id);
      assert.strictEqual(collapse(line.textContent), 'Asked by Wren');
      assert.deepStrictEqual([...line.classList], ['permission-origin'], 'no class from the risk or the agent');
      assert.ok(!line.hasAttribute('style'), 'the line takes no colour of its own');
      const avatar = line.firstElementChild;
      assert.ok(avatar && avatar.classList.contains('avatar'), 'the avatar comes first');
      assert.strictEqual(avatar.getAttribute('aria-hidden'), 'true', 'and is decorative');
      assert.strictEqual(avatar.dataset.icon, 'W');
      const words = avatar.nextElementSibling;
      assert.strictEqual(words.textContent, 'Asked by Wren');
      assert.ok(!words.hasAttribute('style'), 'the words take no colour from the agent');
      const box = card(id).querySelector('.permission-card');
      assert.ok(box.classList.contains('risk-medium'), 'the card keeps its risk class');
      assert.strictEqual(box.firstElementChild, line, 'in the origin slot');
      assert.ok(line.nextElementSibling.classList.contains('permission-header'), 'above the header');
    });
  }

  test('a high-risk card keeps its class, and the line is the same', () => {
    lineDrawerExists();
    const id = nextId();
    chat.handlePermissionRequest(request(id, {}, 'rm -rf build'), 'c-open');
    assert.ok(card(id).querySelector('.permission-card').classList.contains('risk-high'));
    assert.strictEqual(collapse(originLine(id).textContent), 'Asked by Wren');
  });

  test('the name comes from _agent alone: not the active agent, the conversation\'s agent, the input or a body field', () => {
    lineDrawerExists();
    convoStates['c-open'] = { activeAgentId: 'ash' };
    global.conversations = [{ id: 'c-open', agentId: 'ash', messages: [] }];
    const id = nextId();
    chat.handlePermissionRequest(request(id, {
      agent: 'ash', agentId: 'ash',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'node tools/build.js --as ash', description: 'Ash builds the site', agent: 'ash' } },
    }), 'c-open');
    const line = originLine(id);
    assert.strictEqual(collapse(line.textContent), 'Asked by Wren');
    assert.ok(!/Ash/.test(line.textContent));
  });
});

describe('no line where no agent can be named', () => {
  test('an agent the page does not know draws no line, with no guessed name or raw id, while a known one beside it does', () => {
    lineDrawerExists();
    const known = nextId();
    chat.handlePermissionRequest(request(known), 'c-open');
    assert.strictEqual(collapse(originLine(known).textContent), 'Asked by Wren', 'the lookup works');
    const unknown = nextId();
    chat.handlePermissionRequest(request(unknown, { _agent: 'ghost-agent' }), 'c-open');
    assert.ok(card(unknown), 'the card is drawn');
    assert.strictEqual(card(unknown).querySelector('.permission-origin'), null, 'its origin slot is empty, as before');
    assert.ok(!card(unknown).textContent.includes('ghost-agent'), 'no raw id');
    assert.doesNotMatch(card(unknown).textContent, /Asked by/);
  });

  test('a card with no _agent draws no line: a team change, a connector change, an ordinary command', () => {
    lineDrawerExists();
    const known = nextId();
    chat.handlePermissionRequest(request(known), 'c-open');
    assert.strictEqual(collapse(originLine(known).textContent), 'Asked by Wren', 'the lookup works');
    const bare = (id, req) => ({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', ...req }, _conversationId: 'c-open' });
    const team = nextId();
    chat.renderPermissionCard(bare(team, { tool_name: 'SaveAgent', input: { kind: 'agent', action: 'add', name: 'helper', file: '.claude/agents/helper.md', by: 'Lead', content: '---\nname: helper\n---\n\nYou help.' } }), 'c-open');
    const connector = nextId();
    chat.renderPermissionCard(bare(connector, { tool_name: 'SaveConnector', input: { name: 'local-tools', action: 'add', command: 'node', args: ['tools/server.js'] } }), 'c-open');
    const plain = nextId();
    chat.renderPermissionCard(bare(plain, { tool_name: 'Bash', input: { command: 'node tools/build.js' } }), 'c-open');
    for (const id of [team, connector, plain]) {
      assert.ok(card(id), `card ${id} is drawn`);
      assert.strictEqual(card(id).querySelector('.permission-origin'), null, `card ${id} has no origin line`);
    }
  });
});

describe('routine, unattributed and put-back cards keep their own lines', () => {
  test('a routine card keeps "<Routine>, run by <Agent>", even carrying an _agent', () => {
    lineDrawerExists();
    const known = nextId();
    chat.handlePermissionRequest(request(known), 'c-open');
    assert.strictEqual(collapse(originLine(known).textContent), 'Asked by Wren', 'a conversation card beside it is named');
    const id = nextId();
    chat.handleOwnerlessPermissionRequest(request(id, { _conversationId: '', _run: { id: 'run-1', routine: 'Weekly Summary', agent: 'ash' } }));
    assert.strictEqual(collapse(originLine(id).textContent), 'Weekly Summary, run by Ash');
    assert.strictEqual(originLine(id).querySelector('.avatar'), null);
  });

  test('an unattributed card keeps its own line, even carrying an _agent', () => {
    lineDrawerExists();
    const known = nextId();
    chat.handlePermissionRequest(request(known), 'c-open');
    assert.strictEqual(collapse(originLine(known).textContent), 'Asked by Wren', 'a conversation card beside it is named');
    const id = nextId();
    chat.handleOwnerlessPermissionRequest(request(id, { _conversationId: '' }));
    assert.strictEqual(collapse(originLine(id).textContent), 'Unattributed: no conversation or routine could be matched to this request');
    assert.ok(originLine(id).classList.contains('unattributed'));
  });

  test('a put-back card keeps its line, even carrying an _agent', () => {
    lineDrawerExists();
    const known = nextId();
    chat.handlePermissionRequest(request(known), 'c-open');
    assert.strictEqual(collapse(originLine(known).textContent), 'Asked by Wren', 'a conversation card beside it is named');
    const id = nextId();
    chat.handlePermissionRequest(putBackRequest(id), 'c-open');
    assert.deepStrictEqual(actionsOf(id), ['deny', 'allow'], 'the put-back card');
    assert.strictEqual(collapse(originLine(id).textContent), 'Claude Code, running in this conversation');
    assert.doesNotMatch(card(id).textContent, /Asked by/);
  });

  test('who a request belongs to still has three kinds, and _agent adds none', () => {
    lineDrawerExists();
    const own = RundockPermissions.permissionOwner;
    assert.deepStrictEqual(own({ _conversationId: 'c-open', _agent: 'wren' }), { kind: 'conversation', convoId: 'c-open' });
    assert.deepStrictEqual(own({ _run: { id: 'run-1' }, _agent: 'wren' }), { kind: 'routine', run: { id: 'run-1' } });
    assert.deepStrictEqual(own({ _agent: 'wren' }), { kind: 'unattributed' });
  });
});

describe('two agents asking in one conversation', () => {
  for (const [where, draw] of HOSTS) {
    test(`${where}: each card names its own agent, and answering one leaves the other waiting with its own name and buttons`, () => {
      lineDrawerExists();
      waitExists();
      const w = nextId();
      const a = nextId();
      draw(request(w));
      draw(request(a, { _agent: 'ash' }, 'python3 tools/report.py'));
      assert.strictEqual(collapse(originLine(w).textContent), 'Asked by Wren');
      assert.strictEqual(collapse(originLine(a).textContent), 'Asked by Ash');
      mock.timers.tick(500);
      button(w, 'allow').click();
      assert.deepStrictEqual(answered(), [w], 'only the card clicked is answered');
      assert.ok(!global.pendingPermissions.has(w));
      assert.ok(global.pendingPermissions.has(a), 'the other still waits');
      assert.strictEqual(collapse(originLine(a).textContent), 'Asked by Ash');
      assert.deepStrictEqual(actionsOf(a), ['allow', 'always', 'deny']);
      mock.timers.tick(500);
      button(a, 'deny').click();
      assert.deepStrictEqual(responses().map(r => [r.requestId, r.allow]), [[w, true], [a, false]]);
    });
  }
});

describe('a card waits half a second before it takes a click', () => {
  for (const [where, draw] of HOSTS) {
    test(`a permission card ${where}: every button sends nothing at 0 ms or 499 ms, and answers at 500 ms`, () => {
      waitExists();
      const id = nextId();
      draw(request(id));
      const actions = actionsOf(id);
      assert.deepStrictEqual(actions, ['allow', 'always', 'deny']);
      for (const act of actions) button(id, act).click();
      assert.deepStrictEqual(responses(), [], 'nothing at 0 ms');
      mock.timers.tick(499);
      for (const act of actions) button(id, act).click();
      assert.deepStrictEqual(responses(), [], 'nothing at 499 ms');
      mock.timers.tick(1);
      button(id, 'deny').click();
      assert.deepStrictEqual(responses().map(r => [r.requestId, r.allow]), [[id, false]]);
    });

    test(`a put-back card ${where}: both buttons send nothing at 0 ms or 499 ms, and answer at 500 ms`, () => {
      waitExists();
      const id = nextId();
      draw(putBackRequest(id));
      assert.deepStrictEqual(actionsOf(id), ['deny', 'allow']);
      button(id, 'deny').click();
      button(id, 'allow').click();
      assert.deepStrictEqual(responses(), [], 'nothing at 0 ms');
      mock.timers.tick(499);
      button(id, 'deny').click();
      button(id, 'allow').click();
      assert.deepStrictEqual(responses(), [], 'nothing at 499 ms');
      mock.timers.tick(1);
      button(id, 'deny').click();
      assert.deepStrictEqual(responses().map(r => [r.requestId, r.allow]), [[id, false]]);
    });
  }

  test('a waiting button keeps its place: aria-disabled, never disabled, still focusable, and neither a pointer nor a keyboard click answers', () => {
    waitExists();
    const id = nextId();
    chat.handlePermissionRequest(request(id), 'c-open');
    const buttons = [...card(id).querySelectorAll('.btn-perm')];
    assert.strictEqual(buttons.length, 3);
    for (const b of buttons) {
      assert.strictEqual(b.getAttribute('aria-disabled'), 'true');
      assert.ok(!b.hasAttribute('disabled'), 'never disabled');
      b.focus();
      assert.strictEqual(document.activeElement, b, 'it still takes the focus, so it stays in the tab order');
      b.click();
      // Enter or Space on a focused button fires a click with no pointer detail.
      b.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
    }
    assert.deepStrictEqual(responses(), [], 'nothing sent');
    assert.ok(global.pendingPermissions.has(id), 'the card is still pending');
    assert.deepStrictEqual(actionsOf(id), ['allow', 'always', 'deny'], 'with its buttons');
    mock.timers.tick(500);
    for (const b of buttons) assert.ok(!b.hasAttribute('aria-disabled'), 'the mark goes when the wait ends');
    button(id, 'allow').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
    assert.deepStrictEqual(answered(), [id], 'then a keyboard click answers');
  });
});

describe('a card waits again when another card in the same place moves it', () => {
  test('in the thread, a card inserted above it makes it wait again', () => {
    waitExists();
    const m = document.getElementById('messages');
    const live = document.createElement('div');
    live.className = 'msg msg-agent';
    m.appendChild(live);
    const later = nextId();
    chat.handlePermissionRequest(request(later), 'c-open');
    assert.strictEqual(live.nextElementSibling, card(later), 'drawn below the bubble while none is live');
    mock.timers.tick(500);
    convoStates['c-open'].currentStreamingMsg = live;
    const inserted = nextId();
    chat.handlePermissionRequest(request(inserted, { _agent: 'ash' }, 'python3 tools/report.py'), 'c-open');
    assert.strictEqual(card(inserted).nextElementSibling, live, 'the new card goes above the live bubble, above the first');
    button(later, 'allow').click();
    assert.deepStrictEqual(responses(), [], 'the card pushed down waits again');
    mock.timers.tick(499);
    button(later, 'allow').click();
    assert.deepStrictEqual(responses(), []);
    mock.timers.tick(1);
    button(later, 'allow').click();
    assert.deepStrictEqual(answered(), [later]);
  });

  test('in the thread, a card above it that is answered and settles makes it wait again', () => {
    waitExists();
    const first = nextId();
    const second = nextId();
    chat.handlePermissionRequest(request(first), 'c-open');
    chat.handlePermissionRequest(request(second, { _agent: 'ash' }, 'python3 tools/report.py'), 'c-open');
    mock.timers.tick(500);
    button(first, 'allow').click();
    button(second, 'allow').click();
    assert.deepStrictEqual(answered(), [first], 'the second click of the pair sends nothing');
    mock.timers.tick(499);
    button(second, 'allow').click();
    assert.deepStrictEqual(answered(), [first]);
    mock.timers.tick(1);
    button(second, 'allow').click();
    assert.deepStrictEqual(answered(), [first, second]);
  });

  test('in the thread, a card above it that ends without an answer makes it wait again', () => {
    waitExists();
    const first = nextId();
    const second = nextId();
    chat.handlePermissionRequest(request(first), 'c-open');
    chat.handlePermissionRequest(request(second, { _agent: 'ash' }, 'python3 tools/report.py'), 'c-open');
    mock.timers.tick(500);
    chat.endPermissionRequest(first, 'timeout');
    assert.ok(!card(first).querySelector('.btn-perm'), 'the first has settled');
    button(second, 'allow').click();
    assert.deepStrictEqual(responses(), []);
    mock.timers.tick(500);
    button(second, 'allow').click();
    assert.deepStrictEqual(answered(), [second]);
  });

  test('in the dock, a click on the first card\'s Allow then at once on the second\'s answers only the first; the second answers 500 ms later', () => {
    waitExists();
    const first = nextId();
    const second = nextId();
    chat.renderPermissionCard(request(first), 'c-open', dockList());
    chat.renderPermissionCard(request(second, { _agent: 'ash' }, 'python3 tools/report.py'), 'c-open', dockList());
    mock.timers.tick(500);
    button(first, 'allow').click();
    button(second, 'allow').click();
    assert.deepStrictEqual(answered(), [first]);
    assert.ok(global.pendingPermissions.has(second), 'the second still waits');
    mock.timers.tick(499);
    button(second, 'allow').click();
    assert.deepStrictEqual(answered(), [first]);
    mock.timers.tick(1);
    button(second, 'allow').click();
    assert.deepStrictEqual(answered(), [first, second]);
  });

  test('in the dock, a settled card leaving makes the card after it wait again', () => {
    waitExists();
    const first = nextId();
    const second = nextId();
    chat.renderPermissionCard(request(first), 'c-open', dockList());
    chat.renderPermissionCard(request(second, { _agent: 'ash' }, 'python3 tools/report.py'), 'c-open', dockList());
    mock.timers.tick(500);
    button(first, 'allow').click();
    mock.timers.tick(3999);
    assert.ok(card(first), 'the settled card is still there to be read');
    assert.ok(!button(second, 'allow').hasAttribute('aria-disabled'), 'and the one after it has finished waiting');
    mock.timers.tick(1);
    assert.strictEqual(card(first), null, 'the settled card leaves');
    button(second, 'allow').click();
    assert.deepStrictEqual(answered(), [first], 'the click as it leaves sends nothing');
    mock.timers.tick(499);
    button(second, 'allow').click();
    assert.deepStrictEqual(answered(), [first]);
    mock.timers.tick(1);
    button(second, 'allow').click();
    assert.deepStrictEqual(answered(), [first, second]);
  });

  test('in the dock, which grows upward, a card arriving below makes the one above it wait again', () => {
    waitExists();
    const first = nextId();
    chat.renderPermissionCard(request(first), 'c-open', dockList());
    mock.timers.tick(500);
    chat.renderPermissionCard(request(nextId(), { _agent: 'ash' }, 'python3 tools/report.py'), 'c-open', dockList());
    button(first, 'allow').click();
    assert.deepStrictEqual(responses(), []);
    mock.timers.tick(500);
    button(first, 'allow').click();
    assert.deepStrictEqual(answered(), [first]);
  });

  test('a repeat hint the person dismisses takes its space with it, so the cards around it wait again', () => {
    waitExists();
    global.workspaceMode = 'knowledge';
    global.activeConversation = { id: 'c-hint' };
    const ids = ['npm install sharp', 'mkdir -p src/components', 'git checkout -b feature'].map((cmd) => {
      const id = nextId();
      chat.handlePermissionRequest(request(id, { _conversationId: 'c-hint' }, cmd), 'c-hint');
      return id;
    });
    const hint = document.querySelector('#messages .repeat-hint');
    assert.ok(hint, 'the third card brings the hint');
    mock.timers.tick(500);
    hint.querySelector('.repeat-hint-x').click();
    assert.strictEqual(document.querySelector('.repeat-hint'), null, 'dismissed');
    for (const id of ids) button(id, 'allow').click();
    assert.deepStrictEqual(responses(), []);
    mock.timers.tick(500);
    button(ids[2], 'allow').click();
    assert.deepStrictEqual(answered(), [ids[2]]);
  });
});

describe('a card waits again whenever it moves on screen, whatever moved it', () => {
  // jsdom lays nothing out: every element reports a top of 0 and nothing
  // scrolls by itself. So each test says where a card sits, before and after
  // it moves, and fires the scroll or the resize itself. A MutationObserver
  // calls back in a microtask, which the mocked clock does not run, so a test
  // lets one pass after a write and before it clicks. A test that checks a
  // write with no scroll lets the callbacks already queued (the card's own
  // drawing, its wait ending) pass first, so only that write can move it.
  const tops = new Map();
  let layout;
  beforeEach(() => {
    tops.clear();
    layout = dom.window.Element.prototype.getBoundingClientRect;
    dom.window.Element.prototype.getBoundingClientRect = function () {
      const top = tops.get(this.id) || 0;
      return { top, bottom: top + 120, left: 0, right: 640, width: 640, height: 120, x: 0, y: top };
    };
  });
  afterEach(() => { dom.window.Element.prototype.getBoundingClientRect = layout; });
  const sitAt = (id, top) => tops.set('perm-' + id, top);
  const thread = () => document.getElementById('messages');
  const scrolled = (el) => el.dispatchEvent(new dom.window.Event('scroll'));
  const writesSeen = () => Promise.resolve();
  // Another agent's reply as the page streams one: a bubble appended to the
  // thread, whose .streaming-text is rewritten with each chunk.
  function streamingText(agent) {
    const el = document.createElement('div');
    el.className = 'msg msg-agent';
    el.innerHTML = RundockChatMarkup.agentStreamingMessageHtml(agent, '', '');
    thread().appendChild(el);
    return el.querySelector('.streaming-text');
  }
  // The person scrolled up, so the thread stops following the bottom.
  function scrolledUp(fn) {
    global.userScrolledUp = true;
    return Promise.resolve().then(fn).finally(() => { global.userScrolledUp = false; });
  }
  // From the moment it moved: a click at 0 ms and at 499 ms sends nothing, and
  // one at 500 ms answers.
  function waitsFromNow(id) {
    const before = answered();
    button(id, 'allow').click();
    assert.deepStrictEqual(answered(), before, 'nothing at 0 ms after the move');
    mock.timers.tick(499);
    button(id, 'allow').click();
    assert.deepStrictEqual(answered(), before, 'nothing at 499 ms after the move');
    mock.timers.tick(1);
    button(id, 'allow').click();
    assert.deepStrictEqual(answered(), [...before, id], 'one answer at 500 ms');
  }

  test('two agents in one conversation: the other agent\'s streamed reply moves a card pending past 500 ms, and it takes no click until 500 ms after the move', async () => {
    waitExists();
    const id = nextId();
    sitAt(id, 420);
    chat.handlePermissionRequest(request(id), 'c-open');
    assert.strictEqual(collapse(originLine(id).textContent), 'Asked by Wren');
    mock.timers.tick(800);
    assert.ok(!button(id, 'allow').hasAttribute('aria-disabled'), 'pending past 500 ms, it takes a click');
    // Ash's reply streams in below it, written as the page writes each chunk,
    // and the thread follows the bottom, so the card slides up.
    streamingText(ASH).innerHTML = 'Running the report now.<br>Three files changed.';
    chat.scrollBottom();
    sitAt(id, 356);
    scrolled(thread());
    await writesSeen();
    waitsFromNow(id);
  });

  for (const [where, draw] of HOSTS) {
    test(`${where}, a scroll alone that changes a card's top makes it wait again`, () => {
      waitExists();
      const id = nextId();
      sitAt(id, 500);
      draw(request(id));
      mock.timers.tick(500);
      sitAt(id, 380);
      scrolled(card(id).parentNode);
      waitsFromNow(id);
    });
  }

  for (const [kind, write, movedTo] of [
    ['a reply rewritten longer', (text) => { text.innerHTML = 'The plan, in three steps:<br>one<br>two<br>three'; }, 260],
    ['a status line\'s characters changed', (text) => { text.firstChild.data = 'Reading tools/report.py and two more files'; }, 230],
    ['a line above it folded away', (text) => { text.closest('.msg').hidden = true; }, 140],
  ]) {
    test(`a change above a card, with no scroll, that moves it makes it wait again: ${kind}`, async () => {
      waitExists();
      const above = streamingText(ASH);
      above.textContent = 'Reading';
      const id = nextId();
      sitAt(id, 200);
      chat.handlePermissionRequest(request(id), 'c-open');
      mock.timers.tick(500);
      await writesSeen();
      write(above);
      sitAt(id, movedTo);
      await writesSeen();
      waitsFromNow(id);
    });
  }

  test('a stream write and a scroll that leave a card where it was leave it armed, and a click answers at once', () => scrolledUp(async () => {
    waitExists();
    const id = nextId();
    sitAt(id, 240);
    chat.handlePermissionRequest(request(id), 'c-open');
    mock.timers.tick(500);
    streamingText(ASH).innerHTML = 'More of the reply, written below the card.';
    chat.scrollBottom();
    scrolled(thread());
    await writesSeen();
    assert.ok(!button(id, 'allow').hasAttribute('aria-disabled'), 'still armed');
    button(id, 'allow').click();
    assert.deepStrictEqual(answered(), [id], 'answered at once');
  }));

  test('a second move during the wait starts it again: moved at t and at t+300 ms, it sends nothing at t+799 ms and answers at t+800 ms', () => {
    waitExists();
    const id = nextId();
    sitAt(id, 600);
    chat.handlePermissionRequest(request(id), 'c-open');
    mock.timers.tick(500);
    sitAt(id, 540);
    scrolled(thread());
    mock.timers.tick(300);
    button(id, 'allow').click();
    assert.deepStrictEqual(responses(), [], 'nothing at t+300 ms');
    sitAt(id, 480);
    scrolled(thread());
    mock.timers.tick(499);
    button(id, 'allow').click();
    assert.deepStrictEqual(responses(), [], 'nothing at t+799 ms');
    mock.timers.tick(1);
    button(id, 'allow').click();
    assert.deepStrictEqual(answered(), [id], 'answered at t+800 ms');
  });

  test('only the card that moved waits: a reply growing between two cards moves the lower one, and the upper one still answers at once', () => scrolledUp(async () => {
    waitExists();
    const upper = nextId();
    sitAt(upper, 120);
    chat.handlePermissionRequest(request(upper), 'c-open');
    const between = streamingText(ASH);
    const lower = nextId();
    sitAt(lower, 400);
    chat.handlePermissionRequest(request(lower, { _agent: 'ash' }, 'python3 tools/report.py'), 'c-open');
    mock.timers.tick(500);
    await writesSeen();
    between.innerHTML = 'A longer reply<br>that pushes what is under it down';
    sitAt(lower, 470);
    await writesSeen();
    button(lower, 'allow').click();
    assert.deepStrictEqual(responses(), [], 'the card that moved sends nothing');
    button(upper, 'allow').click();
    assert.deepStrictEqual(answered(), [upper], 'the card that stayed answers at once');
    mock.timers.tick(499);
    button(lower, 'allow').click();
    assert.deepStrictEqual(answered(), [upper], 'nothing from the moved card at 499 ms');
    mock.timers.tick(1);
    button(lower, 'allow').click();
    assert.deepStrictEqual(answered(), [upper, lower], 'it answers at 500 ms');
  }));

  test('after a move, the new place is the reference: a card that moved and waited it out stays armed through a change that leaves it there', () => scrolledUp(async () => {
    waitExists();
    const id = nextId();
    sitAt(id, 300);
    chat.handlePermissionRequest(request(id), 'c-open');
    mock.timers.tick(500);
    sitAt(id, 240);
    scrolled(thread());
    button(id, 'allow').click();
    assert.deepStrictEqual(responses(), [], 'the move makes it wait');
    mock.timers.tick(500);
    assert.ok(!button(id, 'allow').hasAttribute('aria-disabled'), 'it has waited it out');
    streamingText(ASH).innerHTML = 'A reply written below it.';
    scrolled(thread());
    await writesSeen();
    assert.ok(!button(id, 'allow').hasAttribute('aria-disabled'), 'it stays armed where it moved to');
    button(id, 'allow').click();
    assert.deepStrictEqual(answered(), [id], 'and a click answers at once');
  }));

  for (const [where, draw] of HOSTS) {
    test(`${where}, a window resize that changes a card's top makes it wait again`, () => {
      waitExists();
      const id = nextId();
      sitAt(id, 520);
      draw(request(id));
      mock.timers.tick(500);
      sitAt(id, 470);
      dom.window.dispatchEvent(new dom.window.Event('resize'));
      waitsFromNow(id);
    });
  }

  test('a settled card is left alone: a change that moves it beside a pending card marks nothing on it and sends nothing, while the pending card waits', async () => {
    waitExists();
    const above = streamingText(ASH);
    const settled = nextId();
    const pending = nextId();
    sitAt(settled, 200);
    sitAt(pending, 420);
    chat.handlePermissionRequest(request(settled), 'c-open');
    chat.handlePermissionRequest(request(pending, { _agent: 'ash' }, 'python3 tools/report.py'), 'c-open');
    mock.timers.tick(500);
    button(settled, 'allow').click();
    assert.deepStrictEqual(answered(), [settled]);
    assert.ok(!card(settled).querySelector('.btn-perm'), 'it has settled');
    mock.timers.tick(500);
    await writesSeen();
    above.innerHTML = 'A reply above both cards<br>that grows';
    sitAt(settled, 260);
    sitAt(pending, 480);
    await writesSeen();
    assert.strictEqual(card(settled).querySelector('[aria-disabled]'), null, 'nothing on the settled card is marked');
    assert.ok(!card(settled).hasAttribute('aria-disabled'));
    for (const el of card(settled).querySelectorAll('*')) el.click();
    assert.deepStrictEqual(answered(), [settled], 'a click on it sends nothing');
    waitsFromNow(pending);
  });
});

describe('the waiting look', () => {
  // Every rule in the app's stylesheets, read as selector -> declarations.
  function rulesNaming(...fragments) {
    const found = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.css')) continue;
        const css = fs.readFileSync(full, 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/@media[^{]*\{((?:[^{}]*\{[^{}]*\})*)\s*\}/g, '$1');
        const re = /([^{}]+)\{([^{}]*)\}/g;
        let r;
        while ((r = re.exec(css))) {
          if (!fragments.every(f => r[1].includes(f))) continue;
          const decls = {};
          for (const d of r[2].split(';')) {
            const k = d.indexOf(':');
            if (k > 0) decls[d.slice(0, k).trim()] = d.slice(k + 1).trim();
          }
          found.push({ file: path.relative(ROOT, full).split(path.sep).join('/'), selector: r[1].trim(), decls });
        }
      }
    };
    walk(path.join(ROOT, 'public', 'styles'));
    return found;
  }

  test('one rule, opacity 0.5, and nothing that moves or resizes the button', () => {
    const rules = rulesNaming('.btn-perm', 'aria-disabled');
    assert.deepStrictEqual(rules, [{
      file: 'public/styles/views/chat.css',
      selector: '.btn-perm[aria-disabled="true"]',
      decls: { opacity: '0.5' },
    }]);
    for (const banned of ['animation', 'transform', 'padding', 'border', 'font-size', 'transition']) {
      assert.ok(!Object.keys(rules[0].decls).some(k => k.startsWith(banned)), `no ${banned}`);
    }
  });
});
