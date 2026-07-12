'use strict';
// Integration: the grep degradation path. RUNDOCK_SEARCH_DISABLE_SQLITE
// simulates a runtime without node:sqlite (Node 20/21); search must degrade
// to bounded grep + the in-memory title layer, never hard-fail. Separate
// file because the capability probe result is cached per process.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../helpers/harness.js');

let client;

function jsonlUser(text, ts) {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text }, timestamp: ts }) + '\n';
}

async function search(msg) {
  const since = client.messages.length;
  client.send({ type: 'search_universal', ...msg });
  const { msg: reply } = await client.waitFor(
    m => m.type === 'search_universal_results' && m.query === (msg.query || ''),
    { since, label: 'search_universal_results' }
  );
  return reply;
}

before(async () => {
  await h.boot({
    env: { RUNDOCK_SEARCH_DISABLE_SQLITE: '1' },
    workspaceOpts: {
      files: {
        'guide.md': 'A guide covering the pelican deployment steps.',
      },
    },
  });
  const hash = h.workspaceDir.replace(/\//g, '-');
  const sessionDir = path.join(process.env.HOME, '.claude', 'projects', hash);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'sess-f1.jsonl'),
    jsonlUser('Remind me about the manatee migration plan.', '2026-07-01T10:00:00.000Z'));
  const rundockDir = path.join(h.workspaceDir, '.rundock');
  fs.mkdirSync(rundockDir, { recursive: true });
  fs.writeFileSync(path.join(rundockDir, 'conversations.json'), JSON.stringify([
    { id: 'cf1', agentId: 'chief-of-staff', sessionId: 'sess-f1', sessionIds: [], title: 'Migration chat', status: 'active', createdAt: '2026-07-01T09:59:00.000Z', lastActiveAt: '2026-07-01T10:01:00.000Z' },
  ]));
  client = await h.connect();
});
after(async () => h.shutdown());

describe('grep fallback (no sqlite)', () => {
  test('no index file is created', async () => {
    await search({ query: 'anything' });
    assert.ok(!fs.existsSync(path.join(h.workspaceDir, '.rundock', 'search-index.db')));
  });

  test('file content still searchable via bounded grep', async () => {
    const reply = await search({ query: 'pelican deployment' });
    const hit = reply.groups.files.find(f => f.path === 'guide.md');
    assert.ok(hit, 'grep fallback finds file content');
    assert.strictEqual(hit.matchType, 'content');
    assert.ok(hit.snippet.includes('pelican'));
  });

  test('conversation content still searchable via legacy jsonl grep', async () => {
    const reply = await search({ query: 'manatee migration' });
    const hit = reply.groups.conversations.find(c => c.id === 'cf1');
    assert.ok(hit, 'legacy grep finds conversation content');
    assert.strictEqual(hit.matchType, 'content');
  });

  test('title fuzzy layer and agents/skills remain fully functional', async () => {
    const reply = await search({ query: 'gd' }); // subsequence of "guide.md"
    assert.ok(reply.groups.files.find(f => f.path === 'guide.md' && f.matchType === 'title'));
    const agents = await search({ query: 'chief' });
    assert.ok(agents.groups.agents.find(a => a.id === 'chief-of-staff'));
  });

  test('sidebar search_conversations degrades to grep with the legacy shape', async () => {
    const since = client.messages.length;
    client.send({ type: 'search_conversations', query: 'manatee' });
    const { msg: reply } = await client.waitFor(m => m.type === 'search_results', { since, label: 'search_results' });
    const hit = reply.results.find(r => r.id === 'cf1');
    assert.ok(hit);
    assert.strictEqual(hit.matchType, 'content');
    assert.ok(hit.snippet);
  });
});
