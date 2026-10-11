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
let stderrFile;

before(async () => {
  // Fake osascript, injected ahead of everything else on PATH. The harness
  // prepends the claude/codex stub dirs inside boot(); passing PATH via
  // opts.env overwrites that, so this value re-includes them explicitly and
  // boot()'s stub-resolution safety gate still holds.
  const fakeBin = makeTempDir('rundock-test-osascript-');
  controlFile = path.join(fakeBin, 'picked-folder.txt');
  // The stub can now fail in the two DIFFERENT ways osascript really fails,
  // because the handler has to tell them apart. A cancel is error -128 on
  // stderr and means the person chose not to pick; anything else is the
  // dialog not working, which they need told about. When the stderr control
  // file exists its contents are written to stderr, so a test can hand the
  // handler either shape; with neither file present the stub still exits
  // non-zero silently, which is the shape the earlier tests used.
  stderrFile = path.join(fakeBin, 'osascript-stderr.txt');
  const script = path.join(fakeBin, 'osascript');
  fs.writeFileSync(script, [
    '#!/usr/bin/env node',
    `const fs = require('fs');`,
    `try { process.stdout.write(fs.readFileSync(${JSON.stringify(controlFile)}, 'utf-8')); }`,
    'catch (e) {',
    `  try { process.stderr.write(fs.readFileSync(${JSON.stringify(stderrFile)}, 'utf-8')); } catch (e2) {}`,
    '  process.exit(1);',
    '}',
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

  // THIS TEST USED TO ASSERT THE DEFECT. It was called "cancelling the
  // dialog" but what it staged was a non-zero exit with nothing on stderr,
  // and a real cancel is never silent: osascript raises -128 and says so.
  // The handler answered both with a bare null, so the test passed while
  // describing something that cannot happen, and the case it actually
  // covered, the dialog failing, was the one going unreported. The cancel it
  // meant to test is the -128 test below; this one now pins what a silent
  // failure is treated as, which is a failure.
  test('a non-zero exit saying nothing is a failure, not an assumed cancel', async () => {
    fs.rmSync(controlFile, { force: true });
    fs.rmSync(stderrFile, { force: true });
    const res = await request({ type: 'pick_folder' }, m => m.type === 'workspace_error', 'folder_picked silent failure');
    assert.match(res.message, /folder chooser/i, 'an unexplained failure is still reported');
  });

  // A CANCEL AND A BROKEN DIALOG ARE NOT THE SAME EVENT, and the interface
  // has no way to say so if the handler answers both with a bare null. The
  // picker button then looks simply dead: nothing opens, nothing is said,
  // and there is no way to tell a deliberate cancel from a dialog that could
  // not be raised at all. Found by driving the shipped product in a browser,
  // where the server could not raise the dialog and the button did nothing.
  test('a real cancel, error -128, stays silent: the person chose this', async () => {
    fs.rmSync(controlFile, { force: true });
    fs.writeFileSync(stderrFile, '0:17: execution error: User cancelled. (-128)\n');
    const res = await request({ type: 'pick_folder' }, m => m.type === 'folder_picked', 'folder_picked -128');
    assert.strictEqual(res.path, null, 'a cancel still answers null');
    assert.ok(!res.message, 'and says nothing, because the person cancelled on purpose');
  });

  test('a dialog that could not be raised is reported, not swallowed as a cancel', async () => {
    fs.rmSync(controlFile, { force: true });
    fs.writeFileSync(stderrFile, "0:12: execution error: Application isn't running. (-600)\n");
    const res = await request({ type: 'pick_folder' }, m => m.type === 'workspace_error', 'pick_folder failure');
    assert.match(res.message, /folder/i, 'the message names what failed');
    assert.ok(res.message.length > 12, 'and says something a reader can act on rather than a bare code');
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

  test('a name of only dots is refused, never resolved to the folder above', async () => {
    const res = await request({ type: 'create_workspace', name: '..' },
      m => m.type === 'workspace_error', 'workspace_error dots');
    assert.strictEqual(res.message, 'Please enter a workspace name');
  });

  test('a name that already exists changes nothing on disk and offers to open it', async () => {
    const dir = path.join(os.homedir(), 'Documents', 'Rundock', 'Already Here');
    fs.mkdirSync(dir, { recursive: true });
    const own = '# Already Here\n\nSet up and in use.\n';
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), own);
    const before = fs.readdirSync(dir).sort();
    const workspaceBefore = h.internal.getWorkspace();

    // Typed with a character to strip, too: the name it resolves to is taken,
    // and that is what the person needs told first.
    for (const name of ['Already Here', 'Already Here?']) {
      const res = await request({ type: 'create_workspace', name },
        m => m.type === 'workspace_name_taken', `workspace_name_taken for ${name}`);
      assert.strictEqual(res.message,
        'A workspace called "Already Here" already exists in ~/Documents/Rundock, so nothing was changed. You can open it instead.');
      assert.strictEqual(res.openPath, fs.realpathSync.native(dir), 'the refusal carries the folder to open instead');
      assert.strictEqual(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf-8'), own, 'CLAUDE.md untouched');
      assert.deepStrictEqual(fs.readdirSync(dir).sort(), before, 'nothing added beside it');
      assert.strictEqual(h.internal.getWorkspace(), workspaceBefore, 'no switch');
    }
  });

  test('the folder offered is the real one: a symlink resolves to where it points', async () => {
    const real = path.join(os.homedir(), 'Documents', 'Rundock', 'Real Target');
    const link = path.join(os.homedir(), 'Documents', 'Rundock', 'Linked');
    fs.mkdirSync(real, { recursive: true });
    fs.symlinkSync(real, link, 'dir');
    const res = await request({ type: 'create_workspace', name: 'Linked' },
      m => m.type === 'workspace_name_taken', 'workspace_name_taken for a symlink');
    assert.strictEqual(res.openPath, fs.realpathSync.native(real));
    assert.match(res.message, /^A workspace called "Real Target" already exists/);
  });

  test('on a case-insensitive disk, a name in other case offers the folder as it is spelled', async (t) => {
    const dir = path.join(os.homedir(), 'Documents', 'Rundock', 'Acme');
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(path.join(os.homedir(), 'Documents', 'Rundock', 'acme'))) {
      t.skip('this disk is case-sensitive, so "acme" is a different name');
      return;
    }
    const res = await request({ type: 'create_workspace', name: 'acme' },
      m => m.type === 'workspace_name_taken', 'workspace_name_taken in other case');
    assert.strictEqual(path.basename(res.openPath), 'Acme', 'opened as Acme, so recents gain no duplicate');
    assert.match(res.message, /^A workspace called "Acme" already exists/);
  });

  test('a folder made between the check and the create is refused the same way, not reused', async () => {
    // The existence check and the mkdir are two steps; the mkdir must not be
    // recursive, or a folder that appears between them is scaffolded over.
    const dir = path.join(os.homedir(), 'Documents', 'Rundock', 'Raced');
    fs.mkdirSync(dir, { recursive: true });
    const own = '# Raced\n';
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), own);
    const realExists = fs.existsSync;
    fs.existsSync = (p) => (p === dir ? false : realExists(p));
    const workspaceBefore = h.internal.getWorkspace();
    try {
      const res = await request({ type: 'create_workspace', name: 'Raced' },
        m => m.type === 'workspace_name_taken' || m.type === 'workspace_set', 'reply to a raced create');
      assert.strictEqual(res.type, 'workspace_name_taken');
    } finally {
      fs.existsSync = realExists;
      h.internal.setWorkspace(workspaceBefore);
    }
    assert.deepStrictEqual(fs.readdirSync(dir), ['CLAUDE.md'], 'nothing added beside it');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf-8'), own);
  });

  test('a name that lost characters says so and where it will go, and makes nothing yet', async () => {
    const res = await request({ type: 'create_workspace', name: 'My/Test:Space?' },
      m => m.type === 'workspace_name_notice', 'workspace_name_notice');
    assert.strictEqual(res.name, 'MyTestSpace');
    assert.strictEqual(res.message,
      'Rundock removed /, : and ? from the name. Press Create again to make the folder at ~/Documents/Rundock/MyTestSpace');
    assert.ok(!fs.existsSync(path.join(os.homedir(), 'Documents', 'Rundock', 'MyTestSpace')), 'nothing made before the second press');

    const one = await request({ type: 'create_workspace', name: 'a/b' },
      m => m.type === 'workspace_name_notice', 'workspace_name_notice single');
    assert.strictEqual(one.message,
      'Rundock removed / from the name. Press Create again to make the folder at ~/Documents/Rundock/ab');
  });

  test('creates under HOME/Documents/Rundock, scaffolds, and announces the full boot set', async () => {
    const since = client.messages.length;
    // The name the notice put in the field, sent on the second press.
    client.send({ type: 'create_workspace', name: 'MyTestSpace' });

    const wsSet = (await client.waitFor(m => m.type === 'workspace_set', { since, label: 'workspace_set' })).msg;
    const expectedDir = path.join(os.homedir(), 'Documents', 'Rundock', 'MyTestSpace');
    assert.strictEqual(wsSet.path, expectedDir);
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
