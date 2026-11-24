'use strict';
// A DELEGATE THAT STOPS BEFORE FINISHING IS SAID TO HAVE STOPPED.
//
// When a teammate's process ends, the server decides whether its last turn
// finished: a successful result since that turn began, or a handoff marker.
// Without either, and unless the person stopped it, the delegate failed, and
// the return switch carries `failed: { code, signal, reason }` naming exactly
// one reason. These tests drive each way a delegate can stop through the real
// server against the stub runtime, and read the switch the window received.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const h = require(path.join(ROOT, 'test', 'helpers', 'harness.js'));
const { standardTeam } = require(path.join(ROOT, 'test', 'helpers', 'workspace.js'));

let client;

before(async () => {
  await h.boot({ agents: standardTeam() });
  client = await h.connect();
});
after(async () => h.shutdown());

/**
 * Cos hands `<tag> brief` to Wren through the Agent tool; Wren's turns are the
 * rules given, first match first; and Cos, respawned with whatever the server
 * tells it, stays quiet. A resumed Cos is started without --agent, so with
 * `cosResumed` its rule matches on the resume instead.
 */
function routeToWren(tag, wrenRules, { cosResumed = false, ...extra } = {}) {
  const cos = cosResumed ? { resume: true } : { agent: 'chief-of-staff' };
  h.writeScenario([
    { match: { ...cos, promptIncludes: `${tag} request`, promptExcludes: '[SYSTEM:' },
      turn: [{ agentTool: { subagent_type: 'content-lead', description: 'Over to Wren.', prompt: `${tag} brief` } }] },
    ...wrenRules.map((r) => ({ ...r, match: { agent: 'content-lead', ...r.match } })),
    { match: { promptIncludes: '[SYSTEM:' }, turn: [{ text: '<silent>' }] },
  ], extra);
}

function startConversation(tag, extra = {}) {
  const convoId = h.freshConvoId(tag);
  client.send({ type: 'save_conversation', conversation: { id: convoId, agentId: 'chief-of-staff', title: tag } });
  const since = client.messages.length;
  client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: `${tag} request`, ...extra });
  return { convoId, since };
}

function waitForReturn(convoId, since) {
  return client.waitFor((m) => m.type === 'system' && m.subtype === 'agent_switch'
    && m._conversationId === convoId && m.fromAgent === 'content-lead' && m.toAgent === 'chief-of-staff',
  { since, label: 'control came back to Cos', timeout: 20000 }).then(({ msg }) => msg);
}

function waitForResult(convoId, text, since, label) {
  return client.waitFor((m) => m.type === 'result' && m._conversationId === convoId && String(m.result || '').includes(text),
    { since, label, timeout: 20000 });
}

function assertStopped(sw, reason) {
  assert.strictEqual((sw.failed || {}).reason, reason, `the return names one reason: ${JSON.stringify(sw.failed)}`);
}

describe('the reason a delegate stopped', () => {
  test('a crash with exit code 1 and no result is exit code 1', async () => {
    h.clearInvocations();
    routeToWren('ds-crash1', [{ match: { promptIncludes: 'ds-crash1 brief' }, crash: 1 }]);
    const { convoId, since } = startConversation('ds-crash1');
    const sw = await waitForReturn(convoId, since);
    assertStopped(sw, 'exit code 1');
    assert.strictEqual((sw.failed || {}).code, 1, 'the code is carried as it came');
    assert.strictEqual((sw.failed || {}).signal, null, 'and no signal is invented');
    h.reapConvo(convoId);
  });

  test('exit code 0 with no result is still a stop, named exit code 0', async () => {
    h.clearInvocations();
    routeToWren('ds-crash0', [{ match: { promptIncludes: 'ds-crash0 brief' }, crash: 0 }]);
    const { convoId, since } = startConversation('ds-crash0');
    assertStopped(await waitForReturn(convoId, since), 'exit code 0');
    h.reapConvo(convoId);
  });

  test('a turn that ended on an error result is Claude Code reported an error, never its exit code', async () => {
    h.clearInvocations();
    routeToWren('ds-iserr', [{ match: { promptIncludes: 'ds-iserr brief' }, isError: true, exitAfterTurn: 1,
      turn: [{ text: 'The tool run hit a snag halfway through.' }] }]);
    const { convoId, since } = startConversation('ds-iserr');
    assertStopped(await waitForReturn(convoId, since), 'Claude Code reported an error');
    h.reapConvo(convoId);
  });

  test('a delegate killed mid-turn is stopped by the system, and the switch names the signal', async () => {
    h.clearInvocations();
    const never = path.join(h.workspaceDir, `never-${Date.now()}`);
    routeToWren('ds-kill', [{ match: { promptIncludes: 'ds-kill brief' }, holdAfterText: never,
      turn: [{ text: 'DS-KILL-PARTIAL work so far' }] }]);
    const { convoId, since } = startConversation('ds-kill');
    await client.waitFor((m) => m._conversationId === convoId && m.type === 'stream_event' && m._agent === 'content-lead'
      && m.event && m.event.type === 'content_block_stop', { since, label: 'Wren is part way through', timeout: 20000 });
    const entry = h.internal.chatProcesses.get(convoId);
    assert.strictEqual(entry && entry.agentId, 'content-lead', 'sanity: Wren is the process on screen');
    entry.process.kill('SIGKILL');
    const sw = await waitForReturn(convoId, since);
    assertStopped(sw, 'stopped by the system');
    assert.strictEqual((sw.failed || {}).signal, 'SIGKILL', 'the switch names the signal');
    h.reapConvo(convoId);
  });

  test('a follow-up that crashes after a first turn that succeeded is exit code 1', async () => {
    h.clearInvocations();
    routeToWren('ds-fucrash', [
      { match: { promptIncludes: 'ds-fucrash again' }, crash: 1 },
      { match: { promptIncludes: 'ds-fucrash brief' }, turn: [{ text: 'DS-FUCRASH-FIRST done' }] },
    ]);
    const { convoId, since } = startConversation('ds-fucrash');
    await waitForResult(convoId, 'DS-FUCRASH-FIRST', since, 'Wren finished the first turn');
    const next = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'content-lead', content: 'ds-fucrash again' });
    assertStopped(await waitForReturn(convoId, next), 'exit code 1');
    h.reapConvo(convoId);
  });

  test('a follow-up that ends on an error result is Claude Code reported an error', async () => {
    h.clearInvocations();
    routeToWren('ds-fuerr', [
      { match: { promptIncludes: 'ds-fuerr again' }, isError: true, exitAfterTurn: 1,
        turn: [{ text: 'The second pass hit a snag.' }] },
      { match: { promptIncludes: 'ds-fuerr brief' }, turn: [{ text: 'DS-FUERR-FIRST done' }] },
    ]);
    const { convoId, since } = startConversation('ds-fuerr');
    await waitForResult(convoId, 'DS-FUERR-FIRST', since, 'Wren finished the first turn');
    const next = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'content-lead', content: 'ds-fuerr again' });
    assertStopped(await waitForReturn(convoId, next), 'Claude Code reported an error');
    h.reapConvo(convoId);
  });

  test('a fresh start after an expired session that then crashes is exit code 1', async () => {
    h.clearInvocations();
    const convoId = h.freshConvoId('ds-fresh');
    const others = h.internal.readConversations().filter((c) => c.id !== convoId);
    h.internal.writeConversations([{ id: convoId, title: 'ds-fresh', status: 'active', agentId: 'chief-of-staff',
      sessionId: 'ds-live-cos', sessionIds: [{ agentId: 'chief-of-staff', sessionId: 'ds-live-cos' },
        { agentId: 'content-lead', sessionId: 'ds-dead-wren' }] }, ...others]);
    // The refused resume is held open, so what the refused attempt left on the
    // entry can be seen to be cleared when the fresh start begins.
    routeToWren('ds-fresh', [{ match: { promptIncludes: 'ds-fresh brief' }, crash: 1 }],
      { cosResumed: true, deadSessions: ['ds-dead-wren'], refusalExitMs: 1500 });
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'ds-fresh request', sessionId: 'ds-live-cos' });
    await h.waitUntil(() => (h.internal.chatProcesses.get(convoId) || {}).agentId === 'content-lead');
    const refused = h.internal.chatProcesses.get(convoId);
    assert.strictEqual(refused && refused.agentId, 'content-lead', 'sanity: Wren\'s refused resume is the process on screen');
    refused.lastTurnOutcome = 'success';
    const sw = await waitForReturn(convoId, since);
    const wren = h.readInvocations().filter((i) => i.agent === 'content-lead' && i.env && i.env.RUNDOCK_CONVO_ID === convoId);
    assert.deepStrictEqual(wren.map((i) => i.resume), ['ds-dead-wren', null], 'sanity: the dead id was refused and Wren started fresh');
    assertStopped(sw, 'exit code 1');
    h.reapConvo(convoId);
  });
});
