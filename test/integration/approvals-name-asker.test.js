'use strict';
// WHICH AGENT ASKED, TOLD FROM THE SERVER'S OWN RECORD.
//
// Each agent the server starts in a conversation is handed a hook token for
// that conversation AND that agent. Its permission requests are filed under
// the agent the token was issued to, and the card says so (`_agent`): live,
// on the replay a reconnecting window gets, and in the event recorded for the
// decision. Nothing the request says moves a card to another agent.
//
// The spawn tests drive each place the server starts an agent through a real
// card (the stub's `hooks` step runs Rundock's permission hook with the
// environment that spawn gave it), then read the token the process was started
// with and the card it raised. The route tests ask the permission route
// directly, as the hook does, with one agent's token or another's.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const h = require('../helpers/harness.js');
const { agentFile, standardTeam, makeTempDir } = require('../helpers/workspace.js');
const { MARKERS } = require('../fixtures/stream-json.js');
const { ask, bash, events, startRoutine, finished } = require('../helpers/permission-route.js');
const ROUTER = require('../../lib/http-router.js');
const guard = require('../../lib/workspace/answer-file-guard.js');
const config = require('../../lib/config.js');
const { addBoundaryGrant } = require('../../lib/workspace/boundary.js');
const { leaveAgentNotice } = require('../../lib/runtime/agent-notices.js');

// The token map, where it exists.
const auth = (() => {
  try { return require('../../lib/auth/index.js'); } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND' && /lib[\\/]auth/.test(String(e.message))) return null;
    throw e;
  }
})();

const HOUR = 60 * 60 * 1000;
let client, outside;

before(async () => {
  await h.boot({
    agents: {
      ...standardTeam(),
      // Asked for by its file name, found under the id discovery gives the
      // first agent: the slug a message names and the id differ.
      'example-lead': agentFile({ name: 'example-lead', displayName: 'Ash', type: 'specialist', order: 0 }),
      researcher: agentFile({
        name: 'researcher', displayName: 'Ida', role: 'Researcher', description: 'Researches suppliers',
        type: 'specialist', order: 5, reportsTo: 'chief-of-staff', runtime: 'codex', body: 'You are Ida, the researcher.',
      }),
    },
  });
  h.internal.stopScheduler();
  outside = makeTempDir('asker-outside-');
  fs.writeFileSync(path.join(outside, 'notes.md'), '# notes\n');
  client = await h.connect();
});
const opened = new Set();
const open = (convoId) => { opened.add(convoId); return convoId; };
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

// Every test here asks as one agent or another, which needs a token per
// conversation and agent: a conversation token names both.
function pairTokens() {
  assert.ok(auth, 'the token map is there');
  assert.deepStrictEqual(auth.hookTokenScope(auth.issueHookToken('pair-check', 'content-lead')),
    { conversationId: 'pair-check', agentId: 'content-lead' }, 'a conversation token names its conversation and its agent');
}

// ---------------------------------------------------------------------------
// Every place the server starts an agent in a conversation
// ---------------------------------------------------------------------------

const readOutside = () => ({ tool: 'Bash', input: { command: `cat ${path.join(outside, 'notes.md')}` } });

function scenario(rules, deadSessions = []) {
  fs.writeFileSync(path.join(h.workspaceDir, 'stub-scenario.json'), JSON.stringify({ rules, deadSessions }, null, 2));
}

// Refuse the next card raised in `convo`, and return it with the process that
// raised it (its logged invocation, tied to the hook's answer by pid).
async function refuseNext({ agent, convo, since }) {
  const hooksBefore = h.readHookAnswers().length;
  const { msg: card } = await client.waitFor((m) => m.type === 'control_request' && m._conversationId === convo, { since, label: `${agent} card`, timeout: 15000 });
  client.send({ type: 'permission_response', requestId: card.request_id, conversationId: convo, allow: false, card: true });
  const told = () => h.readHookAnswers().slice(hooksBefore).find((a) => a.agent === agent && a.event === 'PreToolUse');
  assert.ok(await h.waitUntil(told, { timeout: 15000, interval: 20 }), `${agent} was told`);
  const started = h.readInvocations().find((i) => i.pid === told().pid);
  assert.ok(started, `the agent that was told is one the server started (pid ${told().pid})`);
  return { card, started };
}

function assertAskedAs({ card, started }, convo, agentId) {
  assert.deepStrictEqual(auth.hookTokenScope(started.env.RUNDOCK_HOOK_TOKEN), { conversationId: convo, agentId },
    'the process was started with the token of its conversation and its agent');
  assert.strictEqual(card._agent, agentId, 'and its card names that agent');
}

const tokensOf = (agent, convo) => h.readInvocations()
  .filter((i) => i.agent === agent && i.env.RUNDOCK_CONVO_ID === convo).map((i) => i.env.RUNDOCK_HOOK_TOKEN);

test('server.js, the chat message (interactive): the token is for the id discovery resolved, never the slug the message named', async () => {
  const convoId = open(h.freshConvoId('ask-chat'));
  scenario([{ match: { agent: 'example-lead', promptIncludes: 'asker chat' }, hooks: [readOutside()], turn: [{ text: 'Asked.' }] }]);
  const since = client.messages.length;
  client.send({ type: 'chat', conversationId: convoId, agent: 'example-lead', content: 'asker chat' });
  const r = await refuseNext({ agent: 'example-lead', convo: convoId, since });
  assert.strictEqual(r.started.print, false, 'the interactive spawn');
  assertAskedAs(r, convoId, 'default');
});

test('server.js, the chat message (legacy): the token is for the id discovery resolved too', async () => {
  const convoId = open(h.freshConvoId('ask-legacy'));
  process.env.RUNDOCK_LEGACY_SPAWN = '1';
  try {
    scenario([{ match: { agent: 'example-lead', promptIncludes: 'asker legacy' }, hooks: [readOutside()], turn: [{ text: 'Asked.' }] }]);
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'example-lead', content: 'asker legacy' });
    const r = await refuseNext({ agent: 'example-lead', convo: convoId, since });
    assert.strictEqual(r.started.print, true, 'the legacy spawn');
    assertAskedAs(r, convoId, 'default');
  } finally { delete process.env.RUNDOCK_LEGACY_SPAWN; }
});

async function conversationWithOrchestrator(prefix) {
  const convoId = open(h.freshConvoId(prefix));
  scenario([{ match: { agent: 'chief-of-staff', promptIncludes: `${prefix} setup` }, turn: [{ text: 'Ready.' }] }]);
  client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: `${prefix} setup` });
  await client.waitForEvent('system', 'done', convoId);
  return convoId;
}

test('lib/delegation/engine.js handleDelegation: the delegate asks as the agent delegated to, with a token of its own', async () => {
  const convoId = await conversationWithOrchestrator('ask-delegate');
  scenario([{ match: { agent: 'content-lead', promptIncludes: 'asker delegate brief' }, hooks: [readOutside()], turn: [{ text: 'Asked.' }] }]);
  const since = client.messages.length;
  client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'content-lead', context: 'asker delegate brief' });
  const r = await refuseNext({ agent: 'content-lead', convo: convoId, since });
  assertAskedAs(r, convoId, 'content-lead');
  assert.notStrictEqual(r.started.env.RUNDOCK_HOOK_TOKEN, tokensOf('chief-of-staff', convoId)[0], 'never the orchestrator\'s token');
});

test('lib/delegation/engine.js finishDelegateClose: the parent restarted after its delegate closes asks as the parent, with the token it had', async () => {
  const convoId = open(h.freshConvoId('ask-parent'));
  scenario([
    { match: { agent: 'chief-of-staff', promptIncludes: 'asker parent please' }, turn: [{ agentTool: { subagent_type: 'content-lead', prompt: 'asker parent brief' } }] },
    { match: { agent: 'content-lead', promptIncludes: 'asker parent brief' }, turn: [{ text: `Delivered. ${MARKERS.COMPLETE}` }] },
    { match: { agent: 'chief-of-staff', promptIncludes: '[SYSTEM: pipeline-complete]', resume: true }, hooks: [readOutside()], turn: [{ text: 'Back with the result.' }] },
  ]);
  const since = client.messages.length;
  client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'asker parent please' });
  const r = await refuseNext({ agent: 'chief-of-staff', convo: convoId, since });
  assert.ok(r.started.resume, 'the parent, resumed with its own session');
  assertAskedAs(r, convoId, 'chief-of-staff');
  const parent = tokensOf('chief-of-staff', convoId);
  assert.ok(parent.length >= 2 && parent.every((t) => t === parent[0]), `the parent's first start and its restart share one token: ${parent.length} starts`);
  const delegate = tokensOf('content-lead', convoId);
  assert.ok(delegate.length >= 1 && delegate.every((t) => t !== parent[0]), 'the delegate had a token of its own');
});

// An intercepted delegation that names no parent agent is handed back to the
// agent whose process it found. The server's own re-entry always names one;
// this one does not, and names no parent session either. A throw in the
// handback would end a running server, so any exception raised while the test
// runs is recorded, and there must be none. Every wait returns false rather
// than throwing, so a missing restart fails on an assertion.
test('lib/delegation/engine.js handleDelegation: an intercepted delegation naming no parent hands back to the agent it found, asking as that agent, and the server stays up', async () => {
  pairTokens();
  const convoId = await conversationWithOrchestrator('ask-unnamed');
  scenario([
    { match: { agent: 'content-lead', promptIncludes: 'asker unnamed brief' }, turn: [{ text: `Delivered. ${MARKERS.COMPLETE}` }] },
    { match: { agent: 'chief-of-staff', promptIncludes: '[SYSTEM: pipeline-complete]' }, hooks: [readOutside()], turn: [{ text: '<silent>' }] },
  ]);
  const thrown = [];
  const record = (err) => thrown.push(err);
  process.on('uncaughtException', record);
  try {
    const since = client.messages.length;
    const hooksBefore = h.readHookAnswers().length;
    client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'content-lead', context: 'asker unnamed brief', _intercepted: true });
    const cardOf = () => client.messages.slice(since).find((m) => m.type === 'control_request' && m._conversationId === convoId);
    const raised = await h.waitUntil(cardOf, { timeout: 15000, interval: 20 });
    assert.deepStrictEqual(thrown.map((e) => String(e && e.message)), [], 'the handback raised no exception');
    assert.ok(raised, 'the parent was started again after its delegate closed, and asked');
    const card = cardOf();
    client.send({ type: 'permission_response', requestId: card.request_id, conversationId: convoId, allow: false, card: true });
    const told = () => h.readHookAnswers().slice(hooksBefore).find((a) => a.agent === 'chief-of-staff' && a.event === 'PreToolUse');
    assert.ok(await h.waitUntil(told, { timeout: 15000, interval: 20 }), 'chief-of-staff was told');
    const started = h.readInvocations().find((i) => i.pid === told().pid);
    assert.ok(started, `the agent that was told is one the server started (pid ${told().pid})`);
    assertAskedAs({ card, started }, convoId, 'chief-of-staff');
    assert.strictEqual(started.resume, null, 'started without a session, as none was named');
    const later = await h.connect();
    try {
      assert.ok(await h.waitUntil(() => later.messages.length > 0, { timeout: 5000, interval: 20 }), 'the server still takes a new window');
    } finally { later.close(); }
    assert.deepStrictEqual(thrown.map((e) => String(e && e.message)), [], 'and nothing was raised after');
  } finally { process.removeListener('uncaughtException', record); }
});

// With no parent named and no process to find, there is nobody to hand back
// to, so the delegate is never started and the conversation stays as it was.
// Called directly, because the socket handler would contain a throw and hide it.
test('lib/delegation/engine.js handleDelegation: an intercepted delegation naming no parent, with no process to find, starts nothing and says nothing', async () => {
  pairTokens();
  const convoId = open(h.freshConvoId('ask-noparent'));
  const since = client.messages.length;
  const delegate = { type: 'delegate', conversationId: convoId, targetAgent: 'content-lead', context: 'asker noparent brief', _intercepted: true };
  assert.doesNotThrow(() => h.internal.handleDelegation(delegate, h.internal.chatProcesses), 'having no agent to hand back to is not an error');
  assert.strictEqual(h.internal.chatProcesses.has(convoId), false, 'no process was put in the conversation');
  await h.delay(300);
  assert.deepStrictEqual(h.readInvocations().filter((i) => i.env.RUNDOCK_CONVO_ID === convoId), [], 'no agent was started');
  assert.deepStrictEqual(client.messages.slice(since).filter((m) => m._conversationId === convoId), [], 'and the conversation was sent nothing');
});

test('lib/delegation/engine.js handleScopeReturn: the orchestrator started for a handback asks as the orchestrator', async () => {
  const convoId = open(h.freshConvoId('ask-return'));
  scenario([
    { match: { agent: 'content-lead', promptIncludes: 'asker return please' }, turn: [{ text: `Outside my lane. ${MARKERS.RETURN}` }] },
    { match: { agent: 'chief-of-staff', promptIncludes: ['[SYSTEM: routing-request]', 'asker return please'] }, hooks: [readOutside()], turn: [{ text: 'Routing it.' }] },
  ]);
  const since = client.messages.length;
  client.send({ type: 'chat', conversationId: convoId, agent: 'content-lead', content: 'asker return please' });
  const r = await refuseNext({ agent: 'chief-of-staff', convo: convoId, since });
  assertAskedAs(r, convoId, 'chief-of-staff');
});

test('lib/delegation/engine.js spawnResumedProcess: the caller resumed after a blocked handoff asks as itself, with the token it had', async () => {
  const convoId = open(h.freshConvoId('ask-blocked'));
  scenario([
    { match: { agent: 'content-lead', promptIncludes: 'asker blocked please' }, turn: [{ agentTool: { subagent_type: 'lead-designer', prompt: 'asker off-roster brief' } }] },
    { match: { agent: 'content-lead', promptIncludes: '[SYSTEM: delegation-blocked]', resume: true }, hooks: [readOutside()], turn: [{ text: 'Routing back.' }] },
  ]);
  const since = client.messages.length;
  client.send({ type: 'chat', conversationId: convoId, agent: 'content-lead', content: 'asker blocked please' });
  const r = await refuseNext({ agent: 'content-lead', convo: convoId, since });
  assert.ok(r.started.resume, 'the caller, resumed with its own session');
  assertAskedAs(r, convoId, 'content-lead');
  const lead = tokensOf('content-lead', convoId);
  assert.ok(lead.length >= 2 && lead.every((t) => t === lead[0]), `the first start and the resume share one token: ${lead.length} starts`);
});

test('lib/delegation/engine.js startWithoutSession: a delegate started fresh, its stored session gone, asks as that delegate', async () => {
  const convoId = await conversationWithOrchestrator('ask-stale');
  const others = h.internal.readConversations().filter((c) => c.id !== convoId);
  h.internal.writeConversations([{ id: convoId, title: convoId, status: 'active', agentId: 'chief-of-staff',
    sessionIds: [{ agentId: 'content-lead', sessionId: 'dead-lead-asker' }] }, ...others]);
  scenario([{ match: { agent: 'content-lead', promptIncludes: 'asker stale brief' }, hooks: [readOutside()], turn: [{ text: 'Asked.' }] }], ['dead-lead-asker']);
  const since = client.messages.length;
  client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'content-lead', context: 'asker stale brief' });
  const r = await refuseNext({ agent: 'content-lead', convo: convoId, since });
  const lead = h.readInvocations().filter((i) => i.agent === 'content-lead' && i.env.RUNDOCK_CONVO_ID === convoId);
  assert.deepStrictEqual(lead.map((i) => i.resume), ['dead-lead-asker', null], 'the stored session was refused, and the delegate started again without it');
  assert.strictEqual(r.started.pid, lead[1].pid, 'the card is the fresh start\'s');
  assertAskedAs(r, convoId, 'content-lead');
});

// ---------------------------------------------------------------------------
// The permission route, asked directly with one agent's token or another's
// ---------------------------------------------------------------------------

let seq = 0;
// A command that always waits on a card, unique to each call.
const cardCommand = () => `node tools/build.js --step ${++seq}`;
const commandOf = (m) => m && m.request && m.request.input && m.request.input.command;

// Ask for `command` in `convo` with `agentId`'s token, and wait for its card.
async function raise(convo, agentId, extra = {}) {
  const command = cardCommand();
  const since = client.messages.length;
  const asked = ask(bash(command, convo, extra), { headers: h.hookHeaders(convo, agentId) });
  const { msg: card } = await client.waitFor((m) => m.type === 'control_request' && commandOf(m) === command, { since, label: `${agentId}'s card` });
  return { asked, card, command };
}
const answer = (card, allow, extra = {}) => client.send({
  type: 'permission_response', requestId: card.request_id, conversationId: card._conversationId || '', allow, card: true, ...extra,
});
const permissionEvents = (convo) => events().filter((e) => e.e === 'permission' && e.conv === convo);

test('a conversation card names the agent its token was issued to, and the server files it under that agent', async () => {
  pairTokens();
  const convo = h.freshConvoId('ask-route');
  const { asked, card } = await raise(convo, 'content-lead');
  assert.strictEqual(card._agent, 'content-lead', 'the card names the token\'s agent');
  assert.strictEqual(card._conversationId, convo);
  assert.strictEqual(h.internal.pendingPermissionRequests.get(card.request_id).agentId, 'content-lead', 'and the server files it under the same agent');
  answer(card, false);
  assert.deepStrictEqual((await asked.reply).body, { allow: false });
});

test('the same request on another agent\'s token in the same conversation names that agent', async () => {
  pairTokens();
  const convo = h.freshConvoId('ask-route');
  const { asked, card } = await raise(convo, 'lead-designer');
  assert.strictEqual(card._agent, 'lead-designer');
  answer(card, false);
  await asked.reply;
});

for (const field of ['agent', '_agent', 'agentId']) {
  test(`a request whose body sets \`${field}\` to another agent still names the token's agent`, async () => {
    pairTokens();
    const convo = h.freshConvoId('ask-body');
    const { asked, card } = await raise(convo, 'content-lead', { [field]: 'lead-designer' });
    assert.strictEqual(card._agent, 'content-lead', `the body's ${field} is never read`);
    assert.strictEqual(h.internal.pendingPermissionRequests.get(card.request_id).agentId, 'content-lead');
    answer(card, false);
    await asked.reply;
  });
}

test('a routine\'s card names no agent of a conversation, keeps its run, and its decision is recorded with no agent', async () => {
  pairTokens();
  const command = cardCommand();
  const since = client.messages.length;
  const run = startRoutine('content-analyst', { hooks: [{ tool: 'Bash', input: { command } }] }, 'asker-routine');
  const { msg: card } = await client.waitFor((m) => m.type === 'control_request' && commandOf(m) === command, { since, label: 'the run\'s card', timeout: 15000 });
  assert.ok(!('_agent' in card), `no _agent: ${JSON.stringify(card)}`);
  assert.ok(card._run && card._run.routine === run.name && card._run.agent === 'content-analyst', 'the run names the routine and its agent');
  answer(card, false);
  const record = await finished(run);
  const runEvents = () => events().filter((e) => e.e === 'permission' && !e.conv && e.d && e.d.decision === 'deny');
  assert.ok(await h.waitUntil(() => runEvents().length > 0), 'the refusal is recorded');
  assert.ok(runEvents().every((e) => !('agent' in e)), `a run's decision names no agent: ${JSON.stringify(runEvents())}`);
  assert.strictEqual(record.refusedCards, 1);
});

test('a window that reconnects while a card waits is sent the card naming the same agent', async () => {
  pairTokens();
  const convo = h.freshConvoId('ask-replay');
  const { asked, card } = await raise(convo, 'content-lead');
  assert.strictEqual(card._agent, 'content-lead');
  const second = await h.connect();
  try {
    const { msg: replayed } = await second.waitFor((m) => m.type === 'control_request' && m.request_id === card.request_id, { label: 'the replayed card' });
    assert.strictEqual(replayed._agent, 'content-lead', 'the replay names the agent the first delivery named');
    assert.strictEqual(replayed._conversationId, convo);
  } finally { second.close(); }
  answer(card, false);
  await asked.reply;
});

test('two agents\' cards in one conversation stay apart: answering one leaves the other waiting, and an asker going away ends only its own', async () => {
  pairTokens();
  const convo = h.freshConvoId('ask-two');
  const first = await raise(convo, 'content-lead');
  const second = await raise(convo, 'chief-of-staff');
  assert.strictEqual(first.card._agent, 'content-lead');
  assert.strictEqual(second.card._agent, 'chief-of-staff');
  let secondAnswer = null;
  second.asked.reply.then((r) => { secondAnswer = r; });

  answer(first.card, true);
  assert.deepStrictEqual((await first.asked.reply).body, { allow: true, card: true }, 'the first is answered');
  await h.delay(300);
  assert.strictEqual(secondAnswer, null, 'the second agent\'s request is still held open');
  assert.ok(h.internal.pendingPermissionRequests.has(second.card.request_id), 'and still waits on its card');
  assert.strictEqual(h.internal.pendingPermissionRequests.get(second.card.request_id).agentId, 'chief-of-staff');

  // A third, then the second's asker goes away: the route ends the second only.
  const third = await raise(convo, 'content-lead');
  const since = client.messages.length;
  second.asked.abort();
  const { msg: ended } = await client.waitFor((m) => m.type === 'permission_ended' && m.requestId === second.card.request_id, { since, label: 'the second ended' });
  assert.strictEqual(ended.reason, 'ended');
  await h.delay(200);
  assert.ok(!client.messages.slice(since).some((m) => m.type === 'permission_ended' && m.requestId === third.card.request_id), 'the third was not ended');
  assert.ok(h.internal.pendingPermissionRequests.has(third.card.request_id), 'and still waits');
  answer(third.card, false);
  await third.asked.reply;
});

// The card timeout, short for one test, through the router's own wiring.
async function withTimeout(ms, fn) {
  const prev = ROUTER.wireHttpRouterDeps({ getPermissionTimeoutMs: () => ms });
  try { return await fn(); } finally { ROUTER.wireHttpRouterDeps({ getPermissionTimeoutMs: prev.getPermissionTimeoutMs }); }
}

test('two agents\' cards each time out on their own, and each timeout is recorded with its own agent', async () => {
  pairTokens();
  const convo = h.freshConvoId('ask-timeout');
  await withTimeout(400, async () => {
    const first = await raise(convo, 'content-lead');
    const second = await raise(convo, 'lead-designer');
    assert.deepStrictEqual((await first.asked.reply).body, { allow: false, reason: 'timeout' });
    assert.deepStrictEqual((await second.asked.reply).body, { allow: false, reason: 'timeout' });
    assert.ok(client.messages.some((m) => m.type === 'permission_timeout' && m.requestId === first.card.request_id), 'the window is told of the first');
    assert.ok(client.messages.some((m) => m.type === 'permission_timeout' && m.requestId === second.card.request_id), 'and of the second');
  });
  const timeouts = () => permissionEvents(convo).filter((e) => e.d.decision === 'timeout');
  assert.ok(await h.waitUntil(() => timeouts().length === 2), `both recorded: ${JSON.stringify(permissionEvents(convo))}`);
  assert.deepStrictEqual(timeouts().map((e) => e.agent).sort(), ['content-lead', 'lead-designer']);
});

test('the person\'s answer is recorded with the agent the server filed the card for, never one the window\'s message names', async () => {
  pairTokens();
  const convo = h.freshConvoId('ask-answer');
  const { asked, card } = await raise(convo, 'content-lead');
  answer(card, false, { agentId: 'lead-designer', agent: 'lead-designer', _agent: 'lead-designer' });
  await asked.reply;
  const denied = () => permissionEvents(convo).filter((e) => e.d.decision === 'deny');
  assert.ok(await h.waitUntil(() => denied().length === 1), `recorded: ${JSON.stringify(permissionEvents(convo))}`);
  assert.strictEqual(denied()[0].agent, 'content-lead');
});

test('a read the server answers itself is recorded with the token\'s agent', async () => {
  pairTokens();
  const convo = h.freshConvoId('ask-read');
  const r = await ask(bash('ls -la', convo), { headers: h.hookHeaders(convo, 'lead-designer') }).reply;
  assert.deepStrictEqual(r.body, { allow: true, reason: 'read-only' });
  assert.ok(await h.waitUntil(() => permissionEvents(convo).length === 1), 'recorded');
  assert.strictEqual(permissionEvents(convo)[0].agent, 'lead-designer');
});

// ---------------------------------------------------------------------------
// Saved answers and grants stay per workspace
// ---------------------------------------------------------------------------

async function toolAllows(type, key, settled) {
  const since = client.messages.length;
  client.send({ type, key });
  await client.waitFor((m) => m.type === 'tool_allows' && settled(m.tools), { since, label: `${type} ${key}` });
}

test('a saved "Always allow" answers the same request the same way on two agents\' tokens', async () => {
  pairTokens();
  const convo = h.freshConvoId('ask-saved');
  assert.ok(await h.waitUntil(() => !guard.answerFilesWatched(config.getWorkspace()), { timeout: 5000 }), 'no other turn is running');
  const turn = guard.acquireAnswerFileGuard(config.getWorkspace(), () => {}, { intervalMs: HOUR, convoId: convo });
  try {
    await toolAllows('add_tool_allow', 'Bash:python3', (tools) => tools.includes('Bash:python3'));
    for (const agentId of ['content-lead', 'chief-of-staff']) {
      const r = await ask(bash('python3 tools/report.py', convo), { headers: h.hookHeaders(convo, agentId) }).reply;
      assert.deepStrictEqual(r.body, { allow: true, reason: 'always-allowed' }, `answered from the saved answer on ${agentId}'s token`);
    }
    const saved = () => permissionEvents(convo).filter((e) => e.d.reason === 'always-allowed');
    assert.ok(await h.waitUntil(() => saved().length === 2), 'both recorded');
    assert.deepStrictEqual(saved().map((e) => e.agent).sort(), ['chief-of-staff', 'content-lead'], 'each with the agent that asked');
  } finally {
    turn.release();
    await toolAllows('remove_tool_allow', 'Bash:python3', (tools) => !tools.includes('Bash:python3'));
  }
});

test('a standing folder grant answers the same request the same way on two agents\' tokens', async () => {
  pairTokens();
  const convo = h.freshConvoId('ask-grant');
  const granted = makeTempDir('asker-grant-');
  addBoundaryGrant(granted);
  const file = path.join(granted, 'note.md');
  for (const agentId of ['content-lead', 'lead-designer']) {
    const body = { tool_name: 'Read', tool_input: { file_path: file }, conversation_id: convo, boundary: true, crossings: [{ path: file }] };
    const r = await ask(body, { headers: h.hookHeaders(convo, agentId) }).reply;
    assert.deepStrictEqual(r.body, { allow: true, reason: 'standing-folder-grant' }, `answered from the grant on ${agentId}'s token`);
  }
  assert.ok(await h.waitUntil(() => permissionEvents(convo).length === 2), 'both recorded');
  assert.deepStrictEqual(permissionEvents(convo).map((e) => e.agent).sort(), ['content-lead', 'lead-designer'], 'each with the agent that asked');
});

// ---------------------------------------------------------------------------
// The agent notice, handed over by the conversation the token names
// ---------------------------------------------------------------------------

function getNotice(token, convo) {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: h.port, path: `/api/agent-notice?conversation=${encodeURIComponent(convo)}`, headers: { [auth.HOOK_HEADER]: token } }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { let body = null; try { body = JSON.parse(b); } catch (e) { /* not JSON */ } resolve({ status: res.statusCode, body }); });
    }).on('error', (e) => resolve({ error: e.code || e.message }));
  });
}

test('the agent notice is handed to the conversation an agent\'s token names', async () => {
  pairTokens();
  const convo = h.freshConvoId('ask-notice');
  assert.ok(leaveAgentNotice(convo, 'A change was put back.'));
  const r = await getNotice(auth.issueHookToken(convo, 'content-lead'), convo);
  assert.strictEqual(r.status, 200);
  assert.match(String(r.body && r.body.text), /A change was put back\./);
});

test('a run\'s token is handed no conversation\'s notice', async () => {
  pairTokens();
  const convo = h.freshConvoId('ask-notice-run');
  assert.ok(leaveAgentNotice(convo, 'Kept for the conversation.'));
  const runToken = auth.issueRunHookToken('asker-run');
  try {
    const r = await getNotice(runToken, convo);
    assert.deepStrictEqual(r, { status: 200, body: { text: null } });
  } finally { auth.retireRunHookToken(runToken); }
  const kept = await getNotice(auth.issueHookToken(convo, 'chief-of-staff'), convo);
  assert.match(String(kept.body && kept.body.text), /Kept for the conversation\./, 'the line waits for its own conversation');
});

test('an unknown token is refused the agent notice', async () => {
  pairTokens();
  const r = await getNotice('not-a-token-this-launch-issued', 'ask-notice-unknown');
  assert.deepStrictEqual(r, { status: 401, body: { text: null } });
});

// ---------------------------------------------------------------------------
// Cards the server raises itself
// ---------------------------------------------------------------------------

for (const [kind, approval, tool] of [
  ['command', { kind: 'command', command: 'rm -rf build && ./deploy.sh', reason: 'needs to run outside the sandbox' }, process.platform === 'win32' ? 'PowerShell' : 'Bash'],
  ['file change', { kind: 'fileChange', grantRoot: '/etc/rundock', reason: 'writes outside writable roots' }, 'WriteFile'],
]) {
  test(`a Codex agent's ${kind} card names that agent, live and on the replay`, async () => {
    pairTokens();
    const convoId = open(h.freshConvoId('ask-codex'));
    const prompt = `asker codex ${kind} please`;
    h.writeCodexScenario([{ match: { promptIncludes: prompt }, approval: { ...approval, afterDecision: { accept: { text: 'Done.' }, decline: { text: 'Skipped.' } } } }]);
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: prompt });
    const { msg: card } = await client.waitFor((m) => m.type === 'control_request' && m._conversationId === convoId, { since, label: 'the codex card', timeout: 15000 });
    assert.strictEqual(card.request.tool_name, tool);
    assert.strictEqual(card._agent, 'researcher', 'the live card names the Codex agent');
    const second = await h.connect();
    try {
      const { msg: replayed } = await second.waitFor((m) => m.type === 'control_request' && m.request_id === card.request_id, { label: 'the replayed codex card' });
      assert.strictEqual(replayed._agent, 'researcher', 'and so does the replay');
    } finally { second.close(); }
    answer(card, false);
    await client.waitForEvent('system', 'done', convoId, { since });
  });
}

test('a connector card names no asker', async () => {
  pairTokens();
  const since = client.messages.length;
  client.send({ type: 'save_connector', name: 'asker-tools', content: JSON.stringify({ command: 'node', args: ['tools/server.js', '--stdio'] }), conversationId: 'ask-connector' });
  const { msg: card } = await client.waitFor((m) => m.type === 'control_request' && m.request && m.request.tool_name === 'SaveConnector', { since, label: 'connector card' });
  assert.ok(!('_agent' in card), `no _agent: ${JSON.stringify(card)}`);
  assert.ok(!h.internal.pendingPermissionRequests.get(card.request_id).agentId, 'and the server files it under no agent');
  answer(card, false);
});
