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
function runHook(toolName, toolInput, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [HOOK], {
      cwd: h.workspaceDir,
      env: {
        ...process.env,
        RUNDOCK: '1',
        RUNDOCK_PORT: String(h.port),
        RUNDOCK_WORKSPACE: h.workspaceDir,
        RUNDOCK_CONVO_ID: 'boundary-test',
        ...extraEnv,
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

  test('CODE MODE: a shell command reaching outside cards, while one staying inside does not', async () => {
    // The seam, replayed through the real hook process. Code mode auto-
    // approves everything the classifier returns null for, and a shell
    // command was never classified, so a write outside the workspace happened
    // with no card at all while an Edit of the same file raised one.
    //
    // Both halves are asserted together on purpose. A test that only proved
    // the card appears would still pass if the change carded EVERY command in
    // code mode, which would make code mode unusable and is the obvious way
    // to overshoot this fix.
    const CODE = { RUNDOCK_CODE_MODE: '1' };

    let since = client.messages.length;
    const inside = await runHook('Bash', { command: 'npm test' }, CODE);
    assert.strictEqual(decisionOf(inside), 'allow', 'code mode still runs ordinary commands without asking');
    await h.delay(300);
    assert.strictEqual(client.messages.slice(since).filter(m => m.type === 'control_request').length, 0,
      'an ordinary command raises no card in code mode');

    since = client.messages.length;
    const target = path.join(os.homedir(), 'stray-from-a-command.txt');
    const pending = runHook('Bash', { command: `touch ${target}` }, CODE);
    const { msg } = await client.waitFor(m => m.type === 'control_request'
      && m.request && m.request.boundary === true, { since, label: 'shell boundary card' });
    assert.strictEqual(msg.request.tool_name, 'Bash');
    assert.strictEqual(msg.request.resolved_path, target, 'the card names where the command reaches');
    client.send({ type: 'permission_response', requestId: msg.request_id, conversationId: 'boundary-test', allow: false });
    assert.strictEqual(decisionOf(await pending), 'deny', 'the command never runs');
  });

  test('CODE MODE: a grant covering one target does not carry a second, ungranted one', async () => {
    // The way a standing grant leaks. The server answers a boundary request
    // from a grant without a card, which is what keeps a granted folder
    // usable when no browser is open. If the request names only the FIRST
    // target, a command whose first target sits in the granted folder is
    // allowed outright and everything else in that command rides along
    // unseen. On macOS the sandbox may still stop the second write; on
    // Windows there is no sandbox, and the card is the whole boundary.
    const CODE = { RUNDOCK_CODE_MODE: '1' };
    const granted = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-two-'));
    const first = path.join(granted, 'export.md');
    const second = path.join(os.homedir(), '.ssh-not-really', 'key');

    // Establish the grant on the first folder through the real card flow.
    let since = client.messages.length;
    const pending1 = runHook('Bash', { command: `cp a.md ${first}` }, CODE);
    const card1 = await client.waitFor(m => m.type === 'control_request'
      && m.request && m.request.boundary === true, { since, label: 'first card' });
    client.send({ type: 'permission_response', requestId: card1.msg.request_id, conversationId: 'boundary-test', allow: true, grantDir: granted });
    assert.strictEqual(decisionOf(await pending1), 'allow');

    // The granted folder alone is now silent, which is the behaviour the
    // grant exists to provide and the reason this leak was reachable.
    since = client.messages.length;
    const solo = await runHook('Bash', { command: `cp b.md ${path.join(granted, 'other.md')}` }, CODE);
    assert.strictEqual(decisionOf(solo), 'allow');
    await h.delay(300);
    assert.strictEqual(client.messages.slice(since).filter(m => m.type === 'control_request').length, 0,
      'the grant still answers without a card');

    // Two targets, the first covered by that grant and the second not.
    since = client.messages.length;
    const pending2 = runHook('Bash', { command: `cp a.md ${first} && cp key ${second}` }, CODE);
    const card2 = await client.waitFor(m => m.type === 'control_request'
      && m.request && m.request.boundary === true, { since, label: 'card for the ungranted second target' });
    assert.strictEqual(card2.msg.request.resolved_path, second,
      'the card names the target the grant does NOT cover, not the one it does');
    assert.strictEqual(card2.msg.request.grant_dir, path.dirname(second),
      'and any folder it offers to remember is that one');
    client.send({ type: 'permission_response', requestId: card2.msg.request_id, conversationId: 'boundary-test', allow: false });
    assert.strictEqual(decisionOf(await pending2), 'deny', 'the command never runs');
  });

  test('CODE MODE: turning the sandbox off is itself the boundary question', async () => {
    // The escape hatch, which is the only signal here that does not depend on
    // reading command text. When the spawned runtime's sandbox denies a
    // command it is retried with dangerouslyDisableSandbox, and the retry
    // arrives at this hook carrying the flag. The command text is deliberately
    // one that would NOT card on its own, so the flag alone is what is being
    // proven.
    const since = client.messages.length;
    const pending = runHook('Bash',
      { command: 'make install', dangerouslyDisableSandbox: true },
      { RUNDOCK_CODE_MODE: '1' });
    const { msg } = await client.waitFor(m => m.type === 'control_request'
      && m.request && m.request.boundary === true, { since, label: 'sandbox escape card' });
    assert.strictEqual(msg.request.grant_dir, null,
      'no standing folder grant is offered: a sandbox escape is not about one folder');
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
