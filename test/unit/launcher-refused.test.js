'use strict';
// AN AGENT'S WRITE TO THE LAUNCHER IS REFUSED, WITH A REASON AND NO CARD.
//
// The launcher the runtime starts the permission hook through is Rundock's
// alone: Rundock writes it each time it opens the workspace, and the
// detect-and-restore guard puts any other change to it back without a card.
// So an Allow on a card for it could never hold, and the agent would be told
// it was approved while the write was undone. The hook now refuses the write
// before any card, the way it refuses the settings file the runtime was
// started with, in both modes, for file tools and shell commands alike.
//
// Driven through the real hook against a server that answers every card with
// an Allow, so a write that reached a card would be allowed: a refusal here,
// with no request seen, is the hook refusing on its own.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const HOOK = path.join(__dirname, '..', '..', 'scripts', 'permission-hook.js');

let ws, server, port;
const asked = [];
before(async () => {
  ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-refused-')));
  for (const d of [ws, path.join(ws, 'projects', 'other')]) {
    fs.mkdirSync(path.join(d, '.rundock'), { recursive: true });
    fs.writeFileSync(path.join(d, '.rundock', 'state.json'), '{}\n');
    fs.writeFileSync(path.join(d, '.rundock', 'permission-hook.sh'), '#!/bin/sh\nexec node hook.js "$@"\n');
  }
  fs.writeFileSync(path.join(ws, 'x.sh'), 'echo hi\n');
  fs.writeFileSync(path.join(ws, '.mcp.json'), '{}\n');
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/api/permission-request') {
        asked.push(JSON.parse(body).tool_input);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ allow: true, card: true }));
        return;
      }
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(async () => {
  if (server) await new Promise(r => server.close(r));
  if (ws) fs.rmSync(ws, { recursive: true, force: true });
});

function decision(tool_name, tool_input, codeMode) {
  const env = { ...process.env, RUNDOCK: '1', RUNDOCK_WORKSPACE: ws, RUNDOCK_PORT: String(port), RUNDOCK_EXTRA_DIRS: path.join(ws, 'projects') };
  delete env.RUNDOCK_CODE_MODE;
  delete env.NODE_V8_COVERAGE;
  if (codeMode) env.RUNDOCK_CODE_MODE = '1';
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', () => {
      try {
        const o = JSON.parse(out).hookSpecificOutput;
        resolve({ decision: o.permissionDecision, reason: o.permissionDecisionReason || '' });
      } catch (e) { resolve({ decision: 'none', reason: out }); }
    });
    child.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', cwd: ws, tool_name, tool_input }));
  });
}

const launcher = () => path.join(ws, '.rundock', 'permission-hook.sh');
const WRITES = () => [
  ['Write', { file_path: launcher(), content: '#!/bin/sh\nexit 0\n' }, 'the Write tool'],
  ['Edit', { file_path: launcher(), old_string: 'node', new_string: 'true' }, 'the Edit tool'],
  ['Bash', { command: 'echo exit 0 > .rundock/permission-hook.sh' }, 'a shell redirect'],
  ['Bash', { command: 'cp x.sh .rundock/permission-hook.sh' }, 'cp onto it'],
  ['Bash', { command: "sed -i '' s/node/true/ .rundock/permission-hook.sh" }, 'sed -i'],
  ['Bash', { command: 'echo x > .rundock/permission-hook.cmd' }, 'the Windows launcher'],
  ['Bash', { command: 'echo x > projects/other/.rundock/permission-hook.sh' }, "another workspace's launcher"],
];

describe('a write to the launcher is refused before any card', () => {
  for (const codeMode of [false, true]) {
    const mode = codeMode ? 'Code' : 'Notes';
    test(`every form, with a reason and no card (${mode} mode)`, async () => {
      for (const [tool, input, what] of WRITES()) {
        asked.length = 0;
        const r = await decision(tool, input, codeMode);
        assert.strictEqual(r.decision, 'deny', `${mode}: ${what}`);
        assert.match(r.reason, /starts its permission checks/, `${mode}: ${what}: the reason says why`);
        assert.strictEqual(asked.length, 0, `${mode}: ${what}: no card was raised`);
      }
    });

    test(`another answer file still asks, and a read of the launcher is not refused (${mode} mode)`, async () => {
      asked.length = 0;
      const mcp = await decision('Bash', { command: 'echo {} > .mcp.json' }, codeMode);
      assert.strictEqual(mcp.decision, 'allow', `${mode}: the card was raised and answered`);
      assert.ok(asked.length >= 1, `${mode}: sanity: the server was asked`);
      for (const [tool, input] of [['Read', { file_path: launcher() }], ['Bash', { command: 'cat .rundock/permission-hook.sh' }]]) {
        const r = await decision(tool, input, codeMode);
        assert.doesNotMatch(r.reason, /starts its permission checks/, `${mode}: ${tool} is not refused as a launcher write`);
      }
    });
  }
});
