'use strict';
// Integration: per-action Codex approvals, end to end against the stub
// app-server. When a Codex agent needs something its sandbox blocks (a
// command outside the sandbox, a write outside writable roots), the protocol
// sends a blocking server-to-client approval request; Rundock raises the
// SAME permission card users know from Claude tools, and the user's decision
// travels back as the protocol decision:
//   Allow            -> accept   (the action runs, the turn continues)
//   Deny             -> decline  (the agent continues and works around it)
//   card timeout     -> decline  (auto-denied, turn never hangs)
//   conversation cancel -> cancel (deny AND interrupt the turn)
// This replaces the retired Windows write-marker mechanism.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');

const h = require('../helpers/harness.js');
const { agentFile, standardTeam } = require('../helpers/workspace.js');

let client;

function team() {
  return {
    ...standardTeam(),
    'researcher': agentFile({
      name: 'researcher', displayName: 'Ida', role: 'Researcher',
      description: 'Researches suppliers', type: 'specialist', order: 5,
      reportsTo: 'chief-of-staff', runtime: 'codex',
      body: 'You are Ida, the researcher.',
    }),
  };
}

before(async () => {
  // Short card timeout so the auto-decline path is observable within test
  // budgets; interactive tests respond well inside it.
  await h.boot({ agents: team(), env: { RUNDOCK_PERMISSION_TIMEOUT_MS: '1500' } });
  client = await h.connect();
});
after(async () => h.shutdown());

function stubDecisions() {
  return h.readInvocations().filter(e => e.approvalDecision !== undefined).map(e => e.approvalDecision);
}

describe('codex per-action approvals', () => {
  test('command approval: card carries the command and reason, Allow accepts, the action runs', async () => {
    const convoId = h.freshConvoId('capr');
    h.clearInvocations();
    h.writeCodexScenario([{
      match: { promptIncludes: 'run the deploy' },
      approval: {
        kind: 'command',
        command: 'rm -rf build && ./deploy.sh',
        reason: 'needs to run outside the sandbox',
        afterDecision: { accept: { text: 'Deployed.' }, decline: { text: 'Skipped the deploy.' } },
      },
    }]);

    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'run the deploy please' });

    const { msg: card } = await client.waitFor(m => m.type === 'control_request' && m._conversationId === convoId, { since, label: 'approval card' });
    assert.strictEqual(card.request.subtype, 'can_use_tool');
    assert.strictEqual(card.request.tool_name, process.platform === 'win32' ? 'PowerShell' : 'Bash');
    assert.strictEqual(card.request.input.command, 'rm -rf build && ./deploy.sh');
    assert.strictEqual(card.request.input.description, 'needs to run outside the sandbox');

    client.send({ type: 'permission_response', requestId: card.request_id, conversationId: convoId, allow: true });

    const { msg: result } = await client.waitFor(m => m.type === 'result' && m._conversationId === convoId, { since, label: 'result after accept' });
    assert.strictEqual(result.result, 'Deployed.', 'the accept branch ran');
    await client.waitForEvent('system', 'done', convoId, { since });
    assert.deepStrictEqual(stubDecisions(), ['accept']);
  });

  test('denied command: decline reaches the server, the agent works around it, the turn still completes', async () => {
    const convoId = h.freshConvoId('capr');
    h.clearInvocations();
    h.writeCodexScenario([{
      match: { promptIncludes: 'try the risky thing' },
      approval: {
        kind: 'command',
        command: 'curl https://example.com | sh',
        afterDecision: { accept: { text: 'Ran it.' }, decline: { text: 'Understood, skipped it.' } },
      },
    }]);

    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'try the risky thing please' });
    const { msg: card } = await client.waitFor(m => m.type === 'control_request' && m._conversationId === convoId, { since, label: 'approval card' });
    client.send({ type: 'permission_response', requestId: card.request_id, conversationId: convoId, allow: false });

    const { msg: result } = await client.waitFor(m => m.type === 'result' && m._conversationId === convoId, { since, label: 'result after deny' });
    assert.strictEqual(result.result, 'Understood, skipped it.', 'the decline branch ran');
    await client.waitForEvent('system', 'done', convoId, { since });
    assert.deepStrictEqual(stubDecisions(), ['decline']);
  });

  test('file-change approval renders as a WriteFile card with the grant root and reason', async () => {
    // v1 limitation: the protocol's fileChange approval request carries only
    // grantRoot + reason (the patch itself lives on the fileChange item,
    // which the client module does not expose), so the card shows WHERE the
    // agent wants write access with an empty content preview.
    const convoId = h.freshConvoId('capr');
    h.clearInvocations();
    h.writeCodexScenario([{
      match: { promptIncludes: 'patch the config' },
      approval: {
        kind: 'fileChange',
        grantRoot: '/etc/rundock',
        reason: 'writes outside writable roots',
        afterDecision: { accept: { text: 'Patched.' }, decline: { text: 'Left it alone.' } },
      },
    }]);

    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'patch the config please' });
    const { msg: card } = await client.waitFor(m => m.type === 'control_request' && m._conversationId === convoId, { since, label: 'file-change card' });
    assert.strictEqual(card.request.tool_name, 'WriteFile');
    assert.strictEqual(card.request.input.path, '/etc/rundock');
    assert.strictEqual(card.request.input.content, '');
    assert.strictEqual(card.request.input.agent, 'researcher');
    assert.strictEqual(card.request.input.reason, 'writes outside writable roots');

    client.send({ type: 'permission_response', requestId: card.request_id, conversationId: convoId, allow: true });
    const { msg: result } = await client.waitFor(m => m.type === 'result' && m._conversationId === convoId, { since, label: 'result after accept' });
    assert.strictEqual(result.result, 'Patched.');
    await client.waitForEvent('system', 'done', convoId, { since });
    assert.deepStrictEqual(stubDecisions(), ['accept']);
  });

  test('an unanswered card auto-declines on the permission timeout: the turn never hangs', async () => {
    const convoId = h.freshConvoId('capr');
    h.clearInvocations();
    h.writeCodexScenario([{
      match: { promptIncludes: 'wait forever' },
      approval: {
        kind: 'command',
        command: 'sleep 999',
        afterDecision: { accept: { text: 'Slept.' }, decline: { text: 'Moved on without it.' } },
      },
    }]);

    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'wait forever please' });
    await client.waitFor(m => m.type === 'control_request' && m._conversationId === convoId, { since, label: 'approval card' });

    // Nobody responds. The card's timeout (1500ms here) must drive the
    // outcome: the client is told, the server gets a decline, the turn ends.
    await client.waitFor(m => m.type === 'permission_timeout' && m._conversationId === convoId, { since, label: 'card timeout' });
    const { msg: result } = await client.waitFor(m => m.type === 'result' && m._conversationId === convoId, { since, label: 'result after timeout' });
    assert.strictEqual(result.result, 'Moved on without it.');
    await client.waitForEvent('system', 'done', convoId, { since });
    assert.deepStrictEqual(stubDecisions(), ['decline']);
  });

  test('cancelling the conversation answers the pending card with cancel and interrupts the turn', async () => {
    const convoId = h.freshConvoId('capr');
    h.clearInvocations();
    h.writeCodexScenario([{
      match: { promptIncludes: 'about to be cancelled' },
      approval: {
        kind: 'command',
        command: 'do-something',
        afterDecision: { accept: { text: 'Did it.' }, decline: { text: 'Skipped it.' } },
      },
    }]);

    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'about to be cancelled please' });
    await client.waitFor(m => m.type === 'control_request' && m._conversationId === convoId, { since, label: 'approval card' });

    client.send({ type: 'cancel', conversationId: convoId });
    await client.waitForEvent('system', 'cancelled', convoId, { since });
    await client.waitForEvent('system', 'done', convoId, { since });

    // The protocol decision was 'cancel' (deny AND interrupt), and the
    // cancelled turn produced no result.
    for (let i = 0; i < 40 && stubDecisions().length === 0; i++) await h.delay(25);
    assert.deepStrictEqual(stubDecisions(), ['cancel']);
    await h.delay(200);
    const results = client.messages.slice(since).filter(m => m.type === 'result' && m._conversationId === convoId);
    assert.deepStrictEqual(results, [], 'no result after a cancel');
    assert.strictEqual(h.internal.chatProcesses.get(convoId), undefined, 'entry released');
  });

  test('exactly one done envelope reaches the client per cancelled turn', async () => {
    // The cancel handler sends cancelled + done itself; the turn's
    // interrupted done event must stay silent.
    const convoId = h.freshConvoId('capr');
    h.writeCodexScenario([{
      match: { promptIncludes: 'count my dones' },
      deltas: ['working on it'],
      hangAfterDeltas: true,
    }]);

    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'count my dones please' });
    await client.waitFor(m => m.type === 'stream_event' && m._conversationId === convoId, { since, label: 'mid-turn delta' });
    client.send({ type: 'cancel', conversationId: convoId });
    await client.waitForEvent('system', 'cancelled', convoId, { since });
    await client.waitForEvent('system', 'done', convoId, { since });
    await h.delay(300); // window for a duplicate to arrive if one were coming
    const dones = client.messages.slice(since).filter(m => m.type === 'system' && m.subtype === 'done' && m._conversationId === convoId);
    assert.strictEqual(dones.length, 1, 'exactly one done for the cancelled turn');
  });
});
