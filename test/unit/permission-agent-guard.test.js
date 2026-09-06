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

// MEASURED, NOT ASSUMED. Writes were attempted through the runtime at eight
// paths under `~/.claude` and the result read back from the transcript and
// from whether the file existed afterwards, rather than from what a model said
// had happened. Every one came back "which is a sensitive file" and none was
// written. A file in the home directory but OUTSIDE `.claude` came back with
// the ordinary "you haven't granted it yet".
//
// So Rundock cannot approve past the runtime for these paths, and the card it
// used to show carried "Approve" and "Approve always" for writes that could
// never land: the user approved, the runtime refused anyway, and the card was
// taught to mean nothing. Refusing costs no capability, because none of these
// writes could succeed either way.
//
// SCOPED TO THE PERSISTENCE TIER. The secrets tier keeps its card on every
// access, read and write, because that guarantee says nothing silences it and
// a write the runtime would refuse anyway is not reason to weaken it. Free
// scratch keeps no card at all, because Rundock promises nothing there.
describe('isRuntimeHomeSurfaceEdit', () => {
  const { isRuntimeHomeSurfaceEdit } = require('../../scripts/permission-hook.js');
  const home = os.homedir();

  test('refuses persistence-surface writes under the runtime home', () => {
    const denied = [
      ['Write', { file_path: path.join(home, '.claude', 'commands', 'eyeball-test.md') }],
      ['Write', { file_path: path.join(home, '.claude', 'hooks', 'pretool.sh') }],
      ['Edit', { file_path: path.join(home, '.claude', 'plugins', 'x', 'y.md') }],
      ['Write', { file_path: path.join(home, '.claude', 'settings.json') }],
    ];
    for (const [tool, input] of denied) {
      assert.strictEqual(isRuntimeHomeSurfaceEdit(tool, input), true, `${tool} ${JSON.stringify(input)}`);
    }
  });

  test('leaves the secrets tier, free scratch, reads and the workspace alone', () => {
    const allowed = [
      // THE SECRETS TIER STILL CARDS. Converting this into a refusal would
      // break the one guarantee that says no grant, mode or setting silences
      // that card, on a write the runtime refuses anyway.
      ['Write', { file_path: path.join(home, '.claude', '.credentials.json') }],
      ['Read', { file_path: path.join(home, '.claude', '.credentials.json') }],
      // Free scratch: Rundock offers no card, so there is no false promise.
      ['Write', { file_path: path.join(home, '.claude', 'projects', 'x.jsonl') }],
      ['Write', { file_path: path.join(home, '.claude', 'cache', 'x') }],
      // Reads of the surfaces are the capability the freeing tier gives.
      ['Read', { file_path: path.join(home, '.claude', 'commands', 'x.md') }],
      ['Bash', { command: 'ls ' + path.join(home, '.claude', 'commands') }],
      // EVERYTHING THE GUIDE OWNS. Agents, skills, routines, connectors and
      // their credentials all live in the workspace, never in the runtime
      // home, so none of them is touched by this refusal.
      ['Write', { file_path: '/tmp/ws/.claude/agents/doc.md' }],
      ['Write', { file_path: '/tmp/ws/.claude/skills/helper/SKILL.md' }],
      ['Write', { file_path: '/tmp/ws/.claude/commands/x.md' }],
      ['Write', { file_path: '/tmp/ws/.mcp.json' }],
      ['Write', { file_path: '/tmp/ws/.rundock/mcp-secrets.json' }],
      ['Write', { file_path: path.join(home, 'notes.md') }],
    ];
    for (const [tool, input] of allowed) {
      assert.strictEqual(isRuntimeHomeSurfaceEdit(tool, input), false, `${tool} ${JSON.stringify(input)}`);
    }
  });

  test('no secrets-registry path is also a persistence surface, which is what keeps the refusal off the secrets tier', () => {
    // The refusal above is scoped by isPersistenceSurface alone. That is only
    // safe while the two registries do not overlap: the moment a secret is
    // also a surface, a write to it would be refused instead of carded, and
    // the guarantee that nothing silences the credentials card would be gone
    // without a line changing anywhere near it. Asserted here so the addition
    // that broke it could not land quietly.
    const { SECRET_RELATIVE_PATHS, isPersistenceSurface } = require('../../scripts/permission-hook.js');
    assert.ok(SECRET_RELATIVE_PATHS.length > 0, 'the registry is not empty, or this proves nothing');
    for (const rel of SECRET_RELATIVE_PATHS) {
      assert.strictEqual(isPersistenceSurface(path.join(home, '.claude', rel), home), false,
        `${rel} is a secret, so it must not also be a persistence surface`);
    }
  });

  test('handles missing or malformed input without throwing', () => {
    assert.strictEqual(isRuntimeHomeSurfaceEdit('Write', null), false);
    assert.strictEqual(isRuntimeHomeSurfaceEdit('Write', {}), false);
    assert.strictEqual(isRuntimeHomeSurfaceEdit('Write', { file_path: 42 }), false);
    assert.strictEqual(isRuntimeHomeSurfaceEdit(undefined, undefined), false);
  });
});
