'use strict';
// The line under a finished reply that says what the turn used, in the real
// client against the real server, from each runtime's own result.
//
// WHAT IS ASSERTED, AND WHERE. A stub runtime finishes one turn with a time
// and token counts of its own: Claude Code through the stub claude binary's
// result, Codex through the stub codex app-server's token usage and turn
// completion. On the page: one line under the reply with the time in words,
// and its Details button, which opens and closes the token sentence from the
// keyboard alone (Enter, Escape, Space), focus staying on the button.
//
// IN CONVERSATIONS OF THEIR OWN, deleted afterwards, never a seeded one: the
// specs share one server and one workspace. The Codex agent and both scenario
// files are removed once the test is over, whatever happened.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');
const credentials = require('./credentials.js');

const PORT = Number(process.env.E2E_PORT || 34517);
const STUB_VERSION = '2.1.318-stub';
const CODEX_STUB_VERSION = '0.0.0-stub';
const CODEX_AGENT = 'ash';

function overWs(fn) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`, { headers: credentials.sessionHeaders() });
    const messages = [];
    const waitFor = (pred) => new Promise((ok, no) => {
      const timer = setTimeout(() => no(new Error('timed out waiting over the socket')), 10000);
      const check = () => { const m = messages.find(pred); if (m) { clearTimeout(timer); ok(m); return true; } return false; };
      if (!check()) ws.on('message', check);
    });
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
    ws.on('error', reject);
    ws.on('open', () => fn({ send: (o) => ws.send(JSON.stringify(o)), waitFor }).then((v) => { ws.close(); resolve(v); }, reject));
  });
}

let workspace = null;
let codexVersion = null;
const scenarioFile = () => path.join(workspace, 'stub-scenario.json');
const codexScenarioFile = () => path.join(workspace, 'stub-codex-scenario.json');
const codexAgentFile = () => path.join(workspace, '.claude', 'agents', `${CODEX_AGENT}.md`);

// The roster as the server reads it now: its cache expires on its own.
const rosterHas = (id) => overWs(async ({ send, waitFor }) => {
  send({ type: 'get_agents' });
  const roster = await waitFor((m) => m.type === 'agents');
  return roster.agents.some((a) => a.id === id && (id !== CODEX_AGENT || a.runtime === 'codex'));
});

test.beforeAll(async () => {
  const found = await overWs(async ({ send, waitFor }) => {
    send({ type: 'get_runtime_status' });
    const status = await waitFor((m) => m.type === 'runtime_status');
    if (!(status.claude && status.claude.version === STUB_VERSION)) return null;
    send({ type: 'get_workspaces' });
    const set = await waitFor((m) => m.type === 'workspaces' && m.current);
    return { workspace: set.current, codexVersion: status.codex ? status.codex.version : null };
  });
  if (found) ({ workspace, codexVersion } = found);
});

test.afterAll(async () => {
  if (!workspace) return;
  fs.rmSync(scenarioFile(), { force: true });
  fs.rmSync(codexScenarioFile(), { force: true });
  fs.rmSync(codexAgentFile(), { force: true });
  // Leave the server's roster as the next spec expects it.
  await expect.poll(() => rosterHas(CODEX_AGENT), { timeout: 15000, message: 'the Codex agent has left the roster' }).toBe(false);
});

// Every message the page receives, from before it loads.
function watch(page) {
  const received = [];
  page.on('websocket', (socket) => socket.on('framereceived', (f) => { try { received.push(JSON.parse(f.payload)); } catch (e) { /* not JSON */ } }));
  return received;
}

async function cleanUp(page, ids) {
  for (const id of ids) {
    if (id) await page.evaluate((c) => deleteConversation(c, { stopPropagation() {} }), id).catch(() => {});
  }
}

// A new conversation with the agent, opened once the page has settled, and
// the message sent from the composer.
async function start(page, agentId, title, prompt) {
  await page.goto('/');
  await expect(page.locator('.convo-item').first(), 'the page has drawn its conversations').toBeVisible();
  await expect.poll(() => page.evaluate(() => !document.getElementById('history-loading')), { message: 'the history the page opened has arrived' }).toBe(true);
  await expect.poll(() => page.evaluate((a) => agents.some((x) => x.id === a), agentId), { message: `the page knows ${agentId}` }).toBe(true);
  const id = await page.evaluate(({ a, t }) => createConversation(a, t).id, { a: agentId, t: title });
  expect(await page.evaluate(() => activeConversation && activeConversation.agentId), 'the new conversation is with the agent asked for').toBe(agentId);
  await page.locator('#msg-input').fill(prompt);
  await page.locator('#send-btn').click();
  return id;
}

// The line under the reply, then its Details button from the keyboard alone.
async function checkLine(page, { worked, tokens }) {
  const used = page.locator('#messages .turn-used');
  await expect(used, 'one line under the reply says what the turn used').toHaveCount(1);
  await expect(used.locator('.turn-used-line'), 'the line gives the time worked in words').toHaveText(worked);

  const details = used.locator('button.turn-details');
  const panel = used.locator('.turn-tokens');
  const sentence = panel.locator('.turn-tokens-line');
  await expect(details, 'the line has one Details button').toHaveCount(1);
  await expect(details, 'the button reads Details').toHaveText('Details');
  await expect(details, 'Details starts shut').toHaveAttribute('aria-expanded', 'false');
  expect(await details.getAttribute('aria-controls'), 'Details controls the token sentence').toBe(await panel.getAttribute('id'));
  await expect(panel, 'the token sentence starts hidden').toBeHidden();

  const isFocused = () => details.evaluate((el) => document.activeElement === el);
  const open = async (how) => {
    await expect(details, `${how} opens Details`).toHaveAttribute('aria-expanded', 'true');
    await expect(panel, `${how} shows the token sentence`).toBeVisible();
    await expect(sentence, `${how} shows the counts as the runtime reported them`).toHaveText(tokens);
    expect(await isFocused(), `focus stays on Details after ${how}`).toBe(true);
  };

  await details.focus();
  expect(await isFocused(), 'Details takes focus').toBe(true);
  await page.keyboard.press('Enter');
  await open('Enter');
  await page.keyboard.press('Escape');
  await expect(details, 'Escape closes Details').toHaveAttribute('aria-expanded', 'false');
  await expect(panel, 'Escape hides the token sentence').toBeHidden();
  expect(await isFocused(), 'focus stays on Details after Escape').toBe(true);
  await page.keyboard.press('Space');
  await open('Space');
  await expect(used, 'opening Details adds no second line').toHaveCount(1);
}

test('a Claude Code reply: one line with the time worked, and Details opens its token counts from the keyboard', async ({ page }) => {
  expect(workspace, 'the server must resolve the stub runtime, or nothing may be sent').toBeTruthy();
  const received = watch(page);
  const ids = [];
  try {
    fs.writeFileSync(scenarioFile(), JSON.stringify({ rules: [{
      match: { agent: 'wren', promptIncludes: 'TURN-USED-CLAUDE' },
      turn: [{ text: 'A reply from Wren.' }],
      resultExtra: { duration_ms: 245137, usage: { input_tokens: 18243, cache_read_input_tokens: 2071, output_tokens: 3917 } },
    }] }));
    const id = await start(page, 'wren', 'Turn used Claude e2e', 'TURN-USED-CLAUDE say something short');
    ids.push(id);

    const finished = (m) => m.type === 'result' && m._conversationId === id;
    await expect.poll(() => received.some(finished), { message: 'the turn\'s result reached the page' }).toBe(true);
    const result = received.find(finished);
    expect(result.duration_ms, 'the result carries the runtime\'s own time').toBe(245137);
    expect(result._runtime === undefined || result._runtime === 'claude', 'the result is Claude Code\'s').toBe(true);
    await expect(page.locator('#messages'), 'the reply is drawn').toContainText('A reply from Wren.');

    await checkLine(page, {
      worked: 'Worked 4 min 05 s',
      tokens: 'Tokens as Claude Code reported them: 18,243 input, 3,917 output, 2,071 read from cache.',
    });
  } finally {
    fs.rmSync(scenarioFile(), { force: true });
    await cleanUp(page, ids);
  }
});

test('a Codex reply: one line with the time worked, and Details opens its token counts from the keyboard', async ({ page }) => {
  expect(workspace, 'the server must resolve the stub runtime, or nothing may be sent').toBeTruthy();
  expect(codexVersion, 'the server must resolve the stub Codex, or nothing may be sent').toBe(CODEX_STUB_VERSION);
  const received = watch(page);
  const ids = [];
  try {
    fs.writeFileSync(codexAgentFile(), [
      '---', `name: ${CODEX_AGENT}`, 'displayName: Ash', 'role: Researcher', 'description: Researches suppliers',
      'type: specialist', 'order: 5', 'reportsTo: chief-of-staff', 'runtime: codex', '---',
      'You are Ash, the researcher.', '',
    ].join('\n'));
    fs.writeFileSync(codexScenarioFile(), JSON.stringify({ appServer: { rules: [{
      match: { promptIncludes: 'TURN-USED-CODEX' },
      text: 'A reply from Ash.',
      usage: { inputTokens: 52619, outputTokens: 6047 },
    }] } }));
    await expect.poll(() => rosterHas(CODEX_AGENT), { timeout: 15000, message: 'the server reads the Codex agent' }).toBe(true);

    const id = await start(page, CODEX_AGENT, 'Turn used Codex e2e', 'TURN-USED-CODEX say something short');
    ids.push(id);

    const finished = (m) => m.type === 'result' && m._conversationId === id;
    await expect.poll(() => received.some(finished), { timeout: 20000, message: 'the turn\'s result reached the page' }).toBe(true);
    const result = received.find(finished);
    expect(result._runtime, 'the result is Codex\'s').toBe('codex');
    expect(result.usage, 'the result carries the counts Codex reported').toEqual({ inputTokens: 52619, cachedInputTokens: 0, outputTokens: 6047, reasoningOutputTokens: 0 });
    await expect(page.locator('#messages'), 'the reply is drawn').toContainText('A reply from Ash.');

    await checkLine(page, {
      worked: 'Worked under 1 s',
      tokens: 'Tokens as Codex reported them: 52,619 input, 0 cached input, 6,047 output, 0 reasoning output.',
    });
  } finally {
    fs.rmSync(codexScenarioFile(), { force: true });
    fs.rmSync(codexAgentFile(), { force: true });
    await cleanUp(page, ids);
  }
});
