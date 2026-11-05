'use strict';
// EVERY PRODUCTION SPAWN OF AN AGENT, DRIVEN THROUGH A REFUSED CARD.
//
// test/unit/unattended-spawn-paths.test.js lists every place the app starts
// the Claude CLI, and names, for each spawn of an agent, the test here that
// drives it. Each test below starts that one spawn for real, against the real
// server and the stub runtime, and has the agent it started ask for a read
// outside the workspace through Rundock's real permission hook (the stub's
// `hooks` step, run with the environment that spawn gave it). The card is
// refused, and the test reads what the agent was started with (its logged
// invocation, tied to the hook's answer by pid) and what it was told.
//
// A routine's run is started with no conversation, and told to carry on or say
// it failed. Every conversation spawn is started with its conversation, and
// told to stop and ask. A chat message with no conversation id is the default
// conversation, never none.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const h = require('../helpers/harness.js');
const { agentFile, standardTeam, makeTempDir } = require('../helpers/workspace.js');
const { MARKERS } = require('../fixtures/stream-json.js');
const { refusalNotice } = require('../../scripts/refusal-notice.js');

const ROUTINE_AGENT = 'keeper';
const ATTENDED = refusalNotice('denied', 'Bash');
const UNATTENDED = refusalNotice('denied', 'Bash', { unattended: true });
let client, outside;

before(async () => {
  await h.boot({ agents: { ...standardTeam(), keeper: agentFile({ name: ROUTINE_AGENT, type: 'specialist', order: 5 }) } });
  h.internal.stopScheduler();
  outside = makeTempDir('spawn-path-outside-');
  fs.writeFileSync(path.join(outside, 'notes.md'), '# notes\n');
  client = await h.connect();
});
// Every conversation a test opens is reaped after it, passed or failed, and
// every agent the suite started is ended before the server closes: one left
// running holds the server open, and a failing test would then never finish.
const opened = new Set();
const open = (convoId) => { opened.add(convoId); return convoId; };
afterEach(() => {
  for (const convoId of opened) h.reapConvo(convoId);
  opened.clear();
});
after(async () => {
  // A card a failed test never refused is refused now, so no hook is left
  // holding a request open (a card already settled finds nothing to answer).
  for (const m of client.messages.filter((x) => x.type === 'control_request')) {
    client.send({ type: 'permission_response', requestId: m.request_id, conversationId: m._conversationId || '', allow: false, card: true });
  }
  await h.delay(200);
  for (const { pid } of h.readInvocations()) {
    try { process.kill(pid, 'SIGKILL'); } catch (e) { /* already ended */ }
  }
  await h.shutdown();
});

const readOutside = () => ({ tool: 'Bash', input: { command: `cat ${path.join(outside, 'notes.md')}` } });
const reasonOf = (a) => a.answer.hookSpecificOutput.permissionDecisionReason;

// The stub's script, with the sessions Claude Code no longer has.
function scenario(rules, deadSessions = []) {
  fs.writeFileSync(path.join(h.workspaceDir, 'stub-scenario.json'), JSON.stringify({ rules, deadSessions }, null, 2));
}

async function poll(fn, label, ms = 15000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${label}`);
    await h.delay(20);
  }
}

// Refuse the next card raised for `convo` (or for the routine named), and
// return what the agent that raised it was told and was started with.
async function refuseNext({ agent, convo, routine, since }) {
  const hooksBefore = h.readHookAnswers().length;
  const { msg: card } = await client.waitFor((m) => m.type === 'control_request'
    && (routine ? !!(m._run && m._run.routine === routine) : m._conversationId === convo), { since, label: `${agent} card`, timeout: 15000 });
  client.send({ type: 'permission_response', requestId: card.request_id, conversationId: routine ? '' : convo, allow: false, card: true });
  const told = await poll(() => h.readHookAnswers().slice(hooksBefore).find((a) => a.agent === agent && a.event === 'PreToolUse'), `${agent}'s answer`);
  const started = h.readInvocations().find((i) => i.pid === told.pid);
  assert.ok(started, `the agent that was told is one the server started (pid ${told.pid})`);
  return { card, told, started };
}

function assertStartedAndTold({ told, started }, convo, words) {
  assert.strictEqual(started.env.RUNDOCK, '1', 'started as one of Rundock\'s agents');
  assert.strictEqual(started.env.RUNDOCK_CONVO_ID, convo, 'started with this conversation');
  assert.strictEqual(told.convo, convo, 'and its hook ran with it');
  assert.strictEqual(told.answer.hookSpecificOutput.permissionDecision, 'deny');
  assert.strictEqual(reasonOf(told), words);
}

test('lib/scheduler.js beginRun: a routine\'s run is started with no conversation, and told to carry on or say it failed', async () => {
  scenario([{ match: { agent: ROUTINE_AGENT, promptIncludes: 'spawn path routine' }, hooks: [readOutside()], turn: [{ text: 'Did the rest.' }] }]);
  client.send({ type: 'save_routine', agentId: ROUTINE_AGENT, routine: { name: 'spawn-path', schedule: 'every day at 07:00', prompt: 'spawn path routine', runOn: 'local' } });
  await client.waitFor((m) => m.type === 'routine_saved' && m.name === 'spawn-path', { label: 'saved' });
  const since = client.messages.length;
  client.send({ type: 'run_routine_now', agentId: ROUTINE_AGENT, name: 'spawn-path', occurrence: 0 });
  const r = await refuseNext({ agent: ROUTINE_AGENT, routine: 'spawn-path', since });
  assert.strictEqual(r.card._conversationId || '', '', 'its card belongs to no conversation');
  assertStartedAndTold(r, null, UNATTENDED);
});

test('server.js, the chat message (interactive): a conversation\'s turn is started with its conversation, and told to stop and ask', async () => {
  const convoId = open(h.freshConvoId('sp-chat'));
  scenario([{ match: { agent: 'chief-of-staff', promptIncludes: 'spawn path chat' }, hooks: [readOutside()], turn: [{ text: 'Asked.' }] }]);
  const since = client.messages.length;
  client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'spawn path chat' });
  const r = await refuseNext({ agent: 'chief-of-staff', convo: convoId, since });
  assert.strictEqual(r.started.print, false, 'the interactive spawn');
  assertStartedAndTold(r, convoId, ATTENDED);
});

test('server.js, the chat message (interactive) with no conversation id: the default conversation, told to stop and ask', async () => {
  scenario([{ match: { agent: 'chief-of-staff', promptIncludes: 'spawn path no id' }, hooks: [readOutside()], turn: [{ text: 'Asked.' }] }]);
  const since = client.messages.length;
  open('default');
  client.send({ type: 'chat', agent: 'chief-of-staff', content: 'spawn path no id' });
  const r = await refuseNext({ agent: 'chief-of-staff', convo: 'default', since });
  assert.strictEqual(r.started.print, false, 'the interactive spawn');
  assertStartedAndTold(r, 'default', ATTENDED);
});

test('server.js, the chat message (legacy): a conversation\'s turn is started with its conversation, and told to stop and ask', async () => {
  const convoId = open(h.freshConvoId('sp-legacy'));
  process.env.RUNDOCK_LEGACY_SPAWN = '1';
  try {
    scenario([{ match: { agent: 'chief-of-staff', promptIncludes: 'spawn path legacy' }, hooks: [readOutside()], turn: [{ text: 'Asked.' }] }]);
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'spawn path legacy' });
    const r = await refuseNext({ agent: 'chief-of-staff', convo: convoId, since });
    assert.strictEqual(r.started.print, true, 'the legacy spawn, one process per message');
    assertStartedAndTold(r, convoId, ATTENDED);
  } finally { delete process.env.RUNDOCK_LEGACY_SPAWN; }
});

test('server.js, the chat message (legacy) with no conversation id: the default conversation too', async () => {
  process.env.RUNDOCK_LEGACY_SPAWN = '1';
  try {
    scenario([{ match: { agent: 'chief-of-staff', promptIncludes: 'spawn path legacy no id' }, hooks: [readOutside()], turn: [{ text: 'Asked.' }] }]);
    const since = client.messages.length;
    open('default');
    client.send({ type: 'chat', agent: 'chief-of-staff', content: 'spawn path legacy no id' });
    const r = await refuseNext({ agent: 'chief-of-staff', convo: 'default', since });
    assert.strictEqual(r.started.print, true, 'the legacy spawn');
    assertStartedAndTold(r, 'default', ATTENDED);
  } finally { delete process.env.RUNDOCK_LEGACY_SPAWN; }
});

// A conversation with an orchestrator already answering in it.
async function conversationWithOrchestrator(prefix) {
  const convoId = open(h.freshConvoId(prefix));
  scenario([{ match: { agent: 'chief-of-staff', promptIncludes: `${prefix} setup` }, turn: [{ text: 'Ready.' }] }]);
  client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: `${prefix} setup` });
  await client.waitForEvent('system', 'done', convoId);
  return convoId;
}

test('lib/delegation/engine.js handleDelegation, the delegate: started with the conversation it was delegated in, and told to stop and ask', async () => {
  const convoId = await conversationWithOrchestrator('sp-delegate');
  scenario([{ match: { agent: 'content-lead', promptIncludes: 'spawn path delegate brief' }, hooks: [readOutside()], turn: [{ text: 'Asked.' }] }]);
  const since = client.messages.length;
  client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'content-lead', context: 'spawn path delegate brief' });
  const r = await refuseNext({ agent: 'content-lead', convo: convoId, since });
  assert.strictEqual(r.started.resume, null, 'a delegate with no session yet starts cold');
  assertStartedAndTold(r, convoId, ATTENDED);
});

test('lib/delegation/engine.js handleDelegation, the parent resumed after its delegate finished: keeps the conversation, and is told to stop and ask', async () => {
  const convoId = open(h.freshConvoId('sp-parent'));
  scenario([
    { match: { agent: 'chief-of-staff', promptIncludes: 'spawn path parent please' }, turn: [{ agentTool: { subagent_type: 'content-lead', prompt: 'spawn path parent brief' } }] },
    { match: { agent: 'content-lead', promptIncludes: 'spawn path parent brief' }, turn: [{ text: `Delivered. ${MARKERS.COMPLETE}` }] },
    { match: { agent: 'chief-of-staff', promptIncludes: '[SYSTEM: pipeline-complete]', resume: true }, hooks: [readOutside()], turn: [{ text: 'Back with the result.' }] },
  ]);
  const since = client.messages.length;
  client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'spawn path parent please' });
  const r = await refuseNext({ agent: 'chief-of-staff', convo: convoId, since });
  assert.ok(r.started.resume, 'the parent, resumed with its own session');
  assertStartedAndTold(r, convoId, ATTENDED);
});

test('lib/delegation/engine.js handleScopeReturn: the orchestrator started for a specialist\'s handback keeps the conversation, and is told to stop and ask', async () => {
  const convoId = open(h.freshConvoId('sp-return'));
  scenario([
    { match: { agent: 'content-lead', promptIncludes: 'spawn path return please' }, turn: [{ text: `Outside my lane. ${MARKERS.RETURN}` }] },
    { match: { agent: 'chief-of-staff', promptIncludes: ['[SYSTEM: routing-request]', 'spawn path return please'] }, hooks: [readOutside()], turn: [{ text: 'Routing it.' }] },
  ]);
  const since = client.messages.length;
  client.send({ type: 'chat', conversationId: convoId, agent: 'content-lead', content: 'spawn path return please' });
  const r = await refuseNext({ agent: 'chief-of-staff', convo: convoId, since });
  assert.strictEqual(r.started.resume, null, 'the handback\'s orchestrator is a cold start');
  assertStartedAndTold(r, convoId, ATTENDED);
});

test('lib/delegation/engine.js spawnResumedProcess: the caller resumed after a blocked handoff keeps the conversation, and is told to stop and ask', async () => {
  const convoId = open(h.freshConvoId('sp-blocked'));
  scenario([
    { match: { agent: 'content-lead', promptIncludes: 'spawn path blocked please' }, turn: [{ agentTool: { subagent_type: 'lead-designer', prompt: 'spawn path off-roster brief' } }] },
    { match: { agent: 'content-lead', promptIncludes: '[SYSTEM: delegation-blocked]', resume: true }, hooks: [readOutside()], turn: [{ text: 'Routing back.' }] },
  ]);
  const since = client.messages.length;
  client.send({ type: 'chat', conversationId: convoId, agent: 'content-lead', content: 'spawn path blocked please' });
  const r = await refuseNext({ agent: 'content-lead', convo: convoId, since });
  assert.ok(r.started.resume, 'the caller, resumed with its own session');
  assertStartedAndTold(r, convoId, ATTENDED);
});

test('lib/delegation/engine.js startWithoutSession: a delegate started fresh, its stored session gone, keeps the conversation, and is told to stop and ask', async () => {
  const convoId = await conversationWithOrchestrator('sp-stale');
  const others = h.internal.readConversations().filter((c) => c.id !== convoId);
  h.internal.writeConversations([{ id: convoId, title: convoId, status: 'active', agentId: 'chief-of-staff',
    sessionIds: [{ agentId: 'content-lead', sessionId: 'dead-lead-spawn-path' }] }, ...others]);
  scenario([{ match: { agent: 'content-lead', promptIncludes: 'spawn path stale brief' }, hooks: [readOutside()], turn: [{ text: 'Asked.' }] }], ['dead-lead-spawn-path']);
  const since = client.messages.length;
  client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'content-lead', context: 'spawn path stale brief' });
  const r = await refuseNext({ agent: 'content-lead', convo: convoId, since });
  const lead = h.readInvocations().filter((i) => i.agent === 'content-lead' && i.env.RUNDOCK_CONVO_ID === convoId);
  assert.deepStrictEqual(lead.map((i) => i.resume), ['dead-lead-spawn-path', null], 'the stored session was refused, and the delegate started again without it');
  assert.strictEqual(r.started.pid, lead[1].pid, 'the card is the fresh start\'s');
  assertStartedAndTold(r, convoId, ATTENDED);
});

test('a delegation with no conversation id starts nobody', async () => {
  const before = h.readInvocations().length;
  const since = client.messages.length;
  scenario([{ match: { agent: 'content-lead' }, hooks: [readOutside()], turn: [{ text: 'A delegate with no conversation.' }] }]);
  client.send({ type: 'delegate', targetAgent: 'content-lead', context: 'spawn path no conversation' });
  const { msg } = await client.waitFor((m) => m.type === 'system' && m.subtype === 'delegation_error', { since, label: 'refused' });
  assert.strictEqual(msg.content, 'No active process to delegate from');
  await h.delay(300);
  assert.deepStrictEqual(h.readInvocations().slice(before), [], 'nothing was started');
});
