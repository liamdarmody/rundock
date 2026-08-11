'use strict';
// Characterisation: the workspace lifecycle WS handlers (get_workspaces,
// list_workspaces, pick_folder, create_workspace), pinned as they behave
// today, before they move out of server.js.
//
// pick_folder shells out to `osascript` for the native macOS folder dialog.
// These tests put a fake `osascript` first on PATH (the same injection trick
// the harness uses for the claude stub): it prints the contents of a control
// file, or exits non-zero when the file is absent, so both the picked and the
// cancelled paths run without any real dialog on any platform.
//
// Ordering matters in this file: create_workspace and the stale-pointer test
// SWITCH the live workspace, so each restores the harness workspace before
// the next test runs.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const h = require('../helpers/harness.js');
const { makeTempDir } = require('../helpers/workspace.js');

let client;
let controlFile;

before(async () => {
  // Fake osascript, injected ahead of everything else on PATH. The harness
  // prepends the claude/codex stub dirs inside boot(); passing PATH via
  // opts.env overwrites that, so this value re-includes them explicitly and
  // boot()'s stub-resolution safety gate still holds.
  const fakeBin = makeTempDir('rundock-test-osascript-');
  controlFile = path.join(fakeBin, 'picked-folder.txt');
  const script = path.join(fakeBin, 'osascript');
  fs.writeFileSync(script, [
    '#!/usr/bin/env node',
    `const fs = require('fs');`,
    `try { process.stdout.write(fs.readFileSync(${JSON.stringify(controlFile)}, 'utf-8')); }`,
    'catch (e) { process.exit(1); }',
  ].join('\n'));
  fs.chmodSync(script, 0o755);

  await h.boot({
    env: {
      PATH: [fakeBin, h.STUB_DIR, h.CODEX_STUB_DIR, process.env.PATH].join(path.delimiter),
    },
  });
  client = await h.connect();
});
after(async () => h.shutdown());

function request(msg, pred, label) {
  const since = client.messages.length;
  client.send(msg);
  return client.waitFor(pred, { since, label }).then(r => r.msg);
}

describe('get_workspaces', () => {
  test('answers current workspace, recents, discovered, analysis, and setup state in one message', async () => {
    const res = await request({ type: 'get_workspaces' }, m => m.type === 'workspaces', 'workspaces');
    assert.strictEqual(res.current, h.workspaceDir);
    assert.ok(Array.isArray(res.recent), 'recent is a list');
    assert.ok(Array.isArray(res.discovered), 'discovered is a list');
    assert.ok(res.analysis && typeof res.analysis === 'object', 'workspace analysis included');
    assert.ok(typeof res.workspaceMode === 'string', 'workspace mode included');
    assert.strictEqual(typeof res.setupComplete, 'boolean');
  });

  test('a workspace pointer whose directory vanished is cleared, not served stale', async () => {
    const doomed = makeTempDir('rundock-test-doomed-');
    h.internal.setWorkspace(doomed);
    fs.rmSync(doomed, { recursive: true, force: true });

    const res = await request({ type: 'get_workspaces' }, m => m.type === 'workspaces', 'workspaces after vanish');
    assert.strictEqual(res.current, null, 'vanished workspace reported as no workspace');
    assert.ok(!('analysis' in res), 'no analysis without a workspace');

    h.internal.setWorkspace(h.workspaceDir);
  });
});

describe('list_workspaces', () => {
  test('answers recents and discovered only: no current, no analysis', async () => {
    const res = await request({ type: 'list_workspaces' }, m => m.type === 'workspaces', 'list_workspaces');
    assert.ok(Array.isArray(res.recent));
    assert.ok(Array.isArray(res.discovered));
    assert.ok(!('current' in res), 'list variant does not report current');
    assert.ok(!('analysis' in res), 'list variant does not analyse');
  });
});

describe('pick_folder', () => {
  test('a picked folder comes back with its trailing slash stripped', async () => {
    // osascript's POSIX path output ends in a slash; the handler strips it.
    fs.writeFileSync(controlFile, '/tmp/rundock-picked-folder/\n');
    const res = await request({ type: 'pick_folder' }, m => m.type === 'folder_picked', 'folder_picked');
    assert.strictEqual(res.path, '/tmp/rundock-picked-folder');
  });

  test('cancelling the dialog answers null instead of erroring', async () => {
    fs.rmSync(controlFile, { force: true });
    const res = await request({ type: 'pick_folder' }, m => m.type === 'folder_picked', 'folder_picked cancel');
    assert.strictEqual(res.path, null);
  });

  test('empty dialog output also answers null', async () => {
    fs.writeFileSync(controlFile, '');
    const res = await request({ type: 'pick_folder' }, m => m.type === 'folder_picked', 'folder_picked empty');
    assert.strictEqual(res.path, null);
  });
});

describe('create_workspace', () => {
  test('an empty or fully-sanitised-away name is refused with a user-facing error', async () => {
    const res = await request({ type: 'create_workspace', name: '  /\\:*?"<>|  ' },
      m => m.type === 'workspace_error', 'workspace_error');
    assert.strictEqual(res.message, 'Please enter a workspace name');
  });

  test('creates under HOME/Documents/Rundock, sanitises the name, scaffolds, and announces the full boot set', async () => {
    const since = client.messages.length;
    client.send({ type: 'create_workspace', name: 'My/Test:Space?' });

    const wsSet = (await client.waitFor(m => m.type === 'workspace_set', { since, label: 'workspace_set' })).msg;
    const expectedDir = path.join(os.homedir(), 'Documents', 'Rundock', 'MyTestSpace');
    assert.strictEqual(wsSet.path, expectedDir, 'forbidden filename characters stripped from the name');
    assert.strictEqual(wsSet.isEmpty, true);
    assert.strictEqual(wsSet.setupComplete, false);
    assert.strictEqual(wsSet.scaffoldError, null);
    assert.ok(typeof wsSet.workspaceMode === 'string');

    // The client also receives the agent roster and file tree without asking.
    await client.waitFor(m => m.type === 'agents', { since, label: 'agents after create' });
    const tree = (await client.waitFor(m => m.type === 'file_tree', { since, label: 'file_tree after create' })).msg;
    assert.ok(Array.isArray(tree.tree));

    // On disk: the workspace, its .claude dir, and the scaffold defaults.
    assert.ok(fs.existsSync(expectedDir), 'workspace directory created');
    assert.ok(fs.existsSync(path.join(expectedDir, '.claude')), '.claude directory created');
    assert.ok(fs.existsSync(path.join(expectedDir, 'CLAUDE.md')), 'scaffold defaults written');

    h.internal.setWorkspace(h.workspaceDir);
  });
});
