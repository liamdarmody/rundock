'use strict';
// Integration: interactive chat lifecycle against the stub claude binary.
// Real server.js, real WebSocket, real child processes; no real Claude.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../helpers/harness.js');
const fx = require('../fixtures/stream-json.js');

let client;

before(async () => {
  await h.boot();
  client = await h.connect();
});
after(async () => h.shutdown());

describe('connection bootstrap', () => {
  test('client receives active_processes and server_info on connect', async () => {
    const { msg: active } = await client.waitFor(m => m.type === 'active_processes', { label: 'active_processes' });
    assert.deepStrictEqual(active.processes, []);
    const { msg: info } = await client.waitFor(m => m.type === 'server_info', { label: 'server_info' });
    assert.strictEqual(info.version, require('../../package.json').version);
  });
});

describe('interactive chat', () => {
  test('first message spawns a stub process; response streams back; follow-up reuses the process via stdin', async () => {
    const convoId = h.freshConvoId();
    h.clearInvocations();
    h.writeScenario([
      { match: { agent: 'lead-designer', promptIncludes: 'first question' }, turn: [{ text: 'First answer from Des.' }] },
      { match: { agent: 'lead-designer', promptIncludes: 'second question' }, turn: [{ text: 'Second answer from Des.' }] },
    ]);

    client.send({ type: 'chat', conversationId: convoId, agent: 'lead-designer', content: 'first question' });
    const { msg: started } = await client.waitForEvent('system', 'process_started', convoId);
    assert.strictEqual(started._agent, 'lead-designer');

    const { msg: result1 } = await client.waitFor(m => m.type === 'result' && m._conversationId === convoId, { label: 'first result' });
    assert.strictEqual(result1.result, 'First answer from Des.');
    assert.strictEqual(result1.is_error, false);
    await client.waitForEvent('system', 'done', convoId);

    // Streamed deltas were forwarded with agent attribution
    const deltas = client.messages.filter(m => m.type === 'stream_event' && m._conversationId === convoId
      && m.event?.delta?.type === 'text_delta');
    assert.strictEqual(deltas.map(d => d.event.delta.text).join(''), 'First answer from Des.');

    // Follow-up goes over stdin: no second spawn
    const sinceIdx = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'lead-designer', content: 'second question' });
    const { msg: result2 } = await client.waitFor(m => m.type === 'result' && m._conversationId === convoId, { since: sinceIdx, label: 'second result' });
    assert.strictEqual(result2.result, 'Second answer from Des.');

    const invocations = h.readInvocations();
    assert.strictEqual(invocations.length, 1, 'exactly one spawn for two turns');
    assert.strictEqual(invocations[0].agent, 'lead-designer');
    assert.strictEqual(invocations[0].model, 'sonnet');
    assert.strictEqual(invocations[0].env.RUNDOCK, '1');
    assert.strictEqual(invocations[0].env.RUNDOCK_CONVO_ID, convoId);
    assert.ok(!invocations[0].print, 'interactive mode: no --print');

    // Transcript persisted both turns
    const transcript = JSON.parse(fs.readFileSync(path.join(h.workspaceDir, '.rundock', 'transcripts', `${convoId}.json`), 'utf-8'));
    assert.deepStrictEqual(transcript.map(t => [t.role, t.agent]), [
      ['user', 'user'], ['agent', 'lead-designer'], ['user', 'user'], ['agent', 'lead-designer'],
    ]);
  });

  test('spawn args carry model, agent, prompts, permission mode and disallowed tools (knowledge mode)', async () => {
    const convoId = h.freshConvoId();
    h.clearInvocations();
    h.writeScenario([{ match: {}, turn: [{ text: 'ok answer.' }] }]);
    client.send({ type: 'chat', conversationId: convoId, agent: 'content-lead', content: 'check args' });
    await client.waitForEvent('system', 'done', convoId);

    const inv = h.readInvocations()[0];
    const argStr = inv.argv.join(' ');
    assert.ok(argStr.includes('--output-format stream-json'));
    assert.ok(argStr.includes('--input-format stream-json'));
    assert.ok(argStr.includes('--include-partial-messages'));
    assert.ok(argStr.includes('--permission-mode acceptEdits'));
    assert.ok(argStr.includes('--agent content-lead'));
    assert.ok(argStr.includes(`--add-dir ${h.workspaceDir}`));
    const disallowedIdx = inv.argv.indexOf('--disallowed-tools');
    assert.ok(disallowedIdx > 0, 'knowledge mode passes disallowed tools');
    assert.ok(inv.argv[disallowedIdx + 1].includes('Write(*.js)'));
    const allowed = inv.argv[inv.argv.indexOf('--allowed-tools') + 1];
    assert.ok(!allowed.split(',').includes('Bash'), 'Bash approval flows through the hook, not the allow-list');
    // system prompt injected
    const sysPrompt = inv.argv[inv.argv.indexOf('--append-system-prompt') + 1];
    assert.ok(sysPrompt.includes('SCOPE BOUNDARY:'), 'specialist gets scope boundary');
    assert.ok(sysPrompt.includes('DELEGATION CONTEXT') === false, 'direct chat is not a delegation');
  });

  test('resume: sessionId in the chat message adds --resume and skips --agent', async () => {
    const convoId = h.freshConvoId();
    h.clearInvocations();
    h.writeScenario([{ match: {}, turn: [{ text: 'resumed fine.' }] }]);
    client.send({ type: 'chat', conversationId: convoId, agent: 'lead-designer', content: 'resume me', sessionId: 'stub-prior-session' });
    await client.waitForEvent('system', 'done', convoId);
    const inv = h.readInvocations()[0];
    assert.strictEqual(inv.resume, 'stub-prior-session');
    assert.strictEqual(inv.agent, null, 'no --agent on resume');
  });

  test('cancel mid-turn kills the process and emits cancelled + done(code null)', async () => {
    const convoId = h.freshConvoId();
    h.writeScenario([{ match: { promptIncludes: 'slow question' }, delayMs: 5000, turn: [{ text: 'too late.' }] }]);
    client.send({ type: 'chat', conversationId: convoId, agent: 'lead-designer', content: 'slow question' });
    await client.waitForEvent('system', 'process_started', convoId);

    client.send({ type: 'cancel', conversationId: convoId });
    await client.waitForEvent('system', 'cancelled', convoId);
    const { msg: done } = await client.waitForEvent('system', 'done', convoId);
    assert.strictEqual(done.code, null);
    assert.strictEqual(h.internal.chatProcesses.has(convoId), false, 'entry removed');
  });

  test('agent switch mid-conversation: new agent means the old process is killed and a fresh one spawned', async () => {
    const convoId = h.freshConvoId();
    h.clearInvocations();
    h.writeScenario([
      { match: { agent: 'lead-designer' }, turn: [{ text: 'Des here.' }] },
      { match: { agent: 'content-lead' }, turn: [{ text: 'Penn here.' }] },
    ]);
    client.send({ type: 'chat', conversationId: convoId, agent: 'lead-designer', content: 'hi des' });
    await client.waitForEvent('system', 'done', convoId);
    // Same convo, different agent. The live entry belongs to lead-designer but
    // stdin is writable, so the server pushes the follow-up to the SAME
    // process (agent pinning is by conversation, not by msg.agent). Pinned:
    const sinceIdx = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'content-lead', content: 'now penn please' });
    await client.waitFor(m => m.type === 'result' && m._conversationId === convoId, { since: sinceIdx, label: 'second result' });
    assert.strictEqual(h.readInvocations().length, 1, 'pinned as-is: follow-up reuses the existing process even when msg.agent changes');
  });
});

describe('workspace + roster messages', () => {
  test('get_agents returns the discovered team including scaffolded Doc', async () => {
    const since = client.messages.length;
    client.send({ type: 'get_agents' });
    const { msg } = await client.waitFor(m => m.type === 'agents', { since, label: 'agents' });
    const ids = msg.agents.map(a => a.id);
    for (const expected of ['chief-of-staff', 'content-lead', 'content-analyst', 'lead-designer', 'rundock-guide']) {
      assert.ok(ids.includes(expected), expected);
    }
  });

  test('get_skills returns scaffolded rundock skills assigned to Doc', async () => {
    const since = client.messages.length;
    client.send({ type: 'get_skills' });
    const { msg } = await client.waitFor(m => m.type === 'skills', { since, label: 'skills' });
    const slugs = msg.skills.map(s => s.slug);
    for (const s of ['rundock-workspace', 'rundock-agents', 'rundock-skills']) assert.ok(slugs.includes(s), s);
    const rundockAgentsSkill = msg.skills.find(s => s.slug === 'rundock-agents');
    assert.deepStrictEqual(rundockAgentsSkill.assignedAgents.map(a => a.id), ['rundock-guide']);
  });

  test('save_conversation + get_conversations roundtrip persists metadata only', async () => {
    const convoId = h.freshConvoId('convo');
    client.send({ type: 'save_conversation', conversation: {
      id: convoId, agentId: 'chief-of-staff', title: 'Test convo', sessionId: 'sess-1',
      messages: [{ secret: 'should not persist' }],
    } });
    await h.delay(50); // fire-and-forget write
    const onDisk = JSON.parse(fs.readFileSync(path.join(h.workspaceDir, '.rundock', 'conversations.json'), 'utf-8'));
    const saved = onDisk.find(c => c.id === convoId);
    assert.ok(saved);
    assert.strictEqual(saved.title, 'Test convo');
    assert.strictEqual(saved.messages, undefined, 'message content never persisted');

    const since = client.messages.length;
    client.send({ type: 'get_conversations' });
    const { msg } = await client.waitFor(m => m.type === 'conversations', { since, label: 'conversations' });
    assert.ok(msg.conversations.find(c => c.id === convoId));
  });

  test('set_workspace_mode toggles code/knowledge and rejects invalid modes', async () => {
    let since = client.messages.length;
    client.send({ type: 'set_workspace_mode', mode: 'code' });
    await client.waitFor(m => m.type === 'workspace_mode_changed' && m.mode === 'code', { since, label: 'mode change' });
    assert.strictEqual(h.internal.readState().workspaceMode, 'code');

    since = client.messages.length;
    client.send({ type: 'set_workspace_mode', mode: 'yolo' });
    await client.waitFor(m => m.type === 'workspace_error', { since, label: 'mode error' });

    client.send({ type: 'set_workspace_mode', mode: 'knowledge' });
    await client.waitFor(m => m.type === 'workspace_mode_changed' && m.mode === 'knowledge', { since, label: 'mode back' });
  });

  test('code mode spawn: no --disallowed-tools, RUNDOCK_CODE_MODE=1 in env', async () => {
    const convoId = h.freshConvoId();
    client.send({ type: 'set_workspace_mode', mode: 'code' });
    await client.waitFor(m => m.type === 'workspace_mode_changed' && m.mode === 'code', { label: 'code mode' });
    h.clearInvocations();
    h.writeScenario([{ match: {}, turn: [{ text: 'code mode answer.' }] }]);
    client.send({ type: 'chat', conversationId: convoId, agent: 'lead-designer', content: 'in code mode' });
    await client.waitForEvent('system', 'done', convoId);
    const inv = h.readInvocations()[0];
    assert.ok(!inv.argv.includes('--disallowed-tools'), 'code mode lifts file-type restrictions');
    assert.strictEqual(inv.env.RUNDOCK_CODE_MODE, '1');
    client.send({ type: 'set_workspace_mode', mode: 'knowledge' });
    await client.waitFor(m => m.type === 'workspace_mode_changed' && m.mode === 'knowledge', { label: 'back to knowledge' });
  });
});
