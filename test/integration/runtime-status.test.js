'use strict';
// Integration: runtime status reporting for the settings surface, and the
// runtime tag on agent-saved confirmations.
//
// Status honesty rules under test:
// - Codex reports the full three-state vocabulary from presence checks
//   (binary on PATH, auth.json exists under the Codex home; never read).
// - Claude auth is reported from evidence the server already has: null
//   before any evidence (the UI claims nothing), true after a successful
//   turn. No live probe is ever run for a settings render.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const h = require('../helpers/harness.js');
const { agentFile, standardTeam } = require('../helpers/workspace.js');

let client;

before(async () => {
  await h.boot({ agents: standardTeam() });
  client = await h.connect();
});
after(async () => h.shutdown());

describe('runtime status', () => {
  test('reports both runtimes with versions; codex not signed in without auth.json; claude auth unknown before evidence', async () => {
    const since = client.messages.length;
    client.send({ type: 'get_runtime_status' });
    const { msg } = await client.waitFor(m => m.type === 'runtime_status', { since, label: 'runtime_status' });

    assert.strictEqual(msg.defaultRuntime, 'claude');
    assert.strictEqual(msg.claude.installed, true);
    assert.strictEqual(msg.claude.version, '0.0.0-stub');
    assert.strictEqual(msg.claude.authenticated, null, 'no auth claim without evidence');
    assert.strictEqual(msg.codex.installed, true);
    assert.strictEqual(msg.codex.version, '0.0.0-stub');
    assert.strictEqual(msg.codex.authenticated, false, 'no auth.json yet');
  });

  test('codex reports signed in once auth.json exists (presence only)', async () => {
    fs.mkdirSync(path.join(os.homedir(), '.codex'), { recursive: true });
    fs.writeFileSync(path.join(os.homedir(), '.codex', 'auth.json'), '{}');

    const since = client.messages.length;
    client.send({ type: 'get_runtime_status' });
    const { msg } = await client.waitFor(m => m.type === 'runtime_status', { since, label: 'runtime_status' });
    assert.strictEqual(msg.codex.authenticated, true);
  });

  test('claude auth flips to true after a successful turn (evidence-based)', async () => {
    const convoId = h.freshConvoId('rt');
    h.writeScenario([{ match: {}, turn: [{ text: 'evidence.' }] }]);
    client.send({ type: 'chat', conversationId: convoId, agent: 'lead-designer', content: 'evidence please' });
    await client.waitForEvent('system', 'done', convoId);

    const since = client.messages.length;
    client.send({ type: 'get_runtime_status' });
    const { msg } = await client.waitFor(m => m.type === 'runtime_status', { since, label: 'runtime_status' });
    assert.strictEqual(msg.claude.authenticated, true);
  });
});

describe('platform agent runtime awareness', () => {
  test('Doc gets the RUNTIMES prompt section only when Codex is signed in; specialists never do', () => {
    // auth.json exists from the earlier test, so Codex reports signed in.
    const platformPrompt = h.internal.buildSystemPrompt({ id: 'doc', type: 'platform', displayName: 'Doc' });
    assert.ok(platformPrompt.includes('RUNTIMES:'), 'platform agent prompt carries runtime availability');
    assert.ok(platformPrompt.includes('runtime: codex'), 'frontmatter opt-in instruction present');
    assert.ok(platformPrompt.includes('without asking'), 'default-without-ceremony instruction present');

    const specialistPrompt = h.internal.buildSystemPrompt({ id: 'writer', type: 'specialist', displayName: 'Writer' });
    assert.ok(!specialistPrompt.includes('RUNTIMES:'), 'specialists get no runtime section');
  });
});

describe('agent_saved runtime tag', () => {
  test('saving a codex agent reports runtime codex; a claude agent reports claude', async () => {
    let since = client.messages.length;
    client.send({ type: 'save_agent', name: 'codex-writer', content: agentFile({ name: 'codex-writer', type: 'specialist', order: 7, runtime: 'codex' }) });
    const { msg: saved } = await client.waitFor(m => m.type === 'agent_saved' && m.agentId === 'codex-writer', { since, label: 'codex agent_saved' });
    assert.strictEqual(saved.runtime, 'codex');

    since = client.messages.length;
    client.send({ type: 'save_agent', name: 'plain-writer', content: agentFile({ name: 'plain-writer', type: 'specialist', order: 8 }) });
    const { msg: saved2 } = await client.waitFor(m => m.type === 'agent_saved' && m.agentId === 'plain-writer', { since, label: 'claude agent_saved' });
    assert.strictEqual(saved2.runtime, 'claude');
  });
});
