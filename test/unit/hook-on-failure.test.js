'use strict';
// CLAUDE CODE BLOCKS THE CALL WHEN THE PERMISSION HOOK FAILS.
//
// A PreToolUse command hook that exits non-zero, is killed, passes its
// timeout, prints JSON that does not parse, or cannot start lets the tool call
// go ahead with every check skipped, unless its entry carries
// `"onFailure": "block"`, which Claude Code honors from 2.1.295. Every
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

// Every write the code under test makes to one file, counted, and still made.
function writesTo(file, fn) {
  const real = fs.writeFileSync;
  let count = 0;
  fs.writeFileSync = function (target, ...rest) {
    if (path.resolve(String(target)) === file) count++;
    return real.call(this, target, ...rest);
  };
  try { fn(); } finally { fs.writeFileSync = real; }
  return count;
}

// What the code under test said through console.warn, kept off the screen.
function warnings(fn) {
  const real = console.warn;
  const said = [];
  console.warn = (...args) => { said.push(args.join(' ')); };
  try { fn(); } finally { console.warn = real; }
  return said;
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

describe('the reconcile on open writes only "block", and only into an entry Rundock wrote', () => {
  test('a Rundock entry holding any other value, or none, is rewritten to "block" where it stands', () => {
    const wrong = ['continue', 'bogus', 'Block', 'block ', '', null, true, 0, ['block'], {}];
    for (const value of [...wrong, 'absent']) {
      const dir = workspace();
      open(dir);
      const settings = read(dir);
      for (const e of settings.hooks.PreToolUse) {
        if (value === 'absent') delete e.hooks[0].onFailure;
        else e.hooks[0].onFailure = value;
      }
      save(dir, settings);
      open(dir);
      const pre = read(dir).hooks.PreToolUse;
      assert.deepStrictEqual(pre.map((e) => e.matcher), PRE_MATCHERS, `${JSON.stringify(value)}: same entries, same order`);
      for (const e of pre) {
        assert.strictEqual(e.hooks[0].onFailure, 'block', `${JSON.stringify(value)} on ${e.matcher} is rewritten`);
      }
    }
  });

  test('an entry Rundock did not write is left exactly as it was, and so is a person\'s hook beside ours', () => {
    const dir = workspace();
    open(dir);
    const settings = read(dir);
    const command = settings.hooks.PreToolUse[0].hooks[0].command;
    const theirs = [
      // A person's own hook, with no field and with each value.
      { matcher: 'Bash', hooks: [{ type: 'command', command: './check.sh' }] },
      { matcher: 'Task', hooks: [{ type: 'command', command: './audit.sh', onFailure: 'continue' }] },
      { matcher: 'mcp__.*', hooks: [{ type: 'command', command: './log.sh', timeout: 5, onFailure: 'bogus' }] },
      // Rundock's own command, under a matcher Rundock never writes.
      { matcher: 'Task', hooks: [{ type: 'command', command, timeout: 300 }] },
    ];
    for (const e of settings.hooks.PreToolUse) delete e.hooks[0].onFailure;
    // A person's hook added into Rundock's own Bash entry, beside ours.
    settings.hooks.PreToolUse[0].hooks.push({ type: 'command', command: './lint.sh' });
    settings.hooks.PreToolUse.push(...JSON.parse(JSON.stringify(theirs)));
    save(dir, settings);

    open(dir);
    const after = read(dir).hooks.PreToolUse;
    for (const entry of theirs) {
      const found = after.filter((e) => JSON.stringify(e) === JSON.stringify(entry));
      assert.strictEqual(found.length, 1, `left as it was: ${JSON.stringify(entry)}`);
    }
    const bash = after.find((e) => e.matcher === 'Bash' && e.hooks.some((h) => h.command === command));
    assert.deepStrictEqual(bash.hooks[1], { type: 'command', command: './lint.sh' }, 'their hook in our entry is not given the field');
    for (const matcher of PRE_MATCHERS) {
      const ours = after.filter((e) => e.matcher === matcher && e.hooks.some((h) => h.command === command));
      assert.strictEqual(ours.length, 1, `one Rundock ${matcher} entry`);
      assert.strictEqual(ours[0].hooks[0].onFailure, 'block', `and it carries the field: ${matcher}`);
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

  test('the undo: entries an earlier release wrote without the field are upgraded again on the next open', () => {
    const dir = workspace();
    open(dir);
    const ours = bytes(dir);
    const earlier = asAnEarlierReleaseWroteIt(dir);
    assert.ok(earlier.hooks.PreToolUse.every((e) => !('onFailure' in e.hooks[0])), 'the earlier release\'s entries have no field');
    open(dir);
    assert.deepStrictEqual(ourPre(read(dir)).map((e) => e.hooks[0].onFailure), ['block', 'block', 'block', 'block'], 'every entry has it again');
    assert.strictEqual(bytes(dir), ours, 'upgraded back to exactly what this release wrote');
  });

  test('the retry: opening the same workspace twice writes the file once, and the second open finds nothing to change', () => {
    const dir = workspace();
    open(dir);
    asAnEarlierReleaseWroteIt(dir);
    const file = settingsPath(dir);
    assert.strictEqual(writesTo(file, () => open(dir)), 1, 'the first open writes the field');
    const first = bytes(dir);
    assert.ok(ourPre(read(dir)).every((e) => e.hooks[0].onFailure === 'block'));
    assert.strictEqual(writesTo(file, () => open(dir)), 0, 'the second open writes nothing');
    assert.strictEqual(bytes(dir), first);
  });

  test('the most common next step: a workspace from an earlier release gets the field on every entry, and nothing else changes', () => {
    const dir = workspace();
    const folder = makeTempDir('hook-on-failure-folder-');
    fs.writeFileSync(path.join(dir, '.rundock', 'state.json'), JSON.stringify({ workingFolders: [folder] }));
    open(dir);
    const earlier = asAnEarlierReleaseWroteIt(dir);
    assert.ok(earlier.sandbox && earlier.sandbox.filesystem.allowWrite.includes(folder), 'sanity: the sandbox block names the working folder');
    assert.ok(earlier.permissions.additionalDirectories.includes(folder), 'sanity: and so do the working folders');
    // A person's own keys, beside Rundock's.
    earlier.model = 'opus';
    earlier.env = { MY_TOKEN_NAME: 'x' };
    earlier.permissions.allow = ['Bash(ls)'];
    earlier.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: './check.sh' }] });
    earlier.hooks.PostToolUse.push({ matcher: 'Write', hooks: [{ type: 'command', command: 'prettier --write' }] });
    save(dir, earlier);

    open(dir);
    const after = read(dir);
    assert.strictEqual(ourPre(after).length, 4);
    for (const e of ourPre(after)) assert.strictEqual(e.hooks[0].onFailure, 'block', `${e.matcher} gets the field`);
    for (const e of ourPre(after)) delete e.hooks[0].onFailure;
    assert.deepStrictEqual(after, earlier, 'and with the field taken out again, the file is the earlier release\'s, key for key');
  });

  describe('the control failing', () => {
    test('a settings file the reconcile cannot parse is left byte for byte, and the failure is logged', () => {
      const bodies = ['{"hooks": {"PreToolUse": [', '// my notes\n{}', 'not json', '[]', 'null', '"block"'];
      for (const body of bodies) {
        const dir = workspace();
        fs.writeFileSync(settingsPath(dir), body);
        let written;
        const said = warnings(() => { written = writesTo(settingsPath(dir), () => open(dir)); });
        assert.strictEqual(bytes(dir), body, `${JSON.stringify(body)} is left as it is`);
        assert.strictEqual(written, 0, `${JSON.stringify(body)}: nothing is written`);
        assert.ok(said.some((w) => w.includes(settingsPath(dir))), `${JSON.stringify(body)}: the failure is logged, naming the file`);
      }
    });

    test('a settings file the reconcile cannot read is left as it is, and the failure is logged', () => {
      const dir = workspace();
      fs.mkdirSync(settingsPath(dir));
      const said = warnings(() => open(dir));
      assert.ok(fs.statSync(settingsPath(dir)).isDirectory(), 'still what it was');
      assert.ok(said.some((w) => w.includes(settingsPath(dir))), 'the failure is logged, naming the file');
    });

    test('a settings file the reconcile cannot write is left as it is and logged, and never holds a value but "block"', () => {
      const dir = workspace();
      open(dir);
      asAnEarlierReleaseWroteIt(dir);
      const before = bytes(dir);
      const file = settingsPath(dir);
      const real = fs.writeFileSync;
      fs.writeFileSync = function (target, ...rest) {
        if (path.resolve(String(target)) === file) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
        return real.call(this, target, ...rest);
      };
      let said;
      try { said = warnings(() => open(dir)); } finally { fs.writeFileSync = real; }
      assert.strictEqual(bytes(dir), before, 'left as it is');
      assert.ok(said.some((w) => w.includes('ENOSPC')), 'the failure is logged');
      open(dir);
      const values = read(dir).hooks.PreToolUse.flatMap((e) => e.hooks.map((h) => h.onFailure));
      assert.deepStrictEqual([...new Set(values)], ['block'], 'the next open that can write writes "block", and nothing else');
    });
  });
});
