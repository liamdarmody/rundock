'use strict';
// THROUGH THE REAL HOOK: a PowerShell command that reaches into the runtime's
// own home is freed only when the shared definition reads it as a read.
//
// The hook lets an agent read the runtime's own agents, skills and hook scripts
// with no card, and it learns what a read is from public/read-only-shell.js.
// That module read PowerShell with the Bash rules, which take `( )` as
// harmless, so `Get-Content (Remove-Item <a hook script>)` was freed like the
// read it starts with. On Windows there is no sandbox under the hook.
//
// Each case runs the hook as its own process, the way the runtime does, against
// a stand-in for Rundock that records what the hook asked and answers no.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { UNATTENDED_NEXT } = require('../../scripts/refusal-notice.js');

const HOOK = path.join(__dirname, '..', '..', 'scripts', 'permission-hook.js');
const SHARED = path.join(__dirname, '..', '..', 'public', 'read-only-shell.js');

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ps-reads-hook-')));
const home = path.join(root, 'home');
const ws = path.join(root, 'ws');
const hooks = path.join(home, '.claude', 'hooks');
const script = path.join(hooks, 'x.ps1');
fs.mkdirSync(hooks, { recursive: true });
fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
fs.writeFileSync(script, '');

// A FAILURE FORCED INSIDE THE SHARED DEFINITION, loaded ahead of the hook with
// `--require`. The hook has no switch for it, so nothing in a tool call can set
// it off: the test seam it uses can only make the reading fail.
const readingFails = path.join(root, 'reading-fails.js');
fs.writeFileSync(readingFails,
  `require(${JSON.stringify(SHARED)}).powerShellReadingSeam.beforeReading = () => { throw new Error('forced failure'); };\n`);

const asked = new Map();
let server;
before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url.startsWith('/api/permission-request')) {
        try { const d = JSON.parse(body); asked.set(d.session_id, d); } catch (e) { /* asserted by the callers */ }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ allow: false }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
});
after(async () => {
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  fs.rmSync(root, { recursive: true, force: true });
});

// A conversation's agent is started with its conversation's id, and a
// routine's with none. An undefined value is left out of the child's
// environment.
const CONVERSATION = { RUNDOCK_CONVO_ID: 'c1' };
const ROUTINE = { RUNDOCK_CONVO_ID: undefined };

let seq = 0;
function runHook(command, { env = {}, preload } = {}) {
  const sid = `ps-reads-${process.pid}-${++seq}`;
  return new Promise((resolve) => {
    const args = [...(preload ? ['--require', preload] : []), HOOK];
    const proc = spawn(process.execPath, args, {
      env: {
        ...process.env, NODE_V8_COVERAGE: '', RUNDOCK: '1', RUNDOCK_PORT: String(server.address().port),
        RUNDOCK_WORKSPACE: ws, RUNDOCK_CODE_MODE: '', HOME: home, USERPROFILE: home, ...env,
      },
    });
    const ending = setTimeout(() => proc.kill('SIGKILL'), 30000);
    let out = '';
    let err = '';
    proc.stdout.on('data', (c) => { out += c; });
    proc.stderr.on('data', (c) => { err += c; });
    proc.on('close', (status) => {
      clearTimeout(ending);
      let answer = null;
      try { answer = JSON.parse(out).hookSpecificOutput; } catch (e) { /* asserted below */ }
      resolve({ status, err, decision: answer && answer.permissionDecision, reason: (answer && answer.permissionDecisionReason) || '', card: asked.get(sid) || null });
    });
    proc.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', cwd: ws, session_id: sid, tool_name: 'PowerShell', tool_input: { command } }));
  });
}

const under = (p, dir) => p === dir || p.startsWith(dir + path.sep);
function assertAsksAboutHooks(r, command) {
  assert.strictEqual(r.status, 0, r.err);
  assert.ok(r.card, `the hook asked nobody: ${command}`);
  assert.strictEqual(r.card.boundary, true, `the crossing into the runtime's home was freed: ${command}`);
  assert.ok(r.card.crossings.some((c) => c.persistenceSurface && c.write && under(c.path, fs.realpathSync(hooks))),
    `the card names the hook scripts as changed: ${JSON.stringify(r.card.crossings)}`);
  assert.strictEqual(r.decision, 'deny', 'and the answer it was given, no, is the answer');
}
function assertFreed(r, command) {
  assert.strictEqual(r.status, 0, r.err);
  assert.ok(r.card, `the hook still asks the browser to grade it: ${command}`);
  assert.notStrictEqual(r.card.boundary, true, `a read of the runtime's home raised a crossing: ${command}`);
}
function assertWords(r, unattended) {
  assert.strictEqual(r.reason.endsWith(` ${UNATTENDED_NEXT}`), unattended,
    `${unattended ? 'a routine is' : 'a conversation is not'} told what to do next unattended: ${r.reason}`);
}

describe('through the real hook, a PowerShell command under the runtime home is freed only when it is read as a read', () => {
  for (const [who, env, unattended] of [['a conversation', CONVERSATION, false], ['a routine', ROUTINE, true]]) {
    test(`${who}: a removal inside a read's brackets asks`, async () => {
      const command = `Get-Content (Remove-Item ${script})`;
      const r = await runHook(command, { env });
      assertAsksAboutHooks(r, command);
      assertWords(r, unattended);
    });

    test(`${who}: a write in a read's block or subexpression, or after it, asks`, async () => {
      for (const command of [
        `Get-ChildItem ${hooks} | Sort-Object { Set-Content ${script} x }`,
        `Write-Output $(Set-Content ${script} x)`,
        `Get-Content ${script}\nSet-Content ${script} x`,
      ]) assertAsksAboutHooks(await runHook(command, { env }), command);
    });

    test(`${who}: a plain read there is still freed`, async () => {
      for (const command of [
        `Get-ChildItem ${hooks}`,
        `Get-Date; Get-Content ${script}`,
        `Get-ChildItem ${hooks} | Where-Object Name -like '*.ps1'`,
      ]) assertFreed(await runHook(command, { env }), command);
    });

    test(`${who}: a failure forced inside the shared definition asks, and never allows`, async () => {
      const command = `Get-ChildItem ${hooks}`;
      assertFreed(await runHook(command, { env }), `sanity, with nothing forced: ${command}`);
      const r = await runHook(command, { env, preload: readingFails });
      assertAsksAboutHooks(r, command);
      assertWords(r, unattended);
    });
  }
});
