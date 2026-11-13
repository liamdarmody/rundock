'use strict';
// A CARD STILL OPEN WHEN RUNDOCK STOPS WRITES NOTHING, then or after, and the
// conversation is told.
//
// The in-process harness boots server.js once per test file, so a restart
// cannot be staged there. This file starts server.js as its own process, twice
// in sequence, against one disposable workspace and home, with the stub
// runtime on PATH (the pattern of team-notes-restart.test.js).
//
// The first server brings Doc in for the orchestrator, and Doc's save raises
// its card. The server is stopped with the card open. The second server is
// sent an answer to that old card, which must write nothing; the conversation
// must show the change as refused, and its next turn must be told so.
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
const CONVO = 'handoff-card-across-restart';
const NAME = 'restart-card-helper';
const HEADING = 'WHAT RUNDOCK DID WITH THE LAST REPLY:';

let home;
let workspace;

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-handoff-card-restart-home-'));
  workspace = makeWorkspace({ agents: standardTeam(), claudeMd: '# Hand-off card across a restart\n' });
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
const agentPath = () => file(path.join('.claude', 'agents', `${NAME}.md`));
const prompts = () => readAppendedLog(file('stub-prompts.jsonl')).map((p) => p.prompt);
const stored = () => JSON.parse(fs.readFileSync(file(path.join('.rundock', 'conversations.json')), 'utf8')).find((c) => c.id === CONVO) || null;
const teamLines = () => {
  const f = file(path.join('.rundock', 'transcripts', `${CONVO}.json`));
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).filter((t) => t.type === 'team').map((t) => t.text) : [];
};

test('a card open when the server stops writes nothing, an answer to it after the restart writes nothing, and the conversation and its next turn are told', async () => {
  fs.mkdirSync(file('.rundock'), { recursive: true });
  fs.writeFileSync(file(path.join('.rundock', 'conversations.json')), JSON.stringify([{
    id: CONVO, title: CONVO, status: 'active', agentId: 'chief-of-staff', activeAgentId: 'chief-of-staff', sessionIds: [],
    createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
  }], null, 2));
  const helper = agentFile({ name: NAME, displayName: 'Helper', role: 'Example Role', type: 'specialist', order: 30, body: 'You help.' }).trim();
  fs.writeFileSync(file('stub-scenario.json'), JSON.stringify({ rules: [
    { match: { agent: 'rundock-guide', promptIncludes: 'RC-BRIEF' },
      turn: [{ text: `RC-DONE made it.\n<!-- RUNDOCK:SAVE_AGENT name=${NAME} -->\n${helper}\n<!-- /RUNDOCK:SAVE_AGENT -->` }] },
    { match: { agent: 'chief-of-staff', promptIncludes: 'RC-ASK' },
      turn: [{ agentTool: { subagent_type: 'rundock-guide', prompt: 'RC-BRIEF add the helper' } }] },
    { match: { agent: 'chief-of-staff', promptIncludes: 'RC-NEXT' }, turn: [{ text: 'RC-NEXT-ANSWERED' }] },
  ] }, null, 2));

  // ── THE FIRST SERVER: the card is raised, then the server stops ──
  const first = bootChild();
  let client;
  let card;
  try {
    client = await connect(await first.ready);
    client.send({ type: 'chat', conversationId: CONVO, agent: 'chief-of-staff', content: 'RC-ASK add a helper' });
    card = await client.waitFor((m) => m.type === 'control_request' && m._conversationId === CONVO && m.request.tool_name === 'SaveAgent', 'the card');
    assert.strictEqual(Object.keys((stored() || {}).teamCards || {}).length, 1, 'the open card is held on the conversation\'s record');
    client.close();
  } finally {
    await stopChild(first.child);
  }
  assert.strictEqual(fs.existsSync(agentPath()), false, 'nothing was written before the stop');

  // ── THE SECOND SERVER: the old card writes nothing, and the change is told as refused ──
  const line = `Doc asked to save the agent "${NAME}", but Rundock stopped before anyone answered the card, so nothing was saved.`;
  const second = bootChild();
  try {
    client = await connect(await second.ready);
    const waiting = await client.waitFor((m) => m.type === 'pending_permissions', 'the cards still waiting');
    assert.ok(!waiting.requestIds.includes(card.request_id), 'the old card is not waiting');
    client.send({ type: 'permission_response', requestId: card.request_id, conversationId: CONVO, allow: true, card: true });
    await client.waitFor((m) => m.type === 'permission_ended' && m.requestId === card.request_id && m.reason === 'not-pending', 'the answer refused');
    assert.strictEqual(fs.existsSync(agentPath()), false, 'an answer to the old card writes nothing');
    assert.deepStrictEqual(teamLines(), [line], 'the conversation shows the change as refused');
    assert.ok(!('teamCards' in stored()), 'and the record no longer holds the card');
    client.send({ type: 'chat', conversationId: CONVO, agent: 'chief-of-staff', content: 'RC-NEXT did it work?' });
    await client.waitFor((m) => m.type === 'result' && m._conversationId === CONVO && String(m.result || '').includes('RC-NEXT-ANSWERED'), 'the next turn, answered');
    client.close();
  } finally {
    await stopChild(second.child);
  }
  const told = prompts().filter((p) => p.includes('RC-NEXT'));
  assert.strictEqual(told.length, 1);
  assert.ok(told[0].includes(`${HEADING}\n- Refused: save agent "${NAME}", asked by Doc. ${line}\n\n`), `the next turn is told (got ${JSON.stringify(told[0].slice(0, 400))})`);
  assert.strictEqual(fs.existsSync(agentPath()), false);
});
