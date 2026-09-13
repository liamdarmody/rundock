'use strict';
// THE CLIENT HALF OF A STANDING ALLOW, end to end in one place.
//
// The server half is proven elsewhere (boundary.test.js for the store,
// protocol-handlers-lib.test.js for the handlers). Neither says anything about
// whether the answer ever reaches the decision that asks the question, and the
// first review of this card found exactly that gap: every piece worked, and the
// wire between them was never run.
//
// Three of the four defects those tests now pin were live in the browser and
// invisible to every server-side test:
//
//   - setStandingToolAllows was defined inside chat.js's factory and left out
//     of its export list. The browser republishes globals from that list, so
//     settings.js's `typeof setStandingToolAllows === 'function'` was false and
//     the live set was never updated by anything.
//   - the allow list was only ever fetched when the settings pane opened, so a
//     reload followed by ordinary work met the card it had already answered.
//   - the revoke button interpolated the stored key into a JavaScript literal.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

// Both files are browser modules that reach their siblings as globals, exactly
// as index.html arranges for them. Wiring the same names here, in the same
// shape boundary-card.test.js uses, runs the real code rather than a
// node-shaped variant of it.
const dom = new JSDOM('<!doctype html><div id="messages"></div><div id="tool-allows-block"></div>');
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
// chat.js reads the open conversation to decide whether a card renders here or
// queues. Neither branch sends anything, which is what these tests assert, but
// the name has to exist for the decision to be reached at all.
global.activeConversation = { id: 'c1' };
global.unread = { markPermission() {} };
global.updateUnreadBadge = () => {};
global.renderConvoList = () => {};
const chat = require('../../public/views/chat.js');
const settings = require('../../public/views/settings.js');

describe('a standing allow reaches the decision that asks the question', () => {
  test('the function settings.js calls is one the browser actually publishes', () => {
    // chat.js's UMD tail does `Object.assign(root, root.RundockChatView)`, so
    // the export list IS the set of globals. settings.js reaches
    // setStandingToolAllows as a bare global and guards with typeof, which
    // means an unexported function does not throw: it silently does nothing,
    // and every server-side test still passes. This asserts the publication
    // rather than the definition.
    assert.strictEqual(typeof chat.setStandingToolAllows, 'function',
      'settings.js calls this as a global, so it has to be exported to exist as one');
  });

  // DRIVEN THROUGH handlePermissionRequest, which is the only reader of the
  // live set. Passing a Set of my own to decidePermission would prove that
  // decidePermission works, which is already proven, and would say nothing
  // about whether seeding reached the object the view consults. The evidence
  // that it did is that no card is rendered and an allow goes down the wire.
  function withView(fn) {
    const sent = [];
    global.ws = { readyState: 1, send: (s) => sent.push(JSON.parse(s)) };
    global.WebSocket = { OPEN: 1 };
    document.getElementById('messages').innerHTML = '';
    global.pendingPermissions.clear();
    global.pendingPermissionsByConvo.clear();
    try { return fn(sent); } finally { global.ws = null; }
  }
  // The envelope the server actually sends: the tool call sits under
  // `request`, and the id is `request_id`. Built here rather than inlined so a
  // change to that shape moves every test in this block at once.
  const request = (command) => ({
    request_id: 'r1', request: { tool_name: 'Bash', input: { command } },
  });

  test('a key granted before the reload is allowed without a card', () => {
    withView((sent) => {
      chat.setStandingToolAllows([]);
      chat.handlePermissionRequest(request('supabase db push'), 'c1');
      assert.deepStrictEqual(sent, [], 'sanity: with nothing seeded this does not auto-allow');

      chat.setStandingToolAllows(['Bash:supabase']);
      chat.handlePermissionRequest(request('supabase db push'), 'c1');
      assert.deepStrictEqual(sent, [
        { type: 'permission_response', requestId: 'r1', conversationId: 'c1', allow: true },
      ], 'the answer the person already gave is the answer the next request gets');
    });
  });

  test('seeding replaces rather than accumulates, so a revoke actually revokes', () => {
    withView((sent) => {
      chat.setStandingToolAllows(['Bash:git', 'Bash:npm']);
      chat.setStandingToolAllows(['Bash:git']);
      chat.handlePermissionRequest(request('npm run build'), 'c1');
      assert.deepStrictEqual(sent, [],
        'a key absent from the newly seeded list must stop being allowed');
      chat.handlePermissionRequest(request('git status'), 'c1');
      assert.strictEqual(sent.length, 1, 'and one still present must still be');
    });
  });

  test('a destructive command is carded however it was granted', () => {
    withView((sent) => {
      chat.setStandingToolAllows(['Bash:rm']);
      chat.handlePermissionRequest(request('rm -rf build'), 'c1');
      assert.deepStrictEqual(sent, [],
        'a standing allow never answers for a destructive command');
    });
  });

  test('a boundary crossing is carded even when its key is allowed', () => {
    withView((sent) => {
      chat.setStandingToolAllows(['Bash:git']);
      const req = request('git status');
      chat.handlePermissionRequest({ ...req, request: { ...req.request, boundary: true } }, 'c1');
      assert.deepStrictEqual(sent, [],
        'reaching outside the workspace is a separate question from which tool asked');
    });
  });
});

describe('the workspace seeds its standing allows without being asked to', () => {
  test('opening a workspace requests the stored allows', () => {
    // Read as source rather than run, because onWorkspaceReady drives most of
    // the application. What matters is that the request sits with the other
    // workspace-open sends and not behind a view the person may never open.
    const src = fs.readFileSync(path.join(__dirname, '../../public/app.js'), 'utf-8');
    const at = src.indexOf('function onWorkspaceReady');
    // FOUND BEFORE IT IS READ. A slice taken from indexOf(-1) starts at the
    // end of the file and matches nothing, which would let a renamed function
    // turn this test green by having nothing left to look at.
    assert.ok(at > -1, 'sanity: onWorkspaceReady is still the workspace-open path in app.js');
    const body = src.slice(at);
    const end = body.indexOf('\n}\n');
    assert.ok(end > -1, 'sanity: the function body is delimited as expected');
    const ready = body.slice(0, end);

    // Every message the workspace-open sequence sends, as a set rather than a
    // substring search, so this cannot be satisfied by the string appearing in
    // a comment or in an unrelated branch further down the file.
    const sends = [...ready.matchAll(/type:\s*'([a-z_]+)'/g)].map((m) => m[1]);
    assert.ok(sends.length >= 6,
      `sanity: the open sequence was read and has sends, got ${sends.length}`);
    assert.ok(sends.includes('get_tool_allows'),
      'a reload that lands anywhere but Settings must still restore the answers already given; '
      + `the sequence sends ${JSON.stringify(sends)}`);
    assert.ok(sends.includes('get_agents'),
      'sanity: this is the sequence that loads the workspace, or the premise moved');
  });

  test('the settings pane is not the only thing that asks', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../public/views/settings.js'), 'utf-8');
    assert.match(src, /get_tool_allows/, 'sanity: the pane still refreshes its own list');
    const app = fs.readFileSync(path.join(__dirname, '../../public/app.js'), 'utf-8');
    assert.match(app, /get_tool_allows/,
      'if this were the settings pane alone, the grant would depend on where the person happened to navigate');
  });
});

describe('the revoke control carries an index, never the key', () => {
  test('a key that would break out of a JavaScript literal cannot', () => {
    {
      // The store is validated on the way in, so this key should never reach
      // here. That is the point: the renderer is the second of two defences,
      // and it has to hold on its own for the first to be worth having.
      const hostile = "x'); alert('pwned";
      settings.toolAllowsArrived({ tools: ['Bash:git', hostile] });
      const html = document.getElementById('tool-allows-block').innerHTML;
      // The key still APPEARS, escaped, inside the <code> element: that is the
      // row doing its job. What must not happen is any of it reaching the
      // handler attribute, which is a JavaScript position where HTML escaping
      // is the wrong tool. So the assertion is on the attribute, not the page.
      const handlers = [...html.matchAll(/onclick="([^"]*)"/g)].map((m) => m[1]);
      assert.ok(handlers.length >= 2, 'sanity: both rows rendered a control');
      for (const h of handlers) {
        assert.match(h, /^revokeToolAllowAt\(\d+\)$/,
          `a handler may contain an index and nothing else, got: ${h}`);
      }
      assert.match(html, /revokeToolAllowAt\(0\)/, 'rows are addressed by position');
      assert.match(html, /revokeToolAllowAt\(1\)/);
    }
  });

  test('revoking by position sends the key that was actually in that row', () => {
    const sent = [];
    global.ws = { readyState: 1, send: (s) => sent.push(JSON.parse(s)) };
    global.WebSocket = { OPEN: 1 };
    try {
      settings.toolAllowsArrived({ tools: ['Bash:git', 'Bash:npm'] });
      settings.revokeToolAllowAt(1);
      assert.deepStrictEqual(sent, [{ type: 'remove_tool_allow', key: 'Bash:npm' }],
        'the index has to resolve to the row the person clicked, not to a stale list');
    } finally { global.ws = null; }
  });

  test('an index with no row behind it sends nothing at all', () => {
    const sent = [];
    global.ws = { readyState: 1, send: (s) => sent.push(JSON.parse(s)) };
    global.WebSocket = { OPEN: 1 };
    try {
      settings.toolAllowsArrived({ tools: ['Bash:git'] });
      settings.revokeToolAllowAt(7);
      settings.revokeToolAllowAt(-1);
      assert.deepStrictEqual(sent, [],
        'a stale index must not become a revoke of whatever happens to be there');
    } finally { global.ws = null; }
  });
});
