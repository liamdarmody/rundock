'use strict';
// Integration: a Claude Code turn held quiet keeps sending keepalives until
// its result.
//
// The chat screen finishes a turn it has heard nothing from for 90 seconds,
// and Claude Code prints nothing while it summarizes a long conversation,
// thinks, runs a silent tool or waits on a permission card. So while a Claude
// Code turn is running, the server sends `{type:'system', subtype:'keepalive'}`
// with the turn's conversation and process ids every
// RUNDOCK_CLAUDE_KEEPALIVE_MS (25s in production; shrunk here), and stops at
// the turn's result. Driven through the stub Claude Code, each turn held quiet
// on a file the test writes when it is done looking. The Codex heartbeat has
// its own test beside this one (codex-keepalive.test.js).
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../helpers/harness.js');
const { agentFile, standardTeam } = require('../helpers/workspace.js');

const KEEPALIVE_MS = 120;

const CAPTURE = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'compaction', 'claude-compact.jsonl'), 'utf8')
  .trim().split('\n').map((l) => JSON.parse(l));
const COMPACTING = CAPTURE.find((l) => l.subtype === 'status' && l.status === 'compacting');
const COMPACTED = CAPTURE.find((l) => l.subtype === 'status' && l.compact_result);
const BOUNDARY = CAPTURE.find((l) => l.subtype === 'compact_boundary');

let client;

function team() {
  return {
    ...standardTeam(),
    'researcher': agentFile({
      name: 'researcher', displayName: 'Alpha', role: 'Researcher',
      description: 'Researches suppliers', type: 'specialist', order: 5,
      reportsTo: 'chief-of-staff', runtime: 'codex',
      body: 'You are Alpha, the researcher.',
    }),
  };
}

before(async () => {
  await h.boot({ agents: team(), env: { RUNDOCK_CLAUDE_KEEPALIVE_MS: String(KEEPALIVE_MS) } });
  client = await h.connect();
});
after(async () => h.shutdown());

const isBeat = (m, convoId) => m.type === 'system' && m.subtype === 'keepalive' && m._conversationId === convoId;
const holdFile = (tag) => path.join(h.workspaceDir, `hold-${tag}-${process.pid}`);
const letGo = (file) => fs.writeFileSync(file, '');

async function startOrchestrator(convoId, keyword) {
  h.writeScenario([
    { match: { agent: 'chief-of-staff', promptIncludes: keyword }, turn: [{ text: `Ready (${keyword}).` }] },
  ]);
  const since = client.messages.length;
  client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: keyword });
  const { msg } = await client.waitForEvent('system', 'process_started', convoId, { since });
  await client.waitForEvent('system', 'done', convoId, { since });
  return msg._processId;
}

// While the turn is held: keepalives for its process keep arriving, each
// carrying the agent, the conversation and the process.
async function expectHeartbeat(convoId, started, label) {
  const from = client.messages.indexOf(started);
  const beats = () => client.messages.slice(from).filter((m) => isBeat(m, convoId) && m._processId === started._processId);
  const arrived = await h.waitUntil(() => beats().length >= 3, { timeout: 8000 });
  assert.ok(arrived, `${label}: expected keepalives while the turn is quiet, got ${beats().length}`);
  for (const beat of beats()) {
    assert.strictEqual(beat._agent, started._agent, `${label}: the keepalive names the agent`);
    assert.strictEqual(beat._conversationId, convoId, `${label}: and the conversation`);
  }
}

// After the result, several intervals pass with no keepalive for the process.
async function expectStoppedAfter(convoId, processId, resultIdx, label) {
  await h.delay(KEEPALIVE_MS * 4);
  const late = client.messages.slice(resultIdx + 1).filter((m) => isBeat(m, convoId) && m._processId === processId);
  assert.strictEqual(late.length, 0, `${label}: no keepalive after the result`);
}

describe('a quiet Claude Code turn heartbeats until its result', () => {
  test('a direct chat that summarizes and goes quiet heartbeats with its ids, and stops at its result', async () => {
    const convoId = h.freshConvoId('clka');
    const hold = holdFile('direct');
    h.writeScenario([{
      match: { agent: 'chief-of-staff', promptIncludes: 'quiet direct task' },
      turn: [{ raw: COMPACTING }, { holdUntil: hold }, { raw: COMPACTED }, { raw: BOUNDARY }, { text: 'Here is the answer.' }],
    }]);

    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'quiet direct task' });
    const { msg: started } = await client.waitForEvent('system', 'process_started', convoId, { since });
    await expectHeartbeat(convoId, started, 'summarizing');

    letGo(hold);
    const { index: resultIdx } = await client.waitFor(m => m.type === 'result' && m._conversationId === convoId, { since, label: 'direct result' });
    const others = client.messages.slice(since, resultIdx).filter((m) => isBeat(m, convoId) && m._processId !== started._processId);
    assert.deepStrictEqual(others, [], 'every keepalive in the turn is its own process');
    await expectStoppedAfter(convoId, started._processId, resultIdx, 'direct');
    h.reapConvo(convoId);
  });

  test('a delegated turn held quiet heartbeats with the delegate\'s ids, and stops at its result', async () => {
    const convoId = h.freshConvoId('clka');
    const hold = holdFile('delegate');
    h.writeScenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 'quiet delegate please' },
        turn: [{ agentTool: { subagent_type: 'content-lead', prompt: 'quiet delegate brief' } }] },
      { match: { agent: 'content-lead', promptIncludes: 'quiet delegate brief' }, untilFile: hold,
        turn: [{ text: 'Delegate finished. <!-- RUNDOCK:COMPLETE -->' }] },
      { match: { agent: 'chief-of-staff', promptIncludes: '[SYSTEM: pipeline-complete]' },
        turn: [{ text: '<silent>' }] },
    ]);

    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'quiet delegate please' });
    const { msg: started } = await client.waitFor(
      m => m.type === 'system' && m.subtype === 'process_started' && m._conversationId === convoId && m._agent === 'content-lead',
      { since, label: 'delegate process_started' });
    await expectHeartbeat(convoId, started, 'delegate');

    letGo(hold);
    const { index: resultIdx } = await client.waitFor(
      m => m.type === 'result' && m._conversationId === convoId && m._agent === 'content-lead',
      { since, label: 'delegate result' });
    await expectStoppedAfter(convoId, started._processId, resultIdx, 'delegate');
    h.reapConvo(convoId);
  });

  test('the next message to the same live process starts the heartbeat again', async () => {
    const convoId = h.freshConvoId('clka');
    const firstProcess = await startOrchestrator(convoId, 'second-message-setup');
    const hold = holdFile('second');
    h.writeScenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 'quiet second message' }, untilFile: hold,
        turn: [{ text: 'Second answer.' }] },
    ]);

    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'quiet second message' });
    const { msg: started } = await client.waitForEvent('system', 'process_started', convoId, { since });
    assert.strictEqual(started._processId, firstProcess, 'sanity: the live process took the message');
    await expectHeartbeat(convoId, started, 'second message');

    letGo(hold);
    const { index: resultIdx } = await client.waitFor(m => m.type === 'result' && m._conversationId === convoId, { since, label: 'second result' });
    await expectStoppedAfter(convoId, started._processId, resultIdx, 'second message');
    h.reapConvo(convoId);
  });

  test('an automatic continue after an out-of-scope return heartbeats on the living orchestrator', async () => {
    const convoId = h.freshConvoId('clka');
    await startOrchestrator(convoId, 'skip-return-setup');
    const hold = holdFile('skip-return');
    h.writeScenario([
      { match: { agent: 'content-lead', promptIncludes: 'skip-return task' },
        turn: [{ agentTool: { subagent_type: 'content-analyst', prompt: 'skip-return sub brief' } }] },
      { match: { agent: 'content-analyst', promptIncludes: 'skip-return sub brief' },
        turn: [{ text: 'Outside my scope. <!-- RUNDOCK:RETURN -->' }] },
      { match: { agent: 'chief-of-staff', promptIncludes: 'A specialist just returned' }, untilFile: hold,
        turn: [{ text: 'Routing the pending request onward.' }] },
    ]);

    const since = client.messages.length;
    client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'content-lead', context: 'skip-return task' });
    const { msg: started } = await client.waitFor(
      m => m.type === 'system' && m.subtype === 'process_started' && m._conversationId === convoId && m._agent === 'chief-of-staff' && m.autoContinue,
      { since, label: 'orchestrator auto-continue started' });
    await expectHeartbeat(convoId, started, 'orchestrator auto-continue');

    letGo(hold);
    const { index: resultIdx } = await client.waitFor(
      m => m.type === 'result' && m._conversationId === convoId && m._agent === 'chief-of-staff',
      { since, label: 'routing answer' });
    await expectStoppedAfter(convoId, started._processId, resultIdx, 'orchestrator auto-continue');
    h.reapConvo(convoId);
  });

  test('an automatic continue after a specialist says the work continues heartbeats on the restored parent', async () => {
    const convoId = h.freshConvoId('clka');
    await startOrchestrator(convoId, 'continue-setup');
    const hold = holdFile('continue');
    h.writeScenario([
      { match: { agent: 'content-lead', promptIncludes: 'continue task' },
        turn: [{ text: 'Draft written. Passing this back to route onward. <!-- RUNDOCK:CONTINUE -->' }] },
      { match: { agent: 'chief-of-staff', promptIncludes: 'needs more work' }, untilFile: hold,
        turn: [{ text: 'Carrying it on.' }] },
    ]);

    const since = client.messages.length;
    client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'content-lead', context: 'continue task' });
    const { msg: started } = await client.waitFor(
      m => m.type === 'system' && m.subtype === 'process_started' && m._conversationId === convoId && m._agent === 'chief-of-staff' && m.autoContinue,
      { since, label: 'parent auto-continue started' });
    await expectHeartbeat(convoId, started, 'parent auto-continue');

    letGo(hold);
    const { index: resultIdx } = await client.waitFor(
      m => m.type === 'result' && m._conversationId === convoId && m._agent === 'chief-of-staff',
      { since, label: 'parent answer' });
    await expectStoppedAfter(convoId, started._processId, resultIdx, 'parent auto-continue');
    h.reapConvo(convoId);
  });

  test('a Codex turn keeps only its own heartbeat', async () => {
    // Codex's interval is left at 25 seconds here, so a keepalive inside this
    // short quiet turn could only be a second heartbeat.
    const convoId = h.freshConvoId('clka');
    h.writeCodexScenario([{
      match: { promptIncludes: 'codex quiet task' },
      delayMs: KEEPALIVE_MS * 8,
      text: 'Codex done.',
    }]);

    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'codex quiet task' });
    const { index: resultIdx } = await client.waitFor(m => m.type === 'result' && m._conversationId === convoId, { since, label: 'codex result' });
    const beats = client.messages.slice(since, resultIdx).filter((m) => isBeat(m, convoId));
    assert.deepStrictEqual(beats, [], 'no Claude Code heartbeat on a Codex turn');
    h.reapConvo(convoId);
  });
});

describe('a Claude Code process killed during a quiet turn', () => {
  // Killed with no result and no Stop, as a crash ends one. The chat's own
  // close handling in the server runs as it did before the heartbeat: the
  // screen is told the turn is done and the process is let go.
  test('a process killed mid-quiet stops beating at its close, and the server still says the turn is done and lets the process go', async () => {
    const convoId = h.freshConvoId('clka');
    const hold = holdFile('killed');
    h.writeScenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 'quiet task that is killed' }, untilFile: hold,
        turn: [{ text: 'Never answered.' }] },
    ]);

    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'quiet task that is killed' });
    const { msg: started } = await client.waitForEvent('system', 'process_started', convoId, { since });
    try {
      await expectHeartbeat(convoId, started, 'before the kill');
      const entry = h.internal.chatProcesses.get(convoId);
      assert.strictEqual(entry && entry.processId, started._processId, 'sanity: the server holds the quiet process');
      entry.process.kill('SIGKILL');

      const doneAt = () => client.messages.findIndex((m, i) => i >= since && m.type === 'system' && m.subtype === 'done'
        && m._conversationId === convoId && m._processId === started._processId);
      assert.ok(await h.waitUntil(() => doneAt() >= 0, { timeout: 4000 }),
        'the screen is told the turn is done, as for any process that closes without a result');
      assert.ok(await h.waitUntil(() => !h.internal.chatProcesses.has(convoId), { timeout: 4000 }),
        'and the server lets the process go');
      assert.ok(!client.messages.slice(since).some((m) => m.type === 'result' && m._conversationId === convoId),
        'sanity: the turn never gave a result');

      const closedAt = doneAt();
      await h.delay(KEEPALIVE_MS * 4);
      const late = client.messages.slice(closedAt + 1).filter((m) => isBeat(m, convoId) && m._processId === started._processId);
      assert.strictEqual(late.length, 0, 'no keepalive after the close');
    } finally {
      h.reapConvo(convoId);
    }
  });
});
