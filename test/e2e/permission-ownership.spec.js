'use strict';
// Where a permission card appears, and whether it can still be answered, in
// the real client against the real server.
//
// A ROUTINE'S CARD. A routine has no conversation, so the request its agent
// raises used to be drawn in whichever conversation was open. The run is
// started by pressing it on the stub runtime, its session is read off its own
// record, and a request is raised for that session exactly as the permission
// hook raises one. The card must be absent from the open conversation and
// present in the approvals dock, naming the routine and the agent.
//
// A CARD THAT OUTLIVED ITS REQUEST. A request for a conversation that is not
// on screen is left to time out, then that conversation is opened. The card
// must be there, saying it timed out, with nothing to click.
//
// The launcher shortens the permission timeout for the whole E2E server (see
// serve.js), which is what lets the second case run in seconds.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');

const STUB_VERSION = '0.0.0-stub';
const PORT = Number(process.env.E2E_PORT || 34517);
const ROUTINE = 'Held approvals';
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const SCHEDULE = `every ${WEEKDAYS[(new Date().getDay() + 3) % 7]} at 07:00`;
const PROMPT = 'held approvals e2e body';

function overWs(fn) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
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

// Raised exactly as the hook raises it. The answer is not awaited: the card
// is what is under test, and the server answers the hook on its own clock.
function raise(body) {
  fetch(`http://localhost:${PORT}/api/permission-request`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).catch(() => {});
}

test('a routine\'s request is shown in the approvals dock, named for the routine and the agent, and never in the open conversation', async ({ page }) => {
  const { workspace, version } = await overWs(async ({ send, waitFor }) => {
    send({ type: 'get_runtime_status' });
    const status = await waitFor(m => m.type === 'runtime_status');
    const version = status.claude && status.claude.version;
    if (version !== STUB_VERSION) return { workspace: null, version };
    send({ type: 'get_workspaces' });
    const set = await waitFor(m => m.type === 'workspaces' && m.current);
    fs.writeFileSync(path.join(set.current, 'stub-scenario.json'), JSON.stringify({
      rules: [{ match: { agent: 'wren', promptIncludes: PROMPT }, delayMs: 20000, turn: [{ text: 'held run ran' }] }],
    }));
    send({ type: 'save_routine', agentId: 'wren', routine: { name: ROUTINE, schedule: SCHEDULE, prompt: PROMPT, runOn: 'local' } });
    await waitFor(m => m.type === 'routine_saved' && m.name === ROUTINE);
    return { workspace: set.current, version };
  });
  expect(version, 'the server must resolve the stub runtime, or nothing may be pressed').toBe(STUB_VERSION);

  // A different conversation is open while the routine runs.
  await page.goto('/');
  await expect(page.locator('.convo-item').first()).toBeVisible();
  await page.evaluate(() => openConversation('c1'));
  await expect(page.locator('#view-chat')).toBeVisible();

  await overWs(async ({ send, waitFor }) => {
    send({ type: 'run_routine_now', agentId: 'wren', name: ROUTINE, occurrence: 0 });
    await waitFor(m => m.type === 'routine_run_started');
  });
  const runsDir = path.join(workspace, '.rundock', 'runs');
  let run = null;
  await expect.poll(() => {
    run = fs.readdirSync(runsDir).map(n => JSON.parse(fs.readFileSync(path.join(runsDir, n), 'utf-8')))
      .find(r => r.routine === ROUTINE && r.status === 'running' && r.sessionId) || null;
    return !!run;
  }).toBe(true);

  raise({ tool_name: 'Bash', tool_input: { command: 'sh scripts/apply-labels.sh --ids a,b,c', description: 'Apply labels' }, session_id: run.sessionId, conversation_id: '' });

  const dockCard = page.locator('#approvals-dock .msg-permission');
  await expect(dockCard).toHaveCount(1);
  await expect(dockCard.locator('.permission-origin')).toHaveText(`${ROUTINE}, run by Wren`);
  await expect(dockCard.locator('[data-perm-action="allow"]')).toBeVisible();
  await expect(page.locator('#messages .msg-permission')).toHaveCount(0);
  await expect(page.locator('#approvals-dock')).toBeVisible();
  expect(await page.evaluate(() => activeConversation && activeConversation.id)).toBe('c1');
});

test('a request that timed out while its conversation was off screen is shown as timed out, with no Allow', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.convo-item').first()).toBeVisible();
  await page.evaluate(() => openConversation('c1'));
  await expect(page.locator('#view-chat')).toBeVisible();

  raise({ tool_name: 'Bash', tool_input: { command: 'sh scripts/off-screen.sh' }, conversation_id: 'c2' });
  // Queued for the conversation that asked, which is not on screen.
  await expect.poll(() => page.evaluate(() => (pendingPermissionsByConvo.get('c2') || new Map()).size)).toBe(1);
  await expect(page.locator('#messages .msg-permission')).toHaveCount(0);
  // Left to time out.
  await expect.poll(() => page.evaluate(() => (pendingPermissionsByConvo.get('c2') || new Map()).size), { timeout: 20000 }).toBe(0);

  await page.evaluate(() => openConversation('c2'));
  const card = page.locator('#messages .msg-permission');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('Timed out');
  await expect(card).toContainText('Nobody answered in time');
  await expect(card.locator('[data-perm-action="allow"]')).toHaveCount(0);
});
