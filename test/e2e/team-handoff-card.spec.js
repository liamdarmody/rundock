'use strict';
// The card for a change Doc makes while another agent brought it in, in the
// real client against the real server.
//
// THE DEFECT. Any agent could bring Doc in with a brief claiming the person's
// consent, and Doc's change to an agent or skill was written with no person
// involved.
//
// WHAT IS ASSERTED, AND WHERE. On the page: the orchestrator brings Doc in,
// and Doc's save is drawn as a card in that conversation, and not in another,
// naming the agent, that it would be added, who brought Doc in, and the whole
// file that would be written, open. Nothing is written until the person
// presses Allow on it; then the file on disk is the file the card showed.
//
// IN CONVERSATIONS OF ITS OWN, deleted afterwards: the specs share one server
// and one workspace. The agent file it causes is removed afterwards, and the
// roster is read until it no longer lists it.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');
const credentials = require('./credentials.js');

const PORT = Number(process.env.E2E_PORT || 34517);
const STUB_VERSION = '2.1.318-stub';
const NAME = 'example-handoff-helper';

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
const agentFilePath = () => path.join(workspace, '.claude', 'agents', `${NAME}.md`);
const scenarioFile = () => path.join(workspace, 'stub-scenario.json');

test.beforeAll(async () => {
  workspace = await overWs(async ({ send, waitFor }) => {
    send({ type: 'get_runtime_status' });
    const status = await waitFor((m) => m.type === 'runtime_status');
    if (!(status.claude && status.claude.version === STUB_VERSION)) return null;
    send({ type: 'get_workspaces' });
    const set = await waitFor((m) => m.type === 'workspaces' && m.current);
    return set.current;
  });
});

test.afterAll(async () => {
  if (!workspace) return;
  for (const f of [scenarioFile(), agentFilePath()]) fs.rmSync(f, { force: true });
  await expect.poll(() => overWs(async ({ send, waitFor }) => {
    send({ type: 'get_agents' });
    const roster = await waitFor((m) => m.type === 'agents');
    return roster.agents.some((a) => a.id === NAME || a.name === NAME);
  }), { timeout: 15000 }).toBe(false);
});

const helperFile = [
  '---', `name: ${NAME}`, 'displayName: Example', 'role: Example Specialist', 'type: specialist', 'order: 8', 'tools: Read', '---',
  '', 'You are the example helper.', ...Array.from({ length: 40 }, (_, n) => `Instruction ${n}.`), 'The last instruction.',
].join('\n');

test('Doc brought in by the orchestrator: its save is a card in that conversation, showing the whole file, and written only on Allow', async ({ page }) => {
  expect(workspace, 'the server must resolve the stub runtime, or nothing may be sent').toBeTruthy();
  fs.writeFileSync(scenarioFile(), JSON.stringify({ rules: [
    { match: { agent: 'rundock-guide', promptIncludes: 'HANDOFF-CARD-E2E-BRIEF' },
      turn: [{ text: `HANDOFF-CARD-E2E-DONE made it.\n<!-- RUNDOCK:SAVE_AGENT name=${NAME} -->\n${helperFile}\n<!-- /RUNDOCK:SAVE_AGENT -->` }] },
    { match: { promptIncludes: '[SYSTEM: pipeline-complete]' }, turn: [{ text: '<silent>' }] },
    { match: { promptIncludes: 'HANDOFF-CARD-E2E-ASK', promptExcludes: 'DELEGATION BRIEF' },
      turn: [{ agentTool: { subagent_type: 'rundock-guide', description: 'Bringing in Doc.', prompt: 'HANDOFF-CARD-E2E-BRIEF add the helper' } }] },
  ] }));
  const received = [];
  page.on('websocket', (socket) => socket.on('framereceived', (f) => { try { received.push(JSON.parse(f.payload)); } catch (e) { /* not JSON */ } }));
  const card = page.locator('#messages .msg-permission').filter({ hasText: `Add the agent ${NAME}` });
  let first = null;
  let other = null;
  try {
    await page.goto('/');
    await expect(page.locator('.convo-item').first()).toBeVisible();
    first = await page.evaluate(() => createConversation('default', 'Hand-off card e2e').id);
    await page.locator('#msg-input').fill('HANDOFF-CARD-E2E-ASK add a helper');
    await page.locator('#send-btn').click();

    await expect(card).toHaveCount(1, { timeout: 15000 });
    await expect(card.locator('.permission-summary')).toHaveText(`Add the agent ${NAME}`);
    await expect(card.locator('.permission-context')).toContainText(`Cos brought Doc in, and Doc asked Rundock to add this agent (.claude/agents/${NAME}.md).`);
    await expect(card.locator('.permission-context')).toContainText('there is no Always allow');
    const detail = card.locator('details.permission-detail-collapse[open] .permission-file');
    await expect(detail).toContainText('The last instruction.');
    expect(await detail.evaluate((el) => el.textContent)).toBe(helperFile);
    await expect(card.locator('[data-perm-action="always"]')).toHaveCount(0);
    expect(fs.existsSync(agentFilePath()), 'nothing is written while the card waits').toBe(false);

    // Another conversation on screen does not show it; coming back does.
    other = await page.evaluate(() => createConversation('default', 'Hand-off card other e2e').id);
    await expect.poll(() => page.evaluate(() => activeConversation && activeConversation.id)).toBe(other);
    await expect(card).toHaveCount(0);
    await page.evaluate((id) => openConversation(id), first);
    await expect(card).toHaveCount(1);

    await card.locator('[data-perm-action="allow"]').click();
    await expect.poll(() => fs.existsSync(agentFilePath()), { timeout: 10000 }).toBe(true);
    expect(fs.readFileSync(agentFilePath(), 'utf-8'), 'the file written is the file the card showed').toBe(helperFile);
    await expect.poll(() => received.some((m) => m.type === 'agent_saved' && m.agentId === NAME && m.conversationId === first)).toBe(true);
  } finally {
    fs.rmSync(scenarioFile(), { force: true });
    for (const id of [first, other]) {
      if (id) await page.evaluate((c) => deleteConversation(c, { stopPropagation() {} }), id).catch(() => {});
    }
  }
});
