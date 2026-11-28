'use strict';
// A CARD APPROVED FOR A COMMAND OUTSIDE THE SANDBOX, AND THE ONE ROUTE THAT
// SPENDS WHAT THE APPROVAL LEAVES.
//
// A person's click on a card for a Bash or PowerShell call with
// `dangerouslyDisableSandbox: true` leaves one grant in the server's memory.
// The permission hook spends it through POST /api/sandbox-grant when Claude
// Code asks its own question about the same call. These tests raise real cards
// through the permission route, answer them as the window does, and spend
// through the real route. Every other way a card can end, and every request
// that is not the approved one, leaves nothing to spend.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');

const h = require('../helpers/harness.js');
const { ask, startRoutine, finished } = require('../helpers/permission-route.js');
const ROUTER = require('../../lib/http-router.js');

// Required with a guard, so a missing module fails an assertion rather than
// the whole file.
let grantsModule = null;
try { grantsModule = require('../../lib/runtime/sandbox-grants.js'); } catch (e) { grantsModule = null; }
function grants() {
  assert.ok(grantsModule, 'lib/runtime/sandbox-grants.js exists');
  for (const name of ['recordGrant', 'spendGrant', 'seams']) assert.ok(name in grantsModule, `it exports ${name}`);
  return grantsModule;
}
function routeExists() {
  assert.strictEqual(ROUTER.isOpenRoute({ method: 'POST', url: '/api/sandbox-grant' }), true, 'the spend route is open to the hook');
}

let client;
before(async () => {
  await h.boot();
  h.internal.stopScheduler();
  client = await h.connect();
});
const opened = new Set();
afterEach(() => {
  for (const convoId of opened) h.reapConvo(convoId);
  opened.clear();
});
after(async () => {
  for (const m of client.messages.filter((x) => x.type === 'control_request')) {
    client.send({ type: 'permission_response', requestId: m.request_id, conversationId: m._conversationId || '', allow: false, card: true });
  }
  await h.delay(200);
  for (const { pid } of h.readInvocations()) {
    try { process.kill(pid, 'SIGKILL'); } catch (e) { /* already ended */ }
  }
  await h.shutdown();
});

const AGENT = 'default';
const outside = (command = 'echo hello', tool = 'Bash') => ({ tool, input: { command, dangerouslyDisableSandbox: true } });
const cardBody = (call) => ({
  tool_name: call.tool, tool_input: call.input,
  boundary: true, resolved_path: null, grant_dir: null, grantable: false, crossings: [],
});
const spendBody = (call) => ({ tool_name: call.tool, tool_input: call.input });

// Raise a card for `call` in `convo` with `agent`'s token, and wait for it.
async function raiseCard(convo, call, { agent = AGENT } = {}) {
  const since = client.messages.length;
  const asked = ask(cardBody(call), { headers: h.hookHeaders(convo, agent) });
  const { msg: card } = await client.waitFor((m) => m.type === 'control_request' && m._conversationId === convo, { since, label: `the card in ${convo}` });
  return { asked, card };
}
const answer = (card, convo, allow, extra = { card: true }) => client.send({
  type: 'permission_response', requestId: card.request_id, conversationId: convo, allow, ...extra,
});
// Spend through the route, as the hook does.
async function spend(convo, call, { agent = AGENT, body } = {}) {
  const { reply } = ask(body === undefined ? spendBody(call) : body, { url: '/api/sandbox-grant', headers: h.hookHeaders(convo, agent) });
  return reply;
}

// Every grant the card answer records while `fn` runs, watched by wrapping the
// module's record function in-process.
async function recordedDuring(fn) {
  const g = grants();
  const real = g.recordGrant;
  const made = [];
  g.recordGrant = (grant) => { const ok = real(grant); if (ok) made.push(grant); return ok; };
  try { await fn(); } finally { g.recordGrant = real; }
  return made;
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

test('an approved card for a command outside the sandbox leaves one use of it', async () => {
  routeExists();
  const convo = h.freshConvoId('grant-approved');
  const call = outside();
  const made = await recordedDuring(async () => {
    const { asked, card } = await raiseCard(convo, call);
    answer(card, convo, true);
    assert.deepStrictEqual((await asked.reply).body, { allow: true, card: true });
  });
  assert.strictEqual(made.length, 1, 'one grant');
  assert.deepStrictEqual(await spend(convo, call), { status: 200, body: { spent: true } }, 'spent once');
  assert.deepStrictEqual(await spend(convo, call), { status: 200, body: { spent: false } }, 'and only once');
});

test('two approved cards for one command leave two uses', async () => {
  routeExists();
  const convo = h.freshConvoId('grant-twice');
  const call = outside();
  for (let i = 0; i < 2; i++) {
    const { asked, card } = await raiseCard(convo, call);
    answer(card, convo, true);
    await asked.reply;
  }
  assert.strictEqual((await spend(convo, call)).body.spent, true, 'the first');
  assert.strictEqual((await spend(convo, call)).body.spent, true, 'the second');
  assert.strictEqual((await spend(convo, call)).body.spent, false, 'no third');
});

test('a PowerShell call outside the sandbox is recorded the same way', async () => {
  routeExists();
  const convo = h.freshConvoId('grant-pwsh');
  const call = outside('Write-Output hello', 'PowerShell');
  const { asked, card } = await raiseCard(convo, call);
  answer(card, convo, true);
  await asked.reply;
  assert.strictEqual((await spend(convo, call)).body.spent, true);
});

test('a grant that cannot be recorded is logged, and the card is still answered allow', async () => {
  routeExists();
  const g = grants();
  const convo = h.freshConvoId('grant-record-fails');
  const call = outside();
  const real = g.recordGrant;
  const realWarn = console.warn;
  const warned = [];
  g.recordGrant = () => { throw new Error('the grant map is unavailable'); };
  console.warn = (...args) => { warned.push(args.join(' ')); };
  try {
    const { asked, card } = await raiseCard(convo, call);
    answer(card, convo, true);
    // An answer the failure held back would never come, so the wait is bounded.
    let timer;
    const late = new Promise((resolve) => { timer = setTimeout(() => resolve({ body: 'no answer within 5 seconds' }), 5000); });
    const reply = await Promise.race([asked.reply, late]);
    clearTimeout(timer);
    assert.deepStrictEqual(reply.body, { allow: true, card: true }, 'the hook gets the allow as before');
  } finally {
    g.recordGrant = real;
    console.warn = realWarn;
  }
  assert.ok(warned.some((line) => line.includes('the grant map is unavailable')), 'the failure is logged');
  assert.strictEqual((await spend(convo, call)).body.spent, false, 'and there is nothing to spend');
});

// Each way a card ends without a person's approval, and each request that is
// not the approved command, records nothing.
async function assertNothingLeft(convo, call, fn, { agent = AGENT } = {}) {
  routeExists();
  const made = await recordedDuring(fn);
  assert.deepStrictEqual(made, [], 'no grant was recorded');
  assert.strictEqual((await spend(convo, call, { agent })).body.spent, false, 'nothing to spend');
}

test('a refused card leaves nothing', async () => {
  const convo = h.freshConvoId('grant-deny');
  const call = outside();
  await assertNothingLeft(convo, call, async () => {
    const { asked, card } = await raiseCard(convo, call);
    answer(card, convo, false);
    assert.strictEqual((await asked.reply).body.allow, false);
  });
});

test('a card that timed out leaves nothing, and a click after it records nothing', async () => {
  const convo = h.freshConvoId('grant-timeout');
  const call = outside();
  const prev = ROUTER.wireHttpRouterDeps({ getPermissionTimeoutMs: () => 300 });
  try {
    await assertNothingLeft(convo, call, async () => {
      const { asked, card } = await raiseCard(convo, call);
      assert.deepStrictEqual((await asked.reply).body, { allow: false, reason: 'timeout' });
      answer(card, convo, true);
      await client.waitFor((m) => m.type === 'permission_ended' && m.requestId === card.request_id && m.reason === 'not-pending', { label: 'the late click is told it is too late' });
    });
  } finally { ROUTER.wireHttpRouterDeps({ getPermissionTimeoutMs: prev.getPermissionTimeoutMs }); }
});

test('a card ended by stopping the agent leaves nothing, and a click after it records nothing', async () => {
  const convo = h.freshConvoId('grant-cancel');
  opened.add(convo);
  const call = outside();
  h.writeScenario([{ match: { promptIncludes: 'hold the turn open' }, delayMs: 5000, turn: [{ text: 'never arrives' }] }]);
  await assertNothingLeft(convo, call, async () => {
    client.send({ type: 'chat', conversationId: convo, agent: 'lead-designer', content: 'hold the turn open' });
    await client.waitForEvent('system', 'process_started', convo);
    const { asked, card } = await raiseCard(convo, call);
    client.send({ type: 'cancel', conversationId: convo });
    assert.deepStrictEqual((await asked.reply).body, { allow: false, reason: 'cancelled' });
    answer(card, convo, true);
    await client.waitFor((m) => m.type === 'permission_ended' && m.requestId === card.request_id && m.reason === 'not-pending', { label: 'the late click is told it is too late' });
  });
});

test('a card whose asker went away leaves nothing, and a click after it records nothing', async () => {
  const convo = h.freshConvoId('grant-gone');
  const call = outside();
  await assertNothingLeft(convo, call, async () => {
    const { asked, card } = await raiseCard(convo, call);
    asked.abort();
    await client.waitFor((m) => m.type === 'permission_ended' && m.requestId === card.request_id, { label: 'the card ends with its asker' });
    answer(card, convo, true);
    await client.waitFor((m) => m.type === 'permission_ended' && m.requestId === card.request_id && m.reason === 'not-pending', { label: 'the late click is told it is too late' });
  });
});

// A filed request, put in the server's own pending map as the route files one,
// for the shapes the route cannot be asked to file from outside.
function file(requestId, fields) {
  let answered = null;
  const res = { writeHead() {}, end(text) { answered = JSON.parse(text); } };
  h.internal.pendingPermissionRequests.set(requestId, {
    res, conversationId: '', agentId: AGENT, run: null, toolName: 'Bash', toolInput: outside().input, timer: null, ...fields,
  });
  return () => answered;
}

test('a card whose run ended leaves nothing, and a click after it records nothing', async () => {
  const convo = h.freshConvoId('grant-run-ended');
  const call = outside();
  await assertNothingLeft(convo, call, async () => {
    const requestId = `run-ended-${process.pid}`;
    const said = file(requestId, { conversationId: convo, run: { id: 'run-ended-1', routine: 'example-routine', agent: AGENT } });
    ROUTER.settleRunCards('run-ended-1');
    assert.deepStrictEqual(said(), { allow: false, reason: 'run-ended' });
    answer({ request_id: requestId }, convo, true);
    await client.waitFor((m) => m.type === 'permission_ended' && m.requestId === requestId && m.reason === 'not-pending', { label: 'the late click is told it is too late' });
  });
});

test('a routine\'s card, approved, leaves nothing', async () => {
  routeExists();
  const command = 'echo hello from a routine';
  const made = await recordedDuring(async () => {
    const since = client.messages.length;
    const run = startRoutine('content-lead', { hooks: [outside(command)] }, 'grant-routine');
    const { msg: card } = await client.waitFor((m) => m.type === 'control_request' && m.request && m.request.input && m.request.input.command === command, { since, label: 'the run\'s card', timeout: 15000 });
    assert.ok(card._run, 'a run\'s card');
    answer(card, card._conversationId || '', true);
    await finished(run);
  });
  assert.deepStrictEqual(made, [], 'no grant was recorded');
});

test('a run\'s card is never recorded, even one that names a conversation', async () => {
  // A run's request is filed with no conversation, so this shape cannot come
  // from the route; it shows the run check holds on its own.
  const convo = h.freshConvoId('grant-run-named');
  const call = outside();
  await assertNothingLeft(convo, call, async () => {
    const requestId = `run-named-${process.pid}`;
    const said = file(requestId, { conversationId: convo, run: { id: 'run-named-1', routine: 'example-routine', agent: AGENT } });
    answer({ request_id: requestId }, convo, true);
    assert.ok(await h.waitUntil(() => said() !== null), 'the request was answered');
    assert.deepStrictEqual(said(), { allow: true, card: true });
  });
});

test('an allow with no card shown leaves nothing', async () => {
  const convo = h.freshConvoId('grant-no-card');
  const call = outside();
  await assertNothingLeft(convo, call, async () => {
    const { asked, card } = await raiseCard(convo, call);
    answer(card, convo, true, {});
    assert.deepStrictEqual((await asked.reply).body, { allow: true });
  });
});

test('a server-originated request answered by a card leaves nothing', async () => {
  const convo = h.freshConvoId('grant-on-decision');
  const call = outside();
  await assertNothingLeft(convo, call, async () => {
    const requestId = `on-decision-${process.pid}`;
    let decided = null;
    h.internal.pendingPermissionRequests.set(requestId, {
      conversationId: convo, agentId: AGENT, toolName: 'Bash', toolInput: call.input, timer: null,
      onDecision: (allow, by, extra) => { decided = { allow, by, card: extra && extra.card }; },
    });
    answer({ request_id: requestId }, convo, true);
    assert.ok(await h.waitUntil(() => decided !== null), 'the callback was answered');
    assert.deepStrictEqual(decided, { allow: true, by: 'user', card: true });
  });
});

test('an approved card for another tool leaves nothing', async () => {
  const convo = h.freshConvoId('grant-other-tool');
  const call = { tool: 'Write', input: { file_path: path.join(h.workspaceDir, 'notes.md'), content: 'x', command: 'echo hello', dangerouslyDisableSandbox: true } };
  await assertNothingLeft(convo, outside(), async () => {
    const { asked, card } = await raiseCard(convo, call);
    answer(card, convo, true);
    await asked.reply;
  });
});

test('an approved card for a command with no flag, or the flag as a string, leaves nothing', async () => {
  for (const input of [{ command: 'echo hello' }, { command: 'echo hello', dangerouslyDisableSandbox: 'true' }]) {
    const convo = h.freshConvoId('grant-no-flag');
    await assertNothingLeft(convo, outside(), async () => {
      const { asked, card } = await raiseCard(convo, { tool: 'Bash', input });
      answer(card, convo, true);
      await asked.reply;
    });
  }
});

test('an answer for a request that is no longer waiting records nothing', async () => {
  const convo = h.freshConvoId('grant-not-pending');
  await assertNothingLeft(convo, outside(), async () => {
    answer({ request_id: `never-filed-${process.pid}` }, convo, true);
    await client.waitFor((m) => m.type === 'permission_ended' && m.reason === 'not-pending', { label: 'told it is too late' });
  });
});

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

async function approved(convo, call = outside(), agent = AGENT) {
  const { asked, card } = await raiseCard(convo, call, { agent });
  answer(card, convo, true);
  await asked.reply;
  return call;
}

test('the route refuses a missing or unknown token with 401 and spends nothing', async () => {
  routeExists();
  const convo = h.freshConvoId('route-token');
  const call = await approved(convo);
  for (const headers of [{}, { 'x-rundock-hook-token': 'not-a-token-this-launch-issued' }]) {
    const { reply } = ask(spendBody(call), { url: '/api/sandbox-grant', headers });
    const r = await reply;
    assert.strictEqual(r.status, 401, JSON.stringify(headers));
  }
  assert.strictEqual((await spend(convo, call)).body.spent, true, 'the grant is still there');
});

test('a routine run\'s token spends nothing', async () => {
  routeExists();
  const convo = h.freshConvoId('route-run');
  const call = await approved(convo);
  const { reply } = ask(spendBody(call), { url: '/api/sandbox-grant', headers: h.hookHeaders(null) });
  assert.deepStrictEqual(await reply, { status: 200, body: { spent: false } });
  assert.strictEqual((await spend(convo, call)).body.spent, true, 'the grant is still there');
});

test('a malformed request spends nothing', async () => {
  routeExists();
  const convo = h.freshConvoId('route-malformed');
  const call = await approved(convo);
  const bodies = {
    'not JSON': 'not json at all',
    'an array': [spendBody(call)],
    'a string': JSON.stringify('Bash'),
    'null': 'null',
    'no tool input': { tool_name: 'Bash' },
    'another tool': { tool_name: 'Write', tool_input: call.input },
    'no flag': { tool_name: 'Bash', tool_input: { command: call.input.command } },
    'the flag as a string': { tool_name: 'Bash', tool_input: { command: call.input.command, dangerouslyDisableSandbox: 'true' } },
    'an empty command': { tool_name: 'Bash', tool_input: { command: '', dangerouslyDisableSandbox: true } },
    'a command that is not a string': { tool_name: 'Bash', tool_input: { command: [call.input.command], dangerouslyDisableSandbox: true } },
    'one character changed': { tool_name: 'Bash', tool_input: { command: 'echo hellp', dangerouslyDisableSandbox: true } },
  };
  for (const [why, body] of Object.entries(bodies)) {
    assert.deepStrictEqual(await spend(convo, call, { body }), { status: 200, body: { spent: false } }, why);
  }
  assert.strictEqual((await spend(convo, call)).body.spent, true, 'the grant is still there');
});

test('the conversation and agent come from the token, never the body', async () => {
  routeExists();
  const convo = h.freshConvoId('route-scope');
  const call = await approved(convo);
  const other = h.freshConvoId('route-scope-other');
  const claimed = { ...spendBody(call), conversation_id: convo, conversationId: convo, agent_id: AGENT, agentId: AGENT };
  assert.strictEqual((await spend(other, call, { body: claimed })).body.spent, false, 'another conversation\'s token');
  assert.strictEqual((await spend(convo, call, { agent: 'content-lead', body: claimed })).body.spent, false, 'another agent\'s token');
  assert.strictEqual((await spend(convo, call)).body.spent, true, 'the grant is still there for its own token');
});

test('nothing sent to either route records a grant', async () => {
  routeExists();
  const convo = h.freshConvoId('route-no-record');
  const call = outside('echo never approved');
  const shaped = {
    ...spendBody(call), conversationId: convo, agentId: AGENT, toolName: call.tool, toolInput: call.input,
    grant: true, allow: true, card: true, approved: true,
  };
  const prev = ROUTER.wireHttpRouterDeps({ getPermissionTimeoutMs: () => 300 });
  try {
    const made = await recordedDuring(async () => {
      assert.strictEqual((await spend(convo, call, { body: shaped })).body.spent, false, 'the spend route');
      const since = client.messages.length;
      const { reply } = ask({ ...shaped, boundary: true, crossings: [] }, { headers: h.hookHeaders(convo, AGENT) });
      await client.waitFor((m) => m.type === 'control_request' && m._conversationId === convo, { since, label: 'the card it raises' });
      assert.strictEqual((await reply).body.allow, false, 'left to time out');
    });
    assert.deepStrictEqual(made, []);
  } finally { ROUTER.wireHttpRouterDeps({ getPermissionTimeoutMs: prev.getPermissionTimeoutMs }); }
  assert.strictEqual((await spend(convo, call)).body.spent, false, 'nothing to spend');
});

test('another method on the route is closed as any unknown route is', async () => {
  routeExists();
  for (const method of ['GET', 'PUT', 'DELETE']) {
    assert.strictEqual(ROUTER.isOpenRoute({ method, url: '/api/sandbox-grant' }), false, method);
    const r = await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: h.port, method, path: '/api/sandbox-grant', headers: h.hookHeaders(h.freshConvoId('route-method'), AGENT) }, (res) => {
        let b = '';
        res.on('data', (c) => { b += c; });
        res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] }));
      });
      req.on('error', (e) => resolve({ error: e.code }));
      req.end();
    });
    assert.strictEqual(r.status, 401, method);
    assert.match(String(r.type), /^text\/plain/, method);
  }
});
