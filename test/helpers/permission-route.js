'use strict';
// THE PERMISSION ROUTE AS THE HOOK MEETS IT, for the suites that drive the
// real router with no window connected: requests as the permission hook sends
// them, the real hook as the runtime runs it, routine runs started the way the
// scheduler starts them, and what the router did, seen from outside it.
//
// Every helper reads the booted harness (./harness.js) when it is called, so
// a suite boots first and uses these after.
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const h = require('./harness.js');
const ROUTER = require('../../lib/http-router.js');

const HOOK = path.join(__dirname, '..', '..', 'scripts', 'permission-hook.js');

// What the router did, seen from outside it: every message it sent toward a
// window, every request it stored to wait on a card, and every log line.
// `install` once the harness has booted; `uninstall` before it shuts down.
function routerRecorder() {
  const broadcasts = [];
  const filed = [];
  const logged = [];
  const undo = [];
  return {
    broadcasts,
    filed,
    logged,
    install() {
      const prev = ROUTER.wireHttpRouterDeps({});
      ROUTER.wireHttpRouterDeps({ safeSend: (text) => { try { broadcasts.push(JSON.parse(text)); } catch (e) { /* not JSON */ } return prev.safeSend(text); } });
      undo.push(() => ROUTER.wireHttpRouterDeps({ safeSend: prev.safeSend }));
      const pending = h.internal.pendingPermissionRequests;
      const set = pending.set;
      pending.set = function (id, entry) { filed.push({ id, tool: entry.toolName, input: entry.toolInput, convo: entry.conversationId, run: entry.run }); return set.call(this, id, entry); };
      undo.push(() => { delete pending.set; });
      const log = console.log;
      console.log = (...args) => { logged.push(args.map(String).join(' ')); log.apply(console, args); };
      undo.push(() => { console.log = log; });
    },
    uninstall() {
      for (const fn of undo.reverse()) fn();
      undo.length = 0;
    },
  };
}

// A window a test opened is gone before the next test starts, whether or not
// that test passed.
async function noWindow() {
  assert.ok(await h.waitUntil(() => h.internal.wss.clients.size === 0, { timeout: 3000 }), 'no window is connected');
}

// A request to the permission route exactly as the hook makes it, with the
// token the hook is handed. Resolves the status and the parsed answer;
// `abort` drops the connection, as an asker that went away does.
function ask(body, { convo = null, headers, url = '/api/permission-request' } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  let req;
  const reply = new Promise((resolve) => {
    req = http.request({
      host: '127.0.0.1', port: h.port, method: 'POST', path: url,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), ...(headers || h.hookHeaders(convo)) },
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch (e) { /* not JSON */ } resolve({ status: res.statusCode, body: json }); });
    });
    req.on('error', (e) => resolve({ error: e.code || e.message }));
    req.end(text);
  });
  return { reply, abort: () => req.destroy() };
}
const bashInput = (command) => ({ tool: 'Bash', input: { command } });
const bash = (command, convo, extra = {}) => ({ tool_name: 'Bash', tool_input: { command }, conversation_id: convo || '', ...extra });

// The real hook binary, spawned as the runtime spawns it, for a conversation.
function runHook(toolName, toolInput, { convo, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [HOOK], {
      cwd: h.workspaceDir,
      env: {
        ...process.env, RUNDOCK: '1', RUNDOCK_PORT: String(h.port), RUNDOCK_WORKSPACE: h.workspaceDir,
        RUNDOCK_CODE_MODE: '', RUNDOCK_CONVO_ID: convo, RUNDOCK_HOOK_TOKEN: h.hookToken(convo), ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.on('close', () => { try { resolve(JSON.parse(out).hookSpecificOutput || {}); } catch (e) { reject(new Error(`hook output unparseable: ${out}`)); } });
    proc.stdin.end(JSON.stringify({ tool_name: toolName, tool_input: toolInput, session_id: `s-${convo}`, cwd: h.workspaceDir }));
  });
}

const commandOf = (input) => (input && typeof input === 'object' ? input.command : undefined);

// Every event the workspace has recorded.
function events() {
  const dir = path.join(h.workspaceDir, '.rundock', 'state');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => /^events-.*\.jsonl$/.test(n))
    .flatMap((n) => fs.readFileSync(path.join(dir, n), 'utf-8').split('\n').filter(Boolean))
    .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
}

// ROUTINE RUNS, started the way the scheduler starts every run, for the agent
// `agentId`, each under a name made from `prefix` and a number of its own.
const runsDir = () => path.join(h.workspaceDir, '.rundock', 'runs');
const records = () => (fs.existsSync(runsDir()) ? fs.readdirSync(runsDir()) : [])
  .filter((n) => n.endsWith('.json'))
  .map((n) => JSON.parse(fs.readFileSync(path.join(runsDir(), n), 'utf-8')));
let seq = 0;
function startRoutine(agentId, rule, prefix = 'routine') {
  const name = `${prefix}-${++seq}`;
  const prompt = `routine body number ${seq}`;
  const key = `${agentId}:${name}`;
  h.writeScenario([{ match: { agent: agentId, promptIncludes: prompt }, turn: [{ text: 'done' }], ...rule }]);
  const agent = h.internal.discoverAgents().find((a) => a.id === agentId);
  assert.ok(agent, 'the fixture agent is there');
  h.internal.executeRoutine(agent, { name, schedule: 'every day at 09:00', prompt }, key);
  return { name, key, record: () => records().find((r) => r.routine === name) };
}
async function finished(run, timeout = 15000) {
  assert.ok(await h.waitUntil(() => { const r = run.record(); return r && r.status !== 'running'; }, { timeout }), `${run.name} finished`);
  return run.record();
}
// What the hook told the run's agent, call by call.
const answersOf = (record) => h.readHookAnswers().filter((a) => a.sessionId === record.sessionId).map((a) => a.answer && a.answer.hookSpecificOutput);

module.exports = {
  routerRecorder, noWindow, ask, bash, bashInput, runHook, commandOf, events,
  startRoutine, finished, answersOf,
};
