'use strict';
// A ROUTINE RUN'S CARDS ARE ITS OWN, BY ITS TOKEN.
//
// Every routine run is started with a hook token of its own (lib/auth
// issueRunHookToken), and the server tells which run a request belongs to from
// that token alone. Nothing in the request body moves a card to another run:
// not `session_id`, which a Task subagent shares with its parent and a
// `claude` started from the run's own shell does not, and not anything else.
// A token whose run has ended is refused as unknown, and a lookup that fails
// refuses the request rather than filing it with no run. The token is looked
// up again once the body has arrived, so a request that held its body back
// until its run had ended files nothing. A conversation's token is issued and
// checked exactly as before.
//
// Most cases run Rundock's real permission hook as its own process, with the
// environment the scheduler starts a routine with (getSpawnEnv), against the
// real route, the way test/unit/hook-never-crashes.test.js drives the hook.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const auth = require('../../lib/auth/index.js');
const config = require('../../lib/config.js');
const router = require('../../lib/http-router.js');
const claudeRt = require('../../lib/runtime/claude.js');
const { handlePermissionResponse } = require('../../lib/protocol/handlers/process-control.js');
const { refusalNotice } = require('../../scripts/refusal-notice.js');

const HOOK = path.join(__dirname, '..', '..', 'scripts', 'permission-hook.js');
const RUNS = new Map([
  ['run-a', { id: 'run-a', routine: 'Inbox triage', agent: 'ada' }],
  ['run-b', { id: 'run-b', routine: 'Weekly digest', agent: 'bo' }],
]);
// The scheduler's lookup of a live run by id, stood in for; a test swaps it
// for one that throws or finds nothing.
const liveRun = (id) => RUNS.get(id) || null;
let lookup = liveRun;
let lookups = 0;
// The scheduler's count of refused cards, stood in for: each run id counted.
const counted = [];
let ws, outside, server, port, pending, sent, prevRouter, prevRt, prevWorkspace;

before(async () => {
  ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'run-token-')));
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'run-token-outside-')));
  fs.writeFileSync(path.join(outside, 'notes.md'), '# notes\n');
  fs.mkdirSync(path.join(ws, '.rundock'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.rundock', 'state.json'), '{"workspaceMode":"knowledge"}\n');
  prevWorkspace = config.getWorkspace();
  config.setWorkspace(ws);
  pending = new Map();
  sent = [];
  prevRouter = router.wireHttpRouterDeps({
    pendingPermissionRequests: () => pending,
    safeSend: (s) => sent.push(JSON.parse(s)),
    getPermissionTimeoutMs: () => 60000,
    routineRun: (id) => { lookups++; return lookup(id); },
    noteRefusedCard: (id) => { counted.push(id); return true; },
  });
  server = http.createServer(router.handleHttpRequest);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  prevRt = claudeRt.wireClaudeRuntimeDeps({ getActualPort: () => port });
});
after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  router.wireHttpRouterDeps(prevRouter);
  claudeRt.wireClaudeRuntimeDeps(prevRt);
  if (prevWorkspace) config.setWorkspace(prevWorkspace);
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

function runHook(env, input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', () => { let parsed = null; try { parsed = JSON.parse(out); } catch (e) { /* raw kept */ } resolve(parsed); });
    child.stdin.end(JSON.stringify(input));
  });
}
// A read outside the workspace, which the hook has to ask about. `session`
// undefined leaves the field out, as a call with no session would.
const outsideRead = (session, extra = {}) => ({
  ...(session === undefined ? {} : { session_id: session }),
  hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `cat ${path.join(outside, 'notes.md')}` }, cwd: ws, ...extra,
});
async function waitFor(fn, ms = 10000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}
const deny = (card) => handlePermissionResponse({ pendingPermissions: pending, broadcast: () => {} }, { send() {} },
  { requestId: card.request_id, conversationId: card._conversationId, allow: false, card: true });
// Ask through the hook, deny the card the route raised, and return both.
async function askAndDeny(env, input) {
  const since = sent.length;
  const answer = runHook(env, input);
  const card = await waitFor(() => sent.slice(since).find((m) => m.type === 'control_request'));
  deny(card);
  return { card, out: await answer };
}
// Ask through the hook where no card can be raised: the answer, and every
// card the route sent meanwhile (none, when it refused).
async function askRefused(env, input) {
  const since = sent.length;
  const before = pending.size;
  const out = await runHook(env, input);
  assert.strictEqual(pending.size, before, 'nothing is left waiting');
  return { out, cards: sent.slice(since).filter((m) => m.type === 'control_request') };
}
const routineEnv = (token) => claudeRt.getSpawnEnv(null, token);
const decision = (out) => out && out.hookSpecificOutput && out.hookSpecificOutput.permissionDecision;
const reasonOf = (out) => out && out.hookSpecificOutput && out.hookSpecificOutput.permissionDecisionReason;
const UNATTENDED_DENIED = refusalNotice('denied', 'Bash', { unattended: true });

describe('the environment a routine run is started with', () => {
  test('a routine is started with its run\'s token, and no conversation', () => {
    const token = auth.issueRunHookToken('run-env');
    const env = routineEnv(token);
    assert.strictEqual(env.RUNDOCK_HOOK_TOKEN, token);
    assert.strictEqual('RUNDOCK_CONVO_ID' in env, false);
    auth.retireRunHookToken(token);
  });

  test('an agent started with neither a conversation nor a run token has no token, even one it inherited', () => {
    const saved = process.env.RUNDOCK_HOOK_TOKEN;
    process.env.RUNDOCK_HOOK_TOKEN = auth.issueHookToken('convo-inherited');
    try {
      assert.strictEqual('RUNDOCK_HOOK_TOKEN' in claudeRt.getSpawnEnv(null), false);
      assert.strictEqual('RUNDOCK_HOOK_TOKEN' in claudeRt.getSpawnEnv(''), false);
    } finally {
      if (saved === undefined) delete process.env.RUNDOCK_HOOK_TOKEN; else process.env.RUNDOCK_HOOK_TOKEN = saved;
    }
  });

  test('a conversation\'s agent is started with its conversation\'s token, as before', () => {
    const env = claudeRt.getSpawnEnv('convo-as-before');
    assert.strictEqual(env.RUNDOCK_HOOK_TOKEN, auth.issueHookToken('convo-as-before'));
    assert.strictEqual(auth.hookTokenScope(env.RUNDOCK_HOOK_TOKEN), 'convo-as-before');
    assert.strictEqual(auth.hookTokenRun(env.RUNDOCK_HOOK_TOKEN), null);
  });
});

describe('the run is the token\'s, whatever the request names', () => {
  test('a card names the run its token was issued for, whatever session the request names, or none', async () => {
    const token = auth.issueRunHookToken('run-a');
    const n = counted.length;
    try {
      // Another live run's session, a `claude` started from the run's own
      // shell (a session of its own), and a call that names no session.
      for (const session of ['session-of-run-b', 'nested-claude-session', undefined]) {
        const { card, out } = await askAndDeny(routineEnv(token), outsideRead(session));
        assert.deepStrictEqual(card._run, RUNS.get('run-a'), `session ${String(session)}: the card is run A's, naming its routine and agent`);
        assert.strictEqual(card._conversationId, '', 'and borrows no conversation');
        assert.strictEqual(decision(out), 'deny');
        assert.strictEqual(reasonOf(out), UNATTENDED_DENIED, 'told in a routine\'s words');
      }
      assert.deepStrictEqual(counted.slice(n), ['run-a', 'run-a', 'run-a'], 'each refusal counted on run A, none on run B');
    } finally { auth.retireRunHookToken(token); }
  });

  test('a Task subagent\'s call, carrying the run\'s token, is the run\'s card', async () => {
    const token = auth.issueRunHookToken('run-b');
    const n = counted.length;
    try {
      const { card } = await askAndDeny(routineEnv(token), outsideRead('session-of-run-a', { agent_id: 'a1b2c3d4e5f6a7b8c', agent_type: 'general-purpose' }));
      assert.deepStrictEqual(card._run, RUNS.get('run-b'));
      assert.deepStrictEqual(counted.slice(n), ['run-b'], 'and counted on it');
    } finally { auth.retireRunHookToken(token); }
  });

  test('no field in the body moves a card to another run or into a conversation', async () => {
    const token = auth.issueRunHookToken('run-a');
    const n = counted.length;
    try {
      const since = sent.length;
      const answer = fetch(`http://127.0.0.1:${port}/api/permission-request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [auth.HOOK_HEADER]: token },
        body: JSON.stringify({
          tool_name: 'Bash', tool_input: { command: 'sh send.sh' },
          session_id: 'session-of-run-b', conversation_id: 'convo-somebody-else', run: 'run-b', run_id: 'run-b', _run: RUNS.get('run-b'), routine: 'Weekly digest', agent: 'bo',
        }),
      });
      const card = await waitFor(() => sent.slice(since).find((m) => m.type === 'control_request'));
      assert.deepStrictEqual(card._run, RUNS.get('run-a'));
      assert.strictEqual(card._conversationId, '');
      deny(card);
      assert.deepStrictEqual(await (await answer).json(), { allow: false });
      assert.deepStrictEqual(counted.slice(n), ['run-a'], 'and the refusal is counted on the token\'s run');
    } finally { auth.retireRunHookToken(token); }
  });
});

describe('a token with no live run behind it is refused, and files nothing', () => {
  test('a retired token is refused as unknown, as one never issued is', async () => {
    const token = auth.issueRunHookToken('run-a');
    auth.retireRunHookToken(token);
    const n = counted.length;
    const { out, cards } = await askRefused(routineEnv(token), outsideRead('session-of-run-a'));
    assert.deepStrictEqual(cards, [], 'no card');
    assert.strictEqual(decision(out), 'deny');
    assert.strictEqual(reasonOf(out), UNATTENDED_DENIED);
    const res = await fetch(`http://127.0.0.1:${port}/api/permission-request`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', [auth.HOOK_HEADER]: token }, body: '{"tool_name":"Bash"}',
    });
    assert.strictEqual(res.status, 401);
    assert.deepStrictEqual(counted.slice(n), [], 'and no count changes');
  });

  test('a token whose run the scheduler does not have going is refused', async () => {
    const token = auth.issueRunHookToken('run-not-going');
    const n = counted.length;
    try {
      const { out, cards } = await askRefused(routineEnv(token), outsideRead('s'));
      assert.deepStrictEqual(cards, []);
      assert.strictEqual(decision(out), 'deny');
      assert.deepStrictEqual(counted.slice(n), []);
    } finally { auth.retireRunHookToken(token); }
  });

  // THE CONTROL FAILING: the lookup throws, as a broken scheduler would. The
  // request is refused, never filed as a card that names no run, and the
  // route goes on answering.
  test('a lookup that fails refuses the request rather than filing it with no run, and the route keeps answering', async () => {
    const token = auth.issueRunHookToken('run-a');
    try {
      lookup = () => { throw new Error('the scheduler fell over'); };
      const n = counted.length;
      const { out, cards } = await askRefused(routineEnv(token), outsideRead('session-of-run-a'));
      assert.deepStrictEqual(cards, [], 'no card, with a run or without one');
      assert.deepStrictEqual(counted.slice(n), [], 'and nothing counted on any run');
      assert.strictEqual(decision(out), 'deny');
      assert.strictEqual(reasonOf(out), UNATTENDED_DENIED);
      lookup = liveRun;
      const { card } = await askAndDeny(routineEnv(token), outsideRead('session-of-run-a'));
      assert.deepStrictEqual(card._run, RUNS.get('run-a'), 'and the next request is the run\'s again');
    } finally { lookup = liveRun; auth.retireRunHookToken(token); }
  });
});

// A request whose body is held back. The headers and the start of the body go
// at once, and the route looks the token up as they arrive; the rest goes only
// when `finish` is called, and `abort` drops the connection instead.
async function held(token, body) {
  const text = JSON.stringify(body);
  const n = lookups;
  const req = http.request({
    host: '127.0.0.1', port, path: '/api/permission-request', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), [auth.HOOK_HEADER]: token },
  });
  const answered = new Promise((resolve) => {
    req.on('response', (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b) }));
    });
    req.on('error', (e) => resolve({ error: e.code }));
  });
  req.write(text.slice(0, 10));
  try { await waitFor(() => lookups > n); } catch (e) { req.destroy(); throw e; }
  return { answered, finish: () => req.end(text.slice(10)), abort: () => req.destroy() };
}
const LATE = { tool_name: 'Bash', tool_input: { command: 'sh late.sh' }, session_id: 'session-of-run-a' };
const send = (token, body = LATE) => fetch(`http://127.0.0.1:${port}/api/permission-request`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', [auth.HOOK_HEADER]: token }, body: JSON.stringify(body),
});
// Finish a held request whose run has changed meanwhile: it is refused as an
// unknown token is, with no card, nothing waiting, and no count.
async function refusedWhenFinished(request) {
  const since = sent.length;
  const before = pending.size;
  const n = counted.length;
  request.finish();
  // Whichever comes first: the answer, a card, or five seconds of neither. A
  // card is denied at once, and a request left unanswered is dropped, so a
  // route that gets this wrong fails here rather than waiting out a timeout.
  let poll;
  let gaveUp;
  const filed = new Promise((resolve) => {
    poll = setInterval(() => { const c = sent.slice(since).find((m) => m.type === 'control_request'); if (c) resolve(c); }, 10);
    gaveUp = setTimeout(() => resolve('unanswered'), 5000);
  });
  const card = await Promise.race([request.answered.then(() => null), filed]);
  clearInterval(poll);
  clearTimeout(gaveUp);
  if (card === 'unanswered') request.abort();
  else if (card) deny(card);
  const out = await request.answered;
  assert.strictEqual(out.status, 401, 'refused as an unknown token is');
  assert.deepStrictEqual(sent.slice(since), [], 'no card, and nothing sent to any window');
  assert.strictEqual(pending.size, before, 'nothing left waiting');
  assert.deepStrictEqual(counted.slice(n), [], 'and no count changes');
}

describe('a request whose body arrives late is checked again when it has', () => {
  test('a run still going when its late body arrives files its card, and the refusal is counted on it', async () => {
    const token = auth.issueRunHookToken('run-a');
    const n = counted.length;
    try {
      const since = sent.length;
      const request = await held(token, LATE);
      await new Promise((r) => setTimeout(r, 200));
      request.finish();
      const card = await waitFor(() => sent.slice(since).find((m) => m.type === 'control_request'));
      assert.deepStrictEqual(card._run, RUNS.get('run-a'));
      deny(card);
      assert.deepStrictEqual((await request.answered).body, { allow: false });
      assert.deepStrictEqual(counted.slice(n), ['run-a'], 'counted on the run, once');
    } finally { auth.retireRunHookToken(token); }
  });

  test('a token retired while its body was held is refused when the body arrives, and again when the request is sent once more', async () => {
    const token = auth.issueRunHookToken('run-a');
    const request = await held(token, LATE);
    auth.retireRunHookToken(token);
    await refusedWhenFinished(request);
    const since = sent.length;
    const n = counted.length;
    assert.strictEqual((await send(token)).status, 401, 'the same request again is refused');
    assert.deepStrictEqual(sent.slice(since), [], 'and files no card');
    assert.deepStrictEqual(counted.slice(n), []);
  });

  test('a run the scheduler no longer has going is refused when the body arrives, though its token is still issued', async () => {
    const token = auth.issueRunHookToken('run-a');
    try {
      const request = await held(token, LATE);
      lookup = (id) => (id === 'run-a' ? null : liveRun(id));
      await refusedWhenFinished(request);
    } finally { lookup = liveRun; auth.retireRunHookToken(token); }
  });

  test('a token that names a different run when the body arrives is refused, and files on neither run', async () => {
    const token = auth.issueRunHookToken('run-a');
    try {
      const request = await held(token, LATE);
      lookup = (id) => (id === 'run-a' ? RUNS.get('run-b') : liveRun(id));
      await refusedWhenFinished(request);
    } finally { lookup = liveRun; auth.retireRunHookToken(token); }
  });

  // THE CONTROL FAILING: the second lookup throws. The request is refused,
  // never filed on the run the first lookup found.
  test('a lookup that fails when the body arrives refuses the request, and the route keeps answering', async () => {
    const token = auth.issueRunHookToken('run-a');
    try {
      const request = await held(token, LATE);
      lookup = () => { throw new Error('the scheduler fell over'); };
      await refusedWhenFinished(request);
      lookup = liveRun;
      const { card } = await askAndDeny(routineEnv(token), outsideRead('session-of-run-a'));
      assert.deepStrictEqual(card._run, RUNS.get('run-a'), 'and the next request is the run\'s again');
    } finally { lookup = liveRun; auth.retireRunHookToken(token); }
  });

  test('a client that drops its connection part way through the body files no card, and the route keeps answering', async () => {
    const token = auth.issueRunHookToken('run-a');
    try {
      const since = sent.length;
      const before = pending.size;
      const n = counted.length;
      const request = await held(token, LATE);
      request.abort();
      assert.ok((await request.answered).error, 'the client has no answer');
      await new Promise((r) => setTimeout(r, 200));
      assert.deepStrictEqual(sent.slice(since), [], 'no card');
      assert.strictEqual(pending.size, before);
      assert.deepStrictEqual(counted.slice(n), []);
      const { card } = await askAndDeny(routineEnv(token), outsideRead('session-of-run-a'));
      assert.deepStrictEqual(card._run, RUNS.get('run-a'));
    } finally { auth.retireRunHookToken(token); }
  });

  test('a body that never finishes files no card', async () => {
    const token = auth.issueRunHookToken('run-a');
    const since = sent.length;
    const before = pending.size;
    const n = counted.length;
    const request = await held(token, LATE);
    try {
      await new Promise((r) => setTimeout(r, 500));
      assert.deepStrictEqual(sent.slice(since), [], 'no card while the body is unfinished');
      assert.strictEqual(pending.size, before);
      assert.deepStrictEqual(counted.slice(n), []);
    } finally { request.abort(); auth.retireRunHookToken(token); }
    await request.answered;
  });
});

describe('a conversation\'s token is checked as before', () => {
  test('its card is its conversation\'s, and no run is looked up for it, or counted', async () => {
    const n = lookups;
    const c = counted.length;
    lookup = () => { throw new Error('a conversation\'s card never asks for a run'); };
    try {
      const { card, out } = await askAndDeny(claudeRt.getSpawnEnv('convo-checked'), outsideRead('session-of-run-a'));
      assert.strictEqual(card._conversationId, 'convo-checked');
      assert.strictEqual(card._run, undefined);
      assert.strictEqual(reasonOf(out), refusalNotice('denied', 'Bash'), 'and told to stop and ask, as before');
    } finally { lookup = liveRun; }
    assert.strictEqual(lookups, n);
    assert.deepStrictEqual(counted.slice(c), []);
  });
});
