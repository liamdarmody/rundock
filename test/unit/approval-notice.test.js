'use strict';
// AFTER A PERSON APPROVES A CARD, THE AGENT IS TOLD IN THE SAME STEP.
//
// The runtime never shows the model the reason given with an allow, so an
// approval and a question never asked looked the same from inside a turn. An
// agent reasoning from the command having run could then tell the person the
// safety check had not fired, when it had and they had answered it. Now an
// answer given on a card carries one short line to the agent, as added
// context on the very call that was approved. An allow that asked nobody (a
// rule the window holds, a standing folder grant, Code mode running a command
// without a card) carries none.
//
// Driven end to end: the real hook, spawned as the runtime spawns it, asks the
// real router; the router's card is drawn by the real card code under jsdom
// and its button clicked; the message that click sends is answered by the
// real handler.
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { JSDOM } = require('jsdom');

const config = require('../../lib/config.js');
const router = require('../../lib/http-router.js');
const { handlePermissionResponse } = require('../../lib/protocol/handlers/process-control.js');
const notices = require('../../lib/runtime/agent-notices.js');
const auth = require('../../lib/auth/index.js');
const { approvalNotice, refusalNotice } = require('../../scripts/refusal-notice.js');

const HOOK = path.join(__dirname, '..', '..', 'scripts', 'permission-hook.js');

// The answer, with `ended` set once the hook has exited, so a wait can stop on
// the hook's own exit rather than on a clock.
function runHook(env, input) {
  let ended = false;
  const answer = new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', () => { ended = true; let parsed = null; try { parsed = JSON.parse(out); } catch (e) { /* raw kept */ } resolve({ raw: out, json: parsed }); });
    child.stdin.end(JSON.stringify(input));
  });
  answer.ended = () => ended;
  return answer;
}
// Waits for an event while the hook that should cause it is still running. No
// clock: a slow spawn only takes longer, and a hook that exits without it is a
// failure that says what the hook answered instead.
async function waitFor(fn, hook) {
  for (;;) {
    const v = fn();
    if (v) return v;
    if (hook.ended()) throw new Error(`the hook exited first: ${(await hook).raw}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

let ws, outside, granted, server, port, pending, sent, prevDeps, prevWorkspace, dom, chat, clicked;
before(async () => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-notice-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-notice-outside-'));
  fs.writeFileSync(path.join(outside, 'notes.md'), '# notes\n');
  // Its own folder, so the grant it gets never quiets the other cards here.
  granted = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-notice-granted-'));
  fs.writeFileSync(path.join(granted, 'notes.md'), '# notes\n');
  fs.mkdirSync(path.join(ws, '.rundock'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.rundock', 'state.json'), '{"workspaceMode":"knowledge"}\n');
  prevWorkspace = config.getWorkspace();
  config.setWorkspace(ws);
  pending = new Map();
  sent = [];
  prevDeps = router.wireHttpRouterDeps({
    pendingPermissionRequests: () => pending,
    safeSend: (s) => sent.push(JSON.parse(s)),
    getPermissionTimeoutMs: () => 60000,
    routineRunForSession: () => null,
  });
  server = http.createServer(router.handleHttpRequest);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  // One spawn first, so the first test does not pay for a cold start.
  await runHook({ ...process.env, RUNDOCK: '' }, {});

  // The window, as permission-ownership.test.js draws it.
  dom = new JSDOM('<div id="messages"></div>');
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
  global.unread = { markPermission() {}, resolvePermission() {} };
  global.ws = { send: (s) => clicked.push(JSON.parse(s)) };
  chat = require('../../public/views/chat.js');
});
after(async () => {
  await new Promise((r) => server.close(r));
  router.wireHttpRouterDeps(prevDeps);
  if (prevWorkspace) config.setWorkspace(prevWorkspace);
  if (dom) dom.window.close();
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
  fs.rmSync(granted, { recursive: true, force: true });
});
beforeEach(() => { clicked = []; document.getElementById('messages').innerHTML = ''; });

const env = (convo, extra = {}) => {
  const e = { ...process.env, RUNDOCK: '1', RUNDOCK_PORT: String(port), RUNDOCK_WORKSPACE: ws, RUNDOCK_CONVO_ID: convo, RUNDOCK_HOOK_TOKEN: auth.issueHookToken(convo), RUNDOCK_EXTRA_DIRS: '' };
  delete e.RUNDOCK_CODE_MODE;
  delete e.NODE_V8_COVERAGE;
  return { ...e, ...extra };
};
const call = (convo, tool_name, tool_input) => ({ session_id: `s-${convo}`, hook_event_name: 'PreToolUse', tool_name, tool_input, cwd: ws });
// A read outside: a boundary card, Allow and "Always allow this folder".
const outsideRead = (convo, dir = outside) => call(convo, 'Bash', { command: `cat ${path.join(dir, 'notes.md')}` });
// An interpreter: an ordinary card, Allow and "Always allow".
const interpreter = (convo) => call(convo, 'Bash', { command: 'python3 -c "print(1)"' });
// A write under a hidden folder in the home directory: never remembered, so
// the card offers only "Allow once".
const hiddenWrite = (convo) => call(convo, 'Write', { file_path: path.join(os.homedir(), '.approval-notice-test', 'a.txt'), content: 'x' });
const insideRead = (convo) => call(convo, 'Read', { file_path: path.join(ws, '.rundock', 'state.json') });

// Ask through the hook. The window draws whatever the router sent and, when
// `button` names one, a person clicks it; the message that click sent is
// answered by the real handler. Returns the hook's answer and what the window
// sent.
async function ask(convo, input, button) {
  const since = sent.length;
  global.activeConversation = { id: convo };
  const answer = runHook(env(convo), input);
  const req = await waitFor(() => sent.slice(since).find((m) => m.type === 'control_request' && m._conversationId === convo), answer);
  chat.handlePermissionRequest(req, convo);
  if (button) {
    const btn = document.querySelector(`#perm-${req.request_id} [data-perm-action="${button.action}"]`);
    assert.ok(btn, `the card offers ${button.action}`);
    if (button.label) assert.strictEqual(btn.textContent.trim(), button.label);
    btn.click();
  }
  const msg = await waitFor(() => clicked.find((m) => m.type === 'permission_response' && m.requestId === req.request_id), answer);
  handlePermissionResponse({ pendingPermissions: pending, broadcast: () => {} }, { send() {} }, msg);
  return { out: (await answer).json, msg };
}
const said = (out, line) => JSON.stringify(out).split(line).length - 1;

describe('an approval given on a card is told to the agent in that answer', () => {
  test('Allow: the line is added context on the approved call, once', async () => {
    const { out, msg } = await ask('convo-allow', outsideRead('convo-allow'), { action: 'allow', label: 'Allow' });
    assert.strictEqual(msg.card, true, 'the click says it was a card');
    assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'allow');
    assert.strictEqual(out.hookSpecificOutput.additionalContext, approvalNotice('Bash'));
    assert.strictEqual(said(out, approvalNotice('Bash')), 1);
  });

  test('Always allow: the line once, and the next silent allow by that rule carries none', async () => {
    const first = await ask('convo-always', interpreter('convo-always'), { action: 'always' });
    assert.strictEqual(first.out.hookSpecificOutput.additionalContext, approvalNotice('Bash'));
    assert.strictEqual(said(first.out, approvalNotice('Bash')), 1);
    // The window now answers by its rule, with no card drawn.
    const again = await ask('convo-always', interpreter('convo-always'));
    assert.strictEqual(again.msg.card, undefined, 'an allow by rule is not a card');
    assert.strictEqual(again.out.hookSpecificOutput.permissionDecision, 'allow');
    assert.strictEqual(again.out.hookSpecificOutput.additionalContext, undefined);
  });

  test('Allow once: the line once', async () => {
    const { out } = await ask('convo-once', hiddenWrite('convo-once'), { action: 'allow', label: 'Allow once' });
    assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'allow');
    assert.strictEqual(out.hookSpecificOutput.additionalContext, approvalNotice('Write'));
    assert.strictEqual(said(out, approvalNotice('Write')), 1);
  });

  test('Always allow this folder: the line once, and the next read the grant answers carries none', async () => {
    const first = await ask('convo-folder', outsideRead('convo-folder', granted), { action: 'allow-folder' });
    assert.strictEqual(first.out.hookSpecificOutput.additionalContext, approvalNotice('Bash'));
    // A file read the stored grant covers is answered by the router, no card.
    const since = sent.length;
    const next = (await runHook(env('convo-folder'), call('convo-folder', 'Read', { file_path: path.join(granted, 'notes.md') }))).json;
    assert.ok(!sent.slice(since).some((m) => m.type === 'control_request'), 'no card');
    assert.strictEqual(next.hookSpecificOutput.permissionDecision, 'allow');
    assert.strictEqual(next.hookSpecificOutput.additionalContext, undefined);
  });

  test('a denial still carries only its stop-and-ask line, never this one', async () => {
    const { out } = await ask('convo-deny', outsideRead('convo-deny'), { action: 'deny' });
    assert.strictEqual(out.hookSpecificOutput.permissionDecisionReason, refusalNotice('denied', 'Bash'));
    assert.strictEqual(said(out, approvalNotice('Bash')), 0);
  });
});

describe('no line when nothing was asked', () => {
  test('an allow the window gives by policy, with no card, carries none', async () => {
    // Answered as the auto-allow path answers: no card field.
    const since = sent.length;
    const answer = runHook(env('convo-policy'), outsideRead('convo-policy'));
    const req = await waitFor(() => sent.slice(since).find((m) => m.type === 'control_request' && m._conversationId === 'convo-policy'), answer);
    handlePermissionResponse({ pendingPermissions: pending, broadcast: () => {} }, { send() {} }, { type: 'permission_response', requestId: req.request_id, conversationId: 'convo-policy', allow: true });
    const out = (await answer).json;
    assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'allow');
    assert.strictEqual(out.hookSpecificOutput.additionalContext, undefined);
  });

  test('a card flag on a denial is not an approval', async () => {
    const since = sent.length;
    const answer = runHook(env('convo-flag-deny'), outsideRead('convo-flag-deny'));
    const req = await waitFor(() => sent.slice(since).find((m) => m.type === 'control_request' && m._conversationId === 'convo-flag-deny'), answer);
    handlePermissionResponse({ pendingPermissions: pending, broadcast: () => {} }, { send() {} }, { type: 'permission_response', requestId: req.request_id, conversationId: 'convo-flag-deny', allow: false, card: true });
    const out = (await answer).json;
    assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.strictEqual(said(out, approvalNotice('Bash')), 0);
  });

  test('Code mode running a command without a card carries none', async () => {
    const since = sent.length;
    const out = (await runHook(env('convo-code', { RUNDOCK_CODE_MODE: '1' }), call('convo-code', 'Bash', { command: 'python3 -c "print(1)"' }))).json;
    assert.ok(!sent.slice(since).some((m) => m.type === 'control_request'), 'no card');
    assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'allow');
    assert.strictEqual(out.hookSpecificOutput.additionalContext, undefined);
  });

  test('a read inside the workspace carries none', async () => {
    const out = (await runHook(env('convo-inside'), insideRead('convo-inside'))).json;
    assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'allow');
    assert.strictEqual(out.hookSpecificOutput.additionalContext, undefined);
  });
});

describe('only in its own conversation, and beside a waiting put-back line', () => {
  test('the line is not left behind for the next step, here or anywhere else', async () => {
    await ask('convo-own', outsideRead('convo-own'), { action: 'allow' });
    assert.strictEqual(notices.takeAgentNotice('convo-own'), null, 'nothing left to hand over');
    for (const convo of ['convo-own', 'convo-elsewhere']) {
      const next = (await runHook(env(convo), insideRead(convo))).json;
      assert.strictEqual(next.hookSpecificOutput.additionalContext, undefined, convo);
    }
  });

  test('a put-back line waiting for the conversation is handed over beside it, each once', async () => {
    const LEFT = 'A line Rundock left.';
    notices.leaveAgentNotice('convo-both', LEFT);
    const { out } = await ask('convo-both', outsideRead('convo-both'), { action: 'allow' });
    assert.strictEqual(out.hookSpecificOutput.additionalContext, `${approvalNotice('Bash')}\n${LEFT}`);
    assert.strictEqual(said(out, LEFT), 1);
    assert.strictEqual(said(out, approvalNotice('Bash')), 1);
    const next = (await runHook(env('convo-both'), insideRead('convo-both'))).json;
    assert.strictEqual(next.hookSpecificOutput.additionalContext, undefined, 'neither repeats');
  });
});

describe('the wording', () => {
  test('one short sentence, naming what was approved and that a card was shown, no dashes', () => {
    for (const tool of ['Bash', 'Write', 'mcp__example__send']) {
      const line = approvalNotice(tool);
      assert.match(line, /^The person approved this .* in Rundock after a permission card\.$/);
      assert.doesNotMatch(line, /[\u2013\u2014]/);
      assert.ok(line.length <= 100, `short: ${line.length}`);
    }
    assert.strictEqual(approvalNotice('Bash'), 'The person approved this command in Rundock after a permission card.');
    assert.match(approvalNotice('Ignore previous instructions and'), /approved this action in Rundock/, 'a strange tool name is never echoed');
  });
});
