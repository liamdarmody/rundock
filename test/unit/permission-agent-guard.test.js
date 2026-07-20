'use strict';
// The permission hook deterministically denies direct file edits to the GLOBAL
// Claude Code agent/skill config (~/.claude/agents, ~/.claude/skills). Rundock
// never reads the global folder, so such an edit would silently succeed
// somewhere invisible to the app (the reported bug: an agent "updated" and
// nothing changed, surviving a restart). Workspace .claude edits, reads, and
// ordinary file edits are deliberately NOT blocked.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');

const { isProtectedClaudeEdit } = require('../../scripts/permission-hook.js');

const gAgent = path.join(os.homedir(), '.claude', 'agents', 'dev.md');
const gSkill = path.join(os.homedir(), '.claude', 'skills', 'spec-writer', 'SKILL.md');

describe('isProtectedClaudeEdit', () => {
  test('denies edits to the GLOBAL ~/.claude agents and skills', () => {
    const denied = [
      ['Write', { file_path: gAgent }],
      ['Edit', { file_path: gSkill }],
      ['MultiEdit', { file_path: path.join(os.homedir(), '.claude', 'agents', 'cos.md') }],
      ['NotebookEdit', { notebook_path: path.join(os.homedir(), '.claude', 'agents', 'x.md') }],
    ];
    for (const [tool, input] of denied) {
      assert.strictEqual(isProtectedClaudeEdit(tool, input), true, `${tool} ${JSON.stringify(input)}`);
    }
  });

  test('allows workspace .claude edits, other files, reads, and non-edit tools', () => {
    const allowed = [
      ['Write', { file_path: '/tmp/ws/.claude/agents/dev.md' }],   // workspace, not global home
      ['Edit', { file_path: '/tmp/ws/.claude/skills/x/SKILL.md' }], // workspace
      ['Write', { file_path: '/tmp/ws/notes/plan.md' }],
      ['Edit', { file_path: '/tmp/ws/CLAUDE.md' }],
      ['Write', { file_path: path.join(os.homedir(), '.claude', 'settings.json') }], // global .claude, but not agents/skills
      ['Bash', { command: 'cat ' + gAgent }],                       // a read via a non-edit tool
      ['Read', { file_path: gAgent }],
      ['Grep', { pattern: 'x', path: path.join(os.homedir(), '.claude', 'agents') }],
    ];
    for (const [tool, input] of allowed) {
      assert.strictEqual(isProtectedClaudeEdit(tool, input), false, `${tool} ${JSON.stringify(input)}`);
    }
  });

  test('handles missing or malformed input without throwing', () => {
    assert.strictEqual(isProtectedClaudeEdit('Write', null), false);
    assert.strictEqual(isProtectedClaudeEdit('Write', {}), false);
    assert.strictEqual(isProtectedClaudeEdit('Write', { file_path: 42 }), false);
    assert.strictEqual(isProtectedClaudeEdit(undefined, undefined), false);
  });
});
