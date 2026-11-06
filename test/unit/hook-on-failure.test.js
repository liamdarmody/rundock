'use strict';
// CLAUDE CODE BLOCKS THE CALL WHEN THE PERMISSION HOOK FAILS.
//
// A PreToolUse command hook that exits non-zero, is killed, passes its
// timeout, prints JSON that does not parse, or cannot start lets the tool call
// go ahead with every check skipped, unless its entry carries
// `"onFailure": "block"`, which Claude Code honours from 2.1.295. Every
// PreToolUse entry Rundock writes now carries it.
//
// The value is load-bearing in the other direction as well: on those versions
// any value other than "block" or "continue" makes Claude Code skip the whole
// settings file, the permission hook, the permissions and the sandbox block
// with it, and say nothing. So the value is one constant, the reconcile on
// open only ever writes that constant, and a settings file the reconcile
// cannot read is left as it is rather than rebuilt.
//
// Driven through scaffoldWorkspace, the reconcile every workspace open runs,
// against a real settings file on disk.
const { test, describe, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const scaffold = require('../../lib/workspace/scaffold.js');
const { makeTempDir } = require('../helpers/workspace.js');

const PRE_MATCHERS = ['Bash', 'Read|Write|Edit|MultiEdit|NotebookEdit|Glob|Grep', 'PowerShell', 'mcp__.*'];
const POST_MATCHER = 'Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit|mcp__.*';

let prevDeps;
beforeEach(() => { prevDeps = scaffold.wireScaffoldDeps({ invalidateAgentCache() {}, rebaselineAgentsWatcher() {} }); });
afterEach(() => { scaffold.wireScaffoldDeps(prevDeps); });

function workspace() {
  const dir = makeTempDir('hook-on-failure-');
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.rundock'), { recursive: true });
  return dir;
}
const settingsPath = (dir) => path.join(dir, '.claude', 'settings.local.json');
const bytes = (dir) => fs.readFileSync(settingsPath(dir), 'utf-8');
const read = (dir) => JSON.parse(bytes(dir));
const save = (dir, settings) => fs.writeFileSync(settingsPath(dir), JSON.stringify(settings, null, 2));
const open = (dir, platform = 'darwin') => scaffold.scaffoldWorkspace(dir, { platform });
const isOurs = (h) => !!h && typeof h.command === 'string' && h.command.includes('permission-hook');
const ourPre = (settings) => settings.hooks.PreToolUse.filter((e) => (e.hooks || []).some(isOurs));

// What a release before this one wrote: this release's file with no onFailure
// on any entry, because that field is the only thing this change adds to it.
function asAnEarlierReleaseWroteIt(dir) {
  const settings = read(dir);
  for (const e of settings.hooks.PreToolUse) for (const h of e.hooks) delete h.onFailure;
  save(dir, settings);
  return settings;
}

describe('every PreToolUse entry Rundock writes carries onFailure: "block"', () => {
  test('the value is one constant, and that constant is exactly the string "block"', () => {
    assert.strictEqual(scaffold.HOOK_ON_FAILURE, 'block');
  });

  test('a new workspace gets it on every PreToolUse entry, whatever platform it is written for', () => {
    for (const platform of ['darwin', 'linux', 'win32']) {
      const dir = workspace();
      open(dir, platform);
      const pre = read(dir).hooks.PreToolUse;
      assert.deepStrictEqual(pre.map((e) => e.matcher), PRE_MATCHERS, `${platform}: the four entries`);
      for (const e of pre) {
        assert.strictEqual(e.hooks.length, 1, `${platform} ${e.matcher}: one hook`);
        assert.strictEqual(e.hooks[0].onFailure, 'block', `${platform} ${e.matcher}: exactly "block"`);
      }
    }
  });
});

describe('the PostToolUse entries are unchanged: nothing is refused after a tool has run', () => {
  test('PostToolUse and PostToolUseFailure carry no onFailure, on a new workspace and after a repair', () => {
    const dir = workspace();
    open(dir);
    const command = read(dir).hooks.PreToolUse[0].hooks[0].command;
    const expected = [{ matcher: POST_MATCHER, hooks: [{ type: 'command', command, timeout: 10 }] }];
    for (const event of ['PostToolUse', 'PostToolUseFailure']) {
      assert.deepStrictEqual(read(dir).hooks[event].filter((e) => e.hooks.some(isOurs)), expected, `${event} on a new workspace`);
    }
    asAnEarlierReleaseWroteIt(dir);
    open(dir);
    for (const event of ['PostToolUse', 'PostToolUseFailure']) {
      assert.deepStrictEqual(read(dir).hooks[event].filter((e) => e.hooks.some(isOurs)), expected, `${event} after a repair`);
    }
  });
});

describe('the settings file still passes what it passed before', () => {
  test('the stale-entry cleanup still removes old permission-hook entries, and what replaces them carries the field', () => {
    const dir = workspace();
    save(dir, { hooks: { PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: '"/old/electron" "/old/asar/scripts/permission-hook.js"', timeout: 300 }] },
      { matcher: 'mcp__.*', hooks: [{ type: 'command', command: '"/old/electron" "/old/asar/scripts/permission-hook.js"', timeout: 300, onFailure: 'block' }] },
      { matcher: 'Write', hooks: [{ type: 'command', command: 'anything' }] },
      { matcher: 'Edit', hooks: [{ type: 'command', command: 'anything' }] },
    ] } });
    open(dir);
    const pre = read(dir).hooks.PreToolUse;
    assert.deepStrictEqual(pre.map((e) => e.matcher).sort(), [...PRE_MATCHERS].sort());
    for (const e of pre) {
      assert.ok(!e.hooks[0].command.includes('/old/'), `${e.matcher}: the stale command is gone`);
      assert.strictEqual(e.hooks[0].onFailure, 'block', `${e.matcher}: and its replacement carries the field`);
    }
  });
});

describe('the five sequences', () => {
  let home, closedPort;
  before(async () => {
    home = makeTempDir('hook-on-failure-home-');
    const s = http.createServer();
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    closedPort = s.address().port;
    await new Promise((r) => s.close(r));
  });

  // Runs the command a written entry registers, the way Claude Code runs it.
  function runRegistered(dir, command, toolName, toolInput) {
    const env = { ...process.env, HOME: home, RUNDOCK: '1', RUNDOCK_WORKSPACE: dir, RUNDOCK_PORT: String(closedPort), RUNDOCK_EXTRA_DIRS: '' };
    delete env.NODE_V8_COVERAGE;
    delete env.RUNDOCK_CODE_MODE;
    const input = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', cwd: dir, tool_name: toolName, tool_input: toolInput });
    const r = spawnSync('sh', ['-c', command], { input, env, encoding: 'utf-8', timeout: 60000 });
    return { status: r.status, answer: JSON.parse(r.stdout).hookSpecificOutput };
  }

  test('the inverse action: a hook that answers normally answers exactly as before, and only the field is new', { skip: process.platform === 'win32' }, () => {
    const dir = workspace();
    fs.writeFileSync(path.join(dir, 'notes.md'), 'hi\n');
    open(dir);
    const launcher = path.join(dir, '.rundock', 'permission-hook.sh');
    for (const e of read(dir).hooks.PreToolUse) {
      const { onFailure, ...rest } = e.hooks[0];
      assert.strictEqual(onFailure, 'block', `${e.matcher}: the field`);
      assert.deepStrictEqual(rest, { type: 'command', command: `sh "${launcher}"`, timeout: 300 },
        `${e.matcher}: everything else is the entry an earlier release wrote`);
    }
    const command = read(dir).hooks.PreToolUse[0].hooks[0].command;
    const allowed = runRegistered(dir, command, 'Read', { file_path: path.join(dir, 'notes.md') });
    assert.strictEqual(allowed.status, 0);
    assert.strictEqual(allowed.answer.permissionDecision, 'allow', 'an allow is still an allow');
    const refused = runRegistered(dir, command, 'Write', { file_path: path.join(home, '.rundock-console', 'x.command'), content: 'x' });
    assert.strictEqual(refused.status, 0, 'a refusal is an answer, not a failure');
    assert.strictEqual(refused.answer.permissionDecision, 'deny', 'a deny is still a deny');
    assert.ok(refused.answer.permissionDecisionReason.length > 0, 'with its reason');
  });
});
