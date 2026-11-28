'use strict';
// THE PERMISSIONREQUEST ENTRY THE WORKSPACE SETTINGS CARRY.
//
// Claude Code puts a Bash or PowerShell call with
// `dangerouslyDisableSandbox: true` to the PermissionRequest hooks after the
// PreToolUse answer allowed it, and runs it only if one answers allow. Where
// Rundock owns .claude/settings.local.json, the reconcile every workspace open
// runs registers the permission hook for that event, for those two tools, the
// same way as the PostToolUse entries: a stale entry of ours is replaced, an
// up-to-date one is kept, and every other entry stays, in order and
// unchanged.
//
// Driven through scaffoldWorkspace against a real settings file on disk.
const { test, describe, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const scaffold = require('../../lib/workspace/scaffold.js');
const { makeTempDir, cleanup } = require('../helpers/workspace.js');

after(cleanup);
let prevDeps;
beforeEach(() => { prevDeps = scaffold.wireScaffoldDeps({ invalidateAgentCache() {}, rebaselineAgentsWatcher() {} }); });
afterEach(() => { scaffold.wireScaffoldDeps(prevDeps); });

const MATCHER = 'Bash|PowerShell';

function workspace() {
  const dir = makeTempDir('scaffold-permission-request-');
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
const copy = (value) => JSON.parse(JSON.stringify(value));

// The entry Rundock writes for a workspace, given the settings it wrote: the
// permission hook with the same short timeout as the PostToolUse entry, and no
// onFailure, since a PermissionRequest hook that fails gives no decision.
const entryFor = (settings) => ({ matcher: MATCHER, hooks: copy(settings.hooks.PostToolUse.find((e) => e.hooks.some(isOurs)).hooks) });

// Every time the code under test replaces the settings file, counted.
function writesTo(file, fn) {
  const real = { writeFileSync: fs.writeFileSync, renameSync: fs.renameSync };
  const hits = (p) => path.resolve(String(p)) === path.resolve(file);
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

// What an earlier release wrote and left, captured from its own code. The
// workspace's path is written in it as <workspace>.
const RELEASE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'hook-on-failure-undo', 'captured-earlier-release.json'), 'utf-8'));
const inWorkspace = (settings, dir) => JSON.parse(JSON.stringify(settings).split('<workspace>').join(JSON.stringify(dir).slice(1, -1)));

describe('the workspace settings carry a PermissionRequest entry, and keep everyone else\'s', () => {
  test('a new workspace gets one entry for Bash and PowerShell, with the permission hook and no onFailure', () => {
    const dir = workspace();
    open(dir);
    const settings = read(dir);
    assert.ok(Array.isArray(settings.hooks.PermissionRequest), 'the settings have a PermissionRequest list');
    assert.deepStrictEqual(settings.hooks.PermissionRequest, [entryFor(settings)]);
    const hook = settings.hooks.PermissionRequest[0].hooks[0];
    assert.strictEqual(hook.command, settings.hooks.PreToolUse[0].hooks[0].command, 'the same script as every other entry');
    assert.strictEqual(hook.timeout, 10);
    assert.ok(!('onFailure' in hook));
  });

  // The record is captured for a platform that starts the hook with sh.
  test('a workspace an earlier release left gains the entry, and every other key is unchanged', { skip: process.platform === 'win32' }, () => {
    const dir = workspace();
    const left = inWorkspace(RELEASE.leftByRelease, dir);
    assert.strictEqual(left.hooks.PermissionRequest, undefined, 'sanity: the earlier release wrote none');
    save(dir, left);
    open(dir, RELEASE.platform);
    const settings = read(dir);
    assert.deepStrictEqual(settings.hooks.PermissionRequest, [entryFor(left)]);
    delete settings.hooks.PermissionRequest;
    assert.deepStrictEqual(settings, left);
  });

  test('a workspace an earlier release created gains the entry, beside the change this release already makes', { skip: process.platform === 'win32' }, () => {
    const dir = workspace();
    const created = inWorkspace(RELEASE.createdByRelease, dir);
    save(dir, created);
    open(dir, RELEASE.platform);
    const settings = read(dir);
    assert.deepStrictEqual(settings.hooks.PermissionRequest, [entryFor(created)]);
    delete settings.hooks.PermissionRequest;
    // A release after that one adds onFailure to its PreToolUse entries.
    const expected = copy(created);
    for (const e of expected.hooks.PreToolUse) for (const h of e.hooks) if (isOurs(h)) h.onFailure = scaffold.HOOK_ON_FAILURE;
    assert.deepStrictEqual(settings, expected);
  });

  test('a third-party PermissionRequest hook stays where it was, beside ours', () => {
    const dir = workspace();
    open(dir);
    const settings = read(dir);
    const ours = entryFor(settings);
    const before = { matcher: 'Bash', hooks: [{ type: 'command', command: 'node example/alpha.js', timeout: 30 }] };
    const afterOurs = { matcher: '*', hooks: [{ type: 'command', command: 'node example/beta.js' }] };
    settings.hooks.PermissionRequest = [before, afterOurs];
    save(dir, settings);
    open(dir);
    assert.deepStrictEqual(read(dir).hooks.PermissionRequest, [before, afterOurs, ours], 'theirs stay in order, and ours is added after them');
    const placed = read(dir);
    placed.hooks.PermissionRequest = [before, ours, afterOurs];
    save(dir, placed);
    open(dir);
    assert.deepStrictEqual(read(dir).hooks.PermissionRequest, [before, ours, afterOurs], 'an up-to-date entry of ours is kept where it is');
  });

  // Each form Rundock writes for this event, left at a place it no longer is:
  // the launcher run with sh, the launcher run by PowerShell, and the runtime
  // with the hook script.
  test('a stale entry of ours is replaced, not joined, in each form Rundock writes', () => {
    const dir = workspace();
    open(dir);
    const settings = read(dir);
    const ours = entryFor(settings);
    settings.hooks.PermissionRequest = [
      { matcher: MATCHER, hooks: [{ type: 'command', command: 'sh "/old/place/.rundock/permission-hook.sh"', timeout: 10 }] },
      { matcher: MATCHER, hooks: [{ type: 'command', command: '& "C:\\old\\place\\.rundock\\permission-hook.cmd"', shell: 'powershell', timeout: 10 }] },
      { matcher: MATCHER, hooks: [{ type: 'command', command: '"/old/bin/node" "/old/app/scripts/permission-hook.js"', timeout: 10 }] },
    ];
    save(dir, settings);
    open(dir);
    assert.deepStrictEqual(read(dir).hooks.PermissionRequest, [ours]);
  });

  test('someone else\'s hook whose command mentions permission-hook stays, in order and unchanged', () => {
    const dir = workspace();
    open(dir);
    const settings = read(dir);
    const ours = entryFor(settings);
    const theirs = [
      { matcher: MATCHER, hooks: [{ type: 'command', command: 'node ./hooks/custom-permission-hook.js' }] },
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'node ./hooks/custom-permission-hook.js', timeout: 5 }] },
    ];
    settings.hooks.PermissionRequest = copy(theirs);
    save(dir, settings);
    open(dir);
    assert.deepStrictEqual(read(dir).hooks.PermissionRequest, [...theirs, ours], 'theirs stay, and ours is added after them');
  });

  test('someone else\'s hook beside a stale one of ours in one entry stays, with the entry unchanged', () => {
    const dir = workspace();
    open(dir);
    const settings = read(dir);
    const ours = entryFor(settings);
    const shared = { matcher: MATCHER, hooks: [
      { type: 'command', command: 'sh "/old/place/.rundock/permission-hook.sh"', timeout: 10 },
      { type: 'command', command: 'node example/alpha.js' },
    ] };
    settings.hooks.PermissionRequest = [copy(shared)];
    save(dir, settings);
    open(dir);
    assert.deepStrictEqual(read(dir).hooks.PermissionRequest, [shared, ours], 'an entry that is not wholly ours is left as it is');
  });

  test('a second open writes nothing', () => {
    const dir = workspace();
    open(dir);
    assert.deepStrictEqual(read(dir).hooks.PermissionRequest, [entryFor(read(dir))], 'the first open wrote the entry');
    const first = bytes(dir);
    assert.strictEqual(writesTo(settingsPath(dir), () => open(dir)), 0, 'the second open writes nothing');
    assert.strictEqual(bytes(dir), first);
  });

  test('settings whose sandbox block a person wrote get no entry, while Rundock\'s own do', () => {
    const owned = workspace();
    open(owned);
    assert.deepStrictEqual(read(owned).hooks.PermissionRequest, [entryFor(read(owned))], 'Rundock\'s own settings get the entry');
    const dir = workspace();
    const theirs = { sandbox: { enabled: true, filesystem: { allowWrite: ['/a'] } }, hooks: { PermissionRequest: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node example/alpha.js' }] }] } };
    save(dir, theirs);
    open(dir);
    const settings = read(dir);
    assert.deepStrictEqual(settings.hooks.PermissionRequest, theirs.hooks.PermissionRequest, 'theirs is untouched, and ours is not added');
    assert.deepStrictEqual(settings.sandbox, theirs.sandbox);
  });
});
