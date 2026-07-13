'use strict';
// Characterization tests: agent/skill discovery and frontmatter parsing,
// including CRLF handling (the historical Windows bug: parsers use \n-only
// regexes and rely on readNormalisedFile converting CRLF at the read boundary).
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { _internal: srv } = require('../../server.js');
const { makeWorkspace, agentFile, standardTeam, cleanup } = require('../helpers/workspace.js');

after(cleanup);

function useWorkspace(opts) {
  const dir = makeWorkspace(opts);
  srv.setWorkspace(dir);
  return dir;
}

describe('parseAgentFrontmatter', () => {
  test('parses scalar keys and strips quotes', () => {
    const meta = srv.parseAgentFrontmatter('---\nname: penn\ndisplayName: "Penn"\nrole: \'Content Lead\'\norder: 2\n---\nbody');
    assert.strictEqual(meta.name, 'penn');
    assert.strictEqual(meta.displayName, 'Penn');
    assert.strictEqual(meta.role, 'Content Lead');
    assert.strictEqual(meta.order, '2');
  });

  test('folded description (>) is unwrapped and continuation lines joined', () => {
    const meta = srv.parseAgentFrontmatter('---\ndescription: > \n  line one\n  line two\nname: x\n---\n');
    assert.strictEqual(meta.description, 'line one line two');
    assert.strictEqual(meta.name, 'x');
  });

  test('nested capabilities/routines/prompts blocks are skipped by the scalar parser', () => {
    const content = '---\nname: x\ncapabilities:\n  does: things\nroutines:\n  - name: r1\n    schedule: every day at 09:00\ntype: specialist\n---\n';
    const meta = srv.parseAgentFrontmatter(content);
    assert.strictEqual(meta.name, 'x');
    assert.strictEqual(meta.type, 'specialist');
    assert.strictEqual(meta.capabilities, undefined);
  });

  test('no frontmatter returns empty object', () => {
    assert.deepStrictEqual(srv.parseAgentFrontmatter('just a body'), {});
  });

  test('pinned as-is: CRLF frontmatter is invisible to the \\n-only regex (callers must normalise first)', () => {
    const crlf = '---\r\nname: x\r\ntype: specialist\r\n---\r\nbody';
    assert.deepStrictEqual(srv.parseAgentFrontmatter(crlf), {});
    // and the documented fix: readNormalisedFile normalises at the read boundary
    const dir = makeWorkspace({});
    const p = path.join(dir, 'crlf.md');
    fs.writeFileSync(p, crlf);
    const normalised = srv.readNormalisedFile(p);
    assert.strictEqual(srv.parseAgentFrontmatter(normalised).name, 'x');
  });
});

describe('nested frontmatter block parsers', () => {
  const fm = [
    'name: penn',
    'capabilities:',
    '  does: Writes hooks and drafts',
    '  connectors: Notion, AuthoredUp',
    'routines:',
    '  - name: morning-digest',
    '    schedule: every day at 08:00',
    '    prompt: Run the digest',
    '  - name: weekly-review',
    '    schedule: every friday at 16:00',
    '    prompt: Review the week',
    'prompts:',
    '  - "Write me a hook"',
    '  - Audit this post',
    'skills:',
    '  - linkedin-hook-generator',
    '  - content-linter',
  ].join('\n');

  test('parseCapabilities extracts the key/value block', () => {
    assert.deepStrictEqual(srv.parseCapabilities(fm), {
      does: 'Writes hooks and drafts',
      connectors: 'Notion, AuthoredUp',
    });
    assert.strictEqual(srv.parseCapabilities('name: x'), null);
  });

  test('parseRoutines extracts each routine with fields', () => {
    const routines = srv.parseRoutines(fm);
    assert.strictEqual(routines.length, 2);
    assert.deepStrictEqual(routines[0], { name: 'morning-digest', schedule: 'every day at 08:00', prompt: 'Run the digest' });
    assert.strictEqual(routines[1].name, 'weekly-review');
    assert.deepStrictEqual(srv.parseRoutines('name: x'), []);
  });

  test('parsePrompts extracts quoted and bare prompts', () => {
    assert.deepStrictEqual(srv.parsePrompts(fm), ['Write me a hook', 'Audit this post']);
  });

  test('parseSkills extracts skill slugs', () => {
    assert.deepStrictEqual(srv.parseSkills(fm), ['linkedin-hook-generator', 'content-linter']);
  });
});

describe('discoverAgents', () => {
  test('no workspace selected: returns [] instead of throwing (latent /api/agents crash)', () => {
    srv.setWorkspace(null);
    let result;
    assert.doesNotThrow(() => { result = srv.discoverAgents(); },
      'discoverAgents must not throw path.join(null,…) before a workspace is picked');
    assert.deepStrictEqual(result, []);
  });

  test('standard team: statuses, ordering, injected Doc', () => {
    useWorkspace({ agents: standardTeam() });
    const agents = srv.discoverAgents();
    const ids = agents.map(a => a.id);
    // orchestrator first, then by order; injected platform Doc present
    assert.strictEqual(agents[0].id, 'chief-of-staff');
    assert.strictEqual(agents[0].type, 'orchestrator');
    assert.ok(ids.includes('content-lead'));
    assert.ok(ids.includes('rundock-guide'), 'built-in Doc injected when no platform agent on disk');
    const doc = agents.find(a => a.id === 'rundock-guide');
    assert.strictEqual(doc.type, 'platform');
    assert.strictEqual(doc.displayName, 'Doc');
    for (const a of agents) {
      if (a.id !== 'rundock-guide') assert.strictEqual(a.status, 'onTeam');
    }
  });

  test('three-state detection: order -> onTeam, type only -> available, neither -> raw', () => {
    useWorkspace({
      agents: {
        onteam: agentFile({ name: 'onteam', type: 'specialist', order: 1 }),
        avail: agentFile({ name: 'avail', type: 'specialist' }),
        raw: '---\nname: raw\n---\nJust a bare Claude Code agent.\n',
      },
    });
    const agents = srv.discoverAgents();
    assert.strictEqual(agents.find(a => a.id === 'onteam').status, 'onTeam');
    assert.strictEqual(agents.find(a => a.id === 'avail').status, 'available');
    assert.strictEqual(agents.find(a => a.id === 'raw').status, 'raw');
    // sort: onTeam < available < raw
    const statuses = agents.filter(a => a.id !== 'rundock-guide').map(a => a.status);
    assert.deepStrictEqual(statuses, ['onTeam', 'available', 'raw']);
  });

  test('order: 0 marks the default agent and CLAUDE.md instructions are merged', () => {
    useWorkspace({
      agents: { lead: agentFile({ name: 'team-lead', displayName: 'Lead', type: 'orchestrator', order: 0 }) },
      claudeMd: '# My Workspace\n\nWorkspace instructions here.',
    });
    const agents = srv.discoverAgents();
    const def = agents.find(a => a.isDefault);
    assert.ok(def, 'order 0 agent is the default');
    assert.strictEqual(def.id, 'default');
    assert.strictEqual(def.name, 'team-lead');
    assert.ok(def.instructions.includes('Workspace instructions here'));
  });

  test('no agent files: default agent synthesised from CLAUDE.md heading', () => {
    useWorkspace({ claudeMd: '# Dex - Your Chief of Staff\n\nHello.' });
    const agents = srv.discoverAgents();
    const def = agents.find(a => a.isDefault);
    assert.ok(def);
    assert.strictEqual(def.displayName, 'Dex');
    assert.strictEqual(def.model, 'sonnet');
  });

  test('model falls back to sonnet; explicit model respected', () => {
    useWorkspace({
      agents: {
        fast: agentFile({ name: 'fast', type: 'specialist', order: 1, model: 'haiku' }),
        plain: agentFile({ name: 'plain', type: 'specialist', order: 2 }),
      },
    });
    const agents = srv.discoverAgents();
    assert.strictEqual(agents.find(a => a.id === 'fast').model, 'haiku');
    assert.strictEqual(agents.find(a => a.id === 'plain').model, 'sonnet');
  });

  test('CRLF agent file on disk parses correctly (readNormalisedFile at the boundary)', () => {
    const lf = agentFile({ name: 'windows-agent', displayName: 'Win', role: 'CRLF Test', type: 'specialist', order: 1 });
    useWorkspace({ agents: { 'windows-agent': lf.replace(/\n/g, '\r\n') } });
    const agents = srv.discoverAgents();
    const win = agents.find(a => a.id === 'windows-agent');
    assert.ok(win, 'agent discovered');
    assert.strictEqual(win.displayName, 'Win');
    assert.strictEqual(win.status, 'onTeam');
    assert.ok(win.instructions.includes('You are Win'), 'body extracted despite CRLF');
  });

  test('agent cache: repeat call within TTL returns same array; invalidateAgentCache forces re-read', () => {
    const dir = useWorkspace({ agents: standardTeam() });
    const first = srv.discoverAgents();
    assert.strictEqual(srv.discoverAgents(), first, 'cached instance');
    fs.writeFileSync(path.join(dir, '.claude', 'agents', 'newbie.md'),
      agentFile({ name: 'newbie', type: 'specialist', order: 9 }));
    assert.strictEqual(srv.discoverAgents(), first, 'still cached');
    srv.invalidateAgentCache();
    const fresh = srv.discoverAgents();
    assert.ok(fresh.find(a => a.id === 'newbie'), 'cache invalidation picks up new file');
  });

  test('rundock-guide.md on disk with platform type suppresses the built-in injection', () => {
    useWorkspace({
      agents: {
        ...standardTeam(),
        'rundock-guide': agentFile({ name: 'rundock-guide', displayName: 'Doc', role: 'Platform Guide', type: 'platform', order: 99 }),
      },
    });
    const agents = srv.discoverAgents();
    const docs = agents.filter(a => a.id === 'rundock-guide');
    assert.strictEqual(docs.length, 1, 'exactly one Doc');
    assert.ok(docs[0].fileName, 'the file-based Doc, not the injected fallback');
  });
});

describe('parseSkillFile / discoverSkills', () => {
  test('parseSkillFile: explicit name, single-line description', () => {
    const parsed = srv.parseSkillFile('---\nname: My Skill\ndescription: Does things\n---\nbody', 'my-skill');
    assert.deepStrictEqual(parsed, { displayName: 'My Skill', description: 'Does things' });
  });

  test('parseSkillFile: multi-line folded description', () => {
    const parsed = srv.parseSkillFile('---\ndescription: >\n  first line\n  second line\n---\n', 'my-skill');
    assert.strictEqual(parsed.description, 'first line second line');
  });

  test('parseSkillFile: slug fallback gets brand-cased title', () => {
    const parsed = srv.parseSkillFile('no frontmatter', 'linkedin-hook-generator');
    assert.strictEqual(parsed.displayName, 'LinkedIn Hook Generator');
    assert.strictEqual(srv.parseSkillFile('x', 'mcp-api-notion').displayName, 'MCP API Notion');
  });

  test('discoverSkills: explicit frontmatter assignment plus body-scan fallback', () => {
    useWorkspace({
      agents: {
        'content-lead': agentFile({
          name: 'content-lead', displayName: 'Penn', type: 'specialist', order: 1,
          skills: ['hook-generator'],
          body: 'You are Penn. Use the content-linter before publishing.',
        }),
        'lead-designer': agentFile({
          name: 'lead-designer', displayName: 'Des', type: 'specialist', order: 2,
          body: 'You are Des. No skill references here.',
        }),
      },
      skills: {
        'hook-generator': '---\nname: Hook Generator\ndescription: Makes hooks\n---\nbody',
        'content-linter': '---\ndescription: Lints content\n---\nbody',
        'unused-skill': '---\ndescription: Nobody uses this\n---\nbody',
      },
    });
    const skills = srv.discoverSkills();
    const bySlug = Object.fromEntries(skills.map(s => [s.slug, s]));
    assert.deepStrictEqual(bySlug['hook-generator'].assignedAgents.map(a => a.id), ['content-lead'], 'explicit frontmatter assignment');
    assert.deepStrictEqual(bySlug['content-linter'].assignedAgents.map(a => a.id), ['content-lead'], 'body-scan fallback');
    assert.strictEqual(bySlug['unused-skill'].status, 'unassigned');
    assert.strictEqual(bySlug['hook-generator'].status, 'assigned');
  });

  test('discoverSkills: rundock-* skills only assign to platform agents and vice versa', () => {
    useWorkspace({
      agents: {
        'content-lead': agentFile({
          name: 'content-lead', displayName: 'Penn', type: 'specialist', order: 1,
          body: 'Penn mentions rundock-agents and hook-generator in the body.',
        }),
        'rundock-guide': agentFile({
          name: 'rundock-guide', displayName: 'Doc', type: 'platform', order: 99,
          body: 'Doc uses rundock-agents. Doc also mentions hook-generator.',
        }),
      },
      skills: {
        'rundock-agents': '---\ndescription: Agent CRUD\n---\nbody',
        'hook-generator': '---\ndescription: Hooks\n---\nbody',
      },
    });
    const skills = srv.discoverSkills();
    const bySlug = Object.fromEntries(skills.map(s => [s.slug, s]));
    assert.deepStrictEqual(bySlug['rundock-agents'].assignedAgents.map(a => a.id), ['rundock-guide']);
    assert.deepStrictEqual(bySlug['hook-generator'].assignedAgents.map(a => a.id), ['content-lead']);
  });
});

describe('rosters and system prompt', () => {
  test('buildTeamRoster: orchestrator sees direct reports, not grand-reports', () => {
    useWorkspace({ agents: standardTeam() });
    const roster = srv.buildTeamRoster('chief-of-staff', true);
    assert.ok(roster.includes('Penn (content-lead)'));
    assert.ok(roster.includes('Des (lead-designer)'));
    assert.ok(!roster.includes('Ana'), 'Ana reports to Penn, not Cos');
  });

  test('buildTeamRoster: lead sees own direct report; agent with none gets null', () => {
    useWorkspace({ agents: standardTeam() });
    assert.ok(srv.buildTeamRoster('content-lead', true).includes('Ana (content-analyst)'));
    assert.strictEqual(srv.buildTeamRoster('lead-designer', true), null);
  });

  test('buildPeerRoster: lists every other onTeam agent with self-description', () => {
    useWorkspace({ agents: standardTeam() });
    const roster = srv.buildPeerRoster('lead-designer');
    assert.ok(roster.includes('Penn (content-lead)'));
    assert.ok(roster.includes('You are Penn, the content lead.'));
    assert.ok(!roster.includes('Des (lead-designer)'), 'self excluded');
  });

  test('extractSelfDescription: first non-heading paragraph, then description, then capabilities.does', () => {
    assert.strictEqual(srv.extractSelfDescription({ instructions: '# Heading\n\nFirst real paragraph.\n\nSecond.' }), 'First real paragraph.');
    assert.strictEqual(srv.extractSelfDescription({ instructions: '', description: 'Desc here' }), 'Desc here');
    assert.strictEqual(srv.extractSelfDescription({ capabilities: { does: 'Does things' } }), 'Does things');
    assert.strictEqual(srv.extractSelfDescription(null), '');
  });

  test('buildSystemPrompt: orchestrator gets DELEGATION section, specialist gets SCOPE BOUNDARY + teammates', () => {
    useWorkspace({ agents: standardTeam() });
    const agents = srv.discoverAgents();
    const orch = srv.buildSystemPrompt(agents.find(a => a.id === 'chief-of-staff'));
    assert.ok(orch.includes('DELEGATION (your primary job):'));
    assert.ok(orch.includes('YOUR TEAM:'));
    assert.ok(!orch.includes('SCOPE BOUNDARY:'));

    const lead = srv.buildSystemPrompt(agents.find(a => a.id === 'content-lead'));
    assert.ok(lead.includes('YOUR SUPPORT TEAM:'), 'lead with direct reports');
    assert.ok(lead.includes('SCOPE BOUNDARY:'));

    const plain = srv.buildSystemPrompt(agents.find(a => a.id === 'lead-designer'));
    assert.ok(plain.includes('YOUR TEAMMATES:'), 'plain specialist gets peer roster');
    assert.ok(plain.includes('SCOPE BOUNDARY:'));
    assert.ok(plain.includes('<!-- RUNDOCK:RETURN -->'));
  });

  test('buildSystemPrompt: self-description is runtime-neutral (a Codex agent must not say "powered by Claude Code")', () => {
    // Live finding: the base rules described Rundock as "powered by Claude
    // Code" and a Codex agent said it verbatim. The identity line now names
    // both runtimes and no agent claims a single one.
    useWorkspace({ agents: standardTeam() });
    const prompt = srv.buildSystemPrompt(srv.discoverAgents().find(a => a.id === 'content-lead'));
    assert.ok(!prompt.includes('powered by Claude Code'), 'single-runtime claim removed');
    assert.ok(prompt.includes('Claude Code') && prompt.includes('Codex'), 'both runtimes named');
  });

  test('buildSystemPrompt: injects the concrete review-annotation handle instead of a derivation rule', () => {
    // Live finding: "by: <your agent name, lowercase>" parsed differently on
    // GPT-5 (it wrote its ROLE). The concrete handle is now injected.
    useWorkspace({ agents: standardTeam() });
    const agents = srv.discoverAgents();
    const penn = srv.buildSystemPrompt(agents.find(a => a.id === 'content-lead'));
    assert.ok(penn.includes('Your review-annotation handle is: penn'), 'concrete handle stated');
    assert.ok(penn.includes('by: penn'), 'metadata example uses the concrete handle');
    assert.ok(!penn.includes('<your agent name'), 'derivation placeholder removed');
    // displayName lowercased is the handle convention Claude agents settled on
    const des = srv.buildSystemPrompt(agents.find(a => a.id === 'lead-designer'));
    assert.ok(des.includes('Your review-annotation handle is: des'));
  });

  test('buildSystemPrompt: knowledge mode text by default, code mode when state says so', () => {
    const dir = useWorkspace({ agents: standardTeam() });
    const agents = srv.discoverAgents();
    const knowledge = srv.buildSystemPrompt(agents[0]);
    assert.ok(knowledge.includes('knowledge management platform'));
    fs.mkdirSync(path.join(dir, '.rundock'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.rundock', 'state.json'), JSON.stringify({ workspaceMode: 'code' }));
    const code = srv.buildSystemPrompt(agents[0]);
    assert.ok(code.includes('Code mode'));
  });
});

describe('findDirectReportMatch', () => {
  test('subagent_type exact match on name wins', () => {
    useWorkspace({ agents: standardTeam() });
    const match = srv.findDirectReportMatch('chief-of-staff', { subagent_type: 'content-lead', prompt: 'anything' });
    assert.strictEqual(match.id, 'content-lead');
  });

  test('prompt word-boundary match on name and displayName', () => {
    useWorkspace({ agents: standardTeam() });
    assert.strictEqual(srv.findDirectReportMatch('chief-of-staff', { prompt: 'Ask Penn for hooks' }).id, 'content-lead');
    assert.strictEqual(srv.findDirectReportMatch('chief-of-staff', { prompt: 'ask content-lead for hooks' }).id, 'content-lead');
    // word boundary: "Penny" must not match "Penn"... but \b treats the regex
    // as penn\b so "Penny" fails, pinned:
    assert.strictEqual(srv.findDirectReportMatch('chief-of-staff', { prompt: 'ask Penny the pig' }), null);
  });

  test('no direct reports or no match returns null', () => {
    useWorkspace({ agents: standardTeam() });
    assert.strictEqual(srv.findDirectReportMatch('lead-designer', { prompt: 'ask Penn' }), null, 'Des has no reports');
    assert.strictEqual(srv.findDirectReportMatch('chief-of-staff', { prompt: 'search the web' }), null);
  });

  test('orchestrator also matches platform agents as direct reports', () => {
    useWorkspace({
      agents: {
        ...standardTeam(),
        'rundock-guide': agentFile({ name: 'rundock-guide', displayName: 'Doc', type: 'platform', order: 99 }),
      },
    });
    const match = srv.findDirectReportMatch('chief-of-staff', { subagent_type: 'rundock-guide', prompt: 'make an agent' });
    assert.strictEqual(match.id, 'rundock-guide');
  });

  test('an unmatched explicit subagent_type does not fall through to the prompt scan', () => {
    // Post-fix: an Agent call explicitly targeting "general-purpose" is NOT
    // hijacked to a teammate merely named in the prompt. Regression companion
    // in regression.test.js.
    useWorkspace({ agents: standardTeam() });
    const match = srv.findDirectReportMatch('chief-of-staff', {
      subagent_type: 'general-purpose',
      prompt: "Search the vault for Penn's content stats",
    });
    assert.strictEqual(match, null, 'explicit general-purpose call must not be hijacked');
  });

  test('lead intercepts its own direct report by name in prompt', () => {
    useWorkspace({ agents: standardTeam() });
    assert.strictEqual(srv.findDirectReportMatch('content-lead', { prompt: 'Ana, check the numbers' }).id, 'content-analyst');
  });

  test('subagent_type given as displayName matches the teammate', () => {
    // "Penn" is content-lead's displayName. Pre-fix, subagent_type was matched
    // only against name/id case-sensitively, so a displayName address returned
    // null and the delegation degraded to a generic Task.
    useWorkspace({ agents: standardTeam() });
    const match = srv.findDirectReportMatch('chief-of-staff', { subagent_type: 'Penn', prompt: 'write hooks' });
    assert.ok(match, 'displayName address must resolve to a teammate');
    assert.strictEqual(match.id, 'content-lead');
  });

  test('subagent_type with wrong case matches the teammate', () => {
    // A case-mismatched slug ("Content-Lead") must still resolve. Pre-fix the
    // strict `dr.name === subagent_type` returned null.
    useWorkspace({ agents: standardTeam() });
    assert.strictEqual(srv.findDirectReportMatch('chief-of-staff', { subagent_type: 'Content-Lead', prompt: 'x' }).id, 'content-lead');
    assert.strictEqual(srv.findDirectReportMatch('chief-of-staff', { subagent_type: 'PENN', prompt: 'x' }).id, 'content-lead');
  });

  test('general-purpose / unknown subagent_type still returns null', () => {
    useWorkspace({ agents: standardTeam() });
    assert.strictEqual(srv.findDirectReportMatch('chief-of-staff', { subagent_type: 'general-purpose', prompt: 'ask Penn' }), null);
    assert.strictEqual(srv.findDirectReportMatch('chief-of-staff', { subagent_type: 'no-such-agent', prompt: 'ask Penn' }), null);
  });
});

describe('findOffRosterWorkspaceMatch', () => {
  // The impersonation gap: an Agent tool call explicitly naming a workspace
  // agent OUTSIDE the caller's direct reports used to fall through silently,
  // and Claude Code spawned a generic subagent wearing that agent's name.
  // For runtime: codex agents this silently bypassed the runtime choice.
  test('explicit subagent_type naming an off-roster workspace agent matches', () => {
    useWorkspace({ agents: standardTeam() });
    // Des reports to chief-of-staff, not to Penn.
    const byName = srv.findOffRosterWorkspaceMatch('content-lead', { subagent_type: 'lead-designer', prompt: 'design this' });
    assert.strictEqual(byName.id, 'lead-designer');
    const byDisplay = srv.findOffRosterWorkspaceMatch('content-lead', { subagent_type: 'Des', prompt: 'design this' });
    assert.strictEqual(byDisplay.id, 'lead-designer');
  });

  test('direct reports are not claimed (the interception path owns them)', () => {
    useWorkspace({ agents: standardTeam() });
    assert.strictEqual(srv.findOffRosterWorkspaceMatch('chief-of-staff', { subagent_type: 'content-lead', prompt: 'x' }), null);
    assert.strictEqual(srv.findOffRosterWorkspaceMatch('content-lead', { subagent_type: 'content-analyst', prompt: 'x' }), null);
  });

  test('built-in and unknown subagent types pass through untouched', () => {
    useWorkspace({ agents: standardTeam() });
    assert.strictEqual(srv.findOffRosterWorkspaceMatch('content-lead', { subagent_type: 'general-purpose', prompt: 'search files' }), null);
    assert.strictEqual(srv.findOffRosterWorkspaceMatch('content-lead', { subagent_type: 'Explore', prompt: 'x' }), null);
  });

  test('prompt-only mentions of off-roster agents never match (explicit path only)', () => {
    useWorkspace({ agents: standardTeam() });
    assert.strictEqual(srv.findOffRosterWorkspaceMatch('content-lead', { prompt: 'Review what Des produced last week' }), null);
    assert.strictEqual(srv.findOffRosterWorkspaceMatch('content-lead', { subagent_type: 'general-purpose', prompt: 'Review what lead-designer produced' }), null);
  });

  test('the caller itself never matches', () => {
    useWorkspace({ agents: standardTeam() });
    assert.strictEqual(srv.findOffRosterWorkspaceMatch('content-lead', { subagent_type: 'content-lead', prompt: 'x' }), null);
    assert.strictEqual(srv.findOffRosterWorkspaceMatch('content-lead', { subagent_type: 'Penn', prompt: 'x' }), null);
  });
});

describe('agent runtime field', () => {
  test('runtime: codex is parsed onto the agent; model stays unset unless frontmatter sets one', () => {
    useWorkspace({ agents: {
      'researcher': agentFile({ name: 'researcher', type: 'specialist', order: 2, runtime: 'codex' }),
    } });
    srv.invalidateAgentCache();
    const a = srv.discoverAgents().find(x => x.id === 'researcher');
    assert.strictEqual(a.runtime, 'codex');
    // Codex applies its own default model; the Claude default must not leak in.
    assert.strictEqual(a.model, null);
  });

  test('runtime: codex with an explicit model keeps that model', () => {
    useWorkspace({ agents: {
      'researcher': agentFile({ name: 'researcher', type: 'specialist', order: 2, runtime: 'codex', model: 'gpt-5.3-codex' }),
    } });
    srv.invalidateAgentCache();
    const a = srv.discoverAgents().find(x => x.id === 'researcher');
    assert.strictEqual(a.runtime, 'codex');
    assert.strictEqual(a.model, 'gpt-5.3-codex');
  });

  test('absent runtime means claude: existing agent files see no behaviour change', () => {
    useWorkspace({ agents: {
      'writer': agentFile({ name: 'writer', type: 'specialist', order: 2 }),
    } });
    srv.invalidateAgentCache();
    const a = srv.discoverAgents().find(x => x.id === 'writer');
    assert.strictEqual(a.runtime, 'claude');
    assert.strictEqual(a.model, 'sonnet');
  });

  test('unknown runtime values fall back to claude (a typo never strands an agent)', () => {
    useWorkspace({ agents: {
      'writer': agentFile({ name: 'writer', type: 'specialist', order: 2, runtime: 'gemini' }),
    } });
    srv.invalidateAgentCache();
    const a = srv.discoverAgents().find(x => x.id === 'writer');
    assert.strictEqual(a.runtime, 'claude');
    assert.strictEqual(a.model, 'sonnet');
  });
});
