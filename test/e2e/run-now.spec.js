'use strict';
// Pressing Run on a routine's row in the real client: the control disables
// while the stub runtime runs, and the row comes back afterwards.
//
// THE STUB RUNTIME HAS TO BE THE ONE THE SERVER RESOLVES. The E2E launcher
// puts it first on the server's PATH; this spec still asks the server what it
// resolved, through runtime_status, and refuses to press unless the answer
// is the stub, because a real agent would otherwise run with permissions
// skipped.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');

// What the stub answers `--version` with, as the server's probe reads it.
const STUB_VERSION = '0.0.0-stub';
const PORT = Number(process.env.E2E_PORT || 34517);
const ROUTINE = 'Pressed check';
const PROMPT = 'pressed e2e body';

// One WS session from the test's own process: learns the workspace the
// launcher seeded and writes the routine through the real save road.
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

test('pressing Run disables the control while the stub runtime runs, and the row comes back afterwards', async ({ page }) => {
  const { workspace, version } = await overWs(async ({ send, waitFor }) => {
    send({ type: 'get_runtime_status' });
    const status = await waitFor(m => m.type === 'runtime_status');
    const version = status.claude && status.claude.version;
    if (version !== STUB_VERSION) return { workspace: null, version };
    send({ type: 'get_workspaces' });
    const set = await waitFor(m => m.type === 'workspaces' && m.current);
    fs.writeFileSync(path.join(set.current, 'stub-scenario.json'), JSON.stringify({
      rules: [{ match: { agent: 'penn', promptIncludes: PROMPT }, delayMs: 3000, turn: [{ text: 'pressed run ran' }] }],
    }));
    send({ type: 'save_routine', agentId: 'penn', routine: { name: ROUTINE, schedule: 'every day at 07:00', prompt: PROMPT, runOn: 'local' } });
    await waitFor(m => m.type === 'routine_saved' && m.name === ROUTINE);
    return { workspace: set.current, version };
  });
  test.skip(version !== STUB_VERSION, `the server resolved claude ${version}, not the stub, so nothing is pressed`);
  expect(fs.existsSync(path.join(workspace, '.claude', 'agents', 'penn.md'))).toBe(true);
  await page.goto('/');
  await page.click('.nav-item[data-nav="routines"]');
  const row = page.locator('.routine-row', { hasText: ROUTINE });
  await expect(row).toBeVisible();
  const run = row.locator('[data-routines-action="run"]');
  await expect(run).toBeEnabled();
  await expect(row.locator('.rr-actions > *').first()).toHaveAttribute('data-routines-action', 'run');
  await run.click();
  await expect(run).toBeDisabled();
  await expect(row.locator('.run-status.live')).toHaveText('Running now (started manually)');
  await expect(run).toBeEnabled({ timeout: 15000 });
  await expect(row.locator('.run-status.live')).toHaveCount(0);
  await expect(row.locator('.run-status.failed')).toHaveCount(0);
  const records = fs.readdirSync(path.join(workspace, '.rundock', 'runs'))
    .map(name => JSON.parse(fs.readFileSync(path.join(workspace, '.rundock', 'runs', name), 'utf-8')));
  expect(records.filter(r => r.routine === ROUTINE).map(r => r.trigger)).toEqual(['manual']);
});
