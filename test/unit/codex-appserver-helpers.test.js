'use strict';
// A CODEX LEAD'S HELPERS, AS THE PROTOCOL CLIENT HEARS THEM.
//
// A lead's turn can start helpers. Each is a thread of its own on the same
// app-server process: the lead's thread records the start as a
// subAgentActivity item, the helper's thread announces itself with
// thread/started (its source says helper, upkeep or a helper's own helper),
// and the helper then runs turns of its own. A turn started with the
// `helpers` option is told of each helper ('start', 'turn', 'update', 'end',
// 'withdrawn') and nothing a helper says reaches the lead's turn.
//
// Driven over scripted lines: the real client with its transport replaced,
// each server line fed in as the process would deliver it, the requests it
// sends and the answers it writes captured. Wire shapes come from
// test/fixtures/codex-appserver-protocol.js, the same builders the stub uses.
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

const appserver = require('../../codex-appserver.js');
const P = require('../fixtures/codex-appserver-protocol.js');

const LEAD = 'thread-lead';
const LEAD_TURN = 'turn-lead';

// The client with no process: requests are recorded and answered, lines the
// client writes (answers to server requests) are recorded, and server lines
// go in through the same reader the process's stdout feeds.
function newClient() {
  const server = appserver.createCodexAppServer({ binPath: 'codex-not-started', log: () => {} });
  const requests = [];
  const written = [];
  server.request = async (method, params) => {
    requests.push({ method, params });
    return method === 'turn/start' ? { turn: { id: LEAD_TURN } } : {};
  };
  server._writeLine = (obj) => { written.push(obj); return true; };
  return { server, requests, written };
}

function feed(server, ...msgs) {
  server._onData(msgs.map((m) => JSON.stringify(m) + '\n').join(''));
}

// What the handler was told, a copy of the record at the time.
function snap(kind, rec) {
  return { kind, threadId: rec.threadId, name: rec.name, role: rec.role, state: rec.state, turnId: rec.turnId, step: rec.step, file: rec.file };
}

// The lead's turn, with the helpers option unless told otherwise.
async function leadTurn(c, { helpers = true } = {}) {
  const told = [];
  const opts = helpers ? { helpers: (kind, rec) => told.push(snap(kind, rec)) } : {};
  const sub = c.server.startTurn(LEAD, 'start some helpers', opts);
  const events = [];
  sub.on('event', (e) => events.push(e));
  await sub.started;
  return { sub, events, told };
}

// The activity item for a helper starting, as Codex sends it: started, then
// completed, with the same item id.
function activity(threadId, { id = `act-${threadId}`, agentPath = `root/${threadId}`, kind = 'started' } = {}) {
  const spec = { id, agentPath, agentThreadId: threadId, kind };
  return [P.subAgentActivityItem(LEAD, LEAD_TURN, spec, 'started'), P.subAgentActivityItem(LEAD, LEAD_TURN, spec, 'completed')];
}

const kinds = (told, threadId) => told.filter((t) => !threadId || t.threadId === threadId).map((t) => t.kind);

// Asserted before each call, so a module without it fails on that assertion,
// never on a call that throws.
function codexHelper() {
  const helpers = require('../../lib/delegation/helpers.js');
  assert.strictEqual(typeof helpers.codexHelper, 'function', 'helpers.js exports codexHelper');
  return helpers.codexHelper;
}

describe('a lead turn with the helpers option', () => {
  test('the helpers option never reaches the wire: turn/start carries no such field', async () => {
    const c = newClient();
    const { told } = await leadTurn(c);
    feed(c.server, ...activity('h1'));
    assert.deepStrictEqual(kinds(told), ['start'], 'the helper was recorded');
    const start = c.requests.find((r) => r.method === 'turn/start');
    assert.ok(start, 'turn/start was sent');
    assert.ok(!('helpers' in start.params), 'no helpers field on the wire');
  });

  test('a started activity item records a helper once per item id, its name the last part of agentPath until thread/started says more', async () => {
    const c = newClient();
    const { told } = await leadTurn(c);
    feed(c.server, ...activity('h1', { agentPath: 'root/team/rates' }));
    assert.deepStrictEqual(told, [{ kind: 'start', threadId: 'h1', name: 'rates', role: null, state: 'running', turnId: null, step: null, file: null }]);
  });

  test('activity first, then thread/started: the row made first takes the nickname and role when they arrive', async () => {
    const c = newClient();
    const { told } = await leadTurn(c);
    feed(c.server, ...activity('h1', { agentPath: 'root/h1' }));
    feed(c.server, P.subAgentThreadStarted('h1', { nickname: 'rates', role: 'worker', parentThreadId: LEAD }));
    assert.deepStrictEqual(told.map((t) => [t.kind, t.name, t.role]), [['start', 'h1', null], ['update', 'rates', 'worker']]);
  });

  test('thread/started first, then activity: the helper starts with its nickname and role', async () => {
    const c = newClient();
    const { told } = await leadTurn(c);
    feed(c.server, P.subAgentThreadStarted('h1', { nickname: 'rates', role: 'worker', parentThreadId: LEAD }));
    assert.deepStrictEqual(told, [], 'thread/started alone records nothing');
    feed(c.server, ...activity('h1'));
    assert.deepStrictEqual(told.map((t) => [t.kind, t.name, t.role]), [['start', 'rates', 'worker']]);
  });

  test('the nickname is read from the spawn source or from the thread, whichever carries it', async () => {
    const c = newClient();
    const { told } = await leadTurn(c);
    feed(c.server, P.subAgentThreadStarted('h1', { nickname: 'deck', role: 'writer', nicknameIn: 'source' }));
    feed(c.server, P.subAgentThreadStarted('h2', { nickname: 'hooks', role: 'reader', nicknameIn: 'thread' }));
    feed(c.server, ...activity('h1'), ...activity('h2'));
    assert.deepStrictEqual(told.map((t) => [t.threadId, t.name, t.role]), [['h1', 'deck', 'writer'], ['h2', 'hooks', 'reader']]);
  });

  test('a helper whose nickname names a teammate is recorded like any other helper', async () => {
    const c = newClient();
    const { told } = await leadTurn(c);
    feed(c.server, P.subAgentThreadStarted('h1', { nickname: 'ash' }), P.subAgentThreadStarted('h2', { nickname: 'example-research-lead' }));
    feed(c.server, ...activity('h1'), ...activity('h2'));
    assert.deepStrictEqual(told.map((t) => [t.kind, t.name]), [['start', 'ash'], ['start', 'example-research-lead']]);
  });

  test('a thread whose source is other is a helper', async () => {
    const c = newClient();
    const { told } = await leadTurn(c);
    feed(c.server, P.subAgentThreadStarted('h1', { source: 'other' }), ...activity('h1', { agentPath: 'root/pipeline' }));
    assert.deepStrictEqual(told.map((t) => [t.kind, t.name]), [['start', 'pipeline']]);
  });

  for (const source of ['review', 'compact', 'memory_consolidation']) {
    test(`an upkeep thread (${source}) announced before its activity item is never recorded, beside a helper that is`, async () => {
      const c = newClient();
      const { told } = await leadTurn(c);
      feed(c.server, P.subAgentThreadStarted('up', { source }), ...activity('up'));
      feed(c.server, ...activity('h1'));
      assert.deepStrictEqual(told.map((t) => [t.kind, t.threadId]), [['start', 'h1']]);
    });

    test(`an upkeep thread (${source}) announced after its activity item is withdrawn`, async () => {
      const c = newClient();
      const { told } = await leadTurn(c);
      feed(c.server, ...activity('up'));
      feed(c.server, P.subAgentThreadStarted('up', { source }));
      assert.deepStrictEqual(kinds(told, 'up'), ['start', 'withdrawn']);
      // Withdrawn for good: its turns and end tell nothing more.
      feed(c.server, P.turnStarted('up', 'turn-up'), P.turnCompleted('up', 'turn-up', 'completed'));
      assert.deepStrictEqual(kinds(told, 'up'), ['start', 'withdrawn']);
    });
  }

  test("a helper's own helper (depth 2) is never recorded, beside the helper that is", async () => {
    const c = newClient();
    const { told } = await leadTurn(c);
    feed(c.server, P.subAgentThreadStarted('h1', { nickname: 'rates' }), ...activity('h1'), P.turnStarted('h1', 'turn-h1'));
    // Its activity item arrives on the helper's thread, not the lead's.
    feed(c.server, P.subAgentActivityItem('h1', 'turn-h1', { id: 'act-d2', agentPath: 'root/rates/deeper', agentThreadId: 'd2', kind: 'started' }));
    feed(c.server, P.subAgentThreadStarted('d2', { nickname: 'deeper', parentThreadId: 'h1', depth: 2 }), P.turnStarted('d2', 'turn-d2'));
    assert.deepStrictEqual([...new Set(told.map((t) => t.threadId))], ['h1']);
  });

  test('a depth-2 thread that reached the lead as an activity item is withdrawn when its thread/started says so', async () => {
    const c = newClient();
    const { told } = await leadTurn(c);
    feed(c.server, ...activity('d2'));
    feed(c.server, P.subAgentThreadStarted('d2', { nickname: 'deeper', depth: 2 }));
    assert.deepStrictEqual(kinds(told, 'd2'), ['start', 'withdrawn']);
  });

  test("the helper's own turn id is told once known, at once when its turn/started came first", async () => {
    const c = newClient();
    const { told } = await leadTurn(c);
    feed(c.server, ...activity('h1'), P.turnStarted('h1', 'turn-h1'));
    feed(c.server, P.turnStarted('h2', 'turn-h2'), ...activity('h2'));
    assert.deepStrictEqual(told.filter((t) => t.kind === 'turn').map((t) => [t.threadId, t.turnId]), [['h1', 'turn-h1'], ['h2', 'turn-h2']]);
  });

  test("a helper's step comes from its latest item and its file from its last completed file change", async () => {
    const c = newClient();
    const { told } = await leadTurn(c);
    feed(c.server, ...activity('h1'), P.turnStarted('h1', 'turn-h1'));
    const steps = () => told.filter((t) => t.kind === 'update').map((t) => [t.step, t.file]);
    feed(c.server, P.toolItem('started', 'h1', 'turn-h1', { id: 'i1', type: 'commandExecution', command: 'ls -la' }));
    feed(c.server, P.toolItem('completed', 'h1', 'turn-h1', { id: 'i2', type: 'fileChange', paths: ['notes/a.md', 'notes/b.md'] }));
    feed(c.server, P.toolItem('started', 'h1', 'turn-h1', { id: 'i3', type: 'mcpToolCall', server: 'files', tool: 'search' }));
    feed(c.server, P.toolItem('started', 'h1', 'turn-h1', { id: 'i4', type: 'webSearch', query: 'exchange rates' }));
    feed(c.server, P.itemStartedAgentMessage('h1', 'turn-h1', 'm1'));
    assert.deepStrictEqual(steps(), [
      [{ type: 'commandExecution', detail: 'ls -la' }, null],
      [{ type: 'fileChange', detail: 'notes/a.md' }, 'notes/b.md'],
      [{ type: 'mcpToolCall', detail: 'files/search' }, 'notes/b.md'],
      [{ type: 'webSearch', detail: 'exchange rates' }, 'notes/b.md'],
      [null, 'notes/b.md'],
    ]);
  });

  test("a helper's turn/completed gives its end: completed, failed, or killed when interrupted", async () => {
    const c = newClient();
    const { told } = await leadTurn(c);
    for (const id of ['h1', 'h2', 'h3']) feed(c.server, ...activity(id), P.turnStarted(id, `turn-${id}`));
    feed(c.server, P.turnCompleted('h1', 'turn-h1', 'completed'));
    feed(c.server, P.turnCompleted('h2', 'turn-h2', 'failed', { message: 'helper failed' }));
    feed(c.server, P.turnCompleted('h3', 'turn-h3', 'interrupted'));
    assert.deepStrictEqual(told.filter((t) => t.kind === 'end').map((t) => [t.threadId, t.state]), [['h1', 'completed'], ['h2', 'failed'], ['h3', 'killed']]);
  });

  test('an interrupted activity item on the lead reads as the helper killed, once', async () => {
    const c = newClient();
    const { told } = await leadTurn(c);
    feed(c.server, ...activity('h1'), P.turnStarted('h1', 'turn-h1'));
    feed(c.server, ...activity('h1', { id: 'act-stop', kind: 'interrupted' }));
    feed(c.server, P.turnCompleted('h1', 'turn-h1', 'interrupted'));
    assert.deepStrictEqual(told.filter((t) => t.kind === 'end').map((t) => t.state), ['killed']);
  });

  test('an ended helper whose thread starts a new turn is running again', async () => {
    const c = newClient();
    const { told } = await leadTurn(c);
    feed(c.server, ...activity('h1'), P.turnStarted('h1', 'turn-1'), P.turnCompleted('h1', 'turn-1', 'completed'));
    feed(c.server, ...activity('h1', { id: 'act-again', kind: 'interacted' }), P.turnStarted('h1', 'turn-2'));
    assert.deepStrictEqual(told.map((t) => [t.kind, t.state, t.turnId]), [
      ['start', 'running', null], ['turn', 'running', 'turn-1'], ['end', 'completed', 'turn-1'],
      ['start', 'running', 'turn-2'], ['turn', 'running', 'turn-2'],
    ]);
  });

  test('a helper whose turn ended before the lead recorded it is recorded in that final state, with no turn to stop', async () => {
    const c = newClient();
    const { told } = await leadTurn(c);
    feed(c.server, P.turnStarted('h1', 'turn-h1'), P.turnCompleted('h1', 'turn-h1', 'failed', { message: 'helper failed' }));
    feed(c.server, P.turnStarted('h2', 'turn-h2'), P.turnCompleted('h2', 'turn-h2', 'completed'));
    feed(c.server, P.turnStarted('h3', 'turn-h3'), P.turnCompleted('h3', 'turn-h3', 'interrupted'));
    feed(c.server, ...activity('h1'), ...activity('h2'), ...activity('h3'));
    assert.deepStrictEqual(told.map((t) => [t.kind, t.threadId, t.state, t.turnId]), [
      ['start', 'h1', 'failed', 'turn-h1'], ['start', 'h2', 'completed', 'turn-h2'], ['start', 'h3', 'killed', 'turn-h3'],
    ]);
  });

  test('a newer turn started before the lead recorded the helper clears the earlier end', async () => {
    const c = newClient();
    const { told } = await leadTurn(c);
    feed(c.server, P.turnStarted('h1', 'turn-1'), P.turnCompleted('h1', 'turn-1', 'completed'), P.turnStarted('h1', 'turn-2'));
    feed(c.server, ...activity('h1'));
    assert.deepStrictEqual(told.map((t) => [t.kind, t.state, t.turnId]), [['start', 'running', 'turn-2'], ['turn', 'running', 'turn-2']]);
  });

  test('a helper that ends after its lead turn has ended still reports its end', async () => {
    const c = newClient();
    const { told, events } = await leadTurn(c);
    feed(c.server, ...activity('h1'), P.turnStarted('h1', 'turn-h1'));
    feed(c.server, P.turnCompleted(LEAD, LEAD_TURN, 'completed'));
    assert.strictEqual(events.filter((e) => e.type === 'done').length, 1, "the lead's turn ended");
    feed(c.server, P.turnCompleted('h1', 'turn-h1', 'completed'));
    assert.deepStrictEqual(told.filter((t) => t.kind === 'end').map((t) => t.state), ['completed']);
  });

  test('the process exiting ends every running helper as failed, and only the running ones', async () => {
    const c = newClient();
    const { told } = await leadTurn(c);
    for (const id of ['h1', 'h2', 'h3']) feed(c.server, ...activity(id), P.turnStarted(id, `turn-${id}`));
    feed(c.server, P.turnCompleted('h2', 'turn-h2', 'completed'));
    c.server._onExit(1, null);
    assert.deepStrictEqual(told.filter((t) => t.kind === 'end').map((t) => [t.threadId, t.state]), [['h2', 'completed'], ['h1', 'failed'], ['h3', 'failed']]);
  });
});

describe("a helper's notifications stay off the lead's turn", () => {
  async function withHelper() {
    const c = newClient();
    const lead = await leadTurn(c);
    feed(c.server, ...activity('h1'), P.turnStarted('h1', 'turn-h1'));
    assert.deepStrictEqual(kinds(lead.told), ['start', 'turn'], 'the helper was recorded');
    return { c, ...lead };
  }

  test("a helper's agentMessage never joins the lead's reply", async () => {
    const { c, events } = await withHelper();
    feed(c.server, P.itemStartedAgentMessage('h1', 'turn-h1', 'hm'), P.agentMessageDelta('h1', 'turn-h1', 'hm', 'HELPER-TEXT'));
    feed(c.server, P.itemCompletedAgentMessage('h1', 'turn-h1', 'hm', 'HELPER-TEXT'));
    feed(c.server, P.itemStartedAgentMessage(LEAD, LEAD_TURN, 'lm'), P.itemCompletedAgentMessage(LEAD, LEAD_TURN, 'lm', 'LEAD-TEXT'));
    const texts = events.filter((e) => e.type === 'text' || e.type === 'delta').map((e) => e.text || e.delta);
    assert.deepStrictEqual(texts, ['LEAD-TEXT']);
  });

  test("a helper's turn/completed never ends the lead's turn", async () => {
    const { c, events, told } = await withHelper();
    feed(c.server, P.turnCompleted('h1', 'turn-h1', 'completed'));
    assert.deepStrictEqual(kinds(told).slice(-1), ['end'], 'the helper ended');
    assert.strictEqual(events.filter((e) => e.type === 'done').length, 0, 'the lead is still running');
    assert.ok(c.server._activeTurns.has(LEAD), "the lead's turn still holds its slot");
  });

  test("a helper's token usage never sets the lead's usage", async () => {
    const { c, events } = await withHelper();
    feed(c.server, P.tokenUsageUpdated('h1', 'turn-h1', { inputTokens: 900, outputTokens: 90 }));
    feed(c.server, P.tokenUsageUpdated(LEAD, LEAD_TURN, { inputTokens: 10, outputTokens: 5 }));
    feed(c.server, P.turnCompleted(LEAD, LEAD_TURN, 'completed'));
    const done = events.find((e) => e.type === 'done');
    assert.strictEqual(done.usage.inputTokens, 10);
    assert.strictEqual(done.usage.outputTokens, 5);
  });

  test("a helper's thread is never put in the lead's turn slots", async () => {
    const { c } = await withHelper();
    assert.deepStrictEqual([...c.server._activeTurns.keys()], [LEAD]);
  });
});

describe('a lead turn without the helpers option', () => {
  // By design this passes before helpers existed too. Its sibling, "a started
  // activity item records a helper once per item id, its name the last part
  // of agentPath until thread/started says more", fails without helpers.
  test('records no helper and leaves its notifications ignored', async () => {
    const c = newClient();
    const { events } = await leadTurn(c, { helpers: false });
    feed(c.server, P.subAgentThreadStarted('h1', { nickname: 'rates' }), ...activity('h1'), P.turnStarted('h1', 'turn-h1'));
    feed(c.server, P.itemStartedAgentMessage('h1', 'turn-h1', 'hm'), P.itemCompletedAgentMessage('h1', 'turn-h1', 'hm', 'HELPER-TEXT'));
    feed(c.server, P.turnCompleted('h1', 'turn-h1', 'completed'));
    assert.deepStrictEqual(events.filter((e) => e.type !== 'usage'), []);
    assert.strictEqual(c.server._helperThreads ? c.server._helperThreads.size : 0, 0);
  });
});

describe("a helper's approval requests", () => {
  // The lead's turn with one helper, rates, running its own turn.
  async function withRates() {
    const c = newClient();
    const lead = await leadTurn(c);
    feed(c.server, P.subAgentThreadStarted('h1', { nickname: 'rates' }), ...activity('h1'), P.turnStarted('h1', 'turn-h1'));
    assert.deepStrictEqual(kinds(lead.told), ['start', 'turn'], 'the helper was recorded');
    return { c, ...lead };
  }
  const ask = (id, threadId = 'h1', turnId = `turn-${threadId}`) => P.commandApprovalRequest(id, { threadId, turnId, itemId: `i${id}`, command: 'rm -rf build' });
  const answers = (c) => c.written.filter((w) => w.result && 'decision' in w.result).map((w) => [w.id, w.result.decision]);
  const approvalsOf = (events) => events.filter((e) => e.type === 'approval');

  test("a recorded helper's command or file-change approval is held in the lead's turn and emitted there naming the helper, answered on the helper's request id", async () => {
    const { c, events } = await withRates();
    feed(c.server, ask(7), P.fileChangeApprovalRequest(8, { threadId: 'h1', turnId: 'turn-h1', itemId: 'i8', grantRoot: '/elsewhere' }));
    const got = approvalsOf(events);
    assert.deepStrictEqual(got.map((e) => [e.kind, e.requestId, e.helper]), [
      ['command', 7, { threadId: 'h1', name: 'rates' }],
      ['fileChange', 8, { threadId: 'h1', name: 'rates' }],
    ]);
    assert.deepStrictEqual([...c.server._activeTurns.get(LEAD).approvals.keys()], [7, 8], "held in the lead's approvals");
    assert.deepStrictEqual(answers(c), [], 'nothing answered before the person does');
    got[0].respond('accept');
    got[1].respond('decline');
    assert.deepStrictEqual(answers(c), [[7, 'accept'], [8, 'decline']]);
    assert.strictEqual(c.server._activeTurns.get(LEAD).approvals.size, 0);
  });

  test("the lead's own approval carries no helper", async () => {
    // By design this passes before helpers existed too. Its sibling, "a
    // recorded helper's command or file-change approval is held in the lead's
    // turn and emitted there naming the helper, answered on the helper's
    // request id", fails without helpers.
    const { c, events } = await withRates();
    feed(c.server, ask(9, LEAD, LEAD_TURN));
    const [e] = approvalsOf(events);
    assert.strictEqual(e.requestId, 9);
    assert.ok(!('helper' in e), 'no helper on the lead\'s own request');
  });

  test("a line after a helper's decision is steered onto the helper's own turn, never the lead's", async () => {
    const { c, events } = await withRates();
    feed(c.server, ask(7));
    const [e] = approvalsOf(events);
    e.respond('decline');
    await e.steer('stop and ask');
    const steers = c.requests.filter((r) => r.method === 'turn/steer');
    assert.deepStrictEqual(steers.map((r) => r.params), [{ threadId: 'h1', expectedTurnId: 'turn-h1', input: [{ type: 'text', text: 'stop and ask' }] }]);
  });

  test('a line for a helper that has ended is refused and nothing is sent', async () => {
    const { c, events } = await withRates();
    feed(c.server, ask(7));
    const [e] = approvalsOf(events);
    e.respond('decline');
    feed(c.server, P.turnCompleted('h1', 'turn-h1', 'completed'));
    await assert.rejects(() => e.steer('too late'), /no helper turn/);
    assert.deepStrictEqual(c.requests.filter((r) => r.method === 'turn/steer'), []);
  });

  test("a helper's approval still held when the lead's turn ends is declined", async () => {
    const { c, events } = await withRates();
    feed(c.server, ask(7));
    assert.strictEqual(approvalsOf(events).length, 1, 'held on the lead');
    feed(c.server, P.turnCompleted(LEAD, LEAD_TURN, 'completed'));
    assert.deepStrictEqual(answers(c), [[7, 'decline']]);
  });

  test("a helper's approval with no lead turn running is declined at once and raised nowhere", async () => {
    const { c, events } = await withRates();
    feed(c.server, P.turnCompleted(LEAD, LEAD_TURN, 'completed'));
    const before = events.length;
    feed(c.server, ask(7));
    assert.deepStrictEqual(answers(c), [[7, 'decline']]);
    assert.strictEqual(events.length, before, 'no event');
  });

  test("a helper's approval after the helper ended is declined at once", async () => {
    const { c, events } = await withRates();
    feed(c.server, P.turnCompleted('h1', 'turn-h1', 'completed'), ask(7));
    assert.deepStrictEqual(answers(c), [[7, 'decline']]);
    assert.deepStrictEqual(approvalsOf(events), []);
  });

  test("a helper's own helper's approval is declined at once, beside the helper's that is raised", async () => {
    const { c, events } = await withRates();
    feed(c.server, P.subAgentActivityItem('h1', 'turn-h1', { id: 'act-d2', agentPath: 'root/rates/deeper', agentThreadId: 'd2', kind: 'started' }));
    feed(c.server, P.subAgentThreadStarted('d2', { nickname: 'deeper', parentThreadId: 'h1', depth: 2 }), P.turnStarted('d2', 'turn-d2'));
    feed(c.server, ask(7, 'd2'), ask(8));
    assert.deepStrictEqual(answers(c), [[7, 'decline']]);
    assert.deepStrictEqual(approvalsOf(events).map((e) => e.requestId), [8], "only rates' request is raised");
  });

  test("a helper's permissions request gets the empty grant at once and nothing reaches the lead's turn", async () => {
    // By design this passes before helpers existed too. Its sibling, "a
    // recorded helper's command or file-change approval is held in the lead's
    // turn and emitted there naming the helper, answered on the helper's
    // request id", fails without helpers.
    const { c, events } = await withRates();
    const before = events.length;
    feed(c.server, { id: 9, method: 'item/permissions/requestApproval', params: { threadId: 'h1', turnId: 'turn-h1', itemId: 'p9', permissions: { network: { enabled: true } } } });
    assert.deepStrictEqual(c.written.filter((w) => w.id === 9).map((w) => w.result), [appserver.permissionsRefusal()]);
    assert.strictEqual(events.length, before);
  });

  test("a helper stopped by the cap has its approval declined at once and raised nowhere", async () => {
    const c = newClient();
    const told = [];
    const sub = c.server.startTurn(LEAD, 'start some helpers', { helpers: (kind, rec) => { told.push(kind); if (kind === 'start') rec.capped = true; } });
    const events = [];
    sub.on('event', (e) => events.push(e));
    await sub.started;
    feed(c.server, P.subAgentThreadStarted('h6', { nickname: 'inbox' }), ...activity('h6'), P.turnStarted('h6', 'turn-h6'));
    assert.deepStrictEqual(told, ['start', 'turn'], 'the helper was recorded, and the cap stopped it');
    feed(c.server, ask(7, 'h6'));
    assert.deepStrictEqual(answers(c), [[7, 'decline']]);
    assert.deepStrictEqual(approvalsOf(events), []);
  });

  test("on a lead turn without the helpers option, a helper's approval is declined at once", async () => {
    // By design this passes before helpers existed too. Its sibling, "a
    // recorded helper's command or file-change approval is held in the lead's
    // turn and emitted there naming the helper, answered on the helper's
    // request id", fails without helpers.
    const c = newClient();
    const { events } = await leadTurn(c, { helpers: false });
    feed(c.server, P.subAgentThreadStarted('h1', { nickname: 'rates' }), ...activity('h1'), P.turnStarted('h1', 'turn-h1'), ask(7));
    assert.deepStrictEqual(answers(c), [[7, 'decline']]);
    assert.deepStrictEqual(approvalsOf(events), []);
  });
});

// THE CAP, AS A CONVERSATION'S ROWS HEAR IT. The client tells
// lib/delegation/helpers.js of each helper with the ways to stop it and to
// tell its lead (`ctl`); here those are recorded in one list, beside each
// helpers_changed and each recorded event, so their order can be read.
describe("the cap on a lead's Codex helpers", () => {
  const helpers = require('../../lib/delegation/helpers.js');
  const signals = require('../../lib/signals.js');
  const LINE = (name) => `Rundock stopped the helper ${name}: at most five helpers run at once. Wait for these to report back, then start the rest.`;
  const FIVE = ['rates', 'pipeline', 'deck', 'hooks', 'calendar'];
  let log = [];
  let prevDeps;
  let prevRecord;
  let prevEnabled;
  before(() => {
    prevEnabled = helpers.HELPERS_ENABLED;
    helpers.HELPERS_ENABLED = true;
    prevDeps = helpers.wireHelpersDeps({ safeSend: (s) => log.push(['rows', JSON.parse(s).helpers]) });
    prevRecord = signals.recordEvent;
    signals.recordEvent = (name, fields) => log.push(['event', name, fields]);
  });
  after(() => {
    helpers.HELPERS_ENABLED = prevEnabled;
    helpers.wireHelpersDeps(prevDeps);
    signals.recordEvent = prevRecord;
  });
  beforeEach(() => { log = []; });

  let n = 0;
  const convo = () => `cap-unit-${++n}`;
  const rec = (name) => ({ threadId: `t-${name}`, name, role: null, state: 'running', turnId: null, step: null, file: null, capped: false });
  function ctl({ interrupt = () => Promise.resolve({}), steer = () => Promise.resolve({}) } = {}) {
    return {
      interrupt: () => { log.push(['interrupt']); return interrupt(); },
      steer: (text) => { log.push(['steer', text]); return steer(text); },
      queue: (text) => log.push(['queue', text]),
    };
  }
  const tell = (c, r, kind, k = ctl()) => codexHelper()(c, 'fern', r, kind, k);
  function begin(c, r, k) {
    tell(c, r, 'start', k);
    r.turnId = `turn-${r.name}`;
    tell(c, r, 'turn', k);
  }
  function five(c) {
    const recs = FIVE.map(rec);
    for (const r of recs) begin(c, r);
    log = [];
    return recs;
  }
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const steps = () => log.map((l) => l[0]);
  const rowOf = (rows, name) => rows.find((r) => r.agent === name);
  // A lead turn on the client whose helpers are told to conversation `c`'s
  // rows, as the glue tells them.
  async function wiredLead(c, k = ctl()) {
    const client = newClient();
    const sub = client.server.startTurn(LEAD, 'start some helpers', { helpers: (kind, r) => codexHelper()(c, 'fern', r, kind, k) });
    await sub.started;
    return client;
  }

  test('a helper whose turn ended before Fern recorded it is shown in that final state, never counted and never stopped, beside five that run', async () => {
    const c = convo();
    const { server } = await wiredLead(c);
    for (const name of FIVE) feed(server, ...activity(name), P.turnStarted(name, `turn-${name}`));
    assert.strictEqual(helpers.runningCount(c), 5);
    log = [];
    feed(server, P.turnStarted('inbox', 'turn-inbox'), P.turnCompleted('inbox', 'turn-inbox', 'failed', { message: 'helper failed' }));
    feed(server, ...activity('inbox'));
    await settle();
    assert.deepStrictEqual(steps(), ['rows'], 'shown once, and never interrupted or steered');
    const shown = rowOf(log[0][1], 'inbox');
    assert.deepStrictEqual([shown.state, shown.capped], ['failed', false]);
    assert.strictEqual(helpers.runningCount(c), 5, 'never counted');
  });

  test('a helper recorded before hundreds of others, given more work while five run, is still recognized and stopped', async () => {
    const c = convo();
    const { server } = await wiredLead(c);
    feed(server, ...activity('early'), P.turnStarted('early', 'turn-early-1'), P.turnCompleted('early', 'turn-early-1', 'completed'));
    for (let i = 0; i < 300; i++) {
      const id = `since-${i}`;
      feed(server, ...activity(id), P.turnStarted(id, `turn-${id}`), P.turnCompleted(id, `turn-${id}`, 'completed'));
    }
    for (const name of FIVE) feed(server, ...activity(name), P.turnStarted(name, `turn-${name}`));
    assert.strictEqual(helpers.runningCount(c), 5);
    log = [];
    feed(server, ...activity('early', { id: 'act-early-again', kind: 'interacted' }), P.turnStarted('early', 'turn-early-2'));
    await settle();
    assert.deepStrictEqual(steps(), ['interrupt', 'rows', 'steer', 'event'], 'stopped as any sixth is');
    const shown = rowOf(log[1][1], 'early');
    assert.deepStrictEqual([shown.state, shown.capped], ['killed', true]);
    assert.deepStrictEqual(log[2], ['steer', LINE('early')]);
    assert.strictEqual(helpers.runningCount(c), 5, 'never counted');
  });

  test('a sixth gets no row and no count; once its turn is known it is interrupted, its row shown stopped, Fern steered with one line and the refusal recorded, in that order', async () => {
    const c = convo();
    five(c);
    const inbox = rec('inbox');
    tell(c, inbox, 'start');
    assert.strictEqual(inbox.capped, true);
    assert.deepStrictEqual(log, [], 'no row, no interrupt before its turn is known');
    assert.strictEqual(helpers.runningCount(c), 5);
    inbox.turnId = 'turn-inbox';
    tell(c, inbox, 'turn');
    await settle();
    assert.deepStrictEqual(steps(), ['interrupt', 'rows', 'steer', 'event']);
    const shown = rowOf(log[1][1], 'inbox');
    assert.deepStrictEqual([shown.toolUseId, shown.state, shown.capped], ['t-inbox', 'killed', true]);
    assert.ok(log[1][1].filter((r) => r.agent !== 'inbox').every((r) => r.state === 'running' && r.capped === false), 'the five run on');
    assert.deepStrictEqual(log[2], ['steer', LINE('inbox')]);
    assert.deepStrictEqual(log[3], ['event', 'helper_cap', { conv: c, agent: 'fern', d: { outcome: 'refused' } }]);
    assert.strictEqual(helpers.runningCount(c), 5, 'never counted');
  });

  test('a stopped helper is interrupted once, and its end leaves its row as shown', async () => {
    const c = convo();
    five(c);
    const inbox = rec('inbox');
    begin(c, inbox);
    await settle();
    log = [];
    tell(c, inbox, 'turn');
    inbox.state = 'killed';
    tell(c, inbox, 'end');
    await settle();
    assert.deepStrictEqual(log, [], 'no second interrupt and no change');
    assert.strictEqual(rowOf(helpers.helperRows(c), 'inbox').capped, true);
  });

  test('when the steer fails, the line is queued for Fern\'s next turn', async () => {
    const c = convo();
    five(c);
    begin(c, rec('inbox'), ctl({ steer: () => Promise.reject(new Error('no active turn to steer')) }));
    await settle();
    assert.deepStrictEqual(steps(), ['interrupt', 'rows', 'steer', 'event', 'queue']);
    assert.deepStrictEqual(log[4], ['queue', LINE('inbox')]);
  });

  test('when the interrupt fails, the helper runs and is counted, with no steer and no event', async () => {
    const c = convo();
    five(c);
    const inbox = rec('inbox');
    begin(c, inbox, ctl({ interrupt: () => Promise.reject(new Error('turn cannot be interrupted')) }));
    await settle();
    assert.deepStrictEqual(steps(), ['interrupt', 'rows']);
    const shown = rowOf(log[1][1], 'inbox');
    assert.deepStrictEqual([shown.state, shown.capped], ['running', false]);
    assert.strictEqual(inbox.capped, false, 'its requests may ask again');
    assert.strictEqual(helpers.runningCount(c), 6);
  });

  test('after a sixth\'s interrupt fails and one of the first five ends, it is among five running, so the next is stopped, shown stopped and never counted', async () => {
    const c = convo();
    const recs = five(c);
    const inbox = rec('inbox');
    begin(c, inbox, ctl({ interrupt: () => Promise.reject(new Error('turn cannot be interrupted')) }));
    await settle();
    assert.strictEqual(helpers.runningCount(c), 6, 'the one not stopped runs and is counted');
    recs[0].state = 'completed';
    tell(c, recs[0], 'end');
    assert.strictEqual(helpers.runningCount(c), 5, 'five run, it among them');
    log = [];
    begin(c, rec('drafts'));
    await settle();
    assert.deepStrictEqual(steps(), ['interrupt', 'rows', 'steer', 'event'], 'the next is stopped as any sixth is');
    const shown = rowOf(log[1][1], 'drafts');
    assert.deepStrictEqual([shown.state, shown.capped], ['killed', true]);
    assert.deepStrictEqual([rowOf(log[1][1], 'inbox').state, rowOf(log[1][1], 'inbox').capped], ['running', false], 'the one not stopped still runs');
    assert.deepStrictEqual(log[2], ['steer', LINE('drafts')]);
    assert.strictEqual(helpers.runningCount(c), 5, 'never counted');
  });

  test('while five run, a helper given more work is stopped the same way, its row shown stopped', async () => {
    const c = convo();
    const rates = rec('rates');
    begin(c, rates);
    rates.state = 'completed';
    tell(c, rates, 'end');
    for (const r of FIVE.slice(1).concat('inbox').map(rec)) begin(c, r);
    assert.strictEqual(helpers.runningCount(c), 5);
    log = [];
    rates.state = 'running';
    tell(c, rates, 'start');
    rates.turnId = 'turn-rates-2';
    tell(c, rates, 'turn');
    await settle();
    assert.deepStrictEqual(steps(), ['interrupt', 'rows', 'steer', 'event']);
    assert.deepStrictEqual([rowOf(log[1][1], 'rates').state, rowOf(log[1][1], 'rates').capped], ['killed', true]);
    assert.deepStrictEqual(log[2], ['steer', LINE('rates')]);
  });

  test('a stopped helper given more work while five still run is stopped again, and Fern reads why again', async () => {
    const c = convo();
    five(c);
    const inbox = rec('inbox');
    begin(c, inbox);
    await settle();
    inbox.state = 'killed';
    tell(c, inbox, 'end');
    log = [];
    inbox.state = 'running';
    tell(c, inbox, 'start');
    assert.deepStrictEqual(log, [], 'no row while it waits to be stopped');
    inbox.turnId = 'turn-inbox-2';
    tell(c, inbox, 'turn');
    await settle();
    assert.deepStrictEqual(steps(), ['interrupt', 'rows', 'steer', 'event']);
    assert.deepStrictEqual(log[2], ['steer', LINE('inbox')]);
    assert.strictEqual(helpers.runningCount(c), 5);
  });

  test('once one of five ends, the next starts and runs', async () => {
    const c = convo();
    const recs = five(c);
    recs[0].state = 'completed';
    tell(c, recs[0], 'end');
    log = [];
    const inbox = rec('inbox');
    begin(c, inbox);
    await settle();
    assert.deepStrictEqual(steps(), ['rows']);
    assert.strictEqual(rowOf(log[0][1], 'inbox').state, 'running');
    assert.strictEqual(helpers.runningCount(c), 5);
  });

  test('two conversations each run five', async () => {
    const a = convo();
    const b = convo();
    for (const c of [a, b]) for (const r of FIVE.map(rec)) begin(c, r);
    await settle();
    assert.strictEqual(steps().filter((s) => s === 'rows').length, 10, 'ten rows shown');
    assert.ok(!steps().includes('interrupt'), 'none stopped');
    assert.deepStrictEqual([helpers.runningCount(a), helpers.runningCount(b)], [5, 5]);
  });
});

// THE FIRST BATCH. A Codex lead starts helpers without asking, so its first
// helpers in a conversation are marked for the page's notice instead of a
// card: every helper started in the lead's first turn that starts any, a
// stopped one included. The lead is then kept on the conversation's record as
// noticed, apart from the leads the person allowed, and nothing is marked
// again for it there.
describe("a Codex lead's first batch", () => {
  const helpers = require('../../lib/delegation/helpers.js');
  const config = require('../../lib/config.js');
  const { readConversations, writeConversations } = require('../../lib/store/persistence.js');
  const { makeWorkspace, agentFile, cleanup } = require('../helpers/workspace.js');
  let cards = [];
  let prev;
  before(() => {
    prev = { enabled: helpers.HELPERS_ENABLED, workspace: config.getWorkspace() };
    helpers.HELPERS_ENABLED = true;
    prev.deps = helpers.wireHelpersDeps({
      safeSend: () => {},
      requestServerPermission: (req) => { cards.push(req); req.onDecision(true, null, { card: true }); },
    });
    config.setWorkspace(makeWorkspace({ agents: {
      wren: agentFile({ name: 'wren', displayName: 'Wren', role: 'Lead', order: 1 }),
      ash: agentFile({ name: 'ash', displayName: 'Ash', order: 2, reportsTo: 'wren' }),
    } }));
  });
  after(() => {
    helpers.HELPERS_ENABLED = prev.enabled;
    helpers.wireHelpersDeps(prev.deps);
    config.setWorkspace(prev.workspace);
    cleanup();
  });
  beforeEach(() => { cards = []; });

  let n = 0;
  const convo = () => `first-unit-${++n}`;
  const rec = (c, name, leadTurnId) => ({
    threadId: `${c}-${name}`, leadThreadId: LEAD, leadTurnId, name, role: null,
    state: 'running', turnId: `turn-${name}`, step: null, file: null, capped: false,
  });
  const ctl = { interrupt: () => Promise.resolve({}), steer: () => Promise.resolve({}), queue: () => {} };
  function begin(c, r, lead = 'fern') {
    codexHelper()(c, lead, r, 'start', ctl);
    codexHelper()(c, lead, r, 'turn', ctl);
  }
  const marks = (c) => Object.fromEntries(helpers.helperRows(c).map((r) => [r.agent, r.firstBatch]));
  const record = (c) => readConversations().find((x) => x && x.id === c);
  const plant = (entry) => writeConversations([entry, ...readConversations()]);
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  test('every helper a Codex lead starts in its first turn is marked, with no card, and the lead is kept as noticed', () => {
    const c = convo();
    begin(c, rec(c, 'rates', 'turn-1'));
    begin(c, rec(c, 'pipeline', 'turn-1'));
    assert.deepStrictEqual(marks(c), { rates: true, pipeline: true });
    assert.deepStrictEqual(cards, [], 'no card');
    assert.deepStrictEqual(record(c), { id: c, helpersNoticed: ['fern'] }, 'kept apart from the leads allowed');
  });

  test('a helper the lead starts in a later turn is not marked', () => {
    const c = convo();
    begin(c, rec(c, 'rates', 'turn-1'));
    begin(c, rec(c, 'deck', 'turn-2'));
    begin(c, rec(c, 'hooks', 'turn-1'));
    assert.deepStrictEqual(marks(c), { rates: true, deck: false, hooks: true });
    assert.deepStrictEqual(record(c).helpersNoticed, ['fern'], 'kept once');
  });

  test('a helper stopped by the cap in the first batch is marked too', async () => {
    const c = convo();
    for (const name of ['rates', 'pipeline', 'deck', 'hooks', 'calendar', 'inbox']) begin(c, rec(c, name, 'turn-1'));
    await settle();
    const inbox = helpers.helperRows(c).find((r) => r.agent === 'inbox');
    assert.deepStrictEqual([inbox.capped, inbox.firstBatch], [true, true]);
    assert.ok(helpers.helperRows(c).every((r) => r.firstBatch === true), 'all six');
  });

  test('a helper keeps its mark when it is given more work in a later turn', () => {
    const c = convo();
    const rates = rec(c, 'rates', 'turn-1');
    begin(c, rates);
    rates.state = 'completed';
    codexHelper()(c, 'fern', rates, 'end', ctl);
    begin(c, rec(c, 'deck', 'turn-2'));
    rates.state = 'running';
    begin(c, rates);
    assert.deepStrictEqual(marks(c), { rates: true, deck: false });
  });

  test('a conversation whose record keeps the lead as noticed, as one opened again does, marks nothing', () => {
    const c = convo();
    plant({ id: c, helpersNoticed: ['fern'] });
    begin(c, rec(c, 'rates', 'turn-1'));
    assert.deepStrictEqual(marks(c), { rates: false });
    assert.deepStrictEqual(record(c), { id: c, helpersNoticed: ['fern'] });
  });

  test('a lead the person allowed helpers for is still marked: being allowed is not being noticed', () => {
    const c = convo();
    plant({ id: c, helpersAllowed: ['fern'] });
    begin(c, rec(c, 'rates', 'turn-1'));
    assert.deepStrictEqual(marks(c), { rates: true });
    assert.deepStrictEqual(record(c), { id: c, helpersAllowed: ['fern'], helpersNoticed: ['fern'] });
  });

  test('each Codex lead has its own first batch: after Sky takes over, her first helpers are marked once', () => {
    const c = convo();
    begin(c, rec(c, 'rates', 'turn-1'));
    begin(c, rec(c, 'deck', 'turn-2'), 'sky');
    begin(c, rec(c, 'hooks', 'turn-3'), 'sky');
    assert.deepStrictEqual(marks(c), { rates: true, deck: true, hooks: false }, 'Fern\'s helper keeps her mark beside Sky\'s');
    assert.deepStrictEqual(record(c).helpersNoticed, ['fern', 'sky']);
  });

  test('a thread withdrawn as upkeep that was the only one of the first turn leaves the first batch to come: the next turn\'s helper is marked', () => {
    const c = convo();
    const tidy = rec(c, 'tidy', 'turn-1');
    begin(c, tidy);
    assert.deepStrictEqual(record(c).helpersNoticed, ['fern'], 'marked when it started');
    codexHelper()(c, 'fern', tidy, 'withdrawn', ctl);
    assert.deepStrictEqual(helpers.helperRows(c), [], 'its row is withdrawn');
    assert.strictEqual(record(c).helpersNoticed, undefined, 'and the notice kept for it undone');
    begin(c, rec(c, 'rates', 'turn-2'));
    assert.deepStrictEqual(marks(c), { rates: true }, 'the first real helper is the first batch');
    assert.deepStrictEqual(record(c).helpersNoticed, ['fern']);
  });

  test('a thread withdrawn beside a real helper of the same first turn leaves that helper marked and the lead noticed', () => {
    const c = convo();
    const tidy = rec(c, 'tidy', 'turn-1');
    begin(c, rec(c, 'rates', 'turn-1'));
    begin(c, tidy);
    codexHelper()(c, 'fern', tidy, 'withdrawn', ctl);
    begin(c, rec(c, 'deck', 'turn-2'));
    assert.deepStrictEqual(marks(c), { rates: true, deck: false });
    assert.deepStrictEqual(record(c).helpersNoticed, ['fern']);
  });

  test('a lead noticed before keeps its notice when a thread of its is withdrawn', () => {
    const c = convo();
    plant({ id: c, helpersNoticed: ['fern'] });
    const tidy = rec(c, 'tidy', 'turn-1');
    begin(c, tidy);
    codexHelper()(c, 'fern', tidy, 'withdrawn', ctl);
    begin(c, rec(c, 'rates', 'turn-2'));
    assert.deepStrictEqual(marks(c), { rates: false });
    assert.deepStrictEqual(record(c), { id: c, helpersNoticed: ['fern'] });
  });

  test('a helper with no lead turn known is not marked and leaves the first batch to come', () => {
    const c = convo();
    begin(c, rec(c, 'rates', null));
    assert.strictEqual(record(c), undefined, 'nothing kept');
    begin(c, rec(c, 'deck', 'turn-1'));
    assert.deepStrictEqual(marks(c), { rates: false, deck: true });
  });

  test('when the record cannot be kept, the first batch is still marked', () => {
    const c = convo();
    const workspace = config.getWorkspace();
    const file = require('node:path').join(workspace, '.rundock', 'conversations.json');
    const fs = require('node:fs');
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null;
    fs.rmSync(file, { force: true });
    fs.mkdirSync(file, { recursive: true });
    const warn = console.warn;
    const warned = [];
    console.warn = (line) => warned.push(line);
    try {
      begin(c, rec(c, 'rates', 'turn-1'));
      begin(c, rec(c, 'pipeline', 'turn-1'));
    } finally {
      console.warn = warn;
      fs.rmSync(file, { recursive: true, force: true });
      if (before !== null) fs.writeFileSync(file, before);
    }
    assert.deepStrictEqual(marks(c), { rates: true, pipeline: true });
    assert.strictEqual(warned.length, 1, 'said once');
    assert.match(warned[0], /Could not keep the notice for fern/);
  });

  test('a Claude Code lead kept as noticed alone still asks with a card before its first teammates start', async () => {
    const c = convo();
    plant({ id: c, helpersNoticed: ['wren'] });
    const calls = [
      { id: 'toolu_ash_1', input: { subagent_type: 'ash', description: 'Check the rates', prompt: 'Check the rates.' } },
      { id: 'toolu_explore_1', input: { subagent_type: 'Explore', description: 'Find the notes', prompt: 'Find the notes.' } },
    ];
    helpers.placeMessage(c, { agentId: 'wren', process: null }, calls);
    const answers = await Promise.all(calls.map((call) => helpers.answerAgentRequest({ convoId: c, askedBy: 'wren', data: { tool_use_id: call.id, tool_input: call.input } })));
    assert.deepStrictEqual(answers, [{ allow: true, card: true }, { allow: true, card: true }]);
    assert.strictEqual(cards.length, 1, 'the card was raised');
    assert.deepStrictEqual(record(c), { id: c, helpersNoticed: ['wren'], helpersAllowed: ['wren'] });
    // Beside it, a Codex lead's first helper in the same conversation is
    // marked and raises no card.
    begin(c, rec(c, 'rates', 'turn-1'));
    assert.strictEqual(marks(c).rates, true, 'Fern\'s first helper is marked');
    assert.strictEqual(cards.length, 1, 'with no card of its own');
    assert.deepStrictEqual(record(c).helpersNoticed, ['wren', 'fern']);
    helpers.leadClosed(c, null);
  });

  test('with helpers off, nothing is marked and no record is kept', () => {
    const c = convo();
    helpers.HELPERS_ENABLED = false;
    try { begin(c, rec(c, 'rates', 'turn-1')); } finally { helpers.HELPERS_ENABLED = true; }
    assert.deepStrictEqual(helpers.helperRows(c), []);
    assert.strictEqual(record(c), undefined);
  });
});

// WHAT A RUNNING CODEX HELPER HOLDS. A Claude Code lead's helpers run inside
// its process, so while they run its result ends only a turn, and its return,
// kill and idle wait for the request to end, which the lead's next result
// after they finish brings. A Codex helper is a thread of the app-server: its
// end wakes no process and Codex never ends a request. So it counts toward the
// cap and is shown, and holds nothing, for its lead or any agent after it.
describe('what a running Codex helper holds', () => {
  const helpers = require('../../lib/delegation/helpers.js');
  let prev;
  before(() => {
    prev = { enabled: helpers.HELPERS_ENABLED };
    helpers.HELPERS_ENABLED = true;
    prev.deps = helpers.wireHelpersDeps({ safeSend: () => {} });
  });
  after(() => {
    helpers.HELPERS_ENABLED = prev.enabled;
    helpers.wireHelpersDeps(prev.deps);
  });

  let n = 0;
  const convo = () => `holds-unit-${++n}`;
  const ctl = { interrupt: () => Promise.resolve({}), steer: () => Promise.resolve({}), queue: () => {} };
  // Fern's helper rates, running.
  function codexRuns(c) {
    const rec = { threadId: `${c}-rates`, leadThreadId: LEAD, leadTurnId: null, name: 'rates', role: null, state: 'running', turnId: 'turn-rates', step: null, file: null, capped: false };
    codexHelper()(c, 'fern', rec, 'start', ctl);
    assert.deepStrictEqual(helpers.helperRows(c).map((r) => [r.agent, r.kind, r.state]), [['rates', 'codex', 'running']], 'the Codex helper runs');
    assert.strictEqual(helpers.runningCount(c), 1, 'and is counted');
    return rec;
  }

  test("an agent's result while only a Codex helper runs ends its request: nothing holds its done or idle", () => {
    const c = convo();
    codexRuns(c);
    assert.strictEqual(helpers.helping(c), false);
    assert.strictEqual(helpers.turnHeld(c), false);
  });

  test('a return or kill asked for while only a Codex helper runs acts at once, so nothing is left waiting that nothing would release', () => {
    const c = convo();
    codexRuns(c);
    let acted = 0;
    assert.strictEqual(helpers.holdWhileHelping(c, () => { acted += 1; }), false, 'not held: the caller acts now');
    helpers.requestEnded(c);
    assert.strictEqual(acted, 0, 'and nothing was kept to act later');
  });

  test("a lead's row while only a Codex helper runs keeps its own idle and lists the helper", () => {
    const c = convo();
    codexRuns(c);
    const row = helpers.activeRow(c, { conversationId: c, idle: true });
    assert.strictEqual(row.idle, true);
    assert.deepStrictEqual(row.helpers.map((r) => [r.agent, r.state]), [['rates', 'running']]);
  });

  test("a Claude Code lead's helper beside a Codex one still holds its result, return and idle while it runs", () => {
    const c = convo();
    codexRuns(c);
    helpers.noteStarted(c, { lead: 'ash' }, { toolUseId: 'toolu_holds_1', agent: 'Explore', task: 'Look' });
    assert.strictEqual(helpers.turnHeld(c), true, 'its result ends only a turn');
    assert.strictEqual(helpers.holdWhileHelping(c, () => {}), true, 'a return waits');
    assert.strictEqual(helpers.activeRow(c, { conversationId: c, idle: true }).idle, false, 'busy');
    helpers.noteEnded(c, 'toolu_holds_1', 'completed');
    helpers.requestEnded(c);
  });

  test("once a Claude Code lead's helper ends, its held return acts at the request's end, though a Codex helper still runs", () => {
    const c = convo();
    codexRuns(c);
    helpers.noteStarted(c, { lead: 'ash' }, { toolUseId: 'toolu_holds_2', agent: 'Explore', task: 'Look' });
    assert.strictEqual(helpers.turnHeld(c), true);
    let acted = 0;
    assert.strictEqual(helpers.holdWhileHelping(c, () => { acted += 1; }), true);
    helpers.noteEnded(c, 'toolu_holds_2', 'completed');
    assert.strictEqual(helpers.turnHeld(c), false, 'its next result is not held');
    helpers.requestEnded(c);
    assert.strictEqual(acted, 1, 'the held return acted');
    assert.strictEqual(helpers.runningCount(c), 1, 'the Codex helper is still counted');
  });
});

// CODEX HELPERS BESIDE A CLAUDE CODE LEAD'S. A Claude Code lead's helpers run
// inside its process and end with it, or once another process leads. A Codex
// helper is a thread of the app-server: it ends on its own, when it is
// withdrawn or when the app-server goes. So nothing a Claude Code process does
// ends one or drops its row, and a Codex helper starting ends nothing of a
// Claude Code lead's.
describe("Codex helpers beside a Claude Code lead's", () => {
  const helpers = require('../../lib/delegation/helpers.js');
  const signals = require('../../lib/signals.js');
  const FIVE = ['rates', 'pipeline', 'deck', 'hooks', 'calendar'];
  let prev;
  let interrupts = 0;
  before(() => {
    prev = { enabled: helpers.HELPERS_ENABLED, record: signals.recordEvent };
    helpers.HELPERS_ENABLED = true;
    prev.deps = helpers.wireHelpersDeps({ safeSend: () => {} });
    signals.recordEvent = () => {};
  });
  after(() => {
    helpers.HELPERS_ENABLED = prev.enabled;
    helpers.wireHelpersDeps(prev.deps);
    signals.recordEvent = prev.record;
  });
  beforeEach(() => { interrupts = 0; });

  let n = 0;
  const convo = () => `beside-unit-${++n}`;
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const ctl = { interrupt: () => { interrupts += 1; return Promise.resolve({}); }, steer: () => Promise.resolve({}), queue: () => {} };
  // A lead's process, as its entry holds it.
  const proc = (name) => ({ name, exitCode: null, signalCode: null });
  const rec = (c, name) => ({ threadId: `${c}-${name}`, leadThreadId: LEAD, leadTurnId: null, name, role: null, state: 'running', turnId: `turn-${name}`, step: null, file: null, capped: false });
  function fernFive(c) {
    for (const name of FIVE) codexHelper()(c, 'fern', rec(c, name), 'start', ctl);
    assert.strictEqual(helpers.runningCount(c), 5, 'Fern\'s five run');
  }
  const codexStates = (c) => helpers.helperRows(c).filter((r) => r.kind === 'codex').map((r) => [r.agent, r.state]);
  const allRunning = FIVE.map((name) => [name, 'running']);
  const taskStarted = (id) => ({ type: 'system', subtype: 'task_started', task_id: `task-${id}`, tool_use_id: id, description: 'Look', subagent_type: 'Explore', task_type: 'local_agent' });

  test("a Claude Code lead's helper starting leaves Fern's running Codex helpers running and counted", () => {
    const c = convo();
    fernFive(c);
    const ash = proc('ash');
    helpers.readTaskLine(c, { agentId: 'ash', process: ash }, taskStarted('toolu_beside_1'));
    assert.deepStrictEqual(codexStates(c), allRunning);
    assert.strictEqual(helpers.runningCount(c), 6, 'Ash\'s helper is counted beside them');
    helpers.leadClosed(c, ash);
  });

  test("a Claude Code lead's process closing ends its own helpers and leaves Fern's running and counted", () => {
    const c = convo();
    fernFive(c);
    const ash = proc('ash');
    helpers.readTaskLine(c, { agentId: 'ash', process: ash }, taskStarted('toolu_beside_2'));
    helpers.leadClosed(c, ash);
    assert.deepStrictEqual(helpers.helperRows(c).map((r) => [r.agent, r.state]), allRunning, 'Ash\'s helper ended with him; Fern\'s run on');
    assert.strictEqual(helpers.runningCount(c), 5);
  });

  test("a process with no helpers of its own closing in the conversation leaves Fern's running Codex helpers running and counted", () => {
    const c = convo();
    fernFive(c);
    helpers.leadClosed(c, proc('ash'));
    assert.deepStrictEqual(codexStates(c), allRunning);
    assert.strictEqual(helpers.runningCount(c), 5);
  });

  test("a Claude Code lead's request ending leaves Fern's running Codex helpers running and counted", () => {
    const c = convo();
    fernFive(c);
    helpers.noteStarted(c, { lead: 'ash', proc: proc('ash') }, { toolUseId: 'toolu_beside_3', agent: 'Explore', task: 'Look' });
    helpers.noteEnded(c, 'toolu_beside_3', 'completed');
    helpers.requestEnded(c);
    assert.deepStrictEqual(codexStates(c), allRunning);
    assert.strictEqual(helpers.runningCount(c), 5);
  });

  test("after a Claude Code lead's process closes, Fern's next helper while her five still run is stopped", async () => {
    const c = convo();
    fernFive(c);
    const ash = proc('ash');
    helpers.readTaskLine(c, { agentId: 'ash', process: ash }, taskStarted('toolu_beside_4'));
    helpers.leadClosed(c, ash);
    const inbox = rec(c, 'inbox');
    codexHelper()(c, 'fern', inbox, 'start', ctl);
    codexHelper()(c, 'fern', inbox, 'turn', ctl);
    await settle();
    assert.strictEqual(interrupts, 1, 'interrupted');
    const shown = helpers.helperRows(c).find((r) => r.agent === 'inbox');
    assert.deepStrictEqual([shown.state, shown.capped], ['killed', true]);
    assert.strictEqual(helpers.runningCount(c), 5, 'never more than five');
  });

  test("a Codex helper starting leaves a Claude Code lead's running helpers running and its call held at the cap still waiting", async () => {
    const c = convo();
    const wren = proc('wren');
    const calls = Array.from({ length: 6 }, (_, i) => ({ id: `toolu_beside_w${i}`, input: { subagent_type: 'Explore', description: `Look ${i}`, prompt: `Look ${i}.` } }));
    helpers.placeMessage(c, { agentId: 'wren', process: wren }, calls);
    const answers = calls.map(() => null);
    calls.forEach((call, i) => {
      helpers.answerAgentRequest({ convoId: c, askedBy: 'wren', data: { tool_use_id: call.id, tool_input: call.input } }).then((a) => { answers[i] = a; });
    });
    await settle();
    assert.deepStrictEqual(answers, [...Array(5).fill({ allow: true }), null], 'five start and the sixth is held');
    const rates = rec(c, 'rates');
    try {
      codexHelper()(c, 'fern', rates, 'start', ctl);
      await settle();
      const wrens = helpers.helperRows(c).filter((r) => r.kind === 'builtin').map((r) => r.state);
      assert.deepStrictEqual(wrens, [...Array(5).fill('running'), 'waiting'], 'Wren\'s helpers run on, and the sixth still waits');
      assert.strictEqual(answers[5], null, 'its call is not refused');
      assert.strictEqual(rates.capped, true, 'Fern\'s helper is the one over the cap');
    } finally {
      helpers.leadClosed(c, wren);
    }
    await settle();
    assert.deepStrictEqual(answers[5], { allow: false }, 'Wren\'s close refuses it, as before');
  });
});
