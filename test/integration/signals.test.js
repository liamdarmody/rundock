'use strict';
// Build A: the signal layer. Local, append-only, skinny events recorded at
// server-layer convergence points so both runtimes are measured identically.
//
// The contract these tests pin:
// 1. Events land in .rundock/state/events-YYYY-MM.jsonl with the skinny
//    schema {ts, e, conv, agent, runtime, d}: no message content, no prompt
//    text, no tool arguments.
// 2. Capture can never break the product: a failing write is logged and
//    dropped, the turn completes normally.
// 3. The skill-usage sidecar counts Skill-tool invocations per skill without
//    scanning history.
// 4. Zero behavior change: the spawn argv freeze suite (spawn-argv-freeze
//    .test.js) proves no spawn path changed; nothing here touches spawns.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../helpers/harness.js');

let client;

before(async () => {
  await h.boot();
  client = await h.connect();
});
after(async () => h.shutdown());

function eventsFile() {
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  return path.join(h.workspaceDir, '.rundock', 'state', `events-${month}.jsonl`);
}

function readEvents() {
  const file = eventsFile();
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

async function waitForEvent(pred, label) {
  await h.waitUntil(() => readEvents().some(pred), { timeout: 4000, label });
  return readEvents().find(pred);
}

describe('signal layer', () => {
  test('an agent turn records a skinny turn event', async () => {
    const convoId = h.freshConvoId('sig-turn');
    h.writeScenario([
      { match: { agent: 'lead-designer', promptIncludes: 'signal turn please' },
        turn: [
          { tool: { name: 'Read', input: { file_path: 'notes.md' } } },
          { text: 'Here is the design summary.' },
        ] },
    ]);
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'lead-designer', content: 'signal turn please' });
    await client.waitFor(m => m.type === 'result' && m._conversationId === convoId, { since, label: 'turn result' });

    const ev = await waitForEvent(e => e.e === 'turn' && e.conv === convoId, 'turn event');
    assert.strictEqual(ev.agent, 'lead-designer');
    assert.strictEqual(ev.runtime, 'claude');
    assert.ok(typeof ev.ts === 'string' && ev.ts.includes('T'), 'ISO timestamp');
    assert.strictEqual(ev.d.tools, 1, 'tool count, not tool arguments');
    assert.deepStrictEqual(ev.d.skills, [], 'no Skill invocations this turn');
    assert.deepStrictEqual(ev.d.markers, [], 'no markers this turn');
    assert.strictEqual(ev.d.routing, false);
    // Skinny: no content fields anywhere in the event.
    const flat = JSON.stringify(ev);
    assert.ok(!flat.includes('design summary'), 'events must not carry message content');
    assert.ok(!flat.includes('notes.md'), 'events must not carry tool arguments');
  });

  test('Skill-tool invocations mark the turn event and bump the usage sidecar', async () => {
    const convoId = h.freshConvoId('sig-skill');
    h.writeScenario([
      { match: { agent: 'lead-designer', promptIncludes: 'use the export skill' },
        turn: [
          { tool: { name: 'Skill', input: { skill: 'design-export' } } },
          { text: 'Exported.' },
        ] },
    ]);
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'lead-designer', content: 'use the export skill' });
    await client.waitFor(m => m.type === 'result' && m._conversationId === convoId, { since, label: 'skill turn result' });

    const ev = await waitForEvent(e => e.e === 'turn' && e.conv === convoId, 'skill turn event');
    assert.deepStrictEqual(ev.d.skills, ['design-export'], 'Skill slugs from the turn');

    const sidecar = path.join(h.workspaceDir, '.rundock', 'state', 'skill-usage.json');
    await h.waitUntil(() => fs.existsSync(sidecar), { timeout: 4000, label: 'sidecar file' });
    const usage = JSON.parse(fs.readFileSync(sidecar, 'utf-8'));
    assert.strictEqual(usage['design-export'].useCount, 1);
    assert.ok(usage['design-export'].lastUsed, 'lastUsed stamped');
  });

  test('a delegation records delegation_start, the routing turn, and the handback', async () => {
    const convoId = h.freshConvoId('sig-deleg');
    h.clearInvocations();
    h.writeScenario([
      { match: { agent: 'chief-of-stafF'.toLowerCase(), promptIncludes: 'signal delegation please' },
        turn: [{ agentTool: { subagent_type: 'content-lead', prompt: 'signal brief for penn' } }] },
      { match: { agent: 'content-lead', promptIncludes: 'signal brief for penn' },
        turn: [{ text: `Not my lane. ${'<!-- RUNDOCK:RETURN -->'}` }] },
      { match: { agent: 'chief-of-staff', promptIncludes: '[SYSTEM' },
        turn: [{ text: 'Routing onward.' }] },
    ]);
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'signal delegation please' });
    await client.waitFor(m => m.type === 'system' && m.subtype === 'agent_switch'
      && m._conversationId === convoId && m.toAgent === 'content-lead', { since, label: 'switch to Penn' });
    await client.waitFor(m => m.type === 'result' && m._conversationId === convoId
      && m._agent === 'content-lead', { since, label: 'Penn result' });

    try {
      const start = await waitForEvent(e => e.e === 'delegation_start' && e.conv === convoId, 'delegation_start');
      assert.strictEqual(start.d.from, 'chief-of-staff');
      assert.strictEqual(start.d.to, 'content-lead');
      assert.strictEqual(start.d.intercepted, true);

      const routing = await waitForEvent(e => e.e === 'turn' && e.conv === convoId && e.d.routing === true, 'routing turn event');
      assert.strictEqual(routing.agent, 'chief-of-staff', 'the interception records the routing turn');

      const handback = await waitForEvent(e => e.e === 'handback' && e.conv === convoId, 'handback event');
      assert.strictEqual(handback.d.kind, 'return');
      assert.strictEqual(handback.agent, 'content-lead', 'the returning agent');

      const pennTurn = await waitForEvent(e => e.e === 'turn' && e.conv === convoId && e.agent === 'content-lead', 'Penn turn event');
      assert.deepStrictEqual(pennTurn.d.markers, ['return'], 'the marker the turn carried, by name only');
    } finally {
      h.reapConvo(convoId);
    }
  });

  test('a failing event write never breaks a turn (crash injection)', async () => {
    // Sabotage the events path: make .rundock/state a FILE so every append
    // and mkdir under it fails.
    const stateDir = path.join(h.workspaceDir, '.rundock', 'state');
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.writeFileSync(stateDir, 'not a directory');

    const convoId = h.freshConvoId('sig-crash');
    h.writeScenario([
      { match: { agent: 'lead-designer', promptIncludes: 'crash injection turn' },
        turn: [{ text: 'Turn completes regardless.' }] },
    ]);
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'lead-designer', content: 'crash injection turn' });
    const { msg } = await client.waitFor(m => m.type === 'result' && m._conversationId === convoId,
      { since, label: 'result despite sabotaged events path' });
    assert.ok(msg.result.includes('Turn completes regardless'), 'the turn is unaffected');

    // Restore the directory for any later test.
    fs.rmSync(stateDir, { force: true });
    fs.mkdirSync(stateDir, { recursive: true });
  });

  test('a routine run records outcome and duration', async () => {
    h.writeScenario([
      { match: { agent: 'lead-designer', promptIncludes: 'signal routine body' },
        turn: [{ text: 'Routine done.' }] },
    ]);
    const agents = h.internal.discoverAgents();
    const agent = agents.find(a => a.id === 'lead-designer');
    h.internal.executeRoutine(agent, { name: 'signal-check', prompt: 'signal routine body' }, 'lead-designer::signal-check');
    const ev = await waitForEvent(e => e.e === 'routine_run', 'routine_run event');
    assert.strictEqual(ev.d.routine, 'signal-check');
    assert.ok(['completed', 'failed'].includes(ev.d.status));
    assert.ok(typeof ev.d.duration === 'number');
  });
});
