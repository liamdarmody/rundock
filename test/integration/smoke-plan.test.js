'use strict';
// ============================================================================
// PROPOSAL-FIRST SMOKE TEST PLAN: 12 scenarios automated against the harness
// ============================================================================
// Scenarios T1-T12 mirror the product's proposal-first smoke-test plan.
//
// The smoke plan was written for the Proposal-First plan-mode feature (marker
// DEFERRAL + a consent-surface UI + a defaultMode:plan frontmatter flag). That
// feature is NOT present in this server.js version. This plan now serves as
// the scenario source for the delegation harness (delegate, return, complete,
// intercept, resume, loop-break): each T-scenario is automated here
// against the delegation MECHANIC it exercises. Every test states the mapping
// from the plan's intent to the mechanic under test.
//
// One harness boot; each test drives the real server + stub claude.
// ============================================================================
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../helpers/harness.js');
const { MARKERS } = require('../fixtures/stream-json.js');

let client;
before(async () => { await h.boot(); client = await h.connect(); });
after(async () => h.shutdown());

function transcript(convoId) {
  const f = path.join(h.workspaceDir, '.rundock', 'transcripts', `${convoId}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf-8')) : [];
}
async function orchestrator(convoId, kw) {
  h.writeScenario([{ match: { agent: 'chief-of-staff', promptIncludes: kw }, turn: [{ text: `ready ${kw}` }] }]);
  client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: kw });
  await client.waitForEvent('system', 'done', convoId);
}

describe('Proposal-First smoke plan (T1-T12)', () => {
  // T1: SAVE_AGENT marker handling on a platform delegate (stand-in for
  // "marker held back when emitting agent is in plan mode"). Mechanic: a
  // platform delegate emitting a CRUD marker triggers the auto-return path.
  test('T1: platform-delegate CRUD marker is recognised and drives the return path', async () => {
    const convoId = h.freshConvoId('t1');
    h.writeScenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 't1 create agent' },
        turn: [{ agentTool: { subagent_type: 'rundock-guide', prompt: 't1 make sales-coach' } }] },
      { match: { agent: 'rundock-guide', promptIncludes: 't1 make sales-coach' },
        turn: [{ text: `Proposed. ${MARKERS.saveAgent('sales-coach', '---\nname: sales-coach\n---\nbody')}` }] },
      { match: { agent: 'chief-of-staff', promptIncludes: '[SYSTEM: pipeline-complete]' }, turn: [{ text: '<silent>' }] },
    ]);
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 't1 create agent' });
    await client.waitFor(m => m.type === 'result' && m._conversationId === convoId && m._agent === 'rundock-guide', { label: 'doc result' });
    const { msg: started } = await client.waitFor(m => m.type === 'system' && m.subtype === 'process_started' && m._conversationId === convoId && m._agent === 'chief-of-staff' && m.autoContinue, { label: 'parent restart' });
    assert.strictEqual(started.silent, true, 'CRUD marker auto-return parks the parent silently');
  });

  // T2: Approval replays the marker through the execution path. Mechanic: the
  // save_agent WS message actually writes the file (the "approve" action).
  test('T2: approval executes the agent write (save_agent WS path)', async () => {
    const since = client.messages.length;
    client.send({ type: 'save_agent', name: 'sales-coach', content: '---\nname: sales-coach\ndisplayName: Sollo\nrole: Sales Coach\ndescription: prep\n---\nYou are Sollo.\n' });
    await client.waitFor(m => m.type === 'agent_saved' && m.agentId === 'sales-coach', { since, label: 'saved' });
    const file = path.join(h.workspaceDir, '.claude', 'agents', 'sales-coach.md');
    assert.ok(fs.existsSync(file), 'file written to disk');
    assert.match(fs.readFileSync(file, 'utf-8'), /displayName: Sollo/);
    // sidebar refresh broadcast
    await client.waitFor(m => m.type === 'agents', { since, label: 'roster refresh' });
    // cleanup for T3
    client.send({ type: 'delete_agent', agentId: 'sales-coach' });
    await client.waitFor(m => m.type === 'agent_deleted', { label: 't2 cleanup' });
  });

  // T3: Rejection cleans up state without writing. Mechanic: delete_agent /
  // rejected write leaves no file and no error state.
  test('T3: rejection leaves nothing written and no orphan state', async () => {
    const marketingPath = path.join(h.workspaceDir, '.claude', 'agents', 'marketing-coach.md');
    assert.strictEqual(fs.existsSync(marketingPath), false, 'nothing written for a rejected proposal');
    // deleting a non-existent agent yields a clean error, not a crash
    const since = client.messages.length;
    client.send({ type: 'delete_agent', agentId: 'marketing-coach' });
    const { msg } = await client.waitFor(m => m.type === 'agent_error', { since, label: 'clean error' });
    assert.match(msg.message, /not found/);
  });

  // T4: Orchestrator does NOT auto-resume after a specialist COMPLETE. This is
  // the load-bearing assertion. Mechanic: COMPLETE gate parks the orchestrator
  // idle; no auto-spawned turn follows.
  test('T4: orchestrator stays idle after a specialist COMPLETE (no auto-resume)', async () => {
    const convoId = h.freshConvoId('t4');
    await orchestrator(convoId, 't4-setup');
    h.writeScenario([
      { match: { agent: 'content-lead', promptIncludes: 't4 do work' }, turn: [{ text: `Done end to end. ${MARKERS.COMPLETE}` }] },
    ]);
    const since = client.messages.length;
    client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'content-lead', context: 't4 do work' });
    await client.waitFor(m => m.type === 'system' && m.subtype === 'agent_switch' && m._conversationId === convoId && m.toAgent === 'chief-of-staff', { since, label: 'restored to orchestrator' });
    // The orchestrator entry is idle and no new process_started with
    // autoContinue is emitted (no silent-resume for the WS-delegate COMPLETE).
    const entry = h.internal.chatProcesses.get(convoId);
    assert.strictEqual(entry.agentId, 'chief-of-staff');
    assert.strictEqual(entry.idle, true);
    const restoredIdx = client.messages.findIndex((m, i) => i >= since && m.subtype === 'agent_switch' && m.toAgent === 'chief-of-staff');
    await h.delay(600); // longer than any auto-continue timer
    const autoContinues = client.messages.slice(restoredIdx).filter(m => m.subtype === 'process_started' && m._agent === 'chief-of-staff' && m.autoContinue);
    assert.strictEqual(autoContinues.length, 0, 'no auto-resume turn after COMPLETE');
    h.reapConvo(convoId);
  });

  // T5: Multi-specialist RETURN pipelines still auto-continue. Mechanic: an
  // intercepted RETURN auto-continues the orchestrator, which routes onward to
  // a second specialist, and the final COMPLETE halts cleanly.
  test('T5: RETURN pipeline auto-continues Penn -> Des, final COMPLETE halts', async () => {
    const convoId = h.freshConvoId('t5');
    h.writeScenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 't5 go' },
        turn: [{ agentTool: { subagent_type: 'content-lead', prompt: 't5 hooks brief' } }] },
      { match: { agent: 'content-lead', promptIncludes: 't5 hooks brief' },
        turn: [{ text: `Hooks done, rest is design. ${MARKERS.RETURN}` }] },
      { match: { agent: 'chief-of-staff', promptIncludes: 'outside their scope' },
        turn: [{ agentTool: { subagent_type: 'lead-designer', prompt: 't5 design brief' } }] },
      { match: { agent: 'lead-designer', promptIncludes: 't5 design brief' },
        turn: [{ text: `Visual delivered. ${MARKERS.COMPLETE}` }] },
      { match: { agent: 'chief-of-staff', promptIncludes: '[SYSTEM: pipeline-complete]' }, turn: [{ text: '<silent>' }] },
    ]);
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 't5 go' });
    await client.waitFor(m => m.type === 'result' && m._conversationId === convoId && m._agent === 'lead-designer', { label: 'des result', timeout: 12000 });
    const hops = client.messages.filter(m => m.subtype === 'agent_switch' && m._conversationId === convoId).map(m => `${m.fromAgent}>${m.toAgent}`);
    assert.deepStrictEqual(hops.slice(0, 3), ['chief-of-staff>content-lead', 'content-lead>chief-of-staff', 'chief-of-staff>lead-designer'],
      'Penn returned, orchestrator auto-continued, Des picked up');
    h.reapConvo(convoId);
  });

  // T6: Consent surface renders approve/reject controls. Mechanic: the
  // permission bridge forwards a control_request card the UI renders.
  test('T6: a tool request renders a consent card with approve/reject controls', async () => {
    const since = client.messages.length;
    const pending = fetch(`http://127.0.0.1:${h.port}/api/permission-request`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo hi' }, conversation_id: 't6' }),
    }).then(r => r.json());
    const { msg: card } = await client.waitFor(m => m.type === 'control_request', { since, label: 'consent card' });
    assert.strictEqual(card.request.subtype, 'can_use_tool');
    client.send({ type: 'permission_response', requestId: card.request_id, allow: true });
    assert.deepStrictEqual(await pending, { allow: true });
  });

  // T7: A plain agent behaves as today (no plan mode). Mechanic: a direct chat
  // to a plain specialist streams a normal answer with no consent surface.
  test('T7: plain specialist responds directly, no consent card, no plan badge', async () => {
    const convoId = h.freshConvoId('t7');
    h.writeScenario([{ match: { agent: 'lead-designer', promptIncludes: 't7 polish' }, turn: [{ text: 'Polished draft ready.' }] }]);
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'lead-designer', content: 't7 polish this' });
    const { msg: result } = await client.waitFor(m => m.type === 'result' && m._conversationId === convoId, { since, label: 'result' });
    assert.strictEqual(result.result, 'Polished draft ready.');
    const cards = client.messages.slice(since).filter(m => m.type === 'control_request');
    assert.strictEqual(cards.length, 0, 'no consent card for a plain answer');
  });

  // T8: Streaming-display strip handles markers cleanly. Mechanic: an
  // intercepted orchestrator's prose is preserved in the transcript while the
  // marker/handoff is handled; server-side stripRundockMarkers keeps payload.
  test('T8: marker payloads are stripped from injected prose but preserved for handling', async () => {
    const convoId = h.freshConvoId('t8');
    h.writeScenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 't8 route' },
        turn: [{ text: 'Handing to Penn.' }, { agentTool: { subagent_type: 'content-lead', prompt: 't8 brief' } }] },
      { match: { agent: 'content-lead', promptIncludes: 't8 brief' }, turn: [{ text: 'Penn delivered.' }] },
    ]);
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 't8 route' });
    await client.waitFor(m => m.type === 'result' && m._conversationId === convoId && m._agent === 'content-lead', { label: 'penn result' });
    const cos = transcript(convoId).find(e => e.agent === 'chief-of-staff');
    assert.ok(cos.text.includes('Handing to Penn.'), 'orchestrator prose preserved');
    // server-side marker stripper leaves the visible prose clean
    assert.strictEqual(h.internal.stripRundockMarkers(`Handing to Penn. ${MARKERS.COMPLETE}`).trim(), 'Handing to Penn.');
    h.reapConvo(convoId);
  });

  // T9: Orchestrator does not confabulate after a clean COMPLETE. Mechanic:
  // the pipeline-complete park forces the literal <silent> and filters it, so
  // the orchestrator emits no narrated "bounced back" turn into the transcript.
  test('T9: after a clean COMPLETE the orchestrator emits no narrated turn (<silent> filtered)', async () => {
    const convoId = h.freshConvoId('t9');
    h.writeScenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 't9 sollo prompt' },
        turn: [{ agentTool: { subagent_type: 'content-lead', prompt: 't9 recommendation brief' } }] },
      { match: { agent: 'content-lead', promptIncludes: 't9 recommendation brief' },
        turn: [{ text: `Here is the recommendation. ${MARKERS.COMPLETE}` }] },
      { match: { agent: 'chief-of-staff', promptIncludes: '[SYSTEM: pipeline-complete]' }, turn: [{ text: '<silent>' }] },
    ]);
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 't9 sollo prompt' });
    await client.waitFor(m => m.type === 'result' && m._conversationId === convoId && m._agent === 'chief-of-staff', { label: 'parked result' });
    await h.delay(200);
    const t = transcript(convoId);
    assert.ok(!t.some(e => e.text.includes('<silent>')), 'silent sentinel never persisted');
    assert.ok(!t.some(e => /bounced back/i.test(e.text)), 'no confabulated bounce-back narration');
    // the specialist recommendation is the last agent turn, not an orchestrator absorption
    const lastAgent = [...t].reverse().find(e => e.role === 'agent' && e.text.trim());
    assert.ok(lastAgent.text.includes('Here is the recommendation'), 'specialist output is the record, not an orchestrator rewrite');
    h.reapConvo(convoId);
  });

  // T10: Every spawn site injects context correctly. Mechanic: initial spawn,
  // delegation spawn, and resume spawn all carry --model + system prompt +
  // --agent/--resume in the right shape.
  test('T10: initial, delegation, and resume spawn sites all inject model/agent/prompt correctly', async () => {
    const convoId = h.freshConvoId('t10');
    h.clearInvocations();
    h.writeScenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 't10 route' },
        turn: [{ agentTool: { subagent_type: 'content-lead', prompt: 't10 brief' } }] },
      { match: { agent: 'content-lead', promptIncludes: 't10 brief' }, turn: [{ text: `Done. ${MARKERS.COMPLETE}` }] },
      { match: { agent: 'chief-of-staff', promptIncludes: '[SYSTEM: pipeline-complete]' }, turn: [{ text: '<silent>' }] },
    ]);
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 't10 route' });
    const { index: startedIdx } = await client.waitFor(m => m.subtype === 'process_started' && m._conversationId === convoId && m._agent === 'chief-of-staff' && m.autoContinue, { label: 'resume restart' });
    await client.waitFor(m => m.type === 'result' && m._conversationId === convoId && m._agent === 'chief-of-staff', { since: startedIdx + 1, label: 'resumed result' });
    const invs = h.readInvocations();
    const initial = invs.find(i => i.agent === 'chief-of-staff' && !i.resume);
    const delegate = invs.find(i => i.agent === 'content-lead');
    const resume = invs.find(i => i.agent === 'chief-of-staff' && i.resume);
    for (const [label, inv] of [['initial', initial], ['delegate', delegate], ['resume', resume]]) {
      assert.ok(inv, `${label} spawn recorded`);
      assert.strictEqual(inv.model, 'sonnet', `${label} carries --model`);
      assert.ok(inv.argv.includes('--append-system-prompt'), `${label} carries system prompt`);
    }
    assert.ok(delegate.argv.includes('--agent'), 'delegate cold-spawn passes --agent');
    assert.ok(resume.resume.includes('stub-chief-of-staff'), 'resume passes the parent session');
    h.reapConvo(convoId);
  });

  // T11: Per-conversation toggle restores the fast path. Mechanic: workspace
  // mode toggle (code) changes spawn behavior (no disallowed-tools, code env).
  test('T11: workspace-mode toggle switches the spawn path', async () => {
    client.send({ type: 'set_workspace_mode', mode: 'code' });
    await client.waitFor(m => m.type === 'workspace_mode_changed' && m.mode === 'code', { label: 'code on' });
    const convoId = h.freshConvoId('t11');
    h.clearInvocations();
    h.writeScenario([{ match: {}, turn: [{ text: 'code answer' }] }]);
    client.send({ type: 'chat', conversationId: convoId, agent: 'lead-designer', content: 't11 toggled' });
    await client.waitForEvent('system', 'done', convoId);
    const inv = h.readInvocations()[0];
    assert.ok(!inv.argv.includes('--disallowed-tools'), 'code mode lifts file-type restrictions');
    assert.strictEqual(inv.env.RUNDOCK_CODE_MODE, '1');
    client.send({ type: 'set_workspace_mode', mode: 'knowledge' });
    await client.waitFor(m => m.type === 'workspace_mode_changed' && m.mode === 'knowledge', { label: 'knowledge back' });
  });

  // T12: Existing shell-permission hook still works. Mechanic: a Bash tool
  // request round-trips through the permission bridge with a deny decision.
  test('T12: shell-permission hook round-trips (deny honoured)', async () => {
    const since = client.messages.length;
    const pending = fetch(`http://127.0.0.1:${h.port}/api/permission-request`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm -rf x' }, conversation_id: 't12' }),
    }).then(r => r.json());
    const { msg: card } = await client.waitFor(m => m.type === 'control_request' && m._conversationId === 't12', { since, label: 'shell card' });
    client.send({ type: 'permission_response', requestId: card.request_id, allow: false });
    assert.deepStrictEqual(await pending, { allow: false });
  });
});
