'use strict';
// The workspace file-access boundary.
//
// The boundary contract: anything outside the workspace requires a
// permission card UNLESS a standing per-workspace grant covers it, and
// standing grants are at the folder level, never machine-wide. Enforcement
// lives in the PreToolUse hook (classification) and the server (grants);
// the incident this closes: an agent wrote the workspace CLAUDE.md to the
// user's HOME DIRECTORY silently, because Write/Edit were allowed
// everywhere under acceptEdits and file tools never reached the hook.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { classifyFileAccess } = require('../../scripts/permission-hook.js');
const { _internal: srv } = require('../../server.js');
const { makeWorkspace, cleanup } = require('../helpers/workspace.js');

after(cleanup);

describe('classifyFileAccess (hook-side)', () => {
  const ws = '/tmp/boundary-ws';
  test('non-file tools are not classified', () => {
    assert.strictEqual(classifyFileAccess('Bash', { command: 'ls ~' }, ws, []), null);
    assert.strictEqual(classifyFileAccess('WebFetch', { url: 'https://x' }, ws, []), null);
  });

  test('in-workspace targets are inside, relative paths resolve against the workspace', () => {
    assert.strictEqual(classifyFileAccess('Write', { file_path: path.join(ws, 'notes.md') }, ws, []).where, 'inside');
    assert.strictEqual(classifyFileAccess('Write', { file_path: 'CLAUDE.md' }, ws, []).where, 'inside');
    assert.strictEqual(classifyFileAccess('Edit', { file_path: 'sub/dir/file.md' }, ws, []).where, 'inside');
    assert.strictEqual(classifyFileAccess('Read', { file_path: './a.md' }, ws, []).where, 'inside');
  });

  test('outside targets are outside, with the resolved path reported', () => {
    const home = os.homedir();
    const r = classifyFileAccess('Write', { file_path: path.join(home, 'CLAUDE.md') }, ws, []);
    assert.strictEqual(r.where, 'outside');
    assert.strictEqual(r.resolvedPath, path.join(home, 'CLAUDE.md'));
    // Prefix trickery is not inside: /tmp/boundary-ws-evil shares the string prefix.
    assert.strictEqual(classifyFileAccess('Write', { file_path: ws + '-evil/x.md' }, ws, []).where, 'outside');
    // Traversal out of the workspace is outside.
    assert.strictEqual(classifyFileAccess('Edit', { file_path: '../outside.md' }, ws, []).where, 'outside');
  });

  test('every file tool and its path field is covered', () => {
    const home = os.homedir();
    assert.strictEqual(classifyFileAccess('NotebookEdit', { notebook_path: path.join(home, 'n.ipynb') }, ws, []).where, 'outside');
    assert.strictEqual(classifyFileAccess('MultiEdit', { file_path: path.join(home, 'm.md') }, ws, []).where, 'outside');
    assert.strictEqual(classifyFileAccess('Read', { file_path: path.join(home, 'secrets.txt') }, ws, []).where, 'outside');
    // Glob/Grep card only when an explicit outside path is given; default cwd scan is inside.
    assert.strictEqual(classifyFileAccess('Glob', { pattern: '**/*.md' }, ws, []).where, 'inside');
    assert.strictEqual(classifyFileAccess('Grep', { pattern: 'x', path: home }, ws, []).where, 'outside');
  });

  test('extra allowed roots count as inside', () => {
    const extra = '/tmp/boundary-extra';
    const r = classifyFileAccess('Write', { file_path: path.join(extra, 'f.md') }, ws, [extra]);
    assert.strictEqual(r.where, 'inside');
  });
});

describe('boundary grants (server-side, persisted in the workspace)', () => {
  test('grants persist to .rundock/permissions.json and cover the granted subtree only', () => {
    const dir = makeWorkspace({ agents: [] });
    srv.setWorkspace(dir);
    assert.strictEqual(srv.boundaryGrantCovers('/Users/x/Exports/file.md'), false, 'no grants yet');
    srv.addBoundaryGrant('/Users/x/Exports');
    assert.strictEqual(srv.boundaryGrantCovers('/Users/x/Exports/file.md'), true);
    assert.strictEqual(srv.boundaryGrantCovers('/Users/x/Exports/deep/nested.md'), true, 'subtree covered');
    assert.strictEqual(srv.boundaryGrantCovers('/Users/x/Exports-evil/f.md'), false, 'prefix trickery excluded');
    assert.strictEqual(srv.boundaryGrantCovers('/Users/x/other.md'), false, 'siblings not covered');
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, '.rundock', 'permissions.json'), 'utf-8'));
    assert.deepStrictEqual(onDisk.allowedDirs, ['/Users/x/Exports'], 'workspace-encoded, folder-level');
  });

  test('grants are per workspace: a new workspace starts with none', () => {
    const dir2 = makeWorkspace({ agents: [] });
    srv.setWorkspace(dir2);
    assert.strictEqual(srv.boundaryGrantCovers('/Users/x/Exports/file.md'), false,
      'the previous workspace grant must not leak');
  });
});
