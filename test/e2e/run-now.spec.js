'use strict';
// Pressing Run on a routine's row, in the real client against the real
// server: the control disables while the stub runtime runs, and the row
// comes back afterwards.
//
// THE STUB RUNTIME HAS TO BE THE ONE THE SERVER RESOLVES. The E2E launcher
// (test/e2e/serve.js) boots the real server with the invoking shell's PATH,
// so unless the stub directory is first on it the press would spawn a real
// agent CLI with permissions skipped, in a throwaway workspace. This spec
// therefore refuses to press unless `claude` resolves to the stub, and says
// how to run it:
//
//   PATH="$PWD/test/helpers/stub-claude:$PATH" npx playwright test test/e2e/run-now.spec.js
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const WebSocket = require('ws');

const STUB = path.join(__dirname, '..', 'helpers', 'stub-claude', 'claude');
const PORT = Number(process.env.E2E_PORT || 34517);
const ROUTINE = 'Pressed check';
const PROMPT = 'pressed e2e body';

function resolvedClaude() {
  try { return execSync('which claude', { encoding: 'utf-8' }).trim(); } catch { return null; }
}

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
  test.skip(resolvedClaude() !== STUB,
    `claude resolves to ${resolvedClaude()}, not the stub; put test/helpers/stub-claude first on PATH to run this spec`);

  const workspace = await overWs(async ({ send, waitFor }) => {
    send({ type: 'get_workspaces' });
    const set = await waitFor(m => m.type === 'workspaces' && m.current);
    fs.writeFileSync(path.join(set.current, 'stub-scenario.json'), JSON.stringify({
      rules: [{ match: { agent: 'penn', promptIncludes: PROMPT }, delayMs: 3000, turn: [{ text: 'pressed run ran' }] }],
    }));
    send({ type: 'save_routine', agentId: 'penn', routine: { name: ROUTINE, schedule: 'every day at 07:00', prompt: PROMPT, runOn: 'local' } });
    await waitFor(m => m.type === 'routine_saved' && m.name === ROUTINE);
    return set.current;
  });
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

  // The stub holds the turn for three seconds, then ends; the ending's
  // roster broadcast brings the row back.
  await expect(run).toBeEnabled({ timeout: 15000 });
  await expect(row.locator('.run-status.live')).toHaveCount(0);
  await expect(row.locator('.run-status.failed')).toHaveCount(0);
  const records = fs.readdirSync(path.join(workspace, '.rundock', 'runs'))
    .map(name => JSON.parse(fs.readFileSync(path.join(workspace, '.rundock', 'runs', name), 'utf-8')));
  expect(records.filter(r => r.routine === ROUTINE).map(r => r.trigger)).toEqual(['manual']);
});
