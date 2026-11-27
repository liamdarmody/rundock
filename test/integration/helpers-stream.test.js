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
// The team: Wren leads; Ash and Rowan (agent name example-research-lead)
// report to Wren.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const h = require('../helpers/harness.js');
const { agentFile } = require('../helpers/workspace.js');
const fx = require('../fixtures/stream-json.js');
const { approvalNotice } = require('../../scripts/refusal-notice.js');

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
before(async () => {
  await h.boot({
    agents: {
      wren: agentFile({ name: 'wren', displayName: 'Wren', role: 'Lead', order: 1 }),
      ash: agentFile({ name: 'ash', displayName: 'Ash', order: 2, reportsTo: 'wren' }),
      'example-research-lead': agentFile({ name: 'example-research-lead', displayName: 'Rowan', order: 3, reportsTo: 'wren' }),
    },
  });
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
  const calls = ['ash', 'example-research-lead', 'ash', 'example-research-lead', 'ash', 'example-research-lead'].map((a) => agentCall(a));
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
