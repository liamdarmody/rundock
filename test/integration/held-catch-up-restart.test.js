'use strict';
// A CATCH-UP HELD BY A PAUSED FRESH START OUTLIVES A REAL RESTART.
//
// The in-process harness boots server.js once per test file, and a restart is
// exactly what a single require cannot stage: module state survives it. So this
// file starts server.js as its own process, three times in sequence, against
// one disposable workspace and home, with the stub runtime on PATH.
//
// The first server makes a circuit-breaker fresh start for real: three
// handbacks with no message from the person in between, the third to an
// orchestrator whose stored session Claude Code no longer has. That fresh
// start has no prompt of its own and holds the conversation's catch-up for the
// next message. The first server is then stopped, and the next message is sent
// to a second server: it must carry the catch-up, once. A third server is sent
// the message after that, which must not carry it again.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { makeWorkspace, standardTeam } = require('../helpers/workspace.js');
const { CATCH_UP_HEADINGS } = require('../../lib/delegation/catch-up.js');

const ARRIVING = CATCH_UP_HEADINGS.arriving;
const SERVER = path.join(__dirname, '..', '..', 'server.js');
const STUB_CLAUDE = path.join(__dirname, '..', 'helpers', 'stub-claude');
const STUB_CODEX = path.join(__dirname, '..', 'helpers', 'stub-codex');
const BANNER_TIMEOUT_MS = 20000;
const CONVO = 'held-across-restart';

let home;
let workspace;

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-held-restart-home-'));
  workspace = makeWorkspace({ agents: standardTeam(), claudeMd: '# Held catch-up across a restart\n' });
});
after(() => { fs.rmSync(home, { recursive: true, force: true }); });

function bootChild() {
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PATH: STUB_CLAUDE + path.delimiter + STUB_CODEX + path.delimiter + process.env.PATH,
      PORT: '0', HOME: home, USERPROFILE: home, RUNDOCK_ELECTRON: '1', WORKSPACE: workspace,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no banner within ${BANNER_TIMEOUT_MS}ms:\n${out}`)), BANNER_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      out += chunk.toString();
      const m = /Rundock is running: (http:\/\/localhost:(\d+)\/#c=[A-Za-z0-9_-]+)/.exec(out);
      if (m) { clearTimeout(timer); resolve({ port: Number(m[2]), link: m[1] }); }
    });
    child.stderr.on('data', (chunk) => { out += chunk.toString(); });
    child.once('error', (err) => { clearTimeout(timer); reject(err); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited with ${code} before its banner:\n${out}`)); });
  });
  return { child, ready, output: () => out };
}

function stopChild(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
  });
}

/** A socket that keeps every message, and waits for one that matches. */
async function connect({ port, link }) {
  const WebSocket = require('ws');
  const headers = await require('../../scripts/sign-in-link.js').exchangeForSession(link);
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
  const messages = [];
  ws.on('message', (data) => { try { messages.push(JSON.parse(data.toString())); } catch (e) { /* not JSON */ } });
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  const waitFor = async (pred, label, timeout = 20000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const found = messages.find(pred);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`timed out waiting for ${label}; last: ${JSON.stringify(messages.slice(-5)).slice(0, 1500)}`);
  };
  return { send: (m) => ws.send(JSON.stringify(m)), messages, waitFor, close: () => ws.close() };
}

async function until(fn, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const file = (name) => path.join(workspace, name);
function readLines(name) {
  if (!fs.existsSync(file(name))) return [];
  return fs.readFileSync(file(name), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
const prompts = () => readLines('stub-prompts.jsonl').map((p) => p.prompt);
function stored() {
  const all = JSON.parse(fs.readFileSync(file(path.join('.rundock', 'conversations.json')), 'utf8'));
  return all.find((c) => c.id === CONVO) || null;
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return false; } }
/** Every runtime process the server started has exited. */
const allExited = () => readLines('stub-invocations.jsonl').every((i) => !alive(i.pid));

function resultFrom(text) {
  return (m) => m.type === 'result' && m._conversationId === CONVO && String(m.result || '').includes(text);
}

test('a catch-up held by a paused fresh start reaches the next message once after a restart, and not after the next', async () => {
  // Three stored orchestrator sessions Claude Code no longer has, so each
  // handback is refused and starts the orchestrator fresh; and the
  // specialist's session, which it still has.
  fs.mkdirSync(file('.rundock'), { recursive: true });
  fs.writeFileSync(file(path.join('.rundock', 'conversations.json')), JSON.stringify([{
    id: CONVO, title: CONVO, status: 'active', agentId: 'chief-of-staff', activeAgentId: 'content-lead',
    sessionId: 'dead-orch-c', createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
    sessionIds: [
      { agentId: 'chief-of-staff', sessionId: 'dead-orch-a' },
      { agentId: 'chief-of-staff', sessionId: 'dead-orch-b' },
      { agentId: 'chief-of-staff', sessionId: 'dead-orch-c' },
      { agentId: 'content-lead', sessionId: 'live-lead-rs' },
    ],
  }], null, 2));
  fs.writeFileSync(file('stub-scenario.json'), JSON.stringify({
    deadSessions: ['dead-orch-a', 'dead-orch-b', 'dead-orch-c'],
    rules: [
      // A fresh orchestrator given the handback answers it and exits, so the
      // next message starts a new process and is not a follow-up, which would
      // count as the person speaking and reset the circuit breaker.
      { match: { promptIncludes: 'routing-request' }, turn: [{ text: 'ROUTED-RS' }], exitAfterTurn: 0 },
      { match: { promptIncludes: 'NEXT-RS' }, turn: [{ text: 'ORCH-NEXT-RS' }] },
      { match: { promptIncludes: 'AFTER-RS' }, turn: [{ text: 'ORCH-AFTER-RS' }] },
      { match: { resume: true, promptIncludes: 'TASK-RS' }, turn: [{ text: 'Not mine, handing back RS. <!-- RUNDOCK:RETURN -->' }] },
    ],
  }, null, 2));

  // ── THE FIRST SERVER: three handbacks, the third paused by the breaker ──
  const first = bootChild();
  let client;
  try {
    client = await connect(await first.ready);
    for (const n of [1, 2]) {
      const since = client.messages.length;
      client.send({ type: 'chat', conversationId: CONVO, agent: 'content-lead', content: `do TASK-RS, part ${n}`, sessionId: 'live-lead-rs' });
      await client.waitFor((m) => client.messages.indexOf(m) >= since && resultFrom('ROUTED-RS')(m), `handback ${n} answered`);
      await until(allExited, `the processes of handback ${n} to exit`);
    }
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: CONVO, agent: 'content-lead', content: 'do TASK-RS, part 3', sessionId: 'live-lead-rs' });
    await client.waitFor((m) => client.messages.indexOf(m) >= since && m.type === 'assistant' && m._conversationId === CONVO
      && /Auto-paused/.test(JSON.stringify(m)), 'the circuit breaker pauses the third handback');
    await client.waitFor((m) => client.messages.indexOf(m) >= since && m.subtype === 'info' && m._conversationId === CONVO
      && m.expiredSessionId === 'dead-orch-a', 'the orchestrator starting fresh');
    assert.ok(!prompts().some((p) => p.includes(ARRIVING) && p.includes('TASK-RS, part 3') && !p.includes('routing-request')),
      'the paused fresh start was sent nothing');
    client.close();
  } finally {
    await stopChild(first.child);
  }

  // ── THE SECOND SERVER: the next message carries the catch-up ──
  fs.rmSync(file('stub-prompts.jsonl'), { force: true });
  const second = bootChild();
  let orchSession;
  try {
    client = await connect(await second.ready);
    client.send({ type: 'chat', conversationId: CONVO, agent: 'chief-of-staff', content: 'NEXT-RS please' });
    await client.waitFor(resultFrom('ORCH-NEXT-RS'), 'the next message answered');
    const init = await client.waitFor((m) => m.type === 'system' && m.subtype === 'init' && m._conversationId === CONVO && m._sessionId, 'its session');
    orchSession = init._sessionId;
    client.close();
  } finally {
    await stopChild(second.child);
  }
  assert.strictEqual(prompts().length, 1, 'one message, one prompt');
  const next = prompts()[0];
  assert.ok(next.startsWith(ARRIVING), 'the conversation, as an arrival, leads the next message');
  assert.match(next, /do TASK-RS, part 3/, 'with the request the specialist was working on');
  assert.match(next, /Not mine, handing back RS\./, 'and what the specialist handed back');
  assert.ok(next.endsWith('NEXT-RS please'), 'then the person\'s own words, as sent');
  assert.ok(stored() && !('freshCatchUp' in stored()), 'and it is spent');

  // ── THE THIRD SERVER: the message after it does not carry it again ──
  const third = bootChild();
  try {
    client = await connect(await third.ready);
    client.send({ type: 'chat', conversationId: CONVO, agent: 'chief-of-staff', content: 'AFTER-RS too', sessionId: orchSession });
    await client.waitFor(resultFrom('ORCH-AFTER-RS'), 'the message after it answered');
    client.close();
  } finally {
    await stopChild(third.child);
  }
  assert.deepStrictEqual(prompts().slice(1), ['AFTER-RS too'], 'as sent: given once, not again after the next restart');
  assert.strictEqual(prompts().filter((p) => p.includes(ARRIVING)).length, 1);
});
