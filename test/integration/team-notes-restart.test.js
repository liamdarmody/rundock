'use strict';
// WHAT RUNDOCK DID WITH A REPLY'S TEAM MARKERS OUTLIVES A REAL RESTART.
//
// The in-process harness boots server.js once per test file, and module state
// survives a single require, so a restart cannot be staged there. This file
// starts server.js as its own process, twice in sequence, against one
// disposable workspace and home, with the stub runtime on PATH (the pattern of
// held-catch-up-restart.test.js).
//
// The first server runs a specialist's turn whose save marker is refused, and
// is stopped before the conversation's next turn. The second server is sent
// that next turn: it must open with the refusal, once, and the record must no
// longer hold it afterwards.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { makeWorkspace, standardTeam, agentFile } = require('../helpers/workspace.js');
const { readAppendedLog } = require('../helpers/appended-log.js');

const SERVER = path.join(__dirname, '..', '..', 'server.js');
const STUB_CLAUDE = path.join(__dirname, '..', 'helpers', 'stub-claude');
const STUB_CODEX = path.join(__dirname, '..', 'helpers', 'stub-codex');
const BANNER_TIMEOUT_MS = 20000;
const CONVO = 'team-note-across-restart';
const HEADING = 'WHAT RUNDOCK DID WITH THE LAST REPLY:';

let home;
let workspace;

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-team-note-restart-home-'));
  workspace = makeWorkspace({ agents: standardTeam(), claudeMd: '# Team note across a restart\n' });
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
  return { child, ready };
}

function stopChild(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
  });
}

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

const file = (name) => path.join(workspace, name);
const prompts = () => readAppendedLog(file('stub-prompts.jsonl')).map((p) => p.prompt);
const stored = () => JSON.parse(fs.readFileSync(file(path.join('.rundock', 'conversations.json')), 'utf8')).find((c) => c.id === CONVO) || null;
const resultFrom = (text) => (m) => m.type === 'result' && m._conversationId === CONVO && String(m.result || '').includes(text);

test('a refusal not yet told is told to the next turn after a restart, once, and then removed from the record', async () => {
  fs.mkdirSync(file('.rundock'), { recursive: true });
  fs.writeFileSync(file(path.join('.rundock', 'conversations.json')), JSON.stringify([{
    id: CONVO, title: CONVO, status: 'active', agentId: 'content-lead', activeAgentId: 'content-lead', sessionIds: [],
    createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
  }], null, 2));
  const helper = agentFile({ name: 'restart-helper', displayName: 'Helper', role: 'Example Role', type: 'specialist', order: 30, body: 'You help.' }).trim();
  fs.writeFileSync(file('stub-scenario.json'), JSON.stringify({ rules: [
    { match: { promptIncludes: 'RS-ONE' }, turn: [{ text: `Saved it.\n<!-- RUNDOCK:SAVE_AGENT name=restart-helper -->\n${helper}\n<!-- /RUNDOCK:SAVE_AGENT -->` }] },
    { match: { promptIncludes: 'RS-TWO' }, turn: [{ text: 'RS-TWO-ANSWERED' }] },
    { match: { promptIncludes: 'RS-THREE' }, turn: [{ text: 'RS-THREE-ANSWERED' }] },
  ] }, null, 2));

  // ── THE FIRST SERVER: the refused turn, then stopped before the next ──
  const first = bootChild();
  let client;
  let sessionId;
  try {
    client = await connect(await first.ready);
    client.send({ type: 'chat', conversationId: CONVO, agent: 'content-lead', content: 'RS-ONE save the helper' });
    await client.waitFor(resultFrom('Saved it.'), 'the refused turn');
    await client.waitFor((m) => m.type === 'agent_error' && m.conversationId === CONVO && m.refused === true, 'the refusal');
    sessionId = (await client.waitFor((m) => m.type === 'system' && m.subtype === 'init' && m._conversationId === CONVO && m._sessionId, 'its session'))._sessionId;
    client.close();
  } finally {
    await stopChild(first.child);
  }
  assert.strictEqual(stored().teamOutcomes.length, 1, 'the outcome not yet told is on the conversation\'s record');

  // ── THE SECOND SERVER: the next turn is told, once ──
  const refusal = 'Wren asked to save the agent "restart-helper", but only Doc can change the team, so nothing was saved. Ask Doc to make this change.';
  const second = bootChild();
  try {
    client = await connect(await second.ready);
    client.send({ type: 'chat', conversationId: CONVO, agent: 'content-lead', content: 'RS-TWO did it work?', sessionId });
    await client.waitFor(resultFrom('RS-TWO-ANSWERED'), 'the next turn');
    assert.ok(!stored() || !('teamOutcomes' in stored()), 'and once told it is removed from the record');
    client.send({ type: 'chat', conversationId: CONVO, agent: 'content-lead', content: 'RS-THREE and now?', sessionId });
    await client.waitFor(resultFrom('RS-THREE-ANSWERED'), 'the turn after');
    client.close();
  } finally {
    await stopChild(second.child);
  }
  assert.deepStrictEqual(prompts().filter((p) => p.includes('RS-TWO')),
    [`${HEADING}\n- Refused: save agent "restart-helper", asked by Wren. ${refusal}\n\nRS-TWO did it work?`]);
  assert.deepStrictEqual(prompts().filter((p) => p.includes('RS-THREE')), ['RS-THREE and now?'], 'told once, not again');
  assert.strictEqual(fs.existsSync(file(path.join('.claude', 'agents', 'restart-helper.md'))), false);
});

// The first turn of a conversation can end before any window has saved it.
const UNSAVED = 'team-note-unsaved-across-restart';
const recordOf = (id) => {
  try { return JSON.parse(fs.readFileSync(file(path.join('.rundock', 'conversations.json')), 'utf8')).find((c) => c.id === id) || null; } catch (e) { return null; }
};
async function eventually(check, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test('the first turn of a conversation no window has saved: its refusal is kept on a record of its own, the window\'s save keeps it, and a restart tells it once', async () => {
  const helper = agentFile({ name: 'unsaved-helper', displayName: 'Helper', role: 'Example Role', type: 'specialist', order: 30, body: 'You help.' }).trim();
  fs.writeFileSync(file('stub-scenario.json'), JSON.stringify({ rules: [
    { match: { promptIncludes: 'US-ONE' }, turn: [{ text: `Saved it.\n<!-- RUNDOCK:SAVE_AGENT name=unsaved-helper -->\n${helper}\n<!-- /RUNDOCK:SAVE_AGENT -->` }] },
    { match: { promptIncludes: 'US-TWO' }, turn: [{ text: 'US-TWO-ANSWERED' }] },
    { match: { promptIncludes: 'US-THREE' }, turn: [{ text: 'US-THREE-ANSWERED' }] },
  ] }, null, 2));
  const answered = (text) => (m) => m.type === 'result' && m._conversationId === UNSAVED && String(m.result || '').includes(text);
  assert.strictEqual(recordOf(UNSAVED), null, 'no record of the conversation yet');

  // ── THE FIRST SERVER: the refused turn, with no record, then the window's save ──
  const first = bootChild();
  let client;
  let sessionId;
  try {
    client = await connect(await first.ready);
    client.send({ type: 'chat', conversationId: UNSAVED, agent: 'content-lead', content: 'US-ONE save the helper' });
    await client.waitFor(answered('Saved it.'), 'the refused turn');
    sessionId = (await client.waitFor((m) => m.type === 'system' && m.subtype === 'init' && m._conversationId === UNSAVED && m._sessionId, 'its session'))._sessionId;
    await eventually(() => recordOf(UNSAVED), 'a record holding the outcome');
    assert.deepStrictEqual(Object.keys(recordOf(UNSAVED)).sort(), ['id', 'teamOutcomes'], 'a record of its own, holding the outcome only');
    assert.strictEqual(recordOf(UNSAVED).teamOutcomes.length, 1);
    // The save a window sends after a turn: the metadata it holds, never the outcomes.
    client.send({ type: 'save_conversation', conversation: {
      id: UNSAVED, agentId: 'content-lead', title: 'Unsaved until now', status: 'active',
      sessionId, sessionIds: [{ sessionId, agentId: 'content-lead' }], createdAt: new Date().toISOString(),
    } });
    await eventually(() => recordOf(UNSAVED) && recordOf(UNSAVED).title === 'Unsaved until now', 'the window\'s save');
    assert.strictEqual(recordOf(UNSAVED).teamOutcomes.length, 1, 'the window\'s save keeps the outcome');
    client.close();
  } finally {
    await stopChild(first.child);
  }

  // ── THE SECOND SERVER: the next turn is told, once ──
  const refusal = 'Wren asked to save the agent "unsaved-helper", but only Doc can change the team, so nothing was saved. Ask Doc to make this change.';
  const second = bootChild();
  try {
    client = await connect(await second.ready);
    client.send({ type: 'chat', conversationId: UNSAVED, agent: 'content-lead', content: 'US-TWO did it work?', sessionId });
    await client.waitFor(answered('US-TWO-ANSWERED'), 'the next turn');
    client.send({ type: 'chat', conversationId: UNSAVED, agent: 'content-lead', content: 'US-THREE and now?', sessionId });
    await client.waitFor(answered('US-THREE-ANSWERED'), 'the turn after');
    client.close();
  } finally {
    await stopChild(second.child);
  }
  assert.deepStrictEqual(prompts().filter((p) => p.includes('US-TWO')),
    [`${HEADING}\n- Refused: save agent "unsaved-helper", asked by Wren. ${refusal}\n\nUS-TWO did it work?`]);
  assert.deepStrictEqual(prompts().filter((p) => p.includes('US-THREE')), ['US-THREE and now?'], 'told once, not again');
  assert.ok(!('teamOutcomes' in recordOf(UNSAVED)), 'and removed from the record');
  assert.strictEqual(recordOf(UNSAVED).title, 'Unsaved until now', 'which keeps the window\'s metadata');
});
