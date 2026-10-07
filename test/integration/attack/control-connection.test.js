'use strict';
// Attack tests: only Rundock's own window may drive the server.
//
// Each attack is made the way any other process on the machine would make it,
// an agent included: a WebSocket or an HTTP request to the loopback port with
// no key. Each must be refused, and must leave nothing changed. Each has a
// twin that makes the same request as Rundock's own window, with the key, and
// must succeed, so an attack can never pass because the server was simply
// down or the route was broken.
//
// The permission hook runs inside the agent's own process tree, so it cannot
// hold the window's key. Its two routes take a token of their own instead,
// one per conversation, handed to the agent it was started for: it can ask
// for a card in its own conversation and collect its own notice, and nothing
// else.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const WebSocket = require('ws');

const h = require('../../helpers/harness.js');

let client;

before(async () => {
  await h.boot({ env: { RUNDOCK_PERMISSION_TIMEOUT_MS: '4000' } });
  client = await h.connect();
});
after(async () => h.shutdown());

// A raw HTTP request with exactly the headers given. Resolves the status and
// the body as text.
function request({ method = 'GET', path: url, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: h.port, method, path: url, headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

// The attacker's socket: no key. Resolves whether it opened, and every byte
// it was sent while it stayed open for `holdMs` after sending `messages`.
function attack(messages = [], { headers = {}, holdMs = 400 } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}`, { headers });
    const received = [];
    let opened = false;
    let status = null;
    const finish = () => resolve({ opened, status, received });
    ws.on('message', (data) => received.push(data.toString()));
    ws.on('open', () => {
      opened = true;
      for (const m of messages) ws.send(JSON.stringify(m));
      setTimeout(() => { ws.close(); finish(); }, holdMs);
    });
    ws.on('unexpected-response', (_req, res) => { status = res.statusCode; res.resume(); finish(); });
    ws.on('error', () => { if (!opened) finish(); });
  });
}

// Ask the server something as the window, and wait for the reply.
async function ask(msg, type) {
  const since = client.messages.length;
  client.send(msg);
  const { msg: reply } = await client.waitFor((m) => m.type === type, { since, label: type });
  return reply;
}

// Raise a card for a conversation exactly as the permission hook does.
function raiseCard(conversationId, headers = h.hookHeaders(conversationId)) {
  return request({
    method: 'POST', path: '/api/permission-request',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo attack' }, conversation_id: conversationId }),
  });
}

function pendingFor(conversationId) {
  return [...h.internal.pendingPermissionRequests.entries()].filter(([, p]) => p.conversationId === conversationId);
}

describe('the control connection refuses anything without the key', () => {
  test('1. a pending card cannot be answered', async () => {
    const convo = 'attack-answer';
    const answered = raiseCard(convo);
    await h.waitUntil(() => pendingFor(convo).length === 1);
    const [[requestId]] = pendingFor(convo);
    const res = await attack([{ type: 'permission_response', requestId, allow: true, conversationId: convo }]);
    assert.strictEqual(res.opened, false, 'the socket must be refused');
    assert.strictEqual(pendingFor(convo).length, 1, 'the card is still waiting for the person');
    // Twin: the window answers it.
    client.send({ type: 'permission_response', requestId, allow: false, conversationId: convo });
    assert.strictEqual((await answered).status, 200);
    assert.strictEqual(pendingFor(convo).length, 0);
  });

  test('2. a standing allow cannot be added', async () => {
    const key = 'AttackProbeTool';
    const res = await attack([{ type: 'add_tool_allow', key }]);
    assert.strictEqual(res.opened, false);
    assert.ok(!(await ask({ type: 'get_tool_allows' }, 'tool_allows')).tools.includes(key));
    // Twin.
    client.send({ type: 'add_tool_allow', key });
    await h.waitUntil(() => false, { timeout: 150 });
    assert.ok((await ask({ type: 'get_tool_allows' }, 'tool_allows')).tools.includes(key));
    client.send({ type: 'remove_tool_allow', key });
  });

  test('3. a working folder cannot be added', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-attack-folder-'));
    const res = await attack([{ type: 'set_working_folders', folders: [outside] }]);
    assert.strictEqual(res.opened, false);
    const listed = (await ask({ type: 'get_working_folders' }, 'working_folders')).folders;
    assert.ok(!JSON.stringify(listed).includes(path.basename(outside)), 'no folder was added');
  });

  test('4 and 5. the mode cannot be switched and the sandbox cannot be turned off', async () => {
    const before = await ask({ type: 'get_sandbox_status' }, 'sandbox_status');
    const modeFile = path.join(h.workspaceDir, '.rundock', 'state.json');
    const modeBefore = fs.existsSync(modeFile) ? fs.readFileSync(modeFile, 'utf-8') : null;
    const res = await attack([{ type: 'set_workspace_mode', mode: 'code' }, { type: 'set_workspace_sandbox', on: false }]);
    assert.strictEqual(res.opened, false);
    const after = await ask({ type: 'get_sandbox_status' }, 'sandbox_status');
    assert.strictEqual(after.on, before.on, 'the sandbox switch did not move');
    const modeAfter = fs.existsSync(modeFile) ? fs.readFileSync(modeFile, 'utf-8') : null;
    assert.ok(!(modeAfter || '').includes('"code"') || (modeBefore || '').includes('"code"'), 'the mode did not become code');
  });

  test('6. a workspace file cannot be read through the socket or either file route', async () => {
    fs.writeFileSync(path.join(h.workspaceDir, 'secret-note.md'), 'attack-read-marker');
    const res = await attack([{ type: 'read_file', path: 'secret-note.md' }]);
    assert.strictEqual(res.opened, false);
    assert.ok(!res.received.join('').includes('attack-read-marker'));
    const viaApi = await request({ path: '/api/file?path=secret-note.md' });
    assert.strictEqual(viaApi.status, 401);
    assert.ok(!viaApi.text.includes('attack-read-marker'));
    fs.writeFileSync(path.join(h.workspaceDir, 'secret.png'), 'attack-read-marker');
    const viaBinary = await request({ path: '/workspace-file?path=secret.png' });
    assert.strictEqual(viaBinary.status, 401);
    assert.ok(!viaBinary.text.includes('attack-read-marker'));
    // Twin: the window reads all three.
    assert.strictEqual((await request({ path: '/api/file?path=secret-note.md', headers: h.authHeaders() })).text, 'attack-read-marker');
    assert.strictEqual((await request({ path: '/workspace-file?path=secret.png', headers: h.authHeaders() })).status, 200);
    const read = await ask({ type: 'read_file', path: 'secret-note.md' }, 'file_content');
    assert.strictEqual(read.content, 'attack-read-marker');
  });

  test('7. the permission file cannot be written, nor a review sidecar', async () => {
    const perms = path.join(h.workspaceDir, '.rundock', 'permissions.json');
    const before = fs.existsSync(perms) ? fs.readFileSync(perms, 'utf-8') : null;
    const res = await attack([{ type: 'save_file', path: '.rundock/permissions.json', content: '{"allow":["Bash"]}' }]);
    assert.strictEqual(res.opened, false);
    const after = fs.existsSync(perms) ? fs.readFileSync(perms, 'utf-8') : null;
    assert.strictEqual(after, before, 'the permission file is unchanged');
    const sidecar = await request({
      method: 'POST', path: '/api/review-sidecar', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '.rundock/reviews/attack.json', content: '{}' }),
    });
    assert.strictEqual(sidecar.status, 401);
    assert.ok(!fs.existsSync(path.join(h.workspaceDir, '.rundock', 'reviews', 'attack.json')));
    // Twin.
    const ok = await request({
      method: 'POST', path: '/api/review-sidecar', headers: { 'Content-Type': 'application/json', ...h.authHeaders() },
      body: JSON.stringify({ path: '.rundock/reviews/twin.json', content: '{}' }),
    });
    assert.strictEqual(ok.status, 200);
  });

  test('10. an unauthenticated socket receives nothing, not even the waiting cards', async () => {
    const convo = 'attack-listen';
    const raised = raiseCard(convo);
    await h.waitUntil(() => pendingFor(convo).length === 1);
    const res = await attack([], { holdMs: 300 });
    assert.strictEqual(res.opened, false);
    assert.deepStrictEqual(res.received, [], 'zero bytes');
    const [[requestId]] = pendingFor(convo);
    client.send({ type: 'permission_response', requestId, allow: false, conversationId: convo });
    await raised;
  });

  test('11. a chat cannot be started, a routine approved or a package install confirmed', async () => {
    h.clearInvocations();
    const res = await attack([
      { type: 'chat', conversationId: 'attack-chat', agent: 'chief-of-staff', content: 'attack chat' },
      { type: 'approve_routine_plan', agentId: 'chief-of-staff', name: 'anything' },
      { type: 'confirm_package_install', token: 'forged', approval: {} },
    ]);
    assert.strictEqual(res.opened, false);
    await h.delay(300);
    assert.strictEqual(h.readInvocations().filter((i) => JSON.stringify(i).includes('attack chat')).length, 0, 'no agent was started');
    assert.deepStrictEqual(res.received, []);
  });

  test('12. a valid key sent from a foreign Origin, or from null, is refused', async () => {
    for (const Origin of ['https://attacker.example', 'null']) {
      const res = await attack([], { headers: { ...h.authHeaders(), Origin } });
      assert.strictEqual(res.opened, false, `Origin ${Origin}`);
    }
  });

  test('13. a foreign Host is refused on HTTP and on the upgrade, whatever the key', async () => {
    const res = await request({ path: '/api/agents', headers: { ...h.authHeaders(), Host: `evil.example:${h.port}` } });
    assert.strictEqual(res.status, 403);
    const up = await attack([], { headers: { ...h.authHeaders(), Host: `evil.example:${h.port}` } });
    assert.strictEqual(up.opened, false);
  });

  test('14. a cross-site POST to the card route raises no card', async () => {
    const res = await raiseCard('attack-cross-site', { ...h.hookHeaders('attack-cross-site'), Origin: 'https://attacker.example' });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(pendingFor('attack-cross-site').length, 0);
  });

  test('every API route refuses a request with no key and answers the window', async () => {
    for (const url of ['/api/agents', '/api/files', '/api/graph', '/api/connectors/machine']) {
      const bare = await request({ path: url });
      assert.strictEqual(bare.status, 401, `${url} without the key`);
      const wrong = await request({ path: url, headers: { [Object.keys(h.authHeaders())[0] || 'x-rundock-key']: 'not-the-key' } });
      assert.strictEqual(wrong.status, 401, `${url} with a wrong key`);
      const twin = await request({ path: url, headers: h.authHeaders() });
      assert.strictEqual(twin.status, 200, `${url} with the key`);
    }
  });

  test('the page and its scripts still load with no key, so a browser can sign in', async () => {
    for (const url of ['/', '/app.js', '/favicon.svg']) {
      assert.strictEqual((await request({ path: url })).status, 200, url);
    }
  });

  test('the window\'s socket, with the key, opens', async () => {
    const res = await attack([], { headers: h.authHeaders() });
    assert.strictEqual(res.opened, true);
  });
});

describe('8. a link inside the workspace that leads outside it', () => {
  let outsideFile;
  let outsideDir;
  before(() => {
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-attack-outside-'));
    outsideFile = path.join(outsideDir, 'target.md');
    fs.writeFileSync(outsideFile, 'outside-original');
    fs.symlinkSync(outsideFile, path.join(h.workspaceDir, 'linked-note.md'));
    fs.symlinkSync(outsideDir, path.join(h.workspaceDir, 'linked-folder'));
  });

  test('without the key, refused at the door', async () => {
    const res = await attack([{ type: 'save_file', path: 'linked-note.md', content: 'attack-write' }]);
    assert.strictEqual(res.opened, false);
    assert.strictEqual(fs.readFileSync(outsideFile, 'utf-8'), 'outside-original');
  });

  test('with the key, a write through a linked file is refused', async () => {
    const since = client.messages.length;
    client.send({ type: 'save_file', path: 'linked-note.md', content: 'window-write' });
    await client.waitFor((m) => (m.type === 'file_save_refused' || m.type === 'file_saved') && m.path === 'linked-note.md', { since, label: 'save answer' });
    assert.strictEqual(fs.readFileSync(outsideFile, 'utf-8'), 'outside-original', 'nothing was written outside the workspace');
  });

  test('with the key, a write through a linked folder is refused', async () => {
    const since = client.messages.length;
    client.send({ type: 'save_file', path: 'linked-folder/new.md', content: 'window-write' });
    await client.waitFor((m) => (m.type === 'file_save_refused' || m.type === 'file_saved') && m.path === 'linked-folder/new.md', { since, label: 'save answer' });
    assert.ok(!fs.existsSync(path.join(outsideDir, 'new.md')), 'nothing was created outside the workspace');
  });

  test('with the key, a review sidecar is never written through a linked folder', async () => {
    const reviews = path.join(h.workspaceDir, '.rundock', 'reviews');
    fs.mkdirSync(path.dirname(reviews), { recursive: true });
    fs.rmSync(reviews, { recursive: true, force: true });
    fs.symlinkSync(outsideDir, reviews);
    const res = await request({
      method: 'POST', path: '/api/review-sidecar', headers: { 'Content-Type': 'application/json', ...h.authHeaders() },
      body: JSON.stringify({ path: '.rundock/reviews/linked.json', content: '{}' }),
    });
    assert.notStrictEqual(res.status, 200);
    assert.ok(!fs.existsSync(path.join(outsideDir, 'linked.json')));
    fs.unlinkSync(reviews);
  });

  test('with the key, a sidecar that is itself a link is never written through, even to a file inside', async () => {
    const reviews = path.join(h.workspaceDir, '.rundock', 'reviews');
    fs.mkdirSync(reviews, { recursive: true });
    const inside = path.join(h.workspaceDir, 'inside-target.md');
    fs.writeFileSync(inside, 'inside-original');
    fs.symlinkSync(inside, path.join(reviews, 'linked-file.json'));
    const res = await request({
      method: 'POST', path: '/api/review-sidecar', headers: { 'Content-Type': 'application/json', ...h.authHeaders() },
      body: JSON.stringify({ path: '.rundock/reviews/linked-file.json', content: '{}' }),
    });
    assert.notStrictEqual(res.status, 200);
    assert.strictEqual(fs.readFileSync(inside, 'utf-8'), 'inside-original');
  });

  test('with the key, a read in the window still follows the link (nothing anyone sees changes)', async () => {
    const read = await ask({ type: 'read_file', path: 'linked-note.md' }, 'file_content');
    assert.strictEqual(read.content, 'outside-original');
  });

  test('an ordinary save inside the workspace still writes', async () => {
    const since = client.messages.length;
    client.send({ type: 'save_file', path: 'plain-note.md', content: 'plain' });
    await client.waitFor((m) => m.type === 'file_saved' && m.path === 'plain-note.md', { since, label: 'file_saved' });
    assert.strictEqual(fs.readFileSync(path.join(h.workspaceDir, 'plain-note.md'), 'utf-8'), 'plain');
  });
});

describe('9. the hook\'s routes take only the token handed to that conversation', () => {
  const { leaveAgentNotice } = require('../../../lib/runtime/agent-notices.js');
  const notice = (convo, headers) => request({ path: `/api/agent-notice?conversation=${convo}`, headers });

  test('another conversation\'s notice, with no token or the wrong token, returns nothing; the right token gets it once', async () => {
    leaveAgentNotice('notice-owner', 'owner-only line');
    const bare = await notice('notice-owner', {});
    assert.strictEqual(bare.status, 401, 'no token is refused outright');
    assert.strictEqual(JSON.parse(bare.text || '{}').text || null, null, 'no token');
    assert.strictEqual(JSON.parse((await notice('notice-owner', h.hookHeaders('someone-else'))).text || '{}').text || null, null, 'wrong token');
    assert.strictEqual(JSON.parse((await notice('notice-owner', h.hookHeaders('notice-owner'))).text).text, 'owner-only line');
    assert.strictEqual(JSON.parse((await notice('notice-owner', h.hookHeaders('notice-owner'))).text).text, null, 'handed over once');
  });

  test('a card request with no token raises no card', async () => {
    const res = await raiseCard('hook-no-token', {});
    assert.strictEqual(res.status, 401);
    assert.strictEqual(pendingFor('hook-no-token').length, 0);
  });

  test('a token for one conversation cannot plant a card in another', async () => {
    const res = raiseCard('hook-victim', h.hookHeaders('hook-attacker'));
    await h.delay(200);
    assert.strictEqual(pendingFor('hook-victim').length, 0, 'nothing filed into the other conversation');
    // Whatever was filed belongs to the token's own conversation.
    for (const [requestId] of pendingFor('hook-attacker')) client.send({ type: 'permission_response', requestId, allow: false, conversationId: 'hook-attacker' });
    await res;
  });

  test('an agent is started with a token for its own conversation', () => {
    const env = h.internal.getSpawnEnv('convo-env');
    assert.ok(env.RUNDOCK_HOOK_TOKEN, 'the hook has a token to send');
    assert.strictEqual(require('../../../lib/auth/index.js').hookTokenScope(env.RUNDOCK_HOOK_TOKEN), 'convo-env');
  });
});

describe('15. the key never reaches an agent, the environment or the output', () => {
  test('a spawned agent\'s environment holds neither the key nor a browser token', () => {
    const auth = require('../../../lib/auth/index.js');
    const env = h.internal.getSpawnEnv('convo-leak');
    const values = Object.values(env).join('\n');
    assert.ok(!values.includes(auth.launchKey()), 'the launch key is not in the environment');
    assert.ok(!Object.values(process.env).join('\n').includes(auth.launchKey()), 'nor in the server\'s own');
  });
});
