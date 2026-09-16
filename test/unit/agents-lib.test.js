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

  test('the mandatory formatting rules say which markup to write, not only which words', () => {
    // A fact-checking agent wanted sub-headings inside a message and wrote
    // `=== Heading ===`, which is MediaWiki. Nothing rendered it, because this
    // product renders Markdown. It was not ignoring an instruction: the
    // mandatory block governed dashes and spelling and never named a syntax, so
    // there was nothing to obey. Pinned here because nothing asserted on this
    // block at all, which is how it stayed incomplete.
    useWorkspace({ agents: { doc: agentFile({ name: 'doc', type: 'platform', order: 9 }) } });
    const doc = discovery.discoverAgents().find(a => a.name === 'doc');
    const prompt = promptLib.buildSystemPrompt(doc);

    const rules = prompt.slice(prompt.indexOf('FORMATTING RULES'));
    assert.ok(rules.includes('Write Markdown'),
      'the rule names the syntax this product renders');
    for (const other of ['MediaWiki', 'reStructuredText', 'BBCode', 'Textile']) {
      assert.ok(rules.includes(other),
        `the rule names ${other} as a syntax not to reach for; pinned so a later edit cannot quietly narrow the rule to the one case that prompted it`);
    }
    assert.ok(rules.indexOf('Write Markdown') < rules.indexOf('PLATFORM RULES:'),
      'it sits inside the mandatory block, not in a section of its own');

    // Taking nothing away: the rules that were already mandatory are still here.
    assert.ok(rules.includes('NEVER use em dashes'), 'the dash rule survives');
    assert.ok(rules.includes('UK spelling'), 'and so does the spelling rule');
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

  // Issue #307. The prompt told every platform agent "Never recommend a runtime
  // or model that is not listed here", which forbade a capability the code had
  // always allowed: modelArgs never validated a model, so a gateway identifier
  // worked while Doc refused to write one. Enumerating the consumers, as the
  // card required, showed this sentence only ever reached users with Codex
  // installed AND authenticated, because it lives inside that branch. Both
  // states are asserted so that narrower blast radius is pinned, not assumed.
  test('the prompt permits any model the runtime serves, and forbids only unlisted runtimes', () => {
    useWorkspace({ agents: { doc: agentFile({ name: 'doc', type: 'platform', order: 9 }) } });
    const doc = discovery.discoverAgents().find(a => a.name === 'doc');
    const prev = promptLib.wirePromptDeps({ detectCodexCached: () => ({ installed: true, authenticated: true, version: '1.0.0' }) });
    try {
      const withCodex = promptLib.buildSystemPrompt(doc);
      assert.doesNotMatch(withCodex, /Never recommend a runtime or model that is not listed here/,
        'the blanket prohibition covered models, which the code accepts from any source');
      assert.match(withCodex, /Never recommend a runtime that is not listed here/,
        'the runtime half of the rule is real and stays: Codex either exists on this machine or does not');
      assert.match(withCodex, /any identifier the configured runtime serves/,
        'the prompt states the capability the code has always had');
      assert.match(withCodex, /model: inherit/, 'and names the value to use when the user names nothing');

      // The two runtimes need OPPOSITE instructions for the same situation,
      // and one paragraph covering both read as self-contradictory. A Codex
      // agent written with `model: inherit` gets that string passed to Codex
      // verbatim (lib/runtime/codex-glue.js openCodexThread), which answers
      // with a model-not-available card: Doc would build an agent that cannot
      // start. So the inherit instruction must be scoped to Claude Code, and
      // the Codex instruction must say omit.
      const codexSentence = withCodex.split('\n').find(l => /Codex agent/.test(l) && /OMIT|omit/.test(l));
      assert.ok(codexSentence, 'the prompt must tell Doc to omit the model field for a Codex agent');
      // It must NOT claim that `inherit` breaks a Codex agent. It used to, and
      // that stopped being true when the resolution layer started normalising
      // `inherit` to omission for Codex: a prompt that warns of a consequence
      // the code prevents is teaching Doc something false.
      assert.doesNotMatch(withCodex, /cannot start/,
        'the code tolerates inherit on Codex, so the prompt must not say otherwise');
      assert.doesNotMatch(withCodex, /For a Codex agent write `model: inherit`/,
        'omission is still the instruction for Codex, tolerated or not');

      promptLib.wirePromptDeps({ detectCodexCached: () => ({ installed: false, authenticated: false, version: null }) });
      const noCodex = promptLib.buildSystemPrompt(doc);
      assert.doesNotMatch(noCodex, /Never recommend a runtime/,
        'runtime advice is machine-specific and stays behind the Codex check');
      assert.doesNotMatch(noCodex, /RUNTIMES:/, 'as does the section it lives in');
      // The point of separating them: model advice is NOT machine-specific, and
      // the users who most need it (a gateway, no Codex installed) were the
      // exact users the old structure gave nothing to.
      assert.match(noCodex, /MODELS:/, 'model guidance reaches a machine with no Codex');
      assert.match(noCodex, /any identifier the configured runtime serves/);
      assert.match(noCodex, /model: inherit/, 'including the value to use when the user names nothing');
      assert.doesNotMatch(noCodex, /Codex agent/,
        'and says nothing about a runtime this machine does not have');
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
