'use strict';
// A conversation Claude Code summarised to make room, through the real
// server's search with the FTS index active, and its message count. The grep
// fallback has its own file (compaction-search-fallback.test.js), since the
// engine is chosen once per process.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');

const h = require('../helpers/harness.js');
const {
  seedSummarisedConversation, SUMMARY_ONLY_WORD, SHARED_WORD, DIVIDER_WORDS,
  seedCapturedSession, CAPTURED_SUMMARY_WORD, CAPTURED_PROMPT_WORDS,
  seedStreamSummarySession, STREAM_SUMMARY_WORD, STREAM_PROMPT_WORD,
} = require('../helpers/compaction-seed.js');

const probe = require('../../search.js').probeSqlite();
if (!probe.available) {
  require('node:test').test('summarised conversation search (skipped: no node:sqlite on this runtime)', { skip: true }, () => {});
  return;
}

const CONVO = 'cmp-search';
const CAPTURED = 'cmp-search-captured';
const STREAM = 'cmp-search-stream';
let client;
let seeded;
let streamSeeded;

async function search(query, convoId = CONVO) {
  const since = client.messages.length;
  client.send({ type: 'search_universal', query });
  const { msg } = await client.waitFor((m) => m.type === 'search_universal_results' && m.query === query, { since, label: 'search_universal_results' });
  return msg.groups.conversations.filter((c) => c.id === convoId);
}

before(async () => {
  await h.boot();
  seeded = seedSummarisedConversation(h, { convoId: CONVO, sessionId: 'sess-cmp-fts' });
  seedCapturedSession(h, { convoId: CAPTURED });
  streamSeeded = seedStreamSummarySession(h, { convoId: STREAM });
  client = await h.connect();
});
after(async () => h.shutdown());

describe('the index', () => {
  test('finds the conversation by what was said in it', async () => {
    const hits = await search(SHARED_WORD);
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].matchType, 'content');
    assert.ok(!(hits[0].snippet || '').includes(SUMMARY_ONLY_WORD));
  });

  test('never finds it by the summary Claude Code wrote', async () => {
    assert.deepStrictEqual(await search(SUMMARY_ONLY_WORD), [],
      'the summary is a hidden line nobody typed, and can repeat anything said earlier');
  });

  test('never finds it by the divider\'s words (main already behaves this way: they are drawn, never stored)', async () => {
    for (const words of DIVIDER_WORDS) assert.deepStrictEqual(await search(words), [], words);
  });
});

describe('the index, over the session file Claude Code kept', () => {
  test('finds the conversation by the prompts it was sent (main already behaves this way)', async () => {
    const hits = await search(CAPTURED_PROMPT_WORDS, CAPTURED);
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].matchType, 'content');
  });

  test('never finds it by the summary Claude Code wrote', async () => {
    assert.deepStrictEqual(await search(CAPTURED_SUMMARY_WORD, CAPTURED), []);
  });
});

describe('the index, over a session holding the summary as Claude Code\'s output stream carries it', () => {
  test('finds the conversation by an ordinary prompt in that session', async () => {
    const hits = await search(STREAM_PROMPT_WORD, STREAM);
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].matchType, 'content');
  });

  test('never finds it by the summary line, marked isSynthetic and not isCompactSummary', async () => {
    const { summary } = streamSeeded;
    assert.deepStrictEqual([summary.isSynthetic, summary.isCompactSummary], [true, undefined], 'the line as captured');
    assert.ok(summary.message.content.toLowerCase().includes(STREAM_SUMMARY_WORD), 'the word is the summary\'s');
    assert.deepStrictEqual(await search(STREAM_SUMMARY_WORD, STREAM), []);
  });
});

test('the message count leaves out the summary and its divider (main already behaves this way)', async () => {
  const since = client.messages.length;
  client.send({ type: 'get_conversations' });
  const { msg } = await client.waitFor((m) => m.type === 'conversations', { since, label: 'conversations' });
  const convo = msg.conversations.find((c) => c.id === CONVO);
  assert.strictEqual(convo.messageCount, seeded.visibleTurns);
});
