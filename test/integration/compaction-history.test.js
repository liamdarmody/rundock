'use strict';
// A conversation summarised to make room, reopened: what the history handler
// gives the window for each runtime, after a live run through the stub
// runtimes and from a Claude Code session file holding the summary as Claude
// Code keeps it.
const { test, describe, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../helpers/harness.js');
const glue = require('../../lib/runtime/codex-glue.js');
const P = require('../fixtures/codex-appserver-protocol.js');
const { agentFile, standardTeam } = require('../helpers/workspace.js');
const { seedSummarisedConversation, SUMMARY_ONLY_WORD, BOUNDARY_UUID, seedCapturedSession, CAPTURED_SUMMARY_WORD } = require('../helpers/compaction-seed.js');

const CAPTURE = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'compaction', 'claude-compact.jsonl'), 'utf8')
  .trim().split('\n').map((l) => JSON.parse(l));
const BOUNDARY = CAPTURE.find((l) => l.subtype === 'compact_boundary');
const SUMMARY_LINES = CAPTURE.filter((l) => !(l.type === 'system' && l.subtype === 'init') && l.type !== 'result');

let client;
before(async () => {
  await h.boot({ agents: {
    ...standardTeam(),
    'example-writer': agentFile({ name: 'example-writer', displayName: 'Alpha', role: 'Writer', type: 'specialist', order: 7, body: 'You are Alpha.' }),
    'example-codex': agentFile({ name: 'example-codex', displayName: 'Beta', role: 'Researcher', type: 'specialist', order: 8, runtime: 'codex', body: 'You are Beta.' }),
  } });
  client = await h.connect();
});
after(async () => h.shutdown());

const opened = new Set();
const open = (prefix) => { const id = h.freshConvoId(prefix); opened.add(id); return id; };
afterEach(() => { for (const id of opened) h.reapConvo(id); opened.clear(); });

async function chat(convoId, agent, content) {
  const since = client.messages.length;
  client.send({ type: 'chat', conversationId: convoId, agent, content });
  await client.waitForEvent('system', 'done', convoId, { since });
}

async function reopen(convoId, sessionIds = [], via = client) {
  const since = via.messages.length;
  via.send({ type: 'get_session_history', conversationId: convoId, sessionIds, limit: 200 });
  const { msg } = await via.waitFor((m) => m.type === 'session_history' && m.conversationId === convoId, { since, label: 'session_history' });
  return msg;
}

// Each entry as the window reads it: a divider by its key, a message by its
// role and its words, whitespace folded (a reply's stretches are kept on lines
// of their own).
const shape = (history) => history.messages.map((m) => (m.type === 'compaction'
  ? ['divider', m.key, m.content]
  : [m.role, m.content.replace(/\s+/g, ' ').trim()]));

describe('a Claude Code conversation', () => {
  test('a summary inside a reply is drawn after the message and before that reply, every time it is reopened', async () => {
    const convoId = open('cmph-claude');
    h.writeScenario([{ match: { promptIncludes: 'HIST-CLAUDE' }, turn: [{ text: 'Before. ' }, ...SUMMARY_LINES.map((raw) => ({ raw })), { text: 'After.' }] }]);
    await chat(convoId, 'example-writer', 'HIST-CLAUDE go');
    const expected = [['user', 'HIST-CLAUDE go'], ['divider', BOUNDARY.uuid, ''], ['assistant', 'Before. After.']];
    assert.deepStrictEqual(shape(await reopen(convoId)), expected);
    assert.deepStrictEqual(shape(await reopen(convoId)), expected, 'reopened again: still one divider');
    const after = await h.connect();
    try {
      assert.deepStrictEqual(shape(await reopen(convoId, [], after)), expected, 'from a window that connected afterwards');
    } finally { after.close(); }
  });

  test('two summaries are two dividers, in order, each where it fell', async () => {
    const convoId = open('cmph-claude-two');
    const second = { ...BOUNDARY, uuid: '00000000-0000-4000-8000-0b0000000002' };
    h.writeScenario([
      { match: { promptIncludes: 'HIST-ONE' }, turn: [{ raw: BOUNDARY }, { raw: BOUNDARY }, { text: 'One.' }] },
      { match: { promptIncludes: 'HIST-TWO' }, turn: [{ raw: second }, { text: 'Two.' }] },
    ]);
    await chat(convoId, 'example-writer', 'HIST-ONE go');
    await chat(convoId, 'example-writer', 'HIST-TWO go');
    assert.deepStrictEqual(shape(await reopen(convoId)), [
      ['user', 'HIST-ONE go'], ['divider', BOUNDARY.uuid, ''], ['assistant', 'One.'],
      ['user', 'HIST-TWO go'], ['divider', second.uuid, ''], ['assistant', 'Two.'],
    ]);
  });

  test('from the session file: the divider between the same two messages, and the summary never shown', async () => {
    const convoId = open('cmph-seeded');
    seedSummarisedConversation(h, { convoId, sessionId: 'sess-cmph-seeded', agentId: 'example-writer' });
    h.internal.convoTranscripts.delete(convoId);
    const history = await reopen(convoId, [{ sessionId: 'sess-cmph-seeded', agentId: 'example-writer' }]);
    assert.deepStrictEqual(shape(history).map((e) => e[0]), ['user', 'assistant', 'divider', 'user', 'assistant']);
    assert.strictEqual(history.messages[2].key, BOUNDARY_UUID);
    assert.ok(!JSON.stringify(history).includes(SUMMARY_ONLY_WORD), 'the summary\'s text is nowhere in the history (main already hides it)');
  });

  test('from the session file Claude Code kept: the divider where the transcript puts it, and the summary never shown, with the transcript or from the file alone', async () => {
    const convoId = open('cmph-captured');
    const { sessionId, boundaryUuid } = seedCapturedSession(h, { convoId, agentId: 'example-writer' });
    h.internal.convoTranscripts.delete(convoId);
    const sessions = [{ sessionId, agentId: 'example-writer' }];
    const history = await reopen(convoId, sessions);
    assert.deepStrictEqual(shape(history), [
      ['user', 'Reply with the single word ready.'], ['assistant', 'ready'], ['divider', boundaryUuid, ''],
      ['user', 'Reply with the single word done.'], ['assistant', 'done'],
    ]);
    assert.ok(!JSON.stringify(history).includes(CAPTURED_SUMMARY_WORD), 'with the transcript (main already hides it)');
    // With no transcript, the file's own lines are the history, and only how
    // they are marked keeps the summary out.
    fs.rmSync(path.join(h.workspaceDir, '.rundock', 'transcripts', `${convoId}.json`));
    h.internal.convoTranscripts.delete(convoId);
    assert.ok(!JSON.stringify(await reopen(convoId, sessions)).includes(CAPTURED_SUMMARY_WORD), 'from the file alone (main already hides it)');
  });
});

describe('a Codex conversation', () => {
  test('a summary is drawn after the message and before the reply, once for both records, every time it is reopened', async () => {
    const convoId = open('cmph-codex');
    h.writeCodexScenario([{ match: { promptIncludes: 'HIST-CODEX' }, deltas: ['Carrying on.'], compaction: { notice: true, duplicate: true } }]);
    await chat(convoId, 'example-codex', 'HIST-CODEX go');
    const first = shape(await reopen(convoId));
    assert.deepStrictEqual(first.map((e) => e[0]), ['user', 'divider', 'assistant']);
    assert.match(first[1][1], /^cmp_/);
    assert.strictEqual(first[1][2], '');
    assert.deepStrictEqual(shape(await reopen(convoId)), first, 'reopened again: still one divider');
  });

  test('two summaries in one turn are two dividers, in order, before the reply', async () => {
    const convoId = open('cmph-codex-two');
    h.writeCodexScenario([{ match: { promptIncludes: 'HIST-CODEX-TWO' }, deltas: ['Carrying on.'], compaction: { count: 2 } }]);
    await chat(convoId, 'example-codex', 'HIST-CODEX-TWO go');
    const out = shape(await reopen(convoId));
    assert.deepStrictEqual(out.map((e) => e[0]), ['user', 'divider', 'divider', 'assistant']);
    assert.notStrictEqual(out[1][1], out[2][1]);
  });

  test('the older notice sent twice for one summary, with its item and without: one event, one kept entry, one divider, every time it is reopened', async () => {
    for (const [name, compaction] of [['with its item', { notice: 2 }], ['without its item', { item: false, notice: 2 }]]) {
      const convoId = open('cmph-codex-notice');
      h.writeCodexScenario([{ match: { promptIncludes: 'HIST-CODEX-NOTICE' }, deltas: ['Carrying on.'], compaction }]);
      const since = client.messages.length;
      await chat(convoId, 'example-codex', 'HIST-CODEX-NOTICE go');
      const sent = client.messages.slice(since).filter((m) => m._conversationId === convoId && m.subtype === 'compact_boundary');
      assert.strictEqual(sent.length, 1, `${name}: one event`);
      const kept = h.internal.loadTranscript(convoId).filter((t) => t.type === 'compaction');
      assert.deepStrictEqual(kept.map((t) => t.key), [sent[0].uuid], `${name}: one entry kept, under the event's key`);
      const expected = [['user', 'HIST-CODEX-NOTICE go'], ['divider', sent[0].uuid, ''], ['assistant', 'Carrying on.']];
      assert.deepStrictEqual(shape(await reopen(convoId)), expected, name);
      assert.deepStrictEqual(shape(await reopen(convoId)), expected, `${name}: reopened again`);
    }
  });

  test('two summaries, each with its notice sent twice, are still two dividers, keyed by their items', async () => {
    const convoId = open('cmph-codex-notice-two');
    h.writeCodexScenario([{ match: { promptIncludes: 'HIST-CODEX-NOTICE-TWO' }, deltas: ['Carrying on.'], compaction: { count: 2, notice: 2 } }]);
    await chat(convoId, 'example-codex', 'HIST-CODEX-NOTICE-TWO go');
    const out = shape(await reopen(convoId));
    assert.deepStrictEqual(out.map((e) => e[0]), ['user', 'divider', 'divider', 'assistant']);
    assert.match(out[1][1], /^cmp_.*_0$/);
    assert.match(out[2][1], /^cmp_.*_1$/);
  });
});

// A Codex turn of Rundock's whose records come from a list instead of the
// stub: thread/start, thread/resume and turn/start are answered in-process
// with the given thread and turn ids, and the records go into the real
// protocol client as the server would send them, so the client's routing, the
// glue, the stored transcript and the history handler are the path a live
// turn takes. A later turn sends back the thread the window was told about,
// as the window does, and resumes it. Returns what the window was sent for the
// conversation.
async function scriptedTurn(convoId, prompt, { threadId, turnId, notifications }, { resume = null } = {}) {
  const server = await glue.getCodexAppServer();
  const request = server.request;
  const opened = [];
  server.request = async (method, params, opts) => {
    if (method === 'thread/start' || method === 'thread/resume') { opened.push([method, params.threadId]); return { thread: { id: threadId } }; }
    if (method === 'turn/start') return { turn: { id: turnId } };
    return request.call(server, method, params, opts);
  };
  const since = client.messages.length;
  try {
    client.send({ type: 'chat', conversationId: convoId, agent: 'example-codex', content: prompt, ...(resume ? { sessionId: resume } : {}) });
    let state = null;
    assert.ok(await h.waitUntil(() => (state = server._activeTurns.get(threadId)) && state.turnId === turnId), 'the turn runs under the given ids');
    for (const n of notifications) server._onNotification(n.method, n.params);
    await client.waitForEvent('system', 'done', convoId, { since });
  } finally {
    delete server.request;
  }
  assert.deepStrictEqual(opened, [resume ? ['thread/resume', resume] : ['thread/start', undefined]], 'the thread opened as the window asked');
  return client.messages.slice(since).filter((m) => m._conversationId === convoId);
}

// What the window was shown live: how many times the summarising state, and
// the dividers sent, by key.
const live = (sent) => ({
  summarising: sent.filter((m) => m.subtype === 'status' && m.status === 'compacting').length,
  dividers: sent.filter((m) => m.subtype === 'compact_boundary').map((m) => m.uuid),
});
const keptKeys = (convoId) => h.internal.loadTranscript(convoId).filter((t) => t.type === 'compaction').map((t) => t.key);

// Every turn Rundock started in a capture: the notifications the server sent
// after Rundock's turn/start until the capture's next marker, and the thread
// and turn they name.
function capturedTurns(file) {
  const lines = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'compaction', file), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
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

// The ids codex-auto-compact.jsonl was captured with: one thread, two turns
// Rundock started, a summary inside each.
const CAPTURED_THREAD = '00000000-0000-4000-8000-020000000001';
const CAPTURED_TURNS = ['00000000-0000-4000-8000-030000000001', '00000000-0000-4000-8000-030000000002'];
const CAPTURED_ITEMS = ['00000000-0000-4000-8000-040000000004', '00000000-0000-4000-8000-040000000006'];

describe('a summary Codex ran inside a turn of Rundock\'s, as captured', () => {
  test('both captured turns, with the thread and turn ids they were captured with: for each summary, one live state, one divider sent, one entry kept, and its divider on every reopen', async () => {
    const convoId = open('cmph-codex-captured');
    const turns = capturedTurns('codex-auto-compact.jsonl');
    assert.deepStrictEqual(turns.map((t) => [t.threadId, t.turnId]), CAPTURED_TURNS.map((id) => [CAPTURED_THREAD, id]), 'the ids as captured');
    let resume = null;
    for (const [i, turn] of turns.entries()) {
      const sent = await scriptedTurn(convoId, `CAPTURED-${i + 1} go`, turn, { resume });
      resume = sent.find((m) => m.subtype === 'init')._sessionId;
      assert.strictEqual(resume, CAPTURED_THREAD, `turn ${i + 1}: the captured thread`);
      assert.deepStrictEqual(live(sent), { summarising: 1, dividers: [CAPTURED_ITEMS[i]] }, `turn ${i + 1}`);
      assert.deepStrictEqual(keptKeys(convoId), CAPTURED_ITEMS.slice(0, i + 1), `turn ${i + 1}: the entry kept`);
    }
    const expected = [
      ['user', 'CAPTURED-1 go'], ['divider', CAPTURED_ITEMS[0], ''], ['assistant', 'ready done'],
      ['user', 'CAPTURED-2 go'], ['divider', CAPTURED_ITEMS[1], ''], ['assistant', 'okay'],
    ];
    assert.deepStrictEqual(shape(await reopen(convoId)), expected);
    assert.deepStrictEqual(shape(await reopen(convoId)), expected, 'reopened again: still one divider each');
  });
});

// A turn in the protocol's own shapes: the given records, then a well-formed
// summary, then the reply.
const summaryItem = (threadId, turnId, id) => [P.itemStartedContextCompaction(threadId, turnId, id), P.itemCompletedContextCompaction(threadId, turnId, id)];
const reply = (threadId, turnId, itemId, text) => [
  P.itemStartedAgentMessage(threadId, turnId, itemId), P.agentMessageDelta(threadId, turnId, itemId, text), P.itemCompletedAgentMessage(threadId, turnId, itemId, text),
];
const turnWith = (threadId, turnId, records) => ({ threadId, turnId, notifications: [
  P.turnStarted(threadId, turnId), ...records, ...summaryItem(threadId, turnId, 'c1'), ...reply(threadId, turnId, 'msg-1', 'Still here.'), P.turnCompleted(threadId, turnId),
] });
const noTurnId = (record) => { const params = { ...record.params }; delete params.turnId; return { method: record.method, params }; };

describe('summary records that do not name the running turn by a nonempty id', () => {
  const cases = {
    'a summary item started with no turn id': (th, tu) => [noTurnId(summaryItem(th, tu, 'c1')[0])],
    'a summary item finished with no turn id': (th, tu) => [noTurnId(summaryItem(th, tu, 'c1')[1])],
    'a summary item and its notice naming another turn': (th) => [...summaryItem(th, 'turn-other', 'c1'), P.threadCompacted(th, 'turn-other')],
  };
  for (const [name, records] of Object.entries(cases)) {
    test(`${name}: no live state, no divider sent, nothing kept, and a summary that follows draws exactly one, on every reopen`, async () => {
      const convoId = open('cmph-codex-unnamed');
      const threadId = `thread-${convoId}`;
      const turnId = `turn-${convoId}`;
      const sent = await scriptedTurn(convoId, 'UNNAMED go', turnWith(threadId, turnId, records(threadId, turnId)));
      assert.deepStrictEqual(live(sent), { summarising: 1, dividers: ['c1'] });
      assert.deepStrictEqual(keptKeys(convoId), ['c1']);
      const expected = [['user', 'UNNAMED go'], ['divider', 'c1', ''], ['assistant', 'Still here.']];
      assert.deepStrictEqual(shape(await reopen(convoId)), expected);
      assert.deepStrictEqual(shape(await reopen(convoId)), expected, 'reopened again');
    });
  }

  test('a turn whose id is empty, its summary records naming that empty id: no live state, no divider sent, nothing kept, and a summary in the next turn draws exactly one, on every reopen', async () => {
    const convoId = open('cmph-codex-empty');
    const threadId = `thread-${convoId}`;
    const first = await scriptedTurn(convoId, 'EMPTY-1 go', { threadId, turnId: '', notifications: [
      P.turnStarted(threadId, ''), ...summaryItem(threadId, '', 'c1'), P.threadCompacted(threadId, ''),
      ...reply(threadId, '', 'msg-0', 'First.'), P.turnCompleted(threadId, ''),
    ] });
    assert.deepStrictEqual(live(first), { summarising: 0, dividers: [] });
    assert.deepStrictEqual(keptKeys(convoId), []);
    const next = await scriptedTurn(convoId, 'EMPTY-2 go', turnWith(threadId, `turn-${convoId}`, []), { resume: threadId });
    assert.deepStrictEqual(live(next), { summarising: 1, dividers: ['c1'] });
    assert.deepStrictEqual(keptKeys(convoId), ['c1']);
    const expected = [['user', 'EMPTY-1 go'], ['assistant', 'First.'], ['user', 'EMPTY-2 go'], ['divider', 'c1', ''], ['assistant', 'Still here.']];
    assert.deepStrictEqual(shape(await reopen(convoId)), expected);
    assert.deepStrictEqual(shape(await reopen(convoId)), expected, 'reopened again');
  });
});

describe('summaries announced only by the older notice', () => {
  test('two in one turn, each notice sent twice, the reply carrying on between them: two dividers sent, in order, two entries kept, and both on every reopen', async () => {
    const convoId = open('cmph-codex-notices');
    const threadId = `thread-${convoId}`;
    const turnId = `turn-${convoId}`;
    const notice = P.threadCompacted(threadId, turnId);
    const sent = await scriptedTurn(convoId, 'NOTICES go', { threadId, turnId, notifications: [
      P.turnStarted(threadId, turnId),
      notice, notice,
      ...reply(threadId, turnId, 'msg-1', 'Between.'),
      notice, notice,
      ...reply(threadId, turnId, 'msg-2', 'After.'),
      P.turnCompleted(threadId, turnId),
    ] });
    const keys = [`${turnId}:compacted:1`, `${turnId}:compacted:2`];
    assert.deepStrictEqual(live(sent), { summarising: 0, dividers: keys });
    assert.deepStrictEqual(keptKeys(convoId), keys);
    const expected = [['user', 'NOTICES go'], ['divider', keys[0], ''], ['divider', keys[1], ''], ['assistant', 'Between. After.']];
    assert.deepStrictEqual(shape(await reopen(convoId)), expected);
    assert.deepStrictEqual(shape(await reopen(convoId)), expected, 'reopened again: still two dividers');
  });
});

// The summary Codex ran as a turn of its own when asked with
// thread/compact/start (test/fixtures/compaction/codex-compact.jsonl), which
// Rundock never sends: the notifications from that request to the next marker.
const COMPACT_TURN = (() => {
  const lines = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'compaction', 'codex-compact.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
  const asked = lines.findIndex((l) => l.dir === 'sent' && l.msg.method === 'thread/compact/start');
  const out = [];
  for (const line of lines.slice(asked + 1)) {
    if (line.dir === 'mark') break;
    if (line.dir === 'recv' && line.msg.method && line.msg.id == null) out.push(line.msg);
  }
  return out;
})();
// A record moved onto another thread, its turn left as captured.
function onThread(record, threadId) {
  const copy = JSON.parse(JSON.stringify(record));
  copy.params.threadId = threadId;
  return copy;
}

describe('a summary turn Rundock did not start', () => {
  // A Codex turn held open before its reply, the records sent into the real
  // protocol client while it waits, then let go.
  async function heldTurn(convoId, prompt, records) {
    const release = path.join(h.workspaceDir, `release-${convoId}`);
    h.writeCodexScenario([
      { match: { promptIncludes: `${prompt}-HELD` }, untilFile: release, deltas: ['Carrying on.'] },
      { match: { promptIncludes: `${prompt}-NEXT` }, deltas: ['Next answer.'] },
    ]);
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'example-codex', content: `${prompt}-HELD go` });
    const server = await glue.getCodexAppServer();
    let state = null;
    assert.ok(await h.waitUntil(() => (state = [...server._activeTurns.values()].find((s) => s.turnId && !s.finished))), 'the turn is running');
    for (const r of records(state)) server._onNotification(r.method, r.params);
    fs.writeFileSync(release, '');
    await client.waitForEvent('system', 'done', convoId, { since });
    return { server, threadId: state.threadId };
  }

  test('draws nothing: its records as Codex sent them, naming the turn Codex ran them in, during a turn of Rundock\'s on the same thread or between turns, and the next turn still works', async () => {
    const convoId = open('cmph-codex-foreign');
    const since = client.messages.length;
    const { server, threadId } = await heldTurn(convoId, 'HIST-FOREIGN', (s) => COMPACT_TURN.map((r) => onThread(r, s.threadId)));
    for (const r of COMPACT_TURN.map((rec) => onThread(rec, threadId))) server._onNotification(r.method, r.params);
    await chat(convoId, 'example-codex', 'HIST-FOREIGN-NEXT go');
    assert.deepStrictEqual(shape(await reopen(convoId)), [
      ['user', 'HIST-FOREIGN-HELD go'], ['assistant', 'Carrying on.'],
      ['user', 'HIST-FOREIGN-NEXT go'], ['assistant', 'Next answer.'],
    ]);
    assert.ok(!client.messages.slice(since).some((m) => m._conversationId === convoId && m.subtype === 'compact_boundary'), 'no divider sent to the window');
    assert.ok(!h.internal.loadTranscript(convoId).some((t) => t.type === 'compaction'), 'none kept');
  });
});

describe('what is never drawn', () => {
  test('an entry with no key, or a key already drawn, draws nothing, and an entry\'s text is never shown', async () => {
    const convoId = open('cmph-odd');
    const at = new Date().toISOString();
    h.internal.convoTranscripts.set(convoId, [
      { role: 'user', agent: 'user', text: 'A question', timestamp: at },
      { role: 'system', agent: null, text: 'SUMMARY-TEXT', type: 'compaction', key: 'k1', timestamp: at },
      { role: 'system', agent: null, text: '', type: 'compaction', key: 'k1', timestamp: at },
      { role: 'system', agent: null, text: '', type: 'compaction', timestamp: at },
      { role: 'system', agent: null, text: '', type: 'compaction', key: 42, timestamp: at },
      { role: 'agent', agent: 'example-writer', text: 'An answer', timestamp: at },
    ]);
    const history = await reopen(convoId);
    assert.deepStrictEqual(shape(history), [['user', 'A question'], ['divider', 'k1', ''], ['assistant', 'An answer']]);
    assert.ok(!JSON.stringify(history).includes('SUMMARY-TEXT'));
  });

  test('Codex summary records missing their fields, or naming no turn, draw nothing: the conversation carries on, every time it is reopened', async () => {
    const convoId = open('cmph-codex-odd');
    h.writeCodexScenario([{ match: { promptIncludes: 'HIST-CODEX-ODD' }, deltas: ['Still ', 'here.'], compaction: { malformed: true } }]);
    const since = client.messages.length;
    await chat(convoId, 'example-codex', 'HIST-CODEX-ODD go');
    const expected = [['user', 'HIST-CODEX-ODD go'], ['assistant', 'Still here.']];
    assert.deepStrictEqual(shape(await reopen(convoId)), expected);
    assert.deepStrictEqual(shape(await reopen(convoId)), expected, 'reopened again');
    assert.ok(!client.messages.slice(since).some((m) => m._conversationId === convoId && m.subtype === 'compact_boundary'), 'no divider sent to the window');
    assert.ok(!h.internal.loadTranscript(convoId).some((t) => t.type === 'compaction'), 'none kept');
  });

  test('a conversation never summarised has no divider', async () => {
    const convoId = open('cmph-plain');
    h.writeScenario([{ match: { promptIncludes: 'HIST-PLAIN' }, turn: [{ text: 'Just an answer.' }] }]);
    await chat(convoId, 'example-writer', 'HIST-PLAIN go');
    assert.deepStrictEqual(shape(await reopen(convoId)), [['user', 'HIST-PLAIN go'], ['assistant', 'Just an answer.']]);
  });
});
