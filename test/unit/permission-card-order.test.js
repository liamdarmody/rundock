'use strict';
// AN APPROVAL BELONGS NEXT TO THE WORK IT INTERRUPTED.
//
// A streaming bubble takes its place in the message list when an agent STARTS
// speaking, and its final text is rendered back into that same element when
// the turn ends. Permission cards were appended, so a card raised mid-turn
// landed below a response that had not been written yet. Reported from real
// use: a specialist's conclusion followed by several approvals that had
// obviously been answered before she could have reached it.
//
// The response did not move; it was never positioned where it belonged. Its
// place records when she started talking and the reader takes it for when she
// finished.
//
// Inserting above the live bubble reads correctly and, unlike moving the
// finished message to the end, does not shift text a person is midway through
// reading.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { JSDOM } = require('jsdom');

let chat, dom;
before(() => {
  dom = new JSDOM('<div id="messages"></div>');
  global.window = dom.window;
  global.document = dom.window.document;
  global.pendingPermissions = new Map();
  global.pendingPermissionsByConvo = new Map();
  global.alwaysAllowedTools = new Set();
  global.ws = null;
  global.userScrolledUp = false;
  global.esc = (t) => { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; };
  global.escAttr = (t) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  global.RundockPermissions = require('../../public/permissions.js');
  global.RundockChatMarkup = require('../../public/chat-markup.js');
  chat = require('../../public/views/chat.js');
});
after(() => { if (dom) dom.window.close(); });

const REQUEST = { tool_name: 'Bash', input: { command: 'cat /etc/hosts' } };

/** The live response element, as the streaming path creates it. */
function liveBubble() {
  const m = document.getElementById('messages');
  const el = document.createElement('div');
  el.className = 'msg msg-agent';
  el.id = 'live-response';
  m.appendChild(el);
  return el;
}

function positions() {
  return [...document.getElementById('messages').children].map((el) => el.id || el.className);
}

describe('where an approval card lands', () => {
  test('above the response that is still being written', () => {
    document.getElementById('messages').innerHTML = '';
    global.pendingPermissions.clear();
    const live = liveBubble();
    global.getConvoState = () => ({ currentStreamingMsg: live });

    chat.renderPermissionCard({ request_id: 'ord-1', request: REQUEST }, 'convo-1');

    const order = positions();
    assert.ok(order.indexOf('perm-ord-1') < order.indexOf('live-response'),
      'the card rendered below a response that had not been written yet, so the '
      + `reader sees a conclusion followed by its own preconditions: ${order.join(' then ')}`);
  });

  test('several cards keep their own order above it', () => {
    document.getElementById('messages').innerHTML = '';
    global.pendingPermissions.clear();
    const live = liveBubble();
    global.getConvoState = () => ({ currentStreamingMsg: live });

    chat.renderPermissionCard({ request_id: 'ord-a', request: REQUEST }, 'convo-1');
    chat.renderPermissionCard({ request_id: 'ord-b', request: REQUEST }, 'convo-1');

    const order = positions();
    assert.ok(order.indexOf('perm-ord-a') < order.indexOf('perm-ord-b'),
      'two approvals must still read in the order they were asked');
    assert.ok(order.indexOf('perm-ord-b') < order.indexOf('live-response'));
  });

  test('at the end when nothing is being written', () => {
    document.getElementById('messages').innerHTML = '';
    global.pendingPermissions.clear();
    global.getConvoState = () => ({ currentStreamingMsg: null });
    const earlier = document.createElement('div');
    earlier.id = 'earlier-message';
    document.getElementById('messages').appendChild(earlier);

    chat.renderPermissionCard({ request_id: 'ord-2', request: REQUEST }, 'convo-1');

    const order = positions();
    assert.ok(order.indexOf('earlier-message') < order.indexOf('perm-ord-2'),
      'with no live response, a card belongs after what came before it');
  });

  test('and it renders even when the position cannot be worked out', () => {
    // Positioning must never be able to stop a card appearing. Its absence is
    // a decision the person never gets to make.
    document.getElementById('messages').innerHTML = '';
    global.pendingPermissions.clear();
    global.getConvoState = () => { throw new Error('state unavailable'); };

    chat.renderPermissionCard({ request_id: 'ord-3', request: REQUEST }, 'convo-1');
    assert.ok(document.getElementById('perm-ord-3'), 'the card is on screen regardless');
  });
});

describe('the advisory line actually reaches the card', () => {
  // THE WIRING, WHICH NOTHING EXERCISED. The scan was tested directly, the card
  // was tested with fixtures that never carried the field, and in between the
  // value was dropped twice: the server builds the request object from a
  // whitelist and never named it, and the client read it off the wrong object.
  // The feature computed a correct answer, sent it, and discarded it, while
  // every test stayed green. A scan whose output never reaches a person is an
  // unreachable component with a suite validating it.
  const REQ = {
    subtype: 'can_use_tool',
    tool_name: 'Bash',
    input: { command: 'python3 -c "print(open(\'/etc/hosts\').read())"' },
    advisory_outside_paths: ['/etc/hosts'],
  };

  test('the card says the command names a location outside the workspace', () => {
    document.getElementById('messages').innerHTML = '';
    global.pendingPermissions.clear();
    global.getConvoState = () => ({ currentStreamingMsg: null });

    chat.renderPermissionCard({ request_id: 'adv-1', request: REQ }, 'convo-1');

    const html = document.getElementById('messages').innerHTML;
    assert.match(html, /outside your workspace/,
      'the card asks whether a command may run without saying what it opens');
    assert.match(html, /etc.hosts/, 'and names the location, so the reader can judge it');
  });

  test('a command naming nothing outside gets no such line', () => {
    document.getElementById('messages').innerHTML = '';
    global.pendingPermissions.clear();
    global.getConvoState = () => ({ currentStreamingMsg: null });

    chat.renderPermissionCard({
      request_id: 'adv-2',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'npm run build' } },
    }, 'convo-1');

    const html = document.getElementById('messages').innerHTML;
    assert.ok(!/outside your workspace/.test(html),
      'a line that appears on every card teaches the reader to skip it');
  });

  test('the server names the field, or it never leaves the hook', () => {
    // The request object is a whitelist. A field the hook sends is dropped
    // unless it is listed, and that is how this arrived at the client empty.
    const fs = require('node:fs');
    const path = require('node:path');
    const router = fs.readFileSync(path.join(__dirname, '../../lib/http-router.js'), 'utf8');
    assert.match(router, /advisory_outside_paths: data\.advisory_outside_paths/,
      'the relay dropped it, so the card could never show it');
  });
});
