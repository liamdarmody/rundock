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

  // The shape gained typed fields with the routine data model. A file that
  // declares none of them runs locally, is not paused, and has its owner
  // settled by the caller that knows which agent file this frontmatter came
  // from. It is NOT enabled: a block with no `enabled` key was written before
  // anything in Rundock could run it, so the upgrade that can run it does not
  // take that silence for consent.
  //
  // `timezone` is null here rather than the machine's zone, and this is the
  // whole-shape assertion that would notice a default arriving from anywhere:
  // a routine that never recorded a zone still has not recorded one.
  test('parseRoutines extracts each routine with fields, typed', () => {
    const routines = srv.parseRoutines(fm);
    assert.strictEqual(routines.length, 2);
    assert.deepStrictEqual(routines[0], {
      name: 'morning-digest',
      schedule: 'every day at 08:00',
      prompt: 'Run the digest',
      skill: null,
      runOn: 'local',
      timezone: null,
      owner: null,
      enabled: false,
      paused: false,
      planHash: null,
      // The approval record joined the shape: the hash that was approved,
      // beside the moment it was, absent on a file that has recorded neither.
      planApprovedHash: null,
      planApprovedAt: null,
    });
    assert.strictEqual(routines[1].name, 'weekly-review');
    assert.deepStrictEqual(srv.parseRoutines('name: x'), []);
  });

  test('parsePrompts extracts quoted and bare prompts', () => {
    assert.deepStrictEqual(srv.parsePrompts(fm), ['Write me a hook', 'Audit this post']);
  });

  test('parseSkills extracts skill slugs', () => {
    assert.deepStrictEqual(srv.parseSkills(fm), ['linkedin-hook-generator', 'content-linter']);
  });

  // The inline flow form is valid YAML that authors legitimately write, and
  // it silently parsed to [] for as long as the parser existed: the agent
  // looked correct to its author while Rundock saw no skills at all. The
  // failure was masked by the body-text fallback scan, so nothing ever
  // surfaced it. Same class: block lists indented with four spaces or tabs.
  test('parseSkills reads the inline flow form', () => {
    assert.deepStrictEqual(srv.parseSkills('skills: [alpha, beta]'), ['alpha', 'beta']);
    assert.deepStrictEqual(srv.parseSkills('skills: ["alpha", \'beta-two\']'), ['alpha', 'beta-two']);
    assert.deepStrictEqual(srv.parseSkills('skills: []'), []);
  });

  test('parseSkills reads block lists at any indent', () => {
    assert.deepStrictEqual(srv.parseSkills('skills:\n    - four-space\n    - indent'), ['four-space', 'indent']);
    assert.deepStrictEqual(srv.parseSkills('skills:\n\t- tab\n\t- indent'), ['tab', 'indent']);
  });

  test('parseSkills only matches the top-level skills key', () => {
    assert.deepStrictEqual(srv.parseSkills('other-skills:\n  - nope'), []);
    assert.deepStrictEqual(srv.parseSkills('meta:\n  skills: [nested]'), []);
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

  test('order: 0 marks the default agent; CLAUDE.md fills in ONLY when the file has no body', () => {
    // Live incident (0.11.6 pre-publish testing): the old code REPLACED the
    // default agent's authored body with CLAUDE.md, so a freshly scaffolded
    // Cos showed 279 bytes of workspace boilerplate as its instructions and
    // none of the file Doc actually wrote. The file's body wins when it
    // exists; CLAUDE.md remains the source for body-less stubs (and the
    // synthesised no-file default below), which was the merge's original
    // purpose. The runtime is unaffected either way: it loads the agent file
    // and CLAUDE.md separately.
    // Raw file: agentFile() always writes a default body, and this arm needs
    // a genuinely body-less stub.
    useWorkspace({
      agents: { lead: '---\nname: team-lead\ndisplayName: Lead\ntype: orchestrator\norder: 0\n---\n' },
      claudeMd: '# My Workspace\n\nWorkspace instructions here.',
    });
    let def = srv.discoverAgents().find(a => a.isDefault);
    assert.ok(def, 'order 0 agent is the default');
    assert.strictEqual(def.id, 'default');
    assert.strictEqual(def.name, 'team-lead');
    assert.ok(def.instructions.includes('Workspace instructions here'), 'body-less stub: CLAUDE.md fills in');

    useWorkspace({
      agents: { lead: agentFile({ name: 'team-lead', displayName: 'Lead', type: 'orchestrator', order: 0,
        body: 'You are Lead.\n\n## Responsibilities\n\nRun the whole team end to end.' }) },
      claudeMd: '# My Workspace\n\nWorkspace instructions here.',
    });
    def = srv.discoverAgents().find(a => a.isDefault);
    assert.ok(def.instructions.includes('Run the whole team end to end'), 'authored body is the instructions');
    assert.ok(!def.instructions.includes('Workspace instructions here'), 'CLAUDE.md must not replace an authored body');
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

  test('body-text skill matching survives a CRLF checkout', () => {
    // Every other read in discovery goes through readNormalisedFile. The body
    // read for this second pass did not, and matched frontmatter with a
    // newline-only pattern, so on a Windows checkout the match failed, the
    // body came back empty, and body-text matching silently assigned nothing.
    // Explicit `skills:` entries kept working, which is what made it invisible:
    // a Windows contributor sees half the mechanism work and no error at all.
    useWorkspace({
      agents: {
        'content-lead': agentFile({
          name: 'content-lead', displayName: 'Penn', type: 'specialist', order: 1,
          body: 'Penn reaches for content-linter when a draft needs checking.',
        }).replace(/\n/g, '\r\n'),
      },
      skills: {
        'content-linter': '---\ndescription: Lints content\n---\nbody',
      },
    });
    const bySlug = Object.fromEntries(srv.discoverSkills().map(s => [s.slug, s]));
    assert.deepStrictEqual(bySlug['content-linter'].assignedAgents.map(a => a.id), ['content-lead']);
    assert.strictEqual(bySlug['content-linter'].status, 'assigned');
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

  test('a Doc scaffolded after the cache was primed still owns the platform skills', () => {
    // Regression: on opening a workspace that needs Doc scaffolded in,
    // discoverAgents was called (and cached) before scaffoldWorkspace created
    // Doc, and nothing invalidated the cache afterwards. discoverSkills then
    // read stale agents without Doc, so the rundock-* platform skills showed
    // as "Available to all agents" instead of owned by Doc until a reload.
    const dir = useWorkspace({ agents: {} });
    srv.discoverAgents();          // primes the cache with no Doc present
    srv.scaffoldWorkspace(dir);    // writes the real Doc and rundock-* skills
    const skills = srv.discoverSkills();
    const bySlug = Object.fromEntries(skills.map(s => [s.slug, s]));
    for (const slug of ['rundock-agents', 'rundock-skills', 'rundock-workspace']) {
      assert.ok(bySlug[slug], `${slug} discovered`);
      assert.strictEqual(bySlug[slug].status, 'assigned', `${slug} is assigned, not left to all agents`);
      assert.deepStrictEqual(bySlug[slug].assignedAgents.map(a => a.name), ['Doc'], `${slug} owned by Doc`);
    }
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
    // Code" and a Codex agent said it verbatim. The identity line then named
    // both runtimes as the first fix; the decided positioning goes further
    // and names neither, so no agent can claim a single one and the
    // description stays in the user's language. Runtime detail routes to
    // Doc and the docs.
    useWorkspace({ agents: standardTeam() });
    const prompt = srv.buildSystemPrompt(srv.discoverAgents().find(a => a.id === 'content-lead'));
    assert.ok(!prompt.includes('powered by Claude Code'), 'single-runtime claim removed');
    assert.ok(prompt.includes('AI team workspace'), 'the decided self-description is present');
    assert.ok(!prompt.includes('Claude Code') && !prompt.includes('Codex'), 'no runtime named in the shared identity');
  });

  test('buildSystemPrompt: agents are told the truth about missing connectors', () => {
    // Live finding (issue #70): when a connector's authorisation lapses, its
    // tools are silently absent and the agent improvises an explanation. One
    // user was sent hunting for "Rundock connector settings", which do not
    // exist. The base rules now state the honest cause and the terminal-free
    // fix. Phrased runtime-neutrally: the neutrality test below must keep
    // passing, and a Codex agent's connectors are not Claude Code's anyway.
    useWorkspace({ agents: standardTeam() });
    const prompt = srv.buildSystemPrompt(srv.discoverAgents().find(a => a.id === 'content-lead'));
    assert.ok(prompt.includes('Rundock has no connector settings'), 'the non-existent settings are ruled out');
    assert.ok(prompt.includes('claude.ai'), 'points at where connectors are actually managed');
    assert.ok(prompt.includes('Never invent Rundock settings'), 'the hallucination is named and forbidden');
  });

  test('buildSystemPrompt: a lead with direct reports gets the sequential-delegation rule, same as the orchestrator', () => {
    // Bug A1 (handback integrity spec): the 0.8.5 sequential rule was added
    // inside the orchestrator branch only. An agent with direct reports takes
    // the hasDirectReports branch, was never told, and promised the user
    // parallel execution the engine cannot deliver ("I'll get Ana on the
    // cadence question in parallel", conversation 2026-07-29).
    useWorkspace({ agents: standardTeam() });
    const agents = srv.discoverAgents();
    const orch = srv.buildSystemPrompt(agents.find(a => a.id === 'chief-of-staff'));
    const lead = srv.buildSystemPrompt(agents.find(a => a.id === 'content-lead'));
    assert.ok(orch.includes('Delegation is sequential'), 'orchestrator wording unchanged');
    assert.ok(lead.includes('Delegation is sequential'), 'lead with direct reports gets the rule');
    assert.ok(lead.includes('"in parallel"'), 'the forbidden claim is named for leads');
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
  test('orchestrators and platform agents always run on Claude Code, whatever their frontmatter says', () => {
    // Delegation works through the Agent tool in the Claude Code stream,
    // which Codex exec mode does not have: a Codex orchestrator would be
    // told to route with a tool that does not exist for it. The docs state
    // the rule; discovery enforces it.
    useWorkspace({ agents: {
      'boss': agentFile({ name: 'boss', type: 'orchestrator', order: 1, runtime: 'codex' }),
      'guide': agentFile({ name: 'guide', type: 'platform', order: 99, runtime: 'codex' }),
      'spec': agentFile({ name: 'spec', type: 'specialist', order: 2, reportsTo: 'boss', runtime: 'codex' }),
    } });
    srv.invalidateAgentCache();
    const agents = srv.discoverAgents();
    assert.strictEqual(agents.find(a => a.id === 'boss').runtime, 'claude', 'orchestrator forced to claude');
    assert.strictEqual(agents.find(a => a.id === 'guide').runtime, 'claude', 'platform agent forced to claude');
    assert.strictEqual(agents.find(a => a.id === 'boss').model, 'sonnet', 'forced-claude orchestrator gets the Claude default model, never null');
    assert.strictEqual(agents.find(a => a.id === 'spec').runtime, 'codex', 'specialists keep their declared runtime');
  });

  test('runtime value is case-insensitive: Codex/CODEX must not silently run on Claude', () => {
    // A silent runtime override is the same problem class as the off-roster
    // delegation guard: the user chose a runtime; casing must not undo it.
    useWorkspace({ agents: {
      'r1': agentFile({ name: 'r1', type: 'specialist', order: 2, runtime: 'Codex' }),
      'r2': agentFile({ name: 'r2', type: 'specialist', order: 3, runtime: 'CODEX' }),
      'r3': agentFile({ name: 'r3', type: 'specialist', order: 4 }),
    } });
    srv.invalidateAgentCache();
    const agents = srv.discoverAgents();
    assert.strictEqual(agents.find(a => a.id === 'r1').runtime, 'codex');
    assert.strictEqual(agents.find(a => a.id === 'r2').runtime, 'codex');
    assert.strictEqual(agents.find(a => a.id === 'r1').model, null, 'codex agents never inherit the Claude default model');
    assert.strictEqual(agents.find(a => a.id === 'r3').runtime, 'claude', 'absent runtime defaults to claude');
  });

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
