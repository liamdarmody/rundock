'use strict';
// THE PER-USER CONNECTOR FILE IS AN ANSWER FILE.
//
// `.rundock/mcp-secrets.json` supplies `env` and `headers` for each server
// `.mcp.json` declares, merged in for every spawn (lib/workspace/mcp-secrets.js).
// An `env` such as NODE_OPTIONS changes what a stdio server runs, outside the
// sandbox, so a write to it decides what runs as surely as one to `.mcp.json`.
// It holds credentials, and Rundock never writes it: the person does. So an
// agent's write, edit or delete asks every time, Allow and Deny only, in both
// modes, and is refused when Rundock cannot be asked.
//
// Driven through the real hook against a workspace in the temp folder, so it
// needs no fixture of its own.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const HOOK = path.join(__dirname, '..', '..', 'scripts', 'permission-hook.js');
const hook = require(HOOK);
const REL = '.rundock/mcp-secrets.json';

let ws, other, capture, closed;
before(async () => {
  ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'connector-secrets-')));
  fs.mkdirSync(path.join(ws, '.rundock'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.rundock', 'state.json'), '{}\n');
  fs.writeFileSync(path.join(ws, REL), '{ "notion": { "env": { "API_KEY": "k" } } }\n');
  fs.writeFileSync(path.join(ws, 'notes.txt'), 'notes\n');
  other = path.join(ws, 'projects', 'other-ws');
  fs.mkdirSync(path.join(other, '.rundock'), { recursive: true });
  fs.writeFileSync(path.join(other, '.rundock', 'state.json'), '{}\n');
  const posted = new Map();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try { const d = JSON.parse(body); posted.set(d.session_id, d); } catch (e) { /* ignored */ }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ allow: true }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  capture = { port: server.address().port, posted, close: () => new Promise(r => server.close(r)) };
  const s = http.createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  closed = s.address().port;
  await new Promise(r => s.close(r));
});
after(async () => {
  if (capture) await capture.close();
  if (ws) fs.rmSync(ws, { recursive: true, force: true });
});

function run(port, codeMode, input) {
  const env = { ...process.env, RUNDOCK: '1', RUNDOCK_WORKSPACE: ws, RUNDOCK_PORT: String(port), RUNDOCK_EXTRA_DIRS: '', RUNDOCK_CONVO_ID: 'secrets-test' };
  delete env.RUNDOCK_CODE_MODE;
  delete env.NODE_V8_COVERAGE;
  if (codeMode) env.RUNDOCK_CODE_MODE = '1';
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', () => {
      let h = null;
      try { h = JSON.parse(out).hookSpecificOutput; } catch (e) { /* none */ }
      resolve({ decision: h ? h.permissionDecision : 'pass-through', reason: h ? h.permissionDecisionReason : '' });
    });
    child.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', cwd: ws, ...input }));
  });
}
let seq = 0;
async function judge(tool, toolInput, codeMode) {
  const sid = `secrets-${process.pid}-${++seq}`;
  const live = await run(capture.port, codeMode, { session_id: sid, tool_name: tool, tool_input: toolInput });
  const dead = await run(closed, codeMode, { session_id: `${sid}-dead`, tool_name: tool, tool_input: toolInput });
  return { live, dead, payload: capture.posted.get(sid) || null };
}
const isAnswerFile = p => !!p && (p.answer_file === true
  || (p.boundary === true && Array.isArray(p.crossings) && p.crossings.length > 0 && p.crossings.every(c => c && c.answerFile)));
function assertAsks(r, what) {
  assert.ok(isAnswerFile(r.payload), `${what}: asks, as an answer file`);
  assert.strictEqual(r.payload.grant_dir || null, null, `${what}: with no folder to remember`);
  assert.strictEqual(r.dead.decision, 'deny', `${what}: refused when Rundock cannot be asked`);
  assert.match(r.dead.reason, /never changed without asking/, `${what}: and says why`);
}

const MODES = [false, true];
const SHELL_FORMS = ['echo x > F', 'echo x >> F', 'printf x | tee F', 'cp notes.txt F', 'mv notes.txt F', "sed -i '' s/a/b/ F", 'rm F', 'truncate -s 0 F'];

describe('the per-user connector file asks before an agent changes it', () => {
  for (const codeMode of MODES) {
    const label = codeMode ? 'Code' : 'Notes';
    test(`a file-tool write, edit or multi-edit asks (${label} mode)`, async () => {
      const file_path = path.join(ws, REL);
      for (const [tool, input] of [['Write', { file_path, content: '{}' }], ['Edit', { file_path, old_string: 'k', new_string: 'j' }], ['MultiEdit', { file_path, edits: [{ old_string: 'k', new_string: 'j' }] }]]) {
        assertAsks(await judge(tool, input, codeMode), `${label}: ${tool}`);
      }
    });

    test(`every shell form that writes, edits or deletes it asks (${label} mode)`, async () => {
      for (const form of SHELL_FORMS) {
        const command = form.replace(/\bF\b/g, REL);
        assertAsks(await judge('Bash', { command }, codeMode), `${label}: ${command}`);
      }
    });

    test(`another Rundock workspace's copy asks too, matched by name (${label} mode)`, async () => {
      const target = path.join(other, REL);
      assertAsks(await judge('Write', { file_path: target, content: '{}' }, codeMode), `${label}: Write ${target}`);
      assertAsks(await judge('Bash', { command: `echo x > ${target}` }, codeMode), `${label}: echo x > ${target}`);
    });

    test(`reading it is free, and Rundock's own merged copy beside it is ordinary work (${label} mode)`, async () => {
      assert.strictEqual((await judge('Read', { file_path: path.join(ws, REL) }, codeMode)).live.decision, 'allow');
      const runtime = await judge('Write', { file_path: path.join(ws, '.rundock', 'mcp-runtime.json'), content: '{}' }, codeMode);
      assert.strictEqual(runtime.live.decision, 'allow', 'the merged file is regenerated before every spawn, so a write to it is ordinary');
      assert.ok(!isAnswerFile(runtime.payload));
    });
  }

  test('the card says it holds credentials and decides what runs', () => {
    const RP = require('../../public/permissions.js');
    const p = path.join(ws, REL);
    assert.match(RP.answerFileSummary(p), /Wants to change what runs outside the sandbox/);
    assert.match(RP.answerFileCopy(p), /connector credentials/);
    assert.match(RP.answerFileCopy(p), /decides what Rundock or Claude Code runs, outside the sandbox/);
    assert.match(RP.answerFileCopy(p), /asks every time/);
  });

  test('the operating system is told as well, where a sandbox runs', () => {
    const scaffold = require('../../lib/workspace/scaffold.js');
    for (const mode of ['on', 'off']) {
      const deny = scaffold.sandboxSettings('/w/ws', 'darwin', '/Users/someone', ['/tmp/t'], [], mode).filesystem.denyWrite;
      assert.strictEqual(deny[deny.length - 1], `/w/ws/${REL}`, `the ${mode} block denies it, appended last`);
    }
  });

  test('a case variant is the same file where the filesystem folds case', () => {
    const a = hook.classifyFileAccess('Write', { file_path: path.join(ws, '.RUNDOCK', 'MCP-Secrets.JSON') }, ws, [], os.homedir(), true, true);
    assert.strictEqual(a && a.answerFile, true);
  });

  test('a stored folder grant over the workspace does not cover it', () => {
    const config = require('../../lib/config.js');
    const boundary = require('../../lib/workspace/boundary.js');
    const prev = config.getWorkspace();
    try {
      config.setWorkspace(ws);
      boundary.addBoundaryGrant(path.dirname(ws));
      assert.strictEqual(boundary.crossingCovered({ path: path.join(ws, REL) }), false);
    } finally {
      config.setWorkspace(prev);
    }
  });
});
