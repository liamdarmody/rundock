'use strict';
// A conversation Claude Code summarised to make room, through the real
// server's search on the grep fallback (RUNDOCK_SEARCH_DISABLE_SQLITE stands
// in for a runtime without node:sqlite). Separate from
// compaction-search.test.js because the engine is chosen once per process.
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const h = require('../helpers/harness.js');
const { seedSummarisedConversation, SUMMARY_ONLY_WORD, SHARED_WORD, DIVIDER_WORDS } = require('../helpers/compaction-seed.js');

const CONVO = 'cmp-grep';
let client;

async function search(query) {
  const since = client.messages.length;
  client.send({ type: 'search_universal', query });
  const { msg } = await client.waitFor((m) => m.type === 'search_universal_results' && m.query === query, { since, label: 'search_universal_results' });
  return msg.groups.conversations.filter((c) => c.id === CONVO);
}

before(async () => {
  await h.boot({ env: { RUNDOCK_SEARCH_DISABLE_SQLITE: '1' } });
  seedSummarisedConversation(h, { convoId: CONVO, sessionId: 'sess-cmp-grep' });
  client = await h.connect();
});
after(async () => h.shutdown());

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
