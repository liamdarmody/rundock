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
const { test, describe } = require('node:test');
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
