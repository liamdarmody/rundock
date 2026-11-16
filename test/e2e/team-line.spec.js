'use strict';
// The line saying what Rundock did with Doc's save is kept with its own
// conversation, in the real client against the real server.
//
// THE DEFECT. The line was drawn only if its conversation was on screen when
// the save happened: with another conversation open it was dropped, and after
// a reload it was gone, though the agent file had been written.
//
// WHAT IS ASSERTED, AND WHERE. On the page: Doc's turn in one conversation is
// held until a second conversation is on screen, then released. The line must
// not appear in the second conversation, must appear once in the first when
// the person switches to it, and must still be there, after Doc's reply,
// once the page is reloaded and the first conversation opened again.
//
// IN CONVERSATIONS OF THEIR OWN, deleted afterwards, never a seeded one: the
// specs share one server and one workspace. The agent file this spec causes is
// removed afterwards, and the roster is read until it no longer lists it.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');
const credentials = require('./credentials.js');

const PORT = Number(process.env.E2E_PORT || 34517);
const STUB_VERSION = '2.1.318-stub';
const NAME = 'example-helper';
const LINE = `Agent "${NAME}" created`;

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
const gateFile = () => path.join(workspace, 'team-line-e2e.gate');

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
  for (const f of [scenarioFile(), gateFile(), agentFilePath()]) fs.rmSync(f, { force: true });
  await expect.poll(() => overWs(async ({ send, waitFor }) => {
    send({ type: 'get_agents' });
    const roster = await waitFor((m) => m.type === 'agents');
    return roster.agents.some((a) => a.id === NAME || a.name === NAME);
  }), { timeout: 15000 }).toBe(false);
});

const helperFile = [
  '---', `name: ${NAME}`, 'displayName: Example', 'role: Example Specialist', 'type: specialist', 'order: 8', 'tools: Read', '---',
  '', 'You are the example helper.',
].join('\n');

test('Doc\'s save while another conversation is on screen: the line is shown in its own conversation, and kept after a reload', async ({ page }) => {
  expect(workspace, 'the server must resolve the stub runtime, or nothing may be sent').toBeTruthy();
  const replyLead = 'Made the example helper.';
  fs.writeFileSync(scenarioFile(), JSON.stringify({ rules: [{
    match: { promptIncludes: 'TEAM-LINE-E2E' }, untilFile: gateFile(),
    turn: [{ text: `${replyLead}\n<!-- RUNDOCK:SAVE_AGENT name=${NAME} -->\n${helperFile}\n<!-- /RUNDOCK:SAVE_AGENT -->` }],
  }] }));
  const received = [];
  page.on('websocket', (socket) => socket.on('framereceived', (f) => { try { received.push(JSON.parse(f.payload)); } catch (e) { /* not JSON */ } }));
  const lines = page.locator('#messages .msg-system', { hasText: LINE });
  let first = null;
  let second = null;
  try {
    await page.goto('/');
    await expect(page.locator('.convo-item').first()).toBeVisible();
    first = await page.evaluate(() => createConversation('rundock-guide', 'Team line first e2e').id);
    await page.locator('#msg-input').fill('TEAM-LINE-E2E make the example helper');
    await page.locator('#send-btn').click();
    await expect.poll(() => received.some((m) => m.type === 'system' && m.subtype === 'process_started' && m._conversationId === first)).toBe(true);

    // Another conversation on screen, then Doc's turn finishes.
    second = await page.evaluate(() => createConversation('rundock-guide', 'Team line second e2e').id);
    await expect.poll(() => page.evaluate(() => activeConversation && activeConversation.id)).toBe(second);
    fs.writeFileSync(gateFile(), '');
    await expect.poll(() => fs.existsSync(agentFilePath()), { timeout: 10000 }).toBe(true);
    await expect.poll(() => received.some((m) => m.type === 'agent_saved' && m.agentId === NAME && m.conversationId === first)).toBe(true);
    await expect(lines, 'the line is not drawn in the conversation on screen').toHaveCount(0);

    // Switching to the first conversation shows it, once, after Doc's reply.
    await page.evaluate((id) => openConversation(id), first);
    await expect(page.locator('#messages')).toContainText(replyLead);
    await expect(lines).toHaveCount(1);
    const order = () => page.evaluate(([lead, line]) => [...document.querySelectorAll('#messages > *')]
      .map((el) => (el.textContent.includes(line) && el.classList.contains('msg-system') ? 'line' : el.textContent.includes(lead) ? 'reply' : null))
      .filter(Boolean), [replyLead, LINE]);
    expect(await order()).toEqual(['reply', 'line']);

    // A reload keeps it.
    await page.reload();
    await expect(page.locator('.convo-item').first()).toBeVisible();
    await page.evaluate((id) => openConversation(id), first);
    await expect(page.locator('#messages')).toContainText(replyLead);
    await expect(lines).toHaveCount(1);
    expect(await order()).toEqual(['reply', 'line']);
  } finally {
    for (const id of [first, second]) {
      if (id) await page.evaluate((c) => deleteConversation(c, { stopPropagation() {} }), id).catch(() => {});
    }
  }
});
