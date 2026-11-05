'use strict';
// Integration: a routine run's cards are its own, by the hook token it was
// started with, end to end.
//
// Each run is driven for real: the scheduler starts the stub runtime with the
// environment a routine is given, and the stub runs Rundock's real permission
// hook as its own process, carrying the run's token, against the real server.
// Nothing in the request decides which run a card belongs to: a call naming
// another live run's session, a Task subagent's call, and a call from a
// `claude` started in the run's own shell (with a session of its own, or none)
// are each the run's. A token whose run has ended is refused as unknown.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const h = require('../helpers/harness.js');
const { agentFile, makeTempDir } = require('../helpers/workspace.js');
const { refusalNotice } = require('../../scripts/refusal-notice.js');

const KEEPER = 'keeper';
const LEDGER = 'ledger';
let client, outside;

before(async () => {
  await h.boot({
    agents: {
      keeper: agentFile({ name: KEEPER, type: 'specialist', order: 1 }),
      ledger: agentFile({ name: LEDGER, type: 'specialist', order: 2 }),
    },
  });
  h.internal.stopScheduler();
  outside = makeTempDir('run-token-outside-');
  fs.writeFileSync(path.join(outside, 'notes.md'), '# notes\n');
  client = await h.connect();
});
after(async () => h.shutdown());

// A read outside the workspace, which always raises a card. `extra` sets
// fields of the hook's payload; one set to null is left out.
const readOutside = (extra) => ({ tool: 'Bash', input: { command: `cat ${path.join(outside, 'notes.md')}` }, ...(extra ? { extra } : {}) });
const runsDir = () => path.join(h.workspaceDir, '.rundock', 'runs');
const records = () => (fs.existsSync(runsDir()) ? fs.readdirSync(runsDir()) : [])
  .filter((n) => n.endsWith('.json'))
  .map((name) => JSON.parse(fs.readFileSync(path.join(runsDir(), name), 'utf-8')));
const recordOf = (name) => records().find((r) => r.routine === name);
// The stub's own invocation for a run, found by the session the run passed it.
const tokenOf = (record) => {
  const inv = h.readInvocations().find((i) => i.argv.includes(record.sessionId));
  return inv && inv.env.RUNDOCK_HOOK_TOKEN;
};
const UNATTENDED_DENIED = refusalNotice('denied', 'Bash', { unattended: true });

async function save(agentId, name, prompt) {
  client.send({ type: 'save_routine', agentId, routine: { name, schedule: 'every day at 07:00', prompt, runOn: 'local' } });
  await client.waitFor((m) => m.type === 'routine_saved' && m.name === name, { label: `${name} saved` });
}
function press(agentId, name) {
  client.send({ type: 'run_routine_now', agentId, name, occurrence: 0 });
}
const closed = (name) => h.waitUntil(() => { const r = recordOf(name); return r && r.status !== 'running'; }, { timeout: 15000 });

test('a card raised with one run\'s token, naming another live run\'s session, is the first run\'s and names its routine and agent', async () => {
  // Run B is going, and holds.
  const holds = { match: { agent: LEDGER, promptIncludes: 'b holds' }, delayMs: 3000, turn: [{ text: 'B done.' }] };
  h.writeScenario([holds]);
  await save(LEDGER, 'token-b', 'b holds');
  press(LEDGER, 'token-b');
  assert.ok(await h.waitUntil(() => { const r = recordOf('token-b'); return r && r.status === 'running' && r.sessionId; }), 'run B is going');
  const b = recordOf('token-b');

  // Run A asks, its hook naming run B's session in the request.
  h.writeScenario([holds, { match: { agent: KEEPER, promptIncludes: 'a asks' }, hooks: [readOutside({ session_id: b.sessionId })], turn: [{ text: 'A done.' }] }]);
  await save(KEEPER, 'token-a', 'a asks');
  const since = client.messages.length;
  press(KEEPER, 'token-a');
  const { msg: card } = await client.waitFor((m) => m.type === 'control_request' && m._run, { since, label: 'run A\'s card' });
  const a = recordOf('token-a');
  assert.deepStrictEqual(card._run, { id: a.id, routine: 'token-a', agent: KEEPER }, 'run A\'s card, naming run A\'s routine and agent');
  assert.strictEqual(card._conversationId, '');
  client.send({ type: 'permission_response', requestId: card.request_id, conversationId: '', allow: false, card: true });

  assert.ok(await h.waitUntil(() => h.readHookAnswers().some((x) => x.agent === KEEPER && x.sentSession === b.sessionId)), 'run A\'s hook was answered');
  const told = h.readHookAnswers().find((x) => x.agent === KEEPER && x.sentSession === b.sessionId);
  assert.strictEqual(told.answer.hookSpecificOutput.permissionDecisionReason, UNATTENDED_DENIED);
  assert.ok(await closed('token-a') && await closed('token-b'), 'both runs end');

  const [tokenA, tokenB] = [tokenOf(a), tokenOf(b)];
  assert.ok(tokenA && tokenB && tokenA !== tokenB, 'each run was started with a token of its own');
});

test('a run\'s token, once its record has closed, is refused as unknown and files nothing', async () => {
  h.writeScenario([{ match: { agent: KEEPER, promptIncludes: 'ends at once' }, turn: [{ text: 'Done.' }] }]);
  await save(KEEPER, 'token-ended', 'ends at once');
  press(KEEPER, 'token-ended');
  assert.ok(await closed('token-ended'), 'the run ends');
  const ended = recordOf('token-ended');
  const token = tokenOf(ended);
  assert.ok(token, 'the run was started with a token');

  const since = client.messages.length;
  const res = await fetch(`http://127.0.0.1:${h.port}/api/permission-request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Rundock-Hook-Token': token },
    body: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'sh late.sh' }, session_id: ended.sessionId, conversation_id: '' }),
  });
  assert.strictEqual(res.status, 401, 'refused as a token Rundock never issued is');
  await h.delay(200);
  assert.deepStrictEqual(client.messages.slice(since).filter((m) => m.type === 'control_request'), [], 'no card');
  assert.deepStrictEqual(recordOf('token-ended'), ended, 'and the record is as it closed');
});

test('a Task subagent\'s call and a nested claude\'s, carrying the run\'s token, are the run\'s cards, whatever session they name', async () => {
  // The measured subagent call: the parent's session, plus agent_id and
  // agent_type. A `claude` started from the run's shell has a session of its
  // own, or the call names none.
  const { agent_id: subagent, agent_type: type } = require('../fixtures/subagent-hook-payload.json').subagent;
  h.writeScenario([{
    match: { agent: KEEPER, promptIncludes: 'work started inside' },
    hooks: [readOutside({ agent_id: subagent, agent_type: type }), readOutside({ session_id: 'nested-claude-session' }), readOutside({ session_id: null })],
    turn: [{ text: 'Did the rest.' }],
  }]);
  await save(KEEPER, 'token-inside', 'work started inside');
  let seen = client.messages.length;
  press(KEEPER, 'token-inside');
  const cards = [];
  for (let i = 0; i < 3; i++) {
    const { msg: card, index } = await client.waitFor((m) => m.type === 'control_request' && m._run, { since: seen, label: `card ${i + 1}` });
    seen = index + 1;
    cards.push(card);
    client.send({ type: 'permission_response', requestId: card.request_id, conversationId: '', allow: false, card: true });
  }
  assert.ok(await closed('token-inside'), 'the run ends');
  const run = recordOf('token-inside');
  for (const card of cards) assert.deepStrictEqual(card._run, { id: run.id, routine: 'token-inside', agent: KEEPER });

  const told = h.readHookAnswers().filter((x) => x.agent === KEEPER && x.sessionId === run.sessionId);
  assert.deepStrictEqual(told.map((x) => [x.subagent, x.sentSession]), [[subagent, run.sessionId], [null, 'nested-claude-session'], [null, null]],
    'the hook really sent a subagent\'s call, another session, and none');
  for (const x of told) assert.strictEqual(x.answer.hookSpecificOutput.permissionDecisionReason, UNATTENDED_DENIED);
});
