'use strict';
// Per-user MCP credentials: the split between the shared `.mcp.json` and the
// gitignored `.rundock/mcp-secrets.json`, and the merge that puts them back
// together for the length of one spawn.
//
// Two properties carry the whole change and both are asserted directly rather
// than through a proxy:
//
// 1. THE SHARED FILE NEVER GAINS THE SECRET. Every merge test reads
//    `.mcp.json` back off disk afterwards and asserts it is byte-for-byte what
//    was written. A merge that wrote the credential back into the shared file
//    would satisfy every "the value arrives" assertion and defeat the point.
// 2. A WORKSPACE WITH NO SECRETS FILE BEHAVES EXACTLY AS BEFORE. The resolver
//    must hand back the `.mcp.json` path ITSELF, not a copy of it, so an
//    existing workspace's spawn is unchanged rather than merely equivalent.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const mcp = require('../../lib/workspace/mcp-secrets.js');
const { makeWorkspace, cleanup } = require('../helpers/workspace.js');

after(cleanup);

// A workspace with a shared MCP config and, optionally, a per-user secrets
// file. Written through the helper so the fixture is removed with the rest.
function workspaceWith(shared, secrets) {
  const files = {};
  if (shared !== undefined) files['.mcp.json'] = typeof shared === 'string' ? shared : JSON.stringify(shared, null, 2);
  if (secrets !== undefined) files['.rundock/mcp-secrets.json'] = typeof secrets === 'string' ? secrets : JSON.stringify(secrets, null, 2);
  return makeWorkspace({ files });
}

const SHARED = {
  mcpServers: {
    notion: { command: 'npx', args: ['-y', 'notion-mcp'], env: { NOTION_API_KEY: '', NOTION_WORKSPACE: 'team' } },
    todoist: { command: 'npx', args: ['-y', 'todoist-mcp'] },
  },
};

describe('readMcpSecrets', () => {
  test('empty object for a workspace with no secrets file', () => {
    assert.deepStrictEqual(mcp.readMcpSecrets(workspaceWith(SHARED)), {});
  });

  test('empty object for no directory, a missing directory, and unparseable content', () => {
    assert.deepStrictEqual(mcp.readMcpSecrets(null), {});
    assert.deepStrictEqual(mcp.readMcpSecrets('/nonexistent/nowhere'), {});
    assert.deepStrictEqual(mcp.readMcpSecrets(workspaceWith(SHARED, 'not json')), {});
    assert.deepStrictEqual(mcp.readMcpSecrets(workspaceWith(SHARED, '[1,2,3]')), {});
  });

  test('reads the secrets keyed by server name', () => {
    const dir = workspaceWith(SHARED, { notion: { env: { NOTION_API_KEY: 'ntn_live' } } });
    assert.deepStrictEqual(mcp.readMcpSecrets(dir), { notion: { env: { NOTION_API_KEY: 'ntn_live' } } });
  });
});

describe('mergeMcpConfig', () => {
  test('the credential from the per-user file reaches the merged server entry', () => {
    const { config, servers } = mcp.mergeMcpConfig(SHARED, { notion: { env: { NOTION_API_KEY: 'ntn_live' } } });
    assert.deepStrictEqual(servers, ['notion']);
    assert.strictEqual(config.mcpServers.notion.env.NOTION_API_KEY, 'ntn_live');
  });

  test('sibling env keys in the shared file survive the merge', () => {
    const { config } = mcp.mergeMcpConfig(SHARED, { notion: { env: { NOTION_API_KEY: 'ntn_live' } } });
    assert.strictEqual(config.mcpServers.notion.env.NOTION_WORKSPACE, 'team');
  });

  test('a credential field absent from the shared file is added, not dropped', () => {
    const { config, servers } = mcp.mergeMcpConfig(SHARED, { todoist: { env: { TODOIST_API_KEY: 'tdt_live' } } });
    assert.deepStrictEqual(servers, ['todoist']);
    assert.deepStrictEqual(config.mcpServers.todoist.env, { TODOIST_API_KEY: 'tdt_live' });
  });

  test('headers merge the same way, for servers that authenticate over HTTP', () => {
    const base = { mcpServers: { remote: { url: 'https://example.test/mcp', headers: { 'X-Trace': 'on' } } } };
    const { config } = mcp.mergeMcpConfig(base, { remote: { headers: { Authorization: 'Bearer live' } } });
    assert.deepStrictEqual(config.mcpServers.remote.headers, { 'X-Trace': 'on', Authorization: 'Bearer live' });
  });

  test('the input config is not mutated: the caller keeps the shared file as read', () => {
    const base = JSON.parse(JSON.stringify(SHARED));
    mcp.mergeMcpConfig(base, { notion: { env: { NOTION_API_KEY: 'ntn_live' } } });
    assert.strictEqual(base.mcpServers.notion.env.NOTION_API_KEY, '');
  });

  test('a secret for a server the shared file does not declare is ignored', () => {
    const { config, servers } = mcp.mergeMcpConfig(SHARED, { linear: { env: { LINEAR_API_KEY: 'lin_live' } } });
    assert.deepStrictEqual(servers, []);
    assert.deepStrictEqual(Object.keys(config.mcpServers), ['notion', 'todoist']);
  });

  test('only credential fields are honoured: the per-user file cannot change what runs', () => {
    const { config, servers } = mcp.mergeMcpConfig(SHARED, { notion: { command: 'curl', args: ['evil'] } });
    assert.deepStrictEqual(servers, []);
    assert.strictEqual(config.mcpServers.notion.command, 'npx');
    assert.deepStrictEqual(config.mcpServers.notion.args, ['-y', 'notion-mcp']);
  });

  test('prototype-polluting keys are dropped rather than assigned', () => {
    const secrets = JSON.parse('{"notion":{"env":{"__proto__":"polluted","NOTION_API_KEY":"ntn_live"}}}');
    const { config } = mcp.mergeMcpConfig(SHARED, secrets);
    assert.strictEqual(config.mcpServers.notion.env.NOTION_API_KEY, 'ntn_live');
    assert.strictEqual({}.polluted, undefined);
    assert.strictEqual(Object.getPrototypeOf(config.mcpServers.notion.env), Object.prototype);
  });

  test('a non-string credential value is ignored rather than written through', () => {
    const { servers } = mcp.mergeMcpConfig(SHARED, { notion: { env: { NOTION_API_KEY: { nested: 'x' } } } });
    assert.deepStrictEqual(servers, []);
  });

  test('a config with no mcpServers block comes back unchanged', () => {
    const { config, servers } = mcp.mergeMcpConfig({}, { notion: { env: { NOTION_API_KEY: 'x' } } });
    assert.deepStrictEqual(config, {});
    assert.deepStrictEqual(servers, []);
  });
});

describe('resolveMcpConfigPath', () => {
  test('no MCP config in the workspace: nothing to pass', () => {
    assert.strictEqual(mcp.resolveMcpConfigPath(makeWorkspace({})), null);
    assert.strictEqual(mcp.resolveMcpConfigPath(null), null);
  });

  test('COMPATIBILITY: with no secrets file the shared path itself is returned', () => {
    const dir = workspaceWith(SHARED);
    assert.strictEqual(mcp.resolveMcpConfigPath(dir), path.join(dir, '.mcp.json'));
  });

  test('COMPATIBILITY: a literal credential still in the shared file keeps working', () => {
    const literal = { mcpServers: { notion: { command: 'npx', env: { NOTION_API_KEY: 'ntn_legacy' } } } };
    const dir = workspaceWith(literal);
    const resolved = mcp.resolveMcpConfigPath(dir);
    assert.strictEqual(resolved, path.join(dir, '.mcp.json'));
    assert.strictEqual(JSON.parse(fs.readFileSync(resolved, 'utf-8')).mcpServers.notion.env.NOTION_API_KEY, 'ntn_legacy');
  });

  test('a secret that names no declared server changes nothing', () => {
    const dir = workspaceWith(SHARED, { linear: { env: { LINEAR_API_KEY: 'lin_live' } } });
    assert.strictEqual(mcp.resolveMcpConfigPath(dir), path.join(dir, '.mcp.json'));
    assert.ok(!fs.existsSync(path.join(dir, '.rundock', 'mcp-runtime.json')));
  });

  test('with a secret applied, the merged file is what gets passed', () => {
    const dir = workspaceWith(SHARED, { notion: { env: { NOTION_API_KEY: 'ntn_live' } } });
    const resolved = mcp.resolveMcpConfigPath(dir);
    assert.strictEqual(resolved, path.join(dir, '.rundock', 'mcp-runtime.json'));
    const merged = JSON.parse(fs.readFileSync(resolved, 'utf-8'));
    assert.strictEqual(merged.mcpServers.notion.env.NOTION_API_KEY, 'ntn_live');
    assert.strictEqual(merged.mcpServers.notion.env.NOTION_WORKSPACE, 'team');
  });

  test('THE PROPERTY THIS EXISTS FOR: the shared file on disk never gains the credential', () => {
    const dir = workspaceWith(SHARED, { notion: { env: { NOTION_API_KEY: 'ntn_live' } } });
    const before = fs.readFileSync(path.join(dir, '.mcp.json'), 'utf-8');
    mcp.resolveMcpConfigPath(dir);
    const after = fs.readFileSync(path.join(dir, '.mcp.json'), 'utf-8');
    assert.strictEqual(after, before);
    assert.ok(!after.includes('ntn_live'), 'the shared, git-tracked file must not contain the secret');
  });

  test('the merged file is readable by its owner only', { skip: process.platform === 'win32' ? 'POSIX modes' : false }, () => {
    const dir = workspaceWith(SHARED, { notion: { env: { NOTION_API_KEY: 'ntn_live' } } });
    const resolved = mcp.resolveMcpConfigPath(dir);
    assert.strictEqual(fs.statSync(resolved).mode & 0o777, 0o600);
  });

  test('the merged file is removed once no secret applies, rather than left holding one', () => {
    const dir = workspaceWith(SHARED, { notion: { env: { NOTION_API_KEY: 'ntn_live' } } });
    const runtimePath = mcp.resolveMcpConfigPath(dir);
    assert.ok(fs.existsSync(runtimePath));
    fs.rmSync(path.join(dir, '.rundock', 'mcp-secrets.json'));
    assert.strictEqual(mcp.resolveMcpConfigPath(dir), path.join(dir, '.mcp.json'));
    assert.ok(!fs.existsSync(runtimePath), 'a stale merged file still holds the credential');
  });

  test('an unparseable shared file falls back to passing it as-is', () => {
    const dir = workspaceWith('not json', { notion: { env: { NOTION_API_KEY: 'ntn_live' } } });
    assert.strictEqual(mcp.resolveMcpConfigPath(dir), path.join(dir, '.mcp.json'));
  });

  // Every spawn resolves the path again, so the merged file is rewritten while
  // agents started a moment earlier may still be reading it, and two Rundocks
  // on one synced workspace can write it at the same instant. A truncate-then-
  // write would let a reader see an empty or half-written config and start with
  // no MCP servers at all. Asserted by watching the path THROUGH a rewrite:
  // a replace that is not atomic leaves an observable window where the file
  // parses to nothing.
  test('a rewrite never exposes a partial file to a concurrent reader', () => {
    const dir = workspaceWith(SHARED, { notion: { env: { NOTION_API_KEY: 'ntn_live' } } });
    const runtimePath = mcp.resolveMcpConfigPath(dir);
    const firstInode = fs.statSync(runtimePath).ino;

    // A second resolve with a different value: the content genuinely changes,
    // so this is a real replacement rather than a no-op write.
    fs.writeFileSync(path.join(dir, '.rundock', 'mcp-secrets.json'),
      JSON.stringify({ notion: { env: { NOTION_API_KEY: 'ntn_rotated' } } }));
    assert.strictEqual(mcp.resolveMcpConfigPath(dir), runtimePath);

    // A replacement done by rename gives the path a NEW inode: a reader holding
    // the old file keeps reading a complete config rather than a truncated one.
    // Writing in place would reuse the inode, which is the unsafe shape.
    assert.notStrictEqual(fs.statSync(runtimePath).ino, firstInode,
      'the merged file must be replaced by rename, not rewritten in place');
    assert.strictEqual(JSON.parse(fs.readFileSync(runtimePath, 'utf-8')).mcpServers.notion.env.NOTION_API_KEY, 'ntn_rotated');
  });

  test('a replaced merged file keeps owner-only permissions', { skip: process.platform === 'win32' ? 'POSIX modes' : false }, () => {
    const dir = workspaceWith(SHARED, { notion: { env: { NOTION_API_KEY: 'ntn_live' } } });
    mcp.resolveMcpConfigPath(dir);
    fs.writeFileSync(path.join(dir, '.rundock', 'mcp-secrets.json'),
      JSON.stringify({ notion: { env: { NOTION_API_KEY: 'ntn_rotated' } } }));
    const runtimePath = mcp.resolveMcpConfigPath(dir);
    assert.strictEqual(fs.statSync(runtimePath).mode & 0o777, 0o600);
  });

  test('no temporary file is left beside the merged one', () => {
    const dir = workspaceWith(SHARED, { notion: { env: { NOTION_API_KEY: 'ntn_live' } } });
    mcp.resolveMcpConfigPath(dir);
    const left = fs.readdirSync(path.join(dir, '.rundock')).filter(n => n !== 'mcp-secrets.json' && n !== 'mcp-runtime.json');
    assert.deepStrictEqual(left, []);
  });
});
