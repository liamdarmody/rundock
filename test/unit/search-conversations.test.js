'use strict';
// SR1 universal search: conversations corpus.
// Source of truth is the Claude Code session jsonl (append-only), NOT
// Rundock's .rundock/transcripts (rewritten wholesale, capped, partial for
// old conversations). High-water marks are byte offsets per session file;
// only newline-terminated lines are consumed so a mid-write partial line is
// never half-indexed.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { probeSqlite, createSearchIndex, HIGHLIGHT_OPEN } = require('../../search.js');

const probe = probeSqlite();
if (!probe.available) {
  test('conversations corpus (skipped: no node:sqlite on this runtime)', { skip: true }, () => {});
  return;
}

let tmpRoot, dbPath, idx;

function jsonlUser(text, ts) {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text }, timestamp: ts }) + '\n';
}
function jsonlAssistant(text, ts) {
  return JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, timestamp: ts }) + '\n';
}
function jsonlToolResult(ts) {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'TOOLNOISE grep output' }] }, timestamp: ts }) + '\n';
}
function jsonlToolUse(ts) {
  return JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'TOOLNOISE ls' } }] }, timestamp: ts }) + '\n';
}

function writeSession(name, content) {
  const p = path.join(tmpRoot, name + '.jsonl');
  fs.writeFileSync(p, content);
  return p;
}

function convo(id, agentId, sessions) {
  return { conversationId: id, sessions };
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-convosearch-'));
  dbPath = path.join(tmpRoot, 'search-index.db');
  idx = createSearchIndex({ dbPath, DatabaseSync: probe.DatabaseSync });
  idx.open();
});

afterEach(() => {
  try { idx.close(); } catch (e) {}
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('conversations corpus', () => {
  test('indexes user and assistant text; tool calls and results stay out', () => {
    const p = writeSession('s1',
      jsonlUser('How should we set enterprise pricing for the new tier?', '2026-07-01T10:00:00.000Z') +
      jsonlToolUse('2026-07-01T10:00:05.000Z') +
      jsonlToolResult('2026-07-01T10:00:06.000Z') +
      jsonlAssistant('Anchor enterprise pricing to seats, not usage.', '2026-07-01T10:00:10.000Z')
    );
    idx.reconcileConversations([convo('c1', 'cos', [{ sessionId: 's1', agentId: 'cos', filePath: p }])]);
    const hits = idx.searchMessages('pricing', { collapse: false });
    assert.strictEqual(hits.length, 2);
    assert.strictEqual(idx.searchMessages('TOOLNOISE', { collapse: false }).length, 0, 'tool noise must not be indexed');
    const roles = hits.map(h => h.role).sort();
    assert.deepStrictEqual(roles, ['agent', 'user']);
    assert.ok(hits[0].snippet.includes(HIGHLIGHT_OPEN));
    assert.strictEqual(hits[0].conversationId, 'c1');
    assert.strictEqual(hits[0].agentId, 'cos');
    assert.ok(hits[0].tsMs > 0);
  });

  test('each hit carries one neighbouring message for context', () => {
    const p = writeSession('s1',
      jsonlUser('Tell me about the walrus project.', '2026-07-01T10:00:00.000Z') +
      jsonlAssistant('The walrus project shipped in June.', '2026-07-01T10:00:10.000Z')
    );
    idx.reconcileConversations([convo('c1', 'cos', [{ sessionId: 's1', agentId: 'cos', filePath: p }])]);
    const hits = idx.searchMessages('shipped', { collapse: false });
    assert.strictEqual(hits.length, 1);
    assert.ok(hits[0].neighbour, 'neighbour message present');
    assert.strictEqual(hits[0].neighbour.role, 'user');
    assert.match(hits[0].neighbour.text, /walrus project/);
  });

  test('incremental reconcile consumes only the delta', () => {
    const p = writeSession('s1', jsonlUser('first flamingo message', '2026-07-01T10:00:00.000Z'));
    const c = convo('c1', 'cos', [{ sessionId: 's1', agentId: 'cos', filePath: p }]);
    let r = idx.reconcileConversations([c]);
    assert.strictEqual(r.indexed, 1);
    fs.appendFileSync(p, jsonlAssistant('second flamingo reply', '2026-07-01T10:01:00.000Z'));
    r = idx.reconcileConversations([c]);
    assert.strictEqual(r.indexed, 1, 'only the appended message is indexed');
    assert.strictEqual(idx.searchMessages('flamingo', { collapse: false }).length, 2);
  });

  test('an unchanged session file is skipped entirely', () => {
    const p = writeSession('s1', jsonlUser('static content here', '2026-07-01T10:00:00.000Z'));
    const c = convo('c1', 'cos', [{ sessionId: 's1', agentId: 'cos', filePath: p }]);
    idx.reconcileConversations([c]);
    const r = idx.reconcileConversations([c]);
    assert.strictEqual(r.indexed, 0);
    assert.strictEqual(r.sessionsRead, 0);
  });

  test('a shrunk or replaced session file reindexes from zero without duplicates', () => {
    const p = writeSession('s1',
      jsonlUser('original ocelot content padded to be long enough', '2026-07-01T10:00:00.000Z') +
      jsonlAssistant('original ocelot reply also padded out', '2026-07-01T10:00:10.000Z')
    );
    const c = convo('c1', 'cos', [{ sessionId: 's1', agentId: 'cos', filePath: p }]);
    idx.reconcileConversations([c]);
    assert.strictEqual(idx.searchMessages('ocelot', { collapse: false }).length, 2);
    fs.writeFileSync(p, jsonlUser('replacement lynx content', '2026-07-01T11:00:00.000Z'));
    idx.reconcileConversations([c]);
    assert.strictEqual(idx.searchMessages('ocelot', { collapse: false }).length, 0, 'old content gone');
    const lynx = idx.searchMessages('lynx', { collapse: false });
    assert.strictEqual(lynx.length, 1, 'no duplicates after reindex');
  });

  test('a partial trailing line without a newline is not consumed until terminated', () => {
    const full = jsonlUser('complete penguin line', '2026-07-01T10:00:00.000Z');
    const partial = jsonlUser('incomplete albatross line', '2026-07-01T10:01:00.000Z');
    const p = writeSession('s1', full + partial.slice(0, partial.length - 1)); // strip trailing \n
    const c = convo('c1', 'cos', [{ sessionId: 's1', agentId: 'cos', filePath: p }]);
    idx.reconcileConversations([c]);
    assert.strictEqual(idx.searchMessages('penguin', { collapse: false }).length, 1);
    assert.strictEqual(idx.searchMessages('albatross', { collapse: false }).length, 0, 'unterminated line must wait');
    fs.appendFileSync(p, '\n');
    idx.reconcileConversations([c]);
    assert.strictEqual(idx.searchMessages('albatross', { collapse: false }).length, 1);
  });

  test('multi-session conversations index every session with its own agent', () => {
    const p1 = writeSession('s1', jsonlUser('orchestrator heron question', '2026-07-01T10:00:00.000Z'));
    const p2 = writeSession('s2', jsonlAssistant('specialist heron answer', '2026-07-01T10:05:00.000Z'));
    idx.reconcileConversations([convo('c1', 'cos', [
      { sessionId: 's1', agentId: 'cos', filePath: p1 },
      { sessionId: 's2', agentId: 'dev', filePath: p2 },
    ])]);
    const hits = idx.searchMessages('heron', { collapse: false });
    assert.strictEqual(hits.length, 2);
    assert.deepStrictEqual(hits.map(h => h.agentId).sort(), ['cos', 'dev']);
  });

  test('agent and date filters narrow results', () => {
    const p1 = writeSession('s1', jsonlUser('badger topic early', '2026-07-01T10:00:00.000Z'));
    const p2 = writeSession('s2', jsonlUser('badger topic late', '2026-07-05T10:00:00.000Z'));
    idx.reconcileConversations([
      convo('c1', 'cos', [{ sessionId: 's1', agentId: 'cos', filePath: p1 }]),
      convo('c2', 'dev', [{ sessionId: 's2', agentId: 'dev', filePath: p2 }]),
    ]);
    assert.strictEqual(idx.searchMessages('badger', { collapse: false }).length, 2);
    const byAgent = idx.searchMessages('badger', { agentId: 'dev', collapse: false });
    assert.strictEqual(byAgent.length, 1);
    assert.strictEqual(byAgent[0].conversationId, 'c2');
    const byDate = idx.searchMessages('badger', { fromMs: Date.parse('2026-07-03T00:00:00Z'), collapse: false });
    assert.strictEqual(byDate.length, 1);
    assert.strictEqual(byDate[0].conversationId, 'c2');
    const toDate = idx.searchMessages('badger', { toMs: Date.parse('2026-07-03T00:00:00Z'), collapse: false });
    assert.strictEqual(toDate.length, 1);
    assert.strictEqual(toDate[0].conversationId, 'c1');
  });

  test('collapse mode returns the best hit per conversation with a match count', () => {
    const p = writeSession('s1',
      jsonlUser('vole mention one', '2026-07-01T10:00:00.000Z') +
      jsonlAssistant('vole mention two and vole again', '2026-07-01T10:01:00.000Z') +
      jsonlUser('vole mention three', '2026-07-01T10:02:00.000Z')
    );
    idx.reconcileConversations([convo('c1', 'cos', [{ sessionId: 's1', agentId: 'cos', filePath: p }])]);
    const hits = idx.searchMessages('vole');
    assert.strictEqual(hits.length, 1, 'default collapses to one hit per conversation');
    assert.strictEqual(hits[0].matchCount, 3);
  });

  test('removeConversation deletes its messages and marks', () => {
    const p = writeSession('s1', jsonlUser('ephemeral stoat content', '2026-07-01T10:00:00.000Z'));
    const c = convo('c1', 'cos', [{ sessionId: 's1', agentId: 'cos', filePath: p }]);
    idx.reconcileConversations([c]);
    assert.strictEqual(idx.searchMessages('stoat', { collapse: false }).length, 1);
    idx.removeConversation('c1');
    assert.strictEqual(idx.searchMessages('stoat', { collapse: false }).length, 0);
    // Marks are gone too: the next reconcile re-reads from zero.
    const r = idx.reconcileConversations([c]);
    assert.strictEqual(r.indexed, 1);
  });

  test('rebuild equivalence: delete the db and reconcile produces identical results', () => {
    const p1 = writeSession('s1',
      jsonlUser('capybara planning discussion', '2026-07-01T10:00:00.000Z') +
      jsonlAssistant('the capybara plan is sound', '2026-07-01T10:01:00.000Z')
    );
    const convos = [convo('c1', 'cos', [{ sessionId: 's1', agentId: 'cos', filePath: p1 }])];
    idx.reconcileConversations(convos);
    const before = idx.searchMessages('capybara', { collapse: false })
      .map(h => ({ c: h.conversationId, r: h.role, s: h.snippet, t: h.tsMs }));
    idx.close();
    fs.rmSync(dbPath, { force: true });
    for (const suffix of ['-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
    idx = createSearchIndex({ dbPath, DatabaseSync: probe.DatabaseSync });
    idx.open();
    idx.reconcileConversations(convos);
    const after = idx.searchMessages('capybara', { collapse: false })
      .map(h => ({ c: h.conversationId, r: h.role, s: h.snippet, t: h.tsMs }));
    assert.deepStrictEqual(after, before);
  });

  test('nasty queries never throw', () => {
    const p = writeSession('s1', jsonlUser('plain content', '2026-07-01T10:00:00.000Z'));
    idx.reconcileConversations([convo('c1', 'cos', [{ sessionId: 's1', agentId: 'cos', filePath: p }])]);
    for (const q of ['"unbalanced', 'a* OR b', '(paren', 'col:val', '-', '""', '日本語*()', null, undefined, 42]) {
      assert.doesNotThrow(() => idx.searchMessages(q, { collapse: false }), `query ${JSON.stringify(q)} threw`);
    }
  });

  test('a failing insert mid-delta is atomic: no partial rows, no mark, clean re-run', () => {
    // Simulates a crash mid-reconcile (Review R1 P2-2). Without a per-session
    // transaction, the first insert survives while the mark is never written,
    // so the next reconcile re-reads from offset 0 and duplicates messages.
    const p = writeSession('s1',
      jsonlUser('atomic ibis one', '2026-07-01T10:00:00.000Z') +
      jsonlAssistant('atomic ibis two', '2026-07-01T10:00:10.000Z')
    );
    const c = convo('c1', 'cos', [{ sessionId: 's1', agentId: 'cos', filePath: p }]);
    // Sabotage the second messages insert.
    const origPrepare = idx.db.prepare.bind(idx.db);
    let insertRuns = 0;
    idx.db.prepare = (sql) => {
      const stmt = origPrepare(sql);
      if (/INSERT INTO messages/.test(sql)) {
        const origRun = stmt.run.bind(stmt);
        stmt.run = (...args) => {
          insertRuns++;
          if (insertRuns === 2) throw new Error('simulated crash');
          return origRun(...args);
        };
      }
      return stmt;
    };
    assert.doesNotThrow(() => idx.reconcileConversations([c]), 'a session failure must not abort the reconcile');
    idx.db.prepare = origPrepare;
    assert.strictEqual(idx.searchMessages('ibis', { collapse: false }).length, 0, 'partial session rows rolled back');
    // Clean re-run indexes everything exactly once.
    const r = idx.reconcileConversations([c]);
    assert.strictEqual(r.indexed, 2);
    assert.strictEqual(idx.searchMessages('ibis', { collapse: false }).length, 2, 'no duplicates after recovery');
  });

  test('removeOrphanedConversations sweeps rows for conversations no longer known', () => {
    // (Review R1 P3-5)
    const p1 = writeSession('s1', jsonlUser('kept numbat content', '2026-07-01T10:00:00.000Z'));
    const p2 = writeSession('s2', jsonlUser('orphan numbat content', '2026-07-01T10:00:00.000Z'));
    idx.reconcileConversations([
      convo('keep', 'cos', [{ sessionId: 's1', agentId: 'cos', filePath: p1 }]),
      convo('gone', 'cos', [{ sessionId: 's2', agentId: 'cos', filePath: p2 }]),
    ]);
    assert.strictEqual(idx.searchMessages('numbat', { collapse: false }).length, 2);
    idx.removeOrphanedConversations(['keep']);
    const hits = idx.searchMessages('numbat', { collapse: false });
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].conversationId, 'keep');
    // The orphan's marks are gone too: re-adding it reindexes from zero.
    const r = idx.reconcileConversations([convo('gone', 'cos', [{ sessionId: 's2', agentId: 'cos', filePath: p2 }])]);
    assert.strictEqual(r.indexed, 1);
  });

  test('a missing session file is tolerated (no throw, no rows)', () => {
    const c = convo('c1', 'cos', [{ sessionId: 'ghost', agentId: 'cos', filePath: path.join(tmpRoot, 'nope.jsonl') }]);
    assert.doesNotThrow(() => idx.reconcileConversations([c]));
    assert.strictEqual(idx.searchMessages('anything', { collapse: false }).length, 0);
  });
});
