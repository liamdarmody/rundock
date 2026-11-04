'use strict';
// Integration: a refused card is worded by who can be asked, end to end.
//
// Every spawn path is driven for real: the scheduler's routine run, a
// conversation's agent, and an agent delegated to inside a conversation. Each
// runs Rundock's real permission hook, as its own process, with the
// environment Rundock started it with (the stub's `hooks` step), against the
// real server, which raises the real card that the test then answers.
//
// A routine has nobody to ask, so it is told to carry on without the refused
// step or to end on a failure line its record reads. A conversation, a
// delegated agent's included, is told to stop and ask, as it always was.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const h = require('../helpers/harness.js');
const { agentFile, standardTeam, makeTempDir } = require('../helpers/workspace.js');
const { refusalNotice } = require('../../scripts/refusal-notice.js');

const ROUTINE_AGENT = 'keeper';
let client, outside;

before(async () => {
  await h.boot({ agents: { ...standardTeam(), keeper: agentFile({ name: ROUTINE_AGENT, type: 'specialist', order: 5 }) } });
  h.internal.stopScheduler();
  outside = makeTempDir('unattended-outside-');
  fs.writeFileSync(path.join(outside, 'notes.md'), '# notes\n');
  client = await h.connect();
});
after(async () => h.shutdown());

const readOutside = () => ({ tool: 'Bash', input: { command: `cat ${path.join(outside, 'notes.md')}` } });
const SANDBOX_BLOCK = {
  event: 'PostToolUseFailure', tool: 'Bash', input: { command: 'cp -R ~/Downloads/x ./x' },
  error: 'Exit code 1\ncp: /Users/someone/Downloads/x: Operation not permitted\n<sandbox_violations>\ndeny file-write-create /Users/someone/Downloads/x\n</sandbox_violations>',
};
const answersFrom = (agent) => h.readHookAnswers().filter((a) => a.agent === agent);
const reasonOf = (a) => a.answer.hookSpecificOutput.permissionDecisionReason;

const runsDir = () => path.join(h.workspaceDir, '.rundock', 'runs');
const records = () => (fs.existsSync(runsDir()) ? fs.readdirSync(runsDir()) : [])
  .filter((n) => n.endsWith('.json'))
  .map((name) => JSON.parse(fs.readFileSync(path.join(runsDir(), name), 'utf-8')));

// Start a routine run, answer every card it raises with `answers` in turn
// (true allows, false denies, undefined leaves it to time out), and return
// its closed record.
async function runRoutine(name, prompt, answers) {
  client.send({ type: 'save_routine', agentId: ROUTINE_AGENT, routine: { name, schedule: 'every day at 07:00', prompt, runOn: 'local' } });
  await client.waitFor((m) => m.type === 'routine_saved' && m.name === name, { label: `${name} saved` });
  const since = client.messages.length;
  client.send({ type: 'run_routine_now', agentId: ROUTINE_AGENT, name, occurrence: 0 });
  let seen = since;
  for (const allow of answers) {
    const { msg: card, index } = await client.waitFor((m) => m.type === 'control_request' && m._run && m._run.routine === name, { since: seen, label: `${name} card` });
    seen = index + 1;
    if (allow !== undefined) client.send({ type: 'permission_response', requestId: card.request_id, conversationId: '', allow, card: true });
  }
  assert.ok(await h.waitUntil(() => records().some((r) => r.routine === name && r.status !== 'running'), 15000), `${name} closed`);
  return records().find((r) => r.routine === name);
}

test('a routine\'s refused card and sandbox block tell it to carry on or say it failed', async () => {
  h.writeScenario([{ match: { agent: ROUTINE_AGENT, promptIncludes: 'wording check' }, hooks: [readOutside(), SANDBOX_BLOCK], turn: [{ text: 'Did the rest.' }] }]);
  await runRoutine('wording', 'routine wording check', [false]);
  const [card, sandbox] = answersFrom(ROUTINE_AGENT);
  assert.strictEqual(card.convo, null, 'the scheduler started it with no conversation');
  assert.strictEqual(card.answer.hookSpecificOutput.permissionDecision, 'deny');
  assert.strictEqual(reasonOf(card), refusalNotice('denied', 'Bash', { unattended: true }));
  assert.match(reasonOf(card), /carry on with the rest of the job without that step\..*RUN STATUS: failed: <one-line reason>$/);
  assert.doesNotMatch(reasonOf(card), /stop and ask/i);
  assert.deepStrictEqual(sandbox.answer, { hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: refusalNotice('sandbox', 'Bash', { unattended: true }) } });
});

test('a conversation\'s agent is told to stop and ask, as before', async () => {
  const convoId = h.freshConvoId('ur-chat');
  h.writeScenario([{ match: { agent: 'chief-of-staff', promptIncludes: 'chat wording check' }, hooks: [readOutside(), SANDBOX_BLOCK], turn: [{ text: 'Asked.' }] }]);
  const since = client.messages.length;
  client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'chat wording check' });
  const { msg: card } = await client.waitFor((m) => m.type === 'control_request' && m._conversationId === convoId, { since, label: 'conversation card' });
  assert.strictEqual(card._run, undefined);
  client.send({ type: 'permission_response', requestId: card.request_id, conversationId: convoId, allow: false, card: true });
  await client.waitForEvent('system', 'done', convoId);
  const [denied, sandbox] = answersFrom('chief-of-staff').filter((a) => a.convo === convoId);
  assert.strictEqual(reasonOf(denied), 'The person refused this command. The refusal is deliberate: do not retry it or try another way. Stop and ask the person what to do.');
  assert.strictEqual(sandbox.answer.hookSpecificOutput.additionalContext, 'The workspace\'s sandbox settings blocked this command. The refusal is deliberate: do not retry it or try another way. Stop and ask the person what to do.');
  h.reapConvo(convoId);
});

test('an agent delegated to inside a conversation is told to stop and ask, as before', async () => {
  const convoId = h.freshConvoId('ur-del');
  h.writeScenario([{ match: { agent: 'chief-of-staff', promptIncludes: 'delegation setup' }, turn: [{ text: 'Ready.' }] }]);
  client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'delegation setup' });
  await client.waitForEvent('system', 'done', convoId);
  h.writeScenario([{ match: { agent: 'content-lead', promptIncludes: 'delegated wording check' }, hooks: [readOutside()], turn: [{ text: 'Asked.' }] }]);
  const since = client.messages.length;
  client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'content-lead', context: 'delegated wording check' });
  const { msg: card } = await client.waitFor((m) => m.type === 'control_request' && m._conversationId === convoId, { since, label: 'delegated card' });
  client.send({ type: 'permission_response', requestId: card.request_id, conversationId: convoId, allow: false, card: true });
  assert.ok(await h.waitUntil(() => answersFrom('content-lead').some((a) => a.convo === convoId)), 'the delegate was answered');
  const told = answersFrom('content-lead').find((a) => a.convo === convoId);
  assert.strictEqual(reasonOf(told), 'The person refused this command. The refusal is deliberate: do not retry it or try another way. Stop and ask the person what to do.');
  h.reapConvo(convoId);
});
