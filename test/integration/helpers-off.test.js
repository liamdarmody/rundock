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
// report to Wren. Fern leads on Codex, whose turns can start helpers of their
// own on the app-server.
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
      fern: agentFile({ name: 'fern', displayName: 'Fern', role: 'Lead', order: 4, runtime: 'codex', body: 'You are Fern.' }),
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

// THE STREAM AND THE SPAWNS WITH HELPERS OFF. A helper's lines, the task
// lines, a result and every spawn are handled exactly as before helpers.
const fx = require('../fixtures/stream-json.js');
const doneCount = (convo, since) => client.messages.slice(since).filter((m) => m.type === 'system' && m.subtype === 'done' && m._conversationId === convo).length;
const helpersChanged = (convo) => client.messages.filter((m) => m.type === 'helpers_changed' && m._conversationId === convo);
const wrenReplies = (convo) => (h.internal.loadTranscript(convo) || []).filter((t) => t.agent === 'wren').map((t) => t.text || t.content || '').join('\n');

// By design this passes before helpers existed too. Its sibling in
// helpers-stream.test.js, "with helpers on, a line from a helper never joins
// the lead's reply or its steps", fails without helpers.
test('with helpers off, a line carrying a parent call joins the lead\'s reply and a task_started line reaches the page as it came', async () => {
  const convo = open('off-parent');
  const parent = `toolu_off_parent_${++seq}`;
  h.writeScenario([{ match: { agent: 'wren', promptIncludes: 'off parent line' }, turn: [
    { raw: fx.helperLine(fx.contentBlockStartText(0), parent) },
    { raw: fx.helperLine(fx.textDelta('words a helper wrote', 0), parent) },
    { raw: fx.helperLine(fx.toolUseStart('Read', 1, `toolu_off_read_${seq}`), parent) },
    { raw: fx.taskStarted({ taskId: `task_off_${seq}`, toolUseId: parent, description: 'look around', subagentType: 'Explore' }) },
    { text: 'words the lead wrote' },
  ] }]);
  const since = say(convo, 'off parent line');
  const { msg: result } = await client.waitFor((m) => m.type === 'result' && m._conversationId === convo, { since, label: 'result' });
  await turnDone(convo, since);
  const task = client.messages.slice(since).find((m) => m.type === 'system' && m.subtype === 'task_started' && m._conversationId === convo);
  assert.ok(task, 'the task_started line reached the page');
  assert.strictEqual(task.tool_use_id, parent, 'as it came');
  assert.ok(wrenReplies(convo).includes('words a helper wrote'), 'the helper\'s words joined the lead\'s reply, as before');
  assert.ok(result._toolCalls.some((t) => t.tool === 'Read'), 'the helper\'s tool joined the lead\'s steps, as before');
  assert.deepStrictEqual(helpersChanged(convo), [], 'no helpers_changed was sent');
});

// By design this passes before helpers existed too. Its sibling in
// helpers-stream.test.js, "with helpers on, a helper's result does not end the
// lead's turn", fails without helpers.
test('with helpers off, a result sends done, a helper\'s result included', async () => {
  const convo = open('off-result');
  const parent = `toolu_off_parent_${++seq}`;
  h.writeScenario([{ match: { agent: 'wren', promptIncludes: 'off helper result' }, turn: [
    { raw: fx.helperLine(fx.result({ text: 'a helper finished' }), parent) },
    { text: 'the lead finished' },
  ] }]);
  const since = say(convo, 'off helper result');
  assert.ok(await h.waitUntil(() => doneCount(convo, since) === 2, { timeout: 15000 }), 'each result sent done, as before');
  assert.deepStrictEqual(helpersChanged(convo), [], 'no helpers_changed was sent');
});

// By design this passes before helpers existed too. Its sibling in
// helpers-stream.test.js, "with helpers on, the lead's result while a helper
// runs sends no done and leaves it busy, and the first result after the
// helper ends sends done", fails without helpers.
test('with helpers off, the helpers scenario\'s task lines change nothing: its result sends done and no helpers_changed is sent', async () => {
  const convo = open('off-tasks');
  const calls = [agentCall('Explore'), agentCall('Plan')];
  h.writeScenario([{ match: { agent: 'wren', promptIncludes: 'off task lines' }, helpers: true, running: true, turn: calls.map((c) => ({ agentTool: c.input, id: c.id })) }]);
  const since = say(convo, 'off task lines');
  await turnDone(convo, since);
  const started = client.messages.slice(since).filter((m) => m.type === 'system' && m.subtype === 'task_started' && m._conversationId === convo);
  assert.deepStrictEqual(started.map((m) => m.tool_use_id), calls.map((c) => c.id), 'the stub started both, and each line reached the page');
  assert.deepStrictEqual(helpersChanged(convo), [], 'no helpers_changed was sent');
  if (fs.existsSync(HELPERS)) assert.strictEqual(require(HELPERS).stateOf(convo), undefined, 'no helper state for the conversation');
});

// By design this passes before helpers existed too. Its sibling in
// helpers-stream.test.js, "with helpers on, every conversation spawn carries
// the depth limit and refuses SendMessage", fails without helpers.
test('with helpers off, no spawn sets a helper depth or refuses SendMessage', async () => {
  const convo = open('off-spawn');
  const ash = agentCall('ash');
  const back = `handed back ${++seq}`;
  h.writeScenario([
    { match: { agent: 'wren', promptIncludes: 'off spawn settings' }, turn: [{ agentTool: ash.input, id: ash.id }] },
    { match: { agent: 'ash', promptIncludes: ash.input.prompt }, turn: [{ text: `${back}. ${MARKERS.COMPLETE}` }] },
    { match: { agent: 'wren', promptIncludes: ['[SYSTEM: pipeline-complete]', back] }, turn: [{ text: '<silent>' }] },
  ]);
  say(convo, 'off spawn settings');
  assert.ok(await h.waitUntil(() => invocations('wren', convo).length >= 2 && invocations('ash', convo).length === 1, { timeout: 20000 }), 'Wren, Ash and Wren again were spawned');
  const spawned = h.readInvocations().filter((i) => i.env.RUNDOCK_CONVO_ID === convo);
  for (const inv of spawned) {
    assert.strictEqual(inv.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH, null, `${inv.agent}: no depth setting`);
    const at = inv.argv.indexOf('--disallowed-tools');
    const list = at >= 0 ? inv.argv[at + 1] : '';
    assert.ok(!/\bSendMessage\b/.test(list), `${inv.agent}: SendMessage is not refused: ${list}`);
  }
});

// EACH READER OF THE SWITCH IN THE STREAM, THE HOLDS AND THE SPAWNS reads it
// when it is used, never a copy taken at load: the server here loaded with
// helpers off, and turned on afterwards, each reader acts. One assertion per
// reader. Fails without helpers.
const switchFile = (id) => path.join(h.workspaceDir, `switch-${id}`);
test('the switch is read when it is used by the stream, the holds and the spawns: turned on after boot, each acts', async () => {
  const m = helpers();
  for (const name of ['runningCount', 'helperRows']) assert.strictEqual(typeof m[name], 'function', `helpers.${name} is exported`);
  assert.strictEqual(m.HELPERS_ENABLED, false, 'the server loaded with helpers off');
  const six = open('switch-six');
  const one = open('switch-one');
  const parent = `toolu_off_parent_${++seq}`;
  const calls = Array.from({ length: 6 }, () => agentCall('Explore'));
  const lone = agentCall('Explore');
  h.writeScenario([
    { match: { agent: 'wren', promptIncludes: 'switch readers six' }, helpers: true, running: true, finishOn: { [calls[0].id]: switchFile(calls[0].id) }, turn: [
      { raw: fx.helperLine(fx.contentBlockStartText(0), parent) },
      { raw: fx.helperLine(fx.textDelta('words a helper wrote', 0), parent) },
      { text: 'Starting six.' },
      ...calls.map((c) => ({ agentTool: c.input, id: c.id })),
    ] },
    { match: { agent: 'wren', promptIncludes: 'switch readers one' }, helpers: true, running: true, turn: [{ text: 'Starting one.' }, { agentTool: lone.input, id: lone.id }],
      then: [{ untilFile: switchFile(lone.id), lines: [fx.taskNotification({ taskId: `task_${lone.id}`, toolUseId: lone.id })], turn: [{ text: 'It is back.' }] }] },
  ]);
  try {
    m.HELPERS_ENABLED = true;
    scaffold();

    // A lead with six helper calls, while its helpers run.
    const answered = () => agentHookAnswers(calls.map((c) => c.id)).map((a) => a.answer.hookSpecificOutput.permissionDecision);
    let since = say(six, 'switch readers six');
    assert.ok(await h.waitUntil(() => answered().length >= 5, { timeout: 20000 }), 'five calls were answered');
    await h.delay(300);
    assert.deepStrictEqual(answered(), Array(5).fill('allow'), 'the hold of a sixth call: five start and the sixth waits');
    const rows = helpersChanged(six).pop();
    assert.deepStrictEqual(rows && rows.helpers.map((r) => r.state).sort(), [...Array(5).fill('running'), 'waiting'], 'helpers_changed: the page is sent the rows');
    const other = await h.connect();
    try {
      const { msg } = await other.waitFor((x) => x.type === 'active_processes', { label: 'active_processes' });
      const row = msg.processes.find((p) => p.conversationId === six);
      assert.strictEqual(row && Array.isArray(row.helpers) ? row.helpers.length : null, 6, 'active_processes: the lead\'s row lists its helpers');
    } finally {
      other.close();
    }
    const [spawn] = invocations('wren', six);
    assert.strictEqual(spawn.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH, '1', 'the spawn env: the depth limit');
    const at = spawn.argv.indexOf('--disallowed-tools');
    const refusedTools = at >= 0 ? spawn.argv[at + 1] : '';
    assert.ok(refusedTools.split(',').includes('SendMessage'), `the spawn's --disallowed-tools: SendMessage is refused: ${refusedTools}`);
    const lead = h.internal.chatProcesses.get(six);
    client.send({ type: 'end_delegation', conversationId: six });
    await h.delay(800);
    assert.ok(h.internal.chatProcesses.get(six) === lead && !lead.exited && !lead.scopeReturn && h.pidAlive(lead.process.pid),
      'a return the page asks for waits while the helpers run');
    fs.writeFileSync(switchFile(calls[0].id), '');
    assert.ok(await h.waitUntil(() => answered().length === 6, { timeout: 20000 }), 'a task line read from the stream: a helper\'s end starts the held call');
    await client.waitFor((x) => x.type === 'result' && x._conversationId === six, { since, label: 'the result' });
    await h.delay(300);
    assert.strictEqual(doneCount(six, since), 0, 'the lead\'s result while its helpers run sends no done');
    const reply = wrenReplies(six);
    assert.ok(reply.includes('Starting six.') && !reply.includes('words a helper wrote'), `the parent filter: a helper's words are not the lead's: ${reply}`);
    client.send({ type: 'cancel', conversationId: six });
    assert.ok(await h.waitUntil(() => m.runningCount(six) === 0 && m.helperRows(six).length === 0, { timeout: 10000 }),
      'the lead\'s close ends its helpers');

    // A lead whose one helper reports back.
    since = say(one, 'switch readers one');
    await client.waitFor((x) => x.type === 'result' && x._conversationId === one, { since, label: 'the first result' });
    fs.writeFileSync(switchFile(lone.id), '');
    assert.ok(await h.waitUntil(() => doneCount(one, since) >= 1, { timeout: 20000 }), 'the request ended once its helper reported back');
    assert.deepStrictEqual(m.helperRows(one), [], 'the request\'s end clears its helpers');
  } finally {
    m.HELPERS_ENABLED = false;
    scaffold();
  }
});

// A CODEX LEAD'S HELPERS WITH HELPERS OFF. Fern's turn on the app-server
// starts helpers of its own; with the switch off, nothing of theirs reaches
// Fern's turn, the page or the conversation.
const { scanMarkers } = require('../../public/markers.js');
const holds = new Set();
function hold(tag) {
  const file = path.join(h.workspaceDir, `hold-off-${tag}-${process.pid}`);
  holds.add(file);
  return file;
}
afterEach(() => {
  for (const file of holds) if (!fs.existsSync(file)) fs.writeFileSync(file, 'go');
  holds.clear();
});
const sayFern = (convo, words) => {
  const since = client.messages.length;
  client.send({ type: 'chat', conversationId: convo, agent: 'fern', content: words });
  return since;
};
const appServerCalls = (method) => h.readInvocations().filter((i) => i.mode === 'app-server' && i.method === method);
const fernResult = (convo, since) => client.waitFor((m) => m.type === 'result' && m._conversationId === convo, { since, timeout: 20000, label: 'Fern\'s result' });

// By design this passes before helpers existed too. Its sibling in
// codex-helpers.test.js, "a helper Fern starts is a row on Fern's list,
// named, counted while it runs and not once it completes", fails without
// helpers.
test('with helpers off, Fern\'s helpers leave her reply, her turn and the conversation as they were', async () => {
  const convo = open('off-codex');
  const gate = hold('codex');
  h.clearInvocations();
  h.writeCodexScenario([{
    match: { promptIncludes: 'off codex helpers' }, text: 'FERN-WORDS', untilFile: gate,
    helpers: [{ nickname: 'rates', text: 'HELPER-WORDS', items: [{ type: 'commandExecution', command: 'ls' }] }, { nickname: 'deck', text: 'HELPER-WORDS', status: 'failed' }],
  }]);
  const since = sayFern(convo, 'off codex helpers');
  assert.ok(await h.waitUntil(() => appServerCalls('turn/start').length === 1, { timeout: 15000 }), 'Fern\'s turn started');
  await h.delay(400);
  assert.strictEqual(doneCount(convo, since), 0, 'the helpers ending did not end Fern\'s turn');
  fs.writeFileSync(gate, 'go');
  const { msg: result } = await fernResult(convo, since);
  await turnDone(convo, since);
  assert.strictEqual(result.result, 'FERN-WORDS', 'Fern\'s reply is her own words');
  assert.ok(!wrenReplies(convo).includes('HELPER-WORDS'), 'no helper\'s words were kept');
  assert.ok(!(h.internal.loadTranscript(convo) || []).some((t) => String(t.text || t.content || '').includes('HELPER-WORDS')), 'nor anywhere in the transcript');
  assert.strictEqual(doneCount(convo, since), 1, 'one done, Fern\'s');
  assert.deepStrictEqual(helpersChanged(convo), [], 'no helpers_changed was sent');
  assert.strictEqual(helpers().runningCount(convo), 0, 'no helper is counted');
  assert.strictEqual(helpers().stateOf(convo), undefined, 'no helper state for the conversation');
  assert.deepStrictEqual([...appServerCalls('turn/interrupt'), ...appServerCalls('turn/steer')], [], 'no thread was interrupted or steered');
  const { readConversations } = require('../../lib/store/persistence.js');
  const kept = readConversations().find((c) => c && c.id === convo) || {};
  assert.ok(!('helpersNoticed' in kept), 'Fern is not kept as noticed');
});

// By design this passes before helpers existed too. Its sibling in
// codex-helpers.test.js, "a helper Fern starts is a row on Fern's list,
// named, counted while it runs and not once it completes", fails without
// helpers.
test('with helpers off, the page gets the same messages from a Fern turn with helpers as from one without', async () => {
  const shape = (convo, since) => client.messages.slice(since).filter((m) => m._conversationId === convo).map((m) => {
    const keep = { type: m.type, subtype: m.subtype || null, agent: m._agent || null };
    if (m.type === 'result') Object.assign(keep, { result: m.result, tools: (m._toolCalls || []).length });
    if (typeof m.text === 'string') keep.text = m.text;
    return keep;
  });
  const seen = [];
  for (const withHelpers of [false, true]) {
    const convo = open(withHelpers ? 'off-page-h' : 'off-page');
    h.writeCodexScenario([{
      match: { promptIncludes: 'off page shape' }, deltas: ['Same ', 'reply.'], text: 'Same reply.', awaitHelpers: withHelpers,
      helpers: withHelpers ? [{ nickname: 'rates', items: [{ type: 'fileChange', paths: ['notes.md'] }] }, { nickname: 'tidy', source: 'review' }] : [],
    }]);
    const since = sayFern(convo, 'off page shape');
    await turnDone(convo, since);
    seen.push(shape(convo, since));
  }
  assert.ok(seen[0].some((m) => m.type === 'result'), 'the turn reached the page');
  assert.deepStrictEqual(seen[1], seen[0], 'the same messages, helper events or not');
});

// WHAT THE WINDOW DOES WITH A FERN REPLY: it scans the reply, sends the first
// DELEGATE marker back as a delegate message, and the server answers. A Codex
// turn has already ended by then, so the answer is whatever the server gives
// a conversation with no live turn; these tests pin that it is the same with
// helper events as without them.
async function delegateOutcome(convo, words) {
  const since = sayFern(convo, words);
  const { msg: result } = await fernResult(convo, since);
  await turnDone(convo, since);
  const { delegation } = scanMarkers(result.result);
  const after = client.messages.length;
  client.send({ type: 'delegate', conversationId: convo, targetAgent: delegation.targetAgent, context: delegation.context });
  await h.waitUntil(() => invocations('ash', convo).length > 0
    || client.messages.slice(after).some((m) => m._conversationId === convo && m.subtype === 'delegation_error'), { timeout: 15000 });
  await h.delay(300);
  return {
    delegation,
    ash: invocations('ash', convo).length,
    rowan: invocations('example-research-lead', convo).length,
    page: client.messages.slice(after).filter((m) => m._conversationId === convo)
      .map((m) => [m.type, m.subtype || null, typeof m.content === 'string' ? m.content : null]),
  };
}
const DELEGATE_CASES = [
  { tag: 'one', brief: 'DELEGATE-ONE brief', reply: 'Bringing in Ash.\n<!-- RUNDOCK:DELEGATE agent=ash -->\nDELEGATE-ONE brief\n<!-- /RUNDOCK:DELEGATE -->' },
  { tag: 'two', brief: 'DELEGATE-TWO brief', reply: 'Bringing in two.\n<!-- RUNDOCK:DELEGATE agent=ash -->\nDELEGATE-TWO brief\n<!-- /RUNDOCK:DELEGATE -->\n<!-- RUNDOCK:DELEGATE agent=example-research-lead -->\nDELEGATE-TWO other\n<!-- /RUNDOCK:DELEGATE -->' },
];

// By design this passes before helpers existed too. Its sibling in
// codex-helpers.test.js, "a helper Fern starts is a row on Fern's list,
// named, counted while it runs and not once it completes", fails without
// helpers.
test('with helpers off, Fern\'s DELEGATE markers name the first agent and get the same answer as a reply with no helpers', async () => {
  for (const c of DELEGATE_CASES) {
    const seen = [];
    for (const withHelpers of [false, true]) {
      const convo = open(`off-del-${c.tag}${withHelpers ? '-h' : ''}`);
      h.writeCodexScenario([{
        match: { promptIncludes: `off delegate ${c.tag}` }, text: c.reply, awaitHelpers: withHelpers,
        helpers: withHelpers ? [{ nickname: 'ash' }, { nickname: 'rates' }] : [],
      }]);
      h.writeScenario([{ match: { agent: 'ash', promptIncludes: c.brief }, turn: [{ text: 'Ash took it.' }] }]);
      seen.push(await delegateOutcome(convo, `off delegate ${c.tag}`));
      assert.deepStrictEqual(helpersChanged(convo), [], `${c.tag}: no helpers_changed was sent`);
    }
    assert.deepStrictEqual(seen[0].delegation, { targetAgent: 'ash', context: c.brief }, `${c.tag}: the first marker names Ash`);
    assert.strictEqual(seen[0].rowan, 0, `${c.tag}: Rowan did not start`);
    assert.deepStrictEqual(seen[1], seen[0], `${c.tag}: the same answer, helper events or not`);
  }
});

// By design this passes before helpers existed too. Its sibling in
// codex-helpers.test.js, "with helpers on, no feature flag or agent setting
// reaches the app-server", is the same check with the switch on.
test('with helpers off, no feature flag or agent setting reaches the app-server', async () => {
  const convo = open('off-flags');
  h.clearInvocations();
  h.writeCodexScenario([{ match: { promptIncludes: 'off flags' }, text: 'Plain.', awaitHelpers: true, helpers: [{ nickname: 'rates' }] }]);
  require('../../lib/runtime/codex-glue.js').shutdownCodexAppServer();
  const since = sayFern(convo, 'off flags');
  await turnDone(convo, since);
  const spawns = h.readInvocations().filter((i) => i.mode === 'app-server' && i.event === 'spawn');
  assert.ok(spawns.length >= 1, 'the app-server was started in this test');
  for (const s of spawns) assert.doesNotMatch(JSON.stringify(s.argv), /features|multi_agent|agents/, 'nothing in the argv');
  const starts = [...appServerCalls('thread/start'), ...appServerCalls('thread/resume')];
  assert.ok(starts.length >= 1);
  for (const s of starts) assert.doesNotMatch(JSON.stringify(s.params), /features|multi_agent|"agents"/, 'nothing in the thread params');
});

// By design this passes before helpers existed too. Its sibling in
// codex-helpers.test.js, "a helper's approval raises a card on Fern's turn
// naming the helper, and Allow answers accept on the helper's request",
// fails without helpers.
test('with helpers off, a helper\'s command approval is declined at once with no card, and Fern\'s turn carries on', async () => {
  const convo = open('off-approval');
  h.clearInvocations();
  h.writeCodexScenario([{
    match: { promptIncludes: 'off approval' }, text: 'FERN-AFTER', awaitHelpers: true,
    helpers: [{ nickname: 'rates', approval: { command: 'rm -rf build' } }],
  }]);
  const since = sayFern(convo, 'off approval');
  const { msg: result } = await fernResult(convo, since);
  await turnDone(convo, since);
  const decided = h.readInvocations().filter((i) => i.approvalDecision != null);
  assert.deepStrictEqual(decided.map((d) => d.approvalDecision), ['decline'], 'the helper\'s request was declined');
  assert.notStrictEqual(decided[0].threadId, appServerCalls('turn/start')[0].params.threadId, 'on the helper\'s thread, not Fern\'s');
  assert.deepStrictEqual(client.messages.slice(since).filter((m) => m.type === 'control_request' && m._conversationId === convo), [], 'no card');
  assert.strictEqual(result.result, 'FERN-AFTER', 'Fern\'s turn carried on to her reply');
  assert.deepStrictEqual(appServerCalls('turn/steer'), [], 'no line was steered');
  assert.deepStrictEqual(helpersChanged(convo), [], 'no helpers_changed was sent');
});
