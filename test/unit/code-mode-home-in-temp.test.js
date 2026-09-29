'use strict';
// A home folder that sits inside a temp folder is still home.
//
// Code mode treats the temp folders as development paths: reads and writes
// there raise no card. That rule is about scratch space, and never reaches the
// person's own files: exactly as it never covers the workspace or a working
// folder, it never covers home when home happens to live inside a temp folder
// (a sandboxed or test machine, a throwaway account). The hidden folders under
// home, secrets, instruction files and every other file in home keep their own
// rules whatever folder home is in; the package caches under home stay free.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const hook = require('../../scripts/permission-hook.js');
const fx = require('../helpers/code-mode-fixture.js');
const devPaths = require('../../scripts/dev-paths.js');
const { codeModeVerdict } = require('../../scripts/code-mode-verdict.js');
const { gradeCodexApproval } = require('../../lib/runtime/codex-approval.js');

// The link needs a folder outside every temp folder: the fixture root.
const OUTSIDE = fx.outsideTempRoot();
const SKIP = OUTSIDE.skip || false;
let root, outside, link, home, ws;
before(() => {
  if (SKIP) return;
  // HOME IS GIVEN BY A NAME OUTSIDE EVERY TEMP FOLDER, AND REALLY LIVES INSIDE
  // ONE: a link, built here rather than borrowed from the machine. On macOS the
  // temp folder is itself a link (/tmp is /private/tmp), so home's given name
  // and its real name differ for free; on Linux they do not, and a check that
  // only ever compared home's given name would pass there unseen. With the
  // link outside the temp folder, only home's real name shows that it is in
  // one, on every platform.
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'home-in-temp-'));
  outside = OUTSIDE.dir;
  link = path.join(outside, 'home-link');
  fs.symlinkSync(root, link);
  home = path.join(link, 'home');
  ws = path.join(link, 'ws');
  for (const [f, s] of [
    ['.ssh/config', 'Host x\n'], ['.claude/.credentials.json', '{}\n'], ['.claude/CLAUDE.md', '# global\n'],
    ['.aws/credentials', '[default]\n'], ['notes.txt', 'notes\n'], ['.npm/_cacache/entry', 'cache\n'],
  ]) { fs.mkdirSync(path.dirname(path.join(home, f)), { recursive: true }); fs.writeFileSync(path.join(home, f), s); }
  fs.mkdirSync(path.join(ws, '.rundock'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.rundock', 'state.json'), '{"workspaceMode":"code"}\n');
});
after(() => {
  if (link) { try { fs.unlinkSync(link); } catch (e) { /* already gone */ } }
  if (OUTSIDE.dir) fs.rmSync(OUTSIDE.dir, { recursive: true, force: true });
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

const file = (tool, rel, extra = {}) => hook.classifyFileAccess(tool, { file_path: path.join(home, rel), ...extra }, ws, [], home, true, undefined, { codeMode: true });
const shell = (command) => hook.classifyShellAccess('Bash', { command }, ws, [], home, true, { cwd: ws, codeMode: true });

describe('the temp rule never covers a home folder inside a temp folder', { skip: SKIP }, () => {
  test('the development-path test itself', () => {
    const tmpdir = path.dirname(root);
    assert.strictEqual(devPaths.isDevPath(path.join(home, 'notes.txt'), { home, tmpdir }), false, 'a file in home');
    assert.strictEqual(devPaths.isDevPath(path.join(home, '.ssh', 'config'), { home, tmpdir }), false, 'a hidden folder in home');
    assert.strictEqual(devPaths.isDevPath(path.join(root, 'build.log'), { home, tmpdir }), true, 'the rest of the temp folder is still scratch');
    assert.strictEqual(devPaths.isDevPath(path.join(home, '.npm', '_cacache'), { home, tmpdir }), true, 'a package cache in home is still a cache');
  });

  test('on Windows, where the temp folder lives inside home, the temp folder is still scratch', () => {
    const opts = { platform: 'win32', home: 'C:\\Users\\dev', env: { TEMP: 'C:\\Users\\dev\\AppData\\Local\\Temp', LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local' } };
    assert.strictEqual(devPaths.isDevPath('C:\\Users\\dev\\AppData\\Local\\Temp\\app-build', opts), true);
    assert.strictEqual(devPaths.isDevPath('C:\\Users\\dev\\notes.txt', opts), false);
  });

  test('file tools: hidden folders, secrets and instruction files keep their cards in Code mode', () => {
    const ssh = file('Read', '.ssh/config');
    assert.ok(ssh && ssh.where === 'outside' && ssh.grantDir === null, 'a read of ~/.ssh asks and offers no folder');
    const cred = file('Read', '.claude/.credentials.json');
    assert.ok(cred && cred.where === 'outside' && cred.secret === true, 'a credentials read is a secret crossing');
    const instr = file('Write', '.claude/CLAUDE.md', { content: 'x' });
    assert.ok(instr && instr.where === 'outside' && instr.persistenceSurface === true, 'an instruction-file write is a persistence crossing');
    const plain = file('Write', 'notes.txt', { content: 'x' });
    assert.ok(plain && plain.where === 'outside', 'an ordinary file in home is still outside the workspace');
    assert.strictEqual(file('Read', '.npm/_cacache/entry').where, 'inside', 'the npm cache stays free');
  });

  test('shell commands: the same crossings in Code mode', () => {
    for (const c of [`cat ${home}/.ssh/config`, `cat ${home}/.aws/credentials`, `echo x >> ${home}/.claude/CLAUDE.md`, `touch ${home}/stray.txt`]) {
      const a = shell(c);
      assert.ok(a && a.where === 'outside', c);
    }
    assert.strictEqual(shell(`ls ${home}/.npm/_cacache`), null, 'the npm cache stays free');
  });

  test('a recursive delete in home is not disposable scratch', () => {
    const v = codeModeVerdict({ toolName: 'Bash', command: `rm -rf ${home}/.ssh`, cwd: ws, workspaceRoot: ws, extraDirs: [], home, tmpdir: path.dirname(root) });
    assert.strictEqual(v.verdict, 'always-asks');
  });

  test('Codex file changes in home are carded, not accepted as scratch', () => {
    const g = gradeCodexApproval({ kind: 'fileChange', params: { grantRoot: path.join(home, 'notes.txt'), reason: 'write' }, workspaceRoot: ws, extraDirs: [], codeMode: true, home });
    assert.strictEqual(g.decision, 'card');
  });
});
