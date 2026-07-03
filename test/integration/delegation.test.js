'use strict';
// Integration: the delegation/orchestration engine, end to end against the
// stub claude binary. Covers marker parsing, Agent-tool interception,
// parked-process restore, scope returns, the COMPLETE gate, and the
// MAX_CONSECUTIVE_AGENT_RESUMES circuit breaker.
//
// Every assertion is event-driven (WS lifecycle messages / stub invocation
// log / transcript files); the only fixed waits live inside server.js itself
// (500ms auto-return kill, 300ms auto-continue).
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../helpers/harness.js');
const { MARKERS } = require('../fixtures/stream-json.js');

let client;

before(async () => {
  await h.boot();
  client = await h.connect();
});
after(async () => h.shutdown());

function transcript(convoId) {
  const file = path.join(h.workspaceDir, '.rundock', 'transcripts', `${convoId}.json`);
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

// Boot an idle orchestrator process for a conversation (prerequisite for
// WS-message delegation, which requires an active process to delegate from).
async function startOrchestrator(convoId, keyword) {
  h.writeScenario([
    { match: { agent: 'chief-of-staff', promptIncludes: keyword }, turn: [{ text: `Orchestrator ready (${keyword}).` }] },
  ]);
  client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: keyword });
  await client.waitForEvent('system', 'done', convoId);
}

describe('WS-message delegation (delegate/park/restore)', () => {
  test('delegate spawns the target with conversation transcript; COMPLETE auto-returns and restores the parked parent', async () => {
    const convoId = h.freshConvoId('del');
    await startOrchestrator(convoId, 'basic-delegation-setup');
    h.clearInvocations();
    h.writeScenario([
      {
        match: { agent: 'content-lead', promptIncludes: 'write hooks basic-del' },
        turn: [{ text: `Three hooks delivered. ${MARKERS.COMPLETE}` }],
      },
    ]);

    const since = client.messages.length;
    client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'content-lead', context: 'write hooks basic-del' });

    // agent switch orchestrator -> delegate
    const { msg: sw } = await client.waitFor(m => m.type === 'system' && m.subtype === 'agent_switch' && m._conversationId === convoId, { since, label: 'switch to delegate' });
    assert.strictEqual(sw.fromAgent, 'chief-of-staff');
    assert.strictEqual(sw.toAgent, 'content-lead');
    await client.waitFor(m => m.type === 'result' && m._conversationId === convoId && m._agent === 'content-lead', { since, label: 'delegate result' });

    // COMPLETE -> server kills the delegate after 500ms -> parent restored
    const { msg: swBack } = await client.waitFor(m => m.type === 'system' && m.subtype === 'agent_switch' && m._conversationId === convoId && m.toAgent === 'chief-of-staff', { since, label: 'switch back to parent' });
    assert.strictEqual(swBack.fromAgent, 'content-lead');

    // Parked parent is the active entry again, idle, delegation cleared
    const entry = h.internal.chatProcesses.get(convoId);
    assert.strictEqual(entry.agentId, 'chief-of-staff');
    assert.strictEqual(entry.idle, true);
    assert.strictEqual(entry.delegation, null);

    // Cold non-intercepted delegate got the transcript safety net
    const inv = h.readInvocations().find(i => i.agent === 'content-lead');
    assert.ok(inv, 'delegate spawned');
    // and the delegate's turn is in the conversation transcript
    const t = transcript(convoId);
    assert.ok(t.find(e => e.agent === 'content-lead' && e.text.includes('Three hooks delivered.')));
  });

  test('delegate with no active process emits delegation_error', async () => {
    const convoId = h.freshConvoId('del');
    const since = client.messages.length;
    client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'content-lead', context: 'x' });
    const { msg } = await client.waitFor(m => m.type === 'system' && m.subtype === 'delegation_error' && m._conversationId === convoId, { since, label: 'delegation_error' });
    assert.match(msg.content, /No active process/);
  });

  test('delegate to an unknown agent emits delegation_error', async () => {
    const convoId = h.freshConvoId('del');
    await startOrchestrator(convoId, 'unknown-target-setup');
    const since = client.messages.length;
    client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'ghost-agent', context: 'x' });
    const { msg } = await client.waitFor(m => m.type === 'system' && m.subtype === 'delegation_error' && m._conversationId === convoId, { since, label: 'delegation_error' });
    assert.match(msg.content, /not found/);
  });

  test('duplicate delegation to the already-active agent is skipped silently', async () => {
    const convoId = h.freshConvoId('del');
    await startOrchestrator(convoId, 'dup-delegation-setup');
    h.writeScenario([
      { match: { agent: 'content-lead', promptIncludes: 'dup-del task' }, turn: [{ text: 'Working on it, no markers yet.' }] },
    ]);
    client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'content-lead', context: 'dup-del task' });
    await client.waitFor(m => m.type === 'result' && m._conversationId === convoId && m._agent === 'content-lead', { label: 'first delegate result' });

    h.clearInvocations();
    client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'content-lead', context: 'dup-del again' });
    await h.delay(300);
    assert.strictEqual(h.readInvocations().length, 0, 'no second spawn');
    assert.strictEqual(h.internal.chatProcesses.get(convoId).agentId, 'content-lead', 'original delegate still active');

    // cleanup: cancel the live delegate so later tests start clean
    h.reapConvo(convoId);
  });

  test('end_delegation kills the delegate and restores the parked parent', async () => {
    const convoId = h.freshConvoId('del');
    await startOrchestrator(convoId, 'end-delegation-setup');
    h.writeScenario([
      { match: { agent: 'lead-designer', promptIncludes: 'end-del task' }, turn: [{ text: 'Des is on it, staying in the conversation.' }] },
    ]);
    client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'lead-designer', context: 'end-del task' });
    await client.waitFor(m => m.type === 'result' && m._conversationId === convoId && m._agent === 'lead-designer', { label: 'delegate result' });

    const since = client.messages.length;
    client.send({ type: 'end_delegation', conversationId: convoId });
    const { msg: sw } = await client.waitFor(m => m.type === 'system' && m.subtype === 'agent_switch' && m._conversationId === convoId && m.toAgent === 'chief-of-staff', { since, label: 'switch back' });
    assert.strictEqual(sw.fromAgent, 'lead-designer');
    assert.strictEqual(h.internal.chatProcesses.get(convoId).agentId, 'chief-of-staff');
  });
});

describe('Agent-tool interception', () => {
  test('orchestrator Agent tool call is intercepted: orchestrator killed, delegate spawned with the brief, transcript records the routing turn', async () => {
    const convoId = h.freshConvoId('int');
    h.clearInvocations();
    h.writeScenario([
      {
        match: { agent: 'chief-of-staff', promptIncludes: 'intercept-basic please' },
        turn: [
          { text: 'Handing to Penn.' },
          { agentTool: { subagent_type: 'content-lead', prompt: 'intercept-basic hooks brief' } },
        ],
      },
      {
        match: { agent: 'content-lead', promptIncludes: 'intercept-basic hooks brief' },
        turn: [{ text: 'Penn took over and delivered.' }],
      },
    ]);

    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'intercept-basic please' });

    const { msg: sw } = await client.waitFor(m => m.type === 'system' && m.subtype === 'agent_switch' && m._conversationId === convoId, { label: 'intercept switch' });
    assert.strictEqual(sw.fromAgent, 'chief-of-staff');
    assert.strictEqual(sw.toAgent, 'content-lead');

    const { msg: result } = await client.waitFor(m => m.type === 'result' && m._conversationId === convoId && m._agent === 'content-lead', { label: 'delegate result' });
    assert.strictEqual(result.result, 'Penn took over and delivered.');

    // delegate got the DELEGATION BRIEF (intercepted cold spawn: brief only, no transcript dump)
    const pennInv = h.readInvocations().find(i => i.agent === 'content-lead');
    assert.ok(pennInv);

    // orchestrator's prose survived into the transcript before the SIGKILL
    const t = transcript(convoId);
    const cosEntry = t.find(e => e.agent === 'chief-of-staff');
    assert.ok(cosEntry.text.includes('Handing to Penn.'));

    // orchestrator got its done AFTER the switch (client bubble promotion order)
    const doneIdx = client.messages.findIndex(m => m.type === 'system' && m.subtype === 'done' && m._conversationId === convoId && m._agent === 'chief-of-staff');
    const swIdx = client.messages.indexOf(sw);
    assert.ok(doneIdx > swIdx, 'done for orchestrator sent after agent_switch');

    // no live orchestrator process: active entry is the delegate
    assert.strictEqual(h.internal.chatProcesses.get(convoId).agentId, 'content-lead');

    h.reapConvo(convoId);
  });

  test('COMPLETE gate: intercepted delegate finishing restarts the parent via --resume, parked silently, with sanitized output injected', async () => {
    const convoId = h.freshConvoId('int');
    h.clearInvocations();
    h.writeScenario([
      {
        match: { agent: 'chief-of-staff', promptIncludes: 'complete-gate please' },
        turn: [{ agentTool: { subagent_type: 'content-lead', prompt: 'complete-gate brief' } }],
      },
      {
        match: { agent: 'content-lead', promptIncludes: 'complete-gate brief' },
        turn: [{ text: `RESULT-PAYLOAD-77 delivered. ${MARKERS.COMPLETE}` }],
      },
      {
        // The parked parent must receive the pipeline-complete prompt WITH the
        // specialist's output and WITHOUT the marker (sanitizeSpecialistOutput).
        match: { agent: 'chief-of-staff', promptIncludes: ['[SYSTEM: pipeline-complete]', 'RESULT-PAYLOAD-77'], promptExcludes: 'RUNDOCK:COMPLETE' },
        turn: [{ text: '<silent>' }],
      },
    ]);

    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'complete-gate please' });

    // switch to delegate, delegate result, then switch back to parent
    await client.waitFor(m => m.type === 'system' && m.subtype === 'agent_switch' && m._conversationId === convoId && m.toAgent === 'content-lead', { label: 'to delegate' });
    await client.waitFor(m => m.type === 'result' && m._conversationId === convoId && m._agent === 'content-lead', { label: 'delegate result' });

    // NOTE: after the interception SIGKILL, the original orchestrator's own
    // assistant+result envelopes still leak through as a chief-of-staff result
    // with EMPTY text. That is the per-line exited-guard behavior (the
    // entry.exited guard is per-chunk, not per-line) surfacing as an observable
    // event here. We must NOT key the resume assertions off that early leaked
    // result. Sequence off the switch-back and the SILENT restart instead, which
    // only occur in the close handler after the 500ms auto-return kill.
    // Regression companion in regression.test.js.
    await client.waitFor(m => m.type === 'system' && m.subtype === 'agent_switch' && m._conversationId === convoId && m.toAgent === 'chief-of-staff', { label: 'back to parent' });

    // parent restart is SILENT (no visible auto-continue)
    const { msg: started, index: startedIdx } = await client.waitFor(m => m.type === 'system' && m.subtype === 'process_started' && m._conversationId === convoId && m._agent === 'chief-of-staff' && m.autoContinue, { label: 'parent restart' });
    assert.strictEqual(started.silent, true, 'pipeline-complete restart is silent');

    // Wait for the RESUMED parent's result (after the restart index), which
    // only arrives once the resumed stub has booted (and logged its
    // invocation) and answered the pipeline-complete prompt.
    await client.waitFor(m => m.type === 'result' && m._conversationId === convoId && m._agent === 'chief-of-staff', { since: startedIdx + 1, label: 'resumed parent result' });

    // parent was resumed with the orchestrator's original session id
    const invs = h.readInvocations();
    const cosResume = invs.filter(i => i.agent === 'chief-of-staff' && i.resume);
    assert.strictEqual(cosResume.length, 1, 'parent restarted with --resume');
    const cosOriginal = invs.find(i => i.agent === 'chief-of-staff' && !i.resume);
    assert.ok(cosResume[0].resume.includes('stub-chief-of-staff'), 'resumed the parent session');
    assert.ok(cosOriginal, 'original cold spawn recorded');
    const t = transcript(convoId);
    assert.ok(!t.some(e => e.text.includes('<silent>')), 'silent park filtered from transcript');
    assert.ok(!t.some(e => e.text.includes('STUB-NO-RULE')), 'parent prompt matched the strict rule (output injected, marker stripped)');

    // parent is parked idle; a user follow-up goes to it over stdin
    const entry = h.internal.chatProcesses.get(convoId);
    assert.strictEqual(entry.agentId, 'chief-of-staff');
    assert.strictEqual(entry.idle, true);

    h.writeScenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 'follow-up after complete' }, turn: [{ text: 'Parent handling the follow-up.' }] },
    ]);
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'follow-up after complete' });
    const { msg: fu } = await client.waitFor(m => m.type === 'result' && m._conversationId === convoId, { since, label: 'follow-up result' });
    assert.strictEqual(fu.result, 'Parent handling the follow-up.');
    assert.strictEqual(h.readInvocations().filter(i => i.agent === 'chief-of-staff').length, 2, 'follow-up reused the resumed parent process');
  });

  test('RETURN path: intercepted delegate returning out-of-scope auto-continues the parent with a routing prompt, which can delegate onward', async () => {
    const convoId = h.freshConvoId('int');
    h.clearInvocations();
    h.writeScenario([
      {
        match: { agent: 'chief-of-staff', promptIncludes: 'return-path please' },
        turn: [{ agentTool: { subagent_type: 'content-lead', prompt: 'return-path brief for penn' } }],
      },
      {
        match: { agent: 'content-lead', promptIncludes: 'return-path brief' },
        turn: [{ text: `This is design work, handing back. ${MARKERS.RETURN}` }],
      },
      {
        // resumed parent gets the routing request naming the returning agent
        match: { agent: 'chief-of-staff', promptIncludes: ['content-lead returned because the request was outside their scope', 'return-path brief for penn'] },
        turn: [
          { text: 'Routing to Des instead.' },
          { agentTool: { subagent_type: 'lead-designer', prompt: 'return-path design brief' } },
        ],
      },
      {
        match: { agent: 'lead-designer', promptIncludes: 'return-path design brief' },
        turn: [{ text: 'Des delivered the design.' }],
      },
    ]);

    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'return-path please' });

    // penn returns; parent auto-continues NON-silently
    await client.waitFor(m => m.type === 'result' && m._conversationId === convoId && m._agent === 'content-lead', { label: 'penn result' });
    const { msg: restart } = await client.waitFor(m => m.type === 'system' && m.subtype === 'process_started' && m._conversationId === convoId && m._agent === 'chief-of-staff' && m.autoContinue, { label: 'parent auto-continue' });
    assert.notStrictEqual(restart.silent, true, 'RETURN restart is a visible auto-continue');

    // parent's routing turn is intercepted again -> Des takes over and delivers
    const { msg: desResult } = await client.waitFor(m => m.type === 'result' && m._conversationId === convoId && m._agent === 'lead-designer', { label: 'des result', timeout: 12000 });
    assert.strictEqual(desResult.result, 'Des delivered the design.');

    // full hop chain visible in agent switches
    const hops = client.messages
      .filter(m => m.type === 'system' && m.subtype === 'agent_switch' && m._conversationId === convoId)
      .map(m => `${m.fromAgent}>${m.toAgent}`);
    assert.deepStrictEqual(hops, [
      'chief-of-staff>content-lead',
      'content-lead>chief-of-staff',
      'chief-of-staff>lead-designer',
    ]);

    h.reapConvo(convoId);
  });

  test('scope-return loop guard: orchestrator immediately re-targeting the just-returned specialist is blocked with an "already completed" notice', async () => {
    const convoId = h.freshConvoId('int');
    h.writeScenario([
      {
        match: { agent: 'chief-of-staff', promptIncludes: 'loop-guard please' },
        turn: [{ agentTool: { subagent_type: 'content-lead', prompt: 'loop-guard brief' } }],
      },
      {
        match: { agent: 'content-lead', promptIncludes: 'loop-guard brief' },
        turn: [{ text: `Outside my lane. ${MARKERS.RETURN}` }],
      },
      {
        // parent stubbornly re-delegates to the SAME specialist
        match: { agent: 'chief-of-staff', promptIncludes: 'content-lead returned because the request was outside their scope' },
        turn: [{ agentTool: { subagent_type: 'content-lead', prompt: 'loop-guard retry' } }],
      },
    ]);

    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'loop-guard please' });

    const { msg: notice } = await client.waitFor(
      m => m.type === 'assistant' && m._conversationId === convoId && typeof m.message?.content === 'string' && m.message.content.includes('has already completed this task'),
      { since, label: 'loop-guard notice', timeout: 12000 }
    );
    assert.ok(notice.message.content.includes('Penn'), 'notice names the specialist');

    // The loop guard now respawns the orchestrator (interception had
    // SIGKILLed it), so a LIVE process remains for the user to continue with.
    const { msg: reStart } = await client.waitFor(
      m => m.type === 'system' && m.subtype === 'process_started' && m._conversationId === convoId && m._agent === 'chief-of-staff',
      { since, label: 'orchestrator respawned', timeout: 12000 }
    );
    assert.ok(reStart, 'orchestrator respawned after the loop guard');
    const entry = h.internal.chatProcesses.get(convoId);
    assert.ok(entry && !entry.exited, 'a live orchestrator remains after the loop guard');
  });
});

describe('circuit breaker', () => {
  test('three consecutive agent handoffs without user input trip MAX_CONSECUTIVE_AGENT_RESUMES and pause the pipeline', async () => {
    assert.strictEqual(h.internal.MAX_CONSECUTIVE_AGENT_RESUMES, 3, 'breaker threshold pinned');
    const convoId = h.freshConvoId('cb');
    h.writeScenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 'breaker-start please' },
        turn: [{ agentTool: { subagent_type: 'content-lead', prompt: 'breaker-hop-1' } }] },
      { match: { agent: 'content-lead', promptIncludes: 'breaker-hop-1' },
        turn: [{ text: `Not mine. ${MARKERS.RETURN}` }] },
      { match: { agent: 'chief-of-staff', promptIncludes: 'breaker-hop-1' },
        turn: [{ agentTool: { subagent_type: 'lead-designer', prompt: 'breaker-hop-2' } }] },
      { match: { agent: 'lead-designer', promptIncludes: 'breaker-hop-2' },
        turn: [{ text: `Not mine either. ${MARKERS.RETURN}` }] },
      { match: { agent: 'chief-of-staff', promptIncludes: 'breaker-hop-2' },
        turn: [{ agentTool: { subagent_type: 'content-lead', prompt: 'breaker-hop-3' } }] },
      { match: { agent: 'content-lead', promptIncludes: 'breaker-hop-3' },
        turn: [{ text: `Still not mine. ${MARKERS.RETURN}` }] },
      // If the breaker fails, the orchestrator would get another routing
      // prompt; this rule would keep the loop going forever.
      { match: { agent: 'chief-of-staff', promptIncludes: 'breaker-hop-3' },
        turn: [{ agentTool: { subagent_type: 'lead-designer', prompt: 'breaker-hop-4' } }] },
    ]);

    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'breaker-start please' });

    const { msg: paused } = await client.waitFor(
      m => m.type === 'assistant' && m._conversationId === convoId && typeof m.message?.content === 'string' && m.message.content.includes('[Auto-paused: 3 consecutive agent handoffs'),
      { since, label: 'auto-pause message', timeout: 20000 }
    );
    assert.ok(paused.message.content.includes('send your next message to continue'), 'user guidance included');

    // counter was reset when the breaker fired
    assert.strictEqual(h.internal.agentAutoResumeCount.get(convoId), 0);

    // and no fourth hop was spawned
    await h.delay(1200);
    assert.ok(!h.readInvocations().some(i => JSON.stringify(i.argv).includes('breaker-hop-4')), 'loop stopped');
  });

  test('a user follow-up resets the auto-resume counter (fresh spawns do not touch it: pinned as-is)', async () => {
    const convoId = h.freshConvoId('cb');
    h.writeScenario([
      { match: { agent: 'lead-designer', promptIncludes: 'reset-counter' }, turn: [{ text: 'Turn done.' }] },
    ]);
    // Fresh spawn path does NOT reset the counter (only the stdin follow-up
    // path does). Pin that quirk, then exercise the reset.
    h.internal.agentAutoResumeCount.set(convoId, 2);
    client.send({ type: 'chat', conversationId: convoId, agent: 'lead-designer', content: 'reset-counter one' });
    await client.waitForEvent('system', 'done', convoId);
    assert.strictEqual(h.internal.agentAutoResumeCount.get(convoId), 2, 'fresh spawn leaves the counter alone (pinned as-is)');

    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'lead-designer', content: 'reset-counter two' });
    await client.waitFor(m => m.type === 'result' && m._conversationId === convoId, { since, label: 'follow-up result' });
    assert.strictEqual(h.internal.agentAutoResumeCount.get(convoId), 0, 'stdin follow-up resets the breaker');
    h.reapConvo(convoId);
  });
});

describe('directly-started specialist scope return (handleScopeReturn)', () => {
  test('RETURN: specialist exits, orchestrator cold-spawns with a routing-request prompt carrying sanitized output', async () => {
    const convoId = h.freshConvoId('sr');
    h.clearInvocations();
    h.writeScenario([
      { match: { agent: 'content-lead', promptIncludes: 'direct-return please' },
        turn: [{ text: `DIRECT-RETURN-PAYLOAD outside my lane. ${MARKERS.RETURN}` }] },
      // The direct-start onResult now sets finalResponseText (mirroring
      // the delegate path), so handleScopeReturn injects the REAL specialist
      // output into the routing prompt. The rule requires the routing prompt,
      // the quoted user request, AND the specialist's actual words.
      // Regression companion in regression.test.js.
      { match: { agent: 'chief-of-staff', promptIncludes: ['[SYSTEM: routing-request]', 'direct-return please', 'DIRECT-RETURN-PAYLOAD'] },
        turn: [{ text: 'Orchestrator routing the request now.' }] },
    ]);

    client.send({ type: 'chat', conversationId: convoId, agent: 'content-lead', content: 'direct-return please' });

    const { msg: sw } = await client.waitFor(m => m.type === 'system' && m.subtype === 'agent_switch' && m._conversationId === convoId, { label: 'switch to orchestrator' });
    assert.strictEqual(sw.fromAgent, 'content-lead');
    assert.strictEqual(sw.toAgent, 'chief-of-staff');

    const { msg: started } = await client.waitFor(m => m.type === 'system' && m.subtype === 'process_started' && m._conversationId === convoId && m._agent === 'chief-of-staff', { label: 'orchestrator started' });
    assert.strictEqual(started.autoContinue, true);
    assert.notStrictEqual(started.silent, true, 'routing-request start is visible');

    const { msg: result } = await client.waitFor(m => m.type === 'result' && m._conversationId === convoId && m._agent === 'chief-of-staff', { label: 'orchestrator result' });
    assert.strictEqual(result.result, 'Orchestrator routing the request now.', 'strict prompt rule matched: routing request with quoted user message AND the specialist output present');

    // pinned as-is (by design): the scope-return orchestrator is a
    // cold spawn, no --resume
    const cosInv = h.readInvocations().find(i => i.agent === 'chief-of-staff');
    assert.strictEqual(cosInv.resume, null);
  });

  test('COMPLETE: specialist exits, orchestrator parks silently', async () => {
    const convoId = h.freshConvoId('sr');
    h.writeScenario([
      { match: { agent: 'content-lead', promptIncludes: 'direct-complete please' },
        turn: [{ text: `All done here. ${MARKERS.COMPLETE}` }] },
      { match: { agent: 'chief-of-staff', promptIncludes: '[SYSTEM: pipeline-complete]' },
        turn: [{ text: '<silent>' }] },
    ]);

    client.send({ type: 'chat', conversationId: convoId, agent: 'content-lead', content: 'direct-complete please' });
    const { msg: started } = await client.waitFor(m => m.type === 'system' && m.subtype === 'process_started' && m._conversationId === convoId && m._agent === 'chief-of-staff', { label: 'orchestrator started' });
    assert.strictEqual(started.silent, true, 'pipeline-complete park is silent');
    await client.waitFor(m => m.type === 'result' && m._conversationId === convoId && m._agent === 'chief-of-staff', { label: 'parked result' });
    assert.ok(!transcript(convoId).some(e => e.text.includes('<silent>')));
  });

  test('BOTH markers on a directly-started specialist resolve to COMPLETE (like every other path)', async () => {
    const convoId = h.freshConvoId('sr');
    h.writeScenario([
      { match: { agent: 'content-lead', promptIncludes: 'both-markers please' },
        turn: [{ text: `Finished AND out of scope. ${MARKERS.RETURN} ${MARKERS.COMPLETE}` }] },
      { match: { agent: 'chief-of-staff', promptIncludes: '[SYSTEM: routing-request]' },
        turn: [{ text: 'ROUTING-PROMPT-RECEIVED-SENTINEL' }] },
      { match: { agent: 'chief-of-staff', promptIncludes: '[SYSTEM: pipeline-complete]' },
        turn: [{ text: '<silent>' }] },
    ]);
    client.send({ type: 'chat', conversationId: convoId, agent: 'content-lead', content: 'both-markers please' });
    // Both-markers now resolves to COMPLETE: the orchestrator parks silently
    // (pipeline-complete), it does not get the routing-request prompt.
    // Regression companion in regression.test.js.
    const { msg: started } = await client.waitFor(m => m.type === 'system' && m.subtype === 'process_started' && m._conversationId === convoId && m._agent === 'chief-of-staff', { label: 'started' });
    assert.strictEqual(started.silent, true, 'pipeline-complete park is silent');
    await client.waitFor(m => m.type === 'result' && m._conversationId === convoId && m._agent === 'chief-of-staff', { label: 'parked result' });
    assert.ok(!transcript(convoId).some(e => e.text.includes('ROUTING-PROMPT-RECEIVED-SENTINEL')), 'routing prompt not used on both-markers');
  });
});

describe('kill-window follow-up', () => {
  test('a user follow-up inside the 500ms auto-return window cancels the kill and is served by the live delegate, with no orphaned parent', async () => {
    const convoId = h.freshConvoId('kw');
    await startOrchestrator(convoId, 'kill-window-setup');
    h.clearInvocations();
    h.writeScenario([
      // Delegate finishes with COMPLETE -> onResult arms the 500ms auto-return kill.
      { match: { agent: 'content-lead', promptIncludes: 'kill-window task' },
        turn: [{ text: `Pipeline finished. ${MARKERS.COMPLETE}` }] },
      // The follow-up must reach the still-live delegate over stdin.
      { match: { agent: 'content-lead', promptIncludes: 'kill-window followup' },
        turn: [{ text: 'Live delegate served the follow-up.' }] },
    ]);

    const since = client.messages.length;
    client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'content-lead', context: 'kill-window task' });
    await client.waitFor(m => m.type === 'result' && m._conversationId === convoId && m._agent === 'content-lead', { since, label: 'delegate COMPLETE result' });

    // Follow-up INSIDE the kill window (sent immediately, well under 500ms in the
    // in-process harness): it must cancel the auto-return and land on the live
    // delegate, not spawn-fresh and not the orchestrator.
    const since2 = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'content-lead', content: 'kill-window followup' });
    const { msg: fu } = await client.waitFor(m => m.type === 'result' && m._conversationId === convoId && m._agent === 'content-lead', { since: since2, label: 'follow-up served by live delegate' });
    assert.strictEqual(fu.result, 'Live delegate served the follow-up.');

    // (i) No orphaned parent: the active entry is still the delegate, alive, and
    // the parked orchestrator is still referenced via its delegation. In the
    // buggy spawn-fresh path this entry is a NEW content-lead with no delegation
    // and the parked orchestrator is leaked.
    const entry = h.internal.chatProcesses.get(convoId);
    assert.strictEqual(entry.agentId, 'content-lead');
    assert.strictEqual(entry.exited, false, 'delegate stayed alive (auto-return cancelled)');
    assert.strictEqual(entry.pendingKill, false, 'pending auto-return was cancelled by the follow-up');
    assert.ok(entry.delegation && entry.delegation.originalEntry && entry.delegation.originalEntry.agentId === 'chief-of-staff',
      'parked orchestrator still tracked via the live delegate, not orphaned');

    // (ii) The follow-up reused the live delegate: no fresh spawn. Buggy path
    // spawns a second content-lead (msg.agent) after killing the first.
    assert.strictEqual(h.readInvocations().filter(i => i.agent === 'content-lead').length, 1,
      'follow-up reused the live delegate (no spawn-fresh)');
    assert.strictEqual(h.readInvocations().filter(i => i.agent === 'chief-of-staff').length, 0,
      'no orchestrator respawn');

    // (iii) No auto-return handback fired: no switch back to the orchestrator.
    assert.ok(!client.messages.slice(since2).some(m => m.type === 'system' && m.subtype === 'agent_switch' && m._conversationId === convoId && m.toAgent === 'chief-of-staff'),
      'the auto-return switch to the orchestrator never fired: the kill was cancelled');

    h.reapConvo(convoId);
  });
});

describe('kill-window follow-up: cancel-then-crash', () => {
  // An intercepted delegate emits RETURN (arming the 500ms auto-return): onResult
  // stashes the marker in finalResponseText and resets responseText. A user
  // follow-up lands IN-WINDOW and cancels the auto-return (clearing pendingKill /
  // scopeReturn / returnMarkerSeen / responseText). Then the still-live delegate
  // dies abnormally BEFORE its next result. Pre-fix, finalResponseText was NOT
  // cleared, so the close handler's fallback marker-scan re-derives RETURN from
  // the stale text (it wins `|| responseText` because responseText was reset) and
  // fires a SPURIOUS out-of-scope handback: the parent is auto-resumed with the
  // stale specialist output block and a routing prompt for a follow-up the user
  // expected the live process to answer. The fix clears finalResponseText in the
  // follow-up path so no marker survives and the parent restarts silently.
  test('a follow-up cancels the auto-return, then the delegate crashes: NO spurious handback, no stale output injected', async () => {
    const convoId = h.freshConvoId('f1');
    h.clearInvocations();
    h.writeScenario([
      // 1. Orchestrator delegates to content-lead via an intercepted Agent tool.
      { match: { agent: 'chief-of-staff', promptIncludes: 'f1-parent please' },
        turn: [{ agentTool: { subagent_type: 'content-lead', prompt: 'f1 delegate brief' } }] },
      // 2. Delegate returns out-of-scope: arms the 500ms auto-return, stashes the
      //    marker + distinctive payload in finalResponseText, resets responseText.
      { match: { agent: 'content-lead', promptIncludes: 'f1 delegate brief' },
        turn: [{ text: `STALE-PAYLOAD-SENTINEL outside my lane. ${MARKERS.RETURN}` }] },
      // 3. Follow-up lands IN-WINDOW (cancels the auto-return); the delegate then
      //    dies abnormally (non-zero, non-cancelled) BEFORE producing a result.
      { match: { agent: 'content-lead', promptIncludes: 'f1-followup' },
        crash: 1 },
      // 4a. SPURIOUS path (pre-fix ONLY): stale finalResponseText re-derives RETURN;
      //     the parent is resumed out-of-scope with the stale block injected. This
      //     rule keys on BOTH the out-of-scope routing language AND the stale
      //     payload, so it only matches if the bug fires.
      { match: { agent: 'chief-of-staff', promptIncludes: ['returned because the request was outside their scope', 'STALE-PAYLOAD-SENTINEL'] },
        turn: [{ text: 'SPURIOUS-HANDBACK-FIRED' }] },
      // 4b. CORRECT path (post-fix): no marker survives, parent restarts silently
      //     with an empty output block.
      { match: { agent: 'chief-of-staff', promptIncludes: '[SYSTEM: pipeline-complete]' },
        turn: [{ text: '<silent>' }] },
    ]);

    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'f1-parent please' });

    // Delegate emits RETURN -> auto-return armed (pendingKill, 500ms).
    const { msg: ret } = await client.waitFor(
      m => m.type === 'result' && m._conversationId === convoId && m._agent === 'content-lead',
      { since, label: 'delegate RETURN result' });
    assert.ok(/RUNDOCK:RETURN/.test(ret.result), 'delegate returned out-of-scope');

    // Follow-up INSIDE the window: cancels the auto-return, lands on the live
    // delegate, which then crashes before answering.
    const since2 = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'content-lead', content: 'f1-followup answer this' });

    // The close handler restarts the parent. Wait for the parent's turn.
    const { msg: parentResult } = await client.waitFor(
      m => m.type === 'result' && m._conversationId === convoId && m._agent === 'chief-of-staff',
      { since: since2, label: 'parent turn after crash', timeout: 15000 });

    // (i) The spurious out-of-scope handback never fired.
    assert.notStrictEqual(parentResult.result, 'SPURIOUS-HANDBACK-FIRED',
      'parent must NOT be resumed with the stale out-of-scope routing prompt + injected block');
    assert.ok(!client.messages.slice(since2).some(m =>
      (m.type === 'result' && m.result === 'SPURIOUS-HANDBACK-FIRED') ||
      (m.type === 'assistant' && JSON.stringify(m).includes('SPURIOUS-HANDBACK-FIRED'))),
      'no message re-derived the superseded RETURN handback');

    // (ii) The stale specialist output block was never injected into any parent prompt
    //      (proxied by the sentinel rule keyed on STALE-PAYLOAD-SENTINEL not matching).
    assert.ok(!transcript(convoId).some(e => e.text.includes('SPURIOUS-HANDBACK-FIRED')),
      'the stale finalResponseText did not drive a handback');

    // (iii) Any parent restart after the cancelled-then-crashed delegate is a SILENT
    //       park, never a visible out-of-scope auto-continue. Pre-fix the RETURN path
    //       emits process_started WITHOUT silent:true.
    const parentStarts = client.messages.slice(since2).filter(m =>
      m.type === 'system' && m.subtype === 'process_started' &&
      m._conversationId === convoId && m._agent === 'chief-of-staff' && m.autoContinue);
    for (const s of parentStarts) {
      assert.strictEqual(s.silent, true,
        'parent restart after a cancelled-then-crashed delegate must be a silent park, not a visible RETURN auto-continue');
    }

    h.reapConvo(convoId);
  });
});

describe('resumed-parent scope return injects real output', () => {
  test('a resumed parent that emits its own marker hands off with NON-empty specialist output', async () => {
    const convoId = h.freshConvoId('c5');
    h.clearInvocations();
    h.writeScenario([
      // 1. Orchestrator delegates to Penn via an intercepted Agent tool call.
      { match: { agent: 'chief-of-staff', promptIncludes: 'c5-parent please' },
        turn: [{ agentTool: { subagent_type: 'content-lead', prompt: 'c5 delegate brief' } }] },
      // 2. Penn returns out-of-scope, so the orchestrator is resumed with the
      //    routing prompt (the resumeEntry path in handleDelegation).
      { match: { agent: 'content-lead', promptIncludes: 'c5 delegate brief' },
        turn: [{ text: `Not my lane. ${MARKERS.RETURN}` }] },
      // 3. The RESUMED orchestrator itself emits a marker with distinctive output.
      //    This is the third mirrored onResult site: its finalResponseText
      //    must be preserved so the downstream handleScopeReturn injects it.
      { match: { agent: 'chief-of-staff', promptIncludes: 'content-lead returned because the request was outside their scope' },
        turn: [{ text: `PARENT-OWN-OUTPUT-SENTINEL handing off. ${MARKERS.RETURN}` }] },
      // 4. handleScopeReturn spawns a fresh orchestrator whose routing prompt MUST
      //    carry the resumed parent's real words (marker stripped). Pre-fix the
      //    block is empty, this strict rule misses, and STUB-NO-RULE fires instead.
      { match: { agent: 'chief-of-staff', promptIncludes: ['[SYSTEM: routing-request]', 'PARENT-OWN-OUTPUT-SENTINEL'], promptExcludes: 'RUNDOCK:RETURN' },
        turn: [{ text: 'INJECTED-OK-SENTINEL' }] },
    ]);

    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'c5-parent please' });

    const { msg: result } = await client.waitFor(
      m => m.type === 'result' && m._conversationId === convoId && m._agent === 'chief-of-staff' && m.result === 'INJECTED-OK-SENTINEL',
      { label: 'final orchestrator result carrying injected output', timeout: 15000 }
    );
    assert.strictEqual(result.result, 'INJECTED-OK-SENTINEL',
      'handleScopeReturn injected the resumed parent output (non-empty block); pre-fix the block is empty and this rule never matches');
    assert.ok(!transcript(convoId).some(e => e.text.includes('STUB-NO-RULE')),
      'the strict routing rule matched: the resumed parent output was actually injected');

    h.reapConvo(convoId);
  });
});

describe('platform delegate (Doc)', () => {
  test('intercepted platform delegate completing restores the parent silently; bare RETURN without out-of-scope language is overridden to COMPLETE', async () => {
    const convoId = h.freshConvoId('doc');
    h.clearInvocations();
    h.writeScenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 'doc-override please' },
        turn: [{ agentTool: { subagent_type: 'rundock-guide', prompt: 'doc-override create an agent' } }] },
      // Doc does the work but wrongly emits RETURN with no out-of-scope language.
      { match: { agent: 'rundock-guide', promptIncludes: 'doc-override create an agent' },
        turn: [{ text: `Agent created as requested. ${MARKERS.RETURN}` }] },
      { match: { agent: 'chief-of-staff', promptIncludes: '[SYSTEM: pipeline-complete]' },
        turn: [{ text: '<silent>' }] },
      // If the override failed, this routing rule would fire instead and the
      // assertion below would catch it.
      { match: { agent: 'chief-of-staff', promptIncludes: 'returned because the request was outside their scope' },
        turn: [{ text: 'DOC-OVERRIDE-FAILED' }] },
    ]);

    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'doc-override please' });
    await client.waitFor(m => m.type === 'result' && m._conversationId === convoId && m._agent === 'rundock-guide', { label: 'doc result' });

    const { msg: started } = await client.waitFor(m => m.type === 'system' && m.subtype === 'process_started' && m._conversationId === convoId && m._agent === 'chief-of-staff' && m.autoContinue, { label: 'parent restart' });
    assert.strictEqual(started.silent, true, 'platform RETURN overridden to COMPLETE: silent park, no routing');
    await client.waitFor(m => m.type === 'result' && m._conversationId === convoId && m._agent === 'chief-of-staff', { label: 'parked result' });
    assert.ok(!transcript(convoId).some(e => e.text.includes('DOC-OVERRIDE-FAILED')));
  });

  test('platform delegate auto-returns on a CRUD marker even without COMPLETE', async () => {
    const convoId = h.freshConvoId('doc');
    h.writeScenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 'doc-crud please' },
        turn: [{ agentTool: { subagent_type: 'rundock-guide', prompt: 'doc-crud save a skill' } }] },
      { match: { agent: 'rundock-guide', promptIncludes: 'doc-crud save a skill' },
        turn: [{ text: `Here is the skill. ${MARKERS.saveSkill('demo-skill', 'skill body')}` }] },
      { match: { agent: 'chief-of-staff', promptIncludes: '[SYSTEM: pipeline-complete]' },
        turn: [{ text: '<silent>' }] },
    ]);

    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'doc-crud please' });
    await client.waitFor(m => m.type === 'result' && m._conversationId === convoId && m._agent === 'rundock-guide', { label: 'doc result' });
    // CRUD marker alone triggers the auto-return: parent restarts silently
    const { msg: started } = await client.waitFor(m => m.type === 'system' && m.subtype === 'process_started' && m._conversationId === convoId && m._agent === 'chief-of-staff' && m.autoContinue, { label: 'parent restart' });
    assert.strictEqual(started.silent, true);
  });
});

describe('roster refresh', () => {
  test('agent CRUD while an orchestrator is live flags it; the next message respawns it instead of reusing stdin', async () => {
    const convoId = h.freshConvoId('rr');
    await startOrchestrator(convoId, 'roster-refresh-setup');
    assert.strictEqual(h.internal.chatProcesses.get(convoId).needsRosterRefresh, undefined);

    // Use a well-formed agent file (explicit type/order/reportsTo). A file
    // with NO `description:` triggers the frontmatter-injection defect
    // (type/order prepended BEFORE the opening ---, corrupting the frontmatter
    // so name/role parse as body); that case is covered separately in
    // test/integration/http-api.test.js. Here we want a clean roster entry.
    client.send({ type: 'save_agent', name: 'roster-test-agent', content: '---\nname: roster-test-agent\ndisplayName: Roster\nrole: Temp Role\ndescription: A temporary test agent\ntype: specialist\norder: 8\nreportsTo: chief-of-staff\n---\nTemp agent.\n' });
    await client.waitFor(m => m.type === 'agent_saved' && m.agentId === 'roster-test-agent', { label: 'agent_saved' });
    assert.strictEqual(h.internal.chatProcesses.get(convoId).needsRosterRefresh, true, 'live orchestrator flagged');

    h.clearInvocations();
    h.writeScenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 'post-crud question' }, turn: [{ text: 'Fresh roster loaded.' }] },
    ]);
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'post-crud question' });
    const { msg: result } = await client.waitFor(m => m.type === 'result' && m._conversationId === convoId, { since, label: 'post-refresh result' });
    assert.strictEqual(result.result, 'Fresh roster loaded.');
    const invs = h.readInvocations();
    assert.strictEqual(invs.length, 1, 'stale orchestrator killed and respawned');
    const sysPrompt = invs[0].argv[invs[0].argv.indexOf('--append-system-prompt') + 1];
    assert.ok(sysPrompt.includes('roster-test-agent'), 'fresh roster includes the new agent');
    assert.ok(sysPrompt.includes('Roster (roster-test-agent)'), 'new agent rendered in the roster with its display name');

    // cleanup
    client.send({ type: 'delete_agent', agentId: 'roster-test-agent' });
    await client.waitFor(m => m.type === 'agent_deleted', { label: 'cleanup delete' });
  });
});
