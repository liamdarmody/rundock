'use strict';
// A permission card drawn while its conversation is on screen, through a
// switch to another conversation and back, in the real client against the
// real server.
//
// THE DEFECT. Only a card that arrived while its conversation was in the
// background was held for that conversation. A card drawn on screen lived in
// the page alone, so switching away and back lost it, and the request waited
// with no card until the server timed it out and denied it.
//
// WHAT IS ASSERTED. A card raised for the conversation on screen is drawn
// there, and after switching away and back it is drawn again, once, still
// answerable: Allow on it sends one answer naming its own request and
// conversation, and the server takes it before its timeout. Answered, it is
// never live again: the next return shows it once, settled as it was
// answered, and the one after shows nothing. One that timed out while its
// conversation was away comes
// back settled, saying so, and clicking it sends nothing. A conversation left
// with a card open is marked waiting in the list until the card is answered
// or ends, and never once the conversation is deleted. Each conversation's
// card is drawn only in its own. On the stub runtime, the agent that asked is
// told yes and its reply streams in.
//
// The launcher shortens the permission timeout for the whole E2E server to six
// seconds (see serve.js), so every switch and answer here happens inside it,
// and a request left alone ends in seconds.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');
const credentials = require('./credentials.js');
const { readAppendedLog } = require('../helpers/appended-log.js');

const PORT = Number(process.env.E2E_PORT || 34517);
const STUB_VERSION = '2.1.318-stub';

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

// Raised exactly as the hook raises it, for a conversation its token was
// issued to. Resolves to what the server tells the hook.
function raise(convoId, command) {
  return fetch(`http://localhost:${PORT}/api/permission-request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Rundock-Hook-Token': credentials.hookToken(convoId) },
    body: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, conversation_id: convoId }),
  }).then((r) => r.json());
}

// What the page sends and is sent, read off its socket. Registered before the
// page loads, so nothing is missed.
function watch(page) {
  const sent = [];
  const received = [];
  page.on('websocket', (socket) => {
    socket.on('framesent', (f) => { try { const m = JSON.parse(f.payload); if (m.type === 'permission_response') sent.push(m); } catch (e) { /* not JSON */ } });
    socket.on('framereceived', (f) => { try { received.push(JSON.parse(f.payload)); } catch (e) { /* not JSON */ } });
  });
  return { sent, received };
}

const cards = (page) => page.locator('#messages .msg-permission');
const live = (page) => page.locator('#messages [data-perm-action]');
const waitingInList = (page, id) => page.locator(`.convo-item[data-convo-id="${id}"] .convo-unread`);
const markedWaiting = (page, id) => page.evaluate((c) => unread.isUnread(c), id);
const answer = (m) => ({ requestId: m.requestId, conversationId: m.conversationId, allow: m.allow });

async function start(page) {
  await page.goto('/');
  await expect(page.locator('.convo-item').first()).toBeVisible();
}

async function open(page, id) {
  await page.evaluate((c) => openConversation(c), id);
  await expect.poll(() => page.evaluate(() => activeConversation && activeConversation.id)).toBe(id);
}

// The request the page was sent for a conversation, once it has arrived.
async function requestFor(received, convoId, n = 0) {
  const asked = () => received.filter((m) => m.type === 'control_request' && m._conversationId === convoId)[n];
  await expect.poll(() => Boolean(asked())).toBe(true);
  return asked().request_id;
}

test('a card drawn while its conversation is on screen is drawn again after switching away and back, and Allow on it sends one answer the server takes', async ({ page }) => {
  const { sent, received } = watch(page);
  await start(page);
  await open(page, 'c1');
  const told = raise('c1', 'sh scripts/apply-labels.sh --ids a,b,c');
  await expect(cards(page), 'drawn in the conversation on screen').toHaveCount(1);
  const requestId = await requestFor(received, 'c1');

  await open(page, 'c2');
  await expect(cards(page), 'not drawn in the other conversation').toHaveCount(0);
  await open(page, 'c1');
  await expect(cards(page), 'drawn again on return, once').toHaveCount(1);
  await expect(page.locator(`#messages [id="perm-${requestId}"]`), 'the same request').toHaveCount(1);
  const allow = cards(page).locator('[data-perm-action="allow"]');
  await expect(allow).toBeVisible();
  await allow.click();

  expect(await told, 'the server took the answer before its timeout').toEqual({ allow: true, card: true });
  expect(sent.map(answer)).toEqual([{ requestId, conversationId: 'c1', allow: true }]);

  // The undo: the answered card, clicked or pressed, sends nothing more.
  const settled = page.locator(`#messages [id="perm-${requestId}"]`);
  await expect(settled.locator('[data-perm-action]')).toHaveCount(0);
  await settled.click();
  await settled.press('Enter');
  await settled.press('Space');
  // Answered, then switched away and back again: shown once more, settled as
  // it was answered, and never live.
  const said = await settled.innerText();
  await open(page, 'c2');
  expect(await markedWaiting(page, 'c1'), 'an answered card leaves nothing waiting').toBe(false);
  await open(page, 'c1');
  const back = page.locator(`#messages [id="perm-${requestId}"]`);
  await expect(cards(page), 'shown once on return').toHaveCount(1);
  await expect(back.locator('.permission-resolved.allowed'), 'settled as allowed').toHaveCount(1);
  await expect(back.locator('.permission-resolved > span')).toHaveText('✓');
  expect(await back.innerText(), 'it says what it said when it was answered').toBe(said);
  await expect(live(page)).toHaveCount(0);
  await back.click();
  await back.press('Enter');
  await back.press('Space');
  expect(sent.length, 'one answer, and only one').toBe(1);
  // And a later return draws nothing.
  await open(page, 'c2');
  await open(page, 'c1');
  await expect(cards(page), 'drawn once, then not again').toHaveCount(0);
});

test('the retry: five switches away and back leave one live copy, and one click sends one answer', async ({ page }) => {
  const { sent, received } = watch(page);
  await start(page);
  await open(page, 'c1');
  const told = raise('c1', 'sh scripts/retry-labels.sh');
  await expect(cards(page)).toHaveCount(1);
  const requestId = await requestFor(received, 'c1');
  for (let i = 0; i < 5; i++) {
    await open(page, 'c2');
    await open(page, 'c1');
  }
  await expect(cards(page), 'one copy after five switches').toHaveCount(1);
  await expect(page.locator('#messages [data-perm-action="allow"]'), 'one live Allow').toHaveCount(1);
  await page.locator('#messages [data-perm-action="allow"]').click();
  expect(await told).toEqual({ allow: true, card: true });
  expect(sent.map(answer)).toEqual([{ requestId, conversationId: 'c1', allow: true }]);
});

test('the inverse action: switching away and back with no card open draws no card and marks nothing waiting', async ({ page }) => {
  const { sent } = watch(page);
  await start(page);
  await open(page, 'c1');
  await open(page, 'c2');
  expect(await markedWaiting(page, 'c1'), 'nothing open, so nothing waits').toBe(false);
  await expect(waitingInList(page, 'c1')).toHaveCount(0);
  await open(page, 'c1');
  await expect(cards(page)).toHaveCount(0);
  expect(sent).toEqual([]);
});

test('the control failing: a card drawn on screen that times out while its conversation is away comes back settled as timed out, and clicking it sends nothing', async ({ page }) => {
  const { sent } = watch(page);
  await start(page);
  await open(page, 'c1');
  const told = raise('c1', 'sh scripts/left-waiting.sh');
  await expect(cards(page)).toHaveCount(1);

  await open(page, 'c2');
  await expect(waitingInList(page, 'c1'), 'left with a card open, it is marked waiting').toHaveCount(1);
  expect(await told, 'nobody answered, so the server timed it out').toEqual({ allow: false, reason: 'timeout' });
  await expect(waitingInList(page, 'c1'), 'its only card ended, so it no longer waits').toHaveCount(0);

  await open(page, 'c1');
  const card = cards(page);
  await expect(card, 'shown once, settled').toHaveCount(1);
  await expect(card).toContainText('Timed out');
  await expect(card).toContainText('Nobody answered in time');
  await expect(live(page), 'nothing to click').toHaveCount(0);
  await card.click();
  await card.press('Enter');
  await card.press('Space');
  expect(sent, 'clicking a settled card sends nothing').toEqual([]);
});

test('two conversations each with a card drawn on screen: each card is drawn only in its own, and answering one leaves the other open', async ({ page }) => {
  const { sent, received } = watch(page);
  await start(page);
  await open(page, 'c1');
  const toFirst = raise('c1', 'sh scripts/first-of-two.sh');
  await expect(cards(page)).toHaveCount(1);
  const first = await requestFor(received, 'c1');

  await open(page, 'c2');
  await expect(cards(page)).toHaveCount(0);
  const toSecond = raise('c2', 'sh scripts/second-of-two.sh');
  await expect(cards(page)).toHaveCount(1);
  const second = await requestFor(received, 'c2');

  await open(page, 'c1');
  await expect(cards(page), 'only its own card').toHaveCount(1);
  await expect(page.locator(`#messages [id="perm-${first}"]`)).toHaveCount(1);
  await page.locator(`#messages [id="perm-${first}"] [data-perm-action="deny"]`).click();
  expect(await toFirst).toEqual({ allow: false });

  await open(page, 'c2');
  await expect(cards(page), 'only its own card').toHaveCount(1);
  const other = page.locator(`#messages [id="perm-${second}"] [data-perm-action="allow"]`);
  await expect(other, 'still open after the other was answered').toBeVisible();
  await other.click();
  expect(await toSecond).toEqual({ allow: true, card: true });
  expect(sent.map(answer)).toEqual([
    { requestId: first, conversationId: 'c1', allow: false },
    { requestId: second, conversationId: 'c2', allow: true },
  ]);
});

test('a conversation left with a card open is marked waiting, and answering the card on return leaves it unmarked once left again', async ({ page }) => {
  const { sent } = watch(page);
  await start(page);
  await open(page, 'c1');
  const told = raise('c1', 'sh scripts/mark-waiting.sh');
  await expect(cards(page)).toHaveCount(1);
  await open(page, 'c2');
  await expect(waitingInList(page, 'c1'), 'marked waiting once left').toHaveCount(1);
  await open(page, 'c1');
  await cards(page).locator('[data-perm-action="allow"]').click();
  expect(await told).toEqual({ allow: true, card: true });
  await open(page, 'c2');
  await expect(waitingInList(page, 'c1'), 'nothing left waiting').toHaveCount(0);
  expect(sent.length).toBe(1);
});

// On the stub runtime: the request is the agent's own, put to the real
// permission hook by the run the conversation started.
let workspace = null;
const scenarioFile = () => path.join(workspace, 'stub-scenario.json');
const hookAnswers = (convoId) => readAppendedLog(path.join(workspace, 'stub-hook-answers.jsonl'))
  .filter((a) => a.convo === convoId).map((a) => a.answer && a.answer.hookSpecificOutput && a.answer.hookSpecificOutput.permissionDecision);

test.describe('on the stub runtime', () => {
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

  test.afterAll(() => {
    if (workspace) fs.rmSync(scenarioFile(), { force: true });
  });

  const rule = (ask, command, reply) => ({
    match: { promptIncludes: ask },
    hooks: [{ tool: 'Bash', input: { command, description: 'Apply the labels' } }],
    turn: [{ text: reply }],
  });

  test('the most common next step: back in the conversation, Allow on the card drawn there tells the agent yes before the timeout, and its reply streams in', async ({ page }) => {
    expect(workspace, 'the server must resolve the stub runtime, or nothing may be sent').toBeTruthy();
    fs.writeFileSync(scenarioFile(), JSON.stringify({ rules: [rule('OPEN-CARD-SWITCH-E2E-ASK', 'sh scripts/label-run.sh', 'OPEN-CARD-SWITCH-E2E-REPLY labels applied')] }));
    const { sent } = watch(page);
    let id = null;
    try {
      await start(page);
      id = await page.evaluate(() => createConversation('default', 'Open card switch e2e').id);
      await page.locator('#msg-input').fill('OPEN-CARD-SWITCH-E2E-ASK apply the labels');
      await page.locator('#send-btn').click();
      await expect(cards(page), 'the agent\'s card, drawn on screen').toHaveCount(1, { timeout: 15000 });

      await open(page, 'c2');
      await open(page, id);
      const allow = cards(page).locator('[data-perm-action="allow"]');
      await expect(allow, 'still answerable on return').toBeVisible();
      await allow.click();

      await expect.poll(() => hookAnswers(id), { message: 'the agent was told yes, not timed out' }).toEqual(['allow']);
      await expect(page.locator('#messages'), 'the agent carried on, in its own conversation').toContainText('OPEN-CARD-SWITCH-E2E-REPLY', { timeout: 10000 });
      expect(sent.map((m) => m.conversationId)).toEqual([id]);
    } finally {
      fs.rmSync(scenarioFile(), { force: true });
      if (id) await page.evaluate((c) => deleteConversation(c, { stopPropagation() {} }), id).catch(() => {});
    }
  });

  test('a conversation deleted while it holds an open card is never marked waiting again', async ({ page }) => {
    expect(workspace, 'the server must resolve the stub runtime, or nothing may be sent').toBeTruthy();
    fs.writeFileSync(scenarioFile(), JSON.stringify({ rules: [rule('OPEN-CARD-SWITCH-E2E-DELETE', 'sh scripts/label-delete.sh', 'OPEN-CARD-SWITCH-E2E-GONE')] }));
    let id = null;
    try {
      await start(page);
      id = await page.evaluate(() => createConversation('default', 'Open card delete e2e').id);
      await page.locator('#msg-input').fill('OPEN-CARD-SWITCH-E2E-DELETE apply the labels');
      await page.locator('#send-btn').click();
      await expect(cards(page)).toHaveCount(1, { timeout: 15000 });
      await open(page, 'c2');
      expect(await markedWaiting(page, id), 'left with its card open, it waits').toBe(true);

      await page.evaluate((c) => deleteConversation(c, { stopPropagation() {} }), id);
      await open(page, 'c1');
      expect(await markedWaiting(page, id), 'deleted, it is never marked again').toBe(false);
      expect(await page.evaluate((c) => pendingPermissionsByConvo.has(c), id), 'and holds nothing').toBe(false);
      id = null;
    } finally {
      fs.rmSync(scenarioFile(), { force: true });
      if (id) await page.evaluate((c) => deleteConversation(c, { stopPropagation() {} }), id).catch(() => {});
    }
  });
});
