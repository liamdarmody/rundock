'use strict';
// A connector's email card and the reconnect card, in the real client against
// the real server.
//
// THE EMAIL CARD. A send is raised for the open conversation exactly as the
// permission hook raises one. The card must show its recipients, three at a
// time with the rest one click away, Bcc on a row of its own, the subject as
// text, the first lines of the message with the whole of it on request, and
// "Allow once" beside Deny with nothing to remember. Every value is made up.
//
// THE RECONNECT CARD. A turn on the stub runtime fails the way an expired
// Claude Code session does, which draws the card. "Reconnect Claude" asks the
// server to open a console; that one request is answered here, so no window
// opens on the machine running the suite. "I've reconnected" then runs the real
// check through the real server, against the stub, which answers connected.
//
// THAT TURN IS SENT IN A CONVERSATION OF ITS OWN, deleted afterwards, never in
// a seeded one. The specs share one server and one seeded workspace, and a
// turn gives its conversation a transcript, which from then on decides what
// that conversation's history shows. Sent in the seeded "Board prep planning"
// conversation, it hid the eighty messages search.spec.js opens and flashes.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');
const credentials = require('./credentials.js');

const PORT = Number(process.env.E2E_PORT || 34517);
const STUB_VERSION = '0.0.0-stub';
const PROMPT = 'reconnect card e2e';

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

// Raised exactly as the hook raises it; the card is what is under test.
function raise(body) {
  fetch(`http://localhost:${PORT}/api/permission-request`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Rundock-Hook-Token': credentials.hookToken(body.conversation_id || null) }, body: JSON.stringify(body),
  }).catch(() => {});
}

async function openC1(page) {
  await page.goto('/');
  await expect(page.locator('.convo-item').first()).toBeVisible();
  await page.evaluate(() => openConversation('c1'));
  await expect(page.locator('#view-chat')).toBeVisible();
}

test('an email send shows who it goes to and what it says, and asks every time', async ({ page }) => {
  await openC1(page);
  const to = ['sam@example.org', 'priya@example.com', 'jo@example.net', 'lee@example.org', 'omar@example.com', 'tess@example.net'];
  raise({
    tool_name: 'mcp__example_post__send_message', conversation_id: 'c1',
    tool_input: { to, bcc: 'records@example.org', subject: '<b>Venue</b> for the 14th', body: 'Hi Sam,\nline two\nline three\nline four\nBest,\nAlex' },
  });

  const card = page.locator('#messages .msg-permission').filter({ hasText: 'example post' });
  await expect(card).toHaveCount(1);
  await expect(card.locator('.permission-context')).toHaveText('Sends straight away from your account. It cannot be undone, so this always asks.');
  await expect(card.locator('dl.permission-fields > dt')).toHaveText(['To', 'Bcc', 'Subject', 'Message']);

  // Three recipients, the rest one click away.
  for (const a of to.slice(0, 3)) await expect(card.getByText(a, { exact: true })).toBeVisible();
  await expect(card.getByText('lee@example.org', { exact: true })).toBeHidden();
  await card.getByText('+3 more', { exact: true }).click();
  for (const a of to.slice(3)) await expect(card.getByText(a, { exact: true })).toBeVisible();
  await expect(card.getByText('records@example.org', { exact: true })).toBeVisible();

  // The subject is the characters it was sent as.
  await expect(card.locator('.permission-clamp')).toHaveText('<b>Venue</b> for the 14th');
  await expect(card.locator('dl.permission-fields b')).toHaveCount(0);

  // Three lines, then the whole message on request, in a box that scrolls.
  await expect(card.locator('.permission-cut').filter({ hasText: 'more lines' })).toHaveText('… 3 more lines');
  await expect(card.locator('.permission-full-text')).toBeHidden();
  await card.getByText('Show full message', { exact: true }).click();
  await expect(card.locator('.permission-full-text')).toContainText('Alex');
  expect(await card.locator('.permission-full-text').evaluate((el) => getComputedStyle(el).overflowY)).toBe('auto');

  await expect(card.locator('.permission-raw')).toHaveText('Tool name: mcp__example_post__send_message');
  await expect(card.locator('.permission-actions button')).toHaveText(['Allow once', 'Deny']);
  await card.locator('[data-perm-action="deny"]').click();
  await expect(card.locator('.permission-resolved')).toBeVisible();
});

test('an expired session draws the reconnect card, and reconnecting needs no terminal', async ({ page }) => {
  const workspace = await overWs(async ({ send, waitFor }) => {
    send({ type: 'get_runtime_status' });
    const status = await waitFor((m) => m.type === 'runtime_status');
    if (!(status.claude && status.claude.version === STUB_VERSION)) return null;
    send({ type: 'get_workspaces' });
    const set = await waitFor((m) => m.type === 'workspaces' && m.current);
    return set.current;
  });
  expect(workspace, 'the server must resolve the stub runtime, or nothing may be pressed').toBeTruthy();
  const scenario = path.join(workspace, 'stub-scenario.json');
  fs.writeFileSync(scenario, JSON.stringify({
    rules: [{ match: { promptIncludes: PROMPT }, isError: true, turn: [{ text: 'authentication_error: OAuth token has expired' }] }],
  }));
  let convoId = null;
  try {
    const opened = [];
    await page.route('**/api/claude/reconnect', (route) => { opened.push(route.request().method()); return route.fulfill({ json: { ok: true } }); });
    await page.goto('/');
    await expect(page.locator('.convo-item').first()).toBeVisible();
    convoId = await page.evaluate(() => createConversation('default', 'Reconnect card e2e').id);
    await expect(page.locator('#view-chat')).toBeVisible();
    await page.locator('#msg-input').fill(PROMPT);
    await page.locator('#send-btn').click();

    const card = page.locator('#messages .auth-error-card');
    await expect(card).toHaveCount(1);
    await expect(card.locator('.auth-error-title')).toHaveText('Claude needs reconnecting');
    await expect(card).not.toContainText(/sign[\s-]*in/i);

    await card.getByRole('button', { name: 'Reconnect Claude' }).click();
    await expect(card.locator('.auth-error-title')).toHaveText('Waiting for Claude');
    await expect(card.locator('.auth-pulse')).toHaveCount(1);
    expect(opened).toEqual(['POST']);

    await card.getByRole('button', { name: 'I\'ve reconnected' }).click();
    await expect(card.locator('.auth-error-title')).toHaveText('Reconnected');
    await expect(card).toContainText('Resend your message to carry on.');
    await expect(card).not.toContainText(/sign[\s-]*in/i);
  } finally {
    fs.rmSync(scenario, { force: true });
    // Leave the shared workspace as the next spec expects it.
    if (convoId) await page.evaluate((id) => deleteConversation(id, { stopPropagation() {} }), convoId).catch(() => {});
  }
});
