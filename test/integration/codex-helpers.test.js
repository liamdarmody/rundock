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
// example-research-lead) report to Fern.
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
const say = (convo, words) => {
  const since = client.messages.length;
  client.send({ type: 'chat', conversationId: convo, agent: 'fern', content: words });
  return since;
};
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
  assert.strictEqual(typeof firstBatch, 'boolean');
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
  assert.ok(await h.waitUntil(() => h.readInvocations().some((i) => i.approvalDecision != null), 20000), 'the helper asked');
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
