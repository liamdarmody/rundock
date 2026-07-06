'use strict';
// Integration: a Claude orchestrator delegating to a specialist that runs on
// the Codex runtime. The orchestrator's Agent tool call is intercepted as
// usual; the delegate turn runs as one sandboxed codex exec process; handback
// markers round-trip through the same restoration machinery as Claude
// delegates; the transcript persists both sides.
//
// Codex delegates are transactional by design: exec mode runs one turn per
// process, so a delegated task is briefed, completed, and control returns to
// the orchestrator with the specialist's output injected. Direct
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

    // The delegate spawn was a codex exec process carrying identity + brief.
    const codexInv = h.readInvocations().find(i => i.bin === 'codex');
    assert.ok(codexInv, 'codex delegate spawn recorded');
    assert.deepStrictEqual(codexInv.argv, ['exec', '--json', '--sandbox', 'workspace-write', '--skip-git-repo-check', '-']);
    assert.ok(codexInv.prompt.includes('You are Ida'), 'agent identity in the delegate prompt');
    assert.ok(codexInv.prompt.includes('DELEGATION CONTEXT'), 'delegation contract in the delegate prompt');
    assert.ok(codexInv.prompt.includes('codex-del brief'), 'brief in the delegate prompt');

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
});
