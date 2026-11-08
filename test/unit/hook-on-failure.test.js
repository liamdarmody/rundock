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
// on any entry. The record below shows that this is exactly what the v0.15.7
// release's own code writes in a new workspace.
function asAnEarlierReleaseWroteIt(dir) {
  const settings = read(dir);
  for (const e of settings.hooks.PreToolUse) for (const h of e.hooks) delete h.onFailure;
  save(dir, settings);
  return settings;
}

// What the v0.15.7 release's own code did, captured by
// scripts/hook-on-failure-undo/capture.js, which is run by hand because it
// needs the release tags. The workspace's path is written in it as
// <workspace>.
const RELEASE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'hook-on-failure-undo', 'captured-earlier-release.json'), 'utf-8'));
const inWorkspace = (settings, dir) => JSON.parse(JSON.stringify(settings).split('<workspace>').join(JSON.stringify(dir).slice(1, -1)));

// Every time the code under test replaces one file, counted, and still made:
// a write straight to it, or a rename onto it.
function writesTo(file, fn) {
  const real = { writeFileSync: fs.writeFileSync, renameSync: fs.renameSync };
  let resolved = file;
  try { resolved = fs.realpathSync(file); } catch (e) { /* not there yet */ }
  const hits = (p) => [file, resolved].includes(path.resolve(String(p)));
  let count = 0;
  fs.writeFileSync = function (target, ...rest) {
    if (hits(target)) count++;
    return real.writeFileSync.call(this, target, ...rest);
  };
  fs.renameSync = function (from, to, ...rest) {
    if (hits(to)) count++;
    return real.renameSync.call(this, from, to, ...rest);
  };
  try { fn(); } finally { Object.assign(fs, real); }
  return count;
}

// A Rundock entry the next open has to repair, so that open writes the file.
function needingRepair(dir) {
  const settings = read(dir);
  for (const e of ourPre(settings)) e.hooks[0].onFailure = 'continue';
  save(dir, settings);
}

// Temporary files left beside the settings file.
const leftovers = (dir) => fs.readdirSync(path.join(dir, '.claude')).filter((n) => n.startsWith('settings.local.json.'));

const enospc = () => Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });

// A write that starts and then fails partway, as a full disk does. Any file
// whose name starts with the settings file's gets its first ten bytes and
// then ENOSPC, whether it is written through a descriptor or in one call
// straight over the file.
function failingPartway(fn) {
  const real = { openSync: fs.openSync, writeSync: fs.writeSync, writeFileSync: fs.writeFileSync };
  const named = (p) => path.basename(String(p)).startsWith('settings.local.json');
  const opened = new Set();
  fs.openSync = function (p, flags, ...rest) {
    const fd = real.openSync.call(this, p, flags, ...rest);
    if (named(p) && /[wa+]/.test(String(flags))) opened.add(fd);
    return fd;
  };
  fs.writeSync = function (fd, data, ...rest) {
    if (!opened.has(fd)) return real.writeSync.call(this, fd, data, ...rest);
    real.writeSync.call(this, fd, Buffer.from(data).subarray(0, 10));
    throw enospc();
  };
  fs.writeFileSync = function (p, data, ...rest) {
    if (!named(p)) return real.writeFileSync.call(this, p, data, ...rest);
    real.writeFileSync.call(this, p, Buffer.from(data).subarray(0, 10));
    throw enospc();
  };
  try { return fn(); } finally { Object.assign(fs, real); }
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
    env.NODE_V8_COVERAGE = '';
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

  // The record is captured for a platform that starts the hook with sh.
  test('the undo: after the earlier release has opened a workspace this one wrote, the next open leaves every Rundock entry on "block" and changes nothing else', { skip: process.platform === 'win32' }, () => {
    assert.strictEqual(RELEASE.release, 'v0.15.7');
    assert.deepStrictEqual(ourPre(RELEASE.written).map((e) => e.hooks[0].onFailure), ['block', 'block', 'block', 'block'], 'the record starts from a file this release wrote');
    const dir = workspace();
    const left = inWorkspace(RELEASE.leftByRelease, dir);
    save(dir, left);
    open(dir, RELEASE.platform);
    const after = read(dir);
    assert.deepStrictEqual(ourPre(after).map((e) => e.hooks[0].onFailure), ['block', 'block', 'block', 'block'], 'every Rundock entry has it');
    const expected = JSON.parse(JSON.stringify(left));
    for (const e of ourPre(expected)) for (const h of e.hooks) if (isOurs(h)) h.onFailure = 'block';
    assert.deepStrictEqual(after, expected, 'and nothing else changed');
  });

  test('a workspace the earlier release created is this release\'s file with the field taken out, which is where the other sequences start', () => {
    const without = JSON.parse(JSON.stringify(RELEASE.written));
    for (const e of without.hooks.PreToolUse) for (const h of e.hooks) delete h.onFailure;
    assert.deepStrictEqual(RELEASE.createdByRelease, without);
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

    test('a write that fails partway leaves the settings file byte for byte, logs it, and leaves no temporary file', () => {
      const dir = workspace();
      open(dir);
      needingRepair(dir);
      const before = bytes(dir);
      const said = failingPartway(() => warnings(() => open(dir)));
      assert.strictEqual(bytes(dir), before, 'left as it was, not cut short');
      assert.ok(said.some((w) => w.includes('ENOSPC') && w.includes(settingsPath(dir))), 'the failure is logged, naming the file');
      assert.deepStrictEqual(leftovers(dir), [], 'and the temporary file is gone');
      open(dir);
      const values = read(dir).hooks.PreToolUse.flatMap((e) => e.hooks.map((h) => h.onFailure));
      assert.deepStrictEqual([...new Set(values)], ['block'], 'the next open that can write writes "block", and nothing else');
    });

    test('a write whose last step, the rename, fails leaves the settings file as it was and no temporary file', () => {
      const dir = workspace();
      open(dir);
      needingRepair(dir);
      const before = bytes(dir);
      const real = fs.renameSync;
      fs.renameSync = function (from, to, ...rest) {
        if (path.basename(String(to)) === 'settings.local.json') throw Object.assign(new Error('EXDEV: cross-device link not permitted, rename'), { code: 'EXDEV' });
        return real.call(this, from, to, ...rest);
      };
      let said;
      try { said = warnings(() => open(dir)); } finally { fs.renameSync = real; }
      assert.strictEqual(bytes(dir), before);
      assert.ok(said.some((w) => w.includes('EXDEV') && w.includes(settingsPath(dir))), 'the failure is logged, naming the file');
      assert.deepStrictEqual(leftovers(dir), []);
    });

    test('a settings file that cannot be written is left as it is rather than replaced, and logged', { skip: process.platform === 'win32' || (process.getuid && process.getuid() === 0) }, () => {
      const dir = workspace();
      open(dir);
      needingRepair(dir);
      const before = bytes(dir);
      fs.chmodSync(settingsPath(dir), 0o444);
      let said;
      try { said = warnings(() => open(dir)); } finally { fs.chmodSync(settingsPath(dir), 0o644); }
      assert.strictEqual(bytes(dir), before, 'a read-only file is not swapped for a new one');
      assert.ok(said.some((w) => w.includes(settingsPath(dir))), 'the failure is logged, naming the file');
      assert.deepStrictEqual(leftovers(dir), []);
    });

    test('a settings file reached through a link is written through it, and keeps its permissions', { skip: process.platform === 'win32' }, () => {
      const dir = workspace();
      open(dir);
      needingRepair(dir);
      const elsewhere = path.join(makeTempDir('hook-on-failure-kept-'), 'settings.json');
      fs.renameSync(settingsPath(dir), elsewhere);
      fs.symlinkSync(elsewhere, settingsPath(dir));
      fs.chmodSync(elsewhere, 0o600);
      open(dir);
      assert.ok(fs.lstatSync(settingsPath(dir)).isSymbolicLink(), 'still a link');
      const values = JSON.parse(fs.readFileSync(elsewhere, 'utf-8')).hooks.PreToolUse.map((e) => e.hooks[0].onFailure);
      assert.deepStrictEqual(values, ['block', 'block', 'block', 'block'], 'the file it names was written');
      assert.strictEqual(fs.statSync(elsewhere).mode & 0o777, 0o600, 'with its permissions as they were');
      assert.deepStrictEqual(fs.readdirSync(path.dirname(elsewhere)), ['settings.json'], 'and nothing left beside it');
    });
  });
});

describe('the other writers of the settings file write it whole as well', () => {
  const config = require('../../lib/config.js');
  const sandboxStatus = require('../../lib/workspace/sandbox-status.js');

  test('switching the sandbox block, when the write fails partway, leaves the file as it was', () => {
    const dir = workspace();
    open(dir);
    const before = bytes(dir);
    assert.throws(() => failingPartway(() => scaffold.reconcileSandboxForMode(dir, 'off', 'darwin')), /ENOSPC/);
    assert.strictEqual(bytes(dir), before);
    assert.deepStrictEqual(leftovers(dir), []);
  });

  test('bringing a person\'s own sandbox rules in, when the write and the put-back both fail partway, leaves the file as it was', () => {
    const dir = workspace();
    fs.writeFileSync(path.join(dir, '.rundock', 'state.json'), JSON.stringify({ workspaceMode: 'code' }, null, 2));
    save(dir, { sandbox: { enabled: true, filesystem: { allowWrite: [dir], denyWrite: ['*.env'] } }, hooks: { PreToolUse: [] } });
    const original = config.getWorkspace();
    config.setWorkspace(dir);
    try {
      const { digest } = sandboxStatus.reviewSandboxImport(dir, 'darwin');
      const before = bytes(dir);
      warnings(() => assert.throws(() => failingPartway(() => sandboxStatus.importSandboxRules(dir, digest, 'darwin')), /ENOSPC/));
      assert.strictEqual(bytes(dir), before);
      assert.deepStrictEqual(leftovers(dir), []);
    } finally { config.setWorkspace(original); }
  });
});
