'use strict';
// SR1 perf verification (spec: timed search on a 10k-message synthetic
// workspace, budget under 100ms server-side). Deliberately generous
// assertions relative to observed times (~1-5ms) so CI machines with noisy
// neighbours don't flake, while still catching order-of-magnitude
// regressions (e.g. an accidental table scan or per-hit file read).
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { probeSqlite, createSearchIndex } = require('../../search.js');

const probe = probeSqlite();
if (!probe.available) {
  test('search perf (skipped: no node:sqlite on this runtime)', { skip: true }, () => {});
  return;
}

let tmpRoot, idx;
const WORDS = ['pricing', 'roadmap', 'meeting', 'deploy', 'review', 'budget', 'launch', 'metric', 'design', 'sprint', 'onboarding', 'retention', 'infra', 'incident', 'margin'];

function sentence(i) {
  const w = (n) => WORDS[(i * n + n) % WORDS.length];
  return `Message ${i} covering ${w(1)} and ${w(2)} with a note on ${w(3)} planning.`;
}

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-searchperf-'));
  const dbPath = path.join(tmpRoot, 'search-index.db');
  idx = createSearchIndex({ dbPath, DatabaseSync: probe.DatabaseSync });
  idx.open();

  // 10,000 messages across 20 sessions / 20 conversations.
  const convos = [];
  for (let s = 0; s < 20; s++) {
    const lines = [];
    for (let m = 0; m < 500; m++) {
      const i = s * 500 + m;
      const role = m % 2 === 0 ? 'user' : 'assistant';
      const ts = new Date(Date.UTC(2026, 5, 1 + (s % 28), 9, 0, m % 60)).toISOString();
      lines.push(JSON.stringify(role === 'user'
        ? { type: 'user', message: { role: 'user', content: sentence(i) }, timestamp: ts }
        : { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: sentence(i) }] }, timestamp: ts }));
    }
    const p = path.join(tmpRoot, `sess-${s}.jsonl`);
    fs.writeFileSync(p, lines.join('\n') + '\n');
    convos.push({ conversationId: `c${s}`, sessions: [{ sessionId: `sess-${s}`, agentId: 'cos', filePath: p }] });
  }
  const t0 = process.hrtime.bigint();
  const r = idx.reconcileConversations(convos);
  const buildMs = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.strictEqual(r.indexed, 10000);
  console.log(`  [perf] initial index of 10k messages: ${buildMs.toFixed(0)}ms`);
});

after(() => {
  try { idx.close(); } catch (e) {}
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('search performance at 10k messages', () => {
  test('query with snippet + neighbour assembly stays under the 100ms budget', () => {
    // Warm once (first query pays statement compilation).
    idx.searchMessages('pricing roadmap');
    const runs = 10;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < runs; i++) {
      const hits = idx.searchMessages(WORDS[i % WORDS.length], { limit: 20 });
      assert.ok(hits.length > 0);
    }
    const avgMs = Number(process.hrtime.bigint() - t0) / 1e6 / runs;
    console.log(`  [perf] avg query time over ${runs} runs: ${avgMs.toFixed(2)}ms`);
    assert.ok(avgMs < 100, `average query ${avgMs.toFixed(1)}ms exceeds the 100ms budget`);
  });

  test('no-op reconcile over 20 unchanged sessions is effectively free', () => {
    const convos = [];
    for (let s = 0; s < 20; s++) {
      convos.push({ conversationId: `c${s}`, sessions: [{ sessionId: `sess-${s}`, agentId: 'cos', filePath: path.join(tmpRoot, `sess-${s}.jsonl`) }] });
    }
    const t0 = process.hrtime.bigint();
    const r = idx.reconcileConversations(convos);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.strictEqual(r.indexed, 0);
    assert.strictEqual(r.sessionsRead, 0);
    console.log(`  [perf] no-op reconcile of 20 sessions: ${ms.toFixed(2)}ms`);
    assert.ok(ms < 50, `no-op reconcile ${ms.toFixed(1)}ms is too slow for the per-search path`);
  });
});
