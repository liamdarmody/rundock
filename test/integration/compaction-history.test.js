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
const { agentFile, standardTeam } = require('../helpers/workspace.js');
const { seedSummarisedConversation, SUMMARY_ONLY_WORD, BOUNDARY_UUID } = require('../helpers/compaction-seed.js');

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
