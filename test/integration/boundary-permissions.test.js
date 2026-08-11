'use strict';
// The workspace file-access boundary, end to end through the REAL hook
// binary: scripts/permission-hook.js is spawned exactly as the runtime
// spawns it, with the tool request on stdin, and its stdout decision is
// asserted together with the server-side card flow and the persisted
// folder grants.
//
// The incident this replays: an agent wrote the workspace CLAUDE.md to the
// user's home directory with zero friction. After this feature, that write
// produces a permission card; approving with "Always allow this folder"
// persists a per-workspace grant that silences the next card for that
// folder only.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const h = require('../helpers/harness.js');

const HOOK = path.join(__dirname, '..', '..', 'scripts', 'permission-hook.js');

let client;
before(async () => {
  await h.boot();
  client = await h.connect();
});
after(async () => h.shutdown());

// Run the real hook binary with a tool request; resolves with its decision.
function runHook(toolName, toolInput) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [HOOK], {
      cwd: h.workspaceDir,
      env: {
        ...process.env,
        RUNDOCK: '1',
        RUNDOCK_PORT: String(h.port),
        RUNDOCK_WORKSPACE: h.workspaceDir,
        RUNDOCK_CONVO_ID: 'boundary-test',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    proc.stdout.on('data', d => { out += d; });
    proc.on('close', () => {
      try { resolve(JSON.parse(out)); } catch (e) { reject(new Error(`hook output unparseable: ${out}`)); }
    });
    proc.stdin.write(JSON.stringify({ tool_name: toolName, tool_input: toolInput, session_id: 's-boundary' }));
    proc.stdin.end();
  });
}

function decisionOf(hookOutput) {
  return hookOutput.hookSpecificOutput ? hookOutput.hookSpecificOutput.permissionDecision : null;
}

describe('workspace file-access boundary', () => {
  test('an in-workspace write is allowed instantly with no card', async () => {
    const since = client.messages.length;
    const out = await runHook('Write', { file_path: path.join(h.workspaceDir, 'notes.md'), content: 'x' });
    assert.strictEqual(decisionOf(out), 'allow');
    await h.delay(300);
    const cards = client.messages.slice(since).filter(m => m.type === 'control_request');
    assert.strictEqual(cards.length, 0, 'no permission card for in-workspace writes');
  });

  test('the incident replayed: a home-directory write produces a card; denying blocks it', async () => {
    const target = path.join(os.homedir(), 'CLAUDE.md');
    const since = client.messages.length;
    const pending = runHook('Write', { file_path: target, content: 'stray' });
    const { msg } = await client.waitFor(m => m.type === 'control_request'
      && m.request && m.request.boundary === true, { since, label: 'boundary card' });
    assert.strictEqual(msg.request.tool_name, 'Write');
    assert.strictEqual(msg.request.resolved_path, target, 'the card names the real target');
    client.send({ type: 'permission_response', requestId: msg.request_id, conversationId: 'boundary-test', allow: false });
    const out = await pending;
    assert.strictEqual(decisionOf(out), 'deny', 'the write never happens');
  });

  test('"Always allow this folder" persists a per-workspace grant; the next access in that folder is silent', async () => {
    const grantDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-grant-'));
    const target1 = path.join(grantDir, 'export-one.md');
    let since = client.messages.length;
    const pending1 = runHook('Write', { file_path: target1, content: 'one' });
    const { msg } = await client.waitFor(m => m.type === 'control_request'
      && m.request && m.request.boundary === true, { since, label: 'first boundary card' });
    // The folder-grant response: allow AND remember the folder.
    client.send({ type: 'permission_response', requestId: msg.request_id, conversationId: 'boundary-test', allow: true, grantDir });
    const out1 = await pending1;
    assert.strictEqual(decisionOf(out1), 'allow');

    const grants = JSON.parse(fs.readFileSync(path.join(h.workspaceDir, '.rundock', 'permissions.json'), 'utf-8'));
    assert.ok(grants.allowedDirs.includes(grantDir), 'grant encoded into the workspace');

    since = client.messages.length;
    const out2 = await runHook('Write', { file_path: path.join(grantDir, 'export-two.md'), content: 'two' });
    assert.strictEqual(decisionOf(out2), 'allow', 'granted folder allows without a card');
    await h.delay(300);
    const cards = client.messages.slice(since).filter(m => m.type === 'control_request');
    assert.strictEqual(cards.length, 0, 'no second card for the granted folder');

    // The grant covers that folder only, never the machine.
    since = client.messages.length;
    const pending3 = runHook('Write', { file_path: path.join(os.homedir(), 'other.md'), content: 'x' });
    const card3 = await client.waitFor(m => m.type === 'control_request'
      && m.request && m.request.boundary === true, { since, label: 'ungranted folder still cards' });
    client.send({ type: 'permission_response', requestId: card3.msg.request_id, conversationId: 'boundary-test', allow: false });
    assert.strictEqual(decisionOf(await pending3), 'deny');
  });

  test('outside reads are governed too', async () => {
    const since = client.messages.length;
    const pending = runHook('Read', { file_path: path.join(os.homedir(), 'somefile.txt') });
    const { msg } = await client.waitFor(m => m.type === 'control_request'
      && m.request && m.request.boundary === true, { since, label: 'read boundary card' });
    client.send({ type: 'permission_response', requestId: msg.request_id, conversationId: 'boundary-test', allow: false });
    assert.strictEqual(decisionOf(await pending), 'deny');
  });

  test('the global ~/.claude protection still wins outright (deny, no card)', async () => {
    const since = client.messages.length;
    const out = await runHook('Write', { file_path: path.join(os.homedir(), '.claude', 'agents', 'x.md'), content: 'x' });
    assert.strictEqual(decisionOf(out), 'deny', 'deterministic deny, not a card');
    await h.delay(300);
    assert.strictEqual(client.messages.slice(since).filter(m => m.type === 'control_request').length, 0);
  });
});
