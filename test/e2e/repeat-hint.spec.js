'use strict';
// The hint that names the setting which would stop repeated cards, in the real
// client against the real server.
//
// Requests are raised exactly as the permission hook raises them. On the third
// card a setting could fix, a one-line hint appears under that card, outside
// it, naming the setting; its link opens Settings, Permissions with that
// control ringed, and changes nothing: the workspace stays in Notes mode, and
// a folder is typed into the field but never added.
const { test, expect } = require('@playwright/test');
const path = require('node:path');
const WebSocket = require('ws');
const credentials = require('./credentials.js');

const PORT = Number(process.env.E2E_PORT || 34517);

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

function raise(body) {
  fetch(`http://localhost:${PORT}/api/permission-request`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Rundock-Hook-Token': credentials.hookToken(body.conversation_id || null) }, body: JSON.stringify(body),
  }).catch(() => {});
}

// Each test uses its own conversation, so a request still pending from the
// other, re-sent when the page connects, never counts toward this one.
async function openChat(page, convoId) {
  await page.goto('/');
  await expect(page.locator('.convo-item').first()).toBeVisible();
  await page.evaluate((id) => openConversation(id), convoId);
  await expect(page.locator('#view-chat')).toBeVisible();
  expect(await page.evaluate(() => workspaceMode)).not.toBe('code');
}

test('three ordinary commands in Notes mode: the hint names Code mode, and its link changes nothing', async ({ page }) => {
  await openChat(page, 'c1');
  for (const command of ['npm install sharp', 'mkdir -p src/marketing', 'git checkout -b marketing']) {
    raise({ tool_name: 'Bash', tool_input: { command }, conversation_id: 'c1' });
    await expect(page.locator('#messages .msg-permission').filter({ hasText: command })).toHaveCount(1);
  }
  const hint = page.locator('#messages .repeat-hint');
  await expect(hint).toHaveCount(1);
  await expect(hint).toContainText('You\'re in Notes mode: switch to Code mode and everyday commands like this run without asking.');
  // Under the third card, outside it.
  expect(await hint.evaluate((el) => el.previousElementSibling.classList.contains('msg-permission')
    && el.previousElementSibling.textContent.includes('git checkout -b marketing'))).toBe(true);

  await hint.locator('.hint-link').click();
  await expect(page.locator('#view-settings')).toBeVisible();
  await expect(page.locator('#settings-content .mode-toggle.settings-ring')).toBeVisible();
  await expect(page.locator('.mode-toggle-btn.active')).toHaveText('Notes');
  expect(await page.evaluate(() => workspaceMode)).not.toBe('code');
});

test('three writes into one outside folder: the hint names it, and its link fills it in without adding it', async ({ page }) => {
  const folder = await overWs(async ({ send, waitFor }) => {
    send({ type: 'get_workspaces' });
    const set = await waitFor((m) => m.type === 'workspaces' && m.current);
    return path.join(path.dirname(set.current), 'repeat-hint-elsewhere');
  });
  await openChat(page, 'c2');
  for (const name of ['a.md', 'b.md', 'c.md']) {
    const file = path.join(folder, name);
    raise({ tool_name: 'Write', tool_input: { file_path: file, content: 'x' }, conversation_id: 'c2',
      boundary: true, resolved_path: file, grant_dir: folder, grantable: true, crossings: [{ path: file, grantDir: folder }] });
    await expect(page.locator('#messages .msg-permission').filter({ hasText: name })).toHaveCount(1);
  }
  const hint = page.locator('#messages .repeat-hint');
  await expect(hint).toHaveCount(1);
  await expect(hint.locator('.hint-link')).toHaveText('Working folder');
  await expect(hint).toContainText('repeat-hint-elsewhere');

  await hint.locator('.hint-link').click();
  await expect(page.locator('#working-folders-block.settings-ring')).toBeVisible();
  await expect(page.locator('#wf-input')).toHaveValue(new RegExp('repeat-hint-elsewhere$'));
  const folders = await overWs(async ({ send, waitFor }) => {
    send({ type: 'get_working_folders' });
    return (await waitFor((m) => m.type === 'working_folders')).folders;
  });
  expect(folders.map((f) => f.path)).not.toContain(folder);
});
