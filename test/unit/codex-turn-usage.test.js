'use strict';
// WHAT A CODEX TURN USED, AS THE PROTOCOL CLIENT HEARS IT.
//
// Codex sends thread/tokenUsage/updated after each model call in a turn, with
// `last` (that call) and `total` (the thread so far), and repeats an update
// unchanged at times. A turn's usage is the sum of its calls' `last` counts,
// each update counted once, and only the counts the server reported: a count
// it left out stays out, never zero. The turn's time is turn.durationMs from
// turn/completed, or, when that is missing or not a whole number, the time
// the client measured from the turn's start.
//
// Two sources, as in codex-compaction.test.js: the captured lines (recorded
// against codex-cli 0.156.1 and scrubbed) replayed straight into the client,
// and synthetic notifications for the shapes a capture can't stage.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const appserver = require('../../codex-appserver.js');
const P = require('../fixtures/codex-appserver-protocol.js');

const CAPTURES = path.join(__dirname, '..', 'fixtures', 'compaction');
const THREAD = 'thread-alpha';

// Every turn Rundock started in a capture: the turn/start it sent, and the
// notifications the server sent back until the capture's next marker.
function captureLines(file) {
  return fs.readFileSync(path.join(CAPTURES, file), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}
function capturedTurns(file) {
  const turns = [];
  let current = null;
  for (const line of captureLines(file)) {
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
// given turn id, and notifications go in as they came. A client passed in
// carries its earlier turns' state into this one.
const newClient = () => appserver.createCodexAppServer({ binPath: 'codex-not-started', log: () => {} });
async function startTurn(server, threadId, turnId) {
  server.request = async (method) => (method === 'turn/start' ? { turn: { id: turnId } } : {});
  const sub = server.startTurn(threadId, 'carry on');
  const events = [];
  sub.on('event', (e) => events.push(e));
  await sub.started;
  return events;
}
async function replay(notifications, { server = newClient(), threadId, turnId } = {}) {
  const events = await startTurn(server, threadId, turnId);
  for (const n of notifications) server._onNotification(n.method, n.params);
  return events;
}
const doneOf = (events) => {
  const done = events.filter((e) => e.type === 'done');
  assert.strictEqual(done.length, 1, 'one done event');
  return done[0];
};
const usagesOf = (events) => events.filter((e) => e.type === 'usage').map((e) => e.usage);

// An update with the given running total and last call, and nothing else.
function update(turnId, totalTokens, last) {
  return { method: 'thread/tokenUsage/updated', params: { threadId: THREAD, turnId, tokenUsage: { total: { totalTokens }, last } } };
}
function completed(turnId, durationMs) {
  const turn = { id: turnId, items: [], status: 'completed', error: null };
  if (durationMs !== undefined) turn.durationMs = durationMs;
  return { method: 'turn/completed', params: { threadId: THREAD, turn } };
}

function needsNormalizeUsage() {
  assert.strictEqual(typeof appserver.normalizeUsage, 'function', 'the client exports normalizeUsage');
  return appserver.normalizeUsage;
}
function withClock(fn) {
  assert.ok(appserver.clock && typeof appserver.clock.now === 'function', 'the client reads its time from a replaceable clock');
  const real = appserver.clock.now;
  let t = 5000000;
  appserver.clock.now = () => t;
  const move = (ms) => { t += ms; };
  return Promise.resolve(fn(move)).finally(() => { appserver.clock.now = real; });
}

describe('normalizeUsage keeps only the counts the server reported', () => {
  test('copies the four counts from the call it is given and nothing else', () => {
    const normalizeUsage = needsNormalizeUsage();
    assert.deepStrictEqual(
      normalizeUsage({ totalTokens: 17573, inputTokens: 17568, cachedInputTokens: 17280, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0 }),
      { inputTokens: 17568, cachedInputTokens: 17280, outputTokens: 5, reasoningOutputTokens: 0 });
  });

  test('a count left out stays out, never zero', () => {
    const normalizeUsage = needsNormalizeUsage();
    assert.deepStrictEqual(normalizeUsage({ inputTokens: 900, outputTokens: 40 }), { inputTokens: 900, outputTokens: 40 });
  });

  test('no counts at all gives an empty object', () => {
    const normalizeUsage = needsNormalizeUsage();
    for (const none of [undefined, null, {}, 'text', 7, { totalTokens: 10 }]) assert.deepStrictEqual(normalizeUsage(none), {}, String(none));
  });

  const BAD = [['the string "18240"', '18240'], ['-5', -5], ['1.5', 1.5], ['1e400', 1e400], ['2^53', 2 ** 53], ['null', null], ['markup', '<img src=x onerror=alert(1)>']];
  for (const [label, bad] of BAD) {
    test(`a count of ${label} is dropped`, () => {
      const normalizeUsage = needsNormalizeUsage();
      assert.deepStrictEqual(normalizeUsage({ inputTokens: bad, outputTokens: 12 }), { outputTokens: 12 });
    });
  }
});

describe('the captured turns', () => {
  const [one, two] = capturedTurns('codex-auto-compact.jsonl');
  const trailing = captureLines('codex-auto-compact.jsonl')[72].msg;

  test('turn 1 used the sum of its calls, its repeated update counted once', async () => {
    // The capture holds the two turns and the update that trails the second.
    assert.ok(one && two, 'two turns captured');
    assert.strictEqual(trailing.method, 'thread/tokenUsage/updated');
    assert.strictEqual(trailing.params.turnId, two.turnId);
    const done = doneOf(await replay(one.notifications, one));
    assert.deepStrictEqual(done.usage, { inputTokens: 35003, cachedInputTokens: 17280, outputTokens: 49, reasoningOutputTokens: 0 });
  });

  test('each usage event carries the turn\'s sum so far', async () => {
    const events = await replay(one.notifications, one);
    assert.deepStrictEqual(usagesOf(events), [
      { inputTokens: 17435, cachedInputTokens: 0, outputTokens: 44, reasoningOutputTokens: 0 },
      { inputTokens: 35003, cachedInputTokens: 17280, outputTokens: 49, reasoningOutputTokens: 0 },
    ]);
  });

  test('turn 2 starts its sum again after turn 1\'s, and carries its own time', async () => {
    const server = newClient();
    const first = doneOf(await replay(one.notifications, { server, ...one }));
    const done = doneOf(await replay(two.notifications, { server, ...two }));
    assert.deepStrictEqual(done.usage, { inputTokens: 17536, cachedInputTokens: 13056, outputTokens: 5, reasoningOutputTokens: 0 });
    assert.deepStrictEqual(first.usage, { inputTokens: 35003, cachedInputTokens: 17280, outputTokens: 49, reasoningOutputTokens: 0 },
      'turn 1 summed its calls on the same client, so turn 2\'s figures are a fresh sum');
    assert.strictEqual(done.durationMs, 8889, 'turn 2 carries the time Codex reported for it');
  });

  test('the update that trails turn 2 changes neither its tokens nor its time', async () => {
    const server = newClient();
    await replay(one.notifications, { server, ...one });
    const events = await replay(two.notifications, { server, ...two });
    const before = JSON.stringify(events);
    server._onNotification(trailing.method, trailing.params);
    assert.strictEqual(JSON.stringify(events), before);
    assert.deepStrictEqual(doneOf(events).usage, { inputTokens: 17536, cachedInputTokens: 13056, outputTokens: 5, reasoningOutputTokens: 0 });
    assert.strictEqual(doneOf(events).durationMs, 8889, 'the done keeps the time Codex reported for turn 2');
  });

  test('the same update arriving again before the turn ends is not added twice, nor sent on again', async () => {
    const notes = [...two.notifications];
    notes.splice(notes.findIndex((n) => n.method === 'turn/completed'), 0, trailing);
    const events = await replay(notes, two);
    const done = doneOf(events);
    assert.deepStrictEqual(done.usage, { inputTokens: 17536, cachedInputTokens: 13056, outputTokens: 5, reasoningOutputTokens: 0 });
    const once = await replay(two.notifications, two);
    assert.deepStrictEqual(usagesOf(events), usagesOf(once), 'the repeat sends no usage event of its own');
    assert.strictEqual(done.durationMs, 8889, 'the done carries the time Codex reported for turn 2');
  });

  test('each turn\'s done carries the time Codex reported for it', async () => {
    const server = newClient();
    const first = doneOf(await replay(one.notifications, { server, ...one }));
    const second = doneOf(await replay(two.notifications, { server, ...two }));
    assert.strictEqual(first.durationMs, 14779);
    assert.strictEqual(second.durationMs, 8889);
  });

  test('the captured times are drawn as "Worked 14 s" and "Worked 8 s"', async () => {
    const server = newClient();
    const first = doneOf(await replay(one.notifications, { server, ...one }));
    const second = doneOf(await replay(two.notifications, { server, ...two }));
    const dom = new JSDOM('<!doctype html><body></body>');
    global.window = dom.window;
    global.document = dom.window.document;
    const chat = require('../../public/views/chat.js');
    assert.strictEqual(typeof chat.buildActivitySummary, 'function');
    const line = (done) => {
      const drawn = chat.buildActivitySummary([], null, done.durationMs, done.usage, 'codex');
      assert.ok(drawn, 'a turn with no steps still draws the line');
      const words = drawn.querySelector('.turn-used-line');
      assert.ok(words, 'the line carries its words');
      return words.textContent;
    };
    assert.strictEqual(line(first), 'Worked 14 s');
    assert.strictEqual(line(second), 'Worked 8 s');
  });
});

describe('synthetic updates', () => {
  test('a repeated update is counted once, and only the counts it carried are kept', async () => {
    const done = doneOf(await replay([
      update('t1', 940, { inputTokens: 900, outputTokens: 40 }),
      update('t1', 940, { inputTokens: 900, outputTokens: 40 }),
      completed('t1', 100),
    ], { threadId: THREAD, turnId: 't1' }));
    assert.deepStrictEqual(done.usage, { inputTokens: 900, outputTokens: 40 });
  });

  test('two calls in one turn are added together', async () => {
    const done = doneOf(await replay([
      update('t1', 940, { inputTokens: 900, outputTokens: 40 }),
      update('t1', 1360, { inputTokens: 400, outputTokens: 20 }),
      completed('t1', 100),
    ], { threadId: THREAD, turnId: 't1' }));
    assert.deepStrictEqual(done.usage, { inputTokens: 1300, outputTokens: 60 });
  });

  test('two turns with the same numbers each count their own update and carry their own time', async () => {
    const server = newClient();
    const first = doneOf(await replay([P.tokenUsageUpdated(THREAD, 't1'), P.turnCompleted(THREAD, 't1')], { server, threadId: THREAD, turnId: 't1' }));
    const second = doneOf(await replay([P.tokenUsageUpdated(THREAD, 't2'), P.turnCompleted(THREAD, 't2')], { server, threadId: THREAD, turnId: 't2' }));
    const fixture = { inputTokens: 100, cachedInputTokens: 0, outputTokens: 50, reasoningOutputTokens: 0 };
    assert.deepStrictEqual(first.usage, fixture);
    assert.deepStrictEqual(second.usage, fixture);
    assert.strictEqual(first.durationMs, P.turnCompleted(THREAD, 't1').params.turn.durationMs, 'turn 1 carries the time on its turn/completed');
    assert.strictEqual(second.durationMs, P.turnCompleted(THREAD, 't2').params.turn.durationMs, 'turn 2 carries the time on its own turn/completed');
  });

  test('a turn with no update finishes with no usage, never zeros', async () => {
    const done = doneOf(await replay([completed('t1', 100)], { threadId: THREAD, turnId: 't1' }));
    assert.strictEqual(done.usage, null);
    assert.strictEqual(done.durationMs, 100);
  });

  test('a count the server sent as text is not added', async () => {
    const done = doneOf(await replay([
      update('t1', 940, { inputTokens: '900', outputTokens: 40 }),
      completed('t1', 100),
    ], { threadId: THREAD, turnId: 't1' }));
    assert.deepStrictEqual(done.usage, { outputTokens: 40 });
  });
});

describe('the time when Codex sends none', () => {
  test('a missing durationMs gives the time measured from the turn\'s start', () => withClock(async (move) => {
    const server = newClient();
    const events = await startTurn(server, THREAD, 't1');
    move(245000);
    server._onNotification('turn/completed', completed('t1').params);
    assert.strictEqual(doneOf(events).durationMs, 245000);
  }));

  for (const [label, bad] of [['the string "14779"', '14779'], ['-1', -1], ['1.5', 1.5], ['1e400', 1e400], ['null', null]]) {
    test(`a durationMs of ${label} gives the measured time`, () => withClock(async (move) => {
      const server = newClient();
      const events = await startTurn(server, THREAD, 't1');
      move(245000);
      server._onNotification('turn/completed', completed('t1', bad).params);
      assert.strictEqual(doneOf(events).durationMs, 245000);
    }));
  }

  test('the measured time starts at each turn\'s own start', () => withClock(async (move) => {
    const server = newClient();
    const first = await startTurn(server, THREAD, 't1');
    move(60000);
    server._onNotification('turn/completed', completed('t1').params);
    move(30000);
    const second = await startTurn(server, THREAD, 't2');
    move(12000);
    server._onNotification('turn/completed', completed('t2').params);
    assert.strictEqual(doneOf(first).durationMs, 60000);
    assert.strictEqual(doneOf(second).durationMs, 12000);
  }));
});
