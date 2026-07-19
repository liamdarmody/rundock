'use strict';
// Characterization: analyzeWorkspace (the "Seven Signals" workspace analyzer).
// Real product logic that drives onboarding; exercised against fixtures.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');

const { _internal: srv } = require('../../server.js');
const { makeWorkspace, agentFile, cleanup } = require('../helpers/workspace.js');

after(cleanup);

function analyze(opts) {
  const dir = makeWorkspace(opts);
  srv.setWorkspace(dir);
  return { dir, analysis: srv.analyzeWorkspace(dir, srv.discoverAgents()) };
}

describe('analyzeWorkspace: Seven Signals', () => {
  test('Signal 1 identity: README heading + tagline win over CLAUDE.md and package.json', () => {
    const { analysis } = analyze({
      files: {
        'README.md': '# Dex by Dave: Your AI Chief of Staff\n\nA personal operating system.\n',
        'CLAUDE.md': '# Something\n\nYou are Alfred, a butler.\n',
        'package.json': '{"name":"dex-app","description":"the app"}',
      },
    });
    assert.strictEqual(analysis.identity.suggestedName, 'Dex');
    assert.strictEqual(analysis.identity.suggestedTagline, 'Your AI Chief of Staff');
    assert.strictEqual(analysis.identity.sources.length, 3);
  });

  test('Signal 1 identity: falls back to CLAUDE.md "You are X" then package.json name', () => {
    const claudeOnly = analyze({ files: { 'CLAUDE.md': '# W\n\nYou are Alfred, a butler.\n' } });
    assert.strictEqual(claudeOnly.analysis.identity.suggestedName, 'Alfred');
    const pkgOnly = analyze({ files: { 'package.json': '{"name":"jarvis-core"}' } });
    assert.strictEqual(pkgOnly.analysis.identity.suggestedName, 'Jarvis');
  });

  test('Signal 2 skills: grouped into keyword clusters with confidence and ungrouped bucket', () => {
    const { analysis } = analyze({
      skills: {
        'linkedin-hook-generator': '---\nname: Hook Generator\ndescription: Writes content hooks and post drafts\n---\nx',
        'granola-meeting-prep': '---\nname: Meeting Prep\ndescription: Prepares meeting agendas from attendee notes\n---\nx',
        'mystery-widget': '---\nname: Mystery\ndescription: does an unrelated thing\n---\nx',
      },
    });
    assert.strictEqual(analysis.skills.total, 3);
    const labels = analysis.skills.groups.map(g => g.label);
    assert.ok(labels.includes('Content & Writing'));
    assert.ok(labels.includes('Meetings & People'));
    assert.ok(analysis.skills.groups.find(g => g.label === 'Uncategorised').slugs.includes('mystery-widget'));
  });

  test('Signal 3 integrations: named MCP references, configured servers, known tool mentions', () => {
    const { analysis } = analyze({
      files: {
        'CLAUDE.md': '# W\n\nPull notes from the Granola MCP and check the Notion MCP. We use Todoist and Readwise too.\n',
        '.mcp.json': '{"mcpServers":{"notion":{},"todoist":{}}}',
      },
    });
    assert.ok(analysis.integrations.mcpReferences.some(m => m.name === 'Granola MCP'));
    assert.ok(analysis.integrations.mcpReferences.some(m => m.name === 'Notion MCP'));
    assert.deepStrictEqual(analysis.integrations.configuredServers.sort(), ['notion', 'todoist']);
    assert.ok(analysis.integrations.mentionedTools.includes('Todoist'));
    assert.ok(analysis.integrations.mentionedTools.includes('Readwise'));
  });

  test('Signal 4 structure: PARA + numbered pattern and key path detection', () => {
    const { analysis } = analyze({
      files: {
        '00_Projects/p.md': 'x', '01_Areas/a.md': 'x', '02_Resources/r.md': 'x',
        '03_Archive/z.md': 'x', '00_Inbox/i.md': 'x',
      },
    });
    assert.strictEqual(analysis.structure.pattern, 'para-numbered');
    assert.ok(analysis.structure.keyPaths.inbox);
    assert.ok(analysis.structure.keyPaths.projects);
    assert.ok(analysis.structure.hasClaudeDir === false || analysis.structure.hasClaudeDir === true);
  });

  test('Signal 4 structure: dev-project pattern from src/lib/test', () => {
    const { analysis } = analyze({ files: { 'src/a.js': 'x', 'lib/b.js': 'x', 'test/c.js': 'x' } });
    assert.strictEqual(analysis.structure.pattern, 'dev-project');
  });

  test('Signal 5 user profile: detects and reports populated fields', () => {
    const { analysis } = analyze({
      files: { 'user-profile.yaml': 'name: Alex\nrole: Product Leader\ncompany: Rundock\nemail: a@x.com\n' },
    });
    assert.strictEqual(analysis.userProfile.exists, true);
    assert.strictEqual(analysis.userProfile.populated, true);
    assert.strictEqual(analysis.userProfile.fields.name, 'Alex');
    assert.strictEqual(analysis.userProfile.fields.role, 'Product Leader');
  });

  test('Signal 6 hooks: classifies sound, context, and automation hooks', () => {
    const { analysis } = analyze({
      files: {
        '.claude/settings.json': JSON.stringify({
          hooks: {
            Stop: [{ hooks: [{ type: 'command', command: 'afplay /System/Library/Sounds/Glass.aiff' }] }],
            UserPromptSubmit: [{ matcher: '*', hooks: [{ type: 'command', command: 'node inject-context.js' }] }],
            SessionStart: [{ hooks: [{ type: 'command', command: 'python session-init.py' }] }],
          },
        }),
      },
    });
    assert.ok(analysis.hooks.present.includes('Stop'));
    assert.strictEqual(analysis.hooks.soundHooks.length, 1);
    assert.strictEqual(analysis.hooks.contextHooks.length, 1);
    assert.ok(analysis.hooks.automationHooks.length >= 1);
  });

  test('Signal 7 agents: counts on-team/available/raw and orchestrator presence', () => {
    const { analysis } = analyze({
      agents: {
        orch: agentFile({ name: 'orch', type: 'orchestrator', order: 1 }),
        spec: agentFile({ name: 'spec', type: 'specialist', order: 2 }),
        avail: agentFile({ name: 'avail', type: 'specialist' }),
        raw: '---\nname: raw\n---\nbare agent\n',
      },
    });
    assert.strictEqual(analysis.agents.hasOrchestrator, true);
    assert.ok(analysis.agents.onTeam >= 2);
    assert.ok(analysis.agents.available >= 1);
    assert.ok(analysis.agents.raw >= 1);
  });

  test('empty workspace: analysis returns structured defaults without throwing', () => {
    const { analysis } = analyze({});
    assert.ok(analysis.identity);
    assert.strictEqual(analysis.skills.total, 0);
    assert.strictEqual(analysis.structure.pattern, 'minimal');
  });
});
