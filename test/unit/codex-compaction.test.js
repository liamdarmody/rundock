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
// captured turn's id, and the captured notifications go in as they came.
async function replay(turn) {
  const server = createCodexAppServer({ binPath: 'codex-not-started', log: () => {} });
  server.request = async (method) => (method === 'turn/start' ? { turn: { id: turn.turnId } } : {});
  const sub = server.startTurn(turn.threadId, 'carry on');
  const events = [];
  sub.on('event', (e) => events.push(e));
  await sub.started;
  for (const n of turn.notifications) server._onNotification(n.method, n.params);
  return events;
}

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
