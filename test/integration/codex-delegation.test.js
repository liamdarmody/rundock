'use strict';
// Integration: a Claude orchestrator delegating to a specialist that runs on
// the Codex runtime. The orchestrator's Agent tool call is intercepted as
// usual; the delegate turn runs as one sandboxed streamed turn on the shared
// codex app-server; handback markers round-trip through the same restoration
// machinery as Claude delegates; the transcript persists both sides.
//
// Codex delegates are transactional by design: a delegated task is briefed,
// completed in one turn, and control returns to the orchestrator with the
// specialist's output injected when the turn's done event fires (the
// runtime's equivalent of the delegate process closing). Direct
// conversations with Codex agents remain fully conversational (thread
// resume); only the delegated flow is single-shot.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

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
      body: 'You are Ida, the researcher.\n\nYou research suppliers.',
    }),
    // A codex sub-agent under a lead, for the specialist-parent handback case.
    'summary-bot': agentFile({
      name: 'summary-bot', displayName: 'Sumo', role: 'Summariser',
      description: 'Summarises for the content lead', type: 'specialist', order: 2.1,
      reportsTo: 'content-lead', runtime: 'codex',
      body: 'You are Sumo, the summariser.',
    }),
  };
}

before(async () => {
  await h.boot({ agents: team() });
  client = await h.connect();
});
after(async () => h.shutdown());

function transcript(convoId) {
  return JSON.parse(fs.readFileSync(path.join(h.workspaceDir, '.rundock', 'transcripts', `${convoId}.json`), 'utf-8'));
}

describe('delegation to a codex specialist', () => {
  test('COMPLETE handback: brief delivered, output injected into the silently parked parent, transcript persists', async () => {
    const convoId = h.freshConvoId('cdel');
    h.clearInvocations();
    h.writeScenario([
      {
        match: { agent: 'chief-of-staff', promptIncludes: 'codex-del please' },
        turn: [{ agentTool: { subagent_type: 'researcher', prompt: 'codex-del brief' } }],
      },
      {
        // The parked parent receives the pipeline-complete prompt WITH the
        // specialist's output and WITHOUT the marker.
        match: { agent: 'chief-of-staff', promptIncludes: ['[SYSTEM: pipeline-complete]', 'CODEX-PAYLOAD-42'], promptExcludes: 'RUNDOCK:COMPLETE' },
        turn: [{ text: '<silent>' }],
      },
    ]);
    h.writeCodexScenario([
      { match: { promptIncludes: 'codex-del brief' }, text: 'CODEX-PAYLOAD-42 delivered. <!-- RUNDOCK:COMPLETE -->' },
    ]);

    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'codex-del please' });

    // Switch to the codex delegate, its result arrives, then switch back.
    await client.waitFor(m => m.type === 'system' && m.subtype === 'agent_switch' && m._conversationId === convoId && m.toAgent === 'researcher', { label: 'to codex delegate' });
    const { msg: result } = await client.waitFor(m => m.type === 'result' && m._conversationId === convoId && m._agent === 'researcher', { label: 'codex delegate result' });
    assert.ok(result.result.includes('CODEX-PAYLOAD-42'), 'specialist output delivered to the client');

    await client.waitFor(m => m.type === 'system' && m.subtype === 'agent_switch' && m._conversationId === convoId && m.toAgent === 'chief-of-staff', { label: 'back to parent' });
    const { msg: started, index: startedIdx } = await client.waitFor(m => m.type === 'system' && m.subtype === 'process_started' && m._conversationId === convoId && m._agent === 'chief-of-staff' && m.autoContinue, { label: 'parent restart' });
    assert.strictEqual(started.silent, true, 'pipeline-complete restart is silent');

    // Wait for the resumed parent's (silent) result so its invocation is
    // logged before spawn-argument assertions run.
    await client.waitFor(m => m.type === 'result' && m._conversationId === convoId && m._agent === 'chief-of-staff', { since: startedIdx + 1, label: 'resumed parent result' });

    // The delegate turn ran on the shared app-server, sandboxed, carrying
    // identity + delegation contract + brief in its prompt.
    const start = h.readInvocations().find(i => i.mode === 'app-server' && i.method === 'thread/start');
    assert.ok(start, 'codex delegate thread recorded');
    assert.strictEqual(start.params.sandbox, 'workspace-write');
    assert.strictEqual(start.params.approvalPolicy, 'on-request');
    const prompt = h.codexTurnPrompts().pop();
    assert.ok(prompt, 'codex delegate turn recorded');
    assert.ok(prompt.includes('You are Ida'), 'agent identity in the delegate prompt');
    assert.ok(prompt.includes('DELEGATION CONTEXT'), 'delegation contract in the delegate prompt');
    assert.ok(prompt.includes('codex-del brief'), 'brief in the delegate prompt');

    // Parent resumed its own session.
    const cosResume = h.readInvocations().filter(i => i.agent === 'chief-of-staff' && i.resume);
    assert.strictEqual(cosResume.length, 1, 'parent restarted with --resume');

    // Transcript has the user turn, the orchestrator routing turn, and the specialist output.
    const t = transcript(convoId);
    assert.ok(t.some(e => e.agent === 'researcher' && e.text.includes('CODEX-PAYLOAD-42')), 'specialist output persisted');
    assert.ok(!t.some(e => e.text.includes('<silent>')), 'silent park filtered from transcript');

    // Parent is parked idle as the active entry.
    const entry = h.internal.chatProcesses.get(convoId);
    assert.strictEqual(entry.agentId, 'chief-of-staff');
    assert.strictEqual(entry.idle, true);
    h.reapConvo(convoId);
  });

  test('stale end_delegation after a codex handback never kills the restored orchestrator', async () => {
    // A codex delegate exits immediately after its result, so the server can
    // restore the parent BEFORE the browser's marker scan sends
    // end_delegation. That late message must be ignored, not treated as an
    // out-of-scope return from the orchestrator itself.
    const convoId = h.freshConvoId('cdel');
    h.clearInvocations();
    h.writeScenario([
      {
        match: { agent: 'chief-of-staff', promptIncludes: 'stale-race please' },
        turn: [{ agentTool: { subagent_type: 'researcher', prompt: 'stale-race brief' } }],
      },
      {
        match: { agent: 'chief-of-staff', promptIncludes: ['[SYSTEM: pipeline-complete]', 'STALE-RACE-OUT'] },
        turn: [{ text: '<silent>' }],
      },
    ]);
    h.writeCodexScenario([
      { match: { promptIncludes: 'stale-race brief' }, text: 'STALE-RACE-OUT done. <!-- RUNDOCK:COMPLETE -->' },
    ]);

    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'stale-race please' });
    const { index: startedIdx } = await client.waitFor(m => m.type === 'system' && m.subtype === 'process_started' && m._conversationId === convoId && m._agent === 'chief-of-staff' && m.autoContinue, { label: 'parent restart' });
    await client.waitFor(m => m.type === 'result' && m._conversationId === convoId && m._agent === 'chief-of-staff', { since: startedIdx + 1, label: 'resumed parent result' });

    // The browser would now send end_delegation from its RETURN/COMPLETE scan.
    const entryBefore = h.internal.chatProcesses.get(convoId);
    assert.strictEqual(entryBefore.agentId, 'chief-of-staff');
    client.send({ type: 'end_delegation', conversationId: convoId });
    await h.delay(400);

    const entryAfter = h.internal.chatProcesses.get(convoId);
    assert.ok(entryAfter, 'orchestrator entry survives the stale message');
    assert.strictEqual(entryAfter.agentId, 'chief-of-staff');
    assert.strictEqual(entryAfter.exited, false, 'orchestrator process not killed');
    assert.strictEqual(entryAfter.scopeReturn || false, false, 'no scope return forced on the orchestrator');
    h.reapConvo(convoId);
  });

  test('stale end_delegation also spares a restored SPECIALIST parent (lead), not just orchestrators', async () => {
    // Same race as above, but the delegating parent is a lead (type
    // specialist). The guard must key on the recent handback, not on the
    // parent's type.
    const convoId = h.freshConvoId('cdel');
    h.clearInvocations();
    h.writeScenario([
      {
        match: { agent: 'content-lead', promptIncludes: 'lead-race please' },
        turn: [{ agentTool: { subagent_type: 'summary-bot', prompt: 'lead-race brief' } }],
      },
      {
        match: { agent: 'content-lead', promptIncludes: ['[SYSTEM: pipeline-complete]', 'LEAD-RACE-OUT'] },
        turn: [{ text: '<silent>' }],
      },
    ]);
    h.writeCodexScenario([
      { match: { promptIncludes: 'lead-race brief' }, text: 'LEAD-RACE-OUT done. <!-- RUNDOCK:COMPLETE -->' },
    ]);

    client.send({ type: 'chat', conversationId: convoId, agent: 'content-lead', content: 'lead-race please' });
    const { index: startedIdx } = await client.waitFor(m => m.type === 'system' && m.subtype === 'process_started' && m._conversationId === convoId && m._agent === 'content-lead' && m.autoContinue, { label: 'lead restart' });
    await client.waitFor(m => m.type === 'result' && m._conversationId === convoId && m._agent === 'content-lead', { since: startedIdx + 1, label: 'resumed lead result' });

    client.send({ type: 'end_delegation', conversationId: convoId });
    await h.delay(400);

    const entryAfter = h.internal.chatProcesses.get(convoId);
    assert.ok(entryAfter, 'lead entry survives the stale message');
    assert.strictEqual(entryAfter.agentId, 'content-lead');
    assert.strictEqual(entryAfter.exited, false, 'lead process not killed');
    assert.strictEqual(entryAfter.scopeReturn || false, false, 'no scope return forced on the lead');
    h.reapConvo(convoId);
  });

  test('RETURN handback: out-of-scope delegate routes the pending request back through the parent', async () => {
    const convoId = h.freshConvoId('cdel');
    h.clearInvocations();
    h.writeScenario([
      {
        match: { agent: 'chief-of-staff', promptIncludes: 'wrong-domain please' },
        turn: [{ agentTool: { subagent_type: 'researcher', prompt: 'wrong-domain brief' } }],
      },
      {
        // RETURN path: parent is resumed with a routing request carrying the
        // specialist's explanation.
        match: { agent: 'chief-of-staff', promptIncludes: ['outside their scope', 'OUT-OF-SCOPE-NOTE'] },
        turn: [{ text: 'Routing to the right person.' }],
      },
    ]);
    h.writeCodexScenario([
      { match: { promptIncludes: 'wrong-domain brief' }, text: 'OUT-OF-SCOPE-NOTE: this falls outside what I handle. <!-- RUNDOCK:RETURN -->' },
    ]);

    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'wrong-domain please' });

    await client.waitFor(m => m.type === 'result' && m._conversationId === convoId && m._agent === 'researcher', { label: 'codex delegate result' });
    await client.waitFor(m => m.type === 'system' && m.subtype === 'agent_switch' && m._conversationId === convoId && m.toAgent === 'chief-of-staff', { label: 'back to parent' });

    // The resumed parent answers the routing prompt visibly (not silent).
    const { msg: routed } = await client.waitFor(m => m.type === 'result' && m._conversationId === convoId && m._agent === 'chief-of-staff' && m.result === 'Routing to the right person.', { label: 'routing result' });
    assert.ok(routed);
    h.reapConvo(convoId);
  });

  test('off-roster codex target is soft-blocked: no Claude impersonation, corrective prompt names the runtime', async () => {
    // The observed live failure: a specialist names a codex agent outside its
    // direct reports. Pre-fix, Claude Code spawned a Claude subagent wearing
    // the codex agent's name, silently bypassing the user's runtime choice.
    // Ida (researcher, runtime: codex) reports to chief-of-staff, not Penn.
    const convoId = h.freshConvoId('cdel');
    h.clearInvocations();
    h.writeScenario([
      {
        match: { agent: 'content-lead', promptIncludes: 'codex-offroster please' },
        turn: [{ agentTool: { subagent_type: 'researcher', prompt: 'codex-offroster brief' } }],
      },
      {
        // The corrective prompt must state the reason AND flag the runtime.
        match: { agent: 'content-lead', promptIncludes: ['[SYSTEM: delegation-blocked]', 'not one of your direct reports', 'different runtime (Codex)'] },
        turn: [{ text: 'Acknowledged: Ida runs on Codex under another leader.' }],
      },
    ]);

    client.send({ type: 'chat', conversationId: convoId, agent: 'content-lead', content: 'codex-offroster please' });

    await client.waitFor(m => m.type === 'system' && m.subtype === 'info' && m._conversationId === convoId && /Blocked a handoff to Ida/.test(m.content || ''), { label: 'block pill' });
    await client.waitFor(m => m.type === 'result' && m._conversationId === convoId && m._agent === 'content-lead' && /runs on Codex under another leader/.test(m.result || ''), { label: 'resumed caller result' });

    // Neither a codex turn nor a Claude stand-in for Ida ever ran.
    const invs = h.readInvocations();
    assert.strictEqual(invs.find(i => i.mode === 'app-server' && i.method === 'turn/start'), undefined, 'no codex turn started');
    assert.strictEqual(invs.find(i => i.agent === 'researcher'), undefined, 'no Claude process wearing the codex agent name');

    h.reapConvo(convoId);
  });
});
