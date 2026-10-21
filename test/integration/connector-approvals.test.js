'use strict';
// Connector (MCP) approvals, end to end: the real permission hook spawned the
// way the runtime spawns it, the real server relaying its request, and the
// real chat view deciding whether to ask and drawing the card, answered by
// pressing the card's own buttons. Notes mode, which is where connector
// actions are asked about: Code mode runs them without a card.
//
// A connector action that sends, replies or forwards always asks, with Allow
// and Deny only, the treatment a delete already gets. "Always allow" on such a
// card used to be saved for the whole workspace, so one tired click let every
// agent in it send email without asking again.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { JSDOM } = require('jsdom');

const h = require('../helpers/harness.js');

const HOOK = path.join(__dirname, '..', '..', 'scripts', 'permission-hook.js');
const CONVO = 'connector-approvals';
const MAIL = (action) => `mcp__example_mail__${action}`;

let client;
let chat;
let dom;
// Everything the view sent, in order. It goes to the real server as well.
const sent = [];

before(async () => {
  await h.boot();
  client = await h.connect();
  // The chat view as index.html loads it: browser modules reaching their
  // siblings as globals. Its socket is this test's own connection to the real
  // server, so what a button sends is what the server acts on.
  dom = new JSDOM('<!doctype html><div id="messages"></div>'
    + '<div id="approvals-dock" hidden><span class="approvals-dock-count"></span><div class="approvals-dock-list"></div></div>');
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
  global.activeConversation = { id: CONVO };
  global.unread = { markPermission() {}, resolvePermission() {} };
  global.updateUnreadBadge = () => {};
  global.renderConvoList = () => {};
  global.ws = { readyState: 1, send: (s) => { sent.push(JSON.parse(s)); client.ws.send(s); } };
  chat = require('../../public/views/chat.js');
});
after(async () => {
  await h.shutdown();
  if (dom) dom.window.close();
});

// The real hook, given one tool call on stdin, in Notes mode.
function runHook(toolName, convo) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      RUNDOCK: '1',
      RUNDOCK_PORT: String(h.port),
      RUNDOCK_WORKSPACE: h.workspaceDir,
      RUNDOCK_CONVO_ID: convo,
      RUNDOCK_HOOK_TOKEN: h.hookToken(convo || null),
      RUNDOCK_EXTRA_DIRS: '',
    };
    delete env.RUNDOCK_CODE_MODE;
    const proc = spawn(process.execPath, [HOOK], { cwd: h.workspaceDir, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.on('close', () => {
      try {
        const o = JSON.parse(out).hookSpecificOutput || {};
        resolve({ decision: o.permissionDecision, reason: o.permissionDecisionReason });
      } catch (e) { reject(new Error(`hook output unparseable: ${out}`)); }
    });
    proc.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: {}, session_id: `s-${toolName}` }));
  });
}

// One tool call the whole way round, up to the point a person would act.
// Either the hook answers it alone (a read, with no request to the server), or
// a request reaches the view, which answers it from a saved rule or draws a
// card. `done` resolves with the hook's decision once somebody has answered.
async function request(toolName, { convo = CONVO } = {}) {
  const since = client.messages.length;
  const sentBefore = sent.length;
  let alone = null;
  const done = runHook(toolName, convo);
  done.then((r) => { alone = r; }, () => {});
  const arrived = () => client.messages.slice(since)
    .find((m) => m.type === 'control_request' && m.request && m.request.tool_name === toolName);
  await h.waitUntil(() => alone || arrived());
  const msg = arrived();
  if (!msg) return { asked: false, hook: alone };
  // What app.js does with it: a conversation's request goes to that
  // conversation, one with no conversation goes to the approvals dock.
  if (msg._conversationId) chat.handlePermissionRequest(msg, msg._conversationId);
  else chat.handleOwnerlessPermissionRequest(msg);
  const rule = sent.slice(sentBefore).find((m) => m.type === 'permission_response' && m.requestId === msg.request_id);
  const card = document.getElementById(`perm-${msg.request_id}`);
  const buttons = card ? [...card.querySelectorAll('[data-perm-action]')].map((b) => b.dataset.permAction) : null;
  return { asked: true, answeredByRule: !!rule, card, buttons, done };
}

async function press(r, action) {
  assert.ok(r.card, 'there is a card to press');
  r.card.querySelector(`[data-perm-action="${action}"]`).click();
  return r.done;
}

describe('a connector action that sends asks every time, with Allow and Deny only', () => {
  for (const action of ['send_message', 'reply_to_thread', 'forward_email', 'resend_verification', 'sendEmail', 'send_status_update']) {
    test(action, async () => {
      const r = await request(MAIL(action));
      assert.strictEqual(r.asked, true, 'the hook sends it to a card rather than running it');
      assert.strictEqual(r.answeredByRule, false);
      assert.deepStrictEqual(r.buttons, ['allow', 'deny'], 'no Always allow on offer');
      assert.strictEqual((await press(r, 'deny')).decision, 'deny');
    });
  }

  test('a request no conversation owns is asked the same way, in the approvals dock', async () => {
    const r = await request(MAIL('send_message'), { convo: '' });
    assert.strictEqual(r.asked, true);
    assert.ok(r.card && r.card.closest('.approvals-dock-list'), 'drawn in the dock, not in the conversation on screen');
    assert.deepStrictEqual(r.buttons, ['allow', 'deny']);
    assert.strictEqual((await press(r, 'deny')).decision, 'deny');
  });

  test('another connector write still offers Always allow', async () => {
    const r = await request(MAIL('update_signature'));
    assert.deepStrictEqual(r.buttons, ['allow', 'always', 'deny']);
    assert.strictEqual((await press(r, 'deny')).decision, 'deny');
  });
});

describe('names that only look like a send are graded as before', () => {
  for (const action of ['get_sent_items', 'list_sent', 'search_forwarded', 'sender_info']) {
    test(`${action} runs as a read, with no card`, async () => {
      const r = await request(MAIL(action));
      assert.strictEqual(r.asked, false);
      assert.deepStrictEqual(r.hook, { decision: 'allow', reason: 'Auto-approved: MCP read' });
    });
  }

  test('sender_lookup asks as an ordinary write, Always allow on offer', async () => {
    const r = await request(MAIL('sender_lookup'));
    assert.deepStrictEqual(r.buttons, ['allow', 'always', 'deny']);
    assert.strictEqual((await press(r, 'deny')).decision, 'deny');
  });
});

describe('in sequence', () => {
  test('denied, then the agent tries again: it asks again', async () => {
    const first = await request(MAIL('send_message'));
    assert.strictEqual((await press(first, 'deny')).decision, 'deny');
    const again = await request(MAIL('send_message'));
    assert.strictEqual(again.asked, true);
    assert.deepStrictEqual(again.buttons, ['allow', 'deny']);
    assert.strictEqual((await press(again, 'allow')).decision, 'allow');
  });

  test('a draft is graded as before, and sending it still asks', async () => {
    const draft = await request(MAIL('create_draft'));
    assert.deepStrictEqual(draft.buttons, ['allow', 'always', 'deny'], 'a draft is an ordinary write');
    const since = client.messages.length;
    assert.strictEqual((await press(draft, 'always')).decision, 'allow');
    await client.waitFor((m) => m.type === 'tool_allows' && m.tools.includes(MAIL('create_draft')),
      { since, label: 'the draft rule saved' });

    const another = await request(MAIL('create_draft'));
    assert.strictEqual(another.answeredByRule, true, 'the next draft is answered by the rule just saved');
    assert.strictEqual((await another.done).decision, 'allow');

    const send = await request(MAIL('send_draft'));
    assert.strictEqual(send.answeredByRule, false, 'the draft rule never answers the send');
    assert.deepStrictEqual(send.buttons, ['allow', 'deny']);
    assert.strictEqual((await press(send, 'allow')).decision, 'allow');
  });

  test('a read after a send runs with no card', async () => {
    const send = await request(MAIL('reply_to_thread'));
    assert.deepStrictEqual(send.buttons, ['allow', 'deny']);
    assert.strictEqual((await press(send, 'allow')).decision, 'allow');
    const read = await request(MAIL('get_sent_items'));
    assert.strictEqual(read.asked, false);
    assert.deepStrictEqual(read.hook, { decision: 'allow', reason: 'Auto-approved: MCP read' });
  });
});
