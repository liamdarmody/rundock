'use strict';
// Integration: universal search over the real server (WS search_universal +
// upgraded search_conversations), with the FTS engine active. The grep
// fallback path has its own file (search-fallback.test.js) because the
// engine choice is fixed at first use per process.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../helpers/harness.js');

let client;

function jsonlUser(text, ts) {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text }, timestamp: ts }) + '\n';
}
function jsonlAssistant(text, ts) {
  return JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, timestamp: ts }) + '\n';
}

let sessionDir, seq = 0;

function seedSession(sessionId, content) {
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, sessionId + '.jsonl'), content);
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
    workspaceOpts: {
      files: {
        'notes/pricing.md': '---\ntags: [strategy, pricing]\n---\n# Pricing\n\nThe enterprise pricing ladder was agreed in June.',
        'Roadmap-2026.md': 'Quarterly roadmap targets and the mobile milestone.',
        'plain.txt': 'A text file mentioning wombats explicitly.',
        '.claude/skills/demo-skill/SKILL.md': '---\nname: Demo Skill\ndescription: Generates demonstration widgets for testing.\n---\nBody.',
      },
    },
  });
  // Conversation metadata + Claude Code session jsonl (canonical content source)
  const hash = h.workspaceDir.replace(/\//g, '-');
  sessionDir = path.join(process.env.HOME, '.claude', 'projects', hash);
  seedSession('sess-1',
    jsonlUser('Can we revisit the enterprise discount structure?', '2026-07-01T10:00:00.000Z') +
    jsonlAssistant('Yes. The discount structure should follow seat bands.', '2026-07-01T10:00:30.000Z')
  );
  seedSession('sess-2', jsonlUser('Totally unrelated chatter about weather.', '2026-07-02T09:00:00.000Z'));
  const rundockDir = path.join(h.workspaceDir, '.rundock');
  fs.mkdirSync(rundockDir, { recursive: true });
  fs.writeFileSync(path.join(rundockDir, 'conversations.json'), JSON.stringify([
    { id: 'c1', agentId: 'chief-of-staff', sessionId: 'sess-1', sessionIds: [], title: 'Discount planning', status: 'active', createdAt: '2026-07-01T09:59:00.000Z', lastActiveAt: '2026-07-01T10:01:00.000Z' },
    { id: 'c2', agentId: 'developer', sessionId: 'sess-2', sessionIds: [], title: 'Weather smalltalk', status: 'active', createdAt: '2026-07-02T08:59:00.000Z', lastActiveAt: '2026-07-02T09:01:00.000Z' },
  ], null, 2));
  client = await h.connect();
});
after(async () => h.shutdown());

describe('search_universal', () => {
  test('file content matches return ranked, snippeted hits with tags', async () => {
    const reply = await search({ query: 'enterprise pricing ladder' });
    assert.ok(reply.groups, 'grouped reply');
    const files = reply.groups.files;
    assert.ok(files.length >= 1);
    assert.strictEqual(files[0].path, 'notes/pricing.md');
    assert.ok(files[0].snippet.includes('\u0001'), 'highlight markers present');
    assert.deepStrictEqual(files[0].tags.sort(), ['pricing', 'strategy']);
  });

  test('fuzzy filename matches surface as title hits (fzf-style)', async () => {
    const reply = await search({ query: 'rdmp' });
    const files = reply.groups.files;
    assert.ok(files.find(f => f.path === 'Roadmap-2026.md'), 'subsequence filename match');
    assert.strictEqual(files.find(f => f.path === 'Roadmap-2026.md').matchType, 'title');
  });

  test('fuzzy off narrows the title layer to substring matches', async () => {
    const reply = await search({ query: 'rdmp', fuzzy: false });
    assert.ok(!reply.groups.files.find(f => f.path === 'Roadmap-2026.md'), 'no subsequence match with fuzzy off');
    const sub = await search({ query: 'roadmap', fuzzy: false });
    assert.ok(sub.groups.files.find(f => f.path === 'Roadmap-2026.md'), 'substring still matches with fuzzy off');
  });

  test('conversation content matches carry anchor data (session + seq)', async () => {
    const reply = await search({ query: 'discount structure' });
    const convos = reply.groups.conversations;
    assert.ok(convos.length >= 1);
    const hit = convos.find(c => c.id === 'c1');
    assert.ok(hit, 'conversation c1 found by content');
    assert.strictEqual(hit.title, 'Discount planning');
    assert.ok(hit.snippet.includes('\u0001'));
    assert.strictEqual(hit.sessionId, 'sess-1');
    assert.ok(Number.isInteger(hit.seq), 'seq present for open-at-message anchor');
  });

  test('conversation title matches rank above content matches', async () => {
    const reply = await search({ query: 'weather' });
    const convos = reply.groups.conversations;
    assert.ok(convos.length >= 1);
    assert.strictEqual(convos[0].id, 'c2', 'title match first');
    assert.strictEqual(convos[0].matchType, 'title');
  });

  test('agents and skills match by name via the in-memory layer', async () => {
    const reply = await search({ query: 'chief' });
    assert.ok(reply.groups.agents.find(a => a.id === 'chief-of-staff'));
    const skillReply = await search({ query: 'demo skill' });
    assert.ok(skillReply.groups.skills.find(s => s.id === 'demo-skill'));
  });

  test('agent filter narrows conversations', async () => {
    const all = await search({ query: 'unrelated chatter' });
    assert.ok(all.groups.conversations.find(c => c.id === 'c2'));
    const filtered = await search({ query: 'unrelated chatter', agentId: 'chief-of-staff' });
    assert.ok(!filtered.groups.conversations.find(c => c.id === 'c2' && c.matchType === 'content'));
  });

  test('tag filter narrows files', async () => {
    const tagged = await search({ query: 'pricing', tags: ['strategy'] });
    assert.ok(tagged.groups.files.find(f => f.path === 'notes/pricing.md'));
    const wrongTag = await search({ query: 'pricing', tags: ['nonexistent'] });
    assert.ok(!wrongTag.groups.files.find(f => f.path === 'notes/pricing.md' && f.matchType === 'content'));
  });

  test('empty query returns recent items, not nothing', async () => {
    const reply = await search({ query: '' });
    assert.strictEqual(reply.recent, true);
    assert.ok(reply.groups.conversations.length >= 1, 'recent conversations listed');
    assert.ok(reply.groups.files.length >= 1, 'recent files listed');
    assert.strictEqual(reply.groups.conversations[0].id, 'c2', 'most recently active first');
  });

  test('a message appended to a session jsonl is findable without reopening', async () => {
    fs.appendFileSync(path.join(sessionDir, 'sess-1.jsonl'),
      jsonlAssistant('New follow-up about the axolotl initiative.', '2026-07-03T10:00:00.000Z'));
    const reply = await search({ query: 'axolotl initiative' });
    assert.ok(reply.groups.conversations.find(c => c.id === 'c1'), 'fresh message indexed at search time');
  });

  test('a saved file is searchable immediately', async () => {
    const since = client.messages.length;
    client.send({ type: 'save_file', path: 'fresh-note.md', content: 'Notes about the quetzal launch plan.' });
    await client.waitFor(m => m.type === 'file_saved', { since, label: 'file_saved' });
    const reply = await search({ query: 'quetzal launch' });
    assert.ok(reply.groups.files.find(f => f.path === 'fresh-note.md'));
  });

  test('a deleted conversation drops out of results', async () => {
    const before = await search({ query: 'unrelated chatter' });
    assert.ok(before.groups.conversations.find(c => c.id === 'c2'));
    const since = client.messages.length;
    client.send({ type: 'delete_conversation', id: 'c2' });
    await client.waitFor(m => m.type === 'conversation_deleted', { since, label: 'conversation_deleted' });
    const after = await search({ query: 'unrelated chatter' });
    assert.ok(!after.groups.conversations.find(c => c.id === 'c2'));
  });

  test('nasty queries return cleanly', async () => {
    for (const q of ['"unbalanced', 'a* OR b', '(paren', '日本語*()']) {
      const reply = await search({ query: q });
      assert.ok(reply.groups, `reply for ${JSON.stringify(q)}`);
    }
  });
});

describe('search_conversations (sidebar, upgraded internals)', () => {
  test('content matches return with the legacy reply shape plus anchors', async () => {
    const since = client.messages.length;
    client.send({ type: 'search_conversations', query: 'discount structure' });
    const { msg: reply } = await client.waitFor(m => m.type === 'search_results', { since, label: 'search_results' });
    const hit = reply.results.find(r => r.id === 'c1');
    assert.ok(hit, 'c1 found');
    assert.strictEqual(hit.matchType, 'content');
    assert.ok(hit.snippet, 'snippet present');
  });

  test('partial-word queries still match content (parity with the old grep)', async () => {
    // The sidebar fires at >=3 chars mid-word; the pre-index grep matched
    // substrings, so "structur" must keep finding "structure" in message
    // content (query chosen to miss every title so the content phase is
    // what's exercised). (Review R1 P1-1)
    const since = client.messages.length;
    client.send({ type: 'search_conversations', query: 'structur' });
    const { msg: reply } = await client.waitFor(m => m.type === 'search_results', { since, label: 'search_results' });
    const hit = reply.results.find(r => r.id === 'c1' && r.matchType === 'content');
    assert.ok(hit, 'mid-word typing state must return content matches');
  });
});

describe('review round 1 regressions (server-side)', () => {
  test('missing session files are not re-resolved on every call (negative memo)', () => {
    // A pruned session jsonl must not trigger a ~/.claude/projects directory
    // scan per keystroke. (Review R1 P2-1)
    const internal = h.internal;
    internal._sessionPathMemo.clear();
    const rundockDir = path.join(h.workspaceDir, '.rundock');
    const convos = JSON.parse(fs.readFileSync(path.join(rundockDir, 'conversations.json'), 'utf-8'));
    convos.push({ id: 'ghost-c', agentId: 'chief-of-staff', sessionId: 'sess-ghost', sessionIds: [], title: 'Ghost', status: 'active', createdAt: '2026-07-01T00:00:00.000Z', lastActiveAt: '2026-07-01T00:00:00.000Z' });
    fs.writeFileSync(path.join(rundockDir, 'conversations.json'), JSON.stringify(convos));
    try {
      let list = internal.conversationSessionsForSearch('ghost-c');
      assert.strictEqual(list.length, 0, 'ghost session resolves to nothing');
      const memo = internal._sessionPathMemo.get('sess-ghost');
      assert.ok(memo && memo.path === null, 'negative lookup memoised');
      // Even if the file appears now, the memo suppresses re-scanning until TTL...
      fs.writeFileSync(path.join(sessionDir, 'sess-ghost.jsonl'), jsonlUser('ghost content', '2026-07-01T00:00:01.000Z'));
      list = internal.conversationSessionsForSearch('ghost-c');
      assert.strictEqual(list.length, 0, 'within TTL the negative memo holds');
      // ...and a expired memo entry re-resolves and finds it.
      memo.ts = 0;
      list = internal.conversationSessionsForSearch('ghost-c');
      assert.strictEqual(list.length, 1, 'expired negative memo re-resolves');
    } finally {
      fs.writeFileSync(path.join(rundockDir, 'conversations.json'), JSON.stringify(convos.filter(c => c.id !== 'ghost-c')));
      fs.rmSync(path.join(sessionDir, 'sess-ghost.jsonl'), { force: true });
      internal._sessionPathMemo.clear();
    }
  });

  test('conversations sharing a session id do not fight over the marks (first wins)', () => {
    // (Review R1 P2-4)
    const internal = h.internal;
    const rundockDir = path.join(h.workspaceDir, '.rundock');
    const original = fs.readFileSync(path.join(rundockDir, 'conversations.json'), 'utf-8');
    const convos = JSON.parse(original);
    convos.push({ id: 'dupe-a', agentId: 'chief-of-staff', sessionId: 'sess-1', sessionIds: [], title: 'Dupe A', status: 'active', createdAt: '2026-07-01T00:00:00.000Z', lastActiveAt: '2026-07-01T00:00:00.000Z' });
    fs.writeFileSync(path.join(rundockDir, 'conversations.json'), JSON.stringify(convos));
    try {
      const list = internal.conversationSessionsForSearch();
      const holders = list.filter(c => c.sessions.some(s => s.sessionId === 'sess-1'));
      assert.strictEqual(holders.length, 1, 'a session id belongs to exactly one conversation');
      assert.strictEqual(holders[0].conversationId, 'c1', 'first conversation in the list owns the session');
    } finally {
      fs.writeFileSync(path.join(rundockDir, 'conversations.json'), original);
    }
  });

  test('a newly saved skill is searchable immediately (cache invalidation)', async () => {
    // discoverSkills gains a TTL cache (Review R1 P2-3); saving a skill must
    // still surface it in the palette without waiting out the TTL.
    const since = client.messages.length;
    client.send({ type: 'save_skill', name: 'flash-skill', content: '---\nname: Flash Skill\ndescription: Instant cache invalidation check.\n---\nBody.' });
    await client.waitFor(m => m.type === 'skill_saved', { since, label: 'skill_saved' });
    const reply = await search({ query: 'flash skill' });
    assert.ok(reply.groups.skills.find(s => s.id === 'flash-skill'), 'fresh skill found despite skills cache');
  });

  test('a newly saved file is title-searchable immediately (file list cache invalidation)', async () => {
    const since = client.messages.length;
    client.send({ type: 'save_file', path: 'cachecheck-note.md', content: 'Body content here.' });
    await client.waitFor(m => m.type === 'file_saved', { since, label: 'file_saved' });
    const reply = await search({ query: 'cachecheck' });
    assert.ok(reply.groups.files.find(f => f.path === 'cachecheck-note.md' && f.matchType === 'title'), 'fresh file found by title despite file list cache');
  });

  test('the live-turn hook busts a stale negative session memo (R2 P2-1)', () => {
    // Opening the palette can seed a negative memo entry for a brand-new
    // conversation before Claude Code has created its jsonl; the turn-end
    // hook is the authoritative "the jsonl exists now" signal and must not
    // be blinded by that entry for 30s.
    const internal = h.internal;
    const rundockDir = path.join(h.workspaceDir, '.rundock');
    const original = fs.readFileSync(path.join(rundockDir, 'conversations.json'), 'utf-8');
    const convos = JSON.parse(original);
    convos.push({ id: 'live-c', agentId: 'chief-of-staff', sessionId: 'sess-live', sessionIds: [], title: 'Live convo', status: 'active', createdAt: '2026-07-12T00:00:00.000Z', lastActiveAt: '2026-07-12T00:00:00.000Z' });
    fs.writeFileSync(path.join(rundockDir, 'conversations.json'), JSON.stringify(convos));
    try {
      internal._sessionPathMemo.clear();
      internal.conversationSessionsForSearch(); // palette-open reconcile seeds the negative
      assert.strictEqual(internal._sessionPathMemo.get('sess-live').path, null, 'negative memo seeded');
      // Claude Code writes the first turn.
      fs.writeFileSync(path.join(sessionDir, 'sess-live.jsonl'), jsonlUser('brand new gecko content', '2026-07-12T00:00:05.000Z'));
      internal.noteSearchConversationActivity('live-c');
      const engine = internal.getSearchEngine();
      assert.ok(engine, 'engine active in this suite');
      assert.strictEqual(engine.searchMessages('gecko', { collapse: false }).length, 1, 'live content findable immediately');
    } finally {
      fs.writeFileSync(path.join(rundockDir, 'conversations.json'), original);
      fs.rmSync(path.join(sessionDir, 'sess-live.jsonl'), { force: true });
      internal._sessionPathMemo.clear();
    }
  });

  test('a workspace switch retries a failed engine open (R2 P2-2)', async () => {
    const internal = h.internal;
    assert.ok(internal.ensureSearchEngine(), 'engine healthy to start');
    internal._searchTestHooks.simulateOpenFailure();
    assert.strictEqual(internal.ensureSearchEngine(), null, 'backoff active after failure');
    // Re-selecting the workspace (same path) is the documented retry trigger.
    const since = client.messages.length;
    client.send({ type: 'set_workspace', path: h.workspaceDir });
    await client.waitFor(m => m.type === 'workspace_set', { since, label: 'workspace_set' });
    assert.ok(internal.ensureSearchEngine(), 'engine retries after workspace switch');
  });

  test('archived conversations stay out of the empty-query recents', async () => {
    // (Review R1 P3-9)
    const rundockDir = path.join(h.workspaceDir, '.rundock');
    const original = fs.readFileSync(path.join(rundockDir, 'conversations.json'), 'utf-8');
    const convos = JSON.parse(original);
    convos.unshift({ id: 'arch-c', agentId: 'chief-of-staff', sessionId: null, sessionIds: [], title: 'Archived thing', status: 'archived', createdAt: '2026-07-11T00:00:00.000Z', lastActiveAt: '2026-07-11T00:00:00.000Z' });
    fs.writeFileSync(path.join(rundockDir, 'conversations.json'), JSON.stringify(convos));
    try {
      const reply = await search({ query: '' });
      assert.ok(!reply.groups.conversations.find(c => c.id === 'arch-c'), 'archived conversation excluded from recents');
    } finally {
      fs.writeFileSync(path.join(rundockDir, 'conversations.json'), original);
    }
  });
});
