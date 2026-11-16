'use strict';
// A line that hides code in a zsh file pattern, end to end, with "Always allow
// ls" saved: the real permission hook spawned the way the runtime spawns it,
// the real server relaying its request over a real socket, the app's own
// message dispatch handing it on, and the real chat view deciding whether to
// ask, answered by pressing the card's own buttons and sent back over the same
// socket. The same path as test/integration/powershell-read-approvals.test.js,
// on the same harness.
//
// zsh runs the code of a glob qualifier as it expands the word, so
// `ls 'a'*(e:'cp x <home>/.claude/settings.json':)` writes the runtime's
// settings. A saved answer is keyed on the leading command alone, so in Notes
// mode the saved `ls` answer used to run that line with no card. The same line
// is graded in process in test/unit/permissions.test.js and drawn as a card in
// test/unit/zsh-pattern-cards.test.js.
//
// The control the saved answer answers is a writing `ls`. The server answers a
// low-risk read itself, before the window sees it, so a plain listing never
// reaches the saved answer: it is pinned here as answered by the server, and
// the saved answer is shown answering `ls -la > listing.txt`, which the server
// does not answer, right before the line it must not answer.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { JSDOM } = require('jsdom');

const h = require('../helpers/harness.js');

const HOOK = path.join(__dirname, '..', '..', 'scripts', 'permission-hook.js');
const APP_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app.js'), 'utf-8');
const CONVO = 'zsh-pattern-saved-answer';
const WHY = 'This line has a parenthesis inside a word, which the shell can use to run hidden code, so Rundock asks every time and there is no Always allow.';

let client;
let chat;
let dom;
let settingsFile;
const sent = [];

before(async () => {
  await h.boot();
  // The harness's own temporary home, which the hook is spawned with.
  settingsFile = path.join(process.env.HOME, '.claude', 'settings.json');
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
  global.serverPlatform = 'darwin';
  global.workspaceMode = 'knowledge';
  global.activeConversation = { id: CONVO };
  global.unread = { markPermission() {}, resolvePermission() {} };
  global.updateUnreadBadge = () => {};
  global.renderConvoList = () => {};
  global.WebSocket = { OPEN: 1 };
  chat = require('../../public/views/chat.js');
  chat.setStandingToolAllows(['Bash:ls']);

  // THE APP'S OWN DISPATCH, cut out of public/app.js and run as written: the
  // socket's message handler, the line in handle() that reads which
  // conversation a message is for, and handle()'s control_request arm, so the
  // request reaches the card code only the way the window hands it on.
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

// The real hook, given one Bash call on stdin, in Notes mode.
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
      hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command },
      session_id: 's-zsh-pattern', cwd: h.workspaceDir,
    }));
  });
}

// One Bash call the whole way round, up to the point a person would act.
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
  // The frame that carried the request has already been through the app's
  // handler by now, which ran on the same frame straight after the line that
  // recorded it.
  const answers = () => sent.slice(sentBefore).filter((m) => m.type === 'permission_response' && m.requestId === msg.request_id);
  const card = document.getElementById(`perm-${msg.request_id}`);
  return { msg, card, answers, done, hookSoFar: () => hook };
}

// Every request is finished before its test ends, whatever failed: an
// unanswered card is denied, and a request that never reached a card is
// denied over the socket.
async function settle(r) {
  if (!r.answers().length) {
    if (r.card) r.card.querySelector('[data-perm-action="deny"]').click();
    else client.ws.send(JSON.stringify({ type: 'permission_response', requestId: r.msg.request_id, conversationId: CONVO, allow: false }));
  }
  await r.done;
}

describe('Notes mode with "Always allow ls" saved, through the hook, the server and the window', () => {
  test('a plain listing is answered by the server, with no card', async () => {
    const since = client.messages.length;
    const sentBefore = sent.length;
    const cardsBefore = document.querySelectorAll('[id^="perm-"]').length;
    assert.strictEqual((await runHook('ls -la')).decision, 'allow', 'the hook is told to allow it');
    // Long enough for a request sent toward the window to have arrived.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepStrictEqual(client.messages.slice(since).filter((m) => m.type === 'control_request'), [],
      'answered by the server: nothing reached the window');
    assert.deepStrictEqual(sent.slice(sentBefore), [], 'and the window answered nothing');
    assert.strictEqual(document.querySelectorAll('[id^="perm-"]').length, cardsBefore, 'no card was drawn');
  });

  test('a listing the server does not answer runs under the saved answer, with no card', async () => {
    const r = await request('ls -la > listing.txt');
    try {
      assert.strictEqual(r.card, null, 'no card was drawn');
      assert.deepStrictEqual(r.answers().map((m) => ({ allow: m.allow, card: m.card })), [{ allow: true, card: undefined }],
        'allowed once, by the saved answer, with no card');
      assert.strictEqual((await r.done).decision, 'allow', 'and the hook is told to allow it');
    } finally { await settle(r); }
  });

  test('a listing that writes the runtime\'s settings from a file pattern is carded, with no Always allow, and the hook waits for a person', async () => {
    const command = `ls 'a'*(e:'cp x ${settingsFile}':)`;
    const r = await request(command);
    try {
      assert.strictEqual(r.msg.request.tool_name, 'Bash', 'the server forwarded the Bash request');
      assert.strictEqual(r.msg.request.input.command, command, 'with the command as the hook sent it');
      assert.ok(r.card, `no card was drawn: ${command}`);
      const buttons = [...r.card.querySelectorAll('[data-perm-action]')].map((b) => b.dataset.permAction);
      assert.deepStrictEqual(buttons, ['allow', 'deny'], 'Allow and Deny only, no Always allow');
      assert.strictEqual(r.card.querySelector('.permission-context').textContent, WHY, 'and the card says why it asks');
      assert.deepStrictEqual(r.answers(), [], 'nothing was answered on the person\'s behalf');
      // Long enough for an answer to have reached the hook had one been sent.
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.strictEqual(r.hookSoFar(), null, `the hook was answered before anyone pressed anything: ${JSON.stringify(r.hookSoFar())}`);
      r.card.querySelector('[data-perm-action="deny"]').click();
      assert.deepStrictEqual(r.answers().map((m) => ({ allow: m.allow, card: m.card })), [{ allow: false, card: true }], 'denied from the card');
      assert.strictEqual((await r.done).decision, 'deny', 'and the hook is told to deny it');
      assert.ok(!fs.existsSync(settingsFile), 'and the settings file was never written');
    } finally { await settle(r); }
  });
});
