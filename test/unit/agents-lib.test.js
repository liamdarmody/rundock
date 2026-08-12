'use strict';
// Seams introduced by the agents extraction: lib/agents/discovery.js and
// lib/agents/prompt.js own agent discovery, frontmatter parsing, rosters, and
// system prompt assembly. Three contracts matter:
// 1. IDENTITY: _internal re-exports the modules' own function objects, so the
//    existing characterization suite keeps exercising the moved code.
// 2. LIVE WORKSPACE: discovery reads getWorkspace() at use time, never a
//    value captured at require time.
// 3. NAMED INJECTION / SHARED STATE: discoverSkills and detectCodexCached
//    (both stay in the root: skill discovery has its own area, and the codex
//    probe cache is shared with the settings runtime probe) arrive in prompt
//    through named wiring; routineState is owned by lib/scheduler.js and
//    discovery reads that one live object directly (no wiring), so root
//    mutations via the _internal re-export are visible by identity.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');

const { _internal: srv } = require('../../server.js');
const discovery = require('../../lib/agents/discovery.js');
const promptLib = require('../../lib/agents/prompt.js');
const { makeWorkspace, agentFile, standardTeam, cleanup } = require('../helpers/workspace.js');

after(cleanup);

function useWorkspace(opts) {
  const dir = makeWorkspace(opts);
  srv.setWorkspace(dir);
  return dir;
}

describe('lib/agents module seams', () => {
  test('_internal re-exports the module functions BY IDENTITY', () => {
    for (const name of [
      'discoverAgents', 'parseAgentFrontmatter', 'extractFrontmatterText',
      'parseCapabilities', 'parseRoutines', 'parsePrompts', 'parseSkills',
      'readNormalisedFile', 'titleCase',
    ]) {
      assert.strictEqual(srv[name], discovery[name], `${name} must be the discovery module's own function`);
    }
    for (const name of [
      'buildTeamRoster', 'buildPeerRoster', 'findDirectReportMatch',
      'findOffRosterWorkspaceMatch', 'extractSelfDescription', 'buildSystemPrompt',
    ]) {
      assert.strictEqual(srv[name], promptLib[name], `${name} must be the prompt module's own function`);
    }
  });

  test('discovery reads the workspace root at use time (switch is visible without re-require)', () => {
    const dirA = makeWorkspace({ agents: { alpha: agentFile({ name: 'alpha', type: 'specialist', order: 1 }) } });
    const dirB = makeWorkspace({ agents: { beta: agentFile({ name: 'beta', type: 'specialist', order: 1 }) } });
    srv.setWorkspace(dirA);
    assert.ok(discovery.discoverAgents().some(a => a.name === 'alpha'), 'workspace A agent visible');
    srv.setWorkspace(dirB);
    const names = discovery.discoverAgents().map(a => a.name);
    assert.ok(names.includes('beta'), 'workspace B agent visible after switch');
    assert.ok(!names.includes('alpha'), 'workspace A agent gone after switch');
  });

  test('routineState is shared by identity: root mutations are visible to discovery', () => {
    useWorkspace({
      agents: {
        cos: agentFile({
          name: 'cos', type: 'orchestrator', order: 0,
          routines: [{ name: 'morning-briefing', schedule: 'every day at 09:00' }],
        }),
      },
    });
    // Key by the DISCOVERED id: an order-0 orchestrator's id is 'default'.
    let agent = discovery.discoverAgents().find(a => a.name === 'cos');
    const key = `${agent.id}:morning-briefing`;
    delete srv.routineState[key];
    srv.invalidateAgentCache();
    agent = discovery.discoverAgents().find(a => a.name === 'cos');
    assert.strictEqual(agent.routines[0].state, null, 'no state recorded yet');

    const state = { lastRun: '2026-08-11T09:00:00Z', status: 'success', duration: 5 };
    srv.routineState[key] = state;
    srv.invalidateAgentCache();
    agent = discovery.discoverAgents().find(a => a.name === 'cos');
    assert.deepStrictEqual(agent.routines[0].state, state, 'root-recorded state reaches discovery output');
    delete srv.routineState[key];
  });

  test('prompt deps are injected: a fake codex detector controls the RUNTIMES section', () => {
    useWorkspace({ agents: { doc: agentFile({ name: 'doc', type: 'platform', order: 9 }) } });
    const doc = discovery.discoverAgents().find(a => a.name === 'doc');
    const prev = promptLib.wirePromptDeps({ detectCodexCached: () => ({ installed: true, authenticated: true, version: '1.0.0' }) });
    try {
      assert.match(promptLib.buildSystemPrompt(doc), /RUNTIMES:/, 'available codex surfaces the runtime section');
      promptLib.wirePromptDeps({ detectCodexCached: () => ({ installed: false, authenticated: false, version: null }) });
      assert.doesNotMatch(promptLib.buildSystemPrompt(doc), /RUNTIMES:/, 'absent codex omits the section entirely');
    } finally {
      promptLib.wirePromptDeps(prev);
    }
  });

  test('prompt deps are injected: rosters read skills through the injected discoverSkills', () => {
    useWorkspace({ agents: standardTeam() });
    const prev = promptLib.wirePromptDeps({
      discoverSkills: () => [{ slug: 'linkedin-hooks', assignedAgents: [{ id: 'content-lead' }] }],
    });
    try {
      const roster = promptLib.buildTeamRoster('chief-of-staff');
      assert.match(roster, /Skills: linkedin-hooks/, 'injected skill discovery feeds the roster lines');
    } finally {
      promptLib.wirePromptDeps(prev);
    }
  });
});
