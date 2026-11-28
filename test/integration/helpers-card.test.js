'use strict';
// HELPERS: A LEAD'S AGENT CALLS, DECIDED TOGETHER, AND ONE CARD BEFORE ITS
// FIRST TEAMMATES START.
//
// With helpers on, every Agent call a lead makes reaches Rundock's permission
// hook. When a lead's message ends, the server places its Agent calls
// together: one teammate call is a handoff, as it always was, and anything
// else is a batch of helpers. A hook request is matched to its message by its
// tool_use_id. A lead's first batch that starts a teammate waits on one card;
// once the person says yes, that lead's later batches in this conversation
// start without one, even after the conversation is reopened.
//
// The switch is a module attribute. It is turned on here after boot and the
// workspace's hook settings are written again, so every agent started
// afterwards puts its Agent calls to the hook. The stub's `helpers` rule puts
// a message's Agent calls to Rundock's real hook once the message has ended,
// as the runtime does, and logs each answer with its tool_use_id.
//
// The team: Wren leads; Ash and Rowan (agent name example-research-lead)
// report to Wren; Sky reports to Ash.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const h = require('../helpers/harness.js');
const { agentFile } = require('../helpers/workspace.js');
const { ask, bash, startRoutine, finished, answersOf } = require('../helpers/permission-route.js');
const { refusalNotice, approvalNotice } = require('../../scripts/refusal-notice.js');
const { readConversations } = require('../../lib/store/persistence.js');
const guard = require('../../lib/workspace/answer-file-guard.js');
const config = require('../../lib/config.js');
const auth = require('../../lib/auth/index.js');
const fx = require('../fixtures/stream-json.js');

const HELPERS = path.join(__dirname, '..', '..', 'lib', 'delegation', 'helpers.js');
// Asserted before the module is used, so a missing module fails a test on an
// assertion instead of throwing from require.
function helpers() {
  assert.ok(fs.existsSync(HELPERS), 'lib/delegation/helpers.js exists');
  return require(HELPERS);
}

const UNMATCHED = "This call couldn't be matched to the lead's message, so it didn't start. Do this part yourself.";
const DENIED = 'The person chose not to start these teammates. Ask them how they want to go on.';
const FROM_HELPER = "Helpers can't start helpers. Do this part yourself, and say in your report what you would have handed on.";
const SELF = "Wren can't be Wren's own helper. Do this part yourself.";
const INEXACT = 'To start Rowan, set the agent to example-research-lead.';
const GENERAL = "To start Rowan, set the agent to example-research-lead. A general helper can't work as Rowan.";
const OTHER_LEAD = 'Sky works for Ash, so only Ash can start Sky. Do this part yourself, or say that this part needs Ash.';
// Every card in this file times out this soon, so a card left unanswered
// shows what a timeout does without waiting two minutes.
const TIMEOUT_MS = 6000;
const HOUR = 60 * 60 * 1000;

let client;
before(async () => {
  await h.boot({
    agents: {
      wren: agentFile({ name: 'wren', displayName: 'Wren', role: 'Lead', order: 1 }),
      ash: agentFile({ name: 'ash', displayName: 'Ash', order: 2, reportsTo: 'wren' }),
      'example-research-lead': agentFile({ name: 'example-research-lead', displayName: 'Rowan', order: 3, reportsTo: 'wren' }),
      sky: agentFile({ name: 'sky', displayName: 'Sky', order: 4, reportsTo: 'ash' }),
    },
    env: { RUNDOCK_PERMISSION_TIMEOUT_MS: String(TIMEOUT_MS) },
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
  if (fs.existsSync(HELPERS)) {
    const m = require(HELPERS);
    m.HELPERS_ENABLED = false;
    m.MATCH_WAIT_MS = 2000;
  }
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
  const input = { description: description || `${type || 'general'} part ${n}`, prompt: prompt || `Do part ${n}.` };
  if (type) input.subagent_type = type;
  if (background) input.run_in_background = true;
  return { id: `toolu_${String(type || 'general').replace(/[^a-z]/gi, '')}_${n}`, input };
}

// The rule for one message of `agent` that makes these Agent calls. With
// `asks` (the default) the stub puts each call to the hook once the message
// has ended; without it the calls are placed and nothing asks for them.
function messageRule(agent, words, calls, { asks = true, extra = [] } = {}) {
  return {
    match: { agent, promptIncludes: words },
    ...(asks ? { helpers: true } : {}),
    turn: [{ text: 'On it.' }, ...calls.map((c) => ({ agentTool: c.input, id: c.id })), ...extra],
  };
}

function say(convo, agent, words) {
  const since = client.messages.length;
  client.send({ type: 'chat', conversationId: convo, agent, content: words });
  return since;
}
const turnDone = (convo, since) => client.waitForEvent('system', 'done', convo, { since, timeout: 20000 });

// What the hook told the runtime for the call with this tool_use id, once it has.
function hookAnswer(id) {
  const logged = h.readHookAnswers().find((a) => a.toolUseId === id);
  if (!logged) return null;
  return logged.answer ? logged.answer.hookSpecificOutput : { unparsed: logged.raw };
}
async function answersOf_(calls, timeout = 20000) {
  const ids = calls.map((c) => c.id);
  assert.ok(await h.waitUntil(() => ids.every((id) => hookAnswer(id)), { timeout }),
    `every call was answered: ${JSON.stringify(ids.map(hookAnswer))}`);
  return ids.map(hookAnswer);
}
const allowed = (withCard) => ({
  hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'Approved in Rundock',
  ...(withCard ? { additionalContext: approvalNotice('Agent') } : {}),
});
const refused = (notice) => ({ hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: notice });

const agentCards = (convo, since = 0) => client.messages.slice(since)
  .filter((m) => m.type === 'control_request' && m._conversationId === convo && m.request && m.request.tool_name === 'Agent');
async function cardFor(convo, since) {
  assert.ok(await h.waitUntil(() => agentCards(convo, since).length > 0, { timeout: 20000 }), `a card was raised in ${convo}`);
  return agentCards(convo, since)[0];
}
const answerCard = (card, allow) => client.send({
  type: 'permission_response', requestId: card.request_id, conversationId: card._conversationId || '', allow, card: true,
});
const pendingIn = (convo) => [...h.internal.pendingPermissionRequests.values()].filter((p) => p.conversationId === convo);

function record(convo) { return readConversations().find((c) => c && c.id === convo); }
function allowedLeads(convo) { const r = record(convo); return r ? r.helpersAllowed : undefined; }

const invocations = (agent, convo) => h.readInvocations().filter((i) => i.agent === agent && i.env.RUNDOCK_CONVO_ID === convo);
const notRunPrompts = (since) => h.readPrompts().slice(since).filter((p) => /NOT run/.test(p.prompt));
const task = (c) => helpers().helperTask(c.input.description, c.input.prompt);

// Hold `fn` with a different match wait, and put the old one back.
async function withMatchWait(ms, fn) {
  const m = helpers();
  const before = m.MATCH_WAIT_MS;
  m.MATCH_WAIT_MS = ms;
  try { return await fn(); } finally { m.MATCH_WAIT_MS = before; }
}

// Ask the permission route about one Agent call, as the hook would.
const askAgent = (convo, agentId, c, extra = {}) => ask(
  { tool_name: 'Agent', tool_input: c ? c.input : {}, ...(c ? { tool_use_id: c.id } : {}), ...extra },
  { headers: h.hookHeaders(convo, agentId) },
);

// ---------------------------------------------------------------------------
// Placement and the card
// ---------------------------------------------------------------------------

test('two teammates in one message are helpers: one card names both in message order, every call waits on it, Allow starts both beside the lead, and the next batch has no card', async () => {
  helpers();
  const convo = open('helpers-two');
  const ash = agentCall('ash');
  const rowan = agentCall('example-research-lead');
  const next = [agentCall('ash'), agentCall('example-research-lead')];
  h.writeScenario([
    messageRule('wren', 'two teammates first', [ash, rowan]),
    messageRule('wren', 'two teammates again', next),
  ]);
  const prompts = h.readPrompts().length;
  const since = say(convo, 'wren', 'two teammates first');
  const card = await cardFor(convo, since);
  assert.strictEqual(card._agent, 'wren', 'the card is the lead\'s');
  assert.deepStrictEqual(card.request.input, {}, 'the card carries no call input');
  assert.deepStrictEqual(card.request.helpers, [
    { agent: 'ash', task: task(ash) },
    { agent: 'example-research-lead', task: task(rowan) },
  ], 'one card names both teammates, in message order');
  await h.delay(300);
  assert.deepStrictEqual([hookAnswer(ash.id), hookAnswer(rowan.id)], [null, null], 'both calls wait on the card');
  assert.strictEqual(agentCards(convo, since).length, 1, 'one card for the batch');
  answerCard(card, true);
  assert.deepStrictEqual(await answersOf_([ash, rowan]), [allowed(true), allowed(true)], 'both start, each told a person approved it');
  await turnDone(convo, since);
  assert.deepStrictEqual(allowedLeads(convo), ['wren'], 'the yes is kept with the conversation');
  const wren = invocations('wren', convo);
  assert.strictEqual(wren.length, 1, 'one lead process');
  assert.ok(h.pidAlive(wren[0].pid), 'the lead was not ended');
  assert.deepStrictEqual([invocations('ash', convo).length, invocations('example-research-lead', convo).length], [0, 0], 'nobody took over');
  assert.deepStrictEqual(notRunPrompts(prompts), [], 'no call was named back as not run');

  // The most common next step: the same lead's next batch starts at once.
  const again = say(convo, 'wren', 'two teammates again');
  assert.deepStrictEqual(await answersOf_(next), [allowed(false), allowed(false)], 'the next batch starts without a card');
  await turnDone(convo, again);
  assert.strictEqual(agentCards(convo, again).length, 0, 'no second card');
  assert.strictEqual(invocations('wren', convo)[0].pid, wren[0].pid, 'the same lead process');
});

test('a first batch\'s card carries helper_others, the number of its calls that are helpers outside the team, beside helpers', async () => {
  helpers();
  const convo = open('helpers-others');
  const ash = agentCall('ash');
  const others = [agentCall('Explore'), agentCall('Plan')];
  h.writeScenario([messageRule('wren', 'a teammate and two others', [others[0], ash, others[1]])]);
  const since = say(convo, 'wren', 'a teammate and two others');
  const card = await cardFor(convo, since);
  assert.deepStrictEqual([card.request.helpers, card.request.helper_others], [[{ agent: 'ash', task: task(ash) }], 2]);
  answerCard(card, false);
  await answersOf_([ash, ...others]);
});

test('a first batch\'s card for teammates alone carries helper_others 0', async () => {
  helpers();
  const convo = open('helpers-others-none');
  const calls = [agentCall('ash'), agentCall('example-research-lead')];
  h.writeScenario([messageRule('wren', 'two teammates, no others', calls)]);
  const since = say(convo, 'wren', 'two teammates, no others');
  const card = await cardFor(convo, since);
  assert.strictEqual(card.request.helper_others, 0);
  assert.strictEqual(card.request.helpers.length, 2);
  answerCard(card, false);
  await answersOf_(calls);
});

// What a window that connects now is sent for a pending card.
async function replayed(card) {
  const other = await h.connect();
  try {
    const { msg } = await other.waitFor((m) => m.type === 'control_request' && m.request_id === card.request_id, { label: 'the replayed card' });
    return msg;
  } finally {
    other.close();
  }
}

test('a pending Allow card replayed on reconnect keeps helpers and helper_others', async () => {
  helpers();
  const convo = open('helpers-replay');
  const ash = agentCall('ash');
  const explore = agentCall('Explore');
  h.writeScenario([messageRule('wren', 'replay the allow card', [ash, explore])]);
  const since = say(convo, 'wren', 'replay the allow card');
  const card = await cardFor(convo, since);
  const again = await replayed(card);
  assert.deepStrictEqual(again.request.helpers, card.request.helpers);
  assert.strictEqual(again.request.helper_others, 1);
  assert.deepStrictEqual([again._agent, again._conversationId, again.request.tool_name], ['wren', convo, 'Agent']);
  assert.ok(!('_helper' in again), 'the lead\'s own card names no helper');
  answerCard(card, false);
  await answersOf_([ash, explore]);
});

test('a pending helper\'s card replayed on reconnect keeps _helper', async () => {
  helpers();
  const convo = open('helper-replay');
  const command = `node tools/build.js --step ${++seq}`;
  const since = client.messages.length;
  const asked = ask(bash(command, convo, { agent_id: 'agent-r1', agent_type: 'Explore' }), { headers: h.hookHeaders(convo, 'wren') });
  assert.ok(await h.waitUntil(() => client.messages.slice(since).some((m) => m.type === 'control_request' && m.request.input.command === command), { timeout: 10000 }), 'a card');
  const card = client.messages.slice(since).find((m) => m.type === 'control_request' && m.request.input.command === command);
  const again = await replayed(card);
  assert.deepStrictEqual(again._helper, { agentId: 'agent-r1', agentType: 'Explore' });
  assert.deepStrictEqual(again._helper, card._helper, 'as the first delivery named it');
  assert.ok(!('helpers' in again.request), 'an ordinary card carries no teammates');
  answerCard(card, false);
  await asked.reply;
});

test('a lone teammate call sent to the background is a helper under the first batch\'s card; Deny names it back and keeps no yes, and the next batch asks again', async () => {
  helpers();
  const convo = open('helpers-background');
  const first = agentCall('ash', { background: true });
  const retry = agentCall('ash', { background: true });
  h.writeScenario([
    messageRule('wren', 'background first', [first]),
    messageRule('wren', 'background retry', [retry]),
  ]);
  const since = say(convo, 'wren', 'background first');
  const card = await cardFor(convo, since);
  assert.deepStrictEqual(card.request.helpers, [{ agent: 'ash', task: task(first) }]);
  answerCard(card, false);
  assert.deepStrictEqual(await answersOf_([first]), [refused(DENIED)], 'Deny is named back in the person\'s words');
  await turnDone(convo, since);
  assert.strictEqual(allowedLeads(convo), undefined, 'a no is never kept as a yes');
  assert.strictEqual(invocations('ash', convo).length, 0, 'nobody took over');

  const again = say(convo, 'wren', 'background retry');
  const second = await cardFor(convo, again);
  assert.deepStrictEqual(second.request.helpers, [{ agent: 'ash', task: task(retry) }], 'after a no, the next batch asks again');
  answerCard(second, true);
  assert.deepStrictEqual(await answersOf_([retry]), [allowed(true)]);
  assert.deepStrictEqual(allowedLeads(convo), ['wren']);
});

test('built-in helpers alone start with no card and do not count as a yes', async () => {
  helpers();
  const convo = open('helpers-builtin');
  const one = agentCall('Explore');
  const two = [agentCall('Explore'), agentCall('Plan')];
  h.writeScenario([
    messageRule('wren', 'one built-in', [one]),
    messageRule('wren', 'two built-ins', two),
  ]);
  const since = say(convo, 'wren', 'one built-in');
  assert.deepStrictEqual(await answersOf_([one]), [allowed(false)], 'a lone built-in starts');
  await turnDone(convo, since);
  const again = say(convo, 'wren', 'two built-ins');
  assert.deepStrictEqual(await answersOf_(two), [allowed(false), allowed(false)], 'two built-ins start');
  await turnDone(convo, again);
  assert.strictEqual(agentCards(convo, since).length, 0, 'no card');
  assert.strictEqual(allowedLeads(convo), undefined, 'and the lead is not counted as allowed');
  assert.strictEqual(helpers().stateOf(convo).latest.kind, 'helpers');
});

test('a teammate and a built-in are helpers: the card names the teammate only, and the built-in waits on it too', async () => {
  helpers();
  const convo = open('helpers-mixed');
  const ash = agentCall('ash');
  const explore = agentCall('Explore');
  h.writeScenario([messageRule('wren', 'teammate and built-in', [explore, ash])]);
  const since = say(convo, 'wren', 'teammate and built-in');
  const card = await cardFor(convo, since);
  assert.deepStrictEqual(card.request.helpers, [{ agent: 'ash', task: task(ash) }], 'the card names teammates only');
  await h.delay(300);
  assert.strictEqual(hookAnswer(explore.id), null, 'the built-in waits on the card as well');
  answerCard(card, true);
  assert.deepStrictEqual(await answersOf_([explore, ash]), [allowed(true), allowed(true)]);
});

test('a call naming the lead itself is refused beside an Ash call, which is placed as a helper', async () => {
  helpers();
  const convo = open('helpers-self');
  const self = agentCall('wren');
  const ash = agentCall('ash');
  h.writeScenario([messageRule('wren', 'self and ash', [self, ash])]);
  const since = say(convo, 'wren', 'self and ash');
  const card = await cardFor(convo, since);
  assert.deepStrictEqual(card.request.helpers, [{ agent: 'ash', task: task(ash) }], 'only Ash is on the card');
  assert.deepStrictEqual(await answersOf_([self]), [refused(SELF)], 'the self call is named back at once, with its reason');
  answerCard(card, true);
  assert.deepStrictEqual(await answersOf_([ash]), [allowed(true)]);
  assert.strictEqual(invocations('ash', convo).length, 0, 'Ash runs as a helper, not a handoff');
});

// By design this passes before helpers existed too: a lone teammate call was
// always a handoff and still is. Its sibling below, "the hook request of a
// lone teammate call is held until the lead has ended", fails without helpers.
test('a lone teammate call without background hands over to that teammate, as it always has', async () => {
  const convo = open('helpers-handoff');
  const brief = `handoff brief ${++seq}`;
  const lone = agentCall('ash', { prompt: brief });
  h.writeScenario([
    messageRule('wren', 'hand to ash', [lone], { asks: false }),
    { match: { agent: 'ash', promptIncludes: brief }, turn: [{ text: 'Taking it from here.' }] },
  ]);
  say(convo, 'wren', 'hand to ash');
  assert.ok(await h.waitUntil(() => invocations('ash', convo).length === 1, { timeout: 15000 }), 'Ash took over');
  const wren = invocations('wren', convo);
  assert.strictEqual(wren.length, 1);
  assert.ok(await h.waitForPidExit(wren[0].pid, 8000), 'the lead was ended for the handoff');
});

test('the hook request of a lone teammate call is held until the lead has ended, then answered no with no card', async () => {
  helpers();
  const convo = open('helpers-handoff-hook');
  const brief = `handoff hook brief ${++seq}`;
  const lone = agentCall('ash', { prompt: brief });
  h.writeScenario([
    messageRule('wren', 'hand over and ask', [lone], { asks: false }),
    { match: { agent: 'ash', promptIncludes: brief }, turn: [{ text: 'Taking it from here.' }] },
  ]);
  await withMatchWait(15000, async () => {
    // Asked before the message has even started: the request waits for it.
    const asked = askAgent(convo, 'wren', lone);
    const since = say(convo, 'wren', 'hand over and ask');
    const reply = await asked.reply;
    assert.deepStrictEqual(reply.body, { allow: false }, 'the handoff\'s own call never starts');
    const wren = invocations('wren', convo);
    assert.ok(wren.length === 1 && !h.pidAlive(wren[0].pid), 'answered once the lead had ended');
    assert.strictEqual(agentCards(convo, since).length, 0, 'no card');
    assert.strictEqual(helpers().stateOf(convo).latest.kind, 'handoff');
  });
});

test('a lone teammate call in a new request after a batch has ended is a handoff', async () => {
  helpers();
  const convo = open('helpers-then-handoff');
  const batch = [agentCall('Explore'), agentCall('Plan')];
  const brief = `later handoff brief ${++seq}`;
  const lone = agentCall('ash', { prompt: brief });
  h.writeScenario([
    messageRule('wren', 'batch first', batch),
    messageRule('wren', 'then hand over', [lone], { asks: false }),
    { match: { agent: 'ash', promptIncludes: brief }, turn: [{ text: 'Taking it from here.' }] },
  ]);
  const since = say(convo, 'wren', 'batch first');
  await answersOf_(batch);
  await turnDone(convo, since);
  say(convo, 'wren', 'then hand over');
  assert.ok(await h.waitUntil(() => invocations('ash', convo).length === 1, { timeout: 15000 }), 'Ash took over');
  assert.strictEqual(helpers().stateOf(convo).latest.kind, 'handoff');
});

test('a lone call that names no teammate of the lead exactly is refused through the hook with its reason, and nobody takes over', async () => {
  helpers();
  const cases = [
    [agentCall('sky'), OTHER_LEAD],
    [agentCall('Rowan'), INEXACT],
    [agentCall('Example-Research-Lead'), INEXACT],
    [agentCall(null, { description: 'Hand this to Rowan' }), GENERAL],
  ];
  for (const [lone, notice] of cases) {
    const convo = open('helpers-lone-refused');
    const words = `lone call ${lone.id}`;
    h.writeScenario([messageRule('wren', words, [lone])]);
    const since = say(convo, 'wren', words);
    assert.deepStrictEqual(await answersOf_([lone]), [refused(notice)], `${lone.id} is refused with its reason`);
    await turnDone(convo, since);
    assert.strictEqual(helpers().stateOf(convo).latest.kind, 'helpers', `${lone.id} is not a handoff`);
    assert.strictEqual(agentCards(convo, since).length, 0, 'no card');
    const wren = invocations('wren', convo);
    assert.ok(wren.length === 1 && h.pidAlive(wren[0].pid), 'the lead was not ended');
    for (const agent of ['ash', 'example-research-lead', 'sky']) {
      assert.strictEqual(invocations(agent, convo).length, 0, `${agent} did not take over`);
    }
  }
});

// ---------------------------------------------------------------------------
// Undo: timeout and Stop
// ---------------------------------------------------------------------------

test('a card nobody answers times out: every call of the batch is refused with the hook\'s timeout words, and no yes is kept', async () => {
  helpers();
  const convo = open('helpers-timeout');
  const calls = [agentCall('ash'), agentCall('Explore')];
  h.writeScenario([messageRule('wren', 'nobody answers', calls)]);
  const since = say(convo, 'wren', 'nobody answers');
  const card = await cardFor(convo, since);
  const answers = await answersOf_(calls, TIMEOUT_MS + 15000);
  const words = refusalNotice('timeout', 'Agent', { unattended: false });
  assert.deepStrictEqual(answers, [refused(words), refused(words)], 'each call is told the card timed out');
  assert.ok(client.messages.some((m) => m.type === 'permission_timeout' && m.requestId === card.request_id), 'the window is told the card timed out');
  assert.strictEqual(allowedLeads(convo), undefined);
});

// By design this passes before helpers existed too: it is today's card timeout
// for an ordinary call through the hook. Its sibling above, "a card nobody
// answers times out ...", is the same timeout for a batch of helpers and fails
// without helpers.
test('an ordinary card nobody answers is refused through the hook with its timeout words', async () => {
  const convo = open('helpers-bash-timeout');
  const command = `node tools/build.js --step ${++seq}`;
  const since = client.messages.length;
  const { runHook } = require('../helpers/permission-route.js');
  const said = await runHook('Bash', { command }, { convo });
  assert.deepStrictEqual(said, refused(refusalNotice('timeout', 'Bash', { unattended: false })));
  assert.ok(client.messages.slice(since).some((m) => m.type === 'permission_timeout'), 'the window is told the card timed out');
});

test('Stop while the card waits ends the lead, nothing starts, and no yes is kept', async () => {
  helpers();
  const convo = open('helpers-stop');
  const calls = [agentCall('ash'), agentCall('example-research-lead')];
  h.writeScenario([messageRule('wren', 'stop me', calls)]);
  const since = say(convo, 'wren', 'stop me');
  const card = await cardFor(convo, since);
  const placement = helpers().stateOf(convo).latest;
  client.send({ type: 'cancel', conversationId: convo });
  assert.deepStrictEqual(await placement.answer, { allow: false, reason: 'cancelled' }, 'the batch is answered no');
  assert.ok(await h.waitUntil(() => client.messages.some((m) => m.type === 'permission_ended' && m.requestId === card.request_id && m.reason === 'cancelled'), { timeout: 5000 }), 'the card is taken down');
  const wren = invocations('wren', convo);
  assert.ok(await h.waitForPidExit(wren[0].pid, 8000), 'the lead was ended');
  for (const c of calls) {
    const said = hookAnswer(c.id);
    assert.ok(!said || said.permissionDecision === 'deny', `nothing started: ${JSON.stringify(said)}`);
  }
  assert.deepStrictEqual([invocations('ash', convo).length, invocations('example-research-lead', convo).length], [0, 0]);
  assert.strictEqual(allowedLeads(convo), undefined);
});

// ---------------------------------------------------------------------------
// The yes, per lead, kept with the conversation
// ---------------------------------------------------------------------------

test('after a handover to Ash, Ash\'s first batch asks once, as Ash', async () => {
  helpers();
  const convo = open('helpers-handover');
  const first = [agentCall('ash'), agentCall('example-research-lead')];
  const brief = `handover brief ${++seq}`;
  const lone = agentCall('ash', { prompt: brief });
  const ashBatch = [agentCall('sky'), agentCall('Explore')];
  h.writeScenario([
    messageRule('wren', 'wren batch', first),
    messageRule('wren', 'over to ash', [lone], { asks: false }),
    messageRule('ash', brief, ashBatch),
  ]);
  const since = say(convo, 'wren', 'wren batch');
  answerCard(await cardFor(convo, since), true);
  await answersOf_(first);
  await turnDone(convo, since);
  assert.deepStrictEqual(allowedLeads(convo), ['wren']);

  const handed = say(convo, 'wren', 'over to ash');
  const card = await cardFor(convo, handed);
  assert.strictEqual(card._agent, 'ash', 'Ash asks, as Ash');
  assert.deepStrictEqual(card.request.helpers, [{ agent: 'sky', task: task(ashBatch[0]) }]);
  answerCard(card, true);
  assert.deepStrictEqual(await answersOf_(ashBatch), [allowed(true), allowed(true)]);
  assert.strictEqual(agentCards(convo, handed).length, 1, 'one card for Ash\'s batch');
  assert.deepStrictEqual(allowedLeads(convo), ['wren', 'ash'], 'each lead\'s yes is its own');
});

test('a reopened conversation does not ask again for a lead the person allowed', async () => {
  helpers();
  const convo = open('helpers-reopen');
  const first = [agentCall('ash'), agentCall('example-research-lead')];
  const later = [agentCall('ash'), agentCall('example-research-lead')];
  h.writeScenario([
    messageRule('wren', 'before closing', first),
    messageRule('wren', 'after reopening', later),
  ]);
  const since = say(convo, 'wren', 'before closing');
  answerCard(await cardFor(convo, since), true);
  await answersOf_(first);
  await turnDone(convo, since);
  const [gone] = invocations('wren', convo);
  h.reapConvo(convo);
  assert.ok(await h.waitForPidExit(gone.pid, 8000), 'the lead process is gone');

  const reopened = say(convo, 'wren', 'after reopening');
  assert.deepStrictEqual(await answersOf_(later), [allowed(false), allowed(false)], 'the batch starts with no card');
  const now = invocations('wren', convo);
  assert.strictEqual(now.length, 2, 'a new lead process');
  assert.notStrictEqual(now[1].pid, gone.pid);
  assert.strictEqual(agentCards(convo, reopened).length, 0);
});

test('a window that saves helpersAllowed itself changes nothing: the first batch still asks', async () => {
  helpers();
  const convo = open('helpers-forged');
  const since = client.messages.length;
  client.send({ type: 'save_conversation', conversation: { id: convo, agentId: 'wren', title: 'Forged', helpersAllowed: ['wren'] } });
  assert.ok(await h.waitUntil(() => record(convo), { timeout: 5000 }), 'the conversation was saved');
  assert.strictEqual(allowedLeads(convo), undefined, 'the saved list is not taken from the window');
  const calls = [agentCall('ash'), agentCall('example-research-lead')];
  h.writeScenario([messageRule('wren', 'after the forged save', calls)]);
  say(convo, 'wren', 'after the forged save');
  const card = await cardFor(convo, since);
  answerCard(card, false);
  assert.deepStrictEqual(await answersOf_(calls), [refused(DENIED), refused(DENIED)]);
  assert.strictEqual(allowedLeads(convo), undefined);
});

test('a yes given before the conversation has a transcript or a saved record is kept when the list is loaded, and the next batch has no card', async () => {
  const m = helpers();
  const convo = open('helpers-yes-unsaved');
  // Placed as the engine places a lead's message when it ends. Nothing has
  // been said in this conversation, so it has no transcript.
  const first = [agentCall('ash'), agentCall('example-research-lead')];
  m.placeMessage(convo, { agentId: 'wren' }, first);
  const since = client.messages.length;
  const asked = first.map((c) => askAgent(convo, 'wren', c));
  answerCard(await cardFor(convo, since), true);
  for (const a of asked) assert.deepStrictEqual((await a.reply).body, { allow: true, card: true });
  assert.ok(!fs.existsSync(path.join(h.workspaceDir, '.rundock', 'transcripts', `${convo}.json`)), 'no transcript');
  assert.deepStrictEqual(record(convo), { id: convo, helpersAllowed: ['wren'] }, 'the record holds only the yes');

  const listed = client.messages.length;
  client.send({ type: 'get_conversations' });
  await client.waitFor((x) => x.type === 'conversations', { since: listed, label: 'conversations' });
  assert.deepStrictEqual(allowedLeads(convo), ['wren'], 'loading the list keeps the yes');

  // Opened again: a new lead process, whose batch starts with no card.
  const later = [agentCall('ash'), agentCall('example-research-lead')];
  h.writeScenario([messageRule('wren', 'after the list was loaded', later)]);
  const again = say(convo, 'wren', 'after the list was loaded');
  assert.deepStrictEqual(await answersOf_(later), [allowed(false), allowed(false)], 'the next batch starts without a card');
  await turnDone(convo, again);
  assert.strictEqual(agentCards(convo, since).length, 1, 'only the first batch asked');
});

test('a saved always-allow for Agent still raises the card for a batch of teammates', async () => {
  const m = helpers();
  const convo = open('helpers-always');
  const calls = [agentCall('ash'), agentCall('example-research-lead')];
  h.writeScenario([messageRule('wren', 'placed, not asked', calls, { asks: false })]);
  const since = say(convo, 'wren', 'placed, not asked');
  await turnDone(convo, since);
  assert.ok(await h.waitUntil(() => !guard.answerFilesWatched(config.getWorkspace()), { timeout: 5000 }), 'no other turn is running');
  const turn = guard.acquireAnswerFileGuard(config.getWorkspace(), () => {}, { intervalMs: HOUR, convoId: convo });
  const toolAllows = async (type, settled) => {
    const at = client.messages.length;
    client.send({ type, key: 'Agent' });
    await client.waitFor((x) => x.type === 'tool_allows' && settled(x.tools), { since: at, label: `${type} Agent` });
  };
  try {
    await toolAllows('add_tool_allow', (tools) => tools.includes('Agent'));
    // The saved answer is live: with helpers off, it answers an Agent call.
    m.HELPERS_ENABLED = false;
    try {
      const control = await askAgent(convo, 'wren', agentCall('ash')).reply;
      assert.deepStrictEqual(control.body, { allow: true, reason: 'always-allowed' }, 'the saved answer is in force');
    } finally { m.HELPERS_ENABLED = true; }
    const at = client.messages.length;
    const asked = calls.map((c) => askAgent(convo, 'wren', c));
    const card = await cardFor(convo, at);
    assert.deepStrictEqual(card.request.helpers.map((x) => x.agent), ['ash', 'example-research-lead'], 'the card is raised all the same');
    answerCard(card, true);
    for (const a of asked) assert.deepStrictEqual((await a.reply).body, { allow: true, card: true });
  } finally {
    m.HELPERS_ENABLED = true;
    turn.release();
    await toolAllows('remove_tool_allow', (tools) => !tools.includes('Agent'));
  }
});

// ---------------------------------------------------------------------------
// Matching a hook request to the lead's message
// ---------------------------------------------------------------------------

async function assertUnmatched(convo, reply, since) {
  assert.deepStrictEqual((await reply).body, { allow: false, notice: UNMATCHED });
  assert.strictEqual(agentCards(convo, since).length, 0, 'no card');
  assert.strictEqual(pendingIn(convo).length, 0, 'nothing waits on the person');
}

test('a request with no tool_use_id is refused as unmatched, with no card', async () => {
  helpers();
  const convo = open('match-none');
  const since = client.messages.length;
  await assertUnmatched(convo, askAgent(convo, 'wren', null, { tool_input: agentCall('ash').input }).reply, since);
});

test('a request whose id is in no message of the lead is refused as unmatched once the wait is over', async () => {
  helpers();
  const convo = open('match-nowhere');
  // The lead has a message with an Agent call, just not this one.
  const placed = agentCall('Explore');
  h.writeScenario([messageRule('wren', 'some other call', [placed], { asks: false })]);
  const since = say(convo, 'wren', 'some other call');
  await turnDone(convo, since);
  assert.deepStrictEqual(helpers().stateOf(convo).latest.ids, [placed.id]);
  await withMatchWait(300, async () => {
    const started = Date.now();
    await assertUnmatched(convo, askAgent(convo, 'wren', agentCall('ash')).reply, since);
    assert.ok(Date.now() - started >= 250, 'it waited for the message first');
  });
});

test('a second request for an id already answered is refused as unmatched', async () => {
  helpers();
  const convo = open('match-twice');
  const explore = agentCall('Explore');
  h.writeScenario([messageRule('wren', 'answered once', [explore])]);
  const since = say(convo, 'wren', 'answered once');
  assert.deepStrictEqual(await answersOf_([explore]), [allowed(false)]);
  await turnDone(convo, since);
  await assertUnmatched(convo, askAgent(convo, 'wren', explore).reply, since);
});

test('a request for an id from an earlier message is refused as unmatched; one that arrives before its message waits for it', async () => {
  helpers();
  const convo = open('match-earlier');
  const earlier = agentCall('Explore');
  const current = agentCall('Plan');
  // The test asks the hook for the current call itself, so the stub writes
  // that call as raw lines and asks the hook for nothing. Claude Code starts a
  // helper only once the hook allows it, and the lead's request ends once the
  // helper has reported back: here the stub starts and ends it once the test
  // has seen the answer, and the lead wakes to say so. Without that, an allowed
  // call that never starts holds the request open whenever its answer lands
  // before the lead's result.
  const allowedFile = path.join(h.workspaceDir, `allowed-${current.id}`);
  const helperLines = [
    fx.taskStarted({ taskId: `task_${current.id}`, toolUseId: current.id, description: current.input.description, subagentType: 'Plan' }),
    fx.taskNotification({ taskId: `task_${current.id}`, toolUseId: current.id }),
  ];
  h.writeScenario([
    messageRule('wren', 'earlier message', [earlier], { asks: false }),
    { match: { agent: 'wren', promptIncludes: 'current message' }, helpers: true,
      turn: [{ text: 'On it.' }, ...fx.toolUseFlow('Agent', current.input, 1, current.id).map((raw) => ({ raw }))],
      then: [{ untilFile: allowedFile, lines: helperLines, turn: [{ text: 'The plan is in.' }] }] },
  ]);
  const since = say(convo, 'wren', 'earlier message');
  await turnDone(convo, since);
  await withMatchWait(15000, async () => {
    const early = askAgent(convo, 'wren', current);
    await h.delay(200);
    const next = say(convo, 'wren', 'current message');
    assert.deepStrictEqual((await early.reply).body, { allow: true }, 'the early request is answered by its message');
    fs.writeFileSync(allowedFile, '');
    const { index } = await client.waitFor((m) => m.type === 'result' && m._conversationId === convo && m.result === 'The plan is in.',
      { since: next, timeout: 20000, label: 'the lead woke once its helper reported back' });
    await turnDone(convo, index);
  });
  await assertUnmatched(convo, askAgent(convo, 'wren', earlier).reply, since);
});

// The stub opens no message with message_start; Claude Code does, and these
// tests write it where Claude Code would.
const messageBegins = { raw: { type: 'stream_event', event: { type: 'message_start', message: { role: 'assistant' } } } };

test('once the lead begins another message with no Agent calls, a request for a call from the message before is refused as unmatched', async () => {
  helpers();
  const convo = open('match-after-words');
  const earlier = agentCall('Explore');
  h.writeScenario([
    { match: { agent: 'wren', promptIncludes: 'a call nobody asks for' }, turn: [messageBegins, { text: 'On it.' }, { agentTool: earlier.input, id: earlier.id }] },
    { match: { agent: 'wren', promptIncludes: 'just words now' }, turn: [messageBegins, { text: 'Nothing to hand out.' }] },
  ]);
  const since = say(convo, 'wren', 'a call nobody asks for');
  await turnDone(convo, since);
  const next = say(convo, 'wren', 'just words now');
  await turnDone(convo, next);
  await assertUnmatched(convo, askAgent(convo, 'wren', earlier).reply, since);
});

test('once the lead begins another message with Agent calls, a request for a call from the message before is refused as unmatched before that message ends', async () => {
  helpers();
  const convo = open('match-after-calls');
  const earlier = agentCall('Explore');
  const later = agentCall('Plan');
  const hold = path.join(h.workspaceDir, `release-${++seq}`);
  h.writeScenario([
    { match: { agent: 'wren', promptIncludes: 'first call, never asked' }, turn: [messageBegins, { text: 'On it.' }, { agentTool: earlier.input, id: earlier.id }] },
    { match: { agent: 'wren', promptIncludes: 'second call, held' }, turn: [messageBegins, { text: 'Starting the next part.' }, { agentTool: later.input, id: later.id }, { holdUntil: hold }] },
  ]);
  const since = say(convo, 'wren', 'first call, never asked');
  await turnDone(convo, since);
  const next = say(convo, 'wren', 'second call, held');
  await client.waitFor((m) => m.type === 'stream_event' && m._conversationId === convo && m.event && m.event.type === 'content_block_delta',
    { since: next, label: 'the second message has begun' });
  try {
    await assertUnmatched(convo, askAgent(convo, 'wren', earlier).reply, since);
  } finally {
    fs.writeFileSync(hold, '');
  }
  await turnDone(convo, next);
});

// ---------------------------------------------------------------------------
// Routines, and calls made inside a helper
// ---------------------------------------------------------------------------

test('a routine\'s Agent call starts as it always has: no card and no helper state', async () => {
  helpers();
  const hold = path.join(h.workspaceDir, `release-${++seq}`);
  const explore = agentCall('Explore');
  const since = client.messages.length;
  const run = startRoutine('wren', { untilFile: hold, helpers: true, turn: [{ agentTool: explore.input, id: explore.id }, { text: 'done' }] }, 'helpers-routine');
  let token = null;
  assert.ok(await h.waitUntil(() => {
    const started = h.readInvocations().find((i) => i.agent === 'wren' && i.print && !i.env.RUNDOCK_CONVO_ID && i.env.RUNDOCK_HOOK_TOKEN);
    token = started ? started.env.RUNDOCK_HOOK_TOKEN : null;
    return token;
  }, { timeout: 15000 }), 'the run started');
  const direct = await ask({ tool_name: 'Agent', tool_input: explore.input, tool_use_id: 'toolu_routine_direct' }, { headers: { [auth.HOOK_HEADER]: token } }).reply;
  assert.deepStrictEqual(direct.body, { allow: true, reason: 'routine' }, 'the route answers a run\'s Agent call as a routine\'s');
  fs.writeFileSync(hold, '');
  const done = await finished(run);
  assert.deepStrictEqual(answersOf(done).filter((a) => a && a.permissionDecision), [allowed(false)], 'through the hook, the call starts');
  assert.strictEqual(client.messages.slice(since).filter((m) => m.type === 'control_request').length, 0, 'no card');
  assert.strictEqual(helpers().stateOf(''), undefined, 'no helper state');
});

test('a helper\'s own call raises today\'s card, which names the helper and stays filed under the lead', async () => {
  helpers();
  const convo = open('helper-card');
  const command = `node tools/build.js --step ${++seq}`;
  const since = client.messages.length;
  const asked = ask(bash(command, convo, { agent_id: 'agent-a1', agent_type: 'Ash' }), { headers: h.hookHeaders(convo, 'wren') });
  assert.ok(await h.waitUntil(() => client.messages.slice(since).some((m) => m.type === 'control_request' && m.request.input.command === command), { timeout: 10000 }), 'a card');
  const card = client.messages.slice(since).find((m) => m.type === 'control_request' && m.request.input.command === command);
  assert.deepStrictEqual(card._helper, { agentId: 'agent-a1', agentType: 'Ash' }, 'the card names the helper');
  assert.strictEqual(card._agent, 'wren', 'and stays the token\'s agent, whatever the helper\'s type says');
  answerCard(card, false);
  assert.deepStrictEqual((await asked.reply).body, { allow: false });

  // A field that is not a string names no helper.
  const plain = `node tools/build.js --step ${++seq}`;
  const at = client.messages.length;
  const other = ask(bash(plain, convo, { agent_id: 7 }), { headers: h.hookHeaders(convo, 'wren') });
  assert.ok(await h.waitUntil(() => client.messages.slice(at).some((m) => m.type === 'control_request' && m.request.input.command === plain), { timeout: 10000 }));
  const second = client.messages.slice(at).find((m) => m.type === 'control_request' && m.request.input.command === plain);
  assert.ok(!('_helper' in second), 'no _helper');
  answerCard(second, false);
  await other.reply;
});

test('a helper\'s Agent call is never in the lead\'s batch, and its hook request is refused at once', async () => {
  const m = helpers();
  const convo = open('helper-agent');
  const lead = agentCall('Explore');
  const inner = agentCall('ash');
  const json = JSON.stringify(inner.input);
  const line = (event) => ({ raw: { type: 'stream_event', parent_tool_use_id: lead.id, event } });
  h.writeScenario([messageRule('wren', 'a helper calls ash', [lead], {
    asks: false,
    extra: [
      line({ type: 'message_start', message: { role: 'assistant' } }),
      line({ type: 'content_block_start', index: 7, content_block: { type: 'tool_use', id: inner.id, name: 'Agent' } }),
      line({ type: 'content_block_delta', index: 7, delta: { type: 'input_json_delta', partial_json: json } }),
      line({ type: 'content_block_stop', index: 7 }),
      line({ type: 'message_stop' }),
    ],
  })]);
  const since = say(convo, 'wren', 'a helper calls ash');
  await turnDone(convo, since);
  const latest = m.stateOf(convo).latest;
  assert.deepStrictEqual(latest.ids, [lead.id], 'only the lead\'s own call is in its batch');
  assert.strictEqual(invocations('ash', convo).length, 0, 'the helper\'s call handed nothing over');
  const reply = await askAgent(convo, 'wren', inner, { agent_id: 'agent-b2', agent_type: 'Explore' }).reply;
  assert.deepStrictEqual(reply.body, { allow: false, notice: FROM_HELPER });
  assert.strictEqual(agentCards(convo, since).length, 0, 'no card');
});
