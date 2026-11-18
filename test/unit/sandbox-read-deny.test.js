'use strict';
// THE SANDBOX BLOCK REFUSES READS OF THE RUNTIMES' CREDENTIAL FILES, AS WELL AS
// WRITES.
//
// The block has denied writes to every file in the hook's secrets registry,
// and a read, which is all that taking a token needs, had the card alone. It
// now carries `filesystem.denyRead`, built by the same function as those write
// entries (credentialDenyFor in lib/workspace/scaffold.js), so one list feeds
// both denies. Every expectation here is read from the hook's registry, never
// restated, so a credential added there is covered with no change to this file.
//
// Under a made-up home, so the workspaces opened below name no file of the
// account's, and the credential files are never read.
const { home } = require('../helpers/made-up-home.js');
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const scaffold = require('../../lib/workspace/scaffold.js');
const hook = require('../../scripts/permission-hook.js');
const boundary = require('../../lib/workspace/boundary.js');
const { _internal: srv } = require('../../server.js');
const { buildDispatch } = require('../../lib/protocol/handlers/index.js');
const { makeWorkspace, cleanup } = require('../helpers/workspace.js');

after(cleanup);

const WS = '/tmp/read-deny-ws';
const HOME = '/Users/someone';
const SHAPES = ['on', 'off'];
const blockFor = (shape, folders = []) => scaffold.sandboxSettings(WS, 'darwin', HOME, ['/tmp/t'], folders, shape);
// The registry as the hook's own tier checks read it, with POSIX separators,
// because the block is written for macOS whatever host runs this suite.
const registry = (home = HOME) => hook.secretsRegistry(home).map((p) => p.split(path.sep).join('/'));

describe('the block refuses reads of the credential files as well as writes', () => {
  test('a write to a credential file is refused as before, and a read of it is now refused too', () => {
    const secrets = registry();
    assert.ok(secrets.includes(`${HOME}/.claude/.credentials.json`) && secrets.includes(`${HOME}/.codex/auth.json`),
      'sanity: the registry names both runtimes\' credential files');
    for (const shape of SHAPES) {
      const { denyWrite, denyRead } = blockFor(shape).filesystem;
      for (const secret of secrets) {
        assert.ok(denyWrite.includes(secret), `${shape}: a write to ${secret} is still refused`);
        assert.ok(Array.isArray(denyRead) && denyRead.includes(secret), `${shape}: and a read of it is refused too`);
      }
    }
  });

  test('one list, two denies: the read deny is the write deny\'s credential entries, in registry order', () => {
    for (const shape of SHAPES) {
      const { denyWrite, denyRead } = blockFor(shape).filesystem;
      assert.deepStrictEqual(denyRead, registry(), `${shape}: the read deny is exactly the registry, in its order`);
      const first = denyWrite.indexOf(denyRead[0]);
      assert.deepStrictEqual(denyWrite.slice(first, first + denyRead.length), denyRead,
        `${shape}: and the same entries, in the same order, as the write deny's credential run`);
    }
  });

  test('both denies take their credential entries from the one function that lists them, never from a list of their own', (t) => {
    // Values alone cannot tell a read deny that calls that function from one
    // built beside it out of the same registry arrays: both name the same
    // files. So the function is replaced, in-process, with one returning
    // made-up entries, and both denies must carry exactly those and no
    // credential path from anywhere else.
    const made = ['/made-up/first-token.json', '/made-up/second-token.json'];
    t.mock.method(scaffold, 'credentialDenyFor', () => [...made]);
    for (const shape of [...SHAPES, 'knowledge', 'code']) {
      const { denyWrite, denyRead } = blockFor(shape).filesystem;
      assert.deepStrictEqual(denyRead, made, `${shape}: the read deny is what the function returned`);
      const first = denyWrite.indexOf(made[0]);
      assert.deepStrictEqual(denyWrite.slice(first, first + made.length), made,
        `${shape}: and so is the write deny's credential run`);
      const elsewhere = registry().filter((secret) => denyWrite.includes(secret) || denyRead.includes(secret));
      assert.deepStrictEqual(elsewhere, [], `${shape}: no credential path reaches either deny by another route`);
    }
  });

  test('a credential added to the registry is refused for reads and writes, with no change to the block\'s code', () => {
    // The registry arrays are the hook's own, shared by reference with the
    // module that builds the block, so an entry pushed here is one the next
    // block is built from.
    const added = '.made-up-token.json';
    hook.SECRET_RELATIVE_PATHS.push(added);
    try {
      const entry = `${HOME}/.claude/${added}`;
      assert.ok(registry().includes(entry), 'sanity: the registry now names it');
      for (const shape of SHAPES) {
        const { denyWrite, denyRead } = blockFor(shape).filesystem;
        assert.ok(denyWrite.includes(entry), `${shape}: a write to it is refused`);
        assert.ok(Array.isArray(denyRead) && denyRead.includes(entry), `${shape}: and so is a read`);
        assert.deepStrictEqual(denyRead, registry(), `${shape}: the read deny still follows the registry exactly`);
      }
    } finally {
      hook.SECRET_RELATIVE_PATHS.splice(hook.SECRET_RELATIVE_PATHS.indexOf(added), 1);
    }
    assert.ok(!registry().includes(`${HOME}/.claude/${added}`), 'sanity: the registry is as it was');
  });

  test('the read deny is the last key in the filesystem block, after the write deny, in every shape', () => {
    // sameSandbox compares serialised text, so a key's place is part of the
    // shape; last means dropping it moves no other key.
    for (const shape of [...SHAPES, 'knowledge', 'code']) {
      assert.deepStrictEqual(Object.keys(blockFor(shape).filesystem), ['allowWrite', 'denyWrite', 'denyRead'], shape);
    }
  });

  test('the Code-mode shape carries the read deny and enables nothing on its own', () => {
    // The shape that applies when another settings layer turned the sandbox
    // on: `enabled: false`, so Rundock claims no enable, and no network or
    // auto-allow key, which a unioned layer would widen. The runtime merges a
    // read deny across layers like the write deny (see credentialDenyFor).
    for (const shape of ['off', 'code']) {
      const block = blockFor(shape);
      assert.deepStrictEqual(Object.keys(block), ['enabled', 'filesystem'], `${shape}: nothing beside the filesystem block`);
      assert.strictEqual(block.enabled, false, `${shape}: it enables nothing`);
      assert.deepStrictEqual(block.filesystem.denyRead, registry(), `${shape}: and carries the read deny`);
    }
  });
});

// EVERY BLOCK ON DISK TODAY HAS NO READ DENY, so each shape the recogniser knew
// before is still known without one, and gains it at the next open. The read
// deny is known only beside the write deny it shipped with: no build wrote it
// beside a shorter list, beside none, or without `enabled`, so accepting one of
// those would rewrite over a person's edit.
const copy = (o) => JSON.parse(JSON.stringify(o));
const ours = (block) => scaffold.isRundockSandbox(block, 'darwin');
function withoutRead(block) {
  const b = copy(block);
  delete b.filesystem.denyRead;
  return b;
}
// The write deny cut to the first n entries, as an earlier build wrote it, or
// none at all at 0.
function cut(block, n) {
  const b = copy(block);
  if (n) b.filesystem.denyWrite = b.filesystem.denyWrite.slice(0, n);
  else delete b.filesystem.denyWrite;
  return b;
}
// Code mode's block before it stated `enabled: false`.
function keyless(block) {
  const b = copy(block);
  delete b.enabled;
  return b;
}
const shorter = (block) => [0, ...scaffold.WRITTEN_DENY_LENGTHS.filter((n) => n < block.filesystem.denyWrite.length)];
// Each shape a build before this one wrote, as [label, shape, transform of the
// current block], in the two shapes the switch writes.
function earlierShapes(current, shape) {
  const out = [];
  for (const n of [...shorter(current), current.filesystem.denyWrite.length]) {
    out.push([`${shape}, ${n} write-deny entries`, (b) => cut(withoutRead(b), n)]);
    if (shape === 'off') out.push([`${shape} with no enabled key, ${n} write-deny entries`, (b) => keyless(cut(withoutRead(b), n))]);
  }
  return out;
}

describe('a block written before the read deny upgrades, and a person\'s edit of it stays theirs', () => {
  test('every shape an earlier build wrote is still recognised, with no read deny', () => {
    for (const shape of SHAPES) {
      const current = blockFor(shape);
      for (const [label, earlier] of earlierShapes(current, shape)) {
        assert.strictEqual(ours(earlier(current)), true, `${label}: still Rundock's own, so the next open upgrades it`);
      }
    }
  });

  test('the read deny is recognised only beside the write deny it shipped with', () => {
    for (const shape of SHAPES) {
      const current = blockFor(shape);
      assert.strictEqual(ours(current), true, `sanity: the ${shape} block as written is ours`);
      for (const n of shorter(current)) {
        assert.strictEqual(ours(cut(current, n)), false, `${shape}: the read deny beside ${n} write-deny entries is a shape no build wrote`);
        if (shape === 'off') assert.strictEqual(ours(keyless(cut(current, n))), false, `${shape}: nor with no enabled key, beside ${n}`);
      }
      if (shape === 'off') assert.strictEqual(ours(keyless(current)), false, 'the read deny with no enabled key is a shape no build wrote');
    }
  });

  test('a person\'s edit of the read deny is not recognised: an entry removed, changed, reordered or added', () => {
    for (const shape of SHAPES) {
      const current = blockFor(shape);
      const read = current.filesystem.denyRead;
      const edits = [
        ...read.map((_, i) => [`entry ${i} removed`, read.filter((__, j) => j !== i)]),
        ...read.map((entry, i) => [`entry ${i} changed`, read.map((e, j) => (j === i ? `${entry}.old` : e))]),
        ['reversed', [...read].reverse()],
        ['first two swapped', [read[1], read[0], ...read.slice(2)]],
        ['an entry added at the end', [...read, `${HOME}/notes.txt`]],
        ['an entry added at the start', [`${HOME}/notes.txt`, ...read]],
        ['emptied', []],
      ];
      for (const [label, denyRead] of edits) {
        const edited = copy(current);
        edited.filesystem.denyRead = denyRead;
        assert.strictEqual(ours(edited), false, `${shape}: the read deny with ${label} is a person's edit`);
      }
      const { allowWrite, denyWrite, denyRead } = current.filesystem;
      assert.strictEqual(ours({ ...current, filesystem: { allowWrite, denyRead, denyWrite } }), false,
        `${shape}: and so is the read deny moved before the write deny`);
    }
  });
});

const settingsPath = (dir) => path.join(dir, '.claude', 'settings.local.json');
const statePath = (dir) => path.join(dir, '.rundock', 'state.json');
const bytes = (dir) => fs.readFileSync(settingsPath(dir), 'utf-8');
const sandboxOf = (dir) => JSON.parse(bytes(dir)).sandbox;
const ownRegistry = () => registry(home);
function captureWs() {
  const sent = [];
  return { sent, send: (m) => sent.push(JSON.parse(m)), readyState: 1 };
}
// A workspace opened by this build, in the mode given, with the switch stored
// or left to follow the mode.
function opened(state) {
  const dir = makeWorkspace({ claudeMd: '# x' });
  fs.mkdirSync(path.dirname(statePath(dir)), { recursive: true });
  fs.writeFileSync(statePath(dir), JSON.stringify(state, null, 2));
  srv.setWorkspace(dir);
  srv.scaffoldWorkspace(dir, { platform: 'darwin' });
  return dir;
}
function replaceBlock(dir, sandbox) {
  const settings = JSON.parse(bytes(dir));
  settings.sandbox = sandbox;
  fs.writeFileSync(settingsPath(dir), JSON.stringify(settings, null, 2));
}
const reopen = (dir) => srv.scaffoldWorkspace(dir, { platform: 'darwin' });

describe('the read deny through the open, the mode, the switch and the working folders', () => {
  test('at the next open, every block an earlier build wrote gains the read deny, and ends as this build writes it', () => {
    for (const shape of SHAPES) {
      const dir = opened({ workspaceMode: shape === 'on' ? 'knowledge' : 'code' });
      const written = bytes(dir);
      const current = sandboxOf(dir);
      assert.strictEqual(current.enabled, shape === 'on', `sanity: the ${shape} shape`);
      for (const [label, earlier] of earlierShapes(current, shape)) {
        replaceBlock(dir, earlier(current));
        assert.ok(!('denyRead' in sandboxOf(dir).filesystem), `sanity: ${label} has no read deny`);
        reopen(dir);
        assert.deepStrictEqual(sandboxOf(dir).filesystem.denyRead, ownRegistry(), `${label}: the open added the read deny`);
        assert.strictEqual(bytes(dir), written, `${label}: and the file is what this build writes, byte for byte`);
      }
    }
  });

  test('a person\'s edited block is left as written at the next open, with no read deny added', () => {
    const dir = opened({ workspaceMode: 'knowledge' });
    const current = sandboxOf(dir);
    const theirOwn = withoutRead(current);
    theirOwn.filesystem.denyWrite.push(path.posix.join(dir, 'private.md'));
    const cutWhereNoBuildStopped = withoutRead(current);
    cutWhereNoBuildStopped.filesystem.denyWrite.splice(-4);
    const oneRemoved = copy(current);
    oneRemoved.filesystem.denyRead.splice(1, 1);
    const oneAdded = copy(current);
    oneAdded.filesystem.denyRead.push(path.posix.join(home, 'notes.txt'));
    for (const [label, edited, readDeny] of [
      ['a write-deny entry of their own, no read deny', theirOwn, undefined],
      ['the write deny cut where no build stopped, no read deny', cutWhereNoBuildStopped, undefined],
      ['one read-deny entry removed', oneRemoved, oneRemoved.filesystem.denyRead],
      ['one read-deny entry added', oneAdded, oneAdded.filesystem.denyRead],
    ]) {
      replaceBlock(dir, edited);
      const before = bytes(dir);
      reopen(dir);
      assert.strictEqual(bytes(dir), before, `${label}: left byte for byte`);
      assert.deepStrictEqual(sandboxOf(dir).filesystem.denyRead, readDeny, `${label}: and its read deny is as they left it`);
    }
  });

  test('Code mode and back, and the switch off and on, leave the read deny as it was', () => {
    for (const mode of ['knowledge', 'code']) {
      const dir = opened({ workspaceMode: mode });
      const written = bytes(dir);
      const readDeny = sandboxOf(dir).filesystem.denyRead;
      assert.deepStrictEqual(readDeny, ownRegistry(), `sanity: the ${mode} workspace's block carries it`);
      const other = mode === 'code' ? 'knowledge' : 'code';
      for (const step of [other, mode]) {
        buildDispatch().set_workspace_mode({}, captureWs(), { mode: step }, 'darwin');
        assert.deepStrictEqual(sandboxOf(dir).filesystem.denyRead, readDeny, `${mode}: after choosing ${step}`);
      }
      assert.strictEqual(bytes(dir), written, `${mode}: the mode there and back leaves the file as it was`);
      const on = sandboxOf(dir).enabled !== false;
      for (const flip of [!on, on]) {
        buildDispatch().set_workspace_sandbox({}, captureWs(), { on: flip }, 'darwin');
        const block = sandboxOf(dir);
        assert.strictEqual(block.enabled !== false, flip, `${mode}: sanity: the switch is ${flip ? 'on' : 'off'}`);
        assert.deepStrictEqual(block.filesystem.denyRead, readDeny, `${mode}: the read deny with the switch ${flip ? 'on' : 'off'}`);
      }
      assert.strictEqual(bytes(dir), written, `${mode}: the switch off and on leaves the file as it was`);
    }
  });

  test('the home folder and the Codex folder named as working folders add to the write list only, and nothing a card saves widens the read deny', () => {
    const codex = path.join(home, '.codex');
    fs.mkdirSync(codex, { recursive: true });
    const dir = opened({ workspaceMode: 'knowledge' });
    const readDeny = sandboxOf(dir).filesystem.denyRead;
    assert.deepStrictEqual(readDeny, ownRegistry(), 'sanity: the block carries the read deny');
    buildDispatch().set_working_folders({}, captureWs(), { type: 'set_working_folders', folders: [home, codex] }, 'darwin');
    let block = sandboxOf(dir);
    assert.ok(block.filesystem.allowWrite.includes(home) && block.filesystem.allowWrite.includes(codex), 'sanity: both are on the write list');
    assert.deepStrictEqual(block.filesystem.denyRead, readDeny, 'the read deny is unchanged');
    for (const secret of ownRegistry()) assert.ok(block.filesystem.denyWrite.includes(secret), `and a write to ${secret} is still refused`);
    assert.strictEqual(ours(block), true, 'and the block is still Rundock\'s own');

    const named = bytes(dir);
    boundary.addBoundaryGrant(home);
    boundary.addBoundaryGrant(codex);
    boundary.addToolAllow('Bash:cat');
    reopen(dir);
    block = sandboxOf(dir);
    assert.deepStrictEqual(block.filesystem.denyRead, readDeny, 'saved folder grants and answers leave the read deny as it was');
    assert.strictEqual(bytes(dir), named, 'and the file as it was');

    // A command the runtime runs outside the sandbox carries no path, so no
    // grant can answer it and nothing is remembered: the card is the guard.
    const unsandboxed = hook.classifyShellAccess('Bash',
      { command: `cat ${path.join(home, '.claude', '.credentials.json')}`, dangerouslyDisableSandbox: true }, dir, [home, codex], home);
    assert.deepStrictEqual(unsandboxed, { where: 'outside', resolvedPath: null, grantDir: null, grantable: false, crossings: [] },
      'a read run outside the sandbox is a crossing no grant answers, whatever is named or granted');
  });

  test('workspace reads, listings and ordinary commands are untouched: the read deny names the credential files and nothing else', () => {
    const dir = opened({ workspaceMode: 'knowledge' });
    const { denyRead } = sandboxOf(dir).filesystem;
    assert.deepStrictEqual(denyRead, ownRegistry(), 'the credential files alone');
    const covered = (p) => denyRead.some((d) => p === d || p.startsWith(`${d}/`));
    const ordinary = [
      dir, path.posix.join(dir, 'CLAUDE.md'), path.posix.join(dir, '.claude', 'settings.local.json'), path.posix.join(dir, '.rundock', 'state.json'),
      home, path.posix.join(home, '.claude'), path.posix.join(home, '.claude', 'settings.json'), path.posix.join(home, '.claude', 'projects'),
      path.posix.join(home, '.codex'), path.posix.join(home, '.codex', 'config.toml'), path.posix.join(home, 'notes.md'),
    ];
    for (const p of ordinary) assert.strictEqual(covered(p), false, `${p} reads as it did`);
    for (const command of ['ls', 'cat CLAUDE.md', 'grep -r todo .', 'npm test', 'git status']) {
      assert.strictEqual(hook.classifyShellAccess('Bash', { command }, dir, [], home), null, `${command}: no card, as before`);
    }
  });
});
