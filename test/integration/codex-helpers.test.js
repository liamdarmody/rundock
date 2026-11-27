'use strict';
// CODEX HELPERS: ROWS.
//
// A Codex lead's turn can start helpers, each a thread of its own on the
// shared app-server. With helpers on, every helper the lead starts is a row in
// the conversation's helper list, named and counted while it runs, and its
// own turn never touches the lead's. Upkeep threads Codex runs for itself are
// never rows. A routine, which nobody watches, never shows rows.
//
// The team: Fern leads on Codex; Ash and Rowan (agent name
// example-research-lead) report to Fern. Sky, also on Codex, can take over a
// conversation from Fern.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const h = require('../helpers/harness.js');
const { agentFile } = require('../helpers/workspace.js');

const HELPERS = path.join(__dirname, '..', '..', 'lib', 'delegation', 'helpers.js');
function helpers() {
  assert.ok(fs.existsSync(HELPERS), 'lib/delegation/helpers.js exists');
  return require(HELPERS);
}
const glue = () => require('../../lib/runtime/codex-glue.js');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let client;
before(async () => {
  await h.boot({
    agents: {
      fern: agentFile({ name: 'fern', displayName: 'Fern', role: 'Lead', order: 1, runtime: 'codex', body: 'You are Fern.' }),
      ash: agentFile({ name: 'ash', displayName: 'Ash', order: 2, reportsTo: 'fern' }),
      'example-research-lead': agentFile({ name: 'example-research-lead', displayName: 'Rowan', order: 3, reportsTo: 'fern' }),
      sky: agentFile({ name: 'sky', displayName: 'Sky', order: 4, runtime: 'codex', reportsTo: 'fern', body: 'You are Sky.' }),
    },
    env: { RUNDOCK_PERMISSION_TIMEOUT_MS: '1500' },
  });
  h.internal.stopScheduler();
  helpers().HELPERS_ENABLED = true;
  client = await h.connect();
});

// Every helper held on a file is let go after its test, so no turn outlives it.
const holds = new Set();
function hold(tag) {
  const file = path.join(h.workspaceDir, `hold-${tag}-${process.pid}`);
  holds.add(file);
  return file;
}
const release = (file) => fs.writeFileSync(file, 'go');
const opened = new Set();
afterEach(() => {
  for (const file of holds) if (!fs.existsSync(file)) release(file);
  holds.clear();
  for (const convo of opened) h.reapConvo(convo);
  opened.clear();
});
after(async () => {
  if (fs.existsSync(HELPERS)) require(HELPERS).HELPERS_ENABLED = false;
  for (const file of holds) if (!fs.existsSync(file)) release(file);
  await h.delay(200);
  await h.shutdown();
});

function open(prefix) {
  const convo = h.freshConvoId(prefix);
  opened.add(convo);
  return convo;
}
const sayAs = (agent, convo, words) => {
  const since = client.messages.length;
  client.send({ type: 'chat', conversationId: convo, agent, content: words });
  return since;
};
const say = (convo, words) => sayAs('fern', convo, words);
const turnDone = (convo, since) => client.waitForEvent('system', 'done', convo, { since, timeout: 20000 });
const changes = (convo, since = 0) => client.messages.slice(since).filter((m) => m.type === 'helpers_changed' && m._conversationId === convo);
const rowNamed = (m, name) => (m.helpers || []).find((r) => r.agent === name);
// The first helpers_changed from `since` on whose rows pass `pred`.
const rowsWhere = (convo, since, pred, label) => client.waitFor(
  (m) => m.type === 'helpers_changed' && m._conversationId === convo && pred(m.helpers || [], m),
  { since, timeout: 15000, label });
const stateOf = (rows, name) => (rows.find((r) => r.agent === name) || {}).state;

test('a helper Fern starts is a row on Fern\'s list, named, counted while it runs and not once it completes', async () => {
  const convo = open('cxrow');
  const gate = hold('row');
  h.writeCodexScenario([{
    match: { promptIncludes: 'ROW-ONE' }, text: 'Fern on it.',
    helpers: [{ nickname: 'rates', role: 'worker', untilFile: gate, items: [{ type: 'commandExecution', command: 'ls rates' }] }],
  }]);
  assert.strictEqual(typeof helpers().codexHelper, 'function', 'helpers.js exports codexHelper');
  const since = say(convo, 'ROW-ONE please');
  // The activity item comes first, so the row is named from its path; the
  // helper's thread/started then adds its role.
  const { msg } = await rowsWhere(convo, since, (rows) => rows.some((r) => r.agent === 'rates' && r.role === 'worker' && r.state === 'running'), 'the rates row, running, with its role');
  assert.strictEqual(msg.agentId, 'fern', 'the list is Fern\'s');
  const row = rowNamed(msg, 'rates');
  const { firstBatch, ...rest } = row;
  assert.match(rest.toolUseId, UUID_RE, 'the row is keyed by the helper\'s thread id');
  assert.deepStrictEqual(rest, {
    toolUseId: rest.toolUseId, agent: 'rates', kind: 'codex', role: 'worker', task: null,
    state: 'running', step: null, file: null, capped: false,
  });
  assert.strictEqual(firstBatch, true, 'the first helper Fern starts in the conversation is her first batch');
  assert.strictEqual(helpers().runningCount(convo), 1, 'a running helper is counted');

  release(gate);
  const { msg: doneMsg } = await rowsWhere(convo, since, (rows) => stateOf(rows, 'rates') === 'completed', 'the rates row, completed');
  assert.strictEqual(rowNamed(doneMsg, 'rates').toolUseId, row.toolUseId, 'the same row ends');
  assert.strictEqual(helpers().runningCount(convo), 0, 'a completed helper is not counted');
  const stepped = changes(convo, since).map((m) => rowNamed(m, 'rates')).find((r) => r && r.step);
  assert.deepStrictEqual(stepped && stepped.step, { type: 'commandExecution', detail: 'ls rates' }, 'the row showed what it was running');
  await turnDone(convo, since);
});

test('a helper whose own turn fails ends failed and stops being counted', async () => {
  const convo = open('cxfail');
  h.writeCodexScenario([{
    match: { promptIncludes: 'FAIL-ONE' }, text: 'Fern waited.', awaitHelpers: true,
    helpers: [{ nickname: 'pipeline', status: 'failed' }],
  }]);
  const since = say(convo, 'FAIL-ONE please');
  await rowsWhere(convo, since, (rows) => stateOf(rows, 'pipeline') === 'failed', 'the pipeline row, failed');
  assert.strictEqual(helpers().runningCount(convo), 0);
  await turnDone(convo, since);
});

test('a helper still running when Fern\'s turn ends keeps its row and count, and gets its end state later', async () => {
  const convo = open('cxlate');
  const gate = hold('late');
  h.writeCodexScenario([{
    match: { promptIncludes: 'LATE-ONE' }, text: 'Fern is done for now.',
    helpers: [{ nickname: 'deck', untilFile: gate }],
  }]);
  const since = say(convo, 'LATE-ONE please');
  await turnDone(convo, since);
  const last = changes(convo, since).pop();
  assert.strictEqual(stateOf(last.helpers, 'deck'), 'running', 'the row still runs after Fern\'s turn');
  assert.strictEqual(helpers().runningCount(convo), 1);
  release(gate);
  await rowsWhere(convo, since, (rows) => stateOf(rows, 'deck') === 'completed', 'the deck row, completed after Fern\'s turn');
  assert.strictEqual(helpers().runningCount(convo), 0, 'and the count comes down');
});

test('a helper given more work after it completed runs and is counted again', async () => {
  const convo = open('cxagain');
  const gate = hold('again');
  h.writeCodexScenario([{
    match: { promptIncludes: 'AGAIN-ONE' }, text: 'Fern sent more.',
    helpers: [{ nickname: 'hooks', again: { untilFile: gate } }],
  }]);
  const since = say(convo, 'AGAIN-ONE please');
  const { index } = await rowsWhere(convo, since, (rows) => stateOf(rows, 'hooks') === 'completed', 'the hooks row, completed');
  assert.strictEqual(helpers().runningCount(convo), 0);
  release(gate);
  await rowsWhere(convo, index + 1, (rows) => stateOf(rows, 'hooks') === 'running', 'the hooks row, running again');
  await rowsWhere(convo, index + 1, (rows) => stateOf(rows, 'hooks') === 'completed', 'the hooks row, completed again');
  const rows = changes(convo, since).pop().helpers.filter((r) => r.agent === 'hooks');
  assert.strictEqual(rows.length, 1, 'still one row for the helper');
});

test('an upkeep thread announced after its activity item is withdrawn from the list and the count', async () => {
  const convo = open('cxupkeep');
  const gate = hold('upkeep');
  h.writeCodexScenario([{
    match: { promptIncludes: 'UPKEEP-LATE' }, text: 'Fern tidied.',
    helpers: [{ nickname: 'rates', untilFile: gate }, { nickname: 'tidy', source: 'review', untilFile: gate }],
  }]);
  const since = say(convo, 'UPKEEP-LATE please');
  const { index } = await rowsWhere(convo, since, (rows) => stateOf(rows, 'tidy') === 'running', 'the tidy row before it is proven upkeep');
  const { msg } = await rowsWhere(convo, index + 1, (rows) => !rows.some((r) => r.agent === 'tidy'), 'the list without tidy');
  assert.strictEqual(stateOf(msg.helpers, 'rates'), 'running', 'the real helper stays');
  assert.strictEqual(helpers().runningCount(convo), 1, 'only the real helper is counted');
  release(gate);
  await rowsWhere(convo, since, (rows) => stateOf(rows, 'rates') === 'completed', 'the rates row, completed');
  assert.ok(!changes(convo, index + 1).some((m) => rowNamed(m, 'tidy')), 'tidy never comes back');
});

test('an upkeep thread announced before its activity item is never a row', async () => {
  const convo = open('cxupfirst');
  h.writeCodexScenario([{
    match: { promptIncludes: 'UPKEEP-FIRST' }, text: 'Fern tidied.', awaitHelpers: true,
    helpers: [{ nickname: 'tidy', source: 'memory_consolidation', threadStartedFirst: true }, { nickname: 'rates' }],
  }]);
  const since = say(convo, 'UPKEEP-FIRST please');
  await turnDone(convo, since);
  const seen = changes(convo, since);
  assert.ok(seen.some((m) => rowNamed(m, 'rates')), 'the real helper beside it is a row');
  assert.ok(!seen.some((m) => rowNamed(m, 'tidy')), 'the upkeep thread never is');
  assert.strictEqual(helpers().runningCount(convo), 0);
});

test('helpers nicknamed like teammates stay Codex helpers and hand nothing over', async () => {
  const convo = open('cxmates');
  h.writeCodexScenario([{
    match: { promptIncludes: 'MATES-ONE' }, text: 'Fern kept it in house.', awaitHelpers: true,
    helpers: [{ nickname: 'ash' }, { nickname: 'example-research-lead' }],
  }]);
  const since = say(convo, 'MATES-ONE please');
  const { msg } = await client.waitFor((m) => m.type === 'result' && m._conversationId === convo, { since, timeout: 20000, label: 'Fern\'s result' });
  assert.strictEqual(msg._agent, 'fern', 'Fern answers');
  await turnDone(convo, since);
  const last = changes(convo, since).pop();
  for (const name of ['ash', 'example-research-lead']) {
    const row = rowNamed(last, name);
    assert.ok(row, `a row named ${name}`);
    assert.strictEqual(row.kind, 'codex', `${name} is a Codex helper, not a teammate`);
  }
  assert.strictEqual(h.readInvocations().filter((i) => i.bin === 'claude' && i.env && i.env.RUNDOCK_CONVO_ID === convo).length, 0, 'no teammate was started');
});

test('with helpers on, a Fern turn that starts none sends no helper list', async () => {
  const quiet = open('cxquiet');
  const busy = open('cxbusy');
  h.writeCodexScenario([
    { match: { promptIncludes: 'QUIET-ONE' }, text: 'Fern alone.' },
    { match: { promptIncludes: 'BUSY-ONE' }, text: 'Fern with one.', awaitHelpers: true, helpers: [{ nickname: 'calendar' }] },
  ]);
  let since = say(quiet, 'QUIET-ONE please');
  await turnDone(quiet, since);
  assert.deepStrictEqual(changes(quiet, since), [], 'no helpers_changed without helper events');
  since = say(busy, 'BUSY-ONE please');
  await turnDone(busy, since);
  assert.ok(changes(busy, since).length > 0, 'the same turn with a helper does send one');
});

test('a Codex routine that starts a helper shows no rows, and the helper\'s approval is declined at once', async () => {
  // By design this passes before helpers existed too. Its sibling, "a helper
  // Fern starts is a row on Fern's list, named, counted while it runs and not
  // once it completes", fails without helpers.
  h.clearInvocations();
  h.writeCodexScenario([{
    match: { promptIncludes: 'routine with a helper' }, text: 'routine done.', awaitHelpers: true,
    helpers: [{ nickname: 'inbox', approval: { command: 'rm -rf build' } }],
  }]);
  const since = client.messages.length;
  const agent = h.internal.discoverAgents().find((a) => a.id === 'fern');
  h.internal.executeRoutine(agent, { name: 'helper-routine', schedule: 'every day at 09:00', prompt: 'routine with a helper' }, 'codex-helper-routine');
  assert.ok(await h.waitUntil(() => h.readInvocations().some((i) => i.approvalDecision != null), { timeout: 20000 }), 'the helper asked');
  const decisions = h.readInvocations().filter((i) => i.approvalDecision != null);
  assert.deepStrictEqual(decisions.map((d) => d.approvalDecision), ['decline'], 'declined at once');
  assert.ok(decisions[0].threadId, 'on the helper\'s own thread');
  await h.delay(300);
  assert.deepStrictEqual(client.messages.slice(since).filter((m) => m.type === 'helpers_changed' || m.type === 'control_request'), [], 'no rows and no card');
});

test('rows work the same on codex-cli 0.144.3 and 0.156.1', async () => {
  for (const version of ['0.156.1', '0.144.3']) {
    const convo = open('cxver');
    h.writeCodexScenario([{
      match: { promptIncludes: 'VERSION-ONE' }, text: 'Fern on this version.', awaitHelpers: true,
      helpers: [{ nickname: 'rates' }],
    }], { version });
    glue().shutdownCodexAppServer();
    const since = say(convo, `VERSION-ONE on ${version}`);
    await rowsWhere(convo, since, (rows) => stateOf(rows, 'rates') === 'completed', `the rates row on ${version}`);
    assert.strictEqual((await glue().getCodexAppServer()).version(), version, `the app-server reported ${version}`);
    await turnDone(convo, since);
  }
});

test('with helpers on, no feature flag or agent setting reaches the app-server', async () => {
  h.clearInvocations();
  const convo = open('cxflags');
  h.writeCodexScenario([{ match: { promptIncludes: 'FLAGS-ONE' }, text: 'Fern plain.', awaitHelpers: true, helpers: [{ nickname: 'rates' }] }]);
  glue().shutdownCodexAppServer();
  const since = say(convo, 'FLAGS-ONE please');
  await turnDone(convo, since);
  const spawns = h.readInvocations().filter((i) => i.mode === 'app-server' && i.event === 'spawn');
  assert.ok(spawns.length >= 1, 'the app-server was started in this test');
  for (const s of spawns) assert.doesNotMatch(JSON.stringify(s.argv), /features|multi_agent|agents/, 'nothing in the argv');
  const starts = h.readInvocations().filter((i) => i.mode === 'app-server' && (i.method === 'thread/start' || i.method === 'thread/resume'));
  assert.ok(starts.length >= 1);
  for (const s of starts) assert.doesNotMatch(JSON.stringify(s.params), /features|multi_agent|"agents"/, 'nothing in the thread params');
});

// WHAT THE WINDOW DOES WITH A FERN REPLY: it scans the reply, sends the first
// DELEGATE marker back as a delegate message, and the server answers. These
// tests pin that the answer is the same with helper events as without them.
const { scanMarkers } = require('../../public/markers.js');
const invocations = (agent, convo) => h.readInvocations().filter((i) => i.agent === agent && i.env && i.env.RUNDOCK_CONVO_ID === convo);
async function delegateOutcome(convo, words) {
  const since = say(convo, words);
  const { msg: result } = await client.waitFor((m) => m.type === 'result' && m._conversationId === convo, { since, timeout: 20000, label: 'Fern\'s result' });
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
    page: client.messages.slice(after).filter((m) => m._conversationId === convo && m.type !== 'helpers_changed')
      .map((m) => [m.type, m.subtype || null, typeof m.content === 'string' ? m.content : null]),
  };
}

// By design this passes before helpers existed too. Its sibling, "a helper
// Fern starts is a row on Fern's list, named, counted while it runs and not
// once it completes", fails without helpers.
test('with helpers on, Fern\'s DELEGATE markers name the first agent and get the same answer as a reply with no helpers', async () => {
  const cases = [
    { tag: 'one', brief: 'ON-DELEGATE-ONE brief', reply: 'Bringing in Ash.\n<!-- RUNDOCK:DELEGATE agent=ash -->\nON-DELEGATE-ONE brief\n<!-- /RUNDOCK:DELEGATE -->' },
    { tag: 'two', brief: 'ON-DELEGATE-TWO brief', reply: 'Bringing in two.\n<!-- RUNDOCK:DELEGATE agent=ash -->\nON-DELEGATE-TWO brief\n<!-- /RUNDOCK:DELEGATE -->\n<!-- RUNDOCK:DELEGATE agent=example-research-lead -->\nON-DELEGATE-TWO other\n<!-- /RUNDOCK:DELEGATE -->' },
  ];
  for (const c of cases) {
    const seen = [];
    for (const withHelpers of [false, true]) {
      const convo = open(`cxdel-${c.tag}${withHelpers ? '-h' : ''}`);
      h.writeCodexScenario([{
        match: { promptIncludes: `on delegate ${c.tag}` }, text: c.reply, awaitHelpers: withHelpers,
        helpers: withHelpers ? [{ nickname: 'ash' }, { nickname: 'rates' }] : [],
      }]);
      h.writeScenario([{ match: { agent: 'ash', promptIncludes: c.brief }, turn: [{ text: 'Ash took it.' }] }]);
      seen.push(await delegateOutcome(convo, `on delegate ${c.tag}`));
    }
    assert.deepStrictEqual(seen[0].delegation, { targetAgent: 'ash', context: c.brief }, `${c.tag}: the first marker names Ash`);
    assert.strictEqual(seen[0].rowan, 0, `${c.tag}: Rowan did not start`);
    assert.deepStrictEqual(seen[1], seen[0], `${c.tag}: the same answer, helper events or not`);
  }
});

// A HELPER'S APPROVALS. A helper's request that needs a card raises it on
// Fern's turn, naming the helper; the answer goes back on the helper's own
// request, and any line after it onto the helper's own turn.
const { refusalNotice, approvalNotice } = require('../../scripts/refusal-notice.js');
const SHELL = process.platform === 'win32' ? 'PowerShell' : 'Bash';
const decisions = () => h.readInvocations().filter((i) => i.approvalDecision != null);
const appServer = (method) => h.readInvocations().filter((i) => i.mode === 'app-server' && i.method === method);
const fernThread = () => appServer('turn/start')[0].params.threadId;
const cards = (convo, since) => client.messages.slice(since).filter((m) => m.type === 'control_request' && m._conversationId === convo);
const cardAfter = (convo, since) => client.waitFor((m) => m.type === 'control_request' && m._conversationId === convo, { since, timeout: 15000, label: 'a card' });
const answer = (convo, card, allow, extra = {}) => client.send({ type: 'permission_response', requestId: card.request_id, conversationId: convo, allow, ...extra });
async function decidedOn(threadId, n = 1) {
  await h.waitUntil(() => decisions().filter((d) => d.threadId === threadId).length >= n, { timeout: 15000 });
  return decisions().filter((d) => d.threadId === threadId).map((d) => d.approvalDecision);
}
// Fern starts rates, which asks to run a command; by default Fern's turn
// waits for rates to end. `lead` adds to Fern's rule, `config` to the stub's.
async function ratesAsks(convo, tag, { approval = {}, lead = {}, rates = {}, more = [], config } = {}) {
  h.clearInvocations();
  h.writeCodexScenario([{
    match: { promptIncludes: tag }, text: 'Fern heard from rates.', awaitHelpers: true, ...lead,
    helpers: [{ nickname: 'rates', ...rates, approval: { command: 'rm -rf build', reason: 'clear the old build', ...approval } }],
  }, ...more], config);
  const since = say(convo, `${tag} please`);
  const { msg: card } = await cardAfter(convo, since);
  return { since, card };
}

test('a helper\'s approval raises a card on Fern\'s turn naming the helper, and Allow answers accept on the helper\'s request', async () => {
  const convo = open('cxallow');
  const { since, card } = await ratesAsks(convo, 'ALLOW-ONE');
  assert.strictEqual(card._agent, 'fern', 'the card is on Fern');
  assert.ok(card._helper, 'the card names a helper');
  assert.match(card._helper.agentId, UUID_RE);
  assert.deepStrictEqual(card._helper, { agentId: card._helper.agentId, agentType: 'rates' });
  assert.strictEqual(card.request.tool_name, SHELL);
  assert.strictEqual(card.request.input.command, 'rm -rf build');
  const row = rowNamed(changes(convo, since).pop(), 'rates');
  assert.strictEqual(card._helper.agentId, row.toolUseId, 'the same helper as its row');
  assert.deepStrictEqual(decisions(), [], 'nothing answered before the person does');
  answer(convo, card, true);
  assert.deepStrictEqual(await decidedOn(card._helper.agentId), ['accept']);
  await turnDone(convo, since);
  assert.strictEqual(cards(convo, since).length, 1, 'one card');
});

test('Deny on a helper\'s card answers decline on the helper\'s request', async () => {
  const convo = open('cxdeny');
  const { since, card } = await ratesAsks(convo, 'DENY-ONE');
  answer(convo, card, false);
  assert.deepStrictEqual(await decidedOn(card._helper.agentId), ['decline']);
  await turnDone(convo, since);
});

test('a helper\'s card left to its time limit answers decline on the helper\'s request', async () => {
  const convo = open('cxtimeout');
  const { since, card } = await ratesAsks(convo, 'TIMEOUT-ONE');
  await client.waitFor((m) => m.type === 'permission_timeout' && m.requestId === card.request_id, { since, timeout: 10000, label: 'the time limit' });
  assert.deepStrictEqual(await decidedOn(card._helper.agentId), ['decline']);
  await turnDone(convo, since);
});

test('cancelling the conversation answers a helper\'s card with cancel on the helper\'s request', async () => {
  const convo = open('cxcancel');
  const { since, card } = await ratesAsks(convo, 'CANCEL-ONE');
  client.send({ type: 'cancel', conversationId: convo });
  assert.deepStrictEqual(await decidedOn(card._helper.agentId), ['cancel']);
  await client.waitForEvent('system', 'done', convo, { since, timeout: 15000 });
});

test('after Deny, the refusal line is steered onto the helper\'s own turn, never Fern\'s', async () => {
  const convo = open('cxrefuse');
  const { since, card } = await ratesAsks(convo, 'REFUSE-ONE', { approval: { awaitSteerMs: 4000 } });
  answer(convo, card, false);
  await turnDone(convo, since);
  const steers = appServer('turn/steer');
  assert.deepStrictEqual(steers.map((s) => [s.params.threadId, s.params.input]), [[card._helper.agentId, [{ type: 'text', text: refusalNotice('denied', SHELL) }]]]);
  assert.ok(steers[0].params.expectedTurnId, 'bound to the helper\'s turn');
  assert.ok(!steers.some((s) => s.params.threadId === fernThread()), 'nothing steered onto Fern');
});

test('after the time limit, the refusal line is steered onto the helper\'s own turn', async () => {
  const convo = open('cxlimit');
  const { since, card } = await ratesAsks(convo, 'LIMIT-ONE', { approval: { awaitSteerMs: 4000 } });
  await turnDone(convo, since);
  assert.deepStrictEqual(appServer('turn/steer').map((s) => [s.params.threadId, s.params.input[0].text]), [[card._helper.agentId, refusalNotice('timeout', SHELL)]]);
});

test('after Allow on a card, the approval line is steered onto the helper\'s own turn, never Fern\'s', async () => {
  const convo = open('cxnotice');
  const { since, card } = await ratesAsks(convo, 'NOTICE-ONE', { approval: { awaitSteerOnAcceptMs: 4000 } });
  answer(convo, card, true, { card: true });
  await turnDone(convo, since);
  assert.deepStrictEqual(appServer('turn/steer').map((s) => [s.params.threadId, s.params.input[0].text]), [[card._helper.agentId, approvalNotice(SHELL)]]);
});

test('a helper\'s refusal line that cannot be steered is dropped, never carried into Fern\'s next turn', async () => {
  const convo = open('cxdrop');
  const { since, card } = await ratesAsks(convo, 'DROP-ONE', {
    more: [{ match: { promptIncludes: 'DROP-NEXT' }, text: 'Fern again.' }], config: { noSteer: true },
  });
  answer(convo, card, false);
  await turnDone(convo, since);
  assert.ok(appServer('turn/steer').length >= 1, 'a steer was tried');
  const next = say(convo, 'DROP-NEXT please');
  await turnDone(convo, next);
  const prompts = h.codexTurnPrompts();
  assert.strictEqual(prompts.length, 2, 'Fern\'s next turn ran');
  assert.ok(!prompts[1].includes(refusalNotice('denied', SHELL)), 'the line was not queued for Fern');
});

test('a helper\'s card still up when Fern\'s turn ends is declined on the helper\'s request', async () => {
  const convo = open('cxleadend');
  const gate = hold('leadend');
  const { since, card } = await ratesAsks(convo, 'LEADEND-ONE', { lead: { awaitHelpers: false, untilFile: gate } });
  release(gate);
  await turnDone(convo, since);
  assert.deepStrictEqual(await decidedOn(card._helper.agentId), ['decline']);
});

test('a helper\'s approval with no Fern turn running is declined at once and raises no card', async () => {
  const convo = open('cxnolead');
  const gate = hold('nolead');
  h.clearInvocations();
  h.writeCodexScenario([{
    match: { promptIncludes: 'NOLEAD-ONE' }, text: 'Fern is done.',
    helpers: [{ nickname: 'rates', untilFile: gate, approval: { command: 'rm -rf build' } }],
  }]);
  const since = say(convo, 'NOLEAD-ONE please');
  await turnDone(convo, since);
  const { msg } = await rowsWhere(convo, since, (rows) => stateOf(rows, 'rates') === 'running', 'the rates row');
  release(gate);
  assert.deepStrictEqual(await decidedOn(rowNamed(msg, 'rates').toolUseId), ['decline']);
  await h.delay(300);
  assert.deepStrictEqual(cards(convo, since), [], 'no card');
});

test('a helper\'s own helper\'s approval is declined at once with no card, beside the helper\'s that raises one', async () => {
  const convo = open('cxdeep');
  const { since, card } = await ratesAsks(convo, 'DEEP-ONE', { rates: { depth2: { approval: { command: 'rm -rf deeper' } } } });
  const deep = decisions().filter((d) => d.threadId !== card._helper.agentId);
  assert.deepStrictEqual(deep.map((d) => d.approvalDecision), ['decline'], 'the deeper helper was declined before rates asked');
  assert.strictEqual(card._helper.agentType, 'rates', 'the one card is rates\'');
  answer(convo, card, true);
  await turnDone(convo, since);
  assert.strictEqual(cards(convo, since).length, 1, 'one card in all');
});

test('after Deny, the helper\'s next request raises a new card', async () => {
  const convo = open('cxretry');
  const gate = hold('retry');
  const { since, card } = await ratesAsks(convo, 'RETRY-ONE', {
    lead: { awaitHelpers: false, untilFile: gate },
    rates: { again: { approval: { command: 'rm -rf build/cache' } } },
  });
  answer(convo, card, false);
  const { msg: second } = await client.waitFor((m) => m.type === 'control_request' && m._conversationId === convo && m.request_id !== card.request_id,
    { since, timeout: 15000, label: 'a second card' });
  assert.deepStrictEqual(second._helper, card._helper, 'the same helper asks again');
  assert.strictEqual(second.request.input.command, 'rm -rf build/cache');
  answer(convo, second, true);
  assert.deepStrictEqual(await decidedOn(card._helper.agentId, 2), ['decline', 'accept']);
  release(gate);
  await turnDone(convo, since);
});

// THE CAP. At most five helpers run at once in a conversation. A Codex helper
// is running before Rundock hears of it, so a sixth is stopped: it gets no
// row or count, its turn is interrupted, its row is shown stopped, Fern reads
// why and the refusal is recorded.
const CAP_LINE = (name) => `Rundock stopped the helper ${name}: at most five helpers run at once. Wait for these to report back, then start the rest.`;
const FIVE = ['rates', 'pipeline', 'deck', 'hooks', 'calendar'];
const fiveOn = (gate) => FIVE.map((nickname) => ({ nickname, untilFile: gate }));
const running = (rows) => rows.filter((r) => r.state === 'running').length;
const maxRunning = (convo, since) => Math.max(0, ...changes(convo, since).map((m) => running(m.helpers || [])));
const stopped = (name) => (rows) => rows.some((r) => r.agent === name && r.capped);
function capEvents(convo) {
  const dir = path.join(h.workspaceDir, '.rundock', 'state');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /^events-\d{4}-\d{2}\.jsonl$/.test(f)); } catch (e) { return []; }
  const out = [];
  for (const f of files) {
    for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) if (l.trim()) out.push(JSON.parse(l));
  }
  return out.filter((e) => e.e === 'helper_cap' && e.conv === convo);
}
// The app-server's own request time limit, shortened for `fn`.
async function withRequestLimit(ms, fn) {
  const server = await glue().getCodexAppServer();
  const prev = server._requestTimeoutMs;
  server._requestTimeoutMs = ms;
  try { return await fn(); } finally { server._requestTimeoutMs = prev; }
}

test('a sixth helper is stopped: no row or count, then interrupted, its row shown stopped, Fern steered with one line and the refusal recorded, and nothing more reaches the person', async () => {
  const convo = open('cxcap');
  const gate = hold('cap');
  h.clearInvocations();
  h.writeCodexScenario([
    { match: { promptIncludes: 'CAP-ONE' }, text: 'Fern waits.', awaitHelpers: true, helpers: [...fiveOn(gate), { nickname: 'inbox', holdForInterrupt: true }] },
    { match: { promptIncludes: 'CAP-NEXT' }, text: 'Fern again.' },
  ]);
  const since = say(convo, 'CAP-ONE please');
  const { msg } = await rowsWhere(convo, since, stopped('inbox'), 'the inbox row, stopped');
  const inbox = rowNamed(msg, 'inbox');
  assert.deepStrictEqual([inbox.state, inbox.capped], ['killed', true]);
  assert.deepStrictEqual(msg.helpers.filter((r) => r.capped).map((r) => r.agent), ['inbox'], 'only the inbox is shown stopped');
  assert.ok(msg.helpers.every((r) => r.firstBatch === true), 'all six are Fern\'s first batch, the stopped one included');
  assert.strictEqual(running(msg.helpers), 5, 'the five run on');
  assert.ok(!changes(convo, since).some((m) => stateOf(m.helpers || [], 'inbox') === 'running'), 'the inbox never ran on the list');
  assert.strictEqual(maxRunning(convo, since), 5, 'never more than five counted');
  assert.ok(await h.waitUntil(() => appServer('turn/steer').length === 1), 'Fern was steered');
  const calls = h.readInvocations().filter((i) => i.mode === 'app-server' && ['turn/interrupt', 'turn/steer'].includes(i.method));
  assert.deepStrictEqual(calls.map((i) => i.method), ['turn/interrupt', 'turn/steer'], 'interrupted, then steered');
  assert.strictEqual(calls[0].params.threadId, inbox.toolUseId, 'the inbox\'s own turn was interrupted');
  assert.ok(calls[0].params.turnId, 'by its turn id');
  assert.deepStrictEqual([calls[1].params.threadId, calls[1].params.input], [fernThread(), [{ type: 'text', text: CAP_LINE('inbox') }]]);
  assert.ok(await h.waitUntil(() => capEvents(convo).length === 1), 'the refusal was recorded');
  assert.deepStrictEqual(capEvents(convo).map((e) => [e.agent, e.d]), [['fern', { outcome: 'refused' }]]);
  release(gate);
  await turnDone(convo, since);
  const page = client.messages.slice(since).filter((m) => m._conversationId === convo);
  assert.ok(!page.some((m) => m.type === 'control_request' || m.type === 'error'), 'no card and no error');
  assert.ok(!JSON.stringify(page).includes('Rundock stopped the helper'), 'the line reached Fern alone');
  const next = say(convo, 'CAP-NEXT please');
  await turnDone(convo, next);
  assert.ok(!h.codexTurnPrompts()[1].includes(CAP_LINE('inbox')), 'said once: not again in Fern\'s next turn');
  assert.strictEqual(capEvents(convo).length, 1);
});

test('when a sixth helper\'s interrupt is refused, it runs and is counted, with no line and no event', async () => {
  const convo = open('cxcapfail');
  const gate = hold('capfail');
  h.clearInvocations();
  h.writeCodexScenario([{ match: { promptIncludes: 'CAPFAIL-ONE' }, text: 'Fern waits.', awaitHelpers: true,
    helpers: [...fiveOn(gate), { nickname: 'inbox', untilFile: gate, interruptFails: true }] }]);
  const since = say(convo, 'CAPFAIL-ONE please');
  const { msg } = await rowsWhere(convo, since, (rows) => stateOf(rows, 'inbox') === 'running', 'the inbox row, running');
  assert.strictEqual(rowNamed(msg, 'inbox').capped, false);
  assert.strictEqual(running(msg.helpers), 6, 'six counted');
  assert.strictEqual(appServer('turn/interrupt').length, 1, 'the interrupt was tried');
  release(gate);
  await turnDone(convo, since);
  await h.delay(200);
  assert.deepStrictEqual(appServer('turn/steer'), [], 'no line');
  assert.deepStrictEqual(capEvents(convo), [], 'no event');
  assert.strictEqual(stateOf(changes(convo, since).pop().helpers, 'inbox'), 'completed');
});

test('when a sixth helper\'s interrupt is never answered, it runs and is counted once the request times out, with no line and no event', async () => {
  const convo = open('cxcapdrop');
  const gate = hold('capdrop');
  await withRequestLimit(1000, async () => {
    h.clearInvocations();
    h.writeCodexScenario([{ match: { promptIncludes: 'CAPDROP-ONE' }, text: 'Fern waits.', awaitHelpers: true,
      helpers: [...fiveOn(gate), { nickname: 'inbox', untilFile: gate, dropInterrupt: true }] }]);
    const since = say(convo, 'CAPDROP-ONE please');
    assert.ok(await h.waitUntil(() => appServer('turn/interrupt').length === 1), 'the interrupt was sent');
    const sent = Date.now();
    const { msg } = await rowsWhere(convo, since, (rows) => stateOf(rows, 'inbox') === 'running', 'the inbox row, running');
    assert.ok(Date.now() - sent >= 500, 'not before the request timed out');
    assert.strictEqual(running(msg.helpers), 6, 'six counted');
    release(gate);
    await turnDone(convo, since);
    await h.delay(200);
    assert.deepStrictEqual(appServer('turn/steer'), [], 'no line');
    assert.deepStrictEqual(capEvents(convo), [], 'no event');
  });
});

test('when Fern cannot be steered, the line about a stopped helper is put in her next turn', async () => {
  const convo = open('cxcapq');
  const gate = hold('capq');
  h.clearInvocations();
  h.writeCodexScenario([
    { match: { promptIncludes: 'CAPQ-ONE' }, text: 'Fern waits.', awaitHelpers: true, helpers: [...fiveOn(gate), { nickname: 'inbox', holdForInterrupt: true }] },
    { match: { promptIncludes: 'CAPQ-NEXT' }, text: 'Fern again.' },
  ], { noSteer: true });
  const since = say(convo, 'CAPQ-ONE please');
  await rowsWhere(convo, since, stopped('inbox'), 'the inbox row, stopped');
  assert.ok(await h.waitUntil(() => appServer('turn/steer').length === 1), 'a steer was tried');
  release(gate);
  await turnDone(convo, since);
  const next = say(convo, 'CAPQ-NEXT please');
  await turnDone(convo, next);
  const prompts = h.codexTurnPrompts();
  assert.ok(!prompts[0].includes(CAP_LINE('inbox')));
  assert.ok(prompts[1].includes(CAP_LINE('inbox')), 'the line is in Fern\'s next turn');
});

test('while five run from an earlier turn, a helper Fern starts in a later turn is stopped and she reads why in that turn', async () => {
  const convo = open('cxcaplater');
  const gate = hold('caplater');
  h.clearInvocations();
  h.writeCodexScenario([
    { match: { promptIncludes: 'LATER-ONE' }, text: 'Five started.', helpers: fiveOn(gate) },
    { match: { promptIncludes: 'LATER-TWO' }, text: 'Fern waits.', awaitHelpers: true, helpers: [{ nickname: 'inbox', holdForInterrupt: true }] },
  ]);
  const first = say(convo, 'LATER-ONE please');
  await turnDone(convo, first);
  assert.strictEqual(helpers().runningCount(convo), 5, 'five still run');
  const since = say(convo, 'LATER-TWO please');
  await rowsWhere(convo, since, stopped('inbox'), 'the inbox row, stopped');
  assert.ok(await h.waitUntil(() => appServer('turn/steer').length === 1), 'Fern was steered');
  const laterTurn = appServer('turn/start').at(-1).params.threadId;
  assert.deepStrictEqual(appServer('turn/steer').map((s) => [s.params.threadId, s.params.input[0].text]), [[laterTurn, CAP_LINE('inbox')]], 'onto the turn that started it');
  assert.strictEqual(maxRunning(convo, first), 5);
  release(gate);
  await turnDone(convo, since);
});

test('after a helper is stopped and one of the five ends, Fern can start it again and it runs', async () => {
  const convo = open('cxcapretry');
  const gate = hold('capretry');
  const ratesGate = hold('capretry-rates');
  const leadGate = hold('capretry-lead');
  h.clearInvocations();
  h.writeCodexScenario([
    { match: { promptIncludes: 'RETRYCAP-ONE' }, text: 'Fern waits.', untilFile: leadGate,
      helpers: [{ nickname: 'rates', untilFile: ratesGate }, ...fiveOn(gate).slice(1), { nickname: 'inbox', holdForInterrupt: true }] },
    { match: { promptIncludes: 'RETRYCAP-TWO' }, text: 'Fern again.', awaitHelpers: true, helpers: [{ nickname: 'inbox' }] },
  ]);
  const first = say(convo, 'RETRYCAP-ONE please');
  await rowsWhere(convo, first, stopped('inbox'), 'the inbox row, stopped');
  release(leadGate);
  await turnDone(convo, first);
  release(ratesGate);
  await rowsWhere(convo, first, (rows) => stateOf(rows, 'rates') === 'completed', 'rates done');
  const since = say(convo, 'RETRYCAP-TWO please');
  const { msg } = await rowsWhere(convo, since, (rows) => rows.some((r) => r.agent === 'inbox' && r.state === 'running'), 'the new inbox row, running');
  assert.strictEqual(running(msg.helpers), 5, 'five again');
  await turnDone(convo, since);
  assert.strictEqual(appServer('turn/interrupt').length, 1, 'only the first was stopped');
  assert.strictEqual(capEvents(convo).length, 1);
  release(gate);
});

test('two conversations each run five helpers at once', async () => {
  const a = open('cxcapa');
  const b = open('cxcapb');
  const gate = hold('captwo');
  h.clearInvocations();
  h.writeCodexScenario([
    { match: { promptIncludes: 'TWO-A' }, text: 'A waits.', awaitHelpers: true, helpers: fiveOn(gate) },
    { match: { promptIncludes: 'TWO-B' }, text: 'B waits.', awaitHelpers: true, helpers: fiveOn(gate) },
  ]);
  const sa = say(a, 'TWO-A please');
  const sb = say(b, 'TWO-B please');
  await rowsWhere(a, sa, (rows) => running(rows) === 5, 'five in the first');
  await rowsWhere(b, sb, (rows) => running(rows) === 5, 'five in the second');
  assert.deepStrictEqual([helpers().runningCount(a), helpers().runningCount(b)], [5, 5]);
  assert.deepStrictEqual(appServer('turn/interrupt'), [], 'none stopped');
  release(gate);
  await turnDone(a, sa);
  await turnDone(b, sb);
});

test('while five run, a helper given more work is stopped the same way, its row shown stopped', async () => {
  const convo = open('cxcapagain');
  const gate = hold('capagain');
  const againGate = hold('capagain-more');
  const leadGate = hold('capagain-lead');
  h.clearInvocations();
  h.writeCodexScenario([{ match: { promptIncludes: 'AGAIN-ONE' }, text: 'Fern waits.', untilFile: leadGate,
    helpers: [{ nickname: 'rates', again: { untilFile: againGate, holdForInterrupt: true } }, ...fiveOn(gate).slice(1), { nickname: 'inbox', untilFile: gate }] }]);
  const since = say(convo, 'AGAIN-ONE please');
  await rowsWhere(convo, since, (rows) => stateOf(rows, 'rates') === 'completed' && running(rows) === 5, 'rates done, five running');
  release(againGate);
  const { msg } = await rowsWhere(convo, since, stopped('rates'), 'the rates row, stopped');
  assert.strictEqual(stateOf(msg.helpers, 'rates'), 'killed');
  assert.strictEqual(maxRunning(convo, since), 5);
  assert.ok(await h.waitUntil(() => appServer('turn/steer').length === 1), 'Fern was steered');
  assert.strictEqual(appServer('turn/steer')[0].params.input[0].text, CAP_LINE('rates'));
  release(gate);
  release(leadGate);
  await turnDone(convo, since);
});

test('a stopped helper given more work while five still run is stopped again, and Fern reads why again', async () => {
  const convo = open('cxcaptwice');
  const gate = hold('captwice');
  const againGate = hold('captwice-more');
  const leadGate = hold('captwice-lead');
  h.clearInvocations();
  h.writeCodexScenario([{ match: { promptIncludes: 'TWICE-ONE' }, text: 'Fern waits.', untilFile: leadGate,
    helpers: [...fiveOn(gate), { nickname: 'inbox', holdForInterrupt: true, again: { untilFile: againGate, holdForInterrupt: true } }] }]);
  const since = say(convo, 'TWICE-ONE please');
  await rowsWhere(convo, since, stopped('inbox'), 'the inbox row, stopped');
  assert.ok(await h.waitUntil(() => appServer('turn/steer').length === 1), 'Fern was steered');
  release(againGate);
  assert.ok(await h.waitUntil(() => appServer('turn/steer').length === 2), 'Fern was steered again');
  const stops = appServer('turn/interrupt');
  assert.strictEqual(stops.length, 2, 'interrupted again');
  assert.strictEqual(stops[1].params.threadId, stops[0].params.threadId, 'the same helper');
  assert.notStrictEqual(stops[1].params.turnId, stops[0].params.turnId, 'on its new turn');
  assert.deepStrictEqual(appServer('turn/steer').map((s) => s.params.input[0].text), [CAP_LINE('inbox'), CAP_LINE('inbox')]);
  assert.ok(await h.waitUntil(() => capEvents(convo).length === 2), 'each refusal recorded');
  assert.ok(!changes(convo, since).some((m) => stateOf(m.helpers || [], 'inbox') === 'running'), 'the inbox never ran on the list');
  assert.strictEqual(maxRunning(convo, since), 5);
  release(gate);
  release(leadGate);
  await turnDone(convo, since);
});

test('a stopped helper\'s approval is declined at once and raises no card', async () => {
  const convo = open('cxcapask');
  const gate = hold('capask');
  await withRequestLimit(1500, async () => {
    h.clearInvocations();
    h.writeCodexScenario([{ match: { promptIncludes: 'CAPASK-ONE' }, text: 'Fern waits.', untilFile: gate,
      helpers: [...fiveOn(gate), { nickname: 'inbox', dropInterrupt: true, delayMs: 200, approval: { command: 'rm -rf inbox' } }] }]);
    const since = say(convo, 'CAPASK-ONE please');
    assert.ok(await h.waitUntil(() => decisions().length === 1), 'the inbox asked');
    assert.deepStrictEqual(decisions().map((d) => d.approvalDecision), ['decline']);
    assert.strictEqual(decisions()[0].threadId, appServer('turn/interrupt')[0].params.threadId, 'the stopped helper');
    assert.deepStrictEqual(cards(convo, since), [], 'no card');
    await rowsWhere(convo, since, (rows) => !!rowNamed({ helpers: rows }, 'inbox'), 'the inbox row once the request times out');
    release(gate);
    await turnDone(convo, since);
  });
});

// THE FIRST BATCH. Fern starts helpers without asking, so her first helpers
// in a conversation are marked for the page's notice instead of a card: every
// helper started in her first turn that starts any. She is then kept on the
// conversation's record as noticed, and no later batch of hers is marked
// there, the conversation opened again included.
const { readConversations, writeConversations } = require('../../lib/store/persistence.js');
const record = (convo) => readConversations().find((c) => c && c.id === convo);
const plant = (entry) => writeConversations([entry, ...readConversations()]);
const pendingIn = (convo) => [...h.internal.pendingPermissionRequests.values()].filter((p) => p.conversationId === convo);
// Each helper's marks across every list sent from `since` on.
function marksIn(convo, since) {
  const out = {};
  for (const m of changes(convo, since)) for (const r of m.helpers || []) (out[r.agent] = out[r.agent] || new Set()).add(r.firstBatch);
  return Object.fromEntries(Object.entries(out).map(([name, set]) => [name, [...set]]));
}
async function listed() {
  const since = client.messages.length;
  client.send({ type: 'get_conversations' });
  const { msg } = await client.waitFor((m) => m.type === 'conversations', { since, timeout: 10000, label: 'the conversation list' });
  return msg.conversations;
}
// Fern (or `agent`) starts `names` in one turn and waits for them to end.
async function batch(convo, words, agent = 'fern') {
  const since = sayAs(agent, convo, words);
  await turnDone(convo, since);
  return since;
}
const batchRule = (words, names) => ({ match: { promptIncludes: words }, text: 'Done.', awaitHelpers: true, helpers: names.map((nickname) => ({ nickname })) });

test('Fern\'s first batch is every helper started in her first turn that starts any, with no card, and a later turn\'s helpers are not marked', async () => {
  const convo = open('cxfirst');
  h.writeCodexScenario([
    { match: { promptIncludes: 'FIRST-NONE' }, text: 'Nothing to hand on.' },
    batchRule('FIRST-ONE', ['rates', 'pipeline']),
    batchRule('FIRST-TWO', ['deck']),
  ]);
  await batch(convo, 'FIRST-NONE please');
  assert.strictEqual((record(convo) || {}).helpersNoticed, undefined, 'a turn that starts none is not the first batch');
  const one = await batch(convo, 'FIRST-ONE please');
  assert.deepStrictEqual(marksIn(convo, one), { rates: [true], pipeline: [true] });
  assert.deepStrictEqual(cards(convo, 0), [], 'no card');
  assert.deepStrictEqual(pendingIn(convo), [], 'nothing waits for an answer');
  assert.deepStrictEqual(record(convo).helpersNoticed, ['fern'], 'Fern is kept as noticed');
  assert.strictEqual(record(convo).helpersAllowed, undefined, 'apart from the leads allowed');
  const two = await batch(convo, 'FIRST-TWO please');
  assert.deepStrictEqual(marksIn(convo, two).deck, [false], 'a later turn\'s helper is not marked');
  assert.deepStrictEqual(record(convo).helpersNoticed, ['fern'], 'kept once');
});

test('in a conversation opened again, Fern\'s next helpers are not marked', async () => {
  const convo = open('cxfirstreopen');
  h.writeCodexScenario([batchRule('REOPEN-ONE', ['rates']), batchRule('REOPEN-TWO', ['deck'])]);
  const one = await batch(convo, 'REOPEN-ONE please');
  assert.deepStrictEqual(marksIn(convo, one), { rates: [true] });
  h.reapConvo(convo);
  const two = await batch(convo, 'REOPEN-TWO please');
  assert.deepStrictEqual(marksIn(convo, two).deck, [false]);
});

test('a conversation whose record keeps Fern as noticed, as after Rundock restarts, is kept when the list loads and marks none of her helpers', async () => {
  const convo = open('cxfirstrestart');
  plant({ id: convo, helpersNoticed: ['fern'] });
  assert.ok(!(await listed()).some((c) => c.id === convo), 'a record holding only the notice is not listed');
  assert.deepStrictEqual(record(convo), { id: convo, helpersNoticed: ['fern'] }, 'and is kept on disk');
  h.writeCodexScenario([batchRule('RESTART-ONE', ['rates'])]);
  const one = await batch(convo, 'RESTART-ONE please');
  assert.deepStrictEqual(marksIn(convo, one), { rates: [false] });
});

test('a window that saves helpersNoticed itself changes nothing: Fern\'s first batch is still marked, and the list never sends it', async () => {
  const convo = open('cxfirstforged');
  client.send({ type: 'save_conversation', conversation: { id: convo, agentId: 'fern', title: 'Forged', helpersNoticed: ['fern'] } });
  assert.ok(await h.waitUntil(() => record(convo), { timeout: 5000 }), 'the conversation was saved');
  assert.strictEqual(record(convo).helpersNoticed, undefined, 'not taken from the window');
  h.writeCodexScenario([batchRule('FORGED-ONE', ['rates'])]);
  const one = await batch(convo, 'FORGED-ONE please');
  assert.deepStrictEqual(marksIn(convo, one), { rates: [true] });
  assert.deepStrictEqual(record(convo).helpersNoticed, ['fern']);
  client.send({ type: 'save_conversation', conversation: { id: convo, agentId: 'fern', title: 'Saved again', helpersNoticed: [] } });
  assert.ok(await h.waitUntil(() => record(convo).title === 'Saved again', { timeout: 5000 }), 'saved again');
  assert.deepStrictEqual(record(convo).helpersNoticed, ['fern'], 'a later save keeps the server\'s list');
  const shown = (await listed()).find((c) => c.id === convo);
  assert.ok(shown, 'the conversation is listed');
  assert.strictEqual(shown.helpersNoticed, undefined, 'without the list');
});

test('Fern in the leads allowed helpers alone is still marked: being allowed is not being noticed', async () => {
  const convo = open('cxfirstallowed');
  plant({ id: convo, helpersAllowed: ['fern'] });
  h.writeCodexScenario([batchRule('ALLOWED-ONE', ['rates'])]);
  const one = await batch(convo, 'ALLOWED-ONE please');
  assert.deepStrictEqual(marksIn(convo, one), { rates: [true] });
  assert.deepStrictEqual(record(convo), { id: convo, helpersAllowed: ['fern'], helpersNoticed: ['fern'] });
});

test('after Sky takes the conversation over from Fern, Sky\'s first batch is marked once', async () => {
  const convo = open('cxfirstsky');
  h.writeCodexScenario([batchRule('SKY-FERN', ['rates']), batchRule('SKY-ONE', ['deck']), batchRule('SKY-TWO', ['hooks'])]);
  const fern = await batch(convo, 'SKY-FERN please');
  assert.deepStrictEqual(marksIn(convo, fern), { rates: [true] });
  const one = await batch(convo, 'SKY-ONE please', 'sky');
  assert.ok(changes(convo, one).every((m) => m.agentId === 'sky'), 'the list is Sky\'s');
  assert.deepStrictEqual(marksIn(convo, one).deck, [true], 'Sky\'s first batch');
  const two = await batch(convo, 'SKY-TWO please', 'sky');
  assert.deepStrictEqual(marksIn(convo, two).hooks, [false], 'once');
  assert.deepStrictEqual(record(convo).helpersNoticed, ['fern', 'sky']);
  assert.deepStrictEqual(cards(convo, 0), [], 'no card for either');
});

test('when the app-server goes, every running helper row fails and the count is zero', async () => {
  const convo = open('cxcrash');
  const gate = hold('crash');
  h.writeCodexScenario([{
    match: { promptIncludes: 'CRASH-ONE' }, deltas: ['about to go'], crashMidTurn: true,
    helpers: [{ nickname: 'rates', untilFile: gate }, { nickname: 'deck', untilFile: gate }],
  }]);
  const since = say(convo, 'CRASH-ONE please');
  await client.waitForEvent('system', 'codex_error', convo, { since, timeout: 20000 });
  const { msg } = await rowsWhere(convo, since, (rows) => stateOf(rows, 'rates') === 'failed' && stateOf(rows, 'deck') === 'failed', 'both rows, failed');
  assert.strictEqual(msg.helpers.filter((r) => r.state === 'running').length, 0);
  assert.strictEqual(helpers().runningCount(convo), 0);
  await turnDone(convo, since);
});
