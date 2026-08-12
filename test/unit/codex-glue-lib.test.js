'use strict';
// Seam tests for lib/runtime/codex-glue.js. The real behaviour (turns,
// delegates, approvals, failure surfaces) is pinned by the codex
// integration suite driving the wired module through a booted server;
// these tests pin the SEAMS themselves: unwired deps refuse loudly, the
// live-state accessors are used by identity (the glue mutates the caller's
// own map, never a copy), the app-server pid accessor exists for the
// root's synchronous exit handler, and agent instructions resolve the
// workspace at USE time so a switch redirects the very next read.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const GLUE_KEY = require.resolve('../../lib/runtime/codex-glue.js');

// A private copy per test: wiring one test's fakes must never leak into
// another test (or into the shared instance other requires would see).
function freshGlue() {
  const cached = require.cache[GLUE_KEY];
  delete require.cache[GLUE_KEY];
  const mod = require(GLUE_KEY);
  delete require.cache[GLUE_KEY];
  if (cached) require.cache[GLUE_KEY] = cached;
  return mod;
}

test('unwired root deps throw the named wiring error at first use', () => {
  const glue = freshGlue();
  assert.throws(
    () => glue.startCodexTurn('convo-unwired', { content: 'hi' }, { id: 'agent-a' }),
    /lib\/runtime\/codex-glue: chatProcesses not wired \(call wireCodexGlueDeps at boot\)/,
  );
});

test('live-state accessors are used by identity: the glue writes into the caller\'s own map', () => {
  const glue = freshGlue();
  const myMap = new Map();
  glue.wireCodexGlueDeps({ chatProcesses: () => myMap });
  // safeSend is still unwired, so the turn stops right after the entry is
  // registered; the throw is the proof the glue got exactly that far.
  assert.throws(
    () => glue.startCodexTurn('convo-identity', { content: 'hi' }, { id: 'agent-a' }),
    /safeSend not wired/,
  );
  const entry = myMap.get('convo-identity');
  assert.ok(entry, 'the entry landed in MY map, not a module-internal copy');
  assert.strictEqual(entry.runtime, 'codex');
  assert.strictEqual(entry.agentId, 'agent-a');
  assert.strictEqual(typeof entry.interrupt, 'function', 'entry controls attached before registration');
});

test('wireCodexGlueDeps returns the previous set, restorable by identity', () => {
  const glue = freshGlue();
  const prev = glue.wireCodexGlueDeps({ chatProcesses: () => new Map() });
  assert.strictEqual(typeof prev.chatProcesses, 'function');
  glue.wireCodexGlueDeps(prev);
  assert.throws(
    () => glue.startCodexTurn('convo-restored', { content: 'hi' }, { id: 'agent-a' }),
    /chatProcesses not wired/,
  );
});

test('the app-server pid accessor answers null before any server exists', () => {
  const glue = freshGlue();
  assert.strictEqual(glue.getCodexAppServerPid(), null);
});

test('agent instructions resolve the workspace at USE time: a switch redirects the next read', () => {
  const glue = freshGlue();
  const config = require('../../lib/config.js');
  const original = config.getWorkspace();
  const wsA = fs.mkdtempSync(path.join(os.tmpdir(), 'glue-ws-a-'));
  const wsB = fs.mkdtempSync(path.join(os.tmpdir(), 'glue-ws-b-'));
  try {
    for (const [ws, body] of [[wsA, 'Body from workspace A.'], [wsB, 'Body from workspace B.']]) {
      const dir = path.join(ws, '.claude', 'agents');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'ida.md'), `---\nname: ida\n---\n${body}\n`);
    }
    const agentData = { fileName: 'ida.md', instructions: 'stale discovery snapshot' };
    config.setWorkspace(wsA);
    assert.strictEqual(glue.readAgentInstructions(agentData), 'Body from workspace A.');
    config.setWorkspace(wsB);
    assert.strictEqual(glue.readAgentInstructions(agentData), 'Body from workspace B.',
      'the read followed the switch with no re-wiring');
    // No workspace at all: the (truncated) discovery snapshot is the fallback.
    config.setWorkspace(null);
    assert.strictEqual(glue.readAgentInstructions(agentData), 'stale discovery snapshot');
  } finally {
    config.setWorkspace(original);
    fs.rmSync(wsA, { recursive: true, force: true });
    fs.rmSync(wsB, { recursive: true, force: true });
  }
});
