'use strict';
// HELPERS OFF: EVERYTHING AS IT WAS.
//
// Helpers sit behind one module attribute that ships off. While it is off, a
// lead's Agent calls never reach Rundock's permission hook, one teammate call
// hands over, two hand over to the first and name the second back as not run,
// and the fields a helper's hook request carries change nothing. Most tests
// here pass before helpers existed too, by design: each says so, and names
// the test in this file that does not.
//
// The team: Wren leads; Ash and Rowan (agent name example-research-lead)
// report to Wren.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const h = require('../helpers/harness.js');
const { agentFile } = require('../helpers/workspace.js');
const { MARKERS } = require('../fixtures/stream-json.js');
const { ask, bash } = require('../helpers/permission-route.js');

const HELPERS = path.join(__dirname, '..', '..', 'lib', 'delegation', 'helpers.js');
function helpers() {
  assert.ok(fs.existsSync(HELPERS), 'lib/delegation/helpers.js exists');
  return require(HELPERS);
}
const scaffold = () => require('../../lib/workspace/scaffold.js').scaffoldWorkspace(h.workspaceDir);

let client;
before(async () => {
  await h.boot({
    agents: {
      wren: agentFile({ name: 'wren', displayName: 'Wren', role: 'Lead', order: 1 }),
      ash: agentFile({ name: 'ash', displayName: 'Ash', order: 2, reportsTo: 'wren' }),
      'example-research-lead': agentFile({ name: 'example-research-lead', displayName: 'Rowan', order: 3, reportsTo: 'wren' }),
    },
  });
  h.internal.stopScheduler();
  client = await h.connect();
});
const opened = new Set();
afterEach(() => {
  for (const convo of opened) h.reapConvo(convo);
  opened.clear();
});
after(async () => {
  if (fs.existsSync(HELPERS)) require(HELPERS).HELPERS_ENABLED = false;
  for (const m of client.messages.filter((x) => x.type === 'control_request')) {
    client.send({ type: 'permission_response', requestId: m.request_id, conversationId: m._conversationId || '', allow: false, card: true });
  }
  await h.delay(200);
  for (const { pid } of h.readInvocations()) {
    try { process.kill(pid, 'SIGKILL'); } catch (e) { /* already ended */ }
  }
  await h.shutdown();
});

function open(prefix) {
  const convo = h.freshConvoId(prefix);
  opened.add(convo);
  return convo;
}
let seq = 0;
function agentCall(type) {
  const n = ++seq;
  return { id: `toolu_off_${String(type).replace(/[^a-z]/gi, '')}_${n}`, input: { subagent_type: type, description: `${type} part ${n}`, prompt: `Brief number ${n} for ${type}.` } };
}
const say = (convo, words) => {
  const since = client.messages.length;
  client.send({ type: 'chat', conversationId: convo, agent: 'wren', content: words });
  return since;
};
const turnDone = (convo, since) => client.waitForEvent('system', 'done', convo, { since, timeout: 20000 });
const invocations = (agent, convo) => h.readInvocations().filter((i) => i.agent === agent && i.env.RUNDOCK_CONVO_ID === convo);
const agentHookAnswers = (ids) => h.readHookAnswers().filter((a) => ids.includes(a.toolUseId));

// The PreToolUse entries the workspace's settings give the runtime, and the
// ones of them that would send an Agent call to a hook.
function preToolUse() {
  const file = path.join(h.workspaceDir, '.claude', 'settings.local.json');
  return JSON.parse(fs.readFileSync(file, 'utf8')).hooks.PreToolUse;
}
const agentEntries = () => preToolUse().filter((e) => {
  try { return new RegExp(`^(?:${e.matcher})$`).test('Agent'); } catch (err) { return e.matcher === 'Agent'; }
});

// By design this passes before helpers existed too. Its sibling, "the switch
// is read when it is used ...", fails without helpers.
test('with helpers off, the workspace settings send no Agent call to the hook', () => {
  assert.ok(preToolUse().length > 0, 'the settings have their PreToolUse entries');
  assert.deepStrictEqual(agentEntries(), [], 'no entry matches Agent');
});

// By design this passes before helpers existed too. Its sibling, "the switch
// is read when it is used ...", fails without helpers.
test('with helpers off, one teammate call hands over to that teammate', async () => {
  const convo = open('off-one');
  const ash = agentCall('ash');
  h.writeScenario([
    { match: { agent: 'wren', promptIncludes: 'off one teammate' }, turn: [{ agentTool: ash.input, id: ash.id }] },
    { match: { agent: 'ash', promptIncludes: ash.input.prompt }, turn: [{ text: `Done. ${MARKERS.COMPLETE}` }] },
  ]);
  say(convo, 'off one teammate');
  assert.ok(await h.waitUntil(() => invocations('ash', convo).length === 1, { timeout: 15000 }), 'Ash took over');
  assert.deepStrictEqual(agentHookAnswers([ash.id]), [], 'the call never reached the hook');
});

// By design this passes before helpers existed too. Its sibling, "the switch
// is read when it is used ...", fails without helpers.
test('with helpers off, two teammate calls hand over to the first and name the second back as not run', async () => {
  const convo = open('off-two');
  const ash = agentCall('ash');
  const rowan = agentCall('example-research-lead');
  const back = `handed back ${++seq}`;
  h.writeScenario([
    { match: { agent: 'wren', promptIncludes: 'off two teammates' }, turn: [{ agentTool: ash.input, id: ash.id }, { agentTool: rowan.input, id: rowan.id }] },
    { match: { agent: 'ash', promptIncludes: ash.input.prompt }, turn: [{ text: `${back}. ${MARKERS.COMPLETE}` }] },
    { match: { agent: 'wren', promptIncludes: ['[SYSTEM: pipeline-complete]', back] }, turn: [{ text: '<silent>' }] },
  ]);
  const prompts = h.readPrompts().length;
  say(convo, 'off two teammates');
  assert.ok(await h.waitUntil(() => h.readPrompts().slice(prompts).some((p) => p.agent === 'wren' && p.prompt.includes(back)), { timeout: 20000 }), 'Wren was handed back to');
  assert.strictEqual(invocations('ash', convo).length, 1, 'Ash took over');
  assert.strictEqual(invocations('example-research-lead', convo).length, 0, 'Rowan did not start');
  const note = h.readPrompts().slice(prompts).find((p) => p.agent === 'wren' && p.prompt.includes(back)).prompt;
  assert.ok(/also invoked the Agent tool for: example-research-lead\. .*NOT run/.test(note), `the second call is named back as not run: ${note}`);
  assert.deepStrictEqual(agentHookAnswers([ash.id, rowan.id]), [], 'neither call reached the hook');
});

// By design this passes before helpers existed too. Its sibling, "the switch
// is read when it is used ...", fails without helpers.
test('with helpers off, a request carrying tool_use_id, agent_id and agent_type is answered and carded exactly as one without them', async () => {
  const convo = open('off-fields');
  const extras = { tool_use_id: 'toolu_off_fields', agent_id: 'agent-c3', agent_type: 'Ash' };
  const cases = [
    { tool_name: 'Agent', tool_input: agentCall('ash').input, conversation_id: convo },
    bash(`node tools/build.js --step ${++seq}`, convo),
  ];
  for (const plain of cases) {
    const seen = [];
    for (const body of [plain, { ...plain, ...extras }]) {
      const since = client.messages.length;
      const asked = ask(body, { headers: h.hookHeaders(convo, 'wren') });
      const { msg: card } = await client.waitFor((m) => m.type === 'control_request' && m._conversationId === convo, { since, label: `${body.tool_name} card` });
      client.send({ type: 'permission_response', requestId: card.request_id, conversationId: convo, allow: false, card: true });
      const reply = await asked.reply;
      const { request_id: id, ...shown } = card;
      seen.push({ shown, reply: reply.body });
    }
    assert.ok(!('_helper' in seen[1].shown), 'no _helper on the card');
    assert.deepStrictEqual(seen[1], seen[0], `${plain.tool_name}: the same card and the same answer`);
  }
});

// By design this passes before helpers existed too. Its sibling, "the switch
// is read when it is used ...", fails without helpers.
test('with helpers off, the helpers scenario leaves no helper state and asks the hook nothing', async () => {
  const convo = open('off-state');
  const calls = [agentCall('Explore'), agentCall('Plan')];
  h.writeScenario([{ match: { agent: 'wren', promptIncludes: 'off built-ins' }, helpers: true, turn: calls.map((c) => ({ agentTool: c.input, id: c.id })) }]);
  const since = say(convo, 'off built-ins');
  await turnDone(convo, since);
  assert.deepStrictEqual(agentHookAnswers(calls.map((c) => c.id)), [], 'no Agent call reached the hook');
  if (fs.existsSync(HELPERS)) assert.strictEqual(require(HELPERS).stateOf(convo), undefined, 'no helper state for the conversation');
});

test('the switch is read when it is used: turned on after boot, the settings send Agent calls to the hook and a batch is placed; turned off, neither', async () => {
  const m = helpers();
  const onConvo = open('switch-on');
  const offConvo = open('switch-off');
  const onCalls = [agentCall('Explore'), agentCall('Plan')];
  const offCalls = [agentCall('Explore'), agentCall('Plan')];
  h.writeScenario([
    { match: { agent: 'wren', promptIncludes: 'switch on batch' }, helpers: true, turn: onCalls.map((c) => ({ agentTool: c.input, id: c.id })) },
    { match: { agent: 'wren', promptIncludes: 'switch off batch' }, helpers: true, turn: offCalls.map((c) => ({ agentTool: c.input, id: c.id })) },
  ]);
  try {
    m.HELPERS_ENABLED = true;
    scaffold();
    assert.deepStrictEqual(agentEntries().map((e) => e.matcher), ['Agent'], 'the Agent entry is written');
    const since = say(onConvo, 'switch on batch');
    await turnDone(onConvo, since);
    assert.deepStrictEqual(agentHookAnswers(onCalls.map((c) => c.id)).map((a) => a.answer.hookSpecificOutput.permissionDecision), ['allow', 'allow'], 'the calls reached the hook');
    assert.strictEqual(m.stateOf(onConvo).latest.kind, 'helpers', 'the batch was placed');
  } finally {
    m.HELPERS_ENABLED = false;
    scaffold();
  }
  assert.deepStrictEqual(agentEntries(), [], 'the Agent entry is gone');
  const since = say(offConvo, 'switch off batch');
  await turnDone(offConvo, since);
  assert.deepStrictEqual(agentHookAnswers(offCalls.map((c) => c.id)), [], 'no call reached the hook');
  assert.strictEqual(m.stateOf(offConvo), undefined, 'nothing was placed');
});
