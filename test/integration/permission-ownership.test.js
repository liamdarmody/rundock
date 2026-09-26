'use strict';
// Integration: who a permission request belongs to, and when it is over.
//
// A routine has no conversation, so a request its agent raises arrives with
// none. The server used to forward it bare, and the client put it in whatever
// conversation was open. Here the server's half is pinned: a routine's
// request is attributed to its run by the session the scheduler spawned, and
// a request that ends (answered in any window, answered too late, or its
// asker gone) says so to every window, so no copy of its card is left
// accepting a click nothing will receive. The client's half is pinned in
// test/unit/permission-ownership.test.js and test/e2e/permission-ownership.spec.js.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const h = require('../helpers/harness.js');
const { agentFile } = require('../helpers/workspace.js');
const scheduler = require('../../lib/scheduler.js');

const AGENT = 'runner';
const ROUTINE = 'held-triage';
const PROMPT = 'held routine body';
const PERM_TIMEOUT = 1500;
let client;

before(async () => {
  await h.boot({
    agents: { runner: agentFile({ name: AGENT, type: 'specialist', order: 1 }) },
    env: { RUNDOCK_PERMISSION_TIMEOUT_MS: String(PERM_TIMEOUT) },
  });
  // The run stays live long enough to raise a request while it is going.
  h.writeScenario([{ match: { agent: AGENT, promptIncludes: PROMPT }, delayMs: 4000, turn: [{ text: 'held run ran' }] }]);
  h.internal.stopScheduler();
  client = await h.connect();
});
after(async () => h.shutdown());

const runsDir = () => path.join(h.workspaceDir, '.rundock', 'runs');
const records = () => (fs.existsSync(runsDir()) ? fs.readdirSync(runsDir()) : [])
  .map(name => JSON.parse(fs.readFileSync(path.join(runsDir(), name), 'utf-8')));

function postJson(body) {
  return fetch(`http://127.0.0.1:${h.port}/api/permission-request`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then(async res => JSON.parse(await res.text()));
}

test('a request from a routine run is attributed to the run, never to a conversation', async () => {
  client.send({ type: 'save_routine', agentId: AGENT, routine: { name: ROUTINE, schedule: 'every day at 07:00', prompt: PROMPT, runOn: 'local' } });
  await client.waitFor(m => m.type === 'routine_saved', { label: 'routine_saved' });
  client.send({ type: 'run_routine_now', agentId: AGENT, name: ROUTINE, occurrence: 0 });
  assert.ok(await h.waitUntil(() => records().some(r => r.status === 'running' && r.sessionId)), 'the run is live with a session');
  const run = records().find(r => r.status === 'running');
  assert.deepStrictEqual(scheduler.runForSession(run.sessionId), { id: run.id, routine: ROUTINE, agent: AGENT },
    'the scheduler names the live run for its session');

  const since = client.messages.length;
  const answer = postJson({ tool_name: 'Bash', tool_input: { command: 'sh apply-labels.sh' }, session_id: run.sessionId, conversation_id: '' });
  const { msg: card } = await client.waitFor(m => m.type === 'control_request', { since, label: 'the routine card' });
  assert.strictEqual(card._conversationId, '', 'it borrows no conversation');
  assert.deepStrictEqual(card._run, { id: run.id, routine: ROUTINE, agent: AGENT }, 'it names the run, the routine and the agent');

  // A window that connects while it waits gets the same attribution on replay.
  const late = await h.connect();
  const { msg: replay } = await late.waitFor(m => m.type === 'control_request' && m.request_id === card.request_id, { label: 'the replayed card' });
  assert.deepStrictEqual(replay._run, card._run);
  late.close();

  assert.deepStrictEqual(await answer, { allow: false, reason: 'timeout' }, 'unanswered, it is denied at the timeout as before');
  assert.ok(await h.waitUntil(() => records().every(r => r.status !== 'running'), 8000), 'the run ends');
  assert.strictEqual(scheduler.runForSession(run.sessionId), null, 'and an ended run owns nothing');
});

test('a request whose session matches nothing carries neither a conversation nor a run', async () => {
  const since = client.messages.length;
  const answer = postJson({ tool_name: 'Bash', tool_input: { command: 'sh stray.sh' }, session_id: 'no-such-session', conversation_id: '' });
  const { msg: card } = await client.waitFor(m => m.type === 'control_request', { since, label: 'the stray card' });
  assert.strictEqual(card._conversationId, '');
  assert.strictEqual(card._run, undefined);
  client.send({ type: 'permission_response', requestId: card.request_id, conversationId: '', allow: false });
  assert.strictEqual((await answer).allow, false);
});

test('an answer in one window is announced to every window', async () => {
  const other = await h.connect();
  const since = client.messages.length;
  const otherSince = other.messages.length;
  const answer = postJson({ tool_name: 'Bash', tool_input: { command: 'sh two-windows.sh' }, conversation_id: 'convo-two-windows' });
  const { msg: card } = await client.waitFor(m => m.type === 'control_request', { since, label: 'the card' });
  client.send({ type: 'permission_response', requestId: card.request_id, conversationId: 'convo-two-windows', allow: true });
  assert.strictEqual((await answer).allow, true);
  const { msg: ended } = await other.waitFor(m => m.type === 'permission_ended' && m.requestId === card.request_id, { since: otherSince, label: 'the other window hears' });
  assert.strictEqual(ended.reason, 'answered');
  assert.strictEqual(ended.allow, true);
  other.close();
});

test('an answer to a request nothing is waiting on is told it was too late', async () => {
  const since = client.messages.length;
  client.send({ type: 'permission_response', requestId: 'perm-long-gone', conversationId: '', allow: true });
  const { msg } = await client.waitFor(m => m.type === 'permission_ended' && m.requestId === 'perm-long-gone', { since, label: 'too late' });
  assert.strictEqual(msg.reason, 'not-pending');
});

test('a request whose asker goes away ends at once, for every window', async () => {
  const since = client.messages.length;
  const req = http.request({ host: '127.0.0.1', port: h.port, path: '/api/permission-request', method: 'POST', headers: { 'Content-Type': 'application/json' } });
  req.on('error', () => {});
  req.end(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'sh asker-leaves.sh' }, conversation_id: 'convo-asker' }));
  const { msg: card } = await client.waitFor(m => m.type === 'control_request' && m._conversationId === 'convo-asker', { since, label: 'the card' });
  req.destroy();
  const { msg: ended } = await client.waitFor(m => m.type === 'permission_ended' && m.requestId === card.request_id, { since, label: 'ended' });
  assert.strictEqual(ended.reason, 'ended');
  assert.ok(!h.internal.pendingPermissionRequests.has(card.request_id), 'and nothing is left pending');
});

test('a window that connects is told exactly which requests are still waiting', async () => {
  const since = client.messages.length;
  const answer = postJson({ tool_name: 'Bash', tool_input: { command: 'sh snapshot.sh' }, conversation_id: 'convo-snapshot' });
  const { msg: card } = await client.waitFor(m => m.type === 'control_request', { since, label: 'the card' });
  const during = await h.connect();
  const { msg: snap } = await during.waitFor(m => m.type === 'pending_permissions', { label: 'the snapshot while waiting' });
  assert.ok(snap.requestIds.includes(card.request_id), 'a waiting request is named');
  during.close();
  await answer; // times out
  const afterwards = await h.connect();
  const { msg: snap2 } = await afterwards.waitFor(m => m.type === 'pending_permissions', { label: 'the snapshot afterwards' });
  assert.ok(!snap2.requestIds.includes(card.request_id), 'an ended request is not');
  afterwards.close();
});

test('a request buffered while no window was open is not delivered once it has ended', async () => {
  client.close();
  await h.delay(100);
  const res = await postJson({ tool_name: 'Bash', tool_input: { command: 'sh nobody-home.sh' }, conversation_id: 'convo-buffered' });
  assert.strictEqual(res.reason, 'timeout');
  client = await h.connect();
  const since = client.messages.length;
  client.send({ type: 'flush_buffer' });
  await h.delay(400);
  const delivered = client.messages.slice(since).filter(m => m.type === 'control_request' && m._conversationId === 'convo-buffered');
  assert.deepStrictEqual(delivered, [], 'the stale card is not handed to the window that just arrived');
});
