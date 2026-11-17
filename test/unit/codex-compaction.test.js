'use strict';
// A Codex thread summarised to make room, as the protocol client hears it.
//
// Codex keeps a contextCompaction item in the thread (item/started, then
// item/completed) and, on servers that still send it, the older
// thread/compacted notice for the same turn. The client turns those into two
// turn events: compactionStarted when the summary begins, and compacted, with
// a key naming it, once it has finished. One summary is one compacted event,
// however many records announce it.
//
// Two sources. The captured lines (test/fixtures/compaction/, recorded against
// codex-cli 0.156.1 and scrubbed) are replayed straight into the client, so
// the real shapes and the real order are what is measured. The stub binary
// then drives the shapes a capture can't stage on demand: both records,
// repeats, two summaries, a start with no finish, malformed lines, and words
// that look like a summary inside a reply.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createCodexAppServer } = require('../../codex-appserver.js');
const P = require('../fixtures/codex-appserver-protocol.js');

const STUB_BIN = path.join(__dirname, '..', 'helpers', 'stub-codex', 'codex');
const CAPTURES = path.join(__dirname, '..', 'fixtures', 'compaction');

const kinds = (events) => events.map((e) => e.type);
const compactions = (events) => events.filter((e) => e.type === 'compactionStarted' || e.type === 'compacted');

// ── The captured lines, replayed ────────────────────────────────────────────

// Every turn Rundock started in a capture: the turn/start it sent, and the
// notifications the server sent back until the capture's next marker.
function capturedTurns(file) {
  const lines = fs.readFileSync(path.join(CAPTURES, file), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const turns = [];
  let current = null;
  for (const line of lines) {
    if (line.dir === 'mark') { current = null; continue; }
    if (line.dir === 'sent' && line.msg.method === 'turn/start') { current = { notifications: [] }; turns.push(current); continue; }
    if (!current || line.dir !== 'recv' || !line.msg.method || line.msg.id != null) continue;
    current.notifications.push(line.msg);
    if (line.msg.method === 'turn/started') current.turnId = line.msg.params.turn.id;
    if (line.msg.params && line.msg.params.threadId) current.threadId = line.msg.params.threadId;
  }
  return turns;
}

// The real client with its transport replaced: turn/start answers with the
// captured turn's id, and the captured notifications go in as they came. A
// client passed in carries its earlier turns' state into this one.
const newClient = () => createCodexAppServer({ binPath: 'codex-not-started', log: () => {} });
async function replay(turn, server = newClient()) {
  server.request = async (method) => (method === 'turn/start' ? { turn: { id: turn.turnId } } : {});
  const sub = server.startTurn(turn.threadId, 'carry on');
  const events = [];
  sub.on('event', (e) => events.push(e));
  await sub.started;
  for (const n of turn.notifications) server._onNotification(n.method, n.params);
  return events;
}

// The summary Codex ran as a turn of its own when asked with
// thread/compact/start, which Rundock never sends: the notifications it sent
// from that request to the capture's next marker.
function capturedCompactTurn(file) {
  const lines = fs.readFileSync(path.join(CAPTURES, file), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const asked = lines.findIndex((l) => l.dir === 'sent' && l.msg.method === 'thread/compact/start');
  const out = [];
  for (const line of lines.slice(asked + 1)) {
    if (line.dir === 'mark') break;
    if (line.dir === 'recv' && line.msg.method && line.msg.id == null) out.push(line.msg);
  }
  return out;
}
// A record moved onto another thread, its turn left as captured.
function onThread(record, threadId) {
  const copy = JSON.parse(JSON.stringify(record));
  copy.params.threadId = threadId;
  return copy;
}

// A turn of Rundock's in the protocol's own shapes, with the given records
// between the reply's start and its end: for shapes neither source stages.
const THREAD = 'thread-alpha';
const TURN = 'turn-alpha';
function turnWith(records) {
  return { threadId: THREAD, turnId: TURN, notifications: [
    P.turnStarted(THREAD, TURN),
    P.itemStartedAgentMessage(THREAD, TURN, 'msg-alpha'),
    P.agentMessageDelta(THREAD, TURN, 'msg-alpha', 'Still here.'),
    ...records,
    P.itemCompletedAgentMessage(THREAD, TURN, 'msg-alpha', 'Still here.'),
    P.turnCompleted(THREAD, TURN),
  ] };
}
const withTurnId = (record, turnId) => {
  const params = { ...record.params, turnId };
  if (turnId === undefined) delete params.turnId;
  return { method: record.method, params };
};

describe('the captured lines', () => {
  test('a summary in the middle of a turn: one start, one finish keyed by the item, between the two parts of the reply', async () => {
    const [first] = capturedTurns('codex-auto-compact.jsonl');
    const events = await replay(first);
    assert.deepStrictEqual(compactions(events), [
      { type: 'compactionStarted' },
      { type: 'compacted', key: '00000000-0000-4000-8000-040000000004' },
    ]);
    const finished = events.findIndex((e) => e.type === 'compacted');
    const firstText = events.findIndex((e) => e.type === 'text');
    const lastDelta = events.map((e) => e.type).lastIndexOf('delta');
    assert.ok(firstText < finished && finished < lastDelta, `the summary falls between the reply's two items: ${kinds(events).join(',')}`);
    assert.strictEqual(events[events.length - 1].type, 'done');
  });

  test('a summary at the start of a turn: drawn before any of the reply', async () => {
    const [, second] = capturedTurns('codex-auto-compact.jsonl');
    const events = await replay(second);
    assert.deepStrictEqual(compactions(events), [
      { type: 'compactionStarted' },
      { type: 'compacted', key: '00000000-0000-4000-8000-040000000006' },
    ]);
    assert.ok(events.findIndex((e) => e.type === 'compacted') < events.findIndex((e) => e.type === 'delta'));
  });

  test('a turn with no summary in it gives no summary event', async () => {
    const turns = capturedTurns('codex-compact.jsonl');
    assert.strictEqual(turns.length, 2, 'the two turns Rundock started (the summary itself ran as its own turn)');
    for (const turn of turns) {
      const events = await replay(turn);
      assert.deepStrictEqual(compactions(events), []);
      assert.strictEqual(events[events.length - 1].type, 'done');
    }
  });

  test('a summary turn Rundock did not start draws nothing: its records, naming the turn Codex ran them in, sent during a turn of Rundock\'s on the same thread, and that turn carries on to its own end', async () => {
    const records = capturedCompactTurn('codex-compact.jsonl').map((r) => onThread(r, THREAD));
    assert.deepStrictEqual(records.filter((r) => r.params.item && r.params.item.type === 'contextCompaction').map((r) => r.method),
      ['item/started', 'item/completed'], 'the captured summary records are in what is replayed');
    const events = await replay(turnWith(records));
    assert.deepStrictEqual(compactions(events), []);
    assert.strictEqual(events.find((e) => e.type === 'text').text, 'Still here.', 'its turn/completed did not end this turn');
    assert.deepStrictEqual(events.filter((e) => e.type === 'done').map((e) => e.status), ['completed']);
  });
});

// ── The stub, for the shapes a capture can't stage ──────────────────────────

const dirs = [];
test.after(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

async function runTurn(rule, prompt = 'summarise test') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-compaction-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'stub-codex-scenario.json'), JSON.stringify({ appServer: { rules: [{ match: { promptIncludes: 'summarise test' }, ...rule }] } }));
  const server = createCodexAppServer({ binPath: STUB_BIN, cwd: dir, requestTimeoutMs: 5000, shutdownGraceMs: 1000, log: () => {} });
  try {
    await server.start();
    const { threadId } = await server.startThread({ cwd: dir });
    const sub = server.startTurn(threadId, prompt);
    const events = [];
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no done: ${kinds(events).join(',')}`)), 15000);
      sub.on('event', (e) => { events.push(e); if (e.type === 'done') { clearTimeout(timer); resolve(); } });
    });
    return events;
  } finally {
    await server.shutdown();
  }
}

describe('one summary, one event', () => {
  test('the item alone', async () => {
    const events = await runTurn({ deltas: ['After.'], compaction: {} });
    assert.deepStrictEqual(compactions(events).map((e) => e.type), ['compactionStarted', 'compacted']);
    assert.match(compactions(events)[1].key, /^cmp_/);
    assert.ok(events.findIndex((e) => e.type === 'compacted') < events.findIndex((e) => e.type === 'delta'));
  });

  test('both records, the item and the older notice, and the item finished twice: still one', async () => {
    const events = await runTurn({ deltas: ['After.'], compaction: { notice: true, duplicate: true } });
    assert.deepStrictEqual(compactions(events).map((e) => e.type), ['compactionStarted', 'compacted']);
  });

  test('the older notice alone: one finish, and no start, since the notice announces none', async () => {
    const events = await runTurn({ deltas: ['After.'], compaction: { item: false, notice: true } });
    assert.deepStrictEqual(compactions(events).map((e) => e.type), ['compacted']);
    assert.strictEqual(typeof compactions(events)[0].key, 'string');
  });

  test('two summaries in a turn: two events, two keys, in order', async () => {
    const events = await runTurn({ deltas: ['After.'], compaction: { count: 2 } });
    const finished = events.filter((e) => e.type === 'compacted');
    assert.strictEqual(finished.length, 2);
    assert.deepStrictEqual(finished.map((e) => e.key.slice(-2)), ['_0', '_1']);
  });

  test('the older notice twice for one summary, after its item: one event, keyed by the item', async () => {
    const events = await replay(turnWith([
      P.itemStartedContextCompaction(THREAD, TURN, 'cmp-alpha'),
      P.itemCompletedContextCompaction(THREAD, TURN, 'cmp-alpha'),
      P.threadCompacted(THREAD, TURN),
      P.threadCompacted(THREAD, TURN),
    ]));
    assert.deepStrictEqual(compactions(events), [{ type: 'compactionStarted' }, { type: 'compacted', key: 'cmp-alpha' }]);
  });

  test('the older notice twice with no item: one event', async () => {
    const events = await replay(turnWith([P.threadCompacted(THREAD, TURN), P.threadCompacted(THREAD, TURN)]));
    assert.deepStrictEqual(compactions(events).map((e) => e.type), ['compacted']);
    assert.strictEqual(typeof compactions(events)[0].key, 'string');
  });

  test('two summaries, each with its item and its notice sent twice: two events, keyed by the items, in order', async () => {
    const summary = (id) => [
      P.itemStartedContextCompaction(THREAD, TURN, id),
      P.itemCompletedContextCompaction(THREAD, TURN, id),
      P.threadCompacted(THREAD, TURN),
      P.threadCompacted(THREAD, TURN),
    ];
    const events = await replay(turnWith([...summary('cmp-alpha'), ...summary('cmp-beta')]));
    assert.deepStrictEqual(events.filter((e) => e.type === 'compacted').map((e) => e.key), ['cmp-alpha', 'cmp-beta']);
  });

  // A notice names no summary, only its turn. A summary needs new
  // conversation to trigger, so two summaries always have the turn doing
  // something else between them, and a repeat never does.
  test('two summaries announced only by the older notice, the reply carrying on between them: two events, in order, each keyed by the turn and its place in it', async () => {
    const events = await replay(turnWith([
      P.threadCompacted(THREAD, TURN),
      P.agentMessageDelta(THREAD, TURN, 'msg-alpha', ' More.'),
      P.threadCompacted(THREAD, TURN),
    ]));
    assert.deepStrictEqual(compactions(events), [
      { type: 'compacted', key: `${TURN}:compacted:1` },
      { type: 'compacted', key: `${TURN}:compacted:2` },
    ]);
    assert.deepStrictEqual(kinds(events).filter((k) => k === 'delta' || k === 'compacted'), ['delta', 'compacted', 'delta', 'compacted']);
  });

  test('the older notice and then its item: one event, and no live state after the divider', async () => {
    const events = await replay(turnWith([
      P.threadCompacted(THREAD, TURN),
      P.itemStartedContextCompaction(THREAD, TURN, 'cmp-alpha'),
      P.itemCompletedContextCompaction(THREAD, TURN, 'cmp-alpha'),
    ]));
    assert.deepStrictEqual(compactions(events), [{ type: 'compacted', key: `${TURN}:compacted:1` }]);
  });

  test('two summaries, each with its item and then its notice, the reply carrying on between them: two events, keyed by the items', async () => {
    const events = await replay(turnWith([
      P.itemStartedContextCompaction(THREAD, TURN, 'cmp-alpha'),
      P.itemCompletedContextCompaction(THREAD, TURN, 'cmp-alpha'),
      P.threadCompacted(THREAD, TURN),
      P.agentMessageDelta(THREAD, TURN, 'msg-alpha', ' More.'),
      P.itemStartedContextCompaction(THREAD, TURN, 'cmp-beta'),
      P.itemCompletedContextCompaction(THREAD, TURN, 'cmp-beta'),
      P.threadCompacted(THREAD, TURN),
    ]));
    assert.deepStrictEqual(events.filter((e) => e.type === 'compacted').map((e) => e.key), ['cmp-alpha', 'cmp-beta']);
  });

  test('a summary in the middle of a reply arrives between the reply\'s two items', async () => {
    const events = await runTurn({ deltas: ['Before ', 'the summary. ', 'After it.'], compaction: { afterDeltas: 2 } });
    const order = kinds(events).filter((k) => k === 'delta' || k === 'text' || k === 'compacted');
    assert.deepStrictEqual(order, ['delta', 'delta', 'text', 'compacted', 'delta', 'text']);
    assert.deepStrictEqual(events.filter((e) => e.type === 'text').map((e) => e.text), ['Before the summary. ', 'After it.']);
  });
});

describe('what draws nothing', () => {
  test('a start with no finish: the start is heard, no finish is invented, and the turn still ends', async () => {
    const events = await runTurn({ text: 'Done anyway.', compaction: { finish: false } });
    assert.deepStrictEqual(compactions(events).map((e) => e.type), ['compactionStarted']);
    assert.strictEqual(events.find((e) => e.type === 'text').text, 'Done anyway.');
    assert.strictEqual(events[events.length - 1].status, 'completed');
  });

  test('records missing their fields, or naming another turn, give nothing and break nothing', async () => {
    const events = await runTurn({ deltas: ['Still ', 'here.'], compaction: { malformed: true } });
    assert.deepStrictEqual(compactions(events), []);
    assert.strictEqual(events.find((e) => e.type === 'text').text, 'Still here.');
    assert.strictEqual(events[events.length - 1].status, 'completed');
  });

  test('a summary item with its id but no turn named, started or finished, draws nothing, and the reply and the turn carry on', async () => {
    const started = P.itemStartedContextCompaction(THREAD, TURN, 'cmp-alpha');
    const finished = P.itemCompletedContextCompaction(THREAD, TURN, 'cmp-alpha');
    const cases = {
      'the start alone, no turn id': [withTurnId(started, undefined)],
      'the finish alone, no turn id': [withTurnId(finished, undefined)],
      'both, the turn id null': [withTurnId(started, null), withTurnId(finished, null)],
    };
    for (const [name, records] of Object.entries(cases)) {
      const events = await replay(turnWith(records));
      assert.deepStrictEqual(compactions(events), [], name);
      assert.strictEqual(events.find((e) => e.type === 'text').text, 'Still here.', name);
      assert.strictEqual(events[events.length - 1].type, 'done', name);
    }
  });

  // Each case is followed by a well-formed summary in the same turn, which
  // must still give exactly one start and one finish.
  const wellFormed = [P.itemStartedContextCompaction(THREAD, TURN, 'c1'), P.itemCompletedContextCompaction(THREAD, TURN, 'c1')];
  const unnamed = {
    'a summary item started with no turn id': [withTurnId(wellFormed[0], undefined)],
    'a summary item finished with no turn id': [withTurnId(wellFormed[1], undefined)],
    'a summary item started and finished with no turn id': [withTurnId(wellFormed[0], undefined), withTurnId(wellFormed[1], undefined)],
    'a summary item and its notice naming another turn': [withTurnId(wellFormed[0], 'turn-beta'), withTurnId(wellFormed[1], 'turn-beta'), P.threadCompacted(THREAD, 'turn-beta')],
  };
  for (const [name, records] of Object.entries(unnamed)) {
    test(`${name}: no live state and no divider, and a summary that follows draws exactly one`, async () => {
      const events = await replay(turnWith([...records, ...wellFormed]));
      assert.deepStrictEqual(compactions(events), [{ type: 'compactionStarted' }, { type: 'compacted', key: 'c1' }]);
      assert.strictEqual(events[events.length - 1].type, 'done');
    });
  }

  test('a turn whose id is empty, its summary records naming that empty id: no live state and no divider, and a summary in the next turn draws exactly one', async () => {
    const client = newClient();
    const first = await replay({ threadId: THREAD, turnId: '', notifications: [
      P.turnStarted(THREAD, ''),
      P.itemStartedContextCompaction(THREAD, '', 'c1'),
      P.itemCompletedContextCompaction(THREAD, '', 'c1'),
      P.threadCompacted(THREAD, ''),
      P.turnCompleted(THREAD, ''),
    ] }, client);
    assert.deepStrictEqual(compactions(first), []);
    assert.strictEqual(first[first.length - 1].type, 'done');
    const next = await replay(turnWith(wellFormed), client);
    assert.deepStrictEqual(compactions(next), [{ type: 'compactionStarted' }, { type: 'compacted', key: 'c1' }]);
  });

  test('a reply that spells out the divider\'s words and either runtime\'s summary event is only text', async () => {
    const lookAlikes = [
      'Earlier messages were summarised to make room. ',
      JSON.stringify({ method: 'thread/compacted', params: { threadId: 'x', turnId: 'y' } }),
      JSON.stringify({ method: 'item/completed', params: { item: { type: 'contextCompaction', id: 'z' }, threadId: 'x', turnId: 'y' } }),
      JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: 'w' }),
      JSON.stringify({ type: 'system', subtype: 'status', status: 'compacting' }),
    ];
    const events = await runTurn({ deltas: lookAlikes });
    assert.deepStrictEqual(compactions(events), []);
    assert.strictEqual(events.find((e) => e.type === 'text').text, lookAlikes.join(''));
  });
});
