'use strict';
// Integration: HTTP endpoints, path-traversal guards, and the permission
// bridge (/api/permission-request long-poll <-> WebSocket permission cards).
// RUNDOCK_PERMISSION_TIMEOUT_MS is shortened via the env override so the
// auto-deny path is tested deterministically without a 120s wait.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../helpers/harness.js');

const PERM_TIMEOUT = 400;
let client;

before(async () => {
  await h.boot({
    env: { RUNDOCK_PERMISSION_TIMEOUT_MS: String(PERM_TIMEOUT) },
    workspaceOpts: { files: { 'notes.md': 'workspace note content', 'sub/inner.md': 'inner file' } },
  });
  client = await h.connect();
});
after(async () => h.shutdown());

function get(urlPath) {
  return fetch(`http://127.0.0.1:${h.port}${urlPath}`).then(async res => ({
    status: res.status, body: await res.text(), headers: res.headers,
  }));
}

function postJson(urlPath, body) {
  return fetch(`http://127.0.0.1:${h.port}${urlPath}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then(async res => ({ status: res.status, body: await res.text() }));
}

describe('static + JSON endpoints', () => {
  test('/ serves index.html with no-cache', async () => {
    const res = await get('/');
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.includes('<html') || res.body.includes('<!DOCTYPE'), 'html served');
    assert.strictEqual(res.headers.get('cache-control'), 'no-cache, no-store, must-revalidate');
  });

  test('/app.js and /marked.min.js are served as javascript', async () => {
    const app = await get('/app.js');
    assert.strictEqual(app.status, 200);
    const marked = await get('/marked.min.js');
    assert.strictEqual(marked.status, 200);
  });

  test('every local script tag in index.html resolves to a live route', async () => {
    // code-language.js shipped in 0.10.0 with a script tag but no serving
    // route; a defensive fallback in app.js masked the 404 so the browser
    // silently ran without it. This test makes that class unshippable: any
    // local script index.html references must serve as javascript.
    const html = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf-8');
    const srcs = [...html.matchAll(/<script[^>]+src="(\/[^"]+)"/g)].map(m => m[1])
      .filter(s => !s.startsWith('http'));
    assert.ok(srcs.length >= 3, `sanity: found ${srcs.length} local scripts`);
    for (const src of srcs) {
      const res = await get(src);
      assert.strictEqual(res.status, 200, `${src} must serve (script tag without a route)`);
      assert.match(res.headers.get('content-type') || '', /javascript/, `${src} content type`);
    }
  });

  test('top-level module route rejects unknown files and non-module paths', async () => {
    assert.strictEqual((await get('/no-such-module.js')).status, 404);
    // Traversal cannot be expressed in the route pattern (no slashes or
    // non-extension dots), so these fall through to the 404 handler.
    assert.strictEqual((await get('/..%2Fserver.js')).status, 404);
    assert.strictEqual((await get('/markers.min.map')).status, 404);
  });

  test('/api/agents returns the discovered team as JSON', async () => {
    const res = await get('/api/agents');
    assert.strictEqual(res.status, 200);
    const agents = JSON.parse(res.body);
    assert.ok(agents.find(a => a.id === 'chief-of-staff'));
  });

  test('/api/files returns the workspace tree', async () => {
    const res = await get('/api/files');
    const tree = JSON.parse(res.body);
    assert.ok(tree.find(e => e.name === 'notes.md'));
  });

  test('unknown route is 404', async () => {
    const res = await get('/definitely-not-a-route');
    assert.strictEqual(res.status, 404);
  });
});

describe('path traversal guards', () => {
  test('/api/file serves workspace files', async () => {
    const res = await get('/api/file?path=notes.md');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body, 'workspace note content');
    const nested = await get('/api/file?path=' + encodeURIComponent('sub/inner.md'));
    assert.strictEqual(nested.body, 'inner file');
  });

  test('/api/file blocks ../ traversal out of the workspace', async () => {
    // Plant a secret OUTSIDE the workspace
    const outside = path.join(h.workspaceDir, '..', `outside-secret-${Date.now()}.txt`);
    fs.writeFileSync(outside, 'secret data');
    try {
      const res = await get('/api/file?path=' + encodeURIComponent('../' + path.basename(outside)));
      assert.strictEqual(res.status, 404, 'traversal must be rejected');
      assert.ok(!res.body.includes('secret data'));
      const abs = await get('/api/file?path=' + encodeURIComponent(outside));
      assert.ok(!abs.body.includes('secret data'), 'absolute path must not leak');
    } finally {
      fs.unlinkSync(outside);
    }
  });

  test('a sibling directory sharing the workspace name prefix is blocked on /api/file', async () => {
    // Post-fix: the boundary compares against WORKSPACE + path.sep, so a sibling
    // sharing the name prefix no longer passes. Regression companion in regression.test.js.
    const sibling = h.workspaceDir + '-evil';
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(sibling, 'leak.txt'), 'sibling secret');
    try {
      const res = await get('/api/file?path=' + encodeURIComponent(`../${path.basename(sibling)}/leak.txt`));
      assert.strictEqual(res.status, 404, 'sibling-prefix path must be rejected');
      assert.ok(!res.body.includes('sibling secret'), 'sibling content must not leak');
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true });
    }
  });

  test('/editor and /vendor static routes reject traversal and unknown extensions', async () => {
    assert.strictEqual((await get('/editor/../server.js')).status, 404);
    assert.strictEqual((await get('/vendor/x.png')).status, 404);
    assert.strictEqual((await get('/editor/%2e%2e/server.js')).status, 404);
  });

  test('WS read_file is guarded the same way as /api/file', async () => {
    const outside = path.join(h.workspaceDir, '..', `ws-secret-${Date.now()}.md`);
    fs.writeFileSync(outside, 'ws secret');
    try {
      client.send({ type: 'read_file', path: 'notes.md' });
      const { msg } = await client.waitFor(m => m.type === 'file_content' && m.path === 'notes.md', { label: 'file_content' });
      assert.strictEqual(msg.content, 'workspace note content');

      const since = client.messages.length;
      client.send({ type: 'read_file', path: '../' + path.basename(outside) });
      client.send({ type: 'read_file', path: 'notes.md' }); // sentinel: proves the previous send was processed
      const { msg: sentinel } = await client.waitFor(m => m.type === 'file_content', { since, label: 'sentinel read' });
      assert.strictEqual(sentinel.path, 'notes.md', 'traversal read produced no response');
    } finally {
      fs.unlinkSync(outside);
    }
  });

  test('WS save_file writes inside the workspace and silently drops traversal attempts', async () => {
    client.send({ type: 'save_file', path: 'saved.md', content: 'saved content' });
    await client.waitFor(m => m.type === 'file_saved' && m.path === 'saved.md', { label: 'file_saved' });
    assert.strictEqual(fs.readFileSync(path.join(h.workspaceDir, 'saved.md'), 'utf-8'), 'saved content');

    const evilTarget = path.join(h.workspaceDir, '..', `evil-write-${Date.now()}.md`);
    client.send({ type: 'save_file', path: '../' + path.basename(evilTarget), content: 'evil' });
    client.send({ type: 'save_file', path: 'sentinel.md', content: 'sentinel' });
    await client.waitFor(m => m.type === 'file_saved' && m.path === 'sentinel.md', { label: 'sentinel save' });
    assert.strictEqual(fs.existsSync(evilTarget), false, 'traversal write blocked');
  });
});

describe('permission bridge', () => {
  test('hook request is forwarded as a control_request card; allow resolves the long-poll with {allow:true}', async () => {
    const since = client.messages.length;
    const pending = postJson('/api/permission-request', {
      tool_name: 'Bash', tool_input: { command: 'ls -la' }, conversation_id: 'convo-perm-1',
    });
    const { msg: card } = await client.waitFor(m => m.type === 'control_request', { since, label: 'permission card' });
    assert.strictEqual(card.request.subtype, 'can_use_tool');
    assert.strictEqual(card.request.tool_name, 'Bash');
    assert.deepStrictEqual(card.request.input, { command: 'ls -la' });
    assert.strictEqual(card._conversationId, 'convo-perm-1');

    client.send({ type: 'permission_response', requestId: card.request_id, allow: true, conversationId: 'convo-perm-1' });
    const res = await pending;
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(JSON.parse(res.body), { allow: true });
  });

  test('deny resolves with {allow:false}', async () => {
    const since = client.messages.length;
    const pending = postJson('/api/permission-request', { tool_name: 'Bash', tool_input: { command: 'rm -rf /' }, conversation_id: 'convo-perm-2' });
    const { msg: card } = await client.waitFor(m => m.type === 'control_request', { since, label: 'permission card' });
    client.send({ type: 'permission_response', requestId: card.request_id, allow: false, conversationId: 'convo-perm-2' });
    const res = await pending;
    assert.deepStrictEqual(JSON.parse(res.body), { allow: false });
  });

  test('timeout auto-denies with reason and notifies the browser', async () => {
    const since = client.messages.length;
    const t0 = Date.now();
    const pending = postJson('/api/permission-request', { tool_name: 'Bash', tool_input: { command: 'sleep 1' }, conversation_id: 'convo-perm-3' });
    const res = await pending; // no permission_response sent: must auto-deny at PERM_TIMEOUT
    assert.deepStrictEqual(JSON.parse(res.body), { allow: false, reason: 'timeout' });
    assert.ok(Date.now() - t0 >= PERM_TIMEOUT - 50, 'held until the timeout');
    const { msg: timeoutMsg } = await client.waitFor(m => m.type === 'permission_timeout', { since, label: 'permission_timeout' });
    assert.strictEqual(timeoutMsg._conversationId, 'convo-perm-3');
  });

  test('stale permission_response (already resolved) is ignored without crashing', async () => {
    client.send({ type: 'permission_response', requestId: 'perm-nonexistent', allow: true });
    // sentinel roundtrip proves the server is still healthy
    const since = client.messages.length;
    client.send({ type: 'get_agents' });
    await client.waitFor(m => m.type === 'agents', { since, label: 'agents after stale response' });
  });

  test('malformed body returns 400', async () => {
    const res = await fetch(`http://127.0.0.1:${h.port}/api/permission-request`, { method: 'POST', body: 'not json' });
    assert.strictEqual(res.status, 400);
  });

  test('cancel auto-denies pending permission requests for that conversation', async () => {
    const convoId = h.freshConvoId();
    h.writeScenario([{ match: { promptIncludes: 'needs permission' }, delayMs: 5000, turn: [{ text: 'never arrives' }] }]);
    client.send({ type: 'chat', conversationId: convoId, agent: 'lead-designer', content: 'needs permission' });
    await client.waitForEvent('system', 'process_started', convoId);

    const pending = postJson('/api/permission-request', { tool_name: 'Bash', tool_input: { command: 'ls' }, conversation_id: convoId });
    await client.waitFor(m => m.type === 'control_request' && m._conversationId === convoId, { label: 'card before cancel' });

    client.send({ type: 'cancel', conversationId: convoId });
    const res = await pending;
    assert.deepStrictEqual(JSON.parse(res.body), { allow: false, reason: 'cancelled' });
  });

  test('reconnecting client receives pending permission cards again', async () => {
    const pending = postJson('/api/permission-request', { tool_name: 'Bash', tool_input: { command: 'pwd' }, conversation_id: 'convo-perm-4' });
    const { msg: card } = await client.waitFor(m => m.type === 'control_request' && m._conversationId === 'convo-perm-4', { label: 'original card' });

    const client2 = await h.connect();
    const { msg: replayed } = await client2.waitFor(m => m.type === 'control_request' && m._conversationId === 'convo-perm-4', { label: 'replayed card' });
    assert.strictEqual(replayed.request_id, card.request_id);

    client2.send({ type: 'permission_response', requestId: card.request_id, allow: true });
    const res = await pending;
    assert.deepStrictEqual(JSON.parse(res.body), { allow: true });
    client2.close();
  });
});

describe('agent + skill CRUD over WS', () => {
  test('save_agent creates the file, auto-assigns type/order, refreshes rosters, marks setup complete', async () => {
    // Warm the agent cache first so the cache-staleness race would fire without
    // the fix: a warm (<2s) cache means the post-save broadcast must invalidate
    // before discovering, or it omits the new agent.
    h.internal.discoverAgents();

    const since = client.messages.length;
    client.send({ type: 'save_agent', name: 'sales-coach', content: '---\nname: sales-coach\ndisplayName: Sollo\nrole: Sales Coach\ndescription: Sales prep\n---\nYou are Sollo.\n' });
    const { msg: saved } = await client.waitFor(m => m.type === 'agent_saved', { since, label: 'agent_saved' });
    assert.strictEqual(saved.agentId, 'sales-coach');
    assert.strictEqual(saved.updated, false);

    const file = path.join(h.workspaceDir, '.claude', 'agents', 'sales-coach.md');
    const content = fs.readFileSync(file, 'utf-8');
    assert.match(content, /^type: specialist$/m, 'type auto-assigned');
    assert.match(content, /^order: \d+$/m, 'order auto-assigned');
    // with a description present, injection lands AFTER it (valid frontmatter)
    assert.match(content, /^---\nname: sales-coach/m, 'opening fence intact');

    // The handler invalidates the cache BEFORE discovering, so even with a warm
    // cache the FIRST roster broadcast already includes the new agent.
    // Regression companion in regression.test.js.
    const { msg: firstRoster } = await client.waitFor(m => m.type === 'agents', { since, label: 'agents refresh' });
    assert.ok(firstRoster.agents.find(a => a.id === 'sales-coach'),
      'new agent present in the first post-save broadcast');
    assert.strictEqual(h.internal.readState().setupComplete, true);
  });

  test('save_agent on a description-less file keeps the frontmatter valid', async () => {
    // Post-fix: with no `description:` line, the type/order injection lands
    // AFTER the opening fence (inside the block) instead of before it, so the
    // declared name/displayName/role survive. Regression companion in
    // regression.test.js.
    const since = client.messages.length;
    client.send({ type: 'save_agent', name: 'nodesc-agent', content: '---\nname: nodesc-agent\ndisplayName: RealName\nrole: Real Role\n---\nBody text.\n' });
    await client.waitFor(m => m.type === 'agent_saved' && m.agentId === 'nodesc-agent', { since, label: 'nodesc saved' });
    const raw = fs.readFileSync(path.join(h.workspaceDir, '.claude', 'agents', 'nodesc-agent.md'), 'utf-8');
    // the opening fence is intact and the injected keys are inside the block
    assert.match(raw, /^---\ntype: specialist\norder: \d+\nname: nodesc-agent/, 'type/order inserted inside frontmatter');
    // and the parsed agent keeps its declared identity
    const meta = h.internal.parseAgentFrontmatter(h.internal.readNormalisedFile(path.join(h.workspaceDir, '.claude', 'agents', 'nodesc-agent.md')));
    assert.strictEqual(meta.displayName, 'RealName', 'declared displayName preserved');
    assert.strictEqual(meta.name, 'nodesc-agent', 'declared name preserved as frontmatter');
    assert.strictEqual(meta.role, 'Real Role', 'declared role preserved');
    client.send({ type: 'delete_agent', agentId: 'nodesc-agent' });
    await client.waitFor(m => m.type === 'agent_deleted', { label: 'nodesc cleanup' });
  });

  test('save_agent with invalid slug is rejected and writes nothing', async () => {
    const since = client.messages.length;
    client.send({ type: 'save_agent', name: '../evil', content: 'x' });
    const { msg } = await client.waitFor(m => m.type === 'agent_error', { since, label: 'agent_error' });
    assert.match(msg.message, /Invalid agent name/);
    assert.strictEqual(fs.existsSync(path.join(h.workspaceDir, '.claude', 'evil.md')), false);
  });

  test('delete_agent removes user agents but refuses platform agents', async () => {
    let since = client.messages.length;
    client.send({ type: 'delete_agent', agentId: 'sales-coach' });
    await client.waitFor(m => m.type === 'agent_deleted' && m.agentId === 'sales-coach', { since, label: 'agent_deleted' });
    assert.strictEqual(fs.existsSync(path.join(h.workspaceDir, '.claude', 'agents', 'sales-coach.md')), false);

    since = client.messages.length;
    client.send({ type: 'delete_agent', agentId: 'rundock-guide' });
    const { msg } = await client.waitFor(m => m.type === 'agent_error', { since, label: 'platform delete refusal' });
    assert.match(msg.message, /Cannot delete platform agents/);
  });

  test('save_skill and delete_skill manage .claude/skills/<name>/SKILL.md', async () => {
    let since = client.messages.length;
    client.send({ type: 'save_skill', name: 'test-skill', content: '---\nname: Test Skill\ndescription: A test\n---\nDo the thing.' });
    await client.waitFor(m => m.type === 'skill_saved' && m.skillId === 'test-skill', { since, label: 'skill_saved' });
    const skillFile = path.join(h.workspaceDir, '.claude', 'skills', 'test-skill', 'SKILL.md');
    assert.ok(fs.existsSync(skillFile));

    since = client.messages.length;
    client.send({ type: 'delete_skill', name: 'test-skill' });
    await client.waitFor(m => m.type === 'skill_deleted' && m.skillId === 'test-skill', { since, label: 'skill_deleted' });
    assert.strictEqual(fs.existsSync(path.dirname(skillFile)), false);

    since = client.messages.length;
    client.send({ type: 'delete_skill', name: '../../etc' });
    const { msg } = await client.waitFor(m => m.type === 'skill_error', { since, label: 'skill_error' });
    assert.match(msg.message, /Invalid skill name/);
  });
});
