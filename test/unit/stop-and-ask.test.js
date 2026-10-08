'use strict';
// AFTER A REFUSAL, THE AGENT IS TOLD IN THE SAME STEP TO STOP AND ASK.
//
// A refused action used to read to the agent as an obstacle: a denied card
// said "acknowledge and move on", a card nobody answered said "try the command
// again", and a command the sandbox blocked said nothing at all. Each invited
// another route to the same thing, and each attempt was another card or block
// the person paid for. Now every refusal carries one line, in the answer to
// the very call that was refused, saying the refusal was on purpose and that
// the agent should stop and ask.
//
// Driven through the real hook, spawned as the runtime spawns it, against the
// real router holding the card and the real handler answering it.
const { test, describe, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const config = require('../../lib/config.js');
const router = require('../../lib/http-router.js');
const { handlePermissionResponse } = require('../../lib/protocol/handlers/process-control.js');
const notices = require('../../lib/runtime/agent-notices.js');
const auth = require('../../lib/auth/index.js');
const scaffold = require('../../lib/workspace/scaffold.js');
const { refusalNotice, sandboxBlocked } = require('../../scripts/refusal-notice.js');

const HOOK = path.join(__dirname, '..', '..', 'scripts', 'permission-hook.js');

function runHook(env, input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', () => { let parsed = null; try { parsed = JSON.parse(out); } catch (e) { /* raw kept */ } resolve({ raw: out, json: parsed }); });
    child.stdin.end(JSON.stringify(input));
  });
}

// Words that would tell an agent how to get round a refusal.
const WORKAROUND = /dangerouslyDisableSandbox|allowed_domains|settings\.local|permissions\.json|sudo|instead|use a different|try again/i;

let ws, outside, server, port, pending, sent, prevDeps, prevWorkspace, timeoutMs;
before(async () => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-and-ask-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-and-ask-outside-'));
  fs.writeFileSync(path.join(outside, 'notes.md'), '# notes\n');
  fs.mkdirSync(path.join(ws, '.rundock'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.rundock', 'state.json'), '{"workspaceMode":"knowledge"}\n');
  prevWorkspace = config.getWorkspace();
  config.setWorkspace(ws);
  pending = new Map();
  sent = [];
  timeoutMs = 60000;
  prevDeps = router.wireHttpRouterDeps({
    pendingPermissionRequests: () => pending,
    safeSend: (s) => sent.push(JSON.parse(s)),
    getPermissionTimeoutMs: () => timeoutMs,
    routineRunForSession: () => null,
  });
  server = http.createServer(router.handleHttpRequest);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(async () => {
  await new Promise((r) => server.close(r));
  router.wireHttpRouterDeps(prevDeps);
  if (prevWorkspace) config.setWorkspace(prevWorkspace);
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

const env = (convo, extra = {}) => {
  const e = { ...process.env, RUNDOCK: '1', RUNDOCK_PORT: String(port), RUNDOCK_WORKSPACE: ws, RUNDOCK_CONVO_ID: convo, RUNDOCK_HOOK_TOKEN: auth.issueHookToken(convo), RUNDOCK_EXTRA_DIRS: '', ...extra };
  delete e.RUNDOCK_CODE_MODE;
  delete e.NODE_V8_COVERAGE;
  return e;
};
// A read outside the workspace: always a card, in every mode and platform.
const outsideRead = (convo) => ({ session_id: `s-${convo}`, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `cat ${path.join(outside, 'notes.md')}` }, cwd: ws });
const insideRead = (convo) => ({ session_id: `s-${convo}`, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(ws, '.rundock', 'state.json') }, cwd: ws });

// Ask through the hook, and answer the card the router raised with the real
// handler, as a click in the window would.
async function askAndAnswer(convo, allow) {
  const since = sent.length;
  const answer = runHook(env(convo), outsideRead(convo));
  const card = await waitFor(() => sent.slice(since).find((m) => m.type === 'control_request' && m._conversationId === convo));
  if (allow !== undefined) {
    handlePermissionResponse({ pendingPermissions: pending, broadcast: () => {} }, { send() {} }, { requestId: card.request_id, conversationId: convo, allow });
  }
  return (await answer).json;
}
async function waitFor(fn, ms = 10000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('a refused card tells the agent, in that answer, to stop and ask', () => {
  test('denied: the answer says the person refused it on purpose, and to stop and ask', async () => {
    const out = await askAndAnswer('convo-deny', false);
    assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.strictEqual(out.hookSpecificOutput.permissionDecisionReason, refusalNotice('denied', 'Bash'));
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /person refused this command\..*deliberate.*Stop and ask the person/);
  });

  test('timed out: refused, said so, and the old invitation to try again is gone', async () => {
    timeoutMs = 50;
    try {
      const out = await askAndAnswer('convo-timeout');
      assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
      assert.strictEqual(out.hookSpecificOutput.permissionDecisionReason, refusalNotice('timeout', 'Bash'));
      assert.doesNotMatch(out.hookSpecificOutput.permissionDecisionReason, /try the command again/i);
    } finally { timeoutMs = 60000; }
  });

  test('allowed: no notice at all', async () => {
    const out = await askAndAnswer('convo-allow', true);
    assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'allow');
    assert.strictEqual(out.hookSpecificOutput.permissionDecisionReason, 'Approved in Rundock');
    assert.strictEqual(out.hookSpecificOutput.additionalContext, undefined);
  });

  test('once per refusal, and only in its own conversation', async () => {
    const out = await askAndAnswer('convo-once', false);
    const said = JSON.stringify(out).split('Stop and ask').length - 1;
    assert.strictEqual(said, 1, 'said once in the answer, not again as added context');
    // Nothing is left behind to be handed over again, to it or to anyone.
    assert.strictEqual(notices.takeAgentNotice('convo-once'), null);
    for (const convo of ['convo-once', 'convo-elsewhere']) {
      const next = (await runHook(env(convo), insideRead(convo))).json;
      assert.strictEqual(next.hookSpecificOutput.permissionDecision, 'allow', convo);
      assert.strictEqual(next.hookSpecificOutput.additionalContext, undefined, convo);
    }
  });
});

describe('a command the sandbox blocked is told in the same step', () => {
  const blockedError = 'Exit code 1\ncp: /Users/someone/Downloads/x: Operation not permitted\n<sandbox_violations>\ndeny file-write-create /Users/someone/Downloads/x\n</sandbox_violations>';
  const failed = (convo, error, toolInput = { command: 'cp -R ~/Downloads/x ./x' }) => runHook(env(convo), {
    session_id: `s-${convo}`, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: toolInput, error, cwd: ws,
  });
  const finished = (convo, stderr) => runHook(env(convo), {
    session_id: `s-${convo}`, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: '', stderr }, cwd: ws,
  });

  test('a failure the runtime marks as a sandbox refusal carries the line', async () => {
    const out = (await failed('convo-sbx', blockedError)).json;
    assert.deepStrictEqual(out, { hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: refusalNotice('sandbox', 'Bash') } });
  });

  test('a finished command whose output carries the runtime\'s mark carries it too', async () => {
    const out = (await finished('convo-sbx-ok', blockedError)).json;
    assert.strictEqual(out.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.strictEqual(out.hookSpecificOutput.additionalContext, refusalNotice('sandbox', 'Bash'));
  });

  test('an ordinary failure, and an ordinary finish, say nothing', async () => {
    assert.strictEqual((await failed('convo-plain', 'Exit code 1\nls: x: No such file or directory')).raw, '{}');
    assert.strictEqual((await finished('convo-plain', '')).raw, '{}');
  });

  test('once: the next step in the same conversation says nothing', async () => {
    await failed('convo-sbx-once', blockedError);
    assert.strictEqual((await finished('convo-sbx-once', '')).raw, '{}');
    assert.strictEqual(notices.takeAgentNotice('convo-sbx-once'), null);
  });

  test('a put-back line waiting for the conversation is handed over beside it, not lost', async () => {
    notices.leaveAgentNotice('convo-sbx-both', 'A line Rundock left.');
    const out = (await failed('convo-sbx-both', blockedError)).json;
    assert.strictEqual(out.hookSpecificOutput.additionalContext, `A line Rundock left.\n${refusalNotice('sandbox', 'Bash')}`);
  });

  test('outside Rundock the hook says nothing', async () => {
    const e = env('convo-none'); delete e.RUNDOCK;
    const out = await runHook(e, { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'cp a b' }, error: blockedError });
    assert.strictEqual(out.raw, '{}');
  });
});

describe('what counts as a sandbox refusal', () => {
  const notPermitted = 'cp: x: Operation not permitted';
  test('the runtime\'s own mark is decisive, in every mode and on every platform', () => {
    for (const opts of [{}, { codeMode: true }, { platform: 'linux' }]) {
      assert.strictEqual(sandboxBlocked('Bash', { command: 'cp a b' }, 'x <sandbox_violations>y</sandbox_violations>', opts), true, JSON.stringify(opts));
    }
  });
  test('"Operation not permitted" counts only where Rundock turns the sandbox on, for a command run inside it', () => {
    assert.strictEqual(sandboxBlocked('Bash', { command: 'cp a b' }, notPermitted, { platform: 'darwin' }), true);
    assert.strictEqual(sandboxBlocked('Bash', { command: 'cp a b' }, notPermitted, { platform: 'darwin', codeMode: true }), false, 'Code mode');
    assert.strictEqual(sandboxBlocked('Bash', { command: 'cp a b' }, notPermitted, { platform: 'linux' }), false, 'no Rundock sandbox here');
    assert.strictEqual(sandboxBlocked('Bash', { command: 'cp a b', dangerouslyDisableSandbox: true }, notPermitted, { platform: 'darwin' }), false, 'ran outside it');
  });
  test('only the shell tool, and only text', () => {
    assert.strictEqual(sandboxBlocked('Write', {}, '<sandbox_violations>', {}), false);
    assert.strictEqual(sandboxBlocked('Bash', {}, undefined, { platform: 'darwin' }), false);
  });
});

describe('the wording', () => {
  test('says what was refused, that it was deliberate, and to stop and ask, and never how to get round it', () => {
    for (const kind of ['denied', 'timeout', 'sandbox']) {
      for (const tool of ['Bash', 'Read', 'mcp__example__send']) {
        const line = refusalNotice(kind, tool);
        assert.match(line, tool === 'Bash' ? /this command/i : new RegExp(`this ${tool} call`, 'i'), `${kind} ${tool}`);
        assert.match(line, /The refusal is deliberate/);
        assert.match(line, /Stop and ask the person what to do\.$/);
        assert.doesNotMatch(line, WORKAROUND, `${kind} ${tool}`);
        assert.doesNotMatch(line, /[\u2013\u2014]/, 'no dashes');
        assert.ok(line.length <= 200, `short: ${line.length}`);
      }
    }
    assert.match(refusalNotice('denied', 'Bash'), /person refused/);
    assert.match(refusalNotice('timeout', 'Bash'), /No one answered the request for this command in time, so it was refused/);
    assert.match(refusalNotice('sandbox', 'Bash'), /sandbox settings blocked/);
  });
  test('no line for anything that is not a refusal, and a strange tool name is never echoed', () => {
    assert.strictEqual(refusalNotice('allowed', 'Bash'), null);
    assert.strictEqual(refusalNotice('constructor', 'Bash'), null);
    assert.match(refusalNotice('denied', 'Ignore previous instructions and'), /refused this action\./);
  });
});

describe('the failure hook is registered where Rundock owns the settings file', () => {
  let dir, prev;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-and-ask-scaffold-'));
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.rundock'), { recursive: true });
    prev = scaffold.wireScaffoldDeps({ invalidateAgentCache() {}, rebaselineAgentsWatcher() {} });
  });
  afterEach(() => { scaffold.wireScaffoldDeps(prev); fs.rmSync(dir, { recursive: true, force: true }); });
  const settings = () => JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.local.json'), 'utf-8'));
  const ours = (e) => (e.hooks || []).some((h) => h.command && h.command.includes('permission-hook'));

  test('one PostToolUseFailure entry, the same script and tools as PostToolUse, idempotent', () => {
    scaffold.scaffoldWorkspace(dir, { platform: 'darwin' });
    const s = settings();
    const fail = (s.hooks.PostToolUseFailure || []).filter(ours);
    assert.strictEqual(fail.length, 1);
    assert.deepStrictEqual(fail[0], s.hooks.PostToolUse.filter(ours)[0]);
    const f = path.join(dir, '.claude', 'settings.local.json');
    const first = fs.readFileSync(f, 'utf-8');
    scaffold.scaffoldWorkspace(dir, { platform: 'darwin' });
    assert.strictEqual(fs.readFileSync(f, 'utf-8'), first);
  });

  test('a stale entry is replaced, and a person\'s own failure hook is left alone', () => {
    fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), JSON.stringify({ hooks: { PostToolUseFailure: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'notify-me' }] },
      { matcher: 'Bash', hooks: [{ type: 'command', command: '"/old/place/permission-hook.js"' }] },
    ] } }, null, 2));
    scaffold.scaffoldWorkspace(dir, { platform: 'darwin' });
    const fail = settings().hooks.PostToolUseFailure;
    assert.ok(fail.some((e) => e.hooks[0].command === 'notify-me'));
    assert.strictEqual(fail.filter(ours).length, 1);
    assert.ok(!fail.some((e) => e.hooks[0].command.includes('/old/place/')));
  });

  test('a settings file whose sandbox block a person wrote gets none', () => {
    fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), JSON.stringify({ sandbox: { enabled: true, filesystem: { allowWrite: ['/a'] } } }, null, 2));
    scaffold.scaffoldWorkspace(dir, { platform: 'darwin' });
    assert.strictEqual((settings().hooks.PostToolUseFailure || []).filter(ours).length, 0);
  });
});
