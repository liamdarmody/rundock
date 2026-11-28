'use strict';
// HELPERS IN THE LEAD'S STREAM: WHAT RUNS, AND WHAT WAITS FOR IT.
//
// With helpers on, the server reads the lead's own stream for its helpers.
// A line a helper wrote carries the id of the call that started it and never
// joins the lead's reply, steps or turn. Claude Code's task_* lines say when
// each helper starts, what it is doing and how it ended, and every change
// reaches the page as helpers_changed.
//
// The switch is a module attribute, turned on here after boot, and the
// workspace's hook settings are written again so every agent started
// afterwards puts its Agent calls to the hook. The stub's `helpers` rule puts
// a message's Agent calls to Rundock's real hook once the message has ended,
// as the runtime does, and starts each call the hook allows with task_started.
//
// The team runs three handoffs deep: Sky orchestrates, Wren reports to Sky,
// Ash to Wren, and Rowan (agent name example-research-lead) to Ash, with four
// reviewers (Birch, Elm, Fern and Moss) reporting to Rowan.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const h = require('../helpers/harness.js');
const { agentFile } = require('../helpers/workspace.js');
const fx = require('../fixtures/stream-json.js');
const { approvalNotice } = require('../../scripts/refusal-notice.js');
const { ask } = require('../helpers/permission-route.js');

const HELPERS = path.join(__dirname, '..', '..', 'lib', 'delegation', 'helpers.js');
// Asserted before the module is used, so a missing module fails a test on an
// assertion instead of throwing from require.
function helpers() {
  assert.ok(fs.existsSync(HELPERS), 'lib/delegation/helpers.js exists');
  return require(HELPERS);
}
// Each name a test uses is asserted first, so a module without it fails on
// that assertion, never on a call that throws.
function names(...wanted) {
  const m = helpers();
  for (const name of wanted) assert.strictEqual(typeof m[name], 'function', `helpers.${name} is exported`);
  return m;
}

let client;
// The idle probe server.js registers with the auth module as it loads, kept
// here as it is handed over: the auth module holds it out of reach.
let idleProbe = null;
before(async () => {
  const auth = require('../../lib/auth/index.js');
  const setIdleProbe = auth.setIdleProbe;
  auth.setIdleProbe = (fn) => { idleProbe = fn; setIdleProbe(fn); };
  await h.boot({
    agents: {
      sky: agentFile({ name: 'sky', displayName: 'Sky', role: 'Orchestrator', type: 'orchestrator', order: 0 }),
      wren: agentFile({ name: 'wren', displayName: 'Wren', role: 'Lead', order: 1, reportsTo: 'sky' }),
      ash: agentFile({ name: 'ash', displayName: 'Ash', order: 2, reportsTo: 'wren' }),
      'example-research-lead': agentFile({ name: 'example-research-lead', displayName: 'Rowan', order: 3, reportsTo: 'ash' }),
      ...Object.fromEntries(['birch', 'elm', 'fern', 'moss'].map((n, i) => [n,
        agentFile({ name: n, displayName: n[0].toUpperCase() + n.slice(1), order: 4 + i, reportsTo: 'example-research-lead' })])),
    },
  });
  auth.setIdleProbe = setIdleProbe;
  h.internal.stopScheduler();
  if (fs.existsSync(HELPERS)) {
    require(HELPERS).HELPERS_ENABLED = true;
    require('../../lib/workspace/scaffold.js').scaffoldWorkspace(h.workspaceDir);
  }
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

// ---------------------------------------------------------------------------
// Scenario helpers
// ---------------------------------------------------------------------------

function open(prefix) {
  const convo = h.freshConvoId(prefix);
  opened.add(convo);
  return convo;
}
let seq = 0;
// One Agent call of a lead's message, with a tool_use id unique to this file.
function agentCall(type, { description, prompt, background } = {}) {
  const n = ++seq;
  const input = { subagent_type: type, description: description || `${type} part ${n}`, prompt: prompt || `Brief number ${n} for ${type}.` };
  if (background) input.run_in_background = true;
  return { id: `toolu_stream_${String(type).replace(/[^a-z]/gi, '')}_${n}`, input };
}
const say = (convo, words, agent = 'wren') => {
  const since = client.messages.length;
  client.send({ type: 'chat', conversationId: convo, agent, content: words });
  return since;
};
const turnDone = (convo, since) => client.waitForEvent('system', 'done', convo, { since, timeout: 20000 });
const doneCount = (convo, since = 0) => client.messages.slice(since).filter((m) => m.type === 'system' && m.subtype === 'done' && m._conversationId === convo).length;
const results = (convo, since = 0) => client.messages.slice(since).filter((m) => m.type === 'result' && m._conversationId === convo);
const helpersChanged = (convo, since = 0) => client.messages.slice(since).filter((m) => m.type === 'helpers_changed' && m._conversationId === convo);
const wrenReplies = (convo) => (h.internal.loadTranscript(convo) || []).filter((t) => t.agent === 'wren').map((t) => t.text || t.content || '').join('\n');
const parentOf = () => `toolu_stream_parent_${++seq}`;

// What the hook told the runtime for the call with this tool_use id, once it has.
function hookAnswer(id) {
  const logged = h.readHookAnswers().find((a) => a.toolUseId === id);
  if (!logged) return null;
  return logged.answer ? logged.answer.hookSpecificOutput : { unparsed: logged.raw };
}
const allowedAnswer = (withCard) => ({
  hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'Approved in Rundock',
  ...(withCard ? { additionalContext: approvalNotice('Agent') } : {}),
});
const refusedAnswer = (notice) => ({ hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: notice });
const agentCards = (convo, since = 0) => client.messages.slice(since)
  .filter((m) => m.type === 'control_request' && m._conversationId === convo && m.request && m.request.tool_name === 'Agent');
async function cardFor(convo, since) {
  assert.ok(await h.waitUntil(() => agentCards(convo, since).length > 0, { timeout: 20000 }), `a card was raised in ${convo}`);
  return agentCards(convo, since)[0];
}
const answerCard = (card, allow) => client.send({
  type: 'permission_response', requestId: card.request_id, conversationId: card._conversationId || '', allow, card: true,
});
// The rule for one message of Wren's whose Agent calls are put to the hook.
// Each allowed helper keeps running until its own file exists.
const finishFile = (id) => path.join(h.workspaceDir, `finish-${id}`);
function helpersRule(words, calls, extra = {}) {
  return {
    match: { agent: 'wren', promptIncludes: words }, helpers: true, running: true,
    finishOn: Object.fromEntries(calls.map((c) => [c.id, finishFile(c.id)])),
    turn: [{ text: 'Starting these.' }, ...calls.map((c) => ({ agentTool: c.input, id: c.id }))],
    ...extra,
  };
}
const finishHelper = (id) => fs.writeFileSync(finishFile(id), '');
// The cap's events for a conversation, from the workspace's events file.
function capEvents(convo) {
  const dir = path.join(h.workspaceDir, '.rundock', 'state');
  const out = [];
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /^events-\d{4}-\d{2}\.jsonl$/.test(f)); } catch (e) { return out; }
  for (const f of files) {
    for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) if (l.trim()) out.push(JSON.parse(l));
  }
  return out.filter((e) => e.e === 'helper_cap' && e.conv === convo);
}
// Hold `fn` with a different hold at the cap, and put the old one back.
async function withHold(ms, fn) {
  const m = helpers();
  const before = m.HELPER_HOLD_MS;
  m.HELPER_HOLD_MS = ms;
  try { return await fn(); } finally { m.HELPER_HOLD_MS = before; }
}
const CAP_NOTICE = 'At most five helpers run at once. Wait for these to report back, then start the rest.';

// ---------------------------------------------------------------------------
// The parent filter
// ---------------------------------------------------------------------------

test('with helpers on, a line from a helper never joins the lead\'s reply or its steps', async () => {
  helpers();
  const convo = open('parent-helper');
  const parent = parentOf();
  const nested = agentCall('ash');
  h.writeScenario([{ match: { agent: 'wren', promptIncludes: 'helper line words' }, turn: [
    { raw: fx.helperLine(fx.contentBlockStartText(0), parent) },
    { raw: fx.helperLine(fx.textDelta('words a helper wrote', 0), parent) },
    { raw: fx.helperLine(fx.toolUseStart('Read', 1, `toolu_stream_read_${seq}`), parent) },
    ...fx.toolUseFlow('Agent', nested.input, 2, nested.id).map((e) => ({ raw: fx.helperLine(e, parent) })),
    { raw: fx.helperLine(fx.messageStop(), parent) },
    { text: 'words the lead wrote' },
  ] }]);
  const since = say(convo, 'helper line words');
  const { msg: result } = await client.waitFor((m) => m.type === 'result' && m._conversationId === convo, { since, label: 'result' });
  await turnDone(convo, since);
  const reply = wrenReplies(convo);
  assert.ok(reply.includes('words the lead wrote'), `the lead's words are its reply: ${reply}`);
  assert.ok(!reply.includes('words a helper wrote'), `the helper's words are not: ${reply}`);
  assert.ok(!result._toolCalls.some((t) => t.tool === 'Read' || t.tool === 'Agent'), `the helper's tools are not the lead's steps: ${JSON.stringify(result._toolCalls)}`);
  const state = helpers().stateOf(convo);
  assert.ok(!state || !state.latest, 'no batch was decided from the helper\'s message');
  assert.strictEqual(h.readInvocations().filter((i) => i.agent === 'ash' && i.env.RUNDOCK_CONVO_ID === convo).length, 0, 'the helper\'s Agent call handed nothing over');
});

// Each of the next two also sends a helper's line, so on a server without the
// filter both fail on the reply they check.
test('with helpers on, a line whose parent_tool_use_id is null is the lead\'s', async () => {
  helpers();
  const convo = open('parent-null');
  h.writeScenario([{ match: { agent: 'wren', promptIncludes: 'null parent words' }, turn: [
    { raw: fx.helperLine(fx.contentBlockStartText(0), parentOf()) },
    { raw: fx.helperLine(fx.textDelta('a helper aside', 0), `toolu_stream_parent_${seq}`) },
    { raw: { ...fx.contentBlockStartText(0), parent_tool_use_id: null } },
    { raw: { ...fx.textDelta('the lead with a null parent', 0), parent_tool_use_id: null } },
    { raw: { ...fx.contentBlockStop(0), parent_tool_use_id: null } },
  ] }]);
  const since = say(convo, 'null parent words');
  await turnDone(convo, since);
  assert.strictEqual(wrenReplies(convo).trim(), 'the lead with a null parent');
});

test('with helpers on, a line with no parent_tool_use_id is the lead\'s', async () => {
  helpers();
  const convo = open('parent-absent');
  h.writeScenario([{ match: { agent: 'wren', promptIncludes: 'absent parent words' }, turn: [
    { raw: fx.helperLine(fx.contentBlockStartText(0), parentOf()) },
    { raw: fx.helperLine(fx.textDelta('a helper aside', 0), `toolu_stream_parent_${seq}`) },
    { text: 'the lead with no parent' },
  ] }]);
  const since = say(convo, 'absent parent words');
  await turnDone(convo, since);
  assert.strictEqual(wrenReplies(convo).trim(), 'the lead with no parent');
});

// Also sends a helper's line, so on a server without the filter it fails on
// the reply it checks.
test('with helpers on, a line and a result whose parent_tool_use_id is empty are the lead\'s', async () => {
  helpers();
  const convo = open('parent-empty');
  const empty = (envelope) => ({ raw: { ...envelope, parent_tool_use_id: '' } });
  h.writeScenario([{ match: { agent: 'wren', promptIncludes: 'empty parent words' }, resultExtra: { parent_tool_use_id: '' }, turn: [
    { raw: fx.helperLine(fx.contentBlockStartText(0), parentOf()) },
    { raw: fx.helperLine(fx.textDelta('a helper aside', 0), `toolu_stream_parent_${seq}`) },
    empty(fx.contentBlockStartText(0)),
    empty(fx.textDelta('the lead with an empty parent', 0)),
    empty(fx.contentBlockStop(0)),
  ] }]);
  const since = say(convo, 'empty parent words');
  assert.ok(await h.waitUntil(() => doneCount(convo, since) >= 1, { timeout: 20000 }), 'the result with an empty parent ended the lead\'s turn');
  assert.deepStrictEqual(results(convo, since).map((r) => r.parent_tool_use_id), [''], 'it reached the page as the lead\'s result');
  assert.strictEqual(wrenReplies(convo).trim(), 'the lead with an empty parent');
});

test('with helpers on, a helper\'s result does not end the lead\'s turn', async () => {
  helpers();
  const convo = open('parent-result');
  const parent = parentOf();
  h.writeScenario([{ match: { agent: 'wren', promptIncludes: 'helper result words' }, turn: [
    { raw: fx.helperLine(fx.result({ text: 'a helper finished' }), parent) },
    { text: 'the lead finished' },
  ] }]);
  const since = say(convo, 'helper result words');
  await turnDone(convo, since);
  await h.delay(300);
  assert.strictEqual(doneCount(convo, since), 1, 'one done, for the lead\'s result');
  assert.deepStrictEqual(results(convo, since).map((r) => r.result), ['the lead finished'], 'only the lead\'s result reached the page');
});

// ---------------------------------------------------------------------------
// task_* lines and helpers_changed
// ---------------------------------------------------------------------------

test('with helpers on, each helper the lead starts reaches the page as a row, from running to its end', async () => {
  names('runningCount', 'helperRows');
  const convo = open('rows-page');
  const calls = [agentCall('Explore', { description: 'Look   around the repo' }), agentCall('Plan')];
  h.writeScenario([{ match: { agent: 'wren', promptIncludes: 'two built-ins for rows' }, helpers: true, turn: calls.map((c) => ({ agentTool: c.input, id: c.id })) }]);
  const since = say(convo, 'two built-ins for rows');
  assert.ok(await h.waitUntil(() => {
    const all = helpersChanged(convo, since);
    return all.length && all[all.length - 1].helpers.length === 2 && all[all.length - 1].helpers.every((r) => r.state === 'completed');
  }, { timeout: 20000 }), `both rows finished: ${JSON.stringify(helpersChanged(convo, since))}`);
  const all = helpersChanged(convo, since);
  assert.ok(all.every((m) => m.agentId === 'wren'), 'each names the lead');
  assert.ok(all.some((m) => m.helpers.some((r) => r.state === 'running')), 'each ran first');
  // Rows join in the order their calls are answered, which the runtime does
  // not fix, so they are compared by id.
  const byId = (rows) => [...rows].sort((a, b) => a.toolUseId.localeCompare(b.toolUseId));
  assert.deepStrictEqual(byId(all[all.length - 1].helpers), byId([
    { toolUseId: calls[0].id, agent: 'Explore', kind: 'builtin', task: 'Look around the repo', state: 'completed', step: null },
    { toolUseId: calls[1].id, agent: 'Plan', kind: 'builtin', task: calls[1].input.description, state: 'completed', step: null },
  ]));
  assert.strictEqual(helpers().runningCount(convo), 0);
});

test('with helpers on, a task_started for a call the lead\'s messages never made is counted', async () => {
  names('runningCount');
  const convo = open('rows-unknown');
  h.writeScenario([{ match: { agent: 'wren', promptIncludes: 'unknown task line' }, turn: [
    { raw: fx.taskStarted({ taskId: 'task_unknown', toolUseId: 'toolu_stream_unknown', description: 'Look', subagentType: 'Explore' }) },
    { raw: fx.taskProgress({ taskId: 'task_unknown', toolUseId: 'toolu_stream_unknown', lastToolName: 'Glob' }) },
    { text: 'carrying on' },
  ] }]);
  const since = say(convo, 'unknown task line');
  await client.waitFor((m) => m.type === 'result' && m._conversationId === convo, { since, label: 'result' });
  assert.strictEqual(helpers().runningCount(convo), 1);
  const last = helpersChanged(convo, since).pop();
  assert.ok(last, 'helpers_changed was sent');
  assert.deepStrictEqual(last.helpers.map((r) => [r.toolUseId, r.state, r.step]), [['toolu_stream_unknown', 'running', 'Glob']]);
});

// ---------------------------------------------------------------------------
// The cap, through the hook
// ---------------------------------------------------------------------------

test('with helpers on, Allow on the card for six teammate calls starts five through the hook and holds the sixth until one finishes', async () => {
  names('runningCount', 'helperRows');
  const convo = open('cap-card');
  const calls = Array.from({ length: 6 }, () => agentCall('ash'));
  h.writeScenario([helpersRule('six teammates at once', calls)]);
  const since = say(convo, 'six teammates at once');
  answerCard(await cardFor(convo, since), true);
  const answered = () => calls.filter((c) => hookAnswer(c.id));
  assert.ok(await h.waitUntil(() => answered().length >= 5, { timeout: 20000 }), 'five were answered');
  await h.delay(300);
  assert.strictEqual(answered().length, 5, `the sixth is held: ${JSON.stringify(calls.map((c) => hookAnswer(c.id)))}`);
  for (const c of answered()) assert.deepStrictEqual(hookAnswer(c.id), allowedAnswer(true));
  const held = calls.find((c) => !hookAnswer(c.id));
  assert.strictEqual(helpers().runningCount(convo), 5);
  const rows = helpersChanged(convo, since).pop().helpers;
  assert.deepStrictEqual(rows.filter((r) => r.state === 'waiting').map((r) => [r.toolUseId, r.kind]), [[held.id, 'teammate']]);
  assert.ok(await h.waitUntil(() => capEvents(convo).length >= 1, { timeout: 5000 }), 'the hold is recorded');
  assert.deepStrictEqual(capEvents(convo).map((e) => [e.agent, e.d]), [['wren', { outcome: 'held' }]]);

  finishHelper(answered()[0].id);
  assert.ok(await h.waitUntil(() => hookAnswer(held.id), { timeout: 20000 }), 'the held call is answered once one finishes');
  assert.deepStrictEqual(hookAnswer(held.id), allowedAnswer(true));
  await client.waitFor((m) => m.type === 'result' && m._conversationId === convo, { since, label: 'result' });
  assert.strictEqual(helpers().runningCount(convo), 5);
  assert.ok(await h.waitUntil(() => capEvents(convo).length >= 2, { timeout: 5000 }), 'the start is recorded');
  assert.deepStrictEqual(capEvents(convo).map((e) => e.d.outcome).sort(), ['held', 'started']);
});

test('with helpers on, a call held at the cap that no slot frees for is refused through the hook with the cap\'s reason', async () => {
  names('runningCount', 'helperRows');
  const convo = open('cap-refused');
  const calls = Array.from({ length: 6 }, () => agentCall('Explore'));
  h.writeScenario([helpersRule('six explorers at once', calls)]);
  await withHold(300, async () => {
    const since = say(convo, 'six explorers at once');
    await client.waitFor((m) => m.type === 'result' && m._conversationId === convo, { since, label: 'result' });
  });
  const answers = calls.map((c) => hookAnswer(c.id));
  assert.deepStrictEqual(answers.filter((a) => a.permissionDecision === 'allow'), Array(5).fill(allowedAnswer(false)));
  assert.deepStrictEqual(answers.filter((a) => a.permissionDecision === 'deny'), [refusedAnswer(CAP_NOTICE)]);
  assert.strictEqual(helpers().runningCount(convo), 5);
  assert.ok(await h.waitUntil(() => capEvents(convo).length >= 2, { timeout: 5000 }), 'the hold and refusal are recorded');
  assert.deepStrictEqual(capEvents(convo).map((e) => e.d.outcome).sort(), ['held', 'refused']);
});

// The count is the server's own. A hook request carries fields a lead's
// process can write, and a page message is whatever a page sends; neither is
// read as a helper starting or ending.
test('with helpers on, nothing in a hook request or a page message changes the count or the rows the page is sent', async () => {
  const m = names('runningCount', 'helperRows');
  const convo = open('count-forged');
  const calls = [agentCall('Explore'), agentCall('Explore'), agentCall('Explore')];
  const [finished, ...running] = calls;
  h.writeScenario([helpersRule('three explorers to forge against', calls)]);
  const since = say(convo, 'three explorers to forge against');
  await client.waitFor((x) => x.type === 'result' && x._conversationId === convo, { since, label: 'result' });
  finishHelper(finished.id);
  assert.ok(await h.waitUntil(() => m.runningCount(convo) === 2, { timeout: 20000 }), 'one of the three finished');
  const known = m.helperRows(convo);
  assert.deepStrictEqual(Object.fromEntries(known.map((r) => [r.toolUseId, r.state])),
    { [finished.id]: 'completed', [running[0].id]: 'running', [running[1].id]: 'running' });
  assert.deepStrictEqual(helpersChanged(convo, since).pop().helpers, known, 'the page has these rows');
  async function unchanged(what, from) {
    await h.delay(200);
    assert.strictEqual(m.runningCount(convo), 2, `${what}: the count is unchanged`);
    assert.deepStrictEqual(m.helperRows(convo), known, `${what}: the rows are unchanged`);
    assert.deepStrictEqual(helpersChanged(convo, from), [], `${what}: no rows were sent to the page`);
  }

  // Hook requests under the lead's own token. The lead's own requests carry
  // only the call's id, and the runtime names Agent calls Agent.
  const forged = [
    ['a call no message made, as a helper\'s', { tool_input: agentCall('Explore').input, tool_use_id: 'toolu_stream_forged_fresh', agent_id: 'agent-forged', agent_type: 'Explore' }, m.NOTICES.fromHelper],
    ['a running helper\'s own call, as a helper\'s', { tool_input: running[0].input, tool_use_id: running[0].id, agent_id: 'agent-forged', agent_type: 'Explore' }, m.NOTICES.fromHelper],
    ['the finished helper\'s call again, naming an agent type', { tool_input: finished.input, tool_use_id: finished.id, agent_type: 'Explore' }, m.NOTICES.unmatched],
  ];
  for (const [what, body, notice] of forged) {
    const from = client.messages.length;
    const reply = await ask({ tool_name: 'Agent', conversation_id: convo, ...body }, { headers: h.hookHeaders(convo, 'wren') }).reply;
    await unchanged(what, from);
    assert.deepStrictEqual(reply.body, { allow: false, notice }, `${what}: refused`);
  }
  const from = client.messages.length;
  const renamed = ask({ tool_name: 'Task', tool_input: agentCall('Explore').input, tool_use_id: 'toolu_stream_forged_task', conversation_id: convo },
    { headers: h.hookHeaders(convo, 'wren') });
  const { msg: card } = await client.waitFor((x) => x.type === 'control_request' && x._conversationId === convo && x.request && x.request.tool_name === 'Task',
    { since: from, label: 'the card for a call under another tool name' });
  client.send({ type: 'permission_response', requestId: card.request_id, conversationId: convo, allow: true, card: true });
  assert.deepStrictEqual((await renamed.reply).body, { allow: true, card: true }, 'a call under another tool name is carded as any other tool');
  await unchanged('a call under another tool name, allowed', from);

  // Page messages over the socket, naming helpers or a count.
  for (const msg of [
    { type: 'helpers_changed', conversationId: convo, _conversationId: convo, agentId: 'wren', helpers: [] },
    { type: 'stop_helper', conversationId: convo, toolUseId: running[0].id },
    { type: 'task_notification', conversationId: convo, task_id: `task_${running[1].id}`, tool_use_id: running[1].id, status: 'completed' },
    { type: 'set_helper_count', conversationId: convo, count: 0 },
  ]) {
    const at = client.messages.length;
    client.send(msg);
    await unchanged(`a page message ${msg.type}`, at);
  }
});

// ---------------------------------------------------------------------------
// The open request: a result while helpers run ends a turn, not the request
// ---------------------------------------------------------------------------

// A helper's end, as Claude Code reports it, and the file that lets the stub
// write it with the lead's next turn.
const wakeFile = (name) => path.join(h.workspaceDir, `wake-${name}`);
const wake = (name) => fs.writeFileSync(wakeFile(name), '');
const ended = (call, status = 'completed') => fx.taskNotification({ taskId: `task_${call.id}`, toolUseId: call.id, status });
async function nthResult(convo, since, n) {
  assert.ok(await h.waitUntil(() => results(convo, since).length >= n, { timeout: 20000 }), `result ${n} arrived in ${convo}`);
  return results(convo, since)[n - 1];
}
async function requestDone(convo, since) {
  assert.ok(await h.waitUntil(() => doneCount(convo, since) >= 1, { timeout: 20000 }), `the request in ${convo} ended with done`);
}
const entryOf = (convo) => h.internal.chatProcesses.get(convo);
const usage = (out) => ({ input_tokens: 1000 + out, output_tokens: out, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
const steps = (r) => (r._toolCalls || []).map((t) => t.tool);

test('with helpers on, the lead\'s result while a helper runs sends no done and leaves it busy, and the first result after the helper ends sends done', async () => {
  names('runningCount', 'helping');
  const convo = open('open-request');
  const call = agentCall('Explore');
  h.writeScenario([helpersRule('one explorer then a wake', [call], {
    finishOn: {},
    then: [{ untilFile: wakeFile(call.id), lines: [ended(call)], turn: [{ text: 'The explorer reported back.' }] }],
  })]);
  const since = say(convo, 'one explorer then a wake');
  await nthResult(convo, since, 1);
  await h.delay(300);
  assert.strictEqual(doneCount(convo, since), 0, 'no done while the helper runs');
  const entry = entryOf(convo);
  assert.ok(entry && !entry.exited && h.pidAlive(entry.process.pid), 'the lead is alive');
  assert.strictEqual(entry.idle, false, 'the lead stays busy');
  assert.strictEqual(helpers().runningCount(convo), 1);

  wake(call.id);
  await requestDone(convo, since);
  assert.deepStrictEqual(results(convo, since).map((r) => r.result), ['Starting these.', 'The explorer reported back.']);
  await h.delay(200);
  assert.strictEqual(doneCount(convo, since), 1, 'one done, for the request');
  assert.strictEqual(entryOf(convo).idle, true, 'the lead is idle once the request ends');
  assert.strictEqual(helpers().helping(convo), false);
});

test('with helpers on, each helper that ends wakes the lead for a turn with its own time, usage and steps', async () => {
  names('runningCount', 'helping');
  const convo = open('open-wakes');
  const calls = [agentCall('Explore'), agentCall('Explore')];
  h.writeScenario([helpersRule('two explorers then two wakes', calls, {
    finishOn: {},
    resultExtra: { duration_ms: 24600, usage: usage(1200) },
    then: [
      { untilFile: wakeFile(calls[0].id), lines: [ended(calls[0])], turn: [{ tool: { name: 'Read', input: { file_path: 'notes.md' } } }, { text: 'The first one is back.' }], resultExtra: { duration_ms: 4300, usage: usage(300) } },
      { untilFile: wakeFile(calls[1].id), lines: [ended(calls[1])], turn: [{ tool: { name: 'Grep', input: { pattern: 'todo' } } }, { text: 'The second one is back.' }], resultExtra: { duration_ms: 3100, usage: usage(200) } },
    ],
  })]);
  const since = say(convo, 'two explorers then two wakes');
  await nthResult(convo, since, 1);
  await h.delay(50);
  wake(calls[0].id);
  await nthResult(convo, since, 2);
  await h.delay(50);
  assert.strictEqual(doneCount(convo, since), 0, 'no done while the second helper runs');
  wake(calls[1].id);
  await requestDone(convo, since);
  const all = results(convo, since);
  assert.deepStrictEqual(all.map((r) => r.duration_ms), [24600, 4300, 3100], 'each turn\'s time is forwarded untouched');
  assert.deepStrictEqual(all.map((r) => r.usage), [usage(1200), usage(300), usage(200)], 'each turn\'s usage is forwarded untouched');
  assert.deepStrictEqual(all.map(steps), [['Agent', 'Agent'], ['Read'], ['Grep']], 'each turn holds only its own steps');
  assert.ok(all[1]._turnStartTime > all[0]._turnStartTime && all[2]._turnStartTime > all[1]._turnStartTime,
    `each turn starts later than the one before: ${all.map((r) => r._turnStartTime)}`);
  await h.delay(200);
  assert.strictEqual(doneCount(convo, since), 1, 'one done, for the request');
});

test('with helpers on, a message the person sends while only helpers work reaches the lead and starts a turn, and the helper carries on', async () => {
  names('runningCount', 'helping');
  const convo = open('open-person');
  const call = agentCall('Explore');
  h.writeScenario([
    helpersRule('one explorer and a note', [call], {
      finishOn: {},
      then: [{ untilFile: wakeFile(call.id), lines: [ended(call)], turn: [{ text: 'The explorer reported back.' }] }],
    }),
    { match: { agent: 'wren', promptIncludes: 'a note while it works' }, turn: [{ tool: { name: 'Glob', input: { pattern: '*.md' } } }, { text: 'Noted.' }] },
  ]);
  const since = say(convo, 'one explorer and a note');
  const first = await nthResult(convo, since, 1);
  const entry = entryOf(convo);
  const pid = entry.process.pid;
  say(convo, 'a note while it works');
  const second = await nthResult(convo, since, 2);
  assert.ok(h.promptsFor('wren').some((p) => p.includes('a note while it works')), 'the message reached the lead');
  assert.strictEqual(entryOf(convo), entry, 'the same lead served it');
  assert.strictEqual(entryOf(convo).process.pid, pid);
  assert.strictEqual(second.result, 'Noted.');
  assert.deepStrictEqual(steps(second), ['Glob'], 'the person\'s turn holds only its own steps');
  assert.ok(second._turnStartTime > first._turnStartTime, 'the person\'s turn starts later');
  assert.strictEqual(helpers().runningCount(convo), 1, 'the helper carries on');
  await h.delay(200);
  assert.strictEqual(doneCount(convo, since), 0, 'the request is still open');

  wake(call.id);
  await requestDone(convo, since);
  assert.deepStrictEqual(results(convo, since).map((r) => r.result), ['Starting these.', 'Noted.', 'The explorer reported back.']);
  await h.delay(200);
  assert.strictEqual(doneCount(convo, since), 1);
});

test('with helpers on, after a cap refusal a later lone teammate call in the same request is a helper', async () => {
  names('runningCount', 'stateOf');
  const convo = open('open-retry');
  const calls = Array.from({ length: 6 }, () => agentCall('Explore'));
  const lone = agentCall('ash');
  h.writeScenario([
    helpersRule('six explorers then a retry', calls),
    { match: { agent: 'wren', promptIncludes: 'now start ash' }, helpers: true, turn: [{ agentTool: lone.input, id: lone.id }] },
  ]);
  const since = say(convo, 'six explorers then a retry');
  await withHold(300, () => nthResult(convo, since, 1));
  const allowed = calls.filter((c) => hookAnswer(c.id) && hookAnswer(c.id).permissionDecision === 'allow');
  assert.strictEqual(allowed.length, 5);
  for (const c of allowed) finishHelper(c.id);
  assert.ok(await h.waitUntil(() => helpers().runningCount(convo) === 0, { timeout: 20000 }), 'the five finished');
  assert.strictEqual(doneCount(convo, since), 0, 'no result since the count reached zero, so the request is open');

  const later = say(convo, 'now start ash');
  answerCard(await cardFor(convo, later), true);
  await requestDone(convo, since);
  assert.deepStrictEqual(hookAnswer(lone.id), allowedAnswer(true), 'the lone call was allowed as a helper');
  assert.strictEqual(helpers().stateOf(convo).latest.kind, 'helpers');
  assert.strictEqual(h.readInvocations().filter((i) => i.agent === 'ash' && i.env.RUNDOCK_CONVO_ID === convo).length, 0, 'nothing was handed over');
});

test('with helpers on, a helper killed, stopped or failed lowers the count', async () => {
  names('runningCount', 'helperRows');
  const convo = open('open-killed');
  const calls = [agentCall('Explore'), agentCall('Explore'), agentCall('Explore')];
  h.writeScenario([helpersRule('three explorers that end badly', calls, {
    finishOn: {},
    then: [{ untilFile: wakeFile(calls[0].id), lines: [ended(calls[0], 'killed'), ended(calls[1], 'stopped'), ended(calls[2], 'failed')], turn: [{ text: 'None of them finished.' }] }],
  })]);
  const since = say(convo, 'three explorers that end badly');
  await nthResult(convo, since, 1);
  assert.strictEqual(helpers().runningCount(convo), 3);
  wake(calls[0].id);
  await requestDone(convo, since);
  assert.strictEqual(helpers().runningCount(convo), 0);
  const rows = helpersChanged(convo, since).pop().helpers;
  assert.deepStrictEqual(Object.fromEntries(rows.map((r) => [r.toolUseId, r.state])),
    { [calls[0].id]: 'killed', [calls[1].id]: 'killed', [calls[2].id]: 'failed' });
});

// ---------------------------------------------------------------------------
// Holds: while the lead's helpers run, nothing returns, hands back or is killed
// ---------------------------------------------------------------------------

// Each return to an agent above, as the page is told of it.
const switches = (convo, since = 0) => client.messages.slice(since)
  .filter((m) => m.type === 'system' && m.subtype === 'agent_switch' && m._conversationId === convo && m.returning);
const switchPairs = (convo, since) => switches(convo, since).map((m) => [m.fromAgent, m.toAgent]);
async function waitSwitch(convo, since, from, to) {
  assert.ok(await h.waitUntil(() => switches(convo, since).some((m) => m.fromAgent === from && m.toAgent === to), { timeout: 20000 }),
    `${from} returned to ${to}: ${JSON.stringify(switchPairs(convo, since))}`);
}
async function resultFrom(convo, agent, since) {
  const { msg } = await client.waitFor((m) => m.type === 'result' && m._conversationId === convo && m._agent === agent,
    { since, timeout: 20000, label: `${agent}'s result` });
  return msg;
}
// The dones one process sent; a process the lead replaced can send its own late.
const doneFrom = (convo, processId, since) => client.messages.slice(since)
  .filter((m) => m.type === 'system' && m.subtype === 'done' && m._conversationId === convo && m._processId === processId).length;
// Sky is the workspace's default agent, so the page knows it by the id 'default'.
const SKY = 'default';
// Sky, handed the conversation back, stays quiet.
const SKY_SILENT = { match: { agent: 'sky', promptIncludes: '[SYSTEM' }, turn: [{ text: '<silent>' }] };
// One message of `agent`'s that hands the conversation to `to` with `brief`.
const handoff = (agent, words, to, brief) => ({
  match: { agent, promptIncludes: words },
  turn: [{ agentTool: { subagent_type: to, description: `Over to ${to}`, prompt: brief }, id: `toolu_stream_handoff_${++seq}` }],
});
// One message of `agent`'s that starts `calls` as helpers and writes `text`.
// The helpers end, and the lead wakes, once wake(name) is called.
function heldRule(agent, words, calls, text, name) {
  return {
    match: { agent, promptIncludes: words }, helpers: true, running: true, finishOn: {},
    turn: [{ text }, ...calls.map((c) => ({ agentTool: c.input, id: c.id }))],
    then: [{ untilFile: wakeFile(name), lines: calls.map((c) => ended(c)), turn: [{ text: 'They reported back.' }] }],
  };
}
// The lead is alive and busy, nothing has returned and it sent no done.
function assertHeld(convo, agent, since) {
  const entry = entryOf(convo);
  assert.ok(entry && entry.agentId === agent && !entry.exited && h.pidAlive(entry.process.pid), `${agent} is alive: ${entry && entry.agentId}`);
  assert.deepStrictEqual(switchPairs(convo, since), [], 'nothing returned');
  assert.strictEqual(doneFrom(convo, entry.processId, since), 0, 'no done');
  assert.strictEqual(helpers().runningCount(convo) > 0, true, 'its helpers still run');
  return entry;
}

test('with helpers on, a return the page asks for while the delegate\'s helpers run waits, and acts at the first result after they end', async () => {
  names('runningCount', 'helping');
  const convo = open('hold-marker');
  const call = agentCall('Explore');
  h.writeScenario([
    SKY_SILENT,
    handoff('sky', 'hold-marker', 'wren', 'wren brief hold-marker'),
    heldRule('wren', 'wren brief hold-marker', [call], 'Started an explorer.', 'hold-marker'),
  ]);
  const since = say(convo, 'hold-marker please', 'sky');
  await resultFrom(convo, 'wren', since);
  client.send({ type: 'end_delegation', conversationId: convo });
  await h.delay(800);
  const entry = assertHeld(convo, 'wren', since);
  assert.ok(entry.delegation, 'wren is still the delegate');
  assert.ok(wrenReplies(convo).includes('Started an explorer.'), 'its reply is stored');
  wake('hold-marker');
  await waitSwitch(convo, since, 'wren', SKY);
});

test('with helpers on, a delegate\'s auto-return waits while its helpers run, and acts at the first result after they end', async () => {
  names('runningCount', 'helping');
  const convo = open('hold-auto');
  const call = agentCall('Explore');
  h.writeScenario([
    SKY_SILENT,
    handoff('sky', 'hold-auto', 'wren', 'wren brief hold-auto'),
    heldRule('wren', 'wren brief hold-auto', [call], `Started an explorer. ${fx.MARKERS.COMPLETE}`, 'hold-auto'),
  ]);
  const since = say(convo, 'hold-auto please', 'sky');
  await resultFrom(convo, 'wren', since);
  await h.delay(800);
  const entry = assertHeld(convo, 'wren', since);
  assert.strictEqual(entry.pendingKill, true, 'the auto-return is pending');
  assert.ok(wrenReplies(convo).includes('Started an explorer.'), 'its reply is stored');
  wake('hold-auto');
  await waitSwitch(convo, since, 'wren', SKY);
});

test('with helpers on, a lead started again after a loop guard keeps its handoff marker\'s kill waiting while its helpers run', async () => {
  names('runningCount', 'helping');
  const convo = open('hold-respawn');
  const call = agentCall('Explore');
  h.writeScenario([
    SKY_SILENT,
    heldRule('wren', 'hold-respawn look around now', [call], `Started an explorer. ${fx.MARKERS.COMPLETE}`, 'hold-respawn'),
    handoff('wren', 'ash returned because the request was outside their scope', 'ash', 'ash brief hold-respawn again'),
    handoff('wren', 'hold-respawn', 'ash', 'ash brief hold-respawn'),
    { match: { agent: 'ash', promptIncludes: 'ash brief hold-respawn' }, turn: [{ text: `Not mine. ${fx.MARKERS.RETURN}` }] },
  ]);
  const since = say(convo, 'hold-respawn start');
  await client.waitFor((m) => m.type === 'assistant' && m._conversationId === convo && m.message
    && typeof m.message.content === 'string' && m.message.content.includes('has already completed this task'), { since, timeout: 20000, label: 'the loop guard' });
  assert.ok(await h.waitUntil(() => { const e = entryOf(convo); return e && e.agentId === 'wren' && !e.exited; }, { timeout: 10000 }), 'wren was started again');
  const later = say(convo, 'hold-respawn look around now');
  await resultFrom(convo, 'wren', later);
  await h.delay(800);
  const entry = assertHeld(convo, 'wren', later);
  assert.strictEqual(entry.scopeReturn, true, 'the marker was seen');
  assert.strictEqual(entry.pendingKill, true, 'its kill is pending');
  wake('hold-respawn');
  await waitSwitch(convo, later, 'wren', SKY);
});

test('with helpers on, a parent resumed after its delegate hands back keeps its handoff marker\'s kill waiting while its helpers run', async () => {
  names('runningCount', 'helping');
  const convo = open('hold-resumed');
  const call = agentCall('Explore');
  h.writeScenario([
    SKY_SILENT,
    heldRule('wren', '[SYSTEM: work-continues]', [call], `Started an explorer. ${fx.MARKERS.COMPLETE}`, 'hold-resumed'),
    handoff('wren', 'hold-resumed start', 'ash', 'ash brief hold-resumed'),
    { match: { agent: 'ash', promptIncludes: 'ash brief hold-resumed' }, turn: [{ text: 'My part is done. <!-- RUNDOCK:CONTINUE -->' }] },
  ]);
  const since = say(convo, 'hold-resumed start');
  const { index } = await client.waitFor((m) => m.type === 'system' && m.subtype === 'agent_switch' && m._conversationId === convo
    && m.returning && m.fromAgent === 'ash', { since, timeout: 20000, label: 'ash handed back' });
  const back = index + 1;
  await resultFrom(convo, 'wren', back);
  await h.delay(800);
  const entry = assertHeld(convo, 'wren', back);
  assert.strictEqual(entry.scopeReturn, true, 'the marker was seen');
  assert.strictEqual(entry.pendingKill, true, 'its kill is pending');
  wake('hold-resumed');
  await waitSwitch(convo, back, 'wren', SKY);
});

test('with helpers on, a lead the person started keeps its handoff marker\'s kill waiting while its helpers run', async () => {
  names('runningCount', 'helping');
  const convo = open('hold-direct');
  const call = agentCall('Explore');
  h.writeScenario([SKY_SILENT, heldRule('wren', 'hold-direct please', [call], `Started an explorer. ${fx.MARKERS.COMPLETE}`, 'hold-direct')]);
  const since = say(convo, 'hold-direct please');
  await resultFrom(convo, 'wren', since);
  await h.delay(800);
  const entry = assertHeld(convo, 'wren', since);
  assert.strictEqual(entry.scopeReturn, true, 'the marker was seen');
  assert.strictEqual(entry.pendingKill, true, 'its kill is pending');
  assert.ok(wrenReplies(convo).includes('Started an explorer.'), 'its reply is stored');
  wake('hold-direct');
  await waitSwitch(convo, since, 'wren', SKY);
  await client.waitFor((m) => m.type === 'system' && m.subtype === 'process_started' && m._conversationId === convo && m._agent === SKY,
    { since, timeout: 20000, label: 'sky started' });
});

test('with helpers on, three handoffs deep, nothing in the chain returns while the deepest lead\'s helpers run, and the hand-backs then return one level at a time', async (t) => {
  names('runningCount', 'helping');
  const convo = open('hold-deep');
  // Each lead in the chain, as the server makes it the conversation's process.
  const leads = [];
  const processes = h.internal.chatProcesses;
  processes.set = function set(key, entry) {
    if (key === convo && !leads.includes(entry)) leads.push(entry);
    return Map.prototype.set.call(this, key, entry);
  };
  t.after(() => { delete processes.set; });
  const reviewers = ['birch', 'elm', 'fern', 'moss'].map((n) => agentCall(n));
  h.writeScenario([
    SKY_SILENT,
    { match: { agent: 'ash', promptIncludes: '[SYSTEM: work-continues]' }, turn: [{ text: `All four reviews are in. ${fx.MARKERS.COMPLETE}` }] },
    handoff('sky', 'hold-deep review', 'wren', 'wren brief hold-deep'),
    handoff('wren', 'wren brief hold-deep', 'ash', 'ash brief hold-deep'),
    handoff('ash', 'ash brief hold-deep', 'example-research-lead', 'rowan brief hold-deep'),
    heldRule('example-research-lead', 'rowan brief hold-deep', reviewers, 'Four reviewers are on it. <!-- RUNDOCK:CONTINUE -->', 'hold-deep'),
  ]);
  const since = say(convo, 'hold-deep review', 'sky');
  answerCard(await cardFor(convo, since), true);
  assert.ok(await h.waitUntil(() => reviewers.every((c) => hookAnswer(c.id)), { timeout: 20000 }), 'all four were answered');
  for (const c of reviewers) assert.deepStrictEqual(hookAnswer(c.id), allowedAnswer(true));
  await resultFrom(convo, 'example-research-lead', since);
  await h.delay(800);
  // No kill was scheduled or fired for any lead in the chain while the helpers
  // run, the wait above being past the kill's 500 ms: Wren and Ash each ended
  // at its own handoff, as today, with no kill scheduled for it, and neither
  // was started again; Rowan is alive, and no kill is under way.
  const ledAs = (id) => leads.filter((e) => e.agentId === id);
  for (const id of ['wren', 'ash']) {
    assert.strictEqual(ledAs(id).length, 1, `${id} led once and was not started again`);
    const [lead] = ledAs(id);
    assert.ok(lead.exited && !h.pidAlive(lead.process.pid), `${id} ended at its own handoff`);
    assert.ok(!lead.pendingKill, `no kill was scheduled for ${id}`);
  }
  assert.strictEqual(ledAs('example-research-lead').length, 1, 'Rowan led once');
  const [rowan] = ledAs('example-research-lead');
  assert.ok(rowan === entryOf(convo) && !rowan.exited && h.pidAlive(rowan.process.pid), 'no kill fired for Rowan');
  assert.strictEqual(h.internal.convoTransitions.has(convo), false, 'no kill is under way in the conversation');
  const entry = assertHeld(convo, 'example-research-lead', since);
  assert.strictEqual(entry.pendingKill, true, 'its auto-return is pending');
  assert.strictEqual(helpers().runningCount(convo), 4);
  wake('hold-deep');
  await waitSwitch(convo, since, 'ash', SKY);
  assert.deepStrictEqual(switchPairs(convo, since), [['example-research-lead', 'ash'], ['ash', SKY]]);
});

// A stub that is stopped or killed cannot log the hook's answer for a call
// still held, so these two read each answer as the server gives it.
async function withAnswers(fn) {
  const m = names('answerAgentRequest');
  const original = m.answerAgentRequest;
  const answers = new Map();
  m.answerAgentRequest = async (args) => {
    const answer = await original(args);
    answers.set(args.data.tool_use_id, answer);
    return answer;
  };
  try { return await fn(answers); } finally { m.answerAgentRequest = original; }
}
async function closeWhileHeld(prefix, close) {
  const convo = open(prefix);
  const calls = Array.from({ length: 6 }, () => agentCall('Explore'));
  h.writeScenario([helpersRule(`six explorers then ${prefix}`, calls)]);
  await withAnswers(async (answers) => {
    const since = say(convo, `six explorers then ${prefix}`);
    assert.ok(await h.waitUntil(() => answers.size >= 5 && capEvents(convo).some((e) => e.d.outcome === 'held'), { timeout: 20000 }),
      'five started and one is held');
    const held = calls.find((c) => !answers.has(c.id));
    const pid = entryOf(convo).process.pid;
    close(convo);
    assert.ok(await h.waitUntil(() => answers.has(held.id), { timeout: 10000 }), 'the held call was answered');
    assert.deepStrictEqual(answers.get(held.id), { allow: false });
    assert.ok(await h.waitForPidExit(pid), 'the lead ended');
    assert.strictEqual(helpers().runningCount(convo), 0);
    assert.deepStrictEqual(helpers().helperRows(convo), []);
    assert.strictEqual(helpers().helping(convo), false);
    await requestDone(convo, since);
    const rows = helpersChanged(convo, since).pop().helpers;
    assert.deepStrictEqual(rows.map((r) => r.state), Array(5).fill('killed'), 'its helpers ended and the held one is gone');
  });
}

test('with helpers on, stopping the conversation refuses the lead\'s held calls, ends its helpers and ends the request', async () => {
  names('runningCount', 'helperRows', 'helping');
  await closeWhileHeld('a stop', (convo) => client.send({ type: 'cancel', conversationId: convo }));
});

test('with helpers on, a lead that crashes refuses its held calls, ends its helpers and ends the request', async () => {
  names('runningCount', 'helperRows', 'helping');
  await closeWhileHeld('a crash', (convo) => entryOf(convo).process.kill('SIGKILL'));
});

test('with helpers on, the reaper keeps a lead whose helpers run, and reaps it once the request ends', async () => {
  names('runningCount', 'helping');
  const convo = open('hold-reaper');
  const call = agentCall('Explore');
  h.writeScenario([heldRule('wren', 'one explorer for the reaper', [call], 'Started an explorer.', 'hold-reaper')]);
  const since = say(convo, 'one explorer for the reaper');
  await resultFrom(convo, 'wren', since);
  const entry = entryOf(convo);
  // A busy entry is kept before the count is read, so this one is made idle
  // and long idle by hand: only the count can keep it.
  entry.idle = true; entry.idleSince = 1;
  h.internal.reapIdleAgents(Date.now() + 24 * 60 * 60 * 1000);
  assert.strictEqual(entryOf(convo), entry, 'the lead is kept');
  assert.ok(h.pidAlive(entry.process.pid), 'and alive');
  entry.idle = false; entry.idleSince = null;
  wake('hold-reaper');
  await requestDone(convo, since);
  h.internal.reapIdleAgents(Date.now() + 24 * 60 * 60 * 1000);
  assert.strictEqual(entryOf(convo), undefined, 'reaped once the count is zero');
});

test('with helpers on, active_processes gives a lead whose helpers run its helper rows and idle false', async () => {
  names('runningCount', 'activeRow');
  const convo = open('hold-active');
  const call = agentCall('Explore', { description: 'Read the notes' });
  h.writeScenario([heldRule('wren', 'one explorer to list', [call], 'Started an explorer.', 'hold-active')]);
  const since = say(convo, 'one explorer to list');
  await resultFrom(convo, 'wren', since);
  const entry = entryOf(convo);
  // The lead is kept busy already, so it is marked idle by hand: only the
  // count can make the row say otherwise.
  entry.idle = true;
  const other = await h.connect();
  try {
    const { msg } = await other.waitFor((m) => m.type === 'active_processes', { label: 'active_processes' });
    const row = msg.processes.find((p) => p.conversationId === convo);
    assert.ok(row, 'the lead is listed');
    assert.strictEqual(row.idle, false);
    assert.deepStrictEqual(row.helpers, [{ toolUseId: call.id, agent: 'Explore', kind: 'builtin', task: 'Read the notes', state: 'running', step: null }]);
  } finally {
    other.close();
    entry.idle = false;
  }
  wake('hold-active');
  await requestDone(convo, since);
});

// Passes on a server without helpers too, by design: the probe reads the
// process map, and a lead whose helpers run stays in it. The sibling that
// fails there is the reaper test above.
test('the idle probe reports the conversation busy while the lead\'s helpers run', async () => {
  const convo = open('hold-probe');
  const call = agentCall('Explore');
  h.writeScenario([heldRule('wren', 'one explorer for the probe', [call], 'Started an explorer.', 'hold-probe')]);
  const since = say(convo, 'one explorer for the probe');
  await resultFrom(convo, 'wren', since);
  await h.delay(200);
  assert.ok(h.internal.chatProcesses.has(convo), 'the lead is in the process map');
  assert.notStrictEqual(h.internal.chatProcesses.size, 0, 'so the probe sees work running');
  wake('hold-probe');
  await requestDone(convo, since);
});

// Passes on a server without helpers too, by design: the probe reads the
// process map, and a lead whose helpers run stays in it. The sibling that
// fails there is the reaper test above, which shares this setup. The helper's
// run is read from the stream's own task lines, which both servers forward.
test('the idle probe server.js registers reports the conversation busy while the lead\'s helpers run, and as it always has once they end', async () => {
  assert.strictEqual(typeof idleProbe, 'function', 'server.js registered an idle probe');
  const convo = open('hold-probe-call');
  const call = agentCall('Explore');
  h.writeScenario([heldRule('wren', 'one explorer the probe is asked about', [call], 'Started an explorer.', 'hold-probe-call')]);
  const since = say(convo, 'one explorer the probe is asked about');
  await resultFrom(convo, 'wren', since);
  const taskLines = (subtype) => client.messages.slice(since)
    .filter((m) => m.type === 'system' && m.subtype === subtype && m._conversationId === convo && m.tool_use_id === call.id);
  assert.ok(await h.waitUntil(() => taskLines('task_started').length === 1, { timeout: 5000 }), 'the helper started');
  await h.delay(200);
  assert.deepStrictEqual(taskLines('task_notification'), [], 'and has not ended');
  assert.strictEqual(idleProbe(), false, 'busy while the helper runs');
  wake('hold-probe-call');
  await requestDone(convo, since);
  await h.delay(200);
  assert.strictEqual(idleProbe(), false, 'busy while the lead stays after its request, as for any process');
  h.internal.reapIdleAgents(Date.now() + 24 * 60 * 60 * 1000);
  assert.strictEqual(entryOf(convo), undefined, 'the lead was reaped');
  assert.deepStrictEqual([...h.internal.chatProcesses.keys()], [], 'nothing else runs');
  assert.strictEqual(idleProbe(), true, 'idle once nothing runs');
});

// ---------------------------------------------------------------------------
// Spawn settings: the depth limit and SendMessage refused, for conversations only
// ---------------------------------------------------------------------------
const spawnsOf = (convo) => h.readInvocations().filter((i) => i.env.RUNDOCK_CONVO_ID === convo);
const disallowedOf = (inv) => { const at = inv.argv.indexOf('--disallowed-tools'); return at >= 0 ? inv.argv[at + 1] : null; };
function assertHelperSettings(inv) {
  assert.strictEqual(inv.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH, '1', `${inv.agent}: the depth limit`);
  assert.ok((disallowedOf(inv) || '').split(',').includes('SendMessage'), `${inv.agent}: SendMessage is refused: ${disallowedOf(inv)}`);
}

test('with helpers on, every conversation spawn carries the depth limit and refuses SendMessage', async () => {
  const convo = open('spawn-settings');
  h.writeScenario([
    SKY_SILENT,
    { match: { agent: 'wren', promptIncludes: '[SYSTEM: work-continues]' }, turn: [{ text: `Finished. ${fx.MARKERS.COMPLETE}` }] },
    handoff('wren', 'spawn settings start', 'ash', 'ash brief spawn settings'),
    { match: { agent: 'ash', promptIncludes: 'ash brief spawn settings' }, turn: [{ text: 'My part is done. <!-- RUNDOCK:CONTINUE -->' }] },
  ]);
  const since = say(convo, 'spawn settings start');
  await waitSwitch(convo, since, 'wren', SKY);
  assert.ok(await h.waitUntil(() => spawnsOf(convo).some((i) => i.agent === 'sky'), { timeout: 20000 }), 'sky was started');
  const spawned = spawnsOf(convo);
  assert.deepStrictEqual(spawned.map((i) => i.agent), ['wren', 'ash', 'wren', 'sky'],
    'the person\'s chat, the handoff, the parent resumed and the orchestrator handed back to');
  const notes = h.internal.getDisallowedTools();
  for (const inv of spawned) {
    assertHelperSettings(inv);
    assert.strictEqual(disallowedOf(inv), `${notes},SendMessage`, `${inv.agent}: the workspace's own list is kept`);
  }
});

test('with helpers on, a lead started again after a loop guard carries the depth limit and refuses SendMessage', async () => {
  const convo = open('spawn-loop');
  h.writeScenario([
    handoff('wren', 'ash returned because the request was outside their scope', 'ash', 'ash brief spawn loop again'),
    handoff('wren', 'spawn loop start', 'ash', 'ash brief spawn loop'),
    { match: { agent: 'ash', promptIncludes: 'ash brief spawn loop' }, turn: [{ text: `Not mine. ${fx.MARKERS.RETURN}` }] },
  ]);
  const since = say(convo, 'spawn loop start');
  await client.waitFor((m) => m.type === 'assistant' && m._conversationId === convo && m.message
    && typeof m.message.content === 'string' && m.message.content.includes('has already completed this task'), { since, timeout: 20000, label: 'the loop guard' });
  assert.ok(await h.waitUntil(() => spawnsOf(convo).filter((i) => i.agent === 'wren').length >= 3, { timeout: 10000 }), 'wren was started again');
  const spawned = spawnsOf(convo);
  assert.deepStrictEqual(spawned.map((i) => i.agent), ['wren', 'ash', 'wren', 'wren'],
    'the person\'s chat, the handoff, the parent resumed and the parent started again');
  for (const inv of spawned) assertHelperSettings(inv);
});

test('with helpers on, a Code-mode spawn, which refuses nothing else, still refuses SendMessage', async () => {
  const convo = open('spawn-code');
  let since = client.messages.length;
  client.send({ type: 'set_workspace_mode', mode: 'code' });
  await client.waitFor((m) => m.type === 'workspace_mode_changed' && m.mode === 'code', { since, label: 'code mode' });
  try {
    h.writeScenario([{ match: { agent: 'wren', promptIncludes: 'spawn in code mode' }, turn: [{ text: 'Done in code mode.' }] }]);
    await turnDone(convo, say(convo, 'spawn in code mode'));
    const spawned = spawnsOf(convo);
    assert.strictEqual(spawned.length, 1);
    assert.strictEqual(spawned[0].env.RUNDOCK_CODE_MODE, '1', 'the workspace is in Code mode');
    assert.strictEqual(disallowedOf(spawned[0]), 'SendMessage');
    assertHelperSettings(spawned[0]);
  } finally {
    since = client.messages.length;
    client.send({ type: 'set_workspace_mode', mode: 'notes' });
    await client.waitFor((m) => m.type === 'workspace_mode_changed' && m.mode === 'notes', { since, label: 'back to notes' });
  }
});

// Saves a routine on Wren's file, so it runs last.
test('with helpers on, a routine run sets no depth limit and keeps the workspace\'s own list, where a conversation spawn sets the limit', async () => {
  assert.strictEqual(h.internal.getSpawnEnv(h.freshConvoId('spawn-env'), 'wren').CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH, '1', 'a conversation spawn has the limit');
  assert.strictEqual(h.internal.getSpawnEnv(null, 'a-run-token').CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH, undefined, 'a routine\'s spawn env has none');
  const name = 'Spawn check';
  const since = client.messages.length;
  client.send({ type: 'save_routine', agentId: 'wren', routine: { name, schedule: 'every day at 07:00', prompt: 'routine spawn check', runOn: 'local' } });
  await client.waitFor((m) => m.type === 'routine_saved' && m.name === name, { since, label: 'the routine saved' });
  h.writeScenario([{ match: { promptIncludes: 'routine spawn check' }, turn: [{ text: 'Checked.' }] }]);
  client.send({ type: 'run_routine_now', agentId: 'wren', name, occurrence: 0 });
  const runsDir = path.join(h.workspaceDir, '.rundock', 'runs');
  const record = () => (fs.existsSync(runsDir) ? fs.readdirSync(runsDir) : []).filter((n) => n.endsWith('.json'))
    .map((n) => JSON.parse(fs.readFileSync(path.join(runsDir, n), 'utf-8'))).find((r) => r.routine === name);
  assert.ok(await h.waitUntil(() => { const r = record(); return r && r.status !== 'running'; }, { timeout: 15000 }), 'the run ended');
  const inv = h.readInvocations().find((i) => i.argv.includes(record().sessionId));
  assert.ok(inv, 'the run\'s spawn was recorded');
  assert.strictEqual(inv.env.RUNDOCK_CONVO_ID, null, 'it has no conversation');
  assert.strictEqual(inv.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH, null, 'no depth limit');
  assert.strictEqual(disallowedOf(inv), h.internal.getDisallowedTools(), 'its list is the workspace mode\'s own, without SendMessage');
});
