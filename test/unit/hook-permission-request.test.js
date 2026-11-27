'use strict';
// THE HOOK'S ANSWER TO CLAUDE CODE'S OWN QUESTION ABOUT A COMMAND OUTSIDE THE
// SANDBOX (PermissionRequest).
//
// A Bash or PowerShell call with `dangerouslyDisableSandbox: true` that the
// PreToolUse answer allowed is put to the PermissionRequest hooks, and runs
// only if one answers allow. The hook answers allow only when Rundock spends a
// grant that a person's click on the call's card recorded, and otherwise gives
// no decision at all, `{}`, so Claude Code refuses the call as it would with no
// hook. It never denies, never rewrites the call and never adds words.
//
// Each case runs the real hook as its own process, the way the runtime does,
// against a stand-in Rundock that records every request it gets.
const made = require('../helpers/made-up-home.js');
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { makeTempDir, cleanup } = require('../helpers/workspace.js');

const HOOK = path.join(__dirname, '..', '..', 'scripts', 'permission-hook.js');
const ws = makeTempDir('hook-permission-request-');
fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
after(cleanup);

const TOKEN = 'example-hook-token';
const ALLOW = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}';

// What Claude Code puts to a PermissionRequest hook, with `fields` over it.
function request(fields = {}) {
  return JSON.stringify({
    session_id: 's', transcript_path: '', cwd: ws, permission_mode: 'default',
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: { command: 'echo hello', dangerouslyDisableSandbox: true },
    ...fields,
  });
}

// Runs the hook on `raw`, inside Rundock for conversation `convo-1` unless
// `env` says otherwise (a variable set to undefined is left out). A run still
// going after `timeout` is ended, and its status is then null.
function runHook(raw, { port = 1, env = {}, preload, timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    const base = { ...process.env, NODE_V8_COVERAGE: '', USERPROFILE: made.home, RUNDOCK: '1', RUNDOCK_PORT: String(port), RUNDOCK_WORKSPACE: ws, RUNDOCK_CONVO_ID: 'convo-1', RUNDOCK_HOOK_TOKEN: TOKEN, RUNDOCK_CODE_MODE: '' };
    const merged = { ...base, ...env };
    for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
    const args = [...[].concat(preload || []).flatMap((file) => ['--require', file]), HOOK];
    const started = Date.now();
    const proc = spawn(process.execPath, args, { env: merged });
    const ending = setTimeout(() => proc.kill('SIGKILL'), timeout);
    let out = '';
    let err = '';
    proc.stdout.on('data', (c) => { out += c; });
    proc.stderr.on('data', (c) => { err += c; });
    proc.on('close', (status) => {
      clearTimeout(ending);
      resolve({ status, stdout: out, stderr: err, took: Date.now() - started });
    });
    proc.stdin.end(raw);
  });
}

// A stand-in Rundock. Every request is recorded with its method, path, hook
// token and body; `reply(req, body, res)` answers it, or leaves it unanswered.
function rundock(reply = (req, body, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"spent":true}'); }) {
  return new Promise((resolve) => {
    const asked = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        asked.push({ method: req.method, path: req.url, token: req.headers['x-rundock-hook-token'], body });
        reply(req, body, res);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      asked,
      close: () => new Promise((done) => { server.closeAllConnections(); server.close(done); }),
    }));
  });
}
const answering = (status, text) => (req, body, res) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(text); };

// No decision: the whole answer is `{}`, and the hook ended cleanly.
function assertNoDecision(r) {
  assert.strictEqual(r.status, 0, `the hook ended with ${r.status}: ${r.stderr}`);
  assert.strictEqual(r.stdout, '{}', `the hook gave a decision: ${r.stdout}`);
}

// Runs the hook on `raw` against a stand-in that answers `reply`, and gives the
// run and every request the stand-in got.
async function ask(raw, reply, options = {}) {
  const server = await rundock(reply);
  try {
    const r = await runHook(raw, { port: server.port, ...options });
    return { ...r, asked: server.asked };
  } finally { await server.close(); }
}

describe('a command outside the sandbox the hook is asked about by Claude Code', () => {
  // Passes before this change as well, by design: outside Rundock the hook has
  // always given no decision. Its twin, which shares this setup and fails
  // before the change, is 'a granted command is answered with an allow, and
  // only the grant route is asked'.
  test('outside Rundock the hook gives no decision and asks nothing', async () => {
    const r = await ask(request(), undefined, { env: { RUNDOCK: undefined } });
    assertNoDecision(r);
    assert.deepStrictEqual(r.asked, []);
  });

  test('a granted command is answered with an allow, and only the grant route is asked', async () => {
    const r = await ask(request(), answering(200, '{"spent":true}'));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, ALLOW);
    assert.deepStrictEqual(r.asked.map((a) => `${a.method} ${a.path}`), ['POST /api/sandbox-grant']);
  });

  test('a granted PowerShell command is answered with an allow', async () => {
    const r = await ask(request({ tool_name: 'PowerShell', tool_input: { command: 'Write-Output hello', dangerouslyDisableSandbox: true } }), answering(200, '{"spent":true}'));
    assert.strictEqual(r.stdout, ALLOW);
  });

  test('the request carries the hook token and the call exactly as Claude Code gave it', async () => {
    const input = { command: 'echo hello', dangerouslyDisableSandbox: true, description: 'Say hello', timeout: 1000 };
    const r = await ask(request({ tool_input: input, conversation_id: 'convo-2', agent_id: 'example-other' }), answering(200, '{"spent":true}'));
    assert.strictEqual(r.asked.length, 1);
    assert.strictEqual(r.asked[0].token, TOKEN);
    assert.deepStrictEqual(JSON.parse(r.asked[0].body), { tool_name: 'Bash', tool_input: input });
  });

  test('a grant Rundock did not spend gives no decision', async () => {
    const r = await ask(request(), answering(200, '{"spent":false}'));
    assertNoDecision(r);
    assert.deepStrictEqual(r.asked.map((a) => a.path), ['/api/sandbox-grant']);
  });

  for (const [label, env] of [
    ['with no conversation', { RUNDOCK_CONVO_ID: undefined }],
    ['with an empty conversation', { RUNDOCK_CONVO_ID: '' }],
  ]) {
    test(`a call ${label} gives no decision and asks nothing`, async () => {
      const r = await ask(request(), undefined, { env });
      assertNoDecision(r);
      assert.deepStrictEqual(r.asked, []);
    });
  }

  // Defence, not Claude Code's behaviour: the CLI never puts a call without
  // the flag to the PermissionRequest hooks, and gives a flag sent as the
  // string "true" to them as true (test/fixtures/claude-cli-sandbox-override.json).
  // The hook still gives no decision to either, should one ever arrive.
  for (const [label, fields] of [
    ['without the flag', { tool_input: { command: 'echo hello' } }],
    ['with the flag as the string "true"', { tool_input: { command: 'echo hello', dangerouslyDisableSandbox: 'true' } }],
  ]) {
    test(`a call ${label}, which Claude Code never sends, still gives no decision and asks nothing`, async () => {
      const r = await ask(request(fields), undefined);
      assertNoDecision(r);
      assert.deepStrictEqual(r.asked, []);
    });
  }

  for (const [label, fields] of [
    ['by another tool', { tool_name: 'Write', tool_input: { file_path: path.join(ws, 'a.txt'), content: 'x', command: 'echo hello', dangerouslyDisableSandbox: true } }],
    ['with the flag false', { tool_input: { command: 'echo hello', dangerouslyDisableSandbox: false } }],
    ['with an empty command', { tool_input: { command: '', dangerouslyDisableSandbox: true } }],
    ['with no command', { tool_input: { dangerouslyDisableSandbox: true } }],
    ['with a command that is not a string', { tool_input: { command: ['echo', 'hello'], dangerouslyDisableSandbox: true } }],
  ]) {
    test(`a call ${label} gives no decision and asks nothing`, async () => {
      const r = await ask(request(fields), undefined);
      assertNoDecision(r);
      assert.deepStrictEqual(r.asked, []);
    });
  }

  for (const [label, status, text] of [
    ['a reply other than 200, even one saying spent', 201, '{"spent":true}'],
    ['a refused token', 401, '{"spent":true}'],
    ['a server error', 500, '{"spent":true}'],
    ['a reply it cannot parse', 200, '{"spent":tr'],
    ['an empty reply', 200, ''],
    ['spent as the string "true"', 200, '{"spent":"true"}'],
    ['spent as 1', 200, '{"spent":1}'],
    ['a bare true', 200, 'true'],
    ['an array', 200, '[{"spent":true}]'],
    ['spent missing', 200, '{"allow":true}'],
  ]) {
    test(`${label} gives no decision`, async () => {
      const r = await ask(request(), answering(status, text));
      assertNoDecision(r);
      assert.strictEqual(r.asked.length, 1);
    });
  }

  test('a Rundock it cannot reach gives no decision', async () => {
    const r = await runHook(request(), { port: 1 });
    assertNoDecision(r);
  });

  test('no reply within 5 seconds gives no decision', async () => {
    const r = await ask(request(), () => { /* never answers */ });
    assertNoDecision(r);
    assert.strictEqual(r.asked.length, 1);
    assert.ok(r.took >= 4500, `the hook gave up after ${r.took} ms`);
    assert.ok(r.took < 9000, `the hook waited ${r.took} ms`);
  });

  // The throw is made where the grant is asked for, and nowhere else, so the
  // stand-in hears from any other way the hook might have answered.
  test('a hook that throws while asking gives no decision', async () => {
    const preload = path.join(ws, 'request-throws.js');
    fs.writeFileSync(preload, [
      "const http = require('http');",
      'const real = http.request;',
      "http.request = (options, ...rest) => { if (options && options.path === '/api/sandbox-grant') throw new Error('example failure'); return real(options, ...rest); };",
      '',
    ].join('\n'));
    const server = await rundock();
    try {
      const r = await runHook(request(), { port: server.port, preload });
      assertNoDecision(r);
      assert.deepStrictEqual(server.asked, []);
    } finally { await server.close(); }
  });
});
