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
  // Told why in Rundock's own sentence, never the line a person reads.
  assert.ok(told[0].startsWith(`${HEADING}\n- Refused: save agent "${NAME}", asked by Doc. Rundock stopped before anyone answered the card, so nothing was saved.\n\n`),
    `the next turn is told (got ${JSON.stringify(told[0].slice(0, 400))})`);
  assert.strictEqual(fs.existsSync(agentPath()), false);
});

// THE FIRST TURN OF A CONVERSATION CAN END WITH ITS CARD OPEN BEFORE ANY
// WINDOW HAS SAVED THE CONVERSATION. The card is held all the same, on a
// record of its own, which a window's save keeps; and after a restart it
// writes nothing and is told, as a card on a saved conversation is.
const UNSAVED = 'handoff-card-unsaved-across-restart';
const UNSAVED_NAME = 'unsaved-card-helper';
const recordOf = (id) => {
  try { return JSON.parse(fs.readFileSync(file(path.join('.rundock', 'conversations.json')), 'utf8')).find((c) => c.id === id) || null; } catch (e) { return null; }
};
const linesOf = (id) => {
  const f = file(path.join('.rundock', 'transcripts', `${id}.json`));
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).filter((t) => t.type === 'team').map((t) => t.text) : [];
};
async function eventually(check, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test('a card raised before any window saved its conversation is held on a record of its own, the window\'s save keeps it, and after a restart it writes nothing and is told once', async () => {
  const helper = agentFile({ name: UNSAVED_NAME, displayName: 'Helper', role: 'Example Role', type: 'specialist', order: 30, body: 'You help.' }).trim();
  const unsavedPath = file(path.join('.claude', 'agents', `${UNSAVED_NAME}.md`));
  fs.writeFileSync(file('stub-scenario.json'), JSON.stringify({ rules: [
    { match: { agent: 'rundock-guide', promptIncludes: 'UC-BRIEF' },
      turn: [{ text: `UC-DONE made it.\n<!-- RUNDOCK:SAVE_AGENT name=${UNSAVED_NAME} -->\n${helper}\n<!-- /RUNDOCK:SAVE_AGENT -->` }] },
    { match: { agent: 'chief-of-staff', promptIncludes: 'UC-ASK' },
      turn: [{ agentTool: { subagent_type: 'rundock-guide', prompt: 'UC-BRIEF add the helper' } }] },
    { match: { agent: 'chief-of-staff', promptIncludes: 'UC-NEXT' }, turn: [{ text: 'UC-NEXT-ANSWERED' }] },
    { match: { agent: 'chief-of-staff', promptIncludes: 'UC-AFTER' }, turn: [{ text: 'UC-AFTER-ANSWERED' }] },
  ] }, null, 2));
  assert.strictEqual(recordOf(UNSAVED), null, 'no record of the conversation yet');

  // ── THE FIRST SERVER: the card is raised with no record, then the window's save, then the stop ──
  const first = bootChild();
  let client;
  let card;
  try {
    client = await connect(await first.ready);
    client.send({ type: 'chat', conversationId: UNSAVED, agent: 'chief-of-staff', content: 'UC-ASK add a helper' });
    card = await client.waitFor((m) => m.type === 'control_request' && m._conversationId === UNSAVED && m.request.tool_name === 'SaveAgent', 'the card');
    await eventually(() => recordOf(UNSAVED), 'a record holding the open card');
    assert.deepStrictEqual(Object.keys(recordOf(UNSAVED)).sort(), ['id', 'teamCards'], 'a record of its own, holding the card only');
    assert.strictEqual(Object.keys(recordOf(UNSAVED).teamCards).length, 1);
    // A record that only holds the server's own fields is not a conversation a window can show.
    const listed = async (label) => {
      const since = client.messages.length;
      client.send({ type: 'get_conversations' });
      const reply = await client.waitFor((m) => m.type === 'conversations' && client.messages.indexOf(m) >= since, label);
      return reply.conversations.map((c) => c.id);
    };
    assert.ok(!(await listed('the list before any save')).includes(UNSAVED), 'not listed while only its card is held');
    // The save a window sends: the metadata it holds, never the card.
    client.send({ type: 'save_conversation', conversation: {
      id: UNSAVED, agentId: 'chief-of-staff', title: 'Unsaved until now', status: 'active', sessionIds: [], createdAt: new Date().toISOString(),
    } });
    await eventually(() => recordOf(UNSAVED) && recordOf(UNSAVED).title === 'Unsaved until now', 'the window\'s save');
    assert.strictEqual(Object.keys(recordOf(UNSAVED).teamCards || {}).length, 1, 'the window\'s save keeps the card');
    assert.ok((await listed('the list after the save')).includes(UNSAVED), 'listed once a window has saved it');
    client.close();
  } finally {
    await stopChild(first.child);
  }
  assert.strictEqual(fs.existsSync(unsavedPath), false, 'nothing was written before the stop');

  // ── THE SECOND SERVER: the old card writes nothing, the conversation shows it, and the next turn is told once ──
  const line = `Doc asked to save the agent "${UNSAVED_NAME}", but Rundock stopped before anyone answered the card, so nothing was saved.`;
  const second = bootChild();
  try {
    client = await connect(await second.ready);
    await client.waitFor((m) => m.type === 'pending_permissions', 'the cards still waiting');
    client.send({ type: 'permission_response', requestId: card.request_id, conversationId: UNSAVED, allow: true, card: true });
    await client.waitFor((m) => m.type === 'permission_ended' && m.requestId === card.request_id && m.reason === 'not-pending', 'the answer refused');
    assert.strictEqual(fs.existsSync(unsavedPath), false, 'an answer to the old card writes nothing');
    assert.deepStrictEqual(linesOf(UNSAVED), [line], 'the conversation shows the change as refused');
    assert.ok(!('teamCards' in recordOf(UNSAVED)), 'and the record no longer holds the card');
    client.send({ type: 'chat', conversationId: UNSAVED, agent: 'chief-of-staff', content: 'UC-NEXT did it work?' });
    await client.waitFor((m) => m.type === 'result' && m._conversationId === UNSAVED && String(m.result || '').includes('UC-NEXT-ANSWERED'), 'the next turn');
    client.send({ type: 'chat', conversationId: UNSAVED, agent: 'chief-of-staff', content: 'UC-AFTER and now?' });
    await client.waitFor((m) => m.type === 'result' && m._conversationId === UNSAVED && String(m.result || '').includes('UC-AFTER-ANSWERED'), 'the turn after');
    client.close();
  } finally {
    await stopChild(second.child);
  }
  const told = prompts().filter((p) => p.includes('UC-NEXT'));
  assert.strictEqual(told.length, 1);
  assert.ok(told[0].startsWith(`${HEADING}\n- Refused: save agent "${UNSAVED_NAME}", asked by Doc. Rundock stopped before anyone answered the card, so nothing was saved.\n\n`),
    `the next turn is told (got ${JSON.stringify(told[0].slice(0, 400))})`);
  assert.deepStrictEqual(prompts().filter((p) => p.includes('UC-AFTER')).map((p) => p.includes(HEADING)), [false], 'told once, not again');
  assert.strictEqual(recordOf(UNSAVED).title, 'Unsaved until now', 'the record keeps the window\'s metadata');
  assert.strictEqual(fs.existsSync(unsavedPath), false);
});
