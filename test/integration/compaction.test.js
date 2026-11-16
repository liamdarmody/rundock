'use strict';
// A conversation summarised to make room, through the real server and both
// stub runtimes: what each runtime's summary sends to the window, what text
// that only looks like one sends, and what a stopped or superseded Codex turn
// sends.
//
// Every assertion about what the window would draw runs the messages the
// window was actually sent through its own reducer
// (public/conversation-state.js), in order, as app.js does.
const { test, describe, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../helpers/harness.js');
const { agentFile, standardTeam } = require('../helpers/workspace.js');
const { createState, reduce } = require('../../public/conversation-state.js');

const CAPTURE = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'compaction', 'claude-compact.jsonl'), 'utf8')
  .trim().split('\n').map((l) => JSON.parse(l));
const BOUNDARY = CAPTURE.find((l) => l.subtype === 'compact_boundary');
// The summary as Claude Code reported it, minus its repeated init and the
// slash command's own result: what a summary inside a turn writes.
const SUMMARY_LINES = CAPTURE.filter((l) => !(l.type === 'system' && l.subtype === 'init') && l.type !== 'result');

const WORDS = 'Earlier messages were summarised to make room. Summarising earlier messages…';
const LOOK_ALIKE = [
  WORDS,
  JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: 'fake-boundary' }),
  JSON.stringify({ type: 'system', subtype: 'status', status: 'compacting' }),
  JSON.stringify({ method: 'thread/compacted', params: { threadId: 'x', turnId: 'y' } }),
  JSON.stringify({ method: 'item/completed', params: { item: { type: 'contextCompaction', id: 'z' } } }),
].join('\n');

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

const sentFor = (convoId, since = 0) => client.messages.slice(since).filter((m) => m._conversationId === convoId);
const summaryLines = (msgs) => msgs.filter((m) => m.type === 'system' && (m.subtype === 'status' || m.subtype === 'compact_boundary'));

// The window's own decisions over what it was sent, keeping the summaries it
// has drawn as app.js does, so a repeat is measured too.
function windowDraws(msgs) {
  let state = createState();
  const keys = [];
  const effects = [];
  for (const m of msgs) {
    const out = reduce(state, m, { isActive: true, convoAgentId: m._agent, knownCompactionKeys: keys.slice() });
    state = out.state;
    for (const e of out.effects) {
      if (e.type === 'insert-compaction-divider') keys.push(e.key);
      if (['show-summarising', 'insert-compaction-divider', 'clear-summarising'].includes(e.type)) effects.push(e);
    }
  }
  return effects;
}

describe('a Claude Code summary', () => {
  test('reaches the window as Claude Code wrote it: the start, then the boundary with its uuid, and one divider', async () => {
    const convoId = open('cmp-claude');
    h.writeScenario([{ match: { promptIncludes: 'CLAUDE-SUMMARY' }, turn: [...SUMMARY_LINES.map((raw) => ({ raw })), { text: 'Carrying on.' }] }]);
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'example-writer', content: 'CLAUDE-SUMMARY go' });
    await client.waitForEvent('system', 'done', convoId, { since });
    const msgs = sentFor(convoId, since);
    const lines = summaryLines(msgs);
    assert.deepStrictEqual(lines.map((m) => [m.subtype, m.status === undefined ? m.uuid : m.status]), [
      ['status', 'compacting'], ['status', null], ['compact_boundary', BOUNDARY.uuid],
    ]);
    assert.strictEqual(lines[2]._agent, 'example-writer');
    assert.deepStrictEqual(windowDraws(msgs).map((e) => e.type), ['show-summarising', 'insert-compaction-divider']);
  });

  test('its words and its event, in a reply, a tool result and the person\'s own message, send no summary line', async () => {
    const convoId = open('cmp-claude-look');
    h.writeScenario([{ match: { promptIncludes: 'CLAUDE-LOOKALIKE' }, turn: [
      { tool: { name: 'Read', input: { file_path: 'notes.md' } } },
      { raw: { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_example', content: LOOK_ALIKE }] } } },
      { text: LOOK_ALIKE },
    ] }]);
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'example-writer', content: `CLAUDE-LOOKALIKE ${LOOK_ALIKE}` });
    await client.waitForEvent('system', 'done', convoId, { since });
    const msgs = sentFor(convoId, since);
    assert.ok(msgs.some((m) => JSON.stringify(m).includes('fake-boundary')), 'the look-alike did reach the window, as text');
    assert.deepStrictEqual(summaryLines(msgs), []);
    assert.deepStrictEqual(windowDraws(msgs), []);
  });
});

describe('a Codex summary', () => {
  test('is sent on in the shapes Claude Code uses: the start, then a boundary keyed by the item, once for both records', async () => {
    const convoId = open('cmp-codex');
    h.writeCodexScenario([{ match: { promptIncludes: 'CODEX-SUMMARY' }, deltas: ['Carrying on.'], compaction: { notice: true, duplicate: true } }]);
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'example-codex', content: 'CODEX-SUMMARY go' });
    await client.waitForEvent('system', 'done', convoId, { since });
    const msgs = sentFor(convoId, since);
    const lines = summaryLines(msgs);
    assert.deepStrictEqual(lines.map((m) => m.subtype), ['status', 'compact_boundary']);
    assert.strictEqual(lines[0].status, 'compacting');
    assert.match(lines[1].uuid, /^cmp_/);
    assert.strictEqual(lines[1]._agent, 'example-codex');
    const started = msgs.find((m) => m.type === 'system' && m.subtype === 'process_started');
    assert.strictEqual(lines[1]._processId, started._processId, 'tagged with the turn that owns the conversation');
    assert.deepStrictEqual(windowDraws(msgs).map((e) => e.type), ['show-summarising', 'insert-compaction-divider']);
  });

  test('its words and either runtime\'s event in a Codex reply send no summary line', async () => {
    const convoId = open('cmp-codex-look');
    h.writeCodexScenario([{ match: { promptIncludes: 'CODEX-LOOKALIKE' }, deltas: [LOOK_ALIKE] }]);
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'example-codex', content: `CODEX-LOOKALIKE ${LOOK_ALIKE}` });
    await client.waitForEvent('system', 'done', convoId, { since });
    const msgs = sentFor(convoId, since);
    assert.deepStrictEqual(summaryLines(msgs), []);
    assert.deepStrictEqual(windowDraws(msgs), []);
  });

  // The stub's zombie turn: the interrupt is accepted, and the turn carries on
  // in the background and summarises after it was stopped or replaced.
  test('a stopped turn\'s summary is not sent', async () => {
    const convoId = open('cmp-codex-stop');
    h.writeCodexScenario([{ match: { promptIncludes: 'CODEX-STOPPED' }, deltas: ['one ', 'two ', 'three'], holdForInterrupt: true, compaction: { afterDeltas: 2 } }],
      { zombieInterrupt: { resumeDelayMs: 200 } });
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'example-codex', content: 'CODEX-STOPPED go' });
    await client.waitFor((m) => m.type === 'stream_event' && m._conversationId === convoId, { since, label: 'first delta' });
    client.send({ type: 'cancel', conversationId: convoId });
    await client.waitForEvent('system', 'cancelled', convoId, { since });
    await h.waitUntil(() => h.readInvocations().some((i) => i.mode === 'app-server' && i.method === 'turn/interrupt'), { timeout: 5000 });
    await h.delay(800);
    assert.deepStrictEqual(summaryLines(sentFor(convoId, since)), []);
  });

  test('a superseded turn\'s summary is not sent, and the turn that replaced it carries on', async () => {
    const convoId = open('cmp-codex-super');
    h.writeCodexScenario([
      { match: { promptIncludes: 'CODEX-FIRST' }, deltas: ['one ', 'two ', 'three'], holdForInterrupt: true, compaction: { afterDeltas: 2 } },
      { match: { promptIncludes: 'CODEX-SECOND' }, text: 'Second answer.' },
    ], { zombieInterrupt: { resumeDelayMs: 200 } });
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'example-codex', content: 'CODEX-FIRST go' });
    const { msg: init } = await client.waitForEvent('system', 'init', convoId, { since });
    await client.waitFor((m) => m.type === 'stream_event' && m._conversationId === convoId, { since, label: 'first delta' });
    client.send({ type: 'chat', conversationId: convoId, agent: 'example-codex', content: 'CODEX-SECOND go', sessionId: init._sessionId });
    const { msg: result } = await client.waitFor((m) => m.type === 'result' && m._conversationId === convoId, { since, timeout: 15000, label: 'second result' });
    assert.strictEqual(result.result, 'Second answer.');
    await h.delay(300);
    assert.deepStrictEqual(summaryLines(sentFor(convoId, since)), []);
  });
});

// What the conversation keeps of a summary: its own transcript entry, keyed
// as the window was sent it, between the person's message and the reply the
// summary fell inside, since a reply is kept whole when its turn ends.
const kept = (convoId) => h.internal.loadTranscript(convoId)
  .map((t) => (t.type === 'compaction' ? ['compaction', t.key, t.text] : [t.role, t.text]));
const keptSummaries = (convoId) => kept(convoId).filter((t) => t[0] === 'compaction');

describe('what the conversation keeps', () => {
  test('a Claude Code summary inside a reply is kept between the message and that reply, under the boundary\'s uuid', async () => {
    const convoId = open('cmp-keep-claude');
    h.writeScenario([{ match: { promptIncludes: 'CLAUDE-KEEP' }, turn: [{ text: 'Before the summary. ' }, ...SUMMARY_LINES.map((raw) => ({ raw })), { text: 'After it.' }] }]);
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'example-writer', content: 'CLAUDE-KEEP go' });
    await client.waitForEvent('system', 'done', convoId, { since });
    const out = kept(convoId);
    assert.deepStrictEqual(out.map((t) => t[0]), ['user', 'compaction', 'agent']);
    assert.deepStrictEqual(out[1], ['compaction', BOUNDARY.uuid, '']);
    assert.match(out[2][1], /After it\./);
  });

  test('a boundary Claude Code repeats is kept once; two summaries are kept twice, in order', async () => {
    const convoId = open('cmp-keep-twice');
    const second = { ...BOUNDARY, uuid: '00000000-0000-4000-8000-0b0000000002' };
    h.writeScenario([
      { match: { promptIncludes: 'CLAUDE-REPEAT' }, turn: [{ raw: BOUNDARY }, { raw: BOUNDARY }, { text: 'One.' }] },
      { match: { promptIncludes: 'CLAUDE-AGAIN' }, turn: [{ raw: second }, { text: 'Two.' }] },
    ]);
    let since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'example-writer', content: 'CLAUDE-REPEAT go' });
    await client.waitForEvent('system', 'done', convoId, { since });
    since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'example-writer', content: 'CLAUDE-AGAIN go' });
    await client.waitForEvent('system', 'done', convoId, { since });
    assert.deepStrictEqual(kept(convoId).map((t) => (t[0] === 'compaction' ? t[1] : t[0])),
      ['user', BOUNDARY.uuid, 'agent', 'user', second.uuid, 'agent']);
  });

  test('a Codex summary is kept once for both records, between the message and the reply', async () => {
    const convoId = open('cmp-keep-codex');
    h.writeCodexScenario([{ match: { promptIncludes: 'CODEX-KEEP' }, deltas: ['Carrying on.'], compaction: { notice: true, duplicate: true } }]);
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'example-codex', content: 'CODEX-KEEP go' });
    await client.waitForEvent('system', 'done', convoId, { since });
    const boundary = summaryLines(sentFor(convoId, since)).find((m) => m.subtype === 'compact_boundary');
    const out = kept(convoId);
    assert.deepStrictEqual(out.map((t) => t[0]), ['user', 'compaction', 'agent']);
    assert.deepStrictEqual(out[1], ['compaction', boundary.uuid, '']);
  });

  test('look-alikes in either runtime keep nothing', async () => {
    const claudeId = open('cmp-keep-look');
    const codexId = open('cmp-keep-look-cx');
    h.writeScenario([{ match: { promptIncludes: 'CLAUDE-LOOKALIKE' }, turn: [{ text: LOOK_ALIKE }] }]);
    h.writeCodexScenario([{ match: { promptIncludes: 'CODEX-LOOKALIKE' }, deltas: [LOOK_ALIKE] }]);
    let since = client.messages.length;
    client.send({ type: 'chat', conversationId: claudeId, agent: 'example-writer', content: `CLAUDE-LOOKALIKE ${LOOK_ALIKE}` });
    await client.waitForEvent('system', 'done', claudeId, { since });
    since = client.messages.length;
    client.send({ type: 'chat', conversationId: codexId, agent: 'example-codex', content: `CODEX-LOOKALIKE ${LOOK_ALIKE}` });
    await client.waitForEvent('system', 'done', codexId, { since });
    assert.deepStrictEqual(keptSummaries(claudeId), []);
    assert.deepStrictEqual(keptSummaries(codexId), []);
  });

  test('a stopped Codex turn\'s summary is not kept', async () => {
    const convoId = open('cmp-keep-stop');
    h.writeCodexScenario([{ match: { promptIncludes: 'CODEX-STOPKEEP' }, deltas: ['one ', 'two ', 'three'], holdForInterrupt: true, compaction: { afterDeltas: 2 } }],
      { zombieInterrupt: { resumeDelayMs: 200 } });
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'example-codex', content: 'CODEX-STOPKEEP go' });
    await client.waitFor((m) => m.type === 'stream_event' && m._conversationId === convoId, { since, label: 'first delta' });
    client.send({ type: 'cancel', conversationId: convoId });
    await client.waitForEvent('system', 'cancelled', convoId, { since });
    await h.waitUntil(() => h.readInvocations().some((i) => i.mode === 'app-server' && i.method === 'turn/interrupt'), { timeout: 5000 });
    await h.delay(800);
    assert.deepStrictEqual(keptSummaries(convoId), []);
  });

  test('a superseded Codex turn\'s summary is not kept', async () => {
    const convoId = open('cmp-keep-super');
    h.writeCodexScenario([
      { match: { promptIncludes: 'CODEX-FIRSTKEEP' }, deltas: ['one ', 'two ', 'three'], holdForInterrupt: true, compaction: { afterDeltas: 2 } },
      { match: { promptIncludes: 'CODEX-SECONDKEEP' }, text: 'Second answer.' },
    ], { zombieInterrupt: { resumeDelayMs: 200 } });
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'example-codex', content: 'CODEX-FIRSTKEEP go' });
    const { msg: init } = await client.waitForEvent('system', 'init', convoId, { since });
    await client.waitFor((m) => m.type === 'stream_event' && m._conversationId === convoId, { since, label: 'first delta' });
    client.send({ type: 'chat', conversationId: convoId, agent: 'example-codex', content: 'CODEX-SECONDKEEP go', sessionId: init._sessionId });
    await client.waitFor((m) => m.type === 'result' && m._conversationId === convoId, { since, timeout: 15000, label: 'second result' });
    await h.delay(300);
    assert.deepStrictEqual(keptSummaries(convoId), []);
  });
});
