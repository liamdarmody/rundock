'use strict';
// Two identical requests, and one card that looked like both.
//
// A command the runtime sandbox refused is retried with the sandbox off, and
// that retry reaches the boundary card with no path: the operating system
// established the crossing, not a target anything could read. The card kept a
// second copy of the command beside the detail for the case where a path
// takes the command's place, and drew it here too, where no path had. So ONE
// request showed the same command twice, which reads as two requests folded
// into one card with nothing saying which one an answer settles.
//
// The rule this pins: two pending requests for the same command are two
// cards, each showing its command once, and answering one settles that one
// and only that one. The other stays pending and answerable.
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { JSDOM } = require('jsdom');

let chat, dom, sent;
before(() => {
  dom = new JSDOM('<div id="messages"></div>');
  global.window = dom.window;
  global.document = dom.window.document;
  global.pendingPermissions = new Map();
  global.pendingPermissionsByConvo = new Map();
  global.alwaysAllowedTools = new Set();
  global.userScrolledUp = false;
  global.esc = (t) => { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; };
  global.escAttr = (t) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  global.RundockPermissions = require('../../public/permissions.js');
  global.RundockChatMarkup = require('../../public/chat-markup.js');
  global.serverPlatform = 'darwin';
  global.workspaceMode = 'knowledge';
  chat = require('../../public/views/chat.js');
});
after(() => { if (dom) dom.window.close(); });
beforeEach(() => {
  document.getElementById('messages').innerHTML = '';
  global.pendingPermissions.clear();
  global.pendingPermissionsByConvo.clear();
  sent = [];
  global.ws = { send: (s) => sent.push(JSON.parse(s)) };
});

// The shape the live card carried: a long command with a description, which
// is what folds the detail behind a "Show command" toggle.
const COMMAND = 'sh scripts/apply-labels.sh messages batchModify --json \'{"ids":["a1","b2","c3","d4","e5"],"addLabelIds":["Label_1"]}\'';
function retry(id) {
  return {
    request_id: id,
    request: {
      subtype: 'can_use_tool', tool_name: 'Bash',
      input: { command: COMMAND, description: 'Apply triage labels', dangerouslyDisableSandbox: true },
      boundary: true, resolved_path: null, grant_dir: null, crossings: [],
    },
  };
}
const occurrences = (text, needle) => text.split(needle).length - 1;

describe('two identical pending requests', () => {
  test('one sandbox retry shows its command once, not twice', () => {
    chat.renderPermissionCard(retry('perm-one'), 'convo-1');
    const card = document.getElementById('perm-perm-one');
    assert.ok(card, 'the card rendered');
    assert.strictEqual(card.querySelectorAll('code.permission-detail').length, 1,
      'one command block on the card');
    assert.strictEqual(occurrences(card.textContent, COMMAND), 1, 'the command text appears once');
    assert.strictEqual(card.querySelectorAll('summary').length, 1, 'one "Show command" toggle');
  });

  test('two identical requests render as two cards, and one answer settles exactly one', () => {
    chat.renderPermissionCard(retry('perm-first'), 'convo-1');
    chat.renderPermissionCard(retry('perm-second'), 'convo-1');

    const cards = document.querySelectorAll('.msg-permission');
    assert.strictEqual(cards.length, 2, 'two requests, two cards');
    for (const card of cards) {
      assert.strictEqual(occurrences(card.textContent, COMMAND), 1, `${card.id} shows the command once`);
      assert.ok(card.querySelector('[data-perm-action="allow"]'), `${card.id} is answerable`);
    }

    // Answer the first, exactly as its Allow button does.
    document.querySelector('#perm-perm-first [data-perm-action="allow"]').click();

    assert.deepStrictEqual(sent.filter(m => m.type === 'permission_response').map(m => m.requestId), ['perm-first'],
      'one answer went to the server, for the request it was given on');
    assert.strictEqual(document.querySelector('#perm-perm-first [data-perm-action="allow"]'), null,
      'the answered card is settled');
    assert.ok(document.querySelector('#perm-perm-second [data-perm-action="allow"]'),
      'the other card is untouched and still answerable');
    assert.ok(global.pendingPermissions.has('perm-second'), 'and its request is still pending');
    assert.ok(!global.pendingPermissions.has('perm-first'));
  });

  test('a crossing with a path still keeps the command beside it', () => {
    // The case the second copy exists for: the path answers "where", only the
    // command answers "what", and both are shown.
    chat.renderPermissionCard({
      request_id: 'perm-path',
      request: {
        subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'touch /etc/probe' },
        boundary: true, resolved_path: '/etc/probe', grant_dir: '/etc', crossings: [{ path: '/etc/probe' }],
      },
    }, 'convo-1');
    const card = document.getElementById('perm-perm-path');
    assert.match(card.textContent, /\/etc\/probe/);
    assert.match(card.textContent, /touch \/etc\/probe/);
    assert.match(card.innerHTML, /Show command/);
  });
});
