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
const { MARKERS } = require('../fixtures/stream-json.js');

const ROUTINE_AGENT = 'keeper';
let client, outside;

before(async () => {
  await h.boot({ agents: { ...standardTeam(), keeper: agentFile({ name: ROUTINE_AGENT, type: 'specialist', order: 5 }) } });
  h.internal.stopScheduler();
  outside = makeTempDir('unattended-outside-');
  fs.writeFileSync(path.join(outside, 'notes.md'), '# notes\n');
  fs.writeFileSync(path.join(outside, 'other.md'), '# other\n');
  client = await h.connect();
});
after(async () => h.shutdown());

const readOutside = (name = 'notes.md') => ({ tool: 'Bash', input: { command: `cat ${path.join(outside, name)}` } });
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
// its closed record. `whileWaiting(i)` runs while card i waits, before it is
// answered, so a test can read the record the run has open.
async function runRoutine(name, prompt, answers, whileWaiting) {
  client.send({ type: 'save_routine', agentId: ROUTINE_AGENT, routine: { name, schedule: 'every day at 07:00', prompt, runOn: 'local' } });
  await client.waitFor((m) => m.type === 'routine_saved' && m.name === name, { label: `${name} saved` });
  const since = client.messages.length;
  client.send({ type: 'run_routine_now', agentId: ROUTINE_AGENT, name, occurrence: 0 });
  let seen = since;
  for (const [i, allow] of answers.entries()) {
    const { msg: card, index } = await client.waitFor((m) => m.type === 'control_request' && m._run && m._run.routine === name, { since: seen, label: `${name} card` });
    seen = index + 1;
    if (whileWaiting) await whileWaiting(i);
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

// ── The run's record says how many of its cards were refused ──
//
// Counted by the server as each card is settled, so the record carries the
// number whatever the agent says or leaves out.

const ROUTER = require('../../lib/http-router.js');
// A pressed run writes no routine state; its outcome is the routine_run event.
function outcomeOf(name) {
  const now = new Date();
  const file = path.join(h.workspaceDir, '.rundock', 'state', `events-${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}.jsonl`);
  if (!fs.existsSync(file)) return null;
  const ev = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .find((e) => e.e === 'routine_run' && e.d && e.d.routine === name);
  return ev ? ev.d.status : null;
}

test('a run whose card was denied records one refusal', async () => {
  h.writeScenario([{ match: { agent: ROUTINE_AGENT, promptIncludes: 'count a denial' }, hooks: [readOutside()], turn: [{ text: 'Did the rest.' }] }]);
  const record = await runRoutine('count-denied', 'count a denial', [false]);
  assert.strictEqual(record.status, 'succeeded');
  assert.strictEqual(record.refusedCards, 1);
});

test('a run whose card nobody answered in time records one refusal', async () => {
  const prev = ROUTER.wireHttpRouterDeps({ getPermissionTimeoutMs: () => 150 });
  try {
    h.writeScenario([{ match: { agent: ROUTINE_AGENT, promptIncludes: 'count a timeout' }, hooks: [readOutside()], turn: [{ text: 'Did the rest.' }] }]);
    const record = await runRoutine('count-timeout', 'count a timeout', [undefined]);
    assert.strictEqual(record.refusedCards, 1);
  } finally { ROUTER.wireHttpRouterDeps({ getPermissionTimeoutMs: prev.getPermissionTimeoutMs }); }
});

test('a run with no refusals has no count in its record', async () => {
  h.writeScenario([{ match: { agent: ROUTINE_AGENT, promptIncludes: 'count an approval' }, hooks: [readOutside()], turn: [{ text: 'All done.' }] }]);
  let open = null;
  const record = await runRoutine('count-none', 'count an approval', [true], () => { open = records().find((r) => r.routine === 'count-none'); });
  assert.strictEqual(open.status, 'running');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(open, 'refusedCards'), false, 'nor while it runs');
  assert.strictEqual(record.status, 'succeeded');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(record, 'refusedCards'), false);
});

// The undo: the run carries on without the refused step and does the rest,
// approved, and the one refusal is still counted once.
test('a run that carries on past a refused step counts that refusal once', async () => {
  h.writeScenario([{ match: { agent: ROUTINE_AGENT, promptIncludes: 'count past a refusal' }, hooks: [readOutside(), readOutside('other.md')], turn: [{ text: 'Did the rest without the notes.' }] }]);
  const open = [];
  const record = await runRoutine('count-carry-on', 'count past a refusal', [false, true], () => { open.push(records().find((r) => r.routine === 'count-carry-on')); });
  // The open record carries the count so far, so a run read mid-way, or left
  // open by a process that died, says what was refused before it stopped.
  assert.deepStrictEqual(open.map((r) => [r.status, r.refusedCards]), [['running', undefined], ['running', 1]]);
  assert.strictEqual(record.status, 'succeeded');
  assert.strictEqual(record.refusedCards, 1);
});

// The retry: refused again, told the same, counted again.
test('a run refused, retried and refused again counts both, each told the same', async () => {
  h.writeScenario([{ match: { agent: ROUTINE_AGENT, promptIncludes: 'count a retry' }, hooks: [readOutside(), readOutside()], turn: [{ text: 'Gave up on the notes.' }] }]);
  const before = answersFrom(ROUTINE_AGENT).length;
  const record = await runRoutine('count-retry', 'count a retry', [false, false]);
  assert.strictEqual(record.refusedCards, 2);
  const [first, again] = answersFrom(ROUTINE_AGENT).slice(before);
  assert.strictEqual(reasonOf(again), reasonOf(first));
  assert.strictEqual(reasonOf(again), refusalNotice('denied', 'Bash', { unattended: true }));
});

// The most common next step: the routine does as it was told and ends on the
// failure line, and its record reads it as failed, with its reason and its count.
test('a run that ends on the failure line it was told is recorded as failed, with its reason and its count', async () => {
  h.writeScenario([{ match: { agent: ROUTINE_AGENT, promptIncludes: 'count a failure' }, hooks: [readOutside()], turn: [{ text: 'I could not read the notes, so the digest is not written.\n\nRUN STATUS: failed: the notes could not be read' }] }]);
  const record = await runRoutine('count-failed', 'count a failure', [false]);
  assert.strictEqual(record.status, 'failed');
  assert.strictEqual(record.error, 'the notes could not be read');
  assert.strictEqual(record.declared, true);
  assert.strictEqual(record.refusedCards, 1);
});

// A subagent the routine starts with its Task tool runs inside the routine's
// own process, and the runtime calls the hook for it with the routine's own
// session id, adding the subagent's id and type (measured, in
// test/fixtures/subagent-hook-payload.json). So its refused card is the run's,
// told the routine's words and counted once on its record.
test('a subagent\'s refused card counts once on the routine\'s run, told the routine\'s words', async () => {
  const { agent_id: subagent, agent_type: type } = require('../fixtures/subagent-hook-payload.json').subagent;
  h.writeScenario([{ match: { agent: ROUTINE_AGENT, promptIncludes: 'count a subagent' }, hooks: [{ ...readOutside(), extra: { agent_id: subagent, agent_type: type } }, readOutside('other.md')], turn: [{ text: 'Did the rest.' }] }]);
  const before = answersFrom(ROUTINE_AGENT).length;
  const record = await runRoutine('count-subagent', 'count a subagent', [false, false]);
  const [bySubagent, byRoutine] = answersFrom(ROUTINE_AGENT).slice(before);
  assert.strictEqual(bySubagent.subagent, subagent, 'the first card was raised as the subagent');
  assert.strictEqual(byRoutine.subagent, null, 'and the second as the routine itself');
  assert.strictEqual(bySubagent.sessionId, byRoutine.sessionId, 'under the one session');
  assert.strictEqual(reasonOf(bySubagent), refusalNotice('denied', 'Bash', { unattended: true }));
  assert.strictEqual(record.refusedCards, 2, 'each counted once, on the run');
});

// Rundock's own delegation is read from a conversation's output: an Agent tool
// call it intercepts, or a handback marker. A routine's output is never read
// (lib/scheduler.js starts it with its output ignored), so a routine that
// names another agent starts nobody, and no card of its run can come from a
// session of another agent's.
test('a routine cannot start a Rundock delegation, whatever its output says', async () => {
  h.clearInvocations();
  h.writeScenario([
    { match: { agent: ROUTINE_AGENT, promptIncludes: 'hand it on' }, turn: [{ text: 'Handing this on.' }, { agentTool: { subagent_type: 'content-lead', prompt: 'routine handoff brief' } }, { text: `Handed on. ${MARKERS.RETURN}` }] },
    { match: { agent: 'content-lead' }, hooks: [readOutside()], turn: [{ text: 'A delegate the routine started.' }] },
  ]);
  const record = await runRoutine('no-delegation', 'hand it on', []);
  assert.strictEqual(record.status, 'succeeded');
  await h.delay(300);
  assert.deepStrictEqual(h.readInvocations().map((i) => i.agent), [ROUTINE_AGENT], 'only the routine\'s own agent was ever started');
  assert.strictEqual(answersFrom('content-lead').filter((a) => a.convo === null).length, 0);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(record, 'refusedCards'), false);
});

// The control failing: a runs folder that cannot be written loses the count,
// never the run's outcome or the server.
test('an unwritable runs folder leaves the run\'s outcome as it was, and the server answering', async () => {
  const aside = `${runsDir()}.aside`;
  fs.renameSync(runsDir(), aside);
  fs.writeFileSync(runsDir(), 'not a directory');
  try {
    h.writeScenario([{ match: { agent: ROUTINE_AGENT, promptIncludes: 'count with no store' }, hooks: [readOutside()], turn: [{ text: 'Did the rest.' }] }]);
    client.send({ type: 'save_routine', agentId: ROUTINE_AGENT, routine: { name: 'count-no-store', schedule: 'every day at 07:00', prompt: 'count with no store', runOn: 'local' } });
    await client.waitFor((m) => m.type === 'routine_saved' && m.name === 'count-no-store', { label: 'saved' });
    const since = client.messages.length;
    client.send({ type: 'run_routine_now', agentId: ROUTINE_AGENT, name: 'count-no-store', occurrence: 0 });
    const { msg: card } = await client.waitFor((m) => m.type === 'control_request' && m._run && m._run.routine === 'count-no-store', { since, label: 'card' });
    client.send({ type: 'permission_response', requestId: card.request_id, conversationId: '', allow: false, card: true });
    assert.ok(await h.waitUntil(() => outcomeOf('count-no-store'), 15000), 'the run reached an outcome');
    assert.strictEqual(outcomeOf('count-no-store'), 'completed', 'the routine completed, so losing the count did not change its outcome');
    const told = answersFrom(ROUTINE_AGENT).at(-1);
    assert.strictEqual(reasonOf(told), refusalNotice('denied', 'Bash', { unattended: true }), 'and the agent was still told');
  } finally {
    fs.rmSync(runsDir(), { force: true });
    fs.renameSync(aside, runsDir());
  }
  h.writeScenario([{ match: { agent: ROUTINE_AGENT, promptIncludes: 'count once restored' }, hooks: [readOutside()], turn: [{ text: 'Did the rest.' }] }]);
  const record = await runRoutine('count-restored', 'count once restored', [false]);
  assert.strictEqual(record.refusedCards, 1, 'and the server went on answering and counting');
});
