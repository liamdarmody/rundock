'use strict';
// Characterisation: the conversation-metadata WS handlers, pinned as they
// behave today, before they move out of server.js. Covers the
// get_conversations load pipeline (cleanup, activeAgentId reconciliation,
// enrichment), set_last_active_conversation, the conversation lists CRUD,
// create_path, add_to_team, the reveal_in_finder guard, and the
// disconnect-buffer flush.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../helpers/harness.js');
const { agentFile } = require('../helpers/workspace.js');

let client;
let sessionsDir;

function request(msg, pred, label) {
  const since = client.messages.length;
  client.send(msg);
  return client.waitFor(pred, { since, label }).then(r => r.msg);
}

function getConversations(label) {
  return request({ type: 'get_conversations' }, m => m.type === 'conversations', label || 'conversations');
}

function writeSession(sessionId, entries) {
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, `${sessionId}.jsonl`),
    entries.map(e => JSON.stringify(e)).join('\n') + '\n');
}

before(async () => {
  await h.boot();
  client = await h.connect();
  sessionsDir = path.join(process.env.HOME, '.claude', 'projects', h.workspaceDir.replace(/\//g, '-'));
});
after(async () => h.shutdown());

describe('get_conversations: load pipeline', () => {
  test('cleans stale empties and reconciles activeAgentId, persisting once', async () => {
    const oldStamp = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const convosFile = path.join(h.workspaceDir, '.rundock', 'conversations.json');
    fs.mkdirSync(path.dirname(convosFile), { recursive: true });
    fs.writeFileSync(convosFile, JSON.stringify([
      // Never got a sessionId and is older than the 5-minute grace: dropped.
      { id: 'stale-empty', agentId: 'chief-of-staff', title: 'Abandoned', lastActiveAt: oldStamp },
      // Points at a delegatee with no live process: reset to the owner.
      { id: 'reconcile-1', agentId: 'chief-of-staff', activeAgentId: 'penn', sessionId: 's-r1', title: 'Reconciled', lastActiveAt: oldStamp },
    ]));

    const res = await getConversations();
    assert.ok(!res.conversations.some(c => c.id === 'stale-empty'), 'stale empty conversation dropped');
    const reconciled = res.conversations.find(c => c.id === 'reconcile-1');
    assert.strictEqual(reconciled.activeAgentId, 'chief-of-staff', 'stale delegatee pointer reset to the owner');

    const persisted = JSON.parse(fs.readFileSync(convosFile, 'utf-8'));
    assert.ok(!persisted.some(c => c.id === 'stale-empty'), 'cleanup persisted to disk');
    assert.strictEqual(persisted.find(c => c.id === 'reconcile-1').activeAgentId, 'chief-of-staff');
  });

  test('enriches each conversation with messageCount and a stripped last-message preview', async () => {
    const convoId = 'enrich-1';
    writeSession('sess-enrich-1', [
      { type: 'user', message: { role: 'user', content: 'Real question' } },
      { message: { role: 'assistant', content: [{ type: 'text', text: 'Real answer' }] } },
      // None of these are user-visible bubbles: excluded from the count.
      { type: 'user', message: { role: 'user', content: '[DELEGATION BRIEF] internal' } },
      { message: { role: 'assistant', content: [{ type: 'text', text: 'No response requested.' }] } },
    ]);
    client.send({
      type: 'save_conversation',
      conversation: { id: convoId, agentId: 'chief-of-staff', title: 'Enrichment pin', sessionId: 'sess-enrich-1', sessionIds: [{ sessionId: 'sess-enrich-1' }] },
    });
    // The preview comes from the transcript's last agent entry: markers,
    // markdown, and leading tool summaries all stripped.
    const dir = path.join(h.workspaceDir, '.rundock', 'transcripts');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${convoId}.json`), JSON.stringify([
      { role: 'user', text: 'Real question' },
      {
        role: 'agent', agent: 'penn',
        text: '<!-- RUNDOCK:SAVE_AGENT name=doc -->\nhidden payload\n<!-- /RUNDOCK:SAVE_AGENT -->[Read: notes.md] **Bold** update with a [link](https://example.com) and [[Page|alias]] inside',
      },
    ]));

    const res = await getConversations('conversations with enrichment');
    const convo = res.conversations.find(c => c.id === convoId);
    assert.ok(convo, 'saved conversation listed');
    assert.strictEqual(convo.messageCount, 2, 'only user-visible bubbles counted');
    assert.strictEqual(convo.lastAgentId, 'penn');
    assert.strictEqual(convo.lastMessagePreview, 'Bold update with a link and alias inside');
  });
});

describe('set_last_active_conversation', () => {
  test('sets and clears the pointer served with the conversation list', async () => {
    client.send({ type: 'set_last_active_conversation', id: 'enrich-1' });
    let res = await getConversations('conversations after set');
    assert.strictEqual(res.lastActiveConversationId, 'enrich-1');

    client.send({ type: 'set_last_active_conversation' });
    res = await getConversations('conversations after clear');
    assert.strictEqual(res.lastActiveConversationId, null);
  });
});

describe('conversation lists', () => {
  test('create trims the name, duplicates are a no-op, delete removes everywhere', async () => {
    let res = await request({ type: 'get_lists' }, m => m.type === 'lists', 'initial lists');
    assert.deepStrictEqual(res.lists, []);

    res = await request({ type: 'create_list', name: '  Client Work  ' }, m => m.type === 'lists', 'created list');
    assert.strictEqual(res.lists.length, 1);
    assert.strictEqual(res.lists[0].name, 'Client Work');
    assert.match(res.lists[0].id, /^list-/);

    // Same name, different case: no duplicate pill.
    res = await request({ type: 'create_list', name: 'client work' }, m => m.type === 'lists', 'duplicate list');
    assert.strictEqual(res.lists.length, 1);

    res = await request({ type: 'delete_list', id: res.lists[0].id }, m => m.type === 'lists', 'deleted list');
    assert.deepStrictEqual(res.lists, []);
  });
});

describe('create_path', () => {
  test('notes are created (never clobbered); folders are idempotent; dot-paths are refused', async () => {
    const since = client.messages.length;
    client.send({ type: 'create_path', path: '/notes/new-note.md', kind: 'note', content: '# Hi' });
    const created = (await client.waitFor(m => m.type === 'path_created', { since, label: 'path_created' })).msg;
    // The leading slash is stripped: the path is workspace-relative.
    assert.strictEqual(created.path, 'notes/new-note.md');
    assert.strictEqual(created.kind, 'note');
    await client.waitFor(m => m.type === 'file_tree', { since, label: 'file_tree after create' });
    assert.strictEqual(fs.readFileSync(path.join(h.workspaceDir, 'notes', 'new-note.md'), 'utf-8'), '# Hi');

    let err = await request({ type: 'create_path', path: 'notes/new-note.md', kind: 'note' },
      m => m.type === 'create_error', 'clobber refused');
    assert.strictEqual(err.reason, 'already exists');

    const folder = await request({ type: 'create_path', path: 'boards/q3', kind: 'folder' },
      m => m.type === 'path_created', 'folder created');
    assert.strictEqual(folder.kind, 'folder');
    const again = await request({ type: 'create_path', path: 'boards/q3', kind: 'folder' },
      m => m.type === 'path_created', 'folder idempotent');
    assert.strictEqual(again.path, 'boards/q3');

    err = await request({ type: 'create_path', path: '.hidden/x.md', kind: 'note' },
      m => m.type === 'create_error', 'dot path refused');
    assert.strictEqual(err.reason, 'invalid path');
  });
});

describe('add_to_team', () => {
  test('assigns the next order number and writes it into the agent file frontmatter', async () => {
    const agentsDir = path.join(h.workspaceDir, '.claude', 'agents');
    fs.writeFileSync(path.join(agentsDir, 'doc.md'), agentFile({
      name: 'doc', displayName: 'Doc', role: 'Recruiter', type: 'specialist',
      description: 'Available agent with no order',
    }));
    // The roster is signature-cached; an external write is only visible after
    // invalidation (in production, the agents-dir watcher's next poll).
    h.internal.invalidateAgentCache();

    // The recruit joins at max(existing orders) + 1 across the WHOLE roster,
    // platform agent included (the scaffolded guide holds a deliberately high
    // order so it sits last, and recruits land after it).
    const roster = await request({ type: 'get_agents' }, m => m.type === 'agents', 'roster before add');
    const expectedOrder = Math.max(0, ...roster.agents.filter(a => a.order !== null).map(a => a.order)) + 1;

    const res = await request({ type: 'add_to_team', agentId: 'doc' }, m => m.type === 'agents', 'agents after add');

    // Disk is the source of truth and is correct immediately, written after
    // the `type:` field.
    const content = fs.readFileSync(path.join(agentsDir, 'doc.md'), 'utf-8');
    assert.match(content, new RegExp(`^type: specialist\\norder: ${expectedOrder}$`, 'm'),
      'order written directly after the type field');

    // The agents message answers with the FRESH roster: the recruit's new
    // order is on the wire immediately, not deferred to a later refresh.
    const doc = res.agents.find(a => a.id === 'doc');
    assert.strictEqual(doc.order, expectedOrder);
  });
});

describe('reveal_in_finder', () => {
  test('a path outside the workspace is guarded to a no-op, not an error', async () => {
    client.send({ type: 'reveal_in_finder', path: '../../outside' });
    // The handler answers nothing; prove the connection survived it.
    const res = await request({ type: 'get_lists' }, m => m.type === 'lists', 'alive after reveal');
    assert.ok(Array.isArray(res.lists));
  });
});

// Last on purpose: this closes every connected client to force buffering.
describe('flush_buffer', () => {
  test('messages emitted while no client is connected replay on request, minus stream noise', async () => {
    const convoId = h.freshConvoId('flush');
    h.writeScenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 'answer into the void' },
        delayMs: 400, turn: [{ text: 'Buffered answer' }] },
    ]);
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'answer into the void' });
    await client.waitForEvent('system', 'process_started', convoId, { label: 'turn started' });
    client.close();

    // The turn completes with nobody connected: its output buffers. In
    // interactive mode the process entry stays alive as idle after the
    // result, so completion is resultSent, not entry removal.
    const finished = await h.waitUntil(() => {
      const e = h.internal.chatProcesses.get(convoId);
      return !!(e && e.resultSent);
    }, { timeout: 8000 });
    assert.ok(finished, 'turn completed while disconnected');
    assert.ok(h.internal.disconnectBuffer.length > 0, 'messages buffered during the disconnect');

    client = await h.connect();
    const since = client.messages.length;
    client.send({ type: 'flush_buffer' });
    const result = (await client.waitFor(
      m => m.type === 'result' && m._conversationId === convoId,
      { since, label: 'buffered result' })).msg;
    assert.ok(result, 'terminal result survived the disconnect');
    // The stream-level noise is filtered: the responseText snapshot covers it.
    assert.ok(!client.messages.slice(since).some(m =>
      (m.type === 'stream_event' || m.type === 'assistant') && m._conversationId === convoId),
    'stream_event and assistant messages are not replayed');
    assert.strictEqual(h.internal.disconnectBuffer.length, 0, 'buffer fully drained');
    h.reapConvo(convoId);
  });
});
