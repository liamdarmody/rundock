'use strict';
// Characterization: handleScopeReturn edge paths the delegation pipeline
// tests never reach, plus the workspace discovery scan. Written while
// restoring the server.js overall coverage floor after the agents
// extraction (moving well-covered code out makes the remaining uncovered
// edges weigh more); each pin here is behaviour a later extraction slice
// must hold.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const h = require('../helpers/harness.js');
const { makeWorkspace, agentFile } = require('../helpers/workspace.js');

let client;
before(async () => { await h.boot(); client = await h.connect(); });
after(h.shutdown);

describe('workspace discovery scan', () => {
  test('Documents subdirectories are scanned; agent count and Rundock frontmatter are detected', () => {
    // The harness points HOME at a disposable temp dir, so the scan sees
    // only what this test plants.
    const home = process.env.HOME;
    const projA = path.join(home, 'Documents', 'proj-a');
    fs.mkdirSync(path.join(projA, '.claude', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(projA, '.claude', 'agents', 'lead.md'),
      '---\nname: lead\ntype: specialist\norder: 1\n---\nbody\n');
    const projB = path.join(home, 'Documents', 'proj-b');
    fs.mkdirSync(projB, { recursive: true });
    fs.writeFileSync(path.join(projB, 'CLAUDE.md'), '# Proj B\n');
    // Skipped by the scan: node_modules and dot-directories.
    fs.mkdirSync(path.join(home, 'Documents', 'node_modules', 'dep'), { recursive: true });
    fs.mkdirSync(path.join(home, 'Documents', '.hidden'), { recursive: true });

    const found = h.internal.discoverWorkspaces();
    const a = found.find(w => w.path === projA);
    const b = found.find(w => w.path === projB);
    assert.ok(a, 'workspace with .claude/agents is discovered');
    assert.strictEqual(a.agentCount, 1, 'agent files are counted');
    assert.strictEqual(a.hasRundockFrontmatter, true, 'type: + order: frontmatter is detected');
    assert.ok(b, 'workspace with only CLAUDE.md is discovered');
    assert.strictEqual(b.agentCount, 0);
    assert.strictEqual(b.hasRundockFrontmatter, false);
    assert.ok(!found.some(w => w.path.includes('node_modules')), 'node_modules is never a workspace candidate');
    assert.ok(!found.some(w => path.basename(w.path).startsWith('.')), 'dot-directories are never candidates');
  });
});

describe('handleScopeReturn edges', () => {
  test('no orchestrator on the roster: specialist done is sent and the convo entry is cleared', async () => {
    // A workspace with a lone specialist and no CLAUDE.md has no
    // orchestrator to route back to; the return must end the turn cleanly
    // instead of crashing or leaving a stale entry.
    const soloDir = makeWorkspace({ agents: { solo: agentFile({ name: 'solo', type: 'specialist', order: 1 }) } });
    h.internal.setWorkspace(soloDir);
    try {
      const convoId = h.freshConvoId('sre-noorch');
      const entry = { agentId: 'solo', processId: 'p-noorch', lastUserMessage: 'hello' };
      h.internal.chatProcesses.set(convoId, entry);
      const since = client.messages.length;
      h.internal.handleScopeReturn(entry, convoId, false);
      const { msg } = await client.waitFor(
        m => m.type === 'system' && m.subtype === 'done' && m._conversationId === convoId,
        { since, label: 'specialist done without orchestrator' });
      assert.strictEqual(msg._agent, 'solo', 'the done belongs to the returning specialist');
      assert.strictEqual(msg.code, 0);
      assert.strictEqual(h.internal.chatProcesses.get(convoId), undefined, 'convo entry cleared');
    } finally {
      h.internal.setWorkspace(h.workspaceDir);
    }
  });

  test('circuit breaker: consecutive handoffs pause the orchestrator instead of writing the routing prompt', async () => {
    const convoId = h.freshConvoId('sre-breaker');
    h.internal.agentAutoResumeCount.set(convoId, h.internal.MAX_CONSECUTIVE_AGENT_RESUMES - 1);
    const entry = { agentId: 'content-lead', processId: 'p-brk', lastUserMessage: 'do the thing', toolCalls: [] };
    const since = client.messages.length;
    h.internal.handleScopeReturn(entry, convoId, false);
    const { msg } = await client.waitFor(
      m => m.type === 'assistant' && m._conversationId === convoId,
      { since, label: 'auto-paused breaker message' });
    assert.match(msg.message.content, /Auto-paused: \d+ consecutive agent handoffs/,
      'the user is told why the orchestrator paused');
    assert.strictEqual(h.internal.agentAutoResumeCount.get(convoId), 0, 'the breaker resets the count');
    const orch = h.internal.chatProcesses.get(convoId);
    assert.ok(orch && orch.idle, 'the orchestrator entry stays live and parked idle');
    h.reapConvo(convoId);
  });
});
