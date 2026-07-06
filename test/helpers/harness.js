'use strict';
// Integration harness: boots the real server.js in-process on a random port,
// against a disposable temp workspace, with the stub `claude` binary injected
// via PATH. One harness per test file (node --test runs each file in its own
// process, so module-level state never leaks between files).
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const { makeWorkspace, makeTempDir, standardTeam } = require('./workspace.js');

const STUB_DIR = path.join(__dirname, 'stub-claude');
const CODEX_STUB_DIR = path.join(__dirname, 'stub-codex');

let srv = null;
let internal = null;
let port = null;
let workspaceDir = null;
const clients = [];

/**
 * Boot the server. Call ONCE per test file, before any test runs.
 * @param {object} opts
 * @param {object} [opts.agents] - agent fixture map (default standardTeam)
 * @param {object} [opts.workspaceOpts] - extra makeWorkspace options
 * @param {object} [opts.env] - extra process.env entries set BEFORE require
 */
async function boot(opts = {}) {
  assert.strictEqual(srv, null, 'boot() must only be called once per test file');

  // Environment isolation. Must happen before server.js is required.
  process.env.PATH = STUB_DIR + path.delimiter + CODEX_STUB_DIR + path.delimiter + process.env.PATH;
  const tempHome = makeTempDir('rundock-test-home-');
  process.env.HOME = tempHome;
  // RUNDOCK_ELECTRON routes the recent-workspaces file into $HOME (now a temp
  // dir) instead of the repo checkout.
  process.env.RUNDOCK_ELECTRON = '1';
  for (const [k, v] of Object.entries(opts.env || {})) process.env[k] = v;

  workspaceDir = makeWorkspace({ agents: opts.agents || standardTeam(), claudeMd: '# Test Workspace\n', ...(opts.workspaceOpts || {}) });

  srv = require('../../server.js');
  internal = srv._internal;
  internal.setWorkspace(workspaceDir);

  // Hard safety gate: never run integration scenarios against a real claude
  // or a real codex.
  const resolved = internal.resolveClaudeBin();
  assert.strictEqual(resolved, path.join(STUB_DIR, 'claude'),
    `stub claude not resolved (got: ${resolved}). Refusing to run against a real binary.`);
  const codexResolved = require('../../codex.js').resolveCodexBin();
  assert.strictEqual(codexResolved, path.join(CODEX_STUB_DIR, 'codex'),
    `stub codex not resolved (got: ${codexResolved}). Refusing to run against a real binary.`);

  port = await srv.startServer({ port: 0 });
  return { internal, port, workspaceDir };
}

function writeScenario(rules) {
  fs.writeFileSync(path.join(workspaceDir, 'stub-scenario.json'), JSON.stringify({ rules }, null, 2));
}

function writeCodexScenario(rules) {
  fs.writeFileSync(path.join(workspaceDir, 'stub-codex-scenario.json'), JSON.stringify({ rules }, null, 2));
}

function readInvocations() {
  const file = path.join(workspaceDir, 'stub-invocations.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function clearInvocations() {
  try { fs.unlinkSync(path.join(workspaceDir, 'stub-invocations.jsonl')); } catch (e) {}
}

// WebSocket test client that records every message.
async function connect() {
  const WebSocket = require('ws');
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const client = {
    ws,
    messages: [],
    closed: false,
    send(obj) { ws.send(JSON.stringify(obj)); },
    /**
     * Wait for the first message matching pred, starting the scan at `since`
     * (an index into client.messages). Returns { msg, index }.
     */
    waitFor(pred, { since = 0, timeout = 8000, label = 'message' } = {}) {
      return new Promise((resolve, reject) => {
        const check = () => {
          for (let i = since; i < client.messages.length; i++) {
            if (pred(client.messages[i])) {
              cleanupWait();
              return resolve({ msg: client.messages[i], index: i });
            }
            since = i + 1;
          }
        };
        const onMessage = () => check();
        const timer = setTimeout(() => {
          cleanupWait();
          const tail = client.messages.slice(-12).map(m => JSON.stringify(m).slice(0, 160));
          reject(new Error(`Timed out waiting for ${label}. Last messages:\n${tail.join('\n')}`));
        }, timeout);
        function cleanupWait() { clearTimeout(timer); client._listeners.delete(onMessage); }
        client._listeners.add(onMessage);
        check();
      });
    },
    /** Sugar: wait for a message of type/subtype in this conversation. */
    waitForEvent(type, subtype, convoId, opts = {}) {
      return client.waitFor(
        m => m.type === type && (subtype == null || m.subtype === subtype) && (convoId == null || m._conversationId === convoId),
        { ...opts, label: opts.label || `${type}/${subtype || '*'} convo=${convoId}` }
      );
    },
    close() {
      client.closed = true;
      try { ws.close(); } catch (e) {}
    },
    _listeners: new Set(),
  };
  ws.on('message', (data) => {
    client.messages.push(JSON.parse(data.toString()));
    for (const l of [...client._listeners]) l();
  });
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  clients.push(client);
  return client;
}

// Deterministic wait helper for the few places where the absence of an event
// must be asserted (e.g. "no auto-resume"). Bounded and explicit.
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// Kill every process attached to a conversation entry (delegate + parked
// parents). Test-level cleanup for scenarios that intentionally leave live
// processes behind.
function reapConvo(convoId) {
  const entry = internal.chatProcesses.get(convoId);
  if (!entry) return;
  const targets = [entry, entry.delegation?.originalEntry, entry.delegation?.orchestratorEntry];
  for (const e of targets) {
    if (e && e.process) {
      try { e.process.kill('SIGKILL'); } catch (err) {}
      e.exited = true;
      e.cancelled = true;
    }
  }
  internal.chatProcesses.delete(convoId);
}

async function shutdown() {
  for (const c of clients.splice(0)) c.close();
  if (!internal) return;
  // Reap EVERY child the server ever spawned. Parked parents and orphaned
  // stubs are not always in chatProcesses; the PID file tracks them all.
  // Without this, a surviving stub keeps the test process's event loop alive
  // and the whole run hangs after the last test.
  const pids = new Set();
  try { for (const p of internal.loadPidFile()) pids.add(p); } catch (e) {}
  for (const [, entry] of internal.chatProcesses) {
    if (entry.process && entry.process.pid) pids.add(entry.process.pid);
  }
  try { internal.killAllChildren(); } catch (e) {}
  for (const pid of pids) {
    try { process.kill(pid, 'SIGKILL'); } catch (e) { /* already gone */ }
  }
  try { internal.wss.clients.forEach(c => c.terminate()); } catch (e) {}
  await new Promise(resolve => internal.server.close(resolve));
}

let convoCounter = 0;
function freshConvoId(prefix = 'it') {
  return `${prefix}-${Date.now().toString(36)}-${++convoCounter}`;
}

module.exports = {
  boot, shutdown, connect, writeScenario, writeCodexScenario, readInvocations, clearInvocations,
  delay, freshConvoId, reapConvo,
  get internal() { return internal; },
  get port() { return port; },
  get workspaceDir() { return workspaceDir; },
  STUB_DIR, CODEX_STUB_DIR,
};
