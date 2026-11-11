'use strict';
// "Always allow", pressed on a routine's card in the real client, holds for
// the routine's next matching request once the window has closed.
//
// The routine is started on the stub runtime, and its agent puts two
// commands to the real permission hook, with the token its run was started
// with. Both fall under one saved key, Bash:python3, and both are medium
// risk, so the first raises a card in the approvals dock. A person presses
// that card's own "Always allow" button, which answers the request and saves
// the key through the window, as it always has. The page is then closed, so
// no window is connected, and only then is the agent let go on to its second
// command. The server applies the saved answer itself: the second command is
// allowed with no card, the run finishes without waiting on one, and the
// outcome is recorded as answered by the saved key.
//
// What the agent was told is read from the stub's own log of hook answers,
// and the run's outcome from its record, so nothing here is inferred from
// the page after it closed.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const credentials = require('./credentials.js');
const { readAppendedLog } = require('../helpers/appended-log.js');

const STUB_VERSION = '2.1.318-stub';
const PORT = Number(process.env.E2E_PORT || 34517);
const ROUTINE = 'Saved answer holds';
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const SCHEDULE = `every ${WEEKDAYS[(new Date().getDay() + 3) % 7]} at 07:00`;
const PROMPT = 'saved answer holds e2e body';
const FIRST = 'python3 tools/report.py';
const SECOND = 'python3 tools/summary.py --week';
const KEY = 'Bash:python3';

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

const savedKeys = (ws) => {
  try { return JSON.parse(fs.readFileSync(path.join(ws, '.rundock', 'permissions.json'), 'utf-8')).allowedTools || []; } catch (e) { return []; }
};
const records = (ws) => {
  const dir = path.join(ws, '.rundock', 'runs');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.endsWith('.json'))
    .map((n) => { try { return JSON.parse(fs.readFileSync(path.join(dir, n), 'utf-8')); } catch (e) { return null; } })
    .filter((r) => r && r.routine === ROUTINE);
};
const answersFor = (ws, sessionId) => readAppendedLog(path.join(ws, 'stub-hook-answers.jsonl'))
  .filter((a) => a.sessionId === sessionId).map((a) => a.answer && a.answer.hookSpecificOutput);
const permissionEvents = (ws, since) => {
  const dir = path.join(ws, '.rundock', 'state');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => /^events-.*\.jsonl$/.test(n))
    .flatMap((n) => readAppendedLog(path.join(dir, n)))
    .filter((e) => e && e.e === 'permission' && Date.parse(e.ts) >= since && e.d && e.d.tool === 'Bash');
};

test('"Always allow" pressed on a routine\'s card answers its next matching request after the window has closed, with no card', async ({ page }) => {
  const gateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-saved-gate-'));
  const gate = path.join(gateDir, 'go');
  let ws = null;
  let scenarioBefore = null;
  try {
    const setup = await overWs(async ({ send, waitFor }) => {
      send({ type: 'get_runtime_status' });
      const status = await waitFor((m) => m.type === 'runtime_status');
      const version = status.claude && status.claude.version;
      if (version !== STUB_VERSION) return { version };
      send({ type: 'get_workspaces' });
      const set = await waitFor((m) => m.type === 'workspaces' && m.current);
      // The key starts unsaved, whatever an earlier spec left.
      if (savedKeys(set.current).includes(KEY)) {
        send({ type: 'remove_tool_allow', key: KEY });
        await waitFor((m) => m.type === 'tool_allows' && !m.tools.includes(KEY));
      }
      const scenario = path.join(set.current, 'stub-scenario.json');
      const before = fs.existsSync(scenario) ? fs.readFileSync(scenario, 'utf-8') : null;
      fs.writeFileSync(scenario, JSON.stringify({
        rules: [{
          match: { agent: 'wren', promptIncludes: PROMPT },
          hooks: [
            { tool: 'Bash', input: { command: FIRST, description: 'Build the report' } },
            { tool: 'Bash', input: { command: SECOND, description: 'Build the summary' }, untilFile: gate },
          ],
          turn: [{ text: 'saved answer run ran' }],
        }],
      }));
      send({ type: 'save_routine', agentId: 'wren', routine: { name: ROUTINE, schedule: SCHEDULE, prompt: PROMPT, runOn: 'local' } });
      await waitFor((m) => m.type === 'routine_saved' && m.name === ROUTINE);
      return { version, ws: set.current, before };
    });
    expect(setup.version, 'the server must resolve the stub runtime, or nothing may be pressed').toBe(STUB_VERSION);
    ws = setup.ws;
    scenarioBefore = setup.before;
    expect(savedKeys(ws)).not.toContain(KEY);

    await page.goto('/');
    await expect(page.locator('.convo-item').first()).toBeVisible();

    const since = Date.now();
    await overWs(async ({ send, waitFor }) => {
      send({ type: 'run_routine_now', agentId: 'wren', name: ROUTINE, occurrence: 0 });
      await waitFor((m) => m.type === 'routine_run_started');
    });

    // The first command's card, in the approvals dock, answered by pressing
    // its own "Always allow".
    const dockCard = page.locator('#approvals-dock .msg-permission');
    await expect(dockCard).toHaveCount(1);
    await expect(dockCard.locator('.permission-origin')).toHaveText(`${ROUTINE}, run by Wren`);
    const always = dockCard.locator('[data-perm-action="always"]');
    await expect(always).toBeVisible();
    await always.click();

    // The window saved the key, and the agent was told yes.
    await expect.poll(() => savedKeys(ws), { message: 'the key is saved' }).toContain(KEY);
    await expect.poll(() => records(ws).length, { message: 'the run is recorded' }).toBe(1);
    const sessionId = records(ws)[0].sessionId;
    await expect.poll(() => answersFor(ws, sessionId).length, { message: 'the first command was answered' }).toBe(1);
    expect(answersFor(ws, sessionId)[0].permissionDecision).toBe('allow');

    // No window from here on.
    await page.close();
    await new Promise((r) => setTimeout(r, 500));
    const released = Date.now();
    fs.writeFileSync(gate, '');

    await expect.poll(() => (records(ws)[0] || {}).status, { message: 'the run finished', timeout: 20000 }).toBe('succeeded');
    const record = records(ws)[0];
    const answers = answersFor(ws, record.sessionId);
    expect(answers.length, 'both commands were put to the hook').toBe(2);
    expect(answers[1].permissionDecision, 'the second command was allowed with no window').toBe('allow');
    expect(record.refusedCards, 'no card was refused').toBeUndefined();
    expect(Date.parse(record.endedAt) - released, 'it never waited on a card').toBeLessThan(5000);
    await expect.poll(() => permissionEvents(ws, since).filter((e) => e.d.reason === 'always-allowed').length, { message: 'the saved key answered it' }).toBe(1);
    expect(permissionEvents(ws, since).filter((e) => e.d.decision === 'timeout')).toEqual([]);
  } finally {
    // A run still held is let go before anything it uses is removed.
    fs.writeFileSync(gate, '', { flag: 'a' });
    if (ws) {
      await expect.poll(() => (records(ws)[0] || { status: 'none' }).status, { timeout: 15000 }).not.toBe('running').catch(() => {});
      await overWs(async ({ send, waitFor }) => {
        send({ type: 'remove_tool_allow', key: KEY });
        await waitFor((m) => m.type === 'tool_allows' && !m.tools.includes(KEY));
        send({ type: 'delete_routine', agentId: 'wren', name: ROUTINE, occurrence: 0 });
        await new Promise((r) => setTimeout(r, 300));
      }).catch(() => {});
      const scenario = path.join(ws, 'stub-scenario.json');
      if (scenarioBefore === null) fs.rmSync(scenario, { force: true }); else fs.writeFileSync(scenario, scenarioBefore);
    }
    fs.rmSync(gateDir, { recursive: true, force: true });
  }
});
