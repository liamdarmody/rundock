'use strict';
// A conversation Claude Code summarised to make room, through the real
// server's search on the grep fallback (RUNDOCK_SEARCH_DISABLE_SQLITE stands
// in for a runtime without node:sqlite). Separate from
// compaction-search.test.js because the engine is chosen once per process.
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const h = require('../helpers/harness.js');
const {
  seedSummarisedConversation, SUMMARY_ONLY_WORD, SHARED_WORD, DIVIDER_WORDS,
  seedCapturedSession, capturedSessionLines, CAPTURED_SUMMARY_WORD, CAPTURED_PROMPT_WORDS,
  seedStreamSummarySession, STREAM_SUMMARY_WORD, STREAM_PROMPT_WORD,
} = require('../helpers/compaction-seed.js');

const CONVO = 'cmp-grep';
const CAPTURED = 'cmp-grep-captured';
const STREAM = 'cmp-grep-stream';
let client;
let streamSeeded;

async function search(query, convoId = CONVO) {
  const since = client.messages.length;
  client.send({ type: 'search_universal', query });
  const { msg } = await client.waitFor((m) => m.type === 'search_universal_results' && m.query === query, { since, label: 'search_universal_results' });
  return msg.groups.conversations.filter((c) => c.id === convoId);
}

before(async () => {
  await h.boot({ env: { RUNDOCK_SEARCH_DISABLE_SQLITE: '1' } });
  seedSummarisedConversation(h, { convoId: CONVO, sessionId: 'sess-cmp-grep' });
  seedCapturedSession(h, { convoId: CAPTURED });
  streamSeeded = seedStreamSummarySession(h, { convoId: STREAM });
  client = await h.connect();
});
after(async () => h.shutdown());

// Both search paths skip the summary by this one mark, so a capture that
// marks it some other way fails here, by name.
test('the session file Claude Code kept marks the one message line holding its summary isCompactSummary', () => {
  const holding = capturedSessionLines()
    .filter((l) => (l.type === 'user' || l.type === 'assistant') && JSON.stringify(l.message).includes(CAPTURED_SUMMARY_WORD));
  assert.deepStrictEqual(holding.map((l) => [l.type, l.isCompactSummary]), [['user', true]]);
});

test('the grep fallback finds the conversation by what was said in it', async () => {
  const hits = await search(SHARED_WORD);
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].matchType, 'content');
});

test('the grep fallback never finds it by the summary Claude Code wrote', async () => {
  assert.deepStrictEqual(await search(SUMMARY_ONLY_WORD), []);
});

test('the grep fallback never finds it by the divider\'s words (main already behaves this way)', async () => {
  for (const words of DIVIDER_WORDS) assert.deepStrictEqual(await search(words), [], words);
});

test('the grep fallback finds the conversation from the session file Claude Code kept by the prompts it was sent (main already behaves this way)', async () => {
  const hits = await search(CAPTURED_PROMPT_WORDS, CAPTURED);
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].matchType, 'content');
});

test('the grep fallback never finds the conversation from the session file Claude Code kept by its summary', async () => {
  assert.deepStrictEqual(await search(CAPTURED_SUMMARY_WORD, CAPTURED), []);
});

test('the grep fallback finds a session holding the summary as Claude Code\'s output stream carries it by an ordinary prompt in it', async () => {
  const hits = await search(STREAM_PROMPT_WORD, STREAM);
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].matchType, 'content');
});

test('the grep fallback never finds that session by its summary line, marked isSynthetic and not isCompactSummary', async () => {
  const { summary } = streamSeeded;
  assert.deepStrictEqual([summary.isSynthetic, summary.isCompactSummary], [true, undefined], 'the line as captured');
  assert.ok(summary.message.content.toLowerCase().includes(STREAM_SUMMARY_WORD), 'the word is the summary\'s');
  assert.deepStrictEqual(await search(STREAM_SUMMARY_WORD, STREAM), []);
});
